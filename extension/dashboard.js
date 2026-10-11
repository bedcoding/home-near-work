// 대시보드(localhost:8787) 안에서만 돈다. 웹 페이지는 창을 여러 개 한꺼번에 열 수 없어서(팝업 차단),
// 대시보드의 '한 번에 열기'를 확장 백그라운드로 넘긴다.
//   대시보드 → { source: 'hnw-dashboard', type: 'ping' | 'open-sites', area }
//   확장     → { source: 'hnw-extension', type: 'hello', version, sites } / { type: 'opened', ok, names | error }

function hnwToPage(message) {
  window.postMessage({ source: 'hnw-extension', ...message }, location.origin);
}

/** 확장이 있다는 것과 켜 둔 사이트를 알려 준다(대시보드 버튼에 'N곳'). */
async function hnwHello() {
  try {
    const { sites: toggles = {} } = await chrome.storage.local.get('sites');
    hnwToPage({ type: 'hello', version: chrome.runtime.getManifest().version, sites: HNW_SITES.filter((s) => hnwEnabled(toggles, s)).map((s) => s.id) });
  } catch {
    /* 확장이 새 버전으로 바뀌면 이 페이지의 스크립트는 끊긴다(새로고침하면 다시 붙음). */
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.source !== 'hnw-dashboard') return;
  if (e.data.type === 'ping') void hnwHello();
  if (e.data.type !== 'open-sites') return;
  const fail = (error) => hnwToPage({ type: 'opened', ok: false, error });
  let sent;
  try {
    sent = chrome.runtime.sendMessage({ type: 'open-sites', area: e.data.area ?? null });
  } catch (err) {
    // 확장을 다시 불러오면 이 페이지에 붙어 있던 스크립트는 끊긴다.
    fail(`크롬 확장과 연결이 끊겼습니다. 이 페이지를 새로고침한 뒤 다시 눌러 주세요. (${err && err.message})`);
    return;
  }
  sent.then(
    (res) => (res ? hnwToPage({ type: 'opened', ...res }) : fail('크롬 확장 백그라운드가 답하지 않았습니다. chrome://extensions에서 이 확장의 새로고침(↻)을 눌러 주세요.')),
    (err) => fail(`크롬 확장 백그라운드에 닿지 못했습니다. chrome://extensions에서 이 확장의 새로고침(↻)을 눌러 주세요. (${err && err.message})`),
  );
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sites) void hnwHello();
});
void hnwHello();
