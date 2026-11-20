// 페이지 쪽(MAIN world)에서 돈다. 부동산 사이트 화면이 받은 JSON 응답을 복사해 bridge.js로 넘긴다.
// 확장 팝업에서 켠 사이트와 이전 순차 조회의 당근 지도에 등록한다.
(() => {
  if (window.__hnwHook) return;
  const host = location.hostname;
  const daangn = host === 'realty.daangn.com';
  const daangnCapture = daangn && typeof HNW_DAANGN_CAPTURE !== 'undefined' ? HNW_DAANGN_CAPTURE : null;
  if (daangn && !daangnCapture) return;
  window.__hnwHook = true;

  // 로그인, 개인 정보, 로그 요청은 읽지 않는다.
  const SKIP = /(member|login|logout|auth|token|user|\/my\b|mypage|favorite|interest|alarm|notif|nelo|\/log\b|analytics|\/si$)/i;
  const MAX_BODY = 2000000;
  let requestOrder = 0;
  const requestMeta = () => ({requestOrder:++requestOrder,requestPageUrl:location.href});
  const started = (url,meta) => {
    try { const parsed=new URL(url,location.href); if(parsed.origin==='https://fin.land.naver.com' && /\/article\/legalDivisionArticleList\/?$/.test(parsed.pathname)) window.postMessage({__hnw:'naver-list-request',url:parsed.href,...meta},location.origin); } catch { /* Ignore unrelated requests. */ }
  };
  // 그 사이트의 데이터 주소만 읽는다. 네이버는 부동산(land.naver.com)만.
  const base = /(^|\.)land\.naver\.com$/.test(host) ? 'land.naver.com' : host.split('.').slice(-2).join('.');
  const denied = status => daangn && (status === 403 || status === 429);

  const wanted = (url) => {
    try {
      if (daangn) return daangnCapture.endpoint(url) && !!daangnCapture.page(location.href);
      const u = new URL(url, location.href);
      return (u.hostname === base || u.hostname.endsWith(`.${base}`)) && !SKIP.test(u.pathname);
    } catch {
      return false;
    }
  };

  const post = (url, method, status, requestBody, body, meta = {}) => {
    if (daangn) {
      const requestPageUrl = daangnCapture.page(meta.requestPageUrl);
      if (!requestPageUrl || !daangnCapture.endpoint(url)) return;
      if (denied(status)) {
        window.postMessage({ __hnw: 'capture', url: daangnCapture.graphql, method, status,
          requestBody: null, body: '', requestPageUrl, requestOrder: meta.requestOrder }, location.origin);
        return;
      }
      if (status < 200 || status >= 300) return;
      body = daangnCapture.body(body);
      requestBody = daangnCapture.requestBody(requestBody, String(method).toUpperCase() === 'GET' ? url : null);
      // 추천 영역도 articleFeed를 쓴다. 페이지 커서가 있는 매물 요청만 추적한다.
      if (!requestBody) return;
      url = daangnCapture.graphql;
      meta = { requestPageUrl, requestOrder: meta.requestOrder };
    }
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

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const meta = requestMeta();
    // Request 객체에 본문을 담아 보내는 화면은 보내기 전에 복사본을 만든다. 원래 요청은 그대로 보낸다.
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
            if (denied(res.status)) { post(res.url || url, method, res.status, null, '', meta); return; }
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
          if (denied(this.status)) { post(this.responseURL || info.url, info.method, this.status, null, '', meta); return; }
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
