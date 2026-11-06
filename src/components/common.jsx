import { useState } from 'react'
import { flattenSchema } from '../lib/schema.js'

export function Method({ m }) {
  return <span className={`m ${m}`}>{m}</span>
}

export function Status({ code }) {
  const c = Number(code) || 0
  return <span className={`status s${String(c)[0] || 0}`}>{c || 'ERR'}</span>
}

export function Badge({ children, kind = '', title }) {
  return (
    <span className={`badge ${kind}`} title={title}>
      {children}
    </span>
  )
}

const SOURCE_LABEL = {
  openapi: 'OpenAPI 스펙',
  js: 'JS 정적분석',
  har: 'HAR',
  capture: '캡처',
  curl: 'cURL',
  direct: '직접 호출',
  form: 'HTML 폼',
  wordpress: 'WordPress',
  nextjs: 'Next.js',
  graphql: 'GraphQL',
  manual: '수동 추가',
  test: '테스트',
}
export const sourceLabel = (s) => SOURCE_LABEL[s] || s
export const CONF_LABEL = { high: '확실', medium: '추정', low: '약한 추정' }

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count != null && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function copyText(text, toast) {
  const done = () => toast?.('복사했습니다')
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done))
  else fallbackCopy(text, done)
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea')
  ta.value = text
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
    done()
  } finally {
    ta.remove()
  }
}

const fmt = (v) => (v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** 스키마 → "결과값" 필드 테이블 */
export function SchemaTable({ schema, empty }) {
  const rows = flattenSchema(schema)
  if (!schema) return <div className="muted small">{empty || '응답 구조 정보가 없습니다.'}</div>
  if (!rows.length) {
    return (
      <div className="small">
        응답 타입: <code>{schema.type}</code>
        {schema.examples?.length ? <> · 예: <code>{fmt(schema.examples[0])}</code></> : null}
      </div>
    )
  }
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>결과 필드</th>
            <th>타입</th>
            <th>예시값</th>
            <th>설명</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 400).map((r) => (
            <tr key={r.path}>
              <td className="mono">
                {r.path}
                {r.required ? '' : <span className="muted" title="일부 응답에만 존재"> ?</span>}
              </td>
              <td className="mono small">
                {r.type}
                {r.format ? <span className="muted"> ({r.format})</span> : null}
              </td>
              <td>
                <div className="chips">
                  {(r.enum || r.examples || []).slice(0, 5).map((e, i) => (
                    <span className="chip" key={i} title={fmt(e)}>
                      {fmt(e)}
                    </span>
                  ))}
                  {r.lengths?.length ? <span className="muted small">길이 {Math.min(...r.lengths)}~{Math.max(...r.lengths)}</span> : null}
                </div>
              </td>
              <td className="small">{r.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 400 && <div className="hint" style={{ padding: 8 }}>… {rows.length - 400}개 필드 생략</div>}
    </div>
  )
}

/** 접을 수 있는 JSON 트리 */
export function JsonView({ value }) {
  return (
    <div className="json">
      <JsonNode v={value} depth={0} />
    </div>
  )
}

function JsonNode({ k, v, depth, last = true }) {
  const [open, setOpen] = useState(depth < 2)
  const [limit, setLimit] = useState(100)
  const keyEl = k !== undefined ? <span className="k">{JSON.stringify(k)}</span> : null
  const comma = last ? '' : ','
  if (v && typeof v === 'object') {
    const isArr = Array.isArray(v)
    const entries = isArr ? v.map((x, i) => [i, x]) : Object.entries(v)
    const [o, c] = isArr ? ['[', ']'] : ['{', '}']
    if (!entries.length)
      return (
        <div>
          {keyEl}
          {keyEl ? ': ' : ''}
          {o + c}
          {comma}
        </div>
      )
    return (
      <div>
        <span className="tog" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </span>
        {keyEl}
        {keyEl ? ': ' : ''}
        {o}
        {!open && (
          <span className="z" style={{ cursor: 'pointer' }} onClick={() => setOpen(true)}>
            {' '}
            {isArr ? `${entries.length} items` : `${entries.length} keys`} {c}
            {comma}
          </span>
        )}
        {open && (
          <>
            <div className="ind">
              {entries.slice(0, limit).map(([kk, vv], i) => (
                <JsonNode key={kk} k={isArr ? undefined : kk} v={vv} depth={depth + 1} last={i === Math.min(entries.length, limit) - 1} />
              ))}
              {entries.length > limit && (
                <button className="btn sm" onClick={() => setLimit(limit + 200)}>
                  +{entries.length - limit}개 더 보기
                </button>
              )}
            </div>
            {c}
            {comma}
          </>
        )}
      </div>
    )
  }
  const cls = typeof v === 'string' ? 's' : typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 'z'
  return (
    <div>
      <span className="tog" />
      {keyEl}
      {keyEl ? ': ' : ''}
      <span className={cls}>{JSON.stringify(v)}</span>
      {comma}
    </div>
  )
}
