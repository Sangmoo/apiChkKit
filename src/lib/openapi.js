// OpenAPI 3.x / Swagger 2.0 스펙 → 엔드포인트, 그리고 엔드포인트 → OpenAPI 3 내보내기
import yaml from 'js-yaml'
import { newEndpoint } from './endpoint.js'

export function parseSpecText(text) {
  const t = text.trim()
  const doc = t.startsWith('{') ? JSON.parse(t) : yaml.load(t)
  if (!doc || !(doc.openapi || doc.swagger)) throw new Error('OpenAPI/Swagger 문서가 아닙니다')
  return doc
}

function makeResolver(doc) {
  const cache = new Map()
  const get = (ref) => {
    if (!ref.startsWith('#/')) return {}
    if (cache.has(ref)) return cache.get(ref)
    const val = ref
      .slice(2)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((o, k) => (o ? o[k] : undefined), doc)
    cache.set(ref, val || {})
    return val || {}
  }
  const deref = (x) => {
    let n = 0
    while (x && x.$ref && n++ < 20) x = get(x.$ref)
    return x || {}
  }
  return { get, deref }
}

/** OpenAPI 스키마를 내부 스키마 포맷으로 변환($ref, allOf 처리) */
function toSchema(s, r, depth = 0, seen = new Set()) {
  if (!s) return undefined
  if (s.$ref) {
    if (seen.has(s.$ref) || depth > 10) return { type: 'object', description: `(순환 참조 ${s.$ref.split('/').pop()})` }
    const ns = new Set(seen)
    ns.add(s.$ref)
    const out = toSchema(r.deref(s), r, depth + 1, ns)
    return out && { ...out, refName: s.$ref.split('/').pop() }
  }
  if (s.allOf) {
    const parts = s.allOf.map((x) => toSchema(x, r, depth + 1, seen)).filter(Boolean)
    const merged = { type: 'object', properties: {}, required: [] }
    for (const p of parts) {
      Object.assign(merged.properties, p.properties || {})
      merged.required.push(...(p.required || []))
      if (p.description && !merged.description) merged.description = p.description
    }
    return merged
  }
  const alt = s.oneOf || s.anyOf
  if (alt?.length) {
    const first = toSchema(alt[0], r, depth + 1, seen) || {}
    return { ...first, description: [s.description, `${s.oneOf ? 'oneOf' : 'anyOf'} ${alt.length}개 중 첫 번째`].filter(Boolean).join(' · ') }
  }
  let type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type
  const nullable = s.nullable || (Array.isArray(s.type) && s.type.includes('null'))
  if (!type) type = s.properties ? 'object' : s.items ? 'array' : 'any'
  const out = { type, nullable, description: s.description, format: s.format }
  if (s.enum) out.enum = s.enum
  const ex = s.example ?? (Array.isArray(s.examples) ? s.examples[0] : undefined) ?? s.default
  if (ex !== undefined && typeof ex !== 'object') out.examples = [ex]
  if (type === 'object' && s.properties) {
    out.properties = {}
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = toSchema(v, r, depth + 1, seen) || { type: 'any' }
    out.required = s.required || []
  }
  if (type === 'array') out.items = toSchema(s.items, r, depth + 1, seen) || {}
  return out
}

function sampleFromSchema(s, depth = 0) {
  if (!s || depth > 6) return null
  if (s.examples?.length) return s.examples[0]
  if (s.enum?.length) return s.enum[0]
  switch (s.type) {
    case 'object': {
      const o = {}
      for (const [k, v] of Object.entries(s.properties || {})) o[k] = sampleFromSchema(v, depth + 1)
      return o
    }
    case 'array':
      return [sampleFromSchema(s.items, depth + 1)]
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'string':
      return s.format === 'date-time' ? new Date().toISOString() : s.format === 'date' ? new Date().toISOString().slice(0, 10) : 'string'
    default:
      return null
  }
}

export function specToEndpoints(doc, specUrl) {
  const r = makeResolver(doc)
  let base = ''
  if (doc.openapi) {
    const srv = doc.servers?.[0]
    let u = srv?.url || '/'
    for (const [k, v] of Object.entries(srv?.variables || {})) u = u.replace(`{${k}}`, v.default ?? '')
    try {
      base = new URL(u, specUrl || 'http://localhost/').href.replace(/\/$/, '')
    } catch {
      base = u.replace(/\/$/, '')
    }
  } else {
    const scheme = doc.schemes?.includes('https') ? 'https' : doc.schemes?.[0] || (specUrl ? new URL(specUrl).protocol.replace(':', '') : 'https')
    const host = doc.host || (specUrl ? new URL(specUrl).host : 'localhost')
    base = `${scheme}://${host}${(doc.basePath || '').replace(/\/$/, '')}`
  }
  const eps = []
  const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
  for (const [path, item0] of Object.entries(doc.paths || {})) {
    const item = r.deref(item0)
    const common = item.parameters || []
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      const params = []
      let bodyType = null
      let bodyExample = null
      const allParams = [...common, ...(op.parameters || [])].map((p) => r.deref(p))
      for (const p of allParams) {
        if (p.in === 'body') {
          // Swagger 2 body
          const sc = toSchema(p.schema, r)
          bodyType = 'json'
          bodyExample = JSON.stringify(sampleFromSchema(sc), null, 2)
          addBodyProps(params, sc)
          continue
        }
        const sc = p.schema ? toSchema(p.schema, r) : { type: p.type, enum: p.enum, format: p.format, examples: p.default !== undefined ? [p.default] : undefined }
        const idx = params.findIndex((x) => x.name === p.name && x.in === (p.in === 'formData' ? 'body' : p.in))
        const entry = {
          name: p.name,
          in: p.in === 'formData' ? 'body' : p.in,
          type: sc?.type === 'array' ? `array<${sc.items?.type || 'any'}>` : sc?.type || 'string',
          required: !!p.required || p.in === 'path',
          description: p.description || sc?.description,
          example: p.example ?? sc?.examples?.[0] ?? (p.examples ? Object.values(p.examples)[0]?.value : undefined),
          enum: sc?.enum || sc?.items?.enum,
          format: sc?.format,
          observed: [],
        }
        if (p.in === 'formData') bodyType = 'form'
        if (idx >= 0) params[idx] = entry
        else params.push(entry)
      }
      if (op.requestBody) {
        const rb = r.deref(op.requestBody)
        const content = rb.content || {}
        const ct = Object.keys(content).find((c) => /json/.test(c)) || Object.keys(content)[0]
        if (ct) {
          const sc = toSchema(content[ct].schema, r)
          bodyType = /json/.test(ct) ? 'json' : /form/.test(ct) ? 'form' : 'raw'
          const ex = content[ct].example ?? (content[ct].examples ? Object.values(content[ct].examples)[0]?.value : undefined)
          const sample = ex ?? sampleFromSchema(sc)
          bodyExample = bodyType === 'form' && sample && typeof sample === 'object' ? new URLSearchParams(Object.entries(sample).map(([k, v]) => [k, String(v ?? '')])).toString() : JSON.stringify(sample, null, 2)
          addBodyProps(params, sc, rb.required)
        }
      }
      const responses = {}
      for (const [st, resp0] of Object.entries(op.responses || {})) {
        const resp = r.deref(resp0)
        let schema
        if (resp.content) {
          const ct = Object.keys(resp.content).find((c) => /json/.test(c)) || Object.keys(resp.content)[0]
          schema = ct ? toSchema(resp.content[ct].schema, r) : undefined
        } else if (resp.schema) schema = toSchema(resp.schema, r)
        responses[st] = { description: resp.description || '', schema }
      }
      eps.push(
        newEndpoint({
          method,
          url: base + path,
          sources: ['openapi'],
          confidence: 'high',
          summary: op.summary || op.operationId || '',
          description: op.description || '',
          tags: op.tags || [],
          params,
          bodyType,
          bodyExample,
          responses,
          deprecated: !!op.deprecated,
          security: op.security || doc.security,
        }),
      )
    }
  }
  return {
    endpoints: eps,
    info: { title: doc.info?.title, version: doc.info?.version, description: doc.info?.description, base, securitySchemes: doc.components?.securitySchemes || doc.securityDefinitions },
  }
}

function addBodyProps(params, sc, required) {
  if (sc?.type === 'object' && sc.properties) {
    const req = new Set(sc.required || [])
    for (const [k, v] of Object.entries(sc.properties)) {
      params.push({
        name: k,
        in: 'body',
        type: v.type === 'array' ? `array<${v.items?.type || 'any'}>` : v.type || 'any',
        required: req.has(k),
        description: v.description,
        example: v.examples?.[0],
        enum: v.enum,
        format: v.format,
        observed: [],
      })
    }
  } else if (sc) {
    params.push({ name: '(body)', in: 'body', type: sc.type || 'any', required: !!required, description: sc.description, observed: [] })
  }
}

// ---------------- 내보내기 ----------------
function toOasSchema(s) {
  if (!s) return {}
  const out = {}
  if (s.type && s.type !== 'any' && s.type !== 'null') out.type = s.type
  if (s.nullable) out.nullable = true
  if (s.format) out.format = s.format
  if (s.description) out.description = s.description
  if (s.enum) out.enum = s.enum
  if (s.examples?.length) out.example = s.examples[0]
  if (s.type === 'object' && s.properties) {
    out.properties = {}
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = toOasSchema(v)
    if (s.required?.length) out.required = s.required
  }
  if (s.type === 'array') out.items = toOasSchema(s.items)
  return out
}

function baseType(t) {
  const b = String(t || 'string').split(/[\s|<]/)[0]
  return ['string', 'integer', 'number', 'boolean', 'array', 'object'].includes(b) ? b : 'string'
}

export function endpointsToOpenApi(endpoints, title = 'API Check Kit export') {
  const doc = { openapi: '3.0.3', info: { title, version: '1.0.0', description: 'API Check Kit 로 분석/관측한 결과를 기반으로 생성한 스펙입니다.' }, servers: [], paths: {} }
  const parsed = []
  for (const ep of endpoints) {
    try {
      const u = new URL(ep.url.replace(/\{/g, '%7B').replace(/\}/g, '%7D'))
      parsed.push({ ep, origin: u.origin, path: decodeURIComponent(u.pathname) })
    } catch {
      /* 잘못된 URL은 건너뜀 */
    }
  }
  const origins = new Set(parsed.map((x) => x.origin))
  const multi = origins.size > 1
  for (const { ep, origin, path } of parsed) {
    const key = multi ? `${origin}${path}` : path
    doc.paths[key] ||= {}
    const op = {
      summary: ep.summary || undefined,
      description: [ep.description, `출처: ${ep.sources.join(', ')} (신뢰도 ${ep.confidence})`].filter(Boolean).join('\n\n'),
      tags: ep.tags?.length ? ep.tags : undefined,
      parameters: ep.params
        .filter((p) => ['query', 'path', 'header', 'cookie'].includes(p.in))
        .map((p) => ({
          name: p.name,
          in: p.in,
          required: p.in === 'path' ? true : !!p.required,
          description: p.description || undefined,
          schema: { type: baseType(p.type), ...(p.enum ? { enum: p.enum } : {}) },
          example: p.example ?? p.observed?.[0],
        })),
      responses: {},
    }
    const bodyParams = ep.params.filter((p) => p.in === 'body')
    if (bodyParams.length || ep.bodyExample) {
      const ct = ep.bodyType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json'
      op.requestBody = {
        content: {
          [ct]: {
            schema: {
              type: 'object',
              properties: Object.fromEntries(bodyParams.map((p) => [p.name, { type: baseType(p.type), description: p.description || undefined }])),
              required: bodyParams.filter((p) => p.required).map((p) => p.name),
            },
          },
        },
      }
      if (!op.requestBody.content[ct].schema.required.length) delete op.requestBody.content[ct].schema.required
    }
    const statuses = Object.entries(ep.responses)
    if (!statuses.length) op.responses.default = { description: '관측된 응답 없음' }
    for (const [st, r] of statuses) {
      op.responses[st] = { description: r.description || `HTTP ${st}` }
      if (r.schema) op.responses[st].content = { 'application/json': { schema: toOasSchema(r.schema) } }
    }
    doc.paths[key][ep.method.toLowerCase()] = JSON.parse(JSON.stringify(op))
  }
  doc.servers = multi ? [{ url: '/' }] : [...origins].map((url) => ({ url }))
  return doc
}
