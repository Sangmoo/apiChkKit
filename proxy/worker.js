// API Check Kit 용 개인 CORS 프록시 (Cloudflare Workers, 무료 플랜으로 충분)
//
// 배포: https://dash.cloudflare.com → Workers & Pages → Create → "Hello World" 워커 생성
//       → 이 파일 내용을 붙여넣고 Deploy
// 사용: API Check Kit ⚙️ 설정 → 개인 CORS 프록시 URL 에
//       https://<워커이름>.<계정>.workers.dev/?url={url}
//
// 보안: 아무나 쓰지 못하도록 ALLOWED_ORIGINS 를 본인 앱 주소로 제한하세요.

const ALLOWED_ORIGINS = [
  'https://sangmoo-apichkkit.static.hf.space',
  'https://huggingface.co',
  'http://localhost:5173',
]

// 대상 서버로 전달하지 않을 헤더
const DROP_REQ_HEADERS = ['host', 'origin', 'referer', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || ''
    const allowed = !origin || ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.hf.space')
    if (!allowed) return new Response('Origin not allowed', { status: 403 })

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })

    const target = new URL(req.url).searchParams.get('url')
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response('usage: ?url=https://example.com/api', { status: 400, headers: corsHeaders(origin) })
    }

    const headers = new Headers(req.headers)
    for (const h of DROP_REQ_HEADERS) headers.delete(h)
    if (!headers.has('user-agent')) headers.set('user-agent', 'Mozilla/5.0 (compatible; ApiChkKit/1.0)')

    let upstream
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
        redirect: 'follow',
      })
    } catch (e) {
      return new Response(`upstream fetch failed: ${e.message}`, { status: 502, headers: corsHeaders(origin) })
    }

    const out = new Response(upstream.body, upstream)
    for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v)
    out.headers.set('X-Final-Url', upstream.url)
    out.headers.delete('content-security-policy')
    out.headers.delete('set-cookie')
    return out
  },
}
