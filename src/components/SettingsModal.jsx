import { useState } from 'react'
import { PUBLIC_PROXIES, request, applyProxy } from '../lib/net.js'
import { AI_MODELS, testKey, aiErrorMessage } from '../lib/ai.js'

export default function SettingsModal({ settings, ai, onSave, onClose }) {
  const [s, setS] = useState(settings)
  const [a, setA] = useState(ai)
  const [testMsg, setTestMsg] = useState('')
  const [aiMsg, setAiMsg] = useState('')
  const [showKey, setShowKey] = useState(false)
  const set = (patch) => setS({ ...s, ...patch })
  const setAi = (patch) => setA({ ...a, ...patch })

  async function checkKey() {
    setAiMsg('확인 중…')
    try {
      const reply = await testKey(a)
      setAiMsg(`✅ ${reply}`)
    } catch (e) {
      setAiMsg(`❌ ${aiErrorMessage(e)}`)
    }
  }

  async function testProxy() {
    if (!s.customProxy.trim()) return
    setTestMsg('확인 중…')
    const target = 'https://httpbin.org/get?from=apiChkKit'
    const r = await request({ url: target }, { ...s, mode: 'proxy', usePublicProxies: false })
    setTestMsg(r.status ? `응답 ${r.status} (${r.time}ms) — ${applyProxy(s.customProxy, target).slice(0, 80)}…` : `실패: ${r.attempts.join(' / ')}`)
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-h">
          ⚙️ 설정
          <span className="spacer" />
          <button className="btn sm ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="card-b">
          <div className="section-title">🤖 Claude AI</div>
          <div className="field">
            <label>Claude API 키</label>
            <div className="row">
              <input
                className="input grow mono"
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                placeholder="sk-ant-..."
                value={a.apiKey}
                onChange={(e) => setAi({ apiKey: e.target.value })}
              />
              <button className="btn" onClick={() => setShowKey(!showKey)} title="키 보기/숨기기">
                {showKey ? '🙈' : '👁'}
              </button>
              <button className="btn" onClick={checkKey} disabled={!a.apiKey.trim()}>
                키 확인
              </button>
            </div>
            {aiMsg && <div className="hint">{aiMsg}</div>}
            <label className="row small" style={{ fontWeight: 400, marginTop: 6 }}>
              <input type="checkbox" checked={a.remember} onChange={(e) => setAi({ remember: e.target.checked })} />
              이 브라우저에 키 저장 (끄면 탭을 닫을 때 지워짐)
            </label>
            <p className="hint">
              키는 <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Anthropic Console</a> 에서 발급합니다. 키는 서버로 보내지 않고 이 브라우저에서 api.anthropic.com 으로만 전송됩니다. 공용 PC에서는 저장하지 마세요. 사용 요금은 키 소유자에게 청구됩니다.
            </p>
          </div>
          <div className="row wrap" style={{ gap: 14, marginBottom: 14 }}>
            <div className="field grow" style={{ marginBottom: 0, minWidth: 220 }}>
              <label>모델</label>
              <select className="select" value={a.model} onChange={(e) => setAi({ model: e.target.value })}>
                {AI_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>분석 깊이 (effort)</label>
              <select className="select" value={a.effort} onChange={(e) => setAi({ effort: e.target.value })}>
                <option value="low">low · 빠름</option>
                <option value="medium">medium · 기본</option>
                <option value="high">high · 꼼꼼함</option>
              </select>
            </div>
          </div>

          <div className="section-title">🌐 네트워크</div>
          <div className="field">
            <label>호출 방식</label>
            <div className="radio-row">
              {[
                ['auto', '자동 (직접 → 실패 시 프록시)'],
                ['direct', '직접 호출만'],
                ['proxy', '프록시만'],
              ].map(([v, l]) => (
                <label key={v}>
                  <input type="radio" name="mode" checked={s.mode === v} onChange={() => set({ mode: v })} /> {l}
                </label>
              ))}
            </div>
            <p className="hint">
              정적 웹앱이라 브라우저에서 바로 호출합니다. 대상 서버가 CORS를 허용하지 않으면 프록시가 필요합니다. 쿠키 기반 로그인 API는 직접 호출 시에도 쿠키가 전달되지 않으니 캡처 스크립트를 이용하세요.
            </p>
          </div>
          <div className="field">
            <label>개인 CORS 프록시 URL (권장)</label>
            <div className="row">
              <input
                className="input grow mono"
                placeholder="https://my-proxy.example.workers.dev/?url={url}"
                value={s.customProxy}
                onChange={(e) => set({ customProxy: e.target.value })}
              />
              <button className="btn" onClick={testProxy} disabled={!s.customProxy.trim()}>
                연결 테스트
              </button>
            </div>
            {testMsg && <div className="hint mono">{testMsg}</div>}
            <p className="hint">
              <code>{'{url}'}</code> 자리에 인코딩된 대상 URL이 들어갑니다. 저장소의 <code>proxy/worker.js</code> 를 Cloudflare Workers 에 무료로 배포해 사용할 수 있습니다 (README 참고).
            </p>
          </div>
          <div className="field">
            <label className="row" style={{ fontWeight: 400 }}>
              <input type="checkbox" checked={s.usePublicProxies} onChange={(e) => set({ usePublicProxies: e.target.checked })} />
              공개 프록시도 시도 (불안정·속도 제한 가능, 민감한 데이터 전송 금지)
            </label>
            <div className="hint mono">{PUBLIC_PROXIES.join('\n')}</div>
          </div>
          <div className="field">
            <label>URL 분석 옵션</label>
            <label className="row" style={{ fontWeight: 400 }}>
              <input type="checkbox" checked={s.scanExternalScripts} onChange={(e) => set({ scanExternalScripts: e.target.checked })} />
              외부 JS 번들까지 내려받아 분석 (최대 25개)
            </label>
            <label className="row" style={{ fontWeight: 400 }}>
              <input type="checkbox" checked={s.probeSpecs} onChange={(e) => set({ probeSpecs: e.target.checked })} />
              OpenAPI/Swagger 스펙 경로 자동 탐색 (/openapi.json, /v3/api-docs …)
            </label>
          </div>
          <div className="field">
            <label>요청 타임아웃 (ms)</label>
            <input className="input" type="number" min={2000} step={1000} value={s.timeoutMs} onChange={(e) => set({ timeoutMs: Number(e.target.value) || 20000 })} style={{ maxWidth: 160 }} />
          </div>
          <div className="row">
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              취소
            </button>
            <button
              className="btn primary"
              onClick={() => {
                onSave(s, { ...a, apiKey: a.apiKey.trim() })
                onClose()
              }}
            >
              저장
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
