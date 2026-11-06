import { useCallback, useEffect, useRef, useState } from 'react'
import InputPanel from './components/InputPanel.jsx'
import EndpointList from './components/EndpointList.jsx'
import EndpointDetail from './components/EndpointDetail.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import { DEFAULT_SETTINGS } from './lib/net.js'
import { analyzeUrl, graphqlIntrospect } from './lib/analyzer.js'
import { mergeEndpoints, observationsToEndpoints } from './lib/endpoint.js'
import { parseHar, parseCapture, parseCurl, detectPasteKind } from './lib/importers.js'
import { parseSpecText, specToEndpoints, endpointsToOpenApi } from './lib/openapi.js'
import { toMarkdown, download } from './lib/report.js'

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k)
      return v ? JSON.parse(v) : d
    } catch {
      return d
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {
      /* 저장 공간 부족 등은 무시 */
    }
  },
}

export default function App() {
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS, ...LS.get('ack.settings', {}) }))
  const [theme, setTheme] = useState(() => LS.get('ack.theme', window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  const [endpoints, setEndpoints] = useState(() => LS.get('ack.endpoints', []))
  const [selectedId, setSelectedId] = useState(() => LS.get("ack.endpoints", [])[0]?.id || null)
  const [logs, setLogs] = useState([])
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState(() => LS.get('ack.target', ''))
  const [showSettings, setShowSettings] = useState(false)
  const [menu, setMenu] = useState(false)
  const [toastMsg, setToastMsg] = useState('')
  const projectFileRef = useRef(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    LS.set('ack.theme', theme)
  }, [theme])
  useEffect(() => LS.set('ack.settings', settings), [settings])
  useEffect(() => {
    // 세션 복원을 위해 가볍게 저장 (샘플 본문 제외)
    const t = setTimeout(() => {
      LS.set(
        'ack.endpoints',
        endpoints.map((e) => ({ ...e, samples: e.samples.slice(-3).map((s) => ({ ...s, response: s.response && { ...s.response, body: (s.response.body || '').slice(0, 5000) } })), runs: (e.runs || []).slice(-20).map((r) => ({ ...r, text: (r.text || '').slice(0, 5000) })) })),
      )
      LS.set('ack.target', target)
    }, 400)
    return () => clearTimeout(t)
  }, [endpoints, target])

  const toast = useCallback((m) => {
    setToastMsg(m)
    setTimeout(() => setToastMsg(''), 1800)
  }, [])

  const log = useCallback((msg, level = 'info') => {
    setLogs((l) => [...l, { t: new Date().toLocaleTimeString(), msg, level }])
  }, [])

  const addEndpoints = useCallback((eps, { replace = false } = {}) => {
    setEndpoints((cur) => {
      const merged = mergeEndpoints(replace ? [] : cur, eps)
      return merged
    })
    if (eps[0]) setSelectedId((id) => (replace || !id ? eps[0].id : id))
  }, [])

  async function onAnalyzeUrl(url) {
    setBusy(true)
    setLogs([])
    setTarget(url)
    try {
      const res = await analyzeUrl(url, settings, log)
      // 확실 → 추정 → 약한 추정 순으로 정렬
      const rank = { high: 0, medium: 1, low: 2 }
      const sorted = [...res.endpoints].sort((a, b) => rank[a.confidence] - rank[b.confidence])
      if (sorted.length) addEndpoints(sorted, { replace: true })
      else setEndpoints([])
    } catch (e) {
      log(`오류: ${e.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  function onImport(kind, text, { name, includeAll } = {}) {
    setLogs([])
    try {
      const detected = detectPasteKind(text)
      const k = kind === 'capture' && detected ? detected : kind
      let eps = []
      if (k === 'openapi') {
        const { endpoints: e, info } = specToEndpoints(parseSpecText(text), null)
        log(`OpenAPI: ${info.title || ''} ${info.version || ''} → ${e.length}개 엔드포인트 (base: ${info.base})`, 'ok')
        eps = e
      } else {
        const parsed = k === 'har' ? parseHar(text, { includeAll }) : k === 'curl' ? parseCurl(text) : parseCapture(text)
        const source = k === 'har' ? 'har' : k === 'curl' ? 'curl' : 'capture'
        eps = observationsToEndpoints(parsed.observations, source)
        log(`${name || source}: 요청 ${parsed.total}개 중 API ${parsed.observations.length}개 → 엔드포인트 ${eps.length}개 (제외 ${parsed.skipped}개)`, eps.length ? 'ok' : 'warn')
        if (parsed.page) setTarget(parsed.page)
      }
      if (!eps.length) log('가져올 API 요청이 없습니다.', 'warn')
      addEndpoints(eps)
      if (eps.length) toast(`${eps.length}개 엔드포인트를 가져왔습니다`)
    } catch (e) {
      log(`가져오기 실패: ${e.message}`, 'error')
    }
  }

  async function onIntrospect(url) {
    setBusy(true)
    log(`GraphQL introspection: ${url}`)
    try {
      const eps = await graphqlIntrospect(url, settings)
      log(`GraphQL query/mutation ${eps.length}개 발견`, 'ok')
      addEndpoints(eps)
      if (eps[0]) setSelectedId(eps[0].id)
    } catch (e) {
      log(`GraphQL introspection 실패: ${e.message}`, 'error')
      toast('introspection 실패 — 로그를 확인하세요')
    } finally {
      setBusy(false)
    }
  }

  function onAddManual() {
    const input = window.prompt('추가할 API를 입력하세요 (예: GET https://api.example.com/items?page=1)')
    if (!input) return
    const m = input.trim().match(/^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(.+)$/i)
    const method = m ? m[1].toUpperCase() : 'GET'
    let url = (m ? m[2] : input).trim()
    if (!/^https?:\/\//.test(url)) url = 'https://' + url
    const eps = observationsToEndpoints([{ method, url }], 'manual')
    if (!eps.length) return toast('URL 형식이 올바르지 않습니다')
    addEndpoints(eps)
    setSelectedId(eps[0].id)
  }

  const updateEndpoint = useCallback((id, fn) => setEndpoints((cur) => cur.map((e) => (e.id === id ? fn(e) : e))), [])
  const removeEndpoint = (id) => {
    setEndpoints((cur) => cur.filter((e) => e.id !== id))
    setSelectedId(null)
  }

  function exportAs(kind) {
    setMenu(false)
    const stamp = new Date().toISOString().slice(0, 10)
    if (kind === 'md') download(`api-report-${stamp}.md`, toMarkdown(endpoints, { target }), 'text/markdown')
    if (kind === 'openapi') download(`openapi-${stamp}.json`, JSON.stringify(endpointsToOpenApi(endpoints, target ? `API of ${target}` : undefined), null, 2), 'application/json')
    if (kind === 'project') download(`apichkkit-project-${stamp}.json`, JSON.stringify({ apiChkKitProject: 1, target, endpoints }, null, 2), 'application/json')
    if (kind === 'load') projectFileRef.current?.click()
  }

  function loadProject(file) {
    const r = new FileReader()
    r.onload = () => {
      try {
        const data = JSON.parse(String(r.result))
        if (!data.apiChkKitProject) throw new Error('API Check Kit 프로젝트 파일이 아닙니다')
        setEndpoints(data.endpoints || [])
        setTarget(data.target || '')
        setSelectedId(data.endpoints?.[0]?.id || null)
        toast('프로젝트를 불러왔습니다')
      } catch (e) {
        toast(e.message)
      }
    }
    r.readAsText(file)
  }

  const selected = endpoints.find((e) => e.id === selectedId) || null

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">✓</div>
          <div>
            API Check Kit <small className="hide-sm">URL → API 분석 · 조건값별 결과 확인</small>
          </div>
        </div>
        <span className="spacer" />
        <div className="menu">
          <button className="btn" onClick={() => setMenu(!menu)}>
            내보내기 ▾
          </button>
          {menu && (
            <div className="card menu-pop" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => exportAs('md')} disabled={!endpoints.length}>
                📝 Markdown 리포트
              </button>
              <button onClick={() => exportAs('openapi')} disabled={!endpoints.length}>
                📘 OpenAPI 3 스펙 (JSON)
              </button>
              <button onClick={() => exportAs('project')} disabled={!endpoints.length}>
                💾 프로젝트 저장
              </button>
              <button onClick={() => exportAs('load')}>📂 프로젝트 불러오기</button>
            </div>
          )}
          <input
            ref={projectFileRef}
            type="file"
            accept=".json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) loadProject(f)
              e.target.value = ''
            }}
          />
        </div>
        <button className="btn" onClick={() => setShowSettings(true)} title="네트워크 설정">
          ⚙️ <span className="hide-sm">설정</span>
        </button>
        <button className="btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="테마 전환">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </header>

      <InputPanel busy={busy} onAnalyzeUrl={onAnalyzeUrl} onImport={onImport} toast={toast} />

      {logs.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-h small">
            분석 로그 {busy && <span className="spin" />}
            <span className="spacer" />
            <button className="btn sm ghost" onClick={() => setLogs([])}>
              닫기
            </button>
          </div>
          <div className="log">
            {logs.map((l, i) => (
              <div key={i} className={l.level}>
                <span className="muted">{l.t}</span> {l.msg}
              </div>
            ))}
          </div>
        </div>
      )}

      {endpoints.length > 0 ? (
        <div className="layout">
          <EndpointList
            endpoints={endpoints}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onAdd={onAddManual}
            onClear={() => {
              if (window.confirm('분석 결과를 모두 지울까요?')) {
                setEndpoints([])
                setSelectedId(null)
              }
            }}
          />
          {selected ? (
            <EndpointDetail key={selected.id} ep={selected} settings={settings} onUpdate={updateEndpoint} onIntrospect={onIntrospect} onRemove={removeEndpoint} toast={toast} />
          ) : (
            <div className="card empty">목록에서 엔드포인트를 선택하세요</div>
          )}
        </div>
      ) : (
        <Welcome />
      )}

      <div className="footer">
        API Check Kit · 모든 분석은 브라우저 안에서 수행됩니다 ·{' '}
        <a href="https://github.com/Sangmoo/apiChkKit" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>

      {showSettings && <SettingsModal settings={settings} onSave={setSettings} onClose={() => setShowSettings(false)} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  )
}

function Welcome() {
  return (
    <div className="card hero" style={{ marginTop: 12 }}>
      <h2>어떤 API를 쓰는지, 어떤 조건에 어떤 결과가 나오는지</h2>
      <div className="muted">URL 하나로 시작해서 API 목록 → 요청 조건값 → 응답 결과값 → 조건별 비교까지 한 화면에서 확인합니다.</div>
      <div className="steps">
        <div className="step">
          <b>1. 수집</b>
          URL 정적 분석(HTML·JS 번들·OpenAPI·WordPress·Next.js·GraphQL), 캡처 스크립트, HAR, cURL 중 편한 방식으로 API를 찾습니다.
        </div>
        <div className="step">
          <b>2. 조건값 → 결과값</b>
          엔드포인트마다 query/path/body/header 조건값과 관측값, 응답 필드 구조와 예시값을 표로 정리합니다.
        </div>
        <div className="step">
          <b>3. 테스트</b>
          조건값을 바꿔 바로 호출하고 응답을 JSON 트리·결과 필드로 확인합니다. 결과는 응답 구조에 자동 반영됩니다.
        </div>
        <div className="step">
          <b>4. 조건 비교</b>
          파라미터 하나를 여러 값으로 바꿔 호출해 상태코드·결과 개수·응답 구조 변화를 한 번에 비교합니다.
        </div>
      </div>
    </div>
  )
}
