// 확장 쪽(ISOLATED world)에서 돈다. hook.js가 넘긴 응답을
// 1) 백그라운드로 보내 대시보드에 쌓고 2) 그 사이트용 표시 스크립트(naver.js 등)에 넘긴다.
// 아이콘 팝업에서 '화면 구조 보내기'를 누르면 지금 화면 구조(HTML)를 돌려준다.
// 확장이 새 버전으로 바뀌어 이 탭과 연결이 끊겼을 때는 새로고침 안내를 띄운다.

const HNW_SITE = hnwSiteFor(location.hostname);
/** 사이트별 표시 스크립트가 여기에 자기를 등록한다: HNW_ADAPTERS[siteId] = { onCapture(capture) } */
const HNW_ADAPTERS = {};

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
// 네이버는 지도 묶음·묶음 목록을 받을 때, 다른 사이트는 아무 데이터나 처음 받을 때. 종류마다 10분에 한 번까지만.
const lastAutoSnapshot = {};

function snapshotKind(url) {
  let name = '';
  try {
    name = new URL(url).pathname.split('/').pop();
  } catch {
    return null;
  }
  if (!HNW_SITE) return null;
  if (HNW_SITE.id === 'naver') return { articleClusters: 'map', clusteredArticles: 'list' }[name] || null;
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
  const { url, method, status, requestBody, body } = event.data;
  const capture = { at: new Date().toISOString(), site: HNW_SITE ? HNW_SITE.id : null, pageUrl: location.href, url, method, status, requestBody, body };
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
    chrome.runtime.sendMessage({ type: 'capture', capture }).catch(() => {});
    maybeAutoSnapshot(url);
  } catch {
    showReloadNotice();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'snapshot') return;
  sendResponse(takeSnapshot());
});
