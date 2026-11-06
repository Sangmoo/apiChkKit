// HTML/JS 소스에서 API 호출 흔적(fetch, axios, XHR, url 문자열 등)을 찾아낸다. (정적 분석 → 추정)
import { NOISE_HOSTS, STATIC_EXT, guessType, newEndpoint, mergeEndpoints } from './endpoint.js'

const Q = `(?<q>['"\`])`
const U = `(?<u>[^'"\`\\n\\s]{1,400}?)\\k<q>`

const PATTERNS = [
  { kind: 'fetch', conf: 'high', re: new RegExp(`\\bfetch\\s*\\(\\s*${Q}${U}`, 'g') },
  {
    kind: 'client',
    conf: 'high',
    re: new RegExp(`[\\w$\\]\\)]\\s*\\.\\s*(?<m>get|post|put|patch|delete|head|getJSON)\\s*(?:<[^>()]{0,80}>)?\\s*\\(\\s*${Q}${U}`, 'gi'),
  },
  {
    kind: 'xhr',
    conf: 'high',
    re: new RegExp(`\\.open\\s*\\(\\s*['"](?<m>GET|POST|PUT|PATCH|DELETE|HEAD)['"]\\s*,\\s*${Q}${U}`, 'gi'),
  },
  { kind: 'url-key', conf: 'medium', re: new RegExp(`\\b(?:url|endpoint|baseURL|baseUrl|apiUrl|API_URL|path|uri|action)\\s*[:=]\\s*${Q}${U}`, 'g') },
  {
    kind: 'string',
    conf: 'low',
    re: new RegExp(`${Q}(?<u>(?:https?:)?\\/\\/[^'"\`\\s<>]{3,300}?|\\/[A-Za-z0-9_${'$'}{}.-]*(?:\\/[^'"\`\\s<>]*)?)\\k<q>`, 'g'),
  },
]

const API_HINT = /(^|[/.?_-])(api|apis|graphql|gql|rest|rpc|v\d{1,2}|ajax|json|service|services|svc|query|search|data|backend|gateway|openapi|oauth|auth|graphql)([/.?_-]|$)|\.(php|do|jsp|asp|aspx|json|action)(\?|$)|^https?:\/\/api\./i

function cleanTemplate(u) {
  // `${a.b}` → {b}, `${encodeURIComponent(q)}` → {q}
  return u.replace(/\$\{([^}]*)\}/g, (_, expr) => {
    const ids = expr.match(/[A-Za-z_$][\w$]*/g) || ['param']
    const skip = new Set(['encodeURIComponent', 'encodeURI', 'String', 'Number', 'this', 'props', 'params', 'options', 'opts', 'e', 't', 'n', 'r', 'i', 'o', 'a', 's', 'u', 'c', 'l', 'd'])
    const name = [...ids].reverse().find((x) => !skip.has(x)) || ids[ids.length - 1]
    return `{${name}}`
  })
}

function looksLikeApi(u, kind) {
  if (!u || u.length < 2) return false
  if (/^(data:|blob:|mailto:|tel:|javascript:|#|about:)/i.test(u)) return false
  if (/[<>()\\|*^]/.test(u)) return false
  if (/^\/\/?$/.test(u) || /^\/[*/]/.test(u)) return false
  if (STATIC_EXT.test(u.split('?')[0] + (u.includes('?') ? '?' : ''))) return false
  if (NOISE_HOSTS.test(u)) return false
  if (/^\{[^}]+\}$/.test(u)) return false
  if (kind === 'string' || kind === 'url-key') return API_HINT.test(u)
  // fetch/client 호출은 경로 형태만 확인
  return /^(https?:)?\/\/|^\/|^\{[^}]+\}\/|^\.{0,2}\/?[\w-]+\//.test(u)
}

function contextParams(ctx, method) {
  const params = []
  const add = (name, where) => {
    if (!name || name.length > 40 || /^(method|headers|body|params|data|url|then|catch|signal|credentials|mode|cache|timeout|responseType|withCredentials|Content-Type|Accept|Authorization)$/i.test(name)) return
    if (!params.some((p) => p.name === name && p.in === where)) params.push({ name, in: where, type: 'string', observed: [] })
  }
  const keysOf = (inner) => {
    const out = []
    const re = /(?:^|[,{])\s*['"]?([A-Za-z_$][\w$-]*)['"]?\s*(?=[:,}]|$)/g
    let m
    while ((m = re.exec(inner))) out.push(m[1])
    return out
  }
  let m
  const pRe = /\bparams\s*:\s*\{([^{}]{0,400})\}/g
  while ((m = pRe.exec(ctx))) keysOf(m[1]).forEach((k) => add(k, 'query'))
  const usp = /new\s+URLSearchParams\s*\(\s*\{([^{}]{0,400})\}/g
  while ((m = usp.exec(ctx))) keysOf(m[1]).forEach((k) => add(k, 'query'))
  const app = /\.(?:append|set)\s*\(\s*['"]([\w.[\]-]{1,40})['"]\s*,/g
  while ((m = app.exec(ctx))) add(m[1], 'query')
  const body = /\b(?:body\s*:\s*JSON\.stringify\s*\(|data\s*:\s*)\{([^{}]{0,500})\}/g
  while ((m = body.exec(ctx))) keysOf(m[1]).forEach((k) => add(k, 'body'))
  // axios.post('/url', { a, b }) 처럼 두 번째 인자로 넘기는 본문
  if (/^(POST|PUT|PATCH)$/.test(method || '')) {
    const second = ctx.match(/['"`]\s*,\s*\{([^{}]{0,500})\}/)
    if (second && !/^\s*(params|headers)\s*:/.test(second[1])) keysOf(second[1]).forEach((k) => add(k, 'body'))
  }
  return params
}

/** 호출식 fetch(...) 또는 url 이 들어있는 객체 {...} 범위만 잘라 문맥으로 사용 (다음 문장으로 번지지 않게) */
function callContext(text, start, matchEnd, kind) {
  let open = -1
  if (kind === 'url-key') {
    // 바로 앞의 여는 중괄호부터 객체 끝까지
    let depth = 0
    for (let i = start; i > Math.max(0, start - 400); i--) {
      const c = text[i]
      if (c === '}') depth++
      else if (c === '{') {
        if (depth === 0) {
          open = i
          break
        }
        depth--
      }
    }
  } else {
    open = text.indexOf('(', start)
    if (open < 0 || open > matchEnd) open = -1
  }
  if (open < 0) return text.slice(start, Math.min(text.length, matchEnd + 200))
  const pairs = { '(': ')', '{': '}', '[': ']' }
  const stack = []
  let quote = null
  const limit = Math.min(text.length, open + 1500)
  for (let i = open; i < limit; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (pairs[c]) stack.push(pairs[c])
    else if (c === ')' || c === '}' || c === ']') {
      stack.pop()
      if (!stack.length) return text.slice(start, i + 1)
    }
  }
  return text.slice(start, limit)
}

function contextMethod(ctx) {
  const m = ctx.match(/\bmethod\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD)['"]/i) || ctx.match(/\btype\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i)
  return m ? m[1].toUpperCase() : null
}

function resolveUrl(u, baseUrl) {
  if (/^\{[^}]+\}/.test(u)) {
    // ${API_BASE}/users → 기본 오리진 기준으로 해석
    u = u.replace(/^\{[^}]+\}/, '')
    if (!u.startsWith('/')) u = '/' + u
  }
  if (u.startsWith('//')) u = 'https:' + u
  try {
    const abs = new URL(u, baseUrl)
    // URL 클래스가 {} 를 인코딩하므로 되돌린다
    return decodeURI(abs.origin + abs.pathname).replace(/%7B/gi, '{').replace(/%7D/gi, '}') + (abs.search ? decodeURIComponent(abs.search).replace(/%7B/gi, '{').replace(/%7D/gi, '}') : '')
  } catch {
    return null
  }
}

/**
 * @param {string} code JS 또는 HTML 소스
 * @param {string} baseUrl 상대 경로를 해석할 기준 URL (보통 페이지 URL)
 * @param {string} sourceName 근거 표시용 파일명
 */
export function scanCode(code, baseUrl, sourceName = 'script') {
  const found = []
  if (!code) return found
  const text = code.length > 6_000_000 ? code.slice(0, 6_000_000) : code
  const seenPos = new Set()
  for (const { kind, conf, re } of PATTERNS) {
    re.lastIndex = 0
    let m
    let count = 0
    while ((m = re.exec(text)) && count < 800) {
      const raw = m.groups.u
      const pos = m.index + m[0].indexOf(raw)
      if (seenPos.has(pos)) continue
      seenPos.add(pos)
      const tpl = cleanTemplate(raw)
      if (!looksLikeApi(tpl, kind)) continue
      count++
      const abs = resolveUrl(tpl, baseUrl)
      if (!abs) continue
      const [path, query = ''] = abs.split('?')
      const ctx = callContext(text, m.index, m.index + m[0].length, kind)
      let method = (m.groups.m || '').toUpperCase()
      if (method === 'GETJSON') method = 'GET'
      method = method || contextMethod(ctx) || 'GET'
      const params = contextParams(kind === 'string' ? '' : ctx, method)
      if (query) {
        for (const pair of query.split('&')) {
          if (!pair) continue
          const [k, v = ''] = pair.split('=')
          if (!k || /^\{/.test(k)) continue
          const isTpl = /^\{.*\}$/.test(v)
          params.push({ name: k, in: 'query', type: isTpl ? 'string' : guessType(v), example: isTpl ? undefined : v, observed: isTpl || !v ? [] : [v] })
        }
      }
      const snippet = text
        .slice(Math.max(0, m.index - 60), Math.min(text.length, m.index + m[0].length + 100))
        .replace(/\s+/g, ' ')
        .trim()
      found.push(
        newEndpoint({
          method,
          url: path,
          sources: ['js'],
          confidence: conf,
          params,
          bodyType: params.some((p) => p.in === 'body') ? 'json' : null,
          evidence: [`[${sourceName}] …${snippet}…`],
        }),
      )
    }
  }
  return mergeEndpoints([], found)
}

/** HTML 문서에서 <form> 을 엔드포인트로 변환 */
export function scanForms(doc, baseUrl) {
  const out = []
  doc.querySelectorAll('form').forEach((f, idx) => {
    const action = f.getAttribute('action')
    let url
    try {
      url = new URL(action || baseUrl, baseUrl)
    } catch {
      return
    }
    if (!/^https?:/.test(url.protocol)) return
    const method = (f.getAttribute('method') || 'GET').toUpperCase()
    const params = []
    f.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
      const name = el.getAttribute('name')
      const type = el.getAttribute('type') || el.tagName.toLowerCase()
      if (['submit', 'button', 'image', 'reset'].includes(type)) return
      const p = {
        name,
        in: method === 'GET' ? 'query' : 'body',
        type: type === 'number' || type === 'range' ? 'integer' : type === 'checkbox' ? 'boolean' : 'string',
        required: el.hasAttribute('required'),
        example: el.getAttribute('value') || el.getAttribute('placeholder') || undefined,
        description: [el.getAttribute('placeholder'), type === 'hidden' ? 'hidden 필드' : '', el.getAttribute('aria-label')].filter(Boolean).join(' · '),
        observed: [],
      }
      if (el.tagName === 'SELECT') {
        p.enum = [...el.querySelectorAll('option')].map((o) => o.getAttribute('value') ?? o.textContent.trim()).filter((x) => x !== '')
      }
      if (!params.some((x) => x.name === name)) params.push(p)
    })
    if (!params.length) return
    out.push(
      newEndpoint({
        method,
        url: url.origin + url.pathname,
        sources: ['form'],
        confidence: 'high',
        summary: `HTML 폼 #${idx + 1}${f.id ? ` (${f.id})` : ''}`,
        params,
        bodyType: method === 'GET' ? null : 'form',
        evidence: [f.outerHTML.replace(/\s+/g, ' ').slice(0, 300)],
      }),
    )
  })
  return out
}

/** JS 번들 안에서 추가로 불러오는 청크 파일 경로를 찾는다 */
export function findChunkUrls(code, baseUrl) {
  const out = new Set()
  const re = /["'`]((?:\.{0,2}\/|\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:m?js))["'`]/g
  let m
  let n = 0
  while ((m = re.exec(code)) && n < 200) {
    n++
    const p = m[1]
    if (NOISE_HOSTS.test(p) || /node_modules|polyfill|\.min\.js$/.test(p)) continue
    try {
      out.add(new URL(p, baseUrl).href)
    } catch {
      /* ignore */
    }
  }
  return [...out]
}
