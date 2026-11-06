import { useEffect, useMemo, useState } from 'react'
import { Method, Badge, Status, Tabs, SchemaTable, JsonView, copyText, sourceLabel, CONF_LABEL } from './common.jsx'
import { buildRequest, initialValues, suggestValues, toCurl, toFetch, toPython } from '../lib/builder.js'
import { request, shortVia } from '../lib/net.js'
import { inferSchema, mergeSchema, summarizeBody, schemaSignature, diffSignature, safeJson } from '../lib/schema.js'

const LOC_LABEL = { query: 'query', path: 'path', header: 'header', body: 'body', cookie: 'cookie', variable: 'gql 변수' }
const fmt = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

export function applyRun(ep, run) {
  const next = { ...ep, runs: [...(ep.runs || []), stripRun(run)].slice(-50) }
  if (run.status && run.json !== undefined) {
    const st = String(run.status)
    const cur = next.responses[st]
    next.responses = { ...next.responses, [st]: { description: cur?.description || '', schema: mergeSchema(cur?.schema, inferSchema(run.json)) } }
  }
  if (run.status) {
    next.samples = [
      ...next.samples,
      { at: run.at, request: run.req, response: { status: run.status, body: (run.text || '').slice(0, 200000), contentType: run.contentType, time: run.time } },
    ].slice(-30)
  }
  return next
}

function stripRun(run) {
  // 저장용: 큰 본문은 잘라서 보관
  const { json, ...rest } = run
  return { ...rest, text: (run.text || '').slice(0, 100000) }
}

function labelOf(ep, values, customParams) {
  const parts = []
  for (const p of ep.params) {
    if (p.in === 'header') continue
    const st = values[`${p.in}:${p.name}`]
    if (st?.enabled) parts.push(`${p.name}=${st.value === '' ? '""' : st.value}`)
  }
  for (const c of customParams || []) if (c.enabled && c.name) parts.push(`${c.name}=${c.value}`)
  const s = parts.join(' & ')
  return s.length > 140 ? s.slice(0, 137) + '…' : s || '(조건 없음)'
}

export default function EndpointDetail({ ep, settings, onUpdate, onIntrospect, onRemove, toast }) {
  const [tab, setTab] = useState('overview')
  const [values, setValues] = useState(() => initialValues(ep))
  const [customParams, setCustomParams] = useState([])
  const [headers, setHeaders] = useState([])
  const [bodyMode, setBodyMode] = useState(ep.bodyType === 'graphql' || (ep.bodyExample && !ep.params.some((p) => p.in === 'body')) ? 'raw' : 'fields')
  const [bodyText, setBodyText] = useState(ep.bodyExample || '')
  const [busy, setBusy] = useState(false)
  const [current, setCurrent] = useState(null)

  useEffect(() => {
    setValues(initialValues(ep))
    setCustomParams([])
    setHeaders([])
    setBodyText(ep.bodyExample || '')
    setBodyMode(ep.bodyType === 'graphql' || (ep.bodyExample && !ep.params.some((p) => p.in === 'body')) ? 'raw' : 'fields')
    setCurrent(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ep.id])

  const extra = { customParams, headers, bodyText, bodyMode }
  const preview = useMemo(() => buildRequest(ep, values, extra), [ep, values, customParams, headers, bodyText, bodyMode]) // eslint-disable-line react-hooks/exhaustive-deps

  async function runWith(vals, label) {
    const req = buildRequest(ep, vals, extra)
    const res = await request(req, settings)
    const run = {
      id: Math.random().toString(36).slice(2),
      at: Date.now(),
      label: label ?? labelOf(ep, vals, customParams),
      req,
      status: res.status,
      time: res.time,
      size: res.size,
      via: res.via,
      headers: res.headers,
      contentType: res.contentType,
      text: res.text,
      json: res.json,
      error: res.error,
      attempts: res.attempts,
      summary: res.status ? summarizeBody(res.json, res.text) : res.error,
      signature: res.json !== undefined ? schemaSignature(inferSchema(res.json)) : [],
    }
    onUpdate(ep.id, (e) => applyRun(e, run))
    return run
  }

  async function send() {
    setBusy(true)
    try {
      setCurrent(await runWith(values))
    } finally {
      setBusy(false)
    }
  }

  const responseStatuses = Object.keys(ep.responses)
  const isGraphqlCandidate = /graphql/i.test(ep.url) && !ep.sources.includes('graphql')

  return (
    <div className="card">
      <div className="card-b" style={{ paddingBottom: 0 }}>
        <div className="url-line">
          <Method m={ep.method} />
          <span className="mono">{ep.url}</span>
          <button className="btn sm" onClick={() => copyText(ep.url, toast)}>
            복사
          </button>
        </div>
        <div className="row wrap" style={{ margin: '8px 0 4px' }}>
          {ep.summary && <b>{ep.summary}</b>}
          <Badge kind={ep.confidence} title="확실: 스펙/실제 관측 · 추정: 코드 문맥 · 약한 추정: 문자열 패턴">
            {CONF_LABEL[ep.confidence]}
          </Badge>
          {ep.sources.map((s) => (
            <Badge key={s}>{sourceLabel(s)}</Badge>
          ))}
          {ep.tags.map((t) => (
            <Badge key={t} kind="accent">
              #{t}
            </Badge>
          ))}
          <span className="spacer" />
          {isGraphqlCandidate && (
            <button className="btn sm" onClick={() => onIntrospect(ep.url.split('#')[0])}>
              GraphQL 스키마 조회
            </button>
          )}
          <button className="btn sm ghost danger" onClick={() => onRemove(ep.id)}>
            삭제
          </button>
        </div>
        {ep.description && <p className="small muted" style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{ep.description.slice(0, 1200)}</p>}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: '조건값 → 결과값' },
          { id: 'test', label: '▶ 테스트' },
          { id: 'sweep', label: '조건 비교' },
          { id: 'history', label: '기록', count: ep.runs?.length || 0 },
          { id: 'code', label: '코드' },
          { id: 'evidence', label: '근거·샘플', count: ep.samples.length + ep.evidence.length },
        ]}
      />
      <div className="card-b">
        {tab === 'overview' && <Overview ep={ep} statuses={responseStatuses} goTest={() => setTab('test')} />}
        {tab === 'test' && (
          <TestTab
            ep={ep}
            values={values}
            setValues={setValues}
            customParams={customParams}
            setCustomParams={setCustomParams}
            headers={headers}
            setHeaders={setHeaders}
            bodyMode={bodyMode}
            setBodyMode={setBodyMode}
            bodyText={bodyText}
            setBodyText={setBodyText}
            preview={preview}
            busy={busy}
            send={send}
            current={current}
            toast={toast}
          />
        )}
        {tab === 'sweep' && <SweepTab ep={ep} values={values} runWith={runWith} />}
        {tab === 'history' && <HistoryTab ep={ep} onClear={() => onUpdate(ep.id, (e) => ({ ...e, runs: [] }))} />}
        {tab === 'code' && <CodeTab req={preview} toast={toast} />}
        {tab === 'evidence' && <EvidenceTab ep={ep} />}
      </div>
    </div>
  )
}

function Overview({ ep, statuses, goTest }) {
  const [st, setSt] = useState(statuses.find((s) => s.startsWith('2')) || statuses[0])
  useEffect(() => {
    if (!statuses.includes(st)) setSt(statuses.find((s) => s.startsWith('2')) || statuses[0])
  }, [statuses.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  const runs = (ep.runs || []).slice(-8).reverse()
  return (
    <>
      <div className="section-title">
        📥 요청 조건값 <span className="badge">{ep.params.length}개</span>
        {ep.bodyType && <span className="badge accent">body: {ep.bodyType}</span>}
      </div>
      {ep.params.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>이름</th>
                <th>위치</th>
                <th>타입</th>
                <th>필수</th>
                <th>예시 · 관측값 · 허용값</th>
                <th>설명</th>
              </tr>
            </thead>
            <tbody>
              {ep.params.map((p) => {
                const vals = Array.from(new Set([...(p.enum || []), fmt(p.example), ...(p.observed || []).map(fmt)].filter((x) => x !== '')))
                return (
                  <tr key={p.in + p.name}>
                    <td className="mono">{p.name}</td>
                    <td>
                      <span className="badge">{LOC_LABEL[p.in] || p.in}</span>
                    </td>
                    <td className="mono small">{p.type}</td>
                    <td>{p.required ? '✓' : ''}</td>
                    <td>
                      <div className="chips">
                        {p.enum?.length ? <span className="muted small">허용값:</span> : null}
                        {vals.slice(0, 10).map((v, i) => (
                          <span className="chip" key={i} title={String(v)}>
                            {String(v)}
                          </span>
                        ))}
                        {vals.length > 10 && <span className="muted small">+{vals.length - 10}</span>}
                      </div>
                    </td>
                    <td className="small">
                      {p.description}
                      {p.note && <div className="muted">{p.note}</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted small">파라미터가 발견되지 않았습니다. 테스트 탭에서 직접 추가할 수 있습니다.</div>
      )}

      <div className="section-title">
        📤 응답 결과값
        {statuses.map((s) => (
          <button key={s} className={`btn sm ${s === st ? 'primary' : ''}`} onClick={() => setSt(s)}>
            {s}
          </button>
        ))}
      </div>
      {st ? (
        <>
          {ep.responses[st]?.description && <div className="small muted" style={{ marginBottom: 6 }}>{ep.responses[st].description}</div>}
          <SchemaTable schema={ep.responses[st]?.schema} empty="이 상태 코드의 응답 본문 구조 정보가 없습니다." />
        </>
      ) : (
        <div className="step small">
          아직 응답 구조를 모릅니다. <button className="btn sm primary" onClick={goTest}>▶ 테스트 호출</button> 을 하면 응답을 받아 결과 필드가 자동으로 채워집니다.
        </div>
      )}

      {runs.length > 0 && (
        <>
          <div className="section-title">🧪 최근 조건별 결과</div>
          <RunTable runs={runs} />
        </>
      )}
    </>
  )
}

function RunTable({ runs, baseline, onView }) {
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>조건</th>
            <th>상태</th>
            <th>시간</th>
            <th>크기</th>
            <th>결과 요약</th>
            {baseline && <th>구조 변화</th>}
            {onView && <th />}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const d = baseline && r.signature?.length && baseline !== r ? diffSignature(baseline.signature, r.signature) : null
            return (
              <tr key={r.id}>
                <td className="mono">{r.label}</td>
                <td>
                  <Status code={r.status} />
                </td>
                <td className="small">{r.time ? `${r.time}ms` : ''}</td>
                <td className="small">{r.size ? `${(r.size / 1024).toFixed(1)}KB` : ''}</td>
                <td className="small">{r.summary}</td>
                {baseline && (
                  <td className="small mono">
                    {baseline === r ? (
                      <span className="muted">기준</span>
                    ) : r.status && !r.signature?.length ? (
                      <span className="muted">필드 없음</span>
                    ) : d ? (
                      d.added.length || d.removed.length ? (
                        <span title={[...d.added.map((x) => '+ ' + x), ...d.removed.map((x) => '- ' + x)].join('\n')}>
                          <span className="diff-add">+{d.added.length}</span> / <span className="diff-rem">-{d.removed.length}</span>
                        </span>
                      ) : (
                        <span className="muted">동일</span>
                      )
                    ) : (
                      ''
                    )}
                  </td>
                )}
                {onView && (
                  <td>
                    <button className="btn sm" onClick={() => onView(r)}>
                      보기
                    </button>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TestTab(props) {
  const { ep, values, setValues, customParams, setCustomParams, headers, setHeaders, bodyMode, setBodyMode, bodyText, setBodyText, preview, busy, send, current } = props
  const set = (key, patch) => setValues({ ...values, [key]: { ...values[key], ...patch } })
  const hasBody = ep.bodyType || !['GET', 'HEAD'].includes(ep.method)
  const bodyFieldParams = ep.params.filter((p) => p.in === 'body')
  return (
    <>
      <div className="section-title">조건값 입력</div>
      {ep.params.filter((p) => p.in !== 'body' || bodyMode === 'fields').length > 0 && (
        <div className="param-grid">
          {ep.params
            .filter((p) => p.in !== 'body' || bodyMode === 'fields')
            .map((p) => {
              const key = `${p.in}:${p.name}`
              const st = values[key] || { value: '', enabled: false }
              const opts = Array.from(new Set([...(p.enum || []), ...(p.observed || []).map(fmt)].filter((x) => x !== '')))
              return (
                <ParamRow key={key} p={p} st={st} opts={opts} onChange={(patch) => set(key, patch)} />
              )
            })}
        </div>
      )}
      <div className="row wrap" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => setCustomParams([...customParams, { name: '', value: '', in: 'query', enabled: true }])}>
          ＋ 파라미터 추가
        </button>
        <button className="btn sm" onClick={() => setHeaders([...headers, { k: '', v: '', enabled: true }])}>
          ＋ 헤더 추가
        </button>
      </div>
      {customParams.map((c, i) => (
        <div className="row" key={'c' + i} style={{ marginTop: 6 }}>
          <input type="checkbox" checked={c.enabled} onChange={(e) => setCustomParams(customParams.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} />
          <select className="select" style={{ width: 90 }} value={c.in} onChange={(e) => setCustomParams(customParams.map((x, j) => (j === i ? { ...x, in: e.target.value } : x)))}>
            <option value="query">query</option>
            <option value="body">body</option>
            <option value="header">header</option>
          </select>
          <input className="input" style={{ maxWidth: 180 }} placeholder="이름" value={c.name} onChange={(e) => setCustomParams(customParams.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input className="input grow" placeholder="값" value={c.value} onChange={(e) => setCustomParams(customParams.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <button className="btn sm ghost" onClick={() => setCustomParams(customParams.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      {headers.map((h, i) => (
        <div className="row" key={'h' + i} style={{ marginTop: 6 }}>
          <input type="checkbox" checked={h.enabled !== false} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} />
          <span className="badge" style={{ width: 90, justifyContent: 'center' }}>
            header
          </span>
          <input className="input" style={{ maxWidth: 180 }} placeholder="Authorization" value={h.k} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
          <input className="input grow" placeholder="Bearer …" value={h.v} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
          <button className="btn sm ghost" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}

      {hasBody && (
        <>
          <div className="section-title">
            요청 본문
            {bodyFieldParams.length > 0 && ep.bodyType !== 'graphql' && (
              <span className="row" style={{ gap: 4 }}>
                <button className={`btn sm ${bodyMode === 'fields' ? 'primary' : ''}`} onClick={() => setBodyMode('fields')}>
                  필드 입력
                </button>
                <button
                  className={`btn sm ${bodyMode === 'raw' ? 'primary' : ''}`}
                  onClick={() => {
                    if (!bodyText.trim() && preview.body) setBodyText(safeJson(preview.body) ? JSON.stringify(safeJson(preview.body), null, 2) : preview.body)
                    setBodyMode('raw')
                  }}
                >
                  직접 작성
                </button>
              </span>
            )}
          </div>
          {(bodyMode === 'raw' || !bodyFieldParams.length || ep.bodyType === 'graphql') && (
            <textarea className="input" rows={8} value={bodyText} onChange={(e) => setBodyText(e.target.value)} placeholder='{"key": "value"}' />
          )}
          {ep.bodyType === 'graphql' && <p className="hint">GraphQL 변수는 위 조건값 입력란의 값이 variables 에 병합됩니다.</p>}
        </>
      )}

      <div className="url-line" style={{ marginTop: 14 }}>
        <Method m={preview.method} />
        <span className="mono small">{preview.url}</span>
        <button className="btn primary" onClick={send} disabled={busy}>
          {busy ? <span className="spin" /> : '▶ 호출'}
        </button>
      </div>

      {current && (
        <>
          <div className="section-title">응답</div>
          <ResponseView run={current} />
        </>
      )}
    </>
  )
}

function ParamRow({ p, st, opts, onChange }) {
  const isEnum = p.enum?.length > 0
  return (
    <>
      <input type="checkbox" checked={st.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} title="이 조건값을 요청에 포함" disabled={p.in === 'path'} />
      <div className="pname" title={p.description}>
        {p.name}
        {p.required && <span className="req"> *</span>}
        <div className="muted small" style={{ fontFamily: 'inherit' }}>
          {p.type}
        </div>
      </div>
      <span className="badge ploc">{LOC_LABEL[p.in] || p.in}</span>
      <div className="pval">
        {isEnum ? (
          <select className="select" value={st.value} onChange={(e) => onChange({ value: e.target.value, enabled: true })}>
            <option value="">(빈 값)</option>
            {p.enum.map((v) => (
              <option key={String(v)} value={String(v)}>
                {String(v)}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              className="input"
              value={st.value}
              placeholder={p.description || p.type}
              list={opts.length ? `dl-${p.in}-${p.name}` : undefined}
              onChange={(e) => onChange({ value: e.target.value, enabled: true })}
            />
            {opts.length > 0 && (
              <datalist id={`dl-${p.in}-${p.name}`}>
                {opts.slice(0, 30).map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            )}
          </>
        )}
      </div>
    </>
  )
}

export function ResponseView({ run }) {
  const [view, setView] = useState(run.json !== undefined || safeJson(run.text) !== undefined ? 'tree' : 'raw')
  const json = run.json !== undefined ? run.json : safeJson(run.text)
  const schema = useMemo(() => (json !== undefined ? inferSchema(json) : null), [json])
  return (
    <>
      <div className="resp-head">
        <Status code={run.status} />
        {run.time ? <span className="small">{run.time}ms</span> : null}
        {run.size ? <span className="small">{(run.size / 1024).toFixed(1)}KB</span> : null}
        {run.contentType && <span className="badge">{run.contentType.split(';')[0]}</span>}
        {run.via && <span className="badge" title={run.via}>경로: {shortVia(run.via)}</span>}
        <span className="small muted">{run.summary}</span>
      </div>
      {run.error && (
        <div className="step small" style={{ borderColor: 'var(--err)', marginBottom: 8 }}>
          <b style={{ color: 'var(--err)' }}>요청 실패: {run.error}</b>
          {run.attempts?.length ? <div className="mono">{run.attempts.join('  →  ')}</div> : null}
          <div className="muted">
            브라우저 CORS 정책으로 직접 호출이 막힌 경우 ⚙️ 설정에서 개인 CORS 프록시(Cloudflare Worker, README 참고)를 지정하거나, 캡처 스크립트/HAR 방식을 사용하세요.
          </div>
        </div>
      )}
      <Tabs
        value={view}
        onChange={setView}
        tabs={[
          ...(json !== undefined ? [{ id: 'tree', label: 'JSON' }, { id: 'fields', label: '결과 필드' }] : []),
          { id: 'raw', label: 'Raw' },
          { id: 'headers', label: '헤더', count: Object.keys(run.headers || {}).length },
          { id: 'req', label: '보낸 요청' },
        ]}
      />
      <div style={{ paddingTop: 10 }}>
        {view === 'tree' && json !== undefined && <JsonView value={json} />}
        {view === 'fields' && <SchemaTable schema={schema} />}
        {view === 'raw' && <pre className="code">{(run.text || '').slice(0, 300000) || '(빈 응답)'}</pre>}
        {view === 'headers' && (
          <div className="kv">
            {Object.entries(run.headers || {}).map(([k, v]) => (
              <FragmentKV key={k} k={k} v={v} />
            ))}
            {!Object.keys(run.headers || {}).length && <div className="muted">(헤더 없음 — CORS로 노출되지 않았을 수 있음)</div>}
          </div>
        )}
        {view === 'req' && <pre className="code">{toCurl(run.req)}</pre>}
      </div>
    </>
  )
}

function FragmentKV({ k, v }) {
  return (
    <>
      <div>{k}</div>
      <div>{v}</div>
    </>
  )
}

function SweepTab({ ep, values, runWith }) {
  const sweepable = ep.params.filter((p) => p.in !== 'header' || true)
  const [key, setKey] = useState(sweepable[0] ? `${sweepable[0].in}:${sweepable[0].name}` : '')
  const p = sweepable.find((x) => `${x.in}:${x.name}` === key)
  const [text, setText] = useState(() => (p ? suggestValues(p).join('\n') : ''))
  const [omit, setOmit] = useState(true)
  const [results, setResults] = useState([])
  const [running, setRunning] = useState(false)
  const [viewing, setViewing] = useState(null)

  useEffect(() => {
    if (p) setText(suggestValues(p).join('\n'))
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!sweepable.length) return <div className="muted">비교할 조건값(파라미터)이 없습니다. 테스트 탭에서 파라미터를 추가해 보세요.</div>

  async function run() {
    const list = text.split('\n').map((x) => x.replace(/\r$/, ''))
    const uniq = Array.from(new Set(list)).slice(0, 30)
    setRunning(true)
    setResults([])
    setViewing(null)
    const out = []
    const cases = [...(omit ? [{ omit: true }] : []), ...uniq.map((v) => ({ value: v }))]
    for (const c of cases) {
      const vals = { ...values, [key]: c.omit ? { ...(values[key] || {}), enabled: false } : { value: c.value, enabled: true } }
      const label = c.omit ? `${p.name} 제외` : `${p.name}=${c.value === '' ? '""' : c.value.length > 60 ? c.value.slice(0, 57) + '…' : c.value}`
      const r = await runWith(vals, label)
      out.push(r)
      setResults([...out])
      await new Promise((res) => setTimeout(res, 150))
    }
    setRunning(false)
  }

  const baseline = results.find((r) => r.status >= 200 && r.status < 300 && r.signature?.length)
  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        하나의 조건값을 여러 값으로 바꿔가며 호출하고, 각 조건에서 어떤 결과(상태코드·결과 개수·응답 구조)가 나오는지 비교합니다. 나머지 조건은 테스트 탭의 현재 입력값을 사용합니다.
      </p>
      <div className="row wrap">
        <select className="select" style={{ maxWidth: 280 }} value={key} onChange={(e) => setKey(e.target.value)}>
          {sweepable.map((x) => (
            <option key={x.in + x.name} value={`${x.in}:${x.name}`}>
              {x.name} ({LOC_LABEL[x.in] || x.in})
            </option>
          ))}
        </select>
        <label className="row small">
          <input type="checkbox" checked={omit} onChange={(e) => setOmit(e.target.checked)} disabled={p?.in === 'path'} /> "파라미터 제외" 케이스 포함
        </label>
        <button className="btn sm" onClick={() => p && setText(suggestValues(p).join('\n'))}>
          값 자동 제안
        </button>
      </div>
      <textarea className="input" style={{ marginTop: 8, minHeight: 110 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="한 줄에 하나씩 값 입력 (최대 30개)" />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={running || !p} onClick={run}>
          {running ? <span className="spin" /> : '▶ 조건 비교 실행'}
        </button>
        {running && <span className="small muted">{results.length}개 완료…</span>}
      </div>
      {results.length > 0 && (
        <>
          <div className="section-title">조건별 결과</div>
          <RunTable runs={results} baseline={baseline} onView={setViewing} />
        </>
      )}
      {viewing && (
        <>
          <div className="section-title">
            응답 상세: <span className="mono small">{viewing.label}</span>
          </div>
          <ResponseView key={viewing.id} run={viewing} />
        </>
      )}
    </>
  )
}

function HistoryTab({ ep, onClear }) {
  const [viewing, setViewing] = useState(null)
  const runs = [...(ep.runs || [])].reverse()
  if (!runs.length) return <div className="muted">아직 테스트 기록이 없습니다.</div>
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="small muted">최근 50개 호출 기록 (조건 → 결과)</span>
        <span className="spacer" />
        <button className="btn sm ghost danger" onClick={onClear}>
          기록 지우기
        </button>
      </div>
      <RunTable runs={runs} onView={setViewing} />
      {viewing && (
        <>
          <div className="section-title">응답 상세</div>
          <ResponseView key={viewing.id} run={viewing} />
        </>
      )}
    </>
  )
}

function CodeTab({ req, toast }) {
  const [lang, setLang] = useState('curl')
  const code = lang === 'curl' ? toCurl(req) : lang === 'fetch' ? toFetch(req) : toPython(req)
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        {['curl', 'fetch', 'python'].map((l) => (
          <button key={l} className={`btn sm ${lang === l ? 'primary' : ''}`} onClick={() => setLang(l)}>
            {l === 'curl' ? 'cURL' : l === 'fetch' ? 'JavaScript fetch' : 'Python requests'}
          </button>
        ))}
        <span className="spacer" />
        <button className="btn sm" onClick={() => copyText(code, toast)}>
          복사
        </button>
      </div>
      <pre className="code">{code}</pre>
      <p className="hint">테스트 탭의 현재 조건값으로 생성됩니다.</p>
    </>
  )
}

function EvidenceTab({ ep }) {
  const [open, setOpen] = useState(null)
  return (
    <>
      {ep.evidence.length > 0 && (
        <>
          <div className="section-title">발견 근거 (소스 코드)</div>
          {ep.evidence.map((e, i) => (
            <pre className="code small" key={i} style={{ marginBottom: 6 }}>
              {e}
            </pre>
          ))}
        </>
      )}
      <div className="section-title">관측된 요청/응답 샘플 {ep.samples.length}개</div>
      {!ep.samples.length && <div className="muted small">샘플이 없습니다.</div>}
      {ep.samples
        .slice()
        .reverse()
        .map((s, i) => (
          <div key={i} className="step" style={{ marginBottom: 6 }}>
            <div className="row" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === i ? null : i)}>
              <Method m={s.request.method} />
              <span className="mono small grow" style={{ wordBreak: 'break-all' }}>
                {s.request.url}
              </span>
              {s.response && <Status code={s.response.status} />}
            </div>
            {open === i && (
              <div style={{ marginTop: 8 }}>
                {s.request.body && (
                  <>
                    <div className="small muted">요청 본문</div>
                    <pre className="code">{s.request.body}</pre>
                  </>
                )}
                {s.response?.body ? (
                  safeJson(s.response.body) !== undefined ? (
                    <JsonView value={safeJson(s.response.body)} />
                  ) : (
                    <pre className="code">{s.response.body.slice(0, 50000)}</pre>
                  )
                ) : (
                  <div className="muted small">응답 본문 없음</div>
                )}
              </div>
            )}
          </div>
        ))}
    </>
  )
}
