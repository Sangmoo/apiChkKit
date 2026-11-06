import { useRef, useState } from 'react'
import { Tabs, copyText } from './common.jsx'
import { CAPTURE_SCRIPT } from '../lib/captureScript.js'

const EXAMPLES = [
  { label: 'JSONPlaceholder (JSON API)', url: 'https://jsonplaceholder.typicode.com/posts?userId=1' },
  { label: 'Petstore (OpenAPI 스펙)', url: 'https://petstore3.swagger.io/api/v3/openapi.json' },
  { label: 'PokeAPI', url: 'https://pokeapi.co/api/v2/pokemon?limit=5&offset=0' },
  { label: 'Countries GraphQL', url: 'https://countries.trevorblades.com/graphql' },
]

export default function InputPanel({ busy, onAnalyzeUrl, onImport, toast }) {
  const [tab, setTab] = useState('url')
  const [url, setUrl] = useState('')
  const [paste, setPaste] = useState({ capture: '', curl: '', spec: '' })
  const [includeAll, setIncludeAll] = useState(false)
  const fileRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  const readFile = (file, kind) => {
    const r = new FileReader()
    r.onload = () => onImport(kind, String(r.result), { name: file.name, includeAll })
    r.readAsText(file)
  }

  const submitUrl = (e) => {
    e?.preventDefault()
    if (url.trim()) onAnalyzeUrl(url.trim())
  }

  return (
    <div className="card">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'url', label: '🔗 URL 분석' },
          { id: 'capture', label: '🎯 캡처 스크립트' },
          { id: 'har', label: '📦 HAR 업로드' },
          { id: 'curl', label: '⌨️ cURL' },
          { id: 'spec', label: '📘 OpenAPI 스펙' },
        ]}
      />
      <div className="card-b">
        {tab === 'url' && (
          <>
            <form className="row" onSubmit={submitUrl}>
              <input
                className="input grow"
                placeholder="https://example.com 또는 https://api.example.com/v1/items?page=1"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoFocus
              />
              <button className="btn primary" disabled={busy || !url.trim()}>
                {busy ? <span className="spin" /> : '분석'}
              </button>
            </form>
            <div className="row wrap" style={{ marginTop: 8 }}>
              <span className="muted small">예시:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.url}
                  className="btn sm"
                  disabled={busy}
                  onClick={() => {
                    setUrl(ex.url)
                    onAnalyzeUrl(ex.url)
                  }}
                >
                  {ex.label}
                </button>
              ))}
            </div>
            <p className="hint">
              <b>웹페이지 URL</b>이면 HTML·JS 번들을 정적 분석하고 OpenAPI/Swagger 스펙을 탐색합니다. <b>API URL</b>이면 응답을 직접 받아 조건값·결과값 구조를
              분석합니다. 브라우저 CORS 제한 때문에 막히면 프록시를 거치며, 프록시는 ⚙️ 설정에서 바꿀 수 있습니다.
            </p>
          </>
        )}

        {tab === 'capture' && (
          <>
            <ol className="small" style={{ margin: '0 0 10px', paddingLeft: 18 }}>
              <li>분석할 사이트를 열고 <b>F12 → Console</b> 탭에서 아래 스크립트를 붙여넣고 실행합니다.</li>
              <li>검색, 필터, 페이지 이동 등 확인하고 싶은 동작을 해봅니다.</li>
              <li>
                콘솔에 <code>__ackDone()</code> 를 입력하면 결과가 클립보드에 복사됩니다 → 아래에 붙여넣기.
              </li>
            </ol>
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="btn" onClick={() => copyText(CAPTURE_SCRIPT, toast)}>
                📋 캡처 스크립트 복사
              </button>
              <span className="muted small">실제 페이지가 호출한 API의 요청값·응답값을 그대로 수집 (CORS 무관, 가장 정확)</span>
            </div>
            <textarea
              className="input"
              placeholder='{"apiChkKitCapture":1, "entries":[...]} 붙여넣기'
              value={paste.capture}
              onChange={(e) => setPaste({ ...paste, capture: e.target.value })}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={!paste.capture.trim()} onClick={() => onImport('capture', paste.capture, { name: '캡처' })}>
                캡처 결과 분석
              </button>
            </div>
          </>
        )}

        {tab === 'har' && (
          <>
            <div
              className="step"
              style={{ textAlign: 'center', padding: 28, cursor: 'pointer', borderStyle: 'dashed', borderColor: dragOver ? 'var(--accent)' : undefined }}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                const f = e.dataTransfer.files?.[0]
                if (f) readFile(f, 'har')
              }}
            >
              <b>.har 파일을 끌어다 놓거나 클릭해서 선택</b>
              <div className="muted small">개발자 도구 → Network 탭 → 마우스 오른쪽 → "Save all as HAR with content"</div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".har,.json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) readFile(f, 'har')
                e.target.value = ''
              }}
            />
            <label className="row small" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={includeAll} onChange={(e) => setIncludeAll(e.target.checked)} />
              정적 리소스를 포함한 모든 요청 가져오기 (기본: XHR/fetch·JSON 응답만)
            </label>
            <p className="hint">HAR 파일은 브라우저에서만 처리되며 서버로 전송되지 않습니다. 쿠키/토큰이 포함될 수 있으니 공유 시 주의하세요.</p>
          </>
        )}

        {tab === 'curl' && (
          <>
            <textarea
              className="input"
              placeholder={"curl 'https://api.example.com/v1/search?q=test' -H 'Accept: application/json'\n\n(여러 개 붙여넣기 가능 — Network 탭 → Copy as cURL)"}
              value={paste.curl}
              onChange={(e) => setPaste({ ...paste, curl: e.target.value })}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={!paste.curl.trim()} onClick={() => onImport('curl', paste.curl, { name: 'cURL' })}>
                cURL 가져오기
              </button>
              <span className="muted small">bash / Windows cmd 형식 모두 지원</span>
            </div>
          </>
        )}

        {tab === 'spec' && (
          <>
            <textarea
              className="input"
              placeholder="OpenAPI 3.x / Swagger 2.0 문서(JSON 또는 YAML)를 붙여넣거나, URL 분석 탭에 스펙 URL을 입력하세요."
              value={paste.spec}
              onChange={(e) => setPaste({ ...paste, spec: e.target.value })}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={!paste.spec.trim()} onClick={() => onImport('openapi', paste.spec, { name: 'OpenAPI' })}>
                스펙 분석
              </button>
              <label className="btn">
                파일 선택
                <input
                  type="file"
                  accept=".json,.yaml,.yml"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) readFile(f, 'openapi')
                    e.target.value = ''
                  }}
                />
              </label>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
