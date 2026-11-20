// 확장 쪽(ISOLATED world)에서 돈다. hook.js가 넘긴 응답을
// 1) 백그라운드로 보내 대시보드에 쌓고 2) 그 사이트용 표시 스크립트(naver.js 등)에 넘긴다.
// 아이콘 팝업에서 '화면 구조 보내기'를 누르면 지금 화면 구조(HTML)를 돌려준다.
// 확장이 새 버전으로 바뀌어 이 탭과 연결이 끊겼을 때는 새로고침 안내를 띄운다.

const HNW_SITE = hnwSiteFor(location.hostname);
/** 사이트별 표시 스크립트가 여기에 자기를 등록한다: HNW_ADAPTERS[siteId] = { onCapture(capture) } */
const HNW_ADAPTERS = {};
// 이동 전 문서에서 늦게 온 응답이 다른 지역에 섞이지 않도록 문서마다 식별한다.
const HNW_DOCUMENT_TOKEN = crypto.randomUUID();
// null 응답만 일반 탭을 뜻한다. 연결 오류나 순회 전용 탭의 미연결 문서를 일반 수집으로 돌리지 않는다.
const HNW_BROWSE_CONTEXT = Promise.resolve()
  .then(() => chrome.runtime.sendMessage({ type: 'browse-context', documentToken: HNW_DOCUMENT_TOKEN }))
  .then((context) => context === null || context?.owned === true ? context : { owned: true, jobId: null })
  .catch(() => ({ owned: true, jobId: null }));

let reloadNoticeShown = false;

function showReloadNotice() {
  if (reloadNoticeShown) return;
  reloadNoticeShown = true;
  const el = document.createElement('div');
  el.textContent = '회사근처 내집마련 확장이 새 버전으로 바뀌었습니다. 이 탭을 새로고침(F5)해 주세요. (누르면 닫힘)';
  el.setAttribute(
    'style',
    'position:fixed;left:16px;bottom:16px;z-index:2147483647;max-width:320px;padding:10px 14px;border-radius:12px;' +
      'background:rgba(22,32,46,.92);color:#fff;font:600 13px/1.45 "Malgun Gothic","Apple SD Gothic Neo",sans-serif;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.3);cursor:pointer',
  );
  el.addEventListener('click', () => el.remove());
  document.documentElement.appendChild(el);
}

const extensionAlive = () => !!(chrome.runtime && chrome.runtime.id);

const takeSnapshot = () => ({
  site: HNW_SITE ? HNW_SITE.id : null,
  pageUrl: location.href,
  title: document.title,
  html: document.documentElement.outerHTML.slice(0, 5000000),
  viewport: { width: innerWidth, height: innerHeight },
});

// 데이터를 처음 받으면 잠시 뒤(그려진 다음) 화면 구조를 한 번 보낸다.
// 네이버는 지도 묶음, 묶음 목록을 받을 때, 다른 사이트는 아무 데이터나 처음 받을 때. 종류마다 10분에 한 번까지만.
const lastAutoSnapshot = {};

function snapshotKind(url) {
  let name = '';
  try {
    name = new URL(url).pathname.split('/').pop();
  } catch {
    return null;
  }
  if (!HNW_SITE) return null;
  if (HNW_SITE.id === 'naver') return { articleClusters: 'map', clusteredArticles: 'list', boundedArticles: 'list', legalDivisionArticleList: 'list' }[name] || null;
  return 'page';
}

function maybeAutoSnapshot(url) {
  const kind = snapshotKind(url);
  if (!kind || Date.now() - (lastAutoSnapshot[kind] || 0) < 10 * 60 * 1000) return;
  lastAutoSnapshot[kind] = Date.now();
  setTimeout(() => {
    if (!extensionAlive()) return;
    chrome.runtime.sendMessage({ type: 'auto-snapshot', snapshot: { ...takeSnapshot(), kind } }).catch(() => {});
  }, 2500);
}

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.__hnw !== 'capture') return;
  const { url, method, status, requestBody, body, requestPageUrl } = event.data;
  const daangn = HNW_SITE?.id === 'daangn';
  const denied = status === 403 || status === 429;
  if (daangn && (event.origin !== location.origin || url !== 'https://realty.kr.karrotmarket.com/graphql' ||
    typeof requestPageUrl !== 'string' || requestPageUrl.length > 2000 || typeof body !== 'string' || !Number.isInteger(status) ||
    !denied && (status < 200 || status >= 300 || !body || body.length > 2000000))) return;
  // MAIN에서 공개 목록으로 투영한 응답이며, 서비스 워커가 저장하기 전에 다시 검증한다.
  const capture = daangn
    ? { site: 'daangn', pageUrl: requestPageUrl, url, method, status,
      requestBody: !denied && typeof requestBody === 'string' && requestBody.length <= 20000 ? requestBody : null, body: denied ? '' : body }
    : { at: new Date().toISOString(), site: HNW_SITE ? HNW_SITE.id : null, pageUrl: location.href, url, method, status, requestBody, body };
  const adapter = HNW_SITE && HNW_ADAPTERS[HNW_SITE.id];
  if (adapter) {
    try {
      adapter.onCapture(capture);
    } catch (e) {
      console.warn('[회사근처 내집마련] 표시 중 오류', e);
    }
  }
  try {
    // 확장을 다시 불러오면 이미 열려 있던 탭의 이 스크립트는 연결이 끊긴다(chrome.runtime.id가 사라짐).
    if (!extensionAlive()) {
      showReloadNotice();
      return;
    }
    void HNW_BROWSE_CONTEXT.then(async (context) => {
      if (context?.owned && !context.jobId) return;
      if (daangn && !context?.jobId) {
        if (!capture.body) return;
        const { sites: toggles } = await chrome.storage.local.get('sites');
        if (!hnwEnabled(toggles, HNW_SITE)) return;
      }
      if (!daangn) maybeAutoSnapshot(url);
      return chrome.runtime.sendMessage({
        type: 'capture', capture,
        ...(context?.jobId ? { browseJobId: context.jobId, documentToken: HNW_DOCUMENT_TOKEN } : {}),
      });
    }).catch(() => {});
  } catch {
    showReloadNotice();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'snapshot') return;
  sendResponse(HNW_SITE?.id === 'daangn' ? null : takeSnapshot());
});
