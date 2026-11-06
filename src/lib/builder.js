// 입력한 조건값으로 실제 요청을 조립하고, 코드 스니펫을 만든다.
import { safeJson } from './schema.js'

function coerce(v, type) {
  if (v === '' || v === undefined) return v
  const t = String(type || '').replace('!', '')
  if (/^(integer|int|Int|number|Float)$/i.test(t) && /^-?\d+(\.\d+)?$/.test(String(v))) return Number(v)
  if (/^(boolean|Boolean)$/i.test(t) && /^(true|false)$/i.test(String(v))) return String(v).toLowerCase() === 'true'
  if (/^(array|object|\[)/.test(t) || /^[[{]/.test(String(v).trim())) {
    const j = safeJson(String(v))
    if (j !== undefined) return j
  }
  return v
}

/**
 * @param ep 엔드포인트
 * @param {Record<string,{value:string, enabled:boolean}>} values  key = `${in}:${name}`
 * @param {{headers:Array<{k:string,v:string}>, bodyText:string, bodyMode:'fields'|'raw'}} extra
 */
export function buildRequest(ep, values, extra = {}) {
  let url = ep.url.split('#')[0]
  const headers = {}
  const query = []
  const bodyFields = {}
  const vars = {}
  for (const p of ep.params) {
    const st = values[`${p.in}:${p.name}`]
    if (!st || !st.enabled) continue
    const v = st.value ?? ''
    if (p.in === 'path') url = url.replace(`{${p.name}}`, encodeURIComponent(v))
    else if (p.in === 'query') query.push([p.name, v])
    else if (p.in === 'header') headers[p.name] = v
    else if (p.in === 'cookie') headers['Cookie'] = [headers['Cookie'], `${p.name}=${v}`].filter(Boolean).join('; ')
    else if (p.in === 'body' && p.name !== '(body)') bodyFields[p.name] = coerce(v, p.type)
    else if (p.in === 'variable') vars[p.name] = coerce(v, p.type)
  }
  for (const c of extra.customParams || []) {
    if (!c.name || !c.enabled) continue
    if (c.in === 'query') query.push([c.name, c.value])
    else if (c.in === 'body') bodyFields[c.name] = coerce(c.value, 'auto')
    else if (c.in === 'header') headers[c.name] = c.value
  }
  for (const h of extra.headers || []) if (h.k && h.enabled !== false) headers[h.k] = h.v
  if (query.length) {
    const [base, existing] = url.split('?')
    const sp = new URLSearchParams(existing || '')
    for (const [k, v] of query) sp.append(k, v)
    url = `${base}?${sp.toString()}`
  }
  let body = null
  const method = ep.method
  if (!['GET', 'HEAD'].includes(method) || ep.bodyType) {
    if (ep.bodyType === 'graphql') {
      const base = safeJson(extra.bodyText || ep.bodyExample || '{}') || {}
      body = JSON.stringify({ ...base, variables: { ...(base.variables || {}), ...vars } })
      setCT(headers, 'application/json')
    } else if (extra.bodyMode === 'raw' && extra.bodyText?.trim()) {
      body = extra.bodyText
      if (safeJson(body) !== undefined) setCT(headers, 'application/json')
    } else if (Object.keys(bodyFields).length) {
      if (ep.bodyType === 'form') {
        body = new URLSearchParams(Object.entries(bodyFields).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString()
        setCT(headers, 'application/x-www-form-urlencoded')
      } else {
        body = JSON.stringify(bodyFields)
        setCT(headers, 'application/json')
      }
    } else if (extra.bodyText?.trim()) {
      body = extra.bodyText
      if (safeJson(body) !== undefined) setCT(headers, 'application/json')
    }
  }
  if (['GET', 'HEAD'].includes(method) && ep.bodyType !== 'graphql') body = null
  return { url, method: ep.bodyType === 'graphql' && method === 'GET' ? 'POST' : method, headers, body }
}

function setCT(headers, v) {
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = v
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

export function toCurl(req) {
  const parts = [`curl -X ${req.method} ${sq(req.url)}`]
  for (const [k, v] of Object.entries(req.headers)) parts.push(`  -H ${sq(`${k}: ${v}`)}`)
  if (req.body) parts.push(`  --data-raw ${sq(req.body)}`)
  return parts.join(' \\\n')
}

export function toFetch(req) {
  const init = { method: req.method }
  if (Object.keys(req.headers).length) init.headers = req.headers
  let s = `const res = await fetch(${JSON.stringify(req.url)}, ${JSON.stringify(init, null, 2)}`
  if (req.body) s = s.replace(/\n}$/, `,\n  "body": ${JSON.stringify(req.body)}\n}`)
  return `${s});\nconst data = await res.json();\nconsole.log(res.status, data);`
}

export function toPython(req) {
  const lines = ['import requests', '']
  lines.push(`res = requests.request(`)
  lines.push(`    ${JSON.stringify(req.method)},`)
  lines.push(`    ${JSON.stringify(req.url)},`)
  if (Object.keys(req.headers).length) lines.push(`    headers=${JSON.stringify(req.headers)},`)
  if (req.body) {
    const j = safeJson(req.body)
    lines.push(j !== undefined ? `    json=${JSON.stringify(j).replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None')},` : `    data=${JSON.stringify(req.body)},`)
  }
  lines.push(')')
  lines.push('print(res.status_code)')
  lines.push('print(res.json())')
  return lines.join('\n')
}

/** 엔드포인트의 기본 입력값 상태 */
export function initialValues(ep) {
  const vals = {}
  for (const p of ep.params) {
    let v = p.example ?? p.observed?.[0] ?? (p.enum?.length ? p.enum[0] : '')
    if (v && typeof v === 'object') v = JSON.stringify(v)
    if (v === null) v = ''
    if (p.cacheBuster) v = Date.now()
    vals[`${p.in}:${p.name}`] = { value: String(v), enabled: p.required || p.in === 'path' || p.in === 'variable' || v !== '' }
  }
  return vals
}

/** 스윕(조건 비교)에서 사용할 값 자동 제안 */
export function suggestValues(p) {
  if (p.enum?.length) return p.enum.map(String)
  const obs = (p.observed || []).map(String).filter((x) => x.length < 200)
  const t = String(p.type || '')
  let extra
  if (/int|number|float/i.test(t)) extra = ['0', '1', '10', '100', '-1', 'abc']
  else if (/bool/i.test(t)) extra = ['true', 'false']
  else extra = ['test', '', '한글', 'a'.repeat(300)]
  return Array.from(new Set([...obs.slice(0, 5), ...extra]))
}
