// 페이지 쪽(MAIN world)에서 돈다. 부동산 사이트 화면이 받은 JSON 응답을 복사해 bridge.js로 넘긴다.
// 확장 팝업에서 켠 사이트에만 들어간다(background.js가 등록).
(() => {
  if (window.__hnwHook) return;
  window.__hnwHook = true;

  // 로그인, 개인 정보, 로그 요청은 읽지 않는다.
  const SKIP = /(member|login|logout|auth|token|user|\/my\b|mypage|favorite|interest|alarm|notif|nelo|\/log\b|analytics|\/si$)/i;
  const MAX_BODY = 2000000;
  let requestOrder = 0;
  const requestMeta = () => ({requestOrder:++requestOrder,requestPageUrl:location.href});
  const started = (url,meta) => {
    try { const parsed=new URL(url,location.href); if(parsed.origin==='https://fin.land.naver.com' && /\/article\/legalDivisionArticleList\/?$/.test(parsed.pathname)) window.postMessage({__hnw:'naver-list-request',url:parsed.href,...meta},location.origin); } catch { /* Ignore unrelated requests. */ }
  };
  // 그 사이트의 데이터 주소만 읽는다. 네이버는 부동산(land.naver.com)만, 당근은 daangn.com과 karrotmarket.com.
  const host = location.hostname;
  const base = /(^|\.)land\.naver\.com$/.test(host) ? 'land.naver.com' : host.split('.').slice(-2).join('.');
  const bases = base === 'daangn.com' ? ['daangn.com', 'karrotmarket.com'] : [base];

  const wanted = (url) => {
    try {
      const u = new URL(url, location.href);
      return bases.some((b) => u.hostname === b || u.hostname.endsWith(`.${b}`)) && !SKIP.test(u.pathname);
    } catch {
      return false;
    }
  };

  const post = (url, method, status, requestBody, body, meta = {}) => {
    if (typeof body !== 'string' || !body || body.length > MAX_BODY) return;
    window.postMessage(
      {
        __hnw: 'capture',
        url,
        method,
        status,
        // 요청 본문(필터, 묶음 번호)은 표시 계산에 쓰므로 넉넉히 넘긴다. 서버는 앞 4,000자만 저장한다.
        requestBody: typeof requestBody === 'string' ? requestBody.slice(0, 20000) : null,
        body,
        ...meta,
      },
      location.origin,
    );
  };

  // 당근부동산: 페이지가 다 뜨고 2초 뒤에 페이지에 담긴 데이터(__NEXT_DATA__, 없으면 self.__next_f 조각을 이은 것)를 한 번 넘긴다.
  // 주소는 '페이지 주소#page-data'.
  if (base === 'daangn.com') {
    const sendPageData = () => {
      const next = document.getElementById('__NEXT_DATA__');
      const flight = Array.isArray(window.__next_f)
        ? window.__next_f.map((x) => (Array.isArray(x) && typeof x[1] === 'string' ? x[1] : '')).join('')
        : '';
      const body = next && next.textContent ? next.textContent : flight ? JSON.stringify({ nextFlight: flight }) : null;
      if (body) post(`${location.origin}${location.pathname}${location.search}#page-data`, 'PAGE', 200, null, body);
    };
    if (document.readyState === 'complete') setTimeout(sendPageData, 2000);
    else window.addEventListener('load', () => setTimeout(sendPageData, 2000), { once: true });
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const meta = requestMeta();
    // 당근처럼 Request 객체에 본문을 담아 보내는 화면은 보내기 전에 복사본을 만든다. 원래 요청은 그대로 보낸다.
    let copy = null;
    try {
      if (input instanceof Request && !(init && init.body != null) && !['GET', 'HEAD'].includes(input.method) && wanted(input.url)) copy = input.clone();
    } catch {
      copy = null;
    }
    const promise = nativeFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
      const inline = init && typeof init.body === 'string' ? init.body : null;
      const requestBody = copy ? copy.text().catch(() => null) : Promise.resolve(inline);
      if (url && wanted(url)) {
        started(url,meta);
        promise
          .then((res) => {
            if (!(res.headers.get('content-type') || '').includes('json')) return;
            Promise.all([requestBody, res.clone().text()])
              .then(([request, body]) => post(res.url || url, method, res.status, request, body, meta))
              .catch(() => {});
          })
          .catch(() => {});
      }
    } catch {
      /* 읽기에 실패해도 페이지 동작은 그대로 둔다 */
    }
    return promise;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__hnw = { method: String(method), url: String(url) };
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (requestBody) {
    const info = this.__hnw;
    if (info && wanted(info.url)) {
      const meta = requestMeta();
      started(info.url,meta);
      this.addEventListener('load', () => {
        try {
          if (!(this.getResponseHeader('content-type') || '').includes('json')) return;
          const body =
            this.responseType === '' || this.responseType === 'text'
              ? this.responseText
              : this.responseType === 'json'
                ? JSON.stringify(this.response)
                : null;
          post(this.responseURL || info.url, info.method, this.status, requestBody, body, meta);
        } catch {
          /* 읽기에 실패해도 페이지 동작은 그대로 둔다 */
        }
      });
    }
    return nativeSend.apply(this, arguments);
  };
})();
