// 대시보드(localhost:8787) 안에서만 돈다. 웹 페이지는 창을 여러 개 한꺼번에 열 수 없어서(팝업 차단),
// 대시보드의 '한 번에 열기'를 확장 백그라운드로 넘긴다.
//   대시보드 → { source: 'hnw-dashboard', type: 'ping' | 'open-sites', area }
//   확장     → { source: 'hnw-extension', type: 'hello', version, sites } / { type: 'opened', ok, names | error }

function hnwToPage(message) {
  window.postMessage({ source: 'hnw-extension', ...message }, location.origin);
}

const HNW_BROWSE_RECONNECT = '순차 조회 백그라운드와 연결되지 않았습니다. 대시보드를 새로고침해 주세요. 계속되면 chrome://extensions에서 이 확장의 새로고침(↻)을 누른 뒤 대시보드도 새로고침해 주세요.';

async function hnwBrowseRequest(message) {
  let timer;
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10000); }),
    ]);
    // 예전 워커는 모르는 메시지에 undefined로 답한다. 설치 여부와 기능 준비 상태를 구분한다.
    if (!res || typeof res !== 'object' || (!Object.hasOwn(res, 'state') && typeof res.error !== 'string')) return { error: HNW_BROWSE_RECONNECT };
    return res;
  } catch {
    return { error: HNW_BROWSE_RECONNECT };
  } finally {
    clearTimeout(timer);
  }
}

/** 확장이 있다는 것과 켜 둔 사이트를 알려 준다(대시보드 버튼에 'N곳'). */
async function hnwHello() {
  try {
    const { sites: toggles = {} } = await chrome.storage.local.get('sites');
    const result = await hnwBrowseRequest({ type: 'browse-status' });
    const browse = Object.hasOwn(result, 'state') && !result.error;
    hnwToPage({ type: 'hello', browse, browseError: result.error, version: chrome.runtime.getManifest().version, sites: HNW_SITES.filter((s) => hnwEnabled(toggles, s)).map((s) => s.id) });
    hnwToPage({ type: 'browse-status', ...result });
  } catch {
    /* 확장이 새 버전으로 바뀌면 이 페이지의 스크립트는 끊긴다(새로고침하면 다시 붙음). */
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin || !e.data || e.data.source !== 'hnw-dashboard') return;
  if (e.data.type === 'ping') void hnwHello();
  if (['browse-command', 'browse-status'].includes(e.data.type)) {
    const { type, command, areas, sites } = e.data;
    const requestId = typeof e.data.requestId === 'string' && e.data.requestId.length <= 120 ? e.data.requestId : undefined;
    void hnwBrowseRequest({ type, command, areas, sites }).then((res) => hnwToPage({ type: 'browse-status', requestId, requestType: type, ...res }));
    return;
  }
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
  if (area === 'local' && changes['hnw-browse-state']) {
    hnwToPage({ type: 'browse-status', state: changes['hnw-browse-state'].newValue ?? null });
  }
});
void hnwHello();
