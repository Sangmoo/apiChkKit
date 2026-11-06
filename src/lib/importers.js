// HAR 파일 / 캡처 스크립트 결과 / cURL 명령을 관측값(observation)으로 변환
import { isApiLike } from './endpoint.js'
import { safeJson } from './schema.js'

function decodeHarText(content) {
  if (!content?.text) return ''
  if (content.encoding === 'base64') {
    try {
      const bin = atob(content.text)
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    } catch {
      return ''
    }
  }
  return content.text
}

function headerListToObj(list = []) {
  const o = {}
  for (const h of list) if (h?.name && !h.name.startsWith(':')) o[h.name] = h.value
  return o
}

/** HAR(JSON) → observations. includeAll=false 면 API로 보이는 요청만 */
export function parseHar(text, { includeAll = false } = {}) {
  const har = typeof text === 'string' ? JSON.parse(text) : text
  const entries = har?.log?.entries
  if (!Array.isArray(entries)) throw new Error('HAR 형식이 아닙니다 (log.entries 없음)')
  const obs = []
  let skipped = 0
  for (const e of entries) {
    const req = e.request || {}
    const res = e.response || {}
    const mime = res.content?.mimeType || ''
    const rtype = e._resourceType || e._initiator_type || ''
    if (!includeAll && !(isApiLike(req.url, mime, rtype) || (req.method && req.method !== 'GET' && !/\.(js|css)(\?|$)/.test(req.url)))) {
      skipped++
      continue
    }
    obs.push({
      method: req.method,
      url: req.url,
      reqHeaders: headerListToObj(req.headers),
      reqBody: req.postData?.text || (req.postData?.params ? req.postData.params.map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value || '')}`).join('&') : null),
      reqMime: req.postData?.mimeType || '',
      status: res.status,
      resHeaders: headerListToObj(res.headers),
      resBody: decodeHarText(res.content),
      resMime: mime,
      time: Math.round(e.time || 0),
    })
  }
  return { observations: obs, skipped, total: entries.length }
}

/** 캡처 스크립트 결과(JSON) → observations */
export function parseCapture(text) {
  const data = typeof text === 'string' ? JSON.parse(text) : text
  if (data?.log?.entries) return parseHar(data)
  const list = Array.isArray(data) ? data : data?.entries
  if (!Array.isArray(list)) throw new Error('캡처 결과 형식이 아닙니다 (entries 배열 없음)')
  const obs = list
    .filter((x) => x && x.url)
    .map((x) => ({
      method: x.method || 'GET',
      url: x.url,
      reqHeaders: x.requestHeaders || {},
      reqBody: x.requestBody ?? null,
      status: x.status || 0,
      resHeaders: x.responseHeaders || {},
      resBody: x.responseBody ?? '',
      resMime: x.contentType || '',
      time: x.time || 0,
    }))
    .filter((o) => isApiLike(o.url, o.resMime, 'fetch') || o.method !== 'GET')
  return { observations: obs, skipped: list.length - obs.length, total: list.length, page: data.page }
}

/** 셸 토크나이저: bash 스타일 따옴표, \ 줄바꿈, Windows cmd ^ 줄바꿈 지원 */
export function shellSplit(cmd) {
  let s = cmd.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ').replace(/`\r?\n/g, ' ')
  // Chrome "Copy as cURL (cmd)": ^"…^" 따옴표와 ^ 이스케이프를 bash 형태로 변환
  if (/\^"/.test(s)) s = s.replace(/\^\\\^"/g, '\\"').replace(/\^"/g, '"').replace(/\^(.)/g, '$1')
  const out = []
  let cur = ''
  let has = false
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === "'") {
      const j = s.indexOf("'", i + 1)
      cur += s.slice(i + 1, j < 0 ? s.length : j)
      has = true
      i = j < 0 ? s.length : j + 1
    } else if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting $'...'
      let j = i + 2
      let buf = ''
      while (j < s.length && s[j] !== "'") {
        if (s[j] === '\\' && j + 1 < s.length) {
          const n = s[j + 1]
          buf += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
          j += 2
        } else buf += s[j++]
      }
      cur += buf
      has = true
      i = j + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') {
        if ((s[j] === '\\' || s[j] === '^') && j + 1 < s.length && /["\\$`^]/.test(s[j + 1])) {
          cur += s[j + 1]
          j += 2
        } else cur += s[j++]
      }
      has = true
      i = j + 1
    } else if (/\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
      i++
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[i + 1]
      has = true
      i += 2
    } else if (c === '^' && i + 1 < s.length) {
      cur += s[i + 1]
      has = true
      i += 2
    } else {
      cur += c
      has = true
      i++
    }
  }
  if (has) out.push(cur)
  return out
}

/** 하나 이상의 cURL 명령 → observations (응답 없음) */
export function parseCurl(text) {
  const cmds = text
    .split(/(?:^|\n)\s*(?=curl\s)/)
    .map((x) => x.trim())
    .filter((x) => x.startsWith('curl'))
  const obs = []
  for (const cmd of cmds) {
    const t = shellSplit(cmd)
    let url = ''
    let method = ''
    const headers = {}
    const data = []
    let get = false
    for (let i = 1; i < t.length; i++) {
      const a = t[i]
      const next = () => t[++i]
      if (a === '-X' || a === '--request') method = next()
      else if (a.startsWith('-X') && a.length > 2) method = a.slice(2)
      else if (a === '-H' || a === '--header') {
        const h = next() || ''
        const idx = h.indexOf(':')
        if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim()
      } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json'].includes(a)) {
        const v = next() || ''
        data.push(a === '--data-urlencode' && !v.includes('=') ? encodeURIComponent(v) : v)
        if (a === '--json') {
          headers['Content-Type'] ||= 'application/json'
          headers['Accept'] ||= 'application/json'
        }
      } else if (a === '-G' || a === '--get') get = true
      else if (a === '-b' || a === '--cookie') headers['Cookie'] = next()
      else if (a === '-A' || a === '--user-agent') headers['User-Agent'] = next()
      else if (a === '-e' || a === '--referer') headers['Referer'] = next()
      else if (a === '-u' || a === '--user') headers['Authorization'] = 'Basic ' + btoa(next() || '')
      else if (a === '--url') url = next()
      else if (['-o', '--output', '-w', '--write-out', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '--retry', '-K', '--config', '-F', '--form'].includes(a)) next()
      else if (a.startsWith('-')) continue
      else if (!url) url = a
    }
    if (!url) continue
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url
    let body = data.length ? data.join('&') : null
    if (get && body) {
      url += (url.includes('?') ? '&' : '?') + body
      body = null
    }
    obs.push({
      method: method || (body ? 'POST' : 'GET'),
      url,
      reqHeaders: headers,
      reqBody: body,
      reqMime: headers['Content-Type'] || headers['content-type'] || '',
      status: 0,
    })
  }
  if (!obs.length) throw new Error('cURL 명령을 찾지 못했습니다')
  return { observations: obs, skipped: 0, total: obs.length }
}

/** 붙여넣은 텍스트가 무엇인지 판별 */
export function detectPasteKind(text) {
  const t = text.trim()
  if (/^curl\s/i.test(t)) return 'curl'
  const j = safeJson(t)
  if (j?.log?.entries) return 'har'
  if (j && (j.openapi || j.swagger)) return 'openapi'
  if (j && (Array.isArray(j.entries) || j.apiChkKitCapture)) return 'capture'
  if (/^(openapi|swagger)\s*:/m.test(t)) return 'openapi'
  return null
}
