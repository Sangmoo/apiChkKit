// 사용자가 입력한 Claude API 키로 브라우저에서 직접 Claude 를 호출한다.
// 키는 이 브라우저 밖으로 나가지 않으며, 요청은 api.anthropic.com 으로 바로 전송된다.
import Anthropic from '@anthropic-ai/sdk'
import { flattenSchema } from './schema.js'

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (기본, 가장 정확)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (빠르고 저렴)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (가장 빠르고 저렴)' },
]

export const DEFAULT_AI = {
  apiKey: '',
  remember: false, // true 면 localStorage 에 키 저장
  model: 'claude-opus-5-5',
  effort: 'medium',
}

// 안전 분류기가 거절한 요청을 다른 모델로 이어서 처리 (Haiku 는 미지원)
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5'])

const SYSTEM = `당신은 API 분석 도우미입니다. 사용자는 "API Check Kit" 이라는 도구로 웹사이트가 사용하는 API를 수집했고, 각 API에 어떤 조건값(요청 파라미터)을 넣으면 어떤 결과값(응답 필드)을 받는지 이해하려고 합니다.
- 항상 한국어로 답합니다.
- 제공된 분석 데이터(파라미터, 관측값, 응답 스키마, 테스트 기록)에 근거해 답하고, 추측한 부분은 "추정"이라고 밝힙니다.
- 데이터에 없는 사실(인증 방식, 요금 등)을 지어내지 않습니다.
- 마크다운(제목, 목록, 표, 코드 블록)으로 읽기 쉽게 정리합니다.
- 허가되지 않은 대상에 대한 공격, 인증 우회, 과도한 요청을 돕지 않습니다.`

function client(ai) {
  if (!ai.apiKey?.trim()) throw new Error('Claude API 키가 없습니다. ⚙️ 설정에서 키를 입력하세요.')
  return new Anthropic({ apiKey: ai.apiKey.trim(), dangerouslyAllowBrowser: true, maxRetries: 1 })
}

/** 오류를 사용자에게 보여줄 한국어 메시지로 변환 */
export function aiErrorMessage(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'API 키가 올바르지 않습니다 (401). 키를 다시 확인하세요.'
  if (e instanceof Anthropic.PermissionDeniedError) return '이 키로는 해당 모델을 사용할 권한이 없습니다 (403).'
  if (e instanceof Anthropic.NotFoundError) return '모델을 찾을 수 없습니다 (404). 설정에서 다른 모델을 선택해 보세요.'
  if (e instanceof Anthropic.RateLimitError) return '요청 한도를 초과했습니다 (429). 잠시 후 다시 시도하세요.'
  if (e instanceof Anthropic.BadRequestError) return `잘못된 요청입니다 (400): ${e.message}`
  if (e instanceof Anthropic.APIUserAbortError) return '중단했습니다.'
  if (e instanceof Anthropic.APIConnectionError) return 'Anthropic API 에 연결하지 못했습니다. 네트워크를 확인하세요.'
  if (e instanceof Anthropic.APIError) return `API 오류 ${e.status ?? ''}: ${e.message}`
  return e?.message || String(e)
}

/**
 * 스트리밍으로 대화를 보낸다.
 * @param {object} ai 설정 { apiKey, model, effort }
 * @param {Array<{role:'user'|'assistant', content:string}>} messages
 * @param {{ onText?: (delta:string, full:string)=>void, signal?: AbortSignal, context?: string }} opts
 * @returns {Promise<{ text:string, stopReason:string, usage:object, model:string, refused:boolean }>}
 */
export async function chatStream(ai, messages, { onText, signal, context } = {}) {
  const c = client(ai)
  const params = {
    model: ai.model || DEFAULT_AI.model,
    max_tokens: 16000,
    output_config: { effort: ai.effort || 'medium' },
    // 고정된 시스템 프롬프트 + 분석 데이터는 캐시해서 같은 API에 대해 여러 번 질문할 때 비용을 줄인다
    system: [
      { type: 'text', text: SYSTEM },
      ...(context ? [{ type: 'text', text: `<분석_데이터>\n${context}\n</분석_데이터>`, cache_control: { type: 'ephemeral' } }] : []),
    ],
    // 화면용으로 붙인 model/usage 등은 빼고 role/content 만 보낸다
    messages: messages.map(({ role, content }) => ({ role, content })),
  }
  if (FALLBACK_MODELS.has(params.model)) {
    params.betas = ['server-side-fallback-2026-07-01']
    params.fallbacks = 'default'
  }
  const stream = c.beta.messages.stream(params, { signal })
  let full = ''
  stream.on('text', (delta) => {
    full += delta
    onText?.(delta, full)
  })
  const msg = await stream.finalMessage()
  const refused = msg.stop_reason === 'refusal'
  let text = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  if (refused) text += `\n\n> ⚠️ Claude 가 이 요청에 답하지 않았습니다${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}.`
  if (msg.stop_reason === 'max_tokens') text += '\n\n> ⚠️ 답변 길이 한도에 도달해 잘렸습니다.'
  return { text, stopReason: msg.stop_reason, usage: msg.usage, model: msg.model, refused }
}

/** 키 확인용 짧은 호출 */
export async function testKey(ai) {
  const c = client(ai)
  const res = await c.messages.create({
    model: ai.model || DEFAULT_AI.model,
    max_tokens: 64,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: '"연결 성공" 이라고만 답하세요.' }],
  })
  return res.content.find((b) => b.type === 'text')?.text?.trim() || '(응답 없음)'
}

// ---------------- 분석 데이터 → 프롬프트 컨텍스트 ----------------
const clip = (s, n) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s)
  return t && t.length > n ? t.slice(0, n) + '…(생략)' : t
}

export function endpointContext(ep) {
  const lines = []
  lines.push(`# ${ep.method} ${ep.url}`)
  if (ep.summary) lines.push(`요약: ${ep.summary}`)
  if (ep.description) lines.push(`설명: ${clip(ep.description, 1500)}`)
  lines.push(`출처: ${ep.sources.join(', ')} · 신뢰도: ${ep.confidence}`)
  if (ep.bodyType) lines.push(`요청 본문 형식: ${ep.bodyType}`)
  lines.push('\n## 요청 조건값')
  if (!ep.params.length) lines.push('(발견된 파라미터 없음)')
  for (const p of ep.params) {
    const vals = [...new Set([p.example, ...(p.observed || [])].filter((v) => v !== undefined && v !== ''))].slice(0, 8)
    lines.push(
      `- ${p.name} [${p.in}, ${p.type}${p.required ? ', 필수' : ''}]` +
        (p.enum?.length ? ` 허용값: ${clip(p.enum.join(', '), 300)}` : '') +
        (vals.length ? ` 관측/예시: ${clip(vals.map(String).join(' | '), 300)}` : '') +
        (p.description ? ` — ${clip(p.description, 200)}` : '') +
        (p.note ? ` (${p.note})` : ''),
    )
  }
  if (ep.bodyExample) lines.push(`\n요청 본문 예시:\n${clip(ep.bodyExample, 2000)}`)
  for (const [st, r] of Object.entries(ep.responses)) {
    lines.push(`\n## 응답 ${st}${r.description ? ` — ${r.description}` : ''}`)
    const rows = flattenSchema(r.schema)
    for (const row of rows.slice(0, 150)) {
      lines.push(`- ${row.path}: ${row.type}${row.required ? '' : ' (일부 응답만)'}${row.examples?.length ? ` 예: ${clip(row.examples.slice(0, 3).map(String).join(' | '), 150)}` : ''}${row.description ? ` — ${clip(row.description, 150)}` : ''}`)
    }
    if (rows.length > 150) lines.push(`… 외 ${rows.length - 150}개 필드`)
  }
  const runs = (ep.runs || []).slice(-25)
  if (runs.length) {
    lines.push('\n## 테스트 기록 (조건 → 결과)')
    for (const r of runs) lines.push(`- ${r.label} → HTTP ${r.status || '실패'}, ${r.time || 0}ms, ${r.summary || ''}`)
  }
  const sample = [...ep.samples].reverse().find((s) => s.response?.body)
  if (sample) lines.push(`\n## 응답 샘플 (${sample.request.url})\n${clip(sample.response.body, 4000)}`)
  if (ep.evidence.length) lines.push(`\n## 발견 근거 코드\n${ep.evidence.slice(0, 3).map((e) => clip(e, 400)).join('\n')}`)
  return lines.join('\n')
}

export function overviewContext(endpoints, target) {
  const lines = [`분석 대상: ${target || '(미지정)'}`, `엔드포인트 ${endpoints.length}개`, '']
  for (const ep of endpoints.slice(0, 120)) {
    const params = ep.params.map((p) => `${p.name}(${p.in}${p.required ? ',필수' : ''})`).join(', ')
    const statuses = Object.keys(ep.responses).join('/')
    const fields = Object.values(ep.responses)
      .flatMap((r) => flattenSchema(r.schema).map((x) => x.path))
      .slice(0, 12)
      .join(', ')
    lines.push(`- ${ep.method} ${ep.url} [${ep.confidence}, ${ep.sources.join('/')}]${ep.summary ? ` ${ep.summary}` : ''}`)
    if (params) lines.push(`  조건값: ${clip(params, 400)}`)
    if (statuses) lines.push(`  응답: ${statuses}${fields ? ` 필드: ${clip(fields, 300)}` : ''}`)
  }
  if (endpoints.length > 120) lines.push(`… 외 ${endpoints.length - 120}개`)
  return lines.join('\n')
}

export const ENDPOINT_PRESETS = [
  {
    id: 'explain',
    label: '이 API 설명',
    prompt:
      '이 API가 무엇을 하는지 설명하고, 각 조건값이 어떤 의미이며 결과에 어떤 영향을 주는지, 주요 결과 필드가 무엇을 뜻하는지 표로 정리해 주세요.',
  },
  {
    id: 'scenarios',
    label: '테스트 시나리오 추천',
    prompt:
      '조건값별로 어떤 결과가 나오는지 확인하기 위한 테스트 시나리오를 추천해 주세요. 각 시나리오마다 넣을 조건값, 기대 결과, 확인할 응답 필드를 표로 정리하고, 경계값과 오류 케이스도 포함해 주세요.',
  },
  {
    id: 'results',
    label: '테스트 결과 해석',
    prompt:
      '테스트 기록(조건 → 결과)을 보고 어떤 조건이 결과를 어떻게 바꾸는지 해석해 주세요. 패턴, 이상한 점, 추가로 확인해 볼 만한 조건을 알려 주세요.',
  },
  {
    id: 'code',
    label: '호출 코드 작성',
    prompt: '이 API를 호출하고 주요 결과 필드를 꺼내 쓰는 JavaScript(fetch)와 Python(requests) 예제 코드를 작성해 주세요. 조건값은 함수 인자로 받도록 해 주세요.',
  },
]

export const OVERVIEW_PRESETS = [
  {
    id: 'summary',
    label: '전체 API 요약',
    prompt:
      '수집된 API 전체를 기능별로 묶어서 요약해 주세요. 각 그룹이 무엇을 하는지, 대표 조건값과 결과값, 그리고 신뢰도가 낮아 실제 호출로 확인이 필요한 항목을 알려 주세요.',
  },
  {
    id: 'priority',
    label: '먼저 확인할 API',
    prompt: '이 중에서 먼저 테스트해 보면 좋을 API 5개를 골라 이유와 함께 추천하고, 각각 어떤 조건값으로 시작하면 좋을지 알려 주세요.',
  },
]
