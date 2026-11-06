// URL 분석 파이프라인: 응답 종류 판별 → 스펙 탐색 → HTML/JS 정적 분석
import { request, pMap } from './net.js'
import { newEndpoint, mergeEndpoints, observationsToEndpoints, NOISE_HOSTS } from './endpoint.js'
import { parseSpecText, specToEndpoints } from './openapi.js'
import { scanCode, scanForms, findChunkUrls } from './jsScanner.js'

export const SPEC_PATHS = [
  '/openapi.json',
  '/openapi.yaml',
  '/swagger.json',
  '/swagger/v1/swagger.json',
  '/v3/api-docs',
  '/v2/api-docs',
  '/api-docs',
  '/api/openapi.json',
  '/api/swagger.json',
  '/api/v1/openapi.json',
  '/docs/openapi.json',
  '/api-docs.json',
  '/.well-known/openapi.json',
]

const MAX_SCRIPTS = 25
const MAX_SCRIPT_BYTES = 4_000_000

/**
 * @param {string} inputUrl
 * @param {object} settings 네트워크 설정
 * @param {(msg:string, level?:'info'|'ok'|'warn'|'error')=>void} log
 */
export async function analyzeUrl(inputUrl, settings, log = () => {}) {
  let url = inputUrl.trim()
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  const result = { endpoints: [], page: null, specs: [], scripts: [] }
  const add = (eps) => (result.endpoints = mergeEndpoints(result.endpoints, eps))

  log(`요청: ${url}`)
  const res = await request({ url }, settings)
  if (res.status === 0) {
    log(`페이지를 가져오지 못했습니다 (${res.attempts.join(' / ')})`, 'error')
    log('CORS 프록시 설정을 확인하거나, HAR 업로드 / 캡처 스크립트 방식을 사용하세요.', 'warn')
    return result
  }
  log(`응답 ${res.status} · ${res.contentType || '타입 미상'} · ${res.size.toLocaleString()} bytes · 경로: ${res.via === 'direct' ? '직접' : '프록시'}`, 'ok')
  const finalUrl = res.finalUrl || url
  result.page = { url: finalUrl, status: res.status, contentType: res.contentType, via: res.via }

  // 1) 스펙 문서 자체인 경우
  if (res.json && (res.json.openapi || res.json.swagger)) {
    const { endpoints, info } = specToEndpoints(res.json, finalUrl)
    log(`OpenAPI 스펙 감지: ${info.title || ''} ${info.version || ''} → ${endpoints.length}개 엔드포인트`, 'ok')
    result.specs.push({ url: finalUrl, ...info })
    add(endpoints)
    return result
  }
  if (!res.json && /^(openapi|swagger)\s*:/m.test(res.text.slice(0, 2000))) {
    try {
      const { endpoints, info } = specToEndpoints(parseSpecText(res.text), finalUrl)
      log(`OpenAPI(YAML) 스펙 감지 → ${endpoints.length}개 엔드포인트`, 'ok')
      result.specs.push({ url: finalUrl, ...info })
      add(endpoints)
      return result
    } catch (e) {
      log(`YAML 파싱 실패: ${e.message}`, 'warn')
    }
  }

  // 2) WordPress REST 인덱스
  if (res.json && res.json.routes && res.json.namespaces) {
    const eps = wordpressToEndpoints(res.json, finalUrl)
    log(`WordPress REST API 인덱스 감지 → ${eps.length}개 엔드포인트`, 'ok')
    add(eps)
    return result
  }

  // 3) JSON/XML 등 API 응답 자체
  const isHtml = /html/i.test(res.contentType) || /^\s*<(!doctype html|html|head|body)/i.test(res.text.slice(0, 500))
  if (/graphql|gql/i.test(new URL(finalUrl).pathname)) {
    log('GraphQL 엔드포인트로 보입니다. introspection 으로 스키마를 조회합니다…')
    try {
      const eps = await graphqlIntrospect(finalUrl.split('?')[0], settings)
      log(`GraphQL query/mutation ${eps.length}개 발견`, 'ok')
      add(eps)
      return result
    } catch (e) {
      log(`introspection 실패: ${e.message}`, 'warn')
    }
  }
  if (!isHtml) {
    const eps = observationsToEndpoints(
      [{ method: 'GET', url: finalUrl, status: res.status, resBody: res.text, resMime: res.contentType, time: res.time }],
      'direct',
    )
    log(`입력한 URL 자체가 API 응답입니다 (${res.json !== undefined ? 'JSON' : res.contentType || '본문 없음'}). 쿼리 파라미터와 응답 구조를 분석했습니다.`, 'ok')
    add(eps)
    return result
  }

  // 4) HTML 페이지 분석
  const doc = new DOMParser().parseFromString(res.text, 'text/html')
  const base = doc.querySelector('base[href]')?.getAttribute('href')
  const baseUrl = base ? new URL(base, finalUrl).href : finalUrl
  result.page.title = doc.title
  log(`HTML 페이지: "${doc.title || '(제목 없음)'}"`)

  const forms = scanForms(doc, baseUrl)
  if (forms.length) log(`HTML 폼 ${forms.length}개 발견`, 'ok')
  add(forms)

  // WordPress / Next.js 등 프레임워크 힌트
  const wpLink = doc.querySelector('link[rel="https://api.w.org/"]')?.getAttribute('href')
  if (wpLink) {
    log(`WordPress REST API 링크 발견: ${wpLink}`, 'ok')
    const wp = await request({ url: new URL(wpLink, baseUrl).href }, settings)
    if (wp.json?.routes) {
      const eps = wordpressToEndpoints(wp.json, new URL(wpLink, baseUrl).href)
      log(`WordPress 라우트 ${eps.length}개`, 'ok')
      add(eps)
    }
  }
  const nextData = doc.getElementById('__NEXT_DATA__')?.textContent
  if (nextData) {
    try {
      const nd = JSON.parse(nextData)
      const u = new URL(finalUrl)
      const pagePath = u.pathname === '/' ? '/index' : u.pathname.replace(/\/$/, '')
      if (nd.buildId) {
        add([
          newEndpoint({
            method: 'GET',
            url: `${u.origin}/_next/data/${nd.buildId}${pagePath}.json`,
            sources: ['nextjs'],
            confidence: 'medium',
            summary: 'Next.js 페이지 데이터 (getServerSideProps/getStaticProps)',
            params: Object.keys(nd.query || {}).map((k) => ({ name: k, in: 'query', type: 'string', example: nd.query[k], observed: [] })),
            evidence: [`__NEXT_DATA__ buildId=${nd.buildId}, page=${nd.page}`],
          }),
        ])
        log(`Next.js 감지 (page: ${nd.page}) → 페이지 데이터 엔드포인트 추가`, 'ok')
      }
    } catch {
      /* ignore */
    }
  }

  // 인라인 스크립트
  const inline = [...doc.querySelectorAll('script:not([src])')].map((s) => s.textContent).join('\n;\n')
  const inlineEps = scanCode(inline + '\n' + extractHtmlAttrs(doc), baseUrl, 'inline')
  if (inlineEps.length) log(`인라인 스크립트/속성에서 ${inlineEps.length}개 후보`, 'ok')
  add(inlineEps)

  // 외부 스크립트
  if (settings.scanExternalScripts) {
    const srcs = [
      ...doc.querySelectorAll('script[src]'),
      ...doc.querySelectorAll('link[rel="modulepreload"][href]'),
      ...doc.querySelectorAll('link[rel="preload"][as="script"][href]'),
    ]
      .map((el) => el.getAttribute('src') || el.getAttribute('href'))
      .map((s) => {
        try {
          return new URL(s, baseUrl).href
        } catch {
          return null
        }
      })
      .filter((s) => s && !NOISE_HOSTS.test(s))
    const queue = [...new Set(srcs)]
    const visited = new Set()
    let round = 0
    while (queue.length && visited.size < MAX_SCRIPTS && round < 2) {
      const batch = queue.splice(0, MAX_SCRIPTS - visited.size).filter((s) => !visited.has(s))
      batch.forEach((s) => visited.add(s))
      if (!batch.length) break
      log(`외부 스크립트 ${batch.length}개 분석 중…`)
      const results = await pMap(batch, (s) => request({ url: s }, settings), 4)
      const next = []
      results.forEach((r, i) => {
        const name = batch[i].split('/').pop().split('?')[0] || batch[i]
        if (!r || r.error || !r.text || r.status >= 400) {
          result.scripts.push({ url: batch[i], ok: false })
          return
        }
        const code = r.text.slice(0, MAX_SCRIPT_BYTES)
        const eps = scanCode(code, baseUrl, name)
        result.scripts.push({ url: batch[i], ok: true, size: r.size, found: eps.length })
        add(eps)
        if (round === 0) for (const c of findChunkUrls(code, batch[i])) if (!visited.has(c) && new URL(c).origin === new URL(batch[i]).origin) next.push(c)
      })
      queue.push(...new Set(next))
      round++
    }
    const okCount = result.scripts.filter((s) => s.ok).length
    log(`스크립트 ${okCount}/${result.scripts.length}개 분석 완료`, okCount ? 'ok' : 'warn')
  }

  // 스펙 문서 탐색
  if (settings.probeSpecs) {
    const origin = new URL(finalUrl).origin
    const hinted = [...doc.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => /swagger|openapi|api-docs|redoc/i.test(h || ''))
      .map((h) => new URL(h, baseUrl).href)
    const candidates = [...new Set([...hinted, ...SPEC_PATHS.map((p) => origin + p)])].slice(0, 18)
    log(`OpenAPI/Swagger 스펙 탐색 (${candidates.length}개 경로)…`)
    const found = await probeSpecs(candidates, settings)
    for (const f of found) {
      log(`스펙 발견: ${f.url} → ${f.endpoints.length}개 엔드포인트`, 'ok')
      result.specs.push({ url: f.url, ...f.info })
      add(f.endpoints)
    }
    if (!found.length) log('공개된 스펙 문서는 찾지 못했습니다', 'info')
  }

  log(`분석 완료: 총 ${result.endpoints.length}개 엔드포인트 후보`, 'ok')
  if (!result.endpoints.length) {
    log('정적 분석으로 찾지 못했습니다. 페이지가 런타임에 API를 호출한다면 "캡처 스크립트" 또는 "HAR 업로드" 방식이 가장 정확합니다.', 'warn')
  }
  return result
}

function extractHtmlAttrs(doc) {
  // data-url, data-api, hx-get 등 속성에 들어있는 URL
  const out = []
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of el.attributes || []) {
      if (/^(data-[\w-]*(url|api|endpoint|src|action)|hx-(get|post|put|patch|delete)|action|ng-src)$/i.test(a.name) && a.value) {
        const m = a.name.match(/^hx-(\w+)/)
        out.push(m ? `${m[1]}("${a.value}")`.replace(/^(\w+)/, '$.$1') : `url: "${a.value}"`)
      }
    }
  })
  return out.join('\n')
}

async function probeSpecs(candidates, settings) {
  const res = await pMap(
    candidates,
    async (u) => {
      const r = await request({ url: u, headers: { Accept: 'application/json, application/yaml, */*' } }, { ...settings, timeoutMs: 10000 })
      if (r.status !== 200) return null
      try {
        const doc = r.json && (r.json.openapi || r.json.swagger) ? r.json : /^(openapi|swagger)\s*:/m.test(r.text.slice(0, 2000)) ? parseSpecText(r.text) : null
        if (!doc) return null
        return { url: u, ...specToEndpoints(doc, u) }
      } catch {
        return null
      }
    },
    4,
  )
  const seen = new Set()
  return res.filter((x) => {
    if (!x || x.error) return false
    const key = x.endpoints.map((e) => e.method + e.url).join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function wordpressToEndpoints(index, rootUrl) {
  const root = (index.url ? index.url.replace(/\/$/, '') + '/wp-json' : rootUrl.replace(/\/$/, '')).replace(/\/wp-json\/wp-json$/, '/wp-json')
  const out = []
  for (const [route, info] of Object.entries(index.routes || {})) {
    const path = route.replace(/\(\?P<(\w+)>[^)]*\)/g, '{$1}')
    for (const ep of info.endpoints || []) {
      for (const method of ep.methods || []) {
        if (method === 'OPTIONS') continue
        out.push(
          newEndpoint({
            method,
            url: root + path,
            sources: ['wordpress'],
            confidence: 'high',
            summary: `WordPress ${info.namespace || ''}`.trim(),
            tags: [info.namespace].filter(Boolean),
            params: Object.entries(ep.args || {}).map(([name, a]) => ({
              name,
              in: path.includes(`{${name}}`) ? 'path' : method === 'GET' ? 'query' : 'body',
              type: Array.isArray(a.type) ? a.type[0] : a.type || 'string',
              required: !!a.required,
              description: a.description,
              enum: a.enum,
              example: a.default !== undefined && typeof a.default !== 'object' ? a.default : undefined,
              observed: [],
            })),
            bodyType: method === 'GET' ? null : 'json',
          }),
        )
      }
    }
  }
  return out
}

// ---------------- GraphQL ----------------
const INTROSPECTION = `query IntrospectionQuery { __schema { queryType { name } mutationType { name }
  types { kind name fields(includeDeprecated: false) { name description args { name description type { ...T } defaultValue } type { ...T } } } } }
fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }`

function typeName(t) {
  if (!t) return 'any'
  if (t.kind === 'NON_NULL') return typeName(t.ofType) + '!'
  if (t.kind === 'LIST') return `[${typeName(t.ofType)}]`
  return t.name
}
function namedType(t) {
  while (t && !t.name) t = t.ofType
  return t?.name
}

export async function graphqlIntrospect(url, settings, headers = {}) {
  const r = await request(
    { url, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ query: INTROSPECTION }) },
    settings,
  )
  const schema = r.json?.data?.__schema
  if (!schema) throw new Error(r.json?.errors?.[0]?.message || r.error || `introspection 실패 (HTTP ${r.status})`)
  const types = new Map(schema.types.map((t) => [t.name, t]))
  const selection = (tn, depth) => {
    const t = types.get(tn)
    if (!t || !t.fields || depth > 1) return ''
    const parts = t.fields
      .filter((f) => !f.args?.some((a) => a.type.kind === 'NON_NULL'))
      .slice(0, 12)
      .map((f) => {
        const nt = types.get(namedType(f.type))
        if (nt?.fields) {
          const sub = selection(nt.name, depth + 1)
          return sub ? `${f.name} ${sub}` : null
        }
        return f.name
      })
      .filter(Boolean)
    return parts.length ? `{ ${parts.join(' ')} }` : ''
  }
  const eps = []
  for (const [kind, root] of [
    ['query', schema.queryType?.name],
    ['mutation', schema.mutationType?.name],
  ]) {
    const rt = root && types.get(root)
    if (!rt?.fields) continue
    for (const f of rt.fields) {
      const varDefs = f.args.map((a) => `$${a.name}: ${typeName(a.type)}`).join(', ')
      const argUse = f.args.map((a) => `${a.name}: $${a.name}`).join(', ')
      const sel = selection(namedType(f.type), 0)
      const query = `${kind} ${f.name[0].toUpperCase() + f.name.slice(1)}${varDefs ? `(${varDefs})` : ''} { ${f.name}${argUse ? `(${argUse})` : ''} ${sel} }`
      eps.push(
        newEndpoint({
          method: 'POST',
          url: url + `#${kind}.${f.name}`,
          sources: ['graphql'],
          confidence: 'high',
          summary: `GraphQL ${kind}: ${f.name} → ${typeName(f.type)}`,
          description: f.description || '',
          tags: [`graphql-${kind}`],
          bodyType: 'graphql',
          bodyExample: JSON.stringify({ query, variables: Object.fromEntries(f.args.map((a) => [a.name, null])) }, null, 2),
          params: f.args.map((a) => ({
            name: a.name,
            in: 'variable',
            type: typeName(a.type),
            required: a.type.kind === 'NON_NULL',
            description: a.description,
            example: a.defaultValue ?? undefined,
            observed: [],
          })),
        }),
      )
    }
  }
  return eps
}
