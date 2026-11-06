import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown.jsx'
import { copyText } from './common.jsx'
import { chatStream, aiErrorMessage, AI_MODELS } from '../lib/ai.js'

/**
 * Claude 와 대화하는 패널.
 * @param ai          AI 설정 (키, 모델, effort)
 * @param getContext  호출 시점의 분석 데이터 문자열을 돌려주는 함수
 * @param presets     빠른 질문 버튼 [{id,label,prompt}]
 * @param messages / setMessages  대화 기록 (부모가 보관)
 */
export default function AiChat({ ai, getContext, presets, messages, setMessages, onOpenSettings, toast }) {
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef(null)
  const endRef = useRef(null)

  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [streaming, messages.length])

  if (!ai.apiKey) {
    return (
      <div className="step">
        <b>🤖 Claude AI 분석</b>
        <p className="small" style={{ margin: '6px 0 10px' }}>
          Claude API 키를 입력하면 이 API의 용도, 조건값과 결과값의 의미, 테스트 시나리오, 테스트 결과 해석, 호출 코드를 Claude 에게 물어볼 수 있습니다.
        </p>
        <button className="btn primary" onClick={onOpenSettings}>
          ⚙️ API 키 입력하기
        </button>
        <p className="hint">
          키는 <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Anthropic Console</a> 에서 발급합니다. 요청은 이 브라우저에서 api.anthropic.com 으로 바로 가며, 사용 요금은 키 소유자에게 청구됩니다.
        </p>
      </div>
    )
  }

  async function ask(text) {
    const q = text.trim()
    if (!q || busy) return
    setError('')
    setInput('')
    const history = [...messages, { role: 'user', content: q }]
    setMessages(history)
    setBusy(true)
    setStreaming('')
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await chatStream(ai, history, { context: getContext(), signal: ctrl.signal, onText: (_, full) => setStreaming(full) })
      setMessages([...history, { role: 'assistant', content: res.text, model: res.model, usage: res.usage }])
    } catch (e) {
      const msg = aiErrorMessage(e)
      setError(msg)
      // 실패한 질문은 대화 기록에서 빼서 다시 보낼 수 있게 한다
      setMessages(messages)
      setInput(q)
    } finally {
      setBusy(false)
      setStreaming('')
      abortRef.current = null
    }
  }

  const modelLabel = AI_MODELS.find((m) => m.id === ai.model)?.label.split(' (')[0] || ai.model
  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        {presets.map((p) => (
          <button key={p.id} className="btn sm" disabled={busy} onClick={() => ask(p.prompt)}>
            {p.label}
          </button>
        ))}
        <span className="spacer" />
        <span className="badge accent" title="⚙️ 설정에서 변경">
          {modelLabel} · {ai.effort}
        </span>
        {messages.length > 0 && (
          <button className="btn sm ghost danger" disabled={busy} onClick={() => setMessages([])}>
            대화 지우기
          </button>
        )}
      </div>

      <div className="chat">
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.role === 'assistant' ? (
              <>
                <Markdown text={m.content} />
                <div className="row small muted" style={{ marginTop: 6 }}>
                  {m.usage && (
                    <span>
                      입력 {m.usage.input_tokens + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0)} · 출력 {m.usage.output_tokens} 토큰
                    </span>
                  )}
                  <span className="spacer" />
                  <button className="btn sm ghost" onClick={() => copyText(m.content, toast)}>
                    복사
                  </button>
                </div>
              </>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
            )}
          </div>
        ))}
        {busy && (
          <div className="bubble assistant">
            {streaming ? <Markdown text={streaming} /> : <span className="muted small"><span className="spin" /> Claude 가 분석 중입니다…</span>}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <div className="step small" style={{ borderColor: 'var(--err)', color: 'var(--err)', margin: '8px 0' }}>
          {error}
        </div>
      )}

      <form
        className="row"
        style={{ marginTop: 8, alignItems: 'flex-end' }}
        onSubmit={(e) => {
          e.preventDefault()
          ask(input)
        }}
      >
        <textarea
          className="input grow"
          style={{ minHeight: 44, fontFamily: 'inherit', fontSize: 14 }}
          rows={2}
          placeholder="이 API에 대해 질문하세요 (Enter 전송, Shift+Enter 줄바꿈)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              ask(input)
            }
          }}
        />
        {busy ? (
          <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
            중지
          </button>
        ) : (
          <button className="btn primary" disabled={!input.trim()}>
            보내기
          </button>
        )}
      </form>
    </div>
  )
}
