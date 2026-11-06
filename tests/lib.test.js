import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanCode } from '../src/lib/jsScanner.js'
import { parseCurl, parseHar, shellSplit } from '../src/lib/importers.js'
import { observationsToEndpoints, templatizePath } from '../src/lib/endpoint.js'
import { specToEndpoints, endpointsToOpenApi } from '../src/lib/openapi.js'
import { buildRequest, initialValues } from '../src/lib/builder.js'
import { inferSchema, mergeSchema, flattenSchema, safeJson } from '../src/lib/schema.js'

test('JS 번들에서 fetch/axios/템플릿 URL 추출', () => {
  const code = `
    fetch("/api/v1/search?q=" + q);
    axios.post('/api/users', { name, email });
    const r = await fetch(\`\${API}/api/items/\${item.id}?page=\${page}&size=20\`, { method: 'PUT', body: JSON.stringify({ title: t, done }) });
    x.open("DELETE", "https://api.example.com/v2/orders/1");
    const docs = "https://reactjs.org/docs/error-decoder.html";
    const img = "/static/logo.png";`
  const eps = scanCode(code, 'https://site.com/page', 'bundle.js')
  const keys = eps.map((e) => `${e.method} ${e.url}`)
  assert.ok(keys.includes('GET https://site.com/api/v1/search'), keys.join('\n'))
  assert.ok(keys.includes('POST https://site.com/api/users'))
  assert.ok(keys.includes('PUT https://site.com/api/items/{id}'), keys.join('\n'))
  assert.ok(keys.includes('DELETE https://api.example.com/v2/orders/1'))
  assert.ok(!keys.some((k) => k.includes('reactjs') || k.includes('logo.png')))
  const put = eps.find((e) => e.method === 'PUT')
  assert.ok(put.params.some((p) => p.name === 'page' && p.in === 'query'))
  assert.ok(put.params.some((p) => p.name === 'size' && p.in === 'query'))
  assert.ok(put.params.some((p) => p.name === 'title' && p.in === 'body'))
  assert.ok(put.params.some((p) => p.name === 'id' && p.in === 'path'))
  const post = eps.find((e) => e.method === 'POST')
  assert.deepEqual(post.params.filter((p) => p.in === 'body').map((p) => p.name).sort(), ['email', 'name'])
})

test('cURL 파싱 (bash, cmd)', () => {
  const { observations } = parseCurl(`curl 'https://api.x.com/v1/q?a=1' \
  -H 'Authorization: Bearer abcdefghijklmnop' \
  --data-raw '{"k":"v","n":2}'
curl ^"https://api.x.com/v1/list^" -H ^"Accept: application/json^"`)
  assert.equal(observations.length, 2)
  assert.equal(observations[0].method, 'POST')
  assert.equal(observations[0].reqBody, '{"k":"v","n":2}')
  assert.equal(observations[1].url, 'https://api.x.com/v1/list')
  const eps = observationsToEndpoints(observations, 'curl')
  const p = eps[0].params
  assert.ok(p.find((x) => x.name === 'a' && x.in === 'query'))
  assert.ok(p.find((x) => x.name === 'n' && x.in === 'body' && x.type === 'integer'))
  assert.ok(p.find((x) => x.name === 'authorization').example.includes('…'))
  assert.deepEqual(shellSplit(String.raw`a "b c" 'd e' f\ g`), ['a', 'b c', 'd e', 'f g'])
})

test('HAR → 엔드포인트 그룹화 + 응답 스키마', () => {
  const mk = (url, body) => ({
    request: { method: 'GET', url, headers: [], queryString: [] },
    response: { status: 200, headers: [], content: { mimeType: 'application/json', text: JSON.stringify(body) } },
    _resourceType: 'xhr', time: 12,
  })
  const har = { log: { entries: [
    mk('https://s.com/api/users/12?tab=info', { id: 12, name: 'a', tags: ['x'] }),
    mk('https://s.com/api/users/34', { id: 34, name: 'b', email: null }),
    { request: { method: 'GET', url: 'https://s.com/app.js', headers: [] }, response: { status: 200, content: { mimeType: 'application/javascript' } } },
  ] } }
  const { observations, skipped } = parseHar(JSON.stringify(har))
  assert.equal(skipped, 1)
  const eps = observationsToEndpoints(observations, 'har')
  assert.equal(eps.length, 1)
  assert.equal(eps[0].url, 'https://s.com/api/users/{userId}')
  const tab = eps[0].params.find((p) => p.name === 'tab')
  assert.equal(tab.required, false)
  const rows = flattenSchema(eps[0].responses['200'].schema)
  assert.ok(rows.find((r) => r.path === 'id' && r.required))
  assert.ok(rows.find((r) => r.path === 'email' && !r.required))
  assert.equal(templatizePath('/a/550e8400-e29b-41d4-a716-446655440000/b'), '/a/{uuid}/b')
})

test('OpenAPI 3 파싱 + 내보내기 왕복', () => {
  const spec = {
    openapi: '3.0.0', info: { title: 'T', version: '1' }, servers: [{ url: '/v1' }],
    paths: { '/pets/{petId}': { parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
      get: { summary: 'Get pet', parameters: [{ name: 'fields', in: 'query', schema: { type: 'string', enum: ['a', 'b'] } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
      post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, responses: { 201: { description: 'created' } } } } },
    components: { schemas: { Pet: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, name: { type: 'string', example: 'doggie' }, owner: { $ref: '#/components/schemas/Pet' } } } } },
  }
  const { endpoints } = specToEndpoints(spec, 'https://p.io/openapi.json')
  assert.equal(endpoints.length, 2)
  const get = endpoints.find((e) => e.method === 'GET')
  assert.equal(get.url, 'https://p.io/v1/pets/{petId}')
  assert.deepEqual(get.params.find((p) => p.name === 'fields').enum, ['a', 'b'])
  assert.ok(flattenSchema(get.responses['200'].schema).some((r) => r.path === 'name'))
  const post = endpoints.find((e) => e.method === 'POST')
  assert.equal(JSON.parse(post.bodyExample).name, 'doggie')
  const vals = initialValues(get)
  vals['path:petId'].value = '7'
  vals['query:fields'] = { value: 'b', enabled: true }
  const req = buildRequest(get, vals)
  assert.equal(req.url, 'https://p.io/v1/pets/7?fields=b')
  const out = endpointsToOpenApi(endpoints)
  assert.ok(out.paths['/v1/pets/{petId}'].get)
  assert.equal(out.servers[0].url, 'https://p.io')
})

test('스키마 병합 / JSONP', () => {
  const s = mergeSchema(inferSchema({ a: 1, b: 'x' }), inferSchema({ a: 2.5, c: true }))
  assert.equal(s.properties.a.type, 'number')
  assert.deepEqual(s.required, ['a'])
  assert.deepEqual(safeJson('cb({"x":1});'), { x: 1 })
})

test('번들 속 API 전용 호스트로 상대 경로 해석 (11번가 형태)', async () => {
  const { findApiHost } = await import('../src/lib/jsScanner.js')
  const code = `var tn="apis.11st.co.kr",x="//c.011st.com/a.css";
    u()(this,"URL","/".concat("search","/api/tab"));
    h.A.get("/search/api/tab-filter?kwd=" + k);
    v.post("/search/api/max-discount", { productNo, sellPrice });`
  const host = findApiHost(code, 'https://search.11st.co.kr/pc/total-search?kwd=a')
  assert.equal(host, 'apis.11st.co.kr')
  const eps = scanCode(code, 'https://search.11st.co.kr/pc/total-search', 'app.js', { apiHost: host })
  const keys = eps.map((e) => `${e.method} ${e.url}`)
  assert.ok(keys.includes('GET https://apis.11st.co.kr/search/api/tab-filter'), keys.join('\n'))
  assert.ok(keys.includes('POST https://apis.11st.co.kr/search/api/max-discount'), keys.join('\n'))
})

test('캡처: 캐시 방지 파라미터, 배열 본문, resource 중복 제거', async () => {
  const { parseCapture } = await import('../src/lib/importers.js')
  const cap = { apiChkKitCapture: 1, entries: [
    { type: 'resource', method: 'GET', url: 'https://apis.x.co.kr/search/api/max-discount', status: 200 },
    { type: 'xhr', method: 'GET', url: 'https://apis.x.co.kr/search/api/tab?kwd=A&sortCd=L&_=1793947543678', status: 200, contentType: 'application/json', responseBody: '{"curPage":1,"data":[]}' },
    { type: 'xhr', method: 'GET', url: 'https://apis.x.co.kr/search/api/tab?kwd=B&_=1793947543999', status: 200, contentType: 'application/json', responseBody: '{"curPage":1,"data":[]}' },
    { type: 'xhr', method: 'POST', url: 'https://apis.x.co.kr/search/api/max-discount', requestBody: '[{"productNo":1,"sellPrice":2}]', status: 200, contentType: 'application/json', responseBody: '[]' },
  ] }
  const { observations } = parseCapture(JSON.stringify(cap))
  assert.equal(observations.length, 3)
  const eps = observationsToEndpoints(observations, 'capture')
  const tab = eps.find((e) => e.url.endsWith('/tab'))
  const bust = tab.params.find((p) => p.name === '_')
  assert.ok(bust.cacheBuster && !bust.required)
  assert.equal(tab.params.find((p) => p.name === 'kwd').required, true)
  assert.equal(tab.params.find((p) => p.name === 'sortCd').required, false)
  const md = eps.find((e) => e.url.endsWith('/max-discount'))
  assert.equal(md.method, 'POST')
  assert.ok(md.params.find((p) => p.name === '[].productNo' && p.in === 'body'))
})
