// 대상 사이트 안에서 실행하는 스크립트들 (콘솔 붙여넣기 또는 북마클릿).
// 사이트가 자기 화면에서 하는 요청을 사용자의 브라우저에서 그대로 관찰·실행하므로 CORS 와 무관하다.

// 대상 사이트 화면 오른쪽 아래에 띄우는 작은 패널 (콘솔 없이 결과 복사)
const PANEL = `
  const panel = (title) => {
    const old = document.getElementById('__ackPanel'); if (old) old.remove();
    const d = document.createElement('div'); d.id = '__ackPanel';
    d.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1b1f2e;color:#fff;font:13px/1.5 sans-serif;padding:12px 14px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);min-width:240px;max-width:340px';
    d.innerHTML = '<b style="display:block;margin-bottom:4px">✅ API Check Kit · ' + title + '</b><div class="m"></div><div style="margin-top:8px;display:flex;gap:6px"><button class="c" style="flex:1;background:#4f46e5;color:#fff;border:0;border-radius:6px;padding:6px 8px;cursor:pointer">결과 복사</button><button class="x" style="background:#444;color:#fff;border:0;border-radius:6px;padding:6px 8px;cursor:pointer">닫기</button></div>';
    document.body.appendChild(d);
    d.querySelector('.x').onclick = () => d.remove();
    return { msg: (t) => d.querySelector('.m').textContent = t, onCopy: (fn) => d.querySelector('.c').onclick = fn };
  };
  const copyOut = async (out, p) => {
    try { await navigator.clipboard.writeText(out); p.msg('복사했습니다. API Check Kit 에 붙여넣으세요.'); }
    catch { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out], { type: 'application/json' })); a.download = 'api-check-kit.json'; a.click(); p.msg('클립보드 대신 파일로 저장했습니다.'); }
  };`

// fetch / XMLHttpRequest 를 감싸서 요청·응답을 기록한다.
export const CAPTURE_SCRIPT = `(() => {${PANEL}
  if (window.__ack) { window.__ackPanel && window.__ackPanel.msg('이미 캡처 중입니다 (' + window.__ack.length + '건)'); return; }
  const MAX = 200000, entries = [];
  const p = panel('캡처 중'); window.__ackPanel = p;
  const upd = () => p.msg('요청 ' + entries.length + '건 기록됨. 검색·정렬·페이지 이동 등을 해본 뒤 [결과 복사]를 누르세요.');
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
      entries.push(e); upd();
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
        e.responseHeaders = rh; entries.push(e); upd();
      });
    }
    return XS.apply(this, arguments);
  };
  // 스크립트 실행 전에 발생한 요청(본문 없음)도 포함
  performance.getEntriesByType('resource').filter((r) => /fetch|xmlhttprequest/.test(r.initiatorType) && !skip(r.name))
    .forEach((r) => entries.push({ type: 'resource', method: 'GET', url: r.name, status: r.responseStatus || 0, time: Math.round(r.duration) }));
  window.__ack = entries; upd();
  const done = async () => {
    await new Promise((r) => setTimeout(r, 300));
    await copyOut(JSON.stringify({ apiChkKitCapture: 1, page: location.href, capturedAt: new Date().toISOString(), entries }), p);
    return entries.length;
  };
  p.onCopy(done); window.__ackDone = done;
})();`

/** 북마크 주소창에 넣을 수 있는 형태 */
export const CAPTURE_BOOKMARKLET = 'javascript:' + encodeURIComponent(CAPTURE_SCRIPT)

const SAME_SITE_LIMIT = 30

/**
 * 앱에서 조립한 요청들을 대상 사이트 탭에서 순서대로 실행하는 스크립트.
 * 사이트 자신의 출처에서, 사용자의 로그인 상태(쿠키)로 호출하므로 사이트 화면이 하는 요청과 같다.
 * @param {Array<{id:string,label:string,url:string,method:string,headers:object,body:string|null}>} requests
 */
export function buildSiteRunScript(requests) {
  const list = requests.slice(0, SAME_SITE_LIMIT).map((r) => ({ id: r.id, label: r.label, url: r.url, method: r.method, headers: r.headers || {}, body: r.body ?? null }))
  return `(async () => {${PANEL}
  const reqs = ${JSON.stringify(list)};
  const p = panel('요청 실행'); const results = [];
  const host = new URL(reqs[0].url).hostname.split('.').slice(-2).join('.');
  const warn = location.hostname.endsWith(host) ? '' : '⚠️ 지금 탭(' + location.hostname + ')은 대상 사이트가 아닐 수 있습니다. 대상 사이트 탭에서 실행해야 차단되지 않습니다. ';
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i], t0 = performance.now();
    p.msg(warn + (i + 1) + ' / ' + reqs.length + ' 실행 중: ' + r.label);
    try {
      const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body, credentials: 'include' });
      const text = (await res.text()).slice(0, 300000); const h = {}; res.headers.forEach((v, k) => h[k] = v);
      results.push({ id: r.id, label: r.label, status: res.status, time: Math.round(performance.now() - t0), contentType: res.headers.get('content-type') || '', headers: h, text });
    } catch (e) { results.push({ id: r.id, label: r.label, status: 0, error: String(e && e.message || e) }); }
    if (i < reqs.length - 1) await new Promise((s) => setTimeout(s, 400));
  }
  const out = JSON.stringify({ apiChkKitRun: 1, page: location.href, results });
  window.__ackRun = out;
  p.msg(warn + '완료: ' + results.length + '건. [결과 복사]를 눌러 API Check Kit 에 붙여넣으세요.');
  p.onCopy(() => copyOut(out, p));
})();`
}

export const SITE_RUN_LIMIT = SAME_SITE_LIMIT

/** 사이트 실행 결과(JSON) 파싱 */
export function parseSiteRunResults(text) {
  const data = JSON.parse(text)
  if (!data?.apiChkKitRun || !Array.isArray(data.results)) throw new Error('"대상 사이트에서 실행" 결과 형식이 아닙니다')
  return data.results
}
