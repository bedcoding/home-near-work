// Runs only in the owned collection document. The hook forwards its response
// through the same durable capture and storage verification as an ordinary page request.
async function hnwFetchNaverPage(body) {
  if (location.origin !== 'https://fin.land.naver.com' || location.pathname.replace(/\/$/, '') !== '/map' || !window.__hnwHook) {
    return { error: 'collection-document-missing' };
  }
  if (typeof body !== 'string' || body.length > 20000) return { error: 'invalid-request' };
  try {
    for (const element of document.querySelectorAll('iframe[src*="captcha"], iframe[title*="challenge"], [id="captcha"], [id="challenge-form"], h1, h2, [role="alert"], [role="dialog"], dialog')) {
      const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (!bounds.width || !bounds.height || style.display === 'none' || style.visibility === 'hidden') continue;
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      if (element.tagName === 'IFRAME' || /접근[이을 ]*(?:제한|차단)|비정상적인?\s*(?:접근|요청)|자동(?:입력|접속)\s*방지|로그인(?:이|을)?\s*(?:필요|해\s*주세요|후)|verify (?:that )?you are human|access denied/i.test(text)) return { error: 'page-security-check' };
    }
    const request = JSON.parse(body);
    if (!request.filter || !request.articlePagingRequest || !Array.isArray(request.articlePagingRequest.lastInfo)) return { error: 'invalid-request' };
    const response = await window.fetch('https://fin.land.naver.com/front-api/v1/article/legalDivisionArticleList', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
      credentials: 'same-origin', mode: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, json: (response.headers.get('content-type') || '').includes('json') };
  } catch { return { error: 'request-failed' }; }
}
