// 대상 사이트의 개발자 도구 콘솔에 붙여넣어 실행하는 캡처 스크립트.
// fetch / XMLHttpRequest 를 감싸서 요청·응답을 기록하고, __ackDone() 으로 결과를 클립보드에 복사한다.
// CORS와 무관하게 실제 페이지가 호출하는 API를 그대로 수집할 수 있다.

export const CAPTURE_SCRIPT = `(() => {
  if (window.__ack) { console.log('[API Check Kit] 이미 캡처 중입니다. __ackDone() 으로 종료하세요.'); return; }
  const MAX = 200000, entries = [];
  const skip = (u) => /\\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|mp4)(\\?|$)/i.test(u) || /google-analytics|googletagmanager|doubleclick|facebook|hotjar|sentry/.test(u);
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return String(u); } };
  const hdr = (h) => { const o = {}; try { new Headers(h || {}).forEach((v, k) => o[k] = v); } catch {} return o; };
  const bodyStr = (b) => b == null ? null : typeof b === 'string' ? b : b instanceof URLSearchParams ? b.toString()
    : b instanceof FormData ? [...b].map(([k, v]) => k + '=' + (typeof v === 'string' ? v : '[file]')).join('&') : '[binary]';
  const of = window.fetch;
  window.fetch = async function (input, init = {}) {
    const t0 = performance.now();
    const req = input instanceof Request ? input : null;
    const url = abs(req ? req.url : input), method = (init.method || (req && req.method) || 'GET').toUpperCase();
    let reqBody = bodyStr(init.body);
    if (reqBody == null && req && method !== 'GET') { try { reqBody = await req.clone().text(); } catch {} }
    const res = await of.apply(this, arguments);
    if (!skip(url)) {
      const e = { type: 'fetch', method, url, requestHeaders: { ...hdr(req && req.headers), ...hdr(init.headers) }, requestBody: reqBody,
        status: res.status, responseHeaders: hdr(res.headers), contentType: res.headers.get('content-type') || '', time: Math.round(performance.now() - t0) };
      entries.push(e);
      res.clone().text().then((t) => e.responseBody = t.slice(0, MAX)).catch(() => {});
    }
    return res;
  };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send, XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__ack = { type: 'xhr', method: String(m).toUpperCase(), url: abs(u), requestHeaders: {} }; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (this.__ack) this.__ack.requestHeaders[k] = v; return XH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    const e = this.__ack, t0 = performance.now();
    if (e && !skip(e.url)) {
      e.requestBody = bodyStr(b);
      this.addEventListener('loadend', () => {
        e.status = this.status; e.time = Math.round(performance.now() - t0);
        e.contentType = this.getResponseHeader('content-type') || '';
        try { e.responseBody = (this.responseType === '' || this.responseType === 'text') ? String(this.responseText).slice(0, MAX) : JSON.stringify(this.response).slice(0, MAX); } catch {}
        const rh = {}; (this.getAllResponseHeaders() || '').trim().split(/\\r?\\n/).forEach((l) => { const i = l.indexOf(':'); if (i > 0) rh[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
        e.responseHeaders = rh; entries.push(e);
      });
    }
    return XS.apply(this, arguments);
  };
  // 스크립트 실행 전에 발생한 요청(본문 없음)도 포함
  performance.getEntriesByType('resource').filter((r) => /fetch|xmlhttprequest/.test(r.initiatorType) && !skip(r.name))
    .forEach((r) => entries.push({ type: 'resource', method: 'GET', url: r.name, status: r.responseStatus || 0, time: Math.round(r.duration) }));
  window.__ack = entries;
  window.__ackDone = async () => {
    await new Promise((r) => setTimeout(r, 300));
    const out = JSON.stringify({ apiChkKitCapture: 1, page: location.href, capturedAt: new Date().toISOString(), entries }, null, 0);
    try { copy(out); } catch { try { await navigator.clipboard.writeText(out); } catch {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out], { type: 'application/json' })); a.download = 'api-capture.json'; a.click(); } }
    console.log('[API Check Kit] ' + entries.length + '개 요청을 복사했습니다. API Check Kit 에 붙여넣으세요.');
    return entries.length;
  };
  console.log('[API Check Kit] 캡처 시작! 페이지에서 검색·필터·페이지 이동 등을 해본 뒤 __ackDone() 을 실행하세요.');
})();`
