import { useMemo, useState } from 'react'
import { copyText, Method } from './common.jsx'
import { buildSiteRunScript, parseSiteRunResults, SITE_RUN_LIMIT } from '../lib/captureScript.js'

/**
 * 앱에서 조립한 요청을 대상 사이트 탭에서 실행하고, 결과를 붙여넣어 받는 창.
 * @param requests [{id,label,url,method,headers,body}]
 * @param onApply  (results) => void
 */
export default function SiteRunModal({ requests, onApply, onClose, toast }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const script = useMemo(() => buildSiteRunScript(requests), [requests])
  const site = useMemo(() => {
    try {
      return new URL(requests[0].url).origin
    } catch {
      return ''
    }
  }, [requests])

  function apply() {
    try {
      const results = parseSiteRunResults(text.trim())
      onApply(results)
      onClose()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="card modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="card-h">
          🌐 대상 사이트에서 실행 <span className="badge">{Math.min(requests.length, SITE_RUN_LIMIT)}건</span>
          <span className="spacer" />
          <button className="btn sm ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="card-b">
          <p className="small" style={{ marginTop: 0 }}>
            이 사이트는 다른 출처(이 웹앱)에서 오는 요청을 막습니다. 아래 스크립트를 <b>대상 사이트를 연 탭</b>의 콘솔에서 실행하면, 사이트가 자기 화면에서 하는 것과 같은 방식으로 요청을 보내고 결과를 모아 줍니다. 요청 사이에 0.4초 간격을 두며, 한 번에 최대 {SITE_RUN_LIMIT}건만 실행합니다.
          </p>
          <ol className="small" style={{ paddingLeft: 18 }}>
            <li>
              대상 사이트 열기: {site && (
                <a href={site} target="_blank" rel="noreferrer">
                  {site}
                </a>
              )}
            </li>
            <li>
              <button className="btn sm primary" onClick={() => copyText(script, toast)}>
                📋 실행 스크립트 복사
              </button>{' '}
              → 그 탭에서 F12 → Console 에 붙여넣고 Enter
            </li>
            <li>오른쪽 아래 패널에 "완료"가 뜨면 <b>[결과 복사]</b> → 아래에 붙여넣기</li>
          </ol>
          <div className="table-wrap" style={{ maxHeight: 160, overflowY: 'auto', marginBottom: 10 }}>
            <table className="t">
              <tbody>
                {requests.slice(0, SITE_RUN_LIMIT).map((r) => (
                  <tr key={r.id}>
                    <td style={{ width: 70 }}>
                      <Method m={r.method} />
                    </td>
                    <td className="mono small">{r.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <textarea className="input" placeholder='{"apiChkKitRun":1, "results":[...]} 붙여넣기' value={text} onChange={(e) => setText(e.target.value)} />
          {error && <div className="hint" style={{ color: 'var(--err)' }}>{error}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              취소
            </button>
            <button className="btn primary" disabled={!text.trim()} onClick={apply}>
              결과 반영
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
