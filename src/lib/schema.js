// JSON 값으로부터 스키마를 추론하고, 여러 샘플의 스키마를 병합한다.

const MAX_EXAMPLES = 5

export function typeOf(v) {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v // string | boolean | object
}

export function detectFormat(v) {
  if (typeof v !== 'string') return undefined
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return 'date-time'
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return 'uuid'
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) return 'email'
  if (/^https?:\/\//.test(v)) return 'uri'
  return undefined
}

function clipExample(v) {
  if (typeof v === 'string' && v.length > 120) return v.slice(0, 117) + '...'
  return v
}

export function inferSchema(value, depth = 0) {
  const type = typeOf(value)
  if (type === 'object') {
    if (depth > 12) return { type: 'object' }
    const properties = {}
    for (const [k, v] of Object.entries(value)) properties[k] = inferSchema(v, depth + 1)
    return { type: 'object', properties, required: Object.keys(value) }
  }
  if (type === 'array') {
    let items = null
    for (const it of value.slice(0, 50)) {
      const s = inferSchema(it, depth + 1)
      items = items ? mergeSchema(items, s) : s
    }
    return { type: 'array', items: items || {}, lengths: [value.length] }
  }
  if (type === 'null') return { type: 'null', nullable: true }
  const s = { type, examples: [clipExample(value)] }
  const fmt = detectFormat(value)
  if (fmt) s.format = fmt
  return s
}

function mergeExamples(a = [], b = []) {
  const out = [...a]
  for (const x of b) {
    if (out.length >= MAX_EXAMPLES) break
    if (!out.some((y) => y === x)) out.push(x)
  }
  return out
}

export function mergeSchema(a, b) {
  if (!a) return b
  if (!b) return a
  if (a.type === 'null' && b.type !== 'null') return { ...b, nullable: true }
  if (b.type === 'null' && a.type !== 'null') return { ...a, nullable: true }
  let type = a.type
  if (a.type !== b.type) {
    if ([a.type, b.type].every((t) => t === 'integer' || t === 'number')) type = 'number'
    else {
      return {
        ...a,
        altTypes: Array.from(new Set([...(a.altTypes || []), b.type, ...(b.altTypes || [])])).filter((t) => t !== a.type),
        nullable: a.nullable || b.nullable,
      }
    }
  }
  const out = { ...a, type, nullable: a.nullable || b.nullable }
  if (type === 'object') {
    const properties = { ...(a.properties || {}) }
    for (const [k, v] of Object.entries(b.properties || {})) properties[k] = mergeSchema(properties[k], v)
    out.properties = properties
    const reqB = new Set(b.required || [])
    out.required = (a.required || []).filter((k) => reqB.has(k))
  } else if (type === 'array') {
    out.items = mergeSchema(a.items, b.items)
    out.lengths = [...(a.lengths || []), ...(b.lengths || [])].slice(-20)
  } else {
    out.examples = mergeExamples(a.examples, b.examples)
    if (a.enum || b.enum) out.enum = Array.from(new Set([...(a.enum || []), ...(b.enum || [])]))
  }
  return out
}

/** 스키마를 path 단위의 행으로 평탄화: data[].user.name */
export function flattenSchema(schema, prefix = '', rows = [], parentRequired = true, depth = 0) {
  if (!schema || depth > 14) return rows
  if (schema.type === 'object' && schema.properties) {
    const req = new Set(schema.required || [])
    for (const [k, v] of Object.entries(schema.properties)) {
      const path = prefix ? `${prefix}.${k}` : k
      rows.push(rowOf(path, v, parentRequired && req.has(k)))
      flattenSchema(v, path, rows, parentRequired && req.has(k), depth + 1)
    }
  } else if (schema.type === 'array' && schema.items) {
    const path = `${prefix}[]`
    if (schema.items.type && schema.items.type !== 'object') {
      if (prefix === '') rows.push(rowOf(path, schema.items, true))
    }
    flattenSchema(schema.items, path, rows, parentRequired, depth + 1)
  }
  return rows
}

function rowOf(path, s, required) {
  let type = s.type || 'any'
  if (type === 'array' && s.items?.type) type = `array<${s.items.type}>`
  if (s.altTypes?.length) type += ' | ' + s.altTypes.join(' | ')
  if (s.nullable && s.type !== 'null') type += ' | null'
  return {
    path,
    type,
    required,
    format: s.format,
    examples: s.examples || (s.example !== undefined ? [s.example] : []),
    enum: s.enum,
    description: s.description,
    lengths: s.lengths,
  }
}

/** 응답 본문의 요약: 배열이면 길이, 객체면 key 수, 대표 배열 길이 등 */
export function summarizeBody(json, text) {
  if (json === undefined) {
    if (!text) return '(빈 응답)'
    return `텍스트 ${text.length.toLocaleString()}자`
  }
  if (Array.isArray(json)) return `배열 ${json.length}개`
  if (json && typeof json === 'object') {
    const keys = Object.keys(json)
    const parts = [`객체 key ${keys.length}개`]
    const arr = findMainArray(json)
    if (arr) parts.push(`${arr.path} ${arr.length}개`)
    for (const k of ['total', 'totalCount', 'total_count', 'count', 'totalElements', 'totalResults']) {
      if (typeof json[k] === 'number') parts.push(`${k}=${json[k]}`)
    }
    for (const k of ['error', 'message', 'msg', 'code', 'status', 'resultCode', 'resultMsg']) {
      const v = json[k]
      if (v !== undefined && (typeof v !== 'object' || v === null)) parts.push(`${k}=${String(v).slice(0, 40)}`)
    }
    return parts.join(' · ')
  }
  return `${typeOf(json)}: ${String(json).slice(0, 60)}`
}

export function findMainArray(obj, path = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null
  let best = null
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k
    if (Array.isArray(v)) {
      if (!best || v.length > best.length) best = { path: p, length: v.length }
    } else if (v && typeof v === 'object') {
      const inner = findMainArray(v, p, depth + 1)
      if (inner && (!best || inner.length > best.length)) best = inner
    }
  }
  return best
}

/** 스키마 구조를 비교할 수 있는 간단한 시그니처 */
export function schemaSignature(schema) {
  return flattenSchema(schema)
    .map((r) => `${r.path}:${r.type.split(' ')[0]}`)
    .sort()
}

export function diffSignature(base, next) {
  const a = new Set(base)
  const b = new Set(next)
  return {
    added: next.filter((x) => !a.has(x)),
    removed: base.filter((x) => !b.has(x)),
  }
}

export function safeJson(text) {
  if (typeof text !== 'string') return undefined
  const t = text.trim()
  if (!t) return undefined
  if (/^[[{"]|^(true|false|null|-?\d)/.test(t)) {
    try {
      return JSON.parse(t)
    } catch {
      return undefined
    }
  }
  // JSONP: callback({...})
  const m = t.match(/^[\w$.]+\s*\(\s*([[{][\s\S]*[\]}])\s*\)\s*;?$/)
  if (m) {
    try {
      return JSON.parse(m[1])
    } catch {
      return undefined
    }
  }
  return undefined
}
