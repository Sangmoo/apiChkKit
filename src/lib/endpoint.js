// 엔드포인트 공통 모델과 병합 도구
import { inferSchema, mergeSchema, safeJson } from './schema.js'

/**
 * Endpoint = {
 *   id, method, url(템플릿, {path} 포함), sources:[], confidence:'high'|'medium'|'low',
 *   summary, description, tags:[],
 *   params: [{name, in:'query'|'path'|'header'|'body'|'cookie', type, required, example, enum, description, observed:[]}],
 *   bodyType: 'json'|'form'|'graphql'|null, bodyExample: string|null,
 *   responses: { [status]: { description, schema } },
 *   samples: [{ at, request:{url,method,headers,body}, response:{status,body,contentType,time} }],
 *   evidence: [string],
 * }
 */

export const STATIC_EXT = /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|pdf|zip|gz|wasm|txt|md|html?)(?:$|[?#])/i

export const NOISE_HOSTS =
  /(google-analytics|googletagmanager|doubleclick|googlesyndication|google\.com\/recaptcha|gstatic|facebook\.(net|com)|fbcdn|hotjar|segment\.(io|com)|sentry\.io|mixpanel|amplitude|clarity\.ms|newrelic|nr-data|datadoghq|intercom|fonts\.googleapis|w3\.org|schema\.org|reactjs\.org|react\.dev|github\.com|mozilla\.org|npmjs|unpkg|jsdelivr|cdnjs|polyfill\.io|youtube\.com|twitter\.com|x\.com\/|linkedin|kakao\.com\/sdk|daumcdn|wcs\.naver|adsystem|adservice|criteo|taboola|outbrain|bing\.com|yandex|tiktok|pinterest|vimeo|cloudflareinsights|onetrust|cookielaw)/i

let seq = 0
export function makeId() {
  seq += 1
  return `ep_${Date.now().toString(36)}_${seq}`
}

const ID_SEG = [
  [/^\d+$/, 'id'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'uuid'],
  [/^[0-9a-f]{16,}$/i, 'hash'],
  [/^[A-Za-z0-9_-]{24,}$/, 'token'],
  [/^\d{4}-\d{2}-\d{2}$/, 'date'],
]

/** /users/123/posts/9 → /users/{userId}/posts/{postId} 형태로 일반화 */
export function templatizePath(pathname) {
  const segs = pathname.split('/')
  const names = new Set()
  return segs
    .map((s, i) => {
      if (!s || /^\{.+\}$/.test(s)) return s
      for (const [re, kind] of ID_SEG) {
        if (re.test(s) && !(kind === 'token' && /^[a-z]+(-[a-z]+)*$/i.test(s))) {
          const prev = segs[i - 1] || ''
          let name = kind === 'id' && prev && !/^\{/.test(prev) ? singular(prev) + 'Id' : kind
          name = name.replace(/[^\w]/g, '')
          let n = name
          let k = 2
          while (names.has(n)) n = name + k++
          names.add(n)
          return `{${n}}`
        }
      }
      return s
    })
    .join('/')
}

function singular(w) {
  w = w.replace(/[^A-Za-z0-9_]/g, '')
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y'
  if (/ses$/.test(w)) return w.slice(0, -2)
  if (/s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1)
  return w || 'id'
}

export function pathParamsOf(urlTemplate) {
  const out = []
  const re = /\{([^}/]+)\}/g
  let m
  const pathPart = urlTemplate.split('?')[0]
  while ((m = re.exec(pathPart))) out.push(m[1])
  return out
}

export function guessType(v) {
  if (v === null || v === undefined || v === '') return 'string'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return 'object'
  const s = String(v)
  if (/^-?\d+$/.test(s) && s.length < 16) return 'integer'
  if (/^-?\d+\.\d+$/.test(s)) return 'number'
  if (/^(true|false)$/i.test(s)) return 'boolean'
  return 'string'
}

export function newEndpoint(partial) {
  const ep = {
    id: makeId(),
    method: 'GET',
    url: '',
    sources: [],
    confidence: 'medium',
    summary: '',
    description: '',
    tags: [],
    params: [],
    bodyType: null,
    bodyExample: null,
    responses: {},
    samples: [],
    evidence: [],
    ...partial,
  }
  ep.method = (ep.method || 'GET').toUpperCase()
  // URL 경로의 {param}을 path 파라미터로 보장
  for (const name of pathParamsOf(ep.url)) {
    if (!ep.params.some((p) => p.in === 'path' && p.name === name)) {
      ep.params.unshift({ name, in: 'path', type: 'string', required: true, observed: [] })
    }
  }
  return ep
}

export function endpointKey(ep) {
  return `${ep.method} ${normalizeUrlKey(ep.url)}`
}

function normalizeUrlKey(url) {
  const [base] = url.split('?')
  return base.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '')
}

const CONF_RANK = { low: 0, medium: 1, high: 2 }

export function mergeParam(list, p) {
  const ex = list.find((x) => x.name === p.name && x.in === p.in)
  if (!ex) {
    list.push({ observed: [], ...p, observed: [...(p.observed || [])] })
    return
  }
  for (const k of ['type', 'description', 'example', 'enum', 'format', 'schema']) {
    if ((ex[k] === undefined || ex[k] === '' || (k === 'type' && ex.type === 'string')) && p[k] !== undefined) ex[k] = p[k]
  }
  ex.required = ex.required || p.required
  for (const v of p.observed || []) if (!ex.observed.includes(v) && ex.observed.length < 30) ex.observed.push(v)
}

export function mergeEndpoints(existing, incoming) {
  const map = new Map(existing.map((e) => [endpointKey(e), e]))
  const out = [...existing]
  for (const ep of incoming) {
    const key = endpointKey(ep)
    const cur = map.get(key)
    if (!cur) {
      map.set(key, ep)
      out.push(ep)
      continue
    }
    for (const s of ep.sources) if (!cur.sources.includes(s)) cur.sources.push(s)
    if (CONF_RANK[ep.confidence] > CONF_RANK[cur.confidence]) cur.confidence = ep.confidence
    // 더 구체적인(스펙 기반) URL 템플릿 우선
    if (ep.sources.includes('openapi') && !cur.sources.slice(0, -1).includes('openapi')) cur.url = ep.url
    cur.summary ||= ep.summary
    cur.description ||= ep.description
    cur.tags = Array.from(new Set([...cur.tags, ...ep.tags]))
    for (const p of ep.params) mergeParam(cur.params, p)
    cur.bodyType ||= ep.bodyType
    cur.bodyExample ||= ep.bodyExample
    for (const [st, r] of Object.entries(ep.responses)) {
      const c = cur.responses[st]
      cur.responses[st] = c
        ? { description: c.description || r.description, schema: mergeSchema(c.schema, r.schema) }
        : r
    }
    cur.samples = [...cur.samples, ...ep.samples].slice(-30)
    cur.evidence = Array.from(new Set([...cur.evidence, ...ep.evidence])).slice(0, 10)
  }
  return out
}

/** 실제 요청/응답 관측값(HAR, 캡처, cURL, 직접 호출)을 엔드포인트로 변환 */
export function observationsToEndpoints(observations, source) {
  const groups = new Map()
  for (const o of observations) {
    let u
    try {
      u = new URL(o.url)
    } catch {
      continue
    }
    const method = (o.method || 'GET').toUpperCase()
    const tpl = u.origin + templatizePath(u.pathname)
    const key = `${method} ${tpl}`
    let ep = groups.get(key)
    if (!ep) {
      ep = newEndpoint({ method, url: tpl, sources: [source], confidence: 'high' })
      groups.set(key, ep)
    }
    // path 파라미터 관측값
    const tplSegs = tpl.slice(u.origin.length).split('/')
    const realSegs = u.pathname.split('/')
    tplSegs.forEach((s, i) => {
      const m = s.match(/^\{(.+)\}$/)
      if (m) mergeParam(ep.params, { name: m[1], in: 'path', type: guessType(realSegs[i]), required: true, example: realSegs[i], observed: [decodeURIComponent(realSegs[i] || '')] })
    })
    // query
    for (const [k, v] of u.searchParams) {
      if (isCacheBuster(k, v)) {
        mergeParam(ep.params, { name: k, in: 'query', type: 'integer', example: v, observed: [], description: '캐시 방지용 타임스탬프 — 결과에 영향 없음 (빼고 호출해도 됨)', cacheBuster: true })
        continue
      }
      mergeParam(ep.params, { name: k, in: 'query', type: guessType(v), example: v, observed: [v] })
    }
    // headers (의미있는 것만)
    for (const [k, v] of Object.entries(o.reqHeaders || {})) {
      const lk = k.toLowerCase()
      if (/^(authorization|x-[\w-]+|api[-_]?key|apikey|content-type|accept)$/.test(lk) && !/^x-(requested-with|forwarded|real-ip|client-data)/.test(lk)) {
        const shown = /authorization|key|token|secret/.test(lk) ? maskSecret(v) : v
        mergeParam(ep.params, { name: lk, in: 'header', type: 'string', example: shown, observed: [shown] })
      }
    }
    // body
    if (o.reqBody) {
      const ct = Object.entries(o.reqHeaders || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || o.reqMime || ''
      const json = safeJson(o.reqBody)
      if (json && typeof json === 'object') {
        if (json.query && typeof json.query === 'string' && /graphql/i.test(u.pathname + ct + o.reqBody.slice(0, 50))) ep.bodyType = 'graphql'
        else ep.bodyType ||= 'json'
        ep.bodyExample ||= JSON.stringify(json, null, 2)
        // 객체 본문은 key 별로, 객체 배열 본문은 첫 원소의 key 를 "[].key" 로 표시
        const fields = Array.isArray(json) ? (json[0] && typeof json[0] === 'object' && !Array.isArray(json[0]) ? Object.entries(json[0]).map(([k, v]) => [`[].${k}`, v]) : []) : Object.entries(json)
        for (const [k, v] of fields) {
          mergeParam(ep.params, {
            name: k,
            in: 'body',
            type: guessType(v),
            example: v,
            observed: [typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 200) : v],
            ...(Array.isArray(json) ? { description: `배열 본문 각 원소의 필드 (관측 시 ${json.length}개 원소)` } : {}),
          })
        }
      } else if (/x-www-form-urlencoded/.test(ct) || /^[\w.%[\]-]+=[^&]*(&[\w.%[\]-]+=[^&]*)*$/.test(o.reqBody.trim())) {
        ep.bodyType ||= 'form'
        ep.bodyExample ||= o.reqBody
        for (const [k, v] of new URLSearchParams(o.reqBody)) mergeParam(ep.params, { name: k, in: 'body', type: guessType(v), example: v, observed: [v] })
      } else {
        ep.bodyType ||= 'raw'
        ep.bodyExample ||= o.reqBody.slice(0, 5000)
      }
    }
    // response
    if (o.status) {
      const st = String(o.status)
      const json = safeJson(o.resBody)
      const schema = json !== undefined ? inferSchema(json) : undefined
      const cur = ep.responses[st]
      ep.responses[st] = { description: cur?.description || '', schema: schema ? mergeSchema(cur?.schema, schema) : cur?.schema }
    }
    ep.samples.push({
      at: Date.now(),
      request: { url: o.url, method, headers: o.reqHeaders || {}, body: o.reqBody || null },
      response: o.status
        ? { status: o.status, body: (o.resBody || '').slice(0, 200000), contentType: o.resMime || '', time: o.time || 0 }
        : null,
    })
    if (ep.samples.length > 30) ep.samples.shift()
  }
  // 모든 샘플에 등장한 query는 필수로 표시
  for (const ep of groups.values()) {
    const n = ep.samples.length
    if (n > 1) {
      for (const p of ep.params) {
        if (p.in !== 'query' || p.cacheBuster) continue
        const cnt = ep.samples.filter((s) => {
          try {
            return new URL(s.request.url).searchParams.has(p.name)
          } catch {
            return false
          }
        }).length
        p.required = cnt === n
        p.note = `${cnt}/${n}회 사용`
      }
    }
  }
  return [...groups.values()]
}

/** _=1793947543678 처럼 캐시를 피하려고 붙이는 타임스탬프 파라미터 */
export function isCacheBuster(name, value) {
  return /^(_|t|ts|_t|timestamp|cb|cachebust(er)?|nocache|rnd|rand)$/i.test(name) && /^\d{10,13}(\.\d+)?$/.test(String(value))
}

export function maskSecret(v) {
  const s = String(v)
  if (s.length <= 10) return '****'
  return s.slice(0, 6) + '…' + s.slice(-4)
}

export function isApiLike(url, contentType = '', resourceType = '') {
  if (/^(data|blob|chrome-extension|about):/.test(url)) return false
  if (NOISE_HOSTS.test(url)) return false
  if (/^(xhr|fetch)$/i.test(resourceType)) return true
  if (/json|xml|graphql|text\/plain|javascript.*jsonp/i.test(contentType) && !/\.js(\?|$)/.test(url)) return true
  if (STATIC_EXT.test(url)) return false
  return /\/(api|graphql|rest|rpc|v\d+|ajax|json|service|services|query|search)(\/|\?|$|\.)/i.test(url)
}
