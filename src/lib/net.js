// 브라우저에서 대상 URL을 호출한다. CORS로 막히면 설정된 프록시로 재시도한다.
import { safeJson } from './schema.js'

export const PUBLIC_PROXIES = [
  'https://api.codetabs.com/v1/proxy/?quest={url}',
  'https://api.allorigins.win/raw?url={url}',
]

export const DEFAULT_SETTINGS = {
  mode: 'auto', // auto | direct | proxy
  customProxy: '', // 예: https://my-worker.workers.dev/?url={url}
  usePublicProxies: true,
  timeoutMs: 20000,
  scanExternalScripts: true,
  probeSpecs: true,
}

// 응답하지 않는 프록시는 잠시 건너뛴다 (분석 중 수십 번 같은 타임아웃을 기다리지 않도록)
const deadUntil = new Map()
const DEAD_MS = 3 * 60 * 1000
const PUBLIC_TIMEOUT_MS = 8000

export function proxyList(settings) {
  const list = []
  if (settings.customProxy?.trim()) list.push(settings.customProxy.trim())
  if (settings.usePublicProxies) list.push(...PUBLIC_PROXIES)
  return list
}

export function applyProxy(template, target) {
  if (template.includes('{url}')) return template.replace('{url}', encodeURIComponent(target))
  if (template.includes('{rawurl}')) return template.replace('{rawurl}', target)
  return template + target
}

function headersToObject(h) {
  const o = {}
  try {
    h.forEach((v, k) => (o[k] = v))
  } catch {
    /* ignore */
  }
  return o
}

async function doFetch(url, { method, headers, body, timeoutMs }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const init = { method, headers, signal: ctrl.signal, redirect: 'follow' }
    if (body != null && !['GET', 'HEAD'].includes(method)) init.body = body
    return await fetch(url, init)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @returns {Promise<{ok:boolean,status:number,statusText:string,headers:object,text:string,json:any,
 *   time:number,size:number,via:string,finalUrl:string,error?:string,attempts:string[]}>}
 */
export async function request({ url, method = 'GET', headers = {}, body = null }, settings = DEFAULT_SETTINGS) {
  method = method.toUpperCase()
  const routes = []
  if (settings.mode !== 'proxy') routes.push({ via: 'direct', url })
  if (settings.mode !== 'direct') {
    for (const p of proxyList(settings)) {
      if ((deadUntil.get(p) || 0) > Date.now()) continue
      routes.push({ via: p, url: applyProxy(p, url) })
    }
  }
  if (!routes.length) routes.push({ via: 'direct', url })

  const attempts = []
  let lastError = ''
  for (const r of routes) {
    const t0 = performance.now()
    try {
      const isPublic = PUBLIC_PROXIES.includes(r.via)
      const timeoutMs = isPublic ? Math.min(PUBLIC_TIMEOUT_MS, settings.timeoutMs || 20000) : settings.timeoutMs || 20000
      const res = await doFetch(r.url, { method, headers, body, timeoutMs })
      const text = await res.text()
      const time = Math.round(performance.now() - t0)
      // 공개 프록시가 자체 오류 페이지를 돌려주는 경우 다음 경로로 넘어간다
      if (r.via !== 'direct' && [403, 429, 500, 502, 503, 520, 521, 522].includes(res.status) && isProxyError(text)) {
        attempts.push(`${shortVia(r.via)}: 프록시 오류 ${res.status}`)
        if (res.status === 429 || res.status === 403) deadUntil.set(r.via, Date.now() + DEAD_MS)
        lastError = `프록시 오류 ${res.status}`
        continue
      }
      attempts.push(`${shortVia(r.via)}: ${res.status}`)
      const resHeaders = headersToObject(res.headers)
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers: resHeaders,
        text,
        json: safeJson(text),
        contentType: resHeaders['content-type'] || '',
        time,
        size: new Blob([text]).size,
        via: r.via,
        finalUrl: res.url && r.via === 'direct' ? res.url : url,
        attempts,
      }
    } catch (e) {
      const msg = e.name === 'AbortError' ? '시간 초과' : 'CORS 차단 또는 네트워크 오류'
      attempts.push(`${shortVia(r.via)}: ${msg}`)
      lastError = msg
      if (r.via !== 'direct') deadUntil.set(r.via, Date.now() + DEAD_MS)
    }
  }
  return {
    ok: false,
    status: 0,
    statusText: '',
    headers: {},
    text: '',
    json: undefined,
    contentType: '',
    time: 0,
    size: 0,
    via: '',
    finalUrl: url,
    error: lastError || '요청 실패',
    attempts,
  }
}

function isProxyError(text) {
  const t = (text || '').slice(0, 600).toLowerCase()
  return /rate limit|too many requests|proxy|cloudflare|error while processing|forbidden|keyless|cors/.test(t)
}

export function shortVia(via) {
  if (!via || via === 'direct') return '직접'
  try {
    return new URL(via.replace('{url}', '').replace('{rawurl}', '')).host
  } catch {
    return via.slice(0, 30)
  }
}

/** 동시 실행 개수를 제한한 map */
export async function pMap(items, fn, concurrency = 4) {
  const out = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      try {
        out[idx] = await fn(items[idx], idx)
      } catch (e) {
        out[idx] = { error: e }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return out
}
