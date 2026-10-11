// 확장 백그라운드.
// - 팝업에서 켠 사이트에만 사이트 안 스크립트(hook.js, bridge.js, naver.js)를 등록한다.
// - 사이트 화면이 받은 응답을 모아 로컬 대시보드 서버로 보낸다. 아이콘 숫자는 대시보드가 받은 수(빨간 !는 못 보냄).
//   대시보드가 꺼져 있으면 매물 목록 응답은 확장 저장소에 남겨 두었다가, 대시보드가 켜지면 보낸다.
// - 지역(역 반경): 팝업·지도에서 바꾼 목록을 확장에 두고, 대시보드가 켜져 있으면 서로 맞춘다(나중에 바꾼 쪽을 따름).
// - 대시보드 쪽 확장 파일의 버전이 바뀌면 스스로 다시 불러온다(열려 있던 사이트 탭은 새로고침해야 붙는다).
// - '한 번에 열기': 팝업·대시보드에서 누르면 켜 둔 사이트를 새 창 하나에 연다.

importScripts('sites.js', 'areas.js');

const SERVER = 'http://127.0.0.1:8787';
const BATCH = 20;
/** 대시보드가 꺼져 있을 때 못 보낸 매물 목록 응답을 담아 두는 저장소 키 앞부분. 오래된 것부터 보낸다. */
const PENDING = 'pending:';
const MAX_PENDING = 300;
let queue = [];
let flushing = false;
let sendingPending = false;

// ---------- 켠 사이트에만 스크립트 등록 ----------

async function registerSiteScripts() {
  const { sites: toggles = {} } = await chrome.storage.local.get('sites');
  const matches = HNW_SITES.filter((s) => hnwEnabled(toggles, s)).flatMap((s) => s.matches);
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([
    { id: 'hnw-hook', matches, js: ['hook.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
    { id: 'hnw-bridge', matches, js: ['sites.js', 'areas.js', 'bridge.js', 'naver.js'], runAt: 'document_start', persistAcrossSessions: true },
  ]);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sites) void registerSiteScripts();
});

// ---------- 대시보드로 보내기 ----------

async function setBadge(text, color, title) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title });
}

async function postJson(path, payload, method = 'POST') {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

/** 대시보드가 받아 놓고 거절한 경우(4xx). 다시 보내도 안 되므로 모아 두지 않는다. */
const rejected = (e) => e && e.status >= 400 && e.status < 500;

async function showTotal(total) {
  const n = Number(total) || 0;
  await setBadge(n > 999 ? '999+' : String(n), '#12825e', `회사근처 내집마련: 화면 데이터 ${n}건을 대시보드로 보냈습니다`);
}

/** 매물 목록 응답(네이버 .../clusteredArticles 등). 대시보드의 매물·'봤음'이 이것으로 만들어진다. */
function isListing(capture) {
  try {
    return /Articles$/.test(new URL(capture.url).pathname);
  } catch {
    return false;
  }
}

async function pendingKeys() {
  const keys = chrome.storage.local.getKeys ? await chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null));
  return keys.filter((k) => k.startsWith(PENDING)).sort();
}

/** 못 보낸 매물 목록 응답을 하나씩 따로 저장한다(서비스 워커가 잠들어도 남는다). 너무 쌓이면 오래된 것부터 버린다. */
async function savePending(captures) {
  if (!captures.length) return;
  const now = Date.now();
  const items = {};
  captures.forEach((c, i) => {
    items[`${PENDING}${now}:${String(i).padStart(3, '0')}`] = c;
  });
  await chrome.storage.local.set(items);
  const keys = await pendingKeys();
  if (keys.length > MAX_PENDING) await chrome.storage.local.remove(keys.slice(0, keys.length - MAX_PENDING));
}

/** 저장해 둔 응답을 오래된 것부터 보낸다. 대시보드가 아직 꺼져 있으면 다음에 다시 한다. */
async function flushPending() {
  if (sendingPending) return;
  sendingPending = true;
  try {
    for (;;) {
      const keys = (await pendingKeys()).slice(0, BATCH);
      if (!keys.length) break;
      const stored = await chrome.storage.local.get(keys);
      const data = await postJson('/api/naver/capture', { captures: keys.map((k) => stored[k]).filter(Boolean) });
      await chrome.storage.local.remove(keys);
      await showTotal(data.total);
    }
  } catch (e) {
    // 대시보드가 아직 꺼져 있으면 다음에 다시 한다. 거절당한 묶음은 버린다(계속 막히지 않게).
    if (rejected(e)) await chrome.storage.local.remove((await pendingKeys()).slice(0, BATCH));
  } finally {
    sendingPending = false;
  }
}

async function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, BATCH);
  let sent = false;
  try {
    const data = await postJson('/api/naver/capture', { captures: batch });
    sent = true;
    await showTotal(data.total);
  } catch (e) {
    // 대시보드가 꺼져 있으면 매물 목록 응답은 저장해 두고(켜지면 보냄), 나머지(지도 묶음 등)는 조금만 들고 있다가 다음에 같이 보낸다.
    // 지도 표시('새 N', 봤음)는 대시보드 없이도 된다.
    if (!rejected(e)) {
      await savePending(batch.filter(isListing)).catch(() => {});
      queue = batch.filter((c) => !isListing(c)).concat(queue).slice(-200);
    }
    await setBadge('!', '#e5484d', `회사근처 내집마련: 대시보드가 꺼져 있어 못 보냈습니다(${e.message}). 매물 목록은 모아 뒀다가 켜지면 보냅니다. 지도 표시는 그대로 됩니다.`);
  } finally {
    flushing = false;
    if (sent) {
      if (queue.length) setTimeout(flush, 1000);
      void flushPending();
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  if (message.type === 'open-sites') {
    openSites(message.area).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.type === 'sync-areas') {
    void syncAreas();
    return;
  }
  if (message.type === 'auto-snapshot') {
    void postJson('/api/naver/snapshot', message.snapshot).catch(() => {});
    return;
  }
  if (message.type !== 'capture') return;
  queue.push(message.capture);
  setTimeout(flush, 800);
  const pageUrl = message.capture && message.capture.pageUrl;
  if (typeof pageUrl === 'string' && pageUrl.startsWith('https://fin.land.naver.com/map')) {
    void chrome.storage.local.set({ lastNaverUrl: pageUrl });
  }
});

// ---------- 한 번에 열기 ----------
// 팝업·대시보드의 '한 번에 열기'를 누르면 켜 둔 사이트의 바로 가기를 새 창 하나에 연다(sites.js의 hnwOpenLinks).
// 대시보드는 웹 페이지라 창을 여러 개 한꺼번에 열 수 없어서(팝업 차단) dashboard.js를 거쳐 여기로 온다.

let lastOpenAt = 0;

/** 넘어온 지역은 모양만 확인한다(한국 좌표 범위). 아니면 지역 없이(네이버는 마지막으로 본 지도) 연다. */
function areaFrom(input) {
  if (!input || typeof input !== 'object') return null;
  const { name, lat, lng, radiusM } = input;
  if (![lat, lng, radiusM].every(Number.isFinite) || lat < 33 || lat > 39 || lng < 124 || lng > 132) return null;
  return { name: String(name ?? '').slice(0, 40), lat, lng, radiusM };
}

async function openSites(input) {
  // 두 번 눌러도 창이 두 개 뜨지 않게
  if (Date.now() - lastOpenAt < 3000) return { ok: false, error: '방금 열었습니다. 새 창을 확인해 주세요.' };
  const got = await chrome.storage.local.get(['sites', 'hnw-stations', 'lastNaverUrl']);
  const { open } = hnwOpenLinks(areaFrom(input), got['hnw-stations'], got.sites);
  if (!open.length) return { ok: false, error: '켜 둔 사이트가 없습니다. 확장 아이콘을 눌러 사이트를 켜 주세요.' };
  lastOpenAt = Date.now();
  await chrome.windows.create({ url: open.map((l) => l.url || got.lastNaverUrl || HNW_NAVER_DEFAULT_URL), focused: true });
  return { ok: true, names: open.map((l) => l.name) };
}

// ---------- 지역(범위) ----------
// 팝업·지도에서 바꾼 목록은 확장에 두고(areas.js), 대시보드가 켜져 있으면 서로 맞춘다. 대시보드가 없어도 확장 목록으로 그린다.

let syncingAreas = false;

/** 확장과 대시보드의 지역을 맞춘다. 확장에서 대시보드보다 나중에 바꿨으면 보내고, 아니면 대시보드 것을 받는다. */
async function syncAreas() {
  if (syncingAreas) return;
  syncingAreas = true;
  try {
    let state;
    try {
      state = await (await fetch(`${SERVER}/api/state`)).json();
    } catch {
      return; // 대시보드가 꺼져 있으면 확장에 둔 목록을 그대로 쓴다.
    }
    if (Array.isArray(state.stations)) {
      await chrome.storage.local.set({
        'hnw-stations': state.stations.map(({ name, label, lat, lng, zigbangId, hogangnonoApt }) => ({ name, label, lat, lng, zigbangId, hogangnonoApt })),
      });
    }
    const got = await chrome.storage.local.get(['hnw-area-list', 'hnw-areas-edited']);
    const edited = got['hnw-areas-edited'];
    let next = state.areas || [];
    if (edited && Array.isArray(got['hnw-area-list']) && (!state.areasUpdatedAt || edited > state.areasUpdatedAt)) {
      try {
        const data = await postJson('/api/areas', { areas: got['hnw-area-list'] }, 'PUT');
        next = data.areas;
      } catch (e) {
        if (!rejected(e)) return; // 잠깐 못 보냈으면 다음에 다시 보낸다.
        // 대시보드가 거절한 목록이면 대시보드 것을 따른다(계속 막히지 않게).
      }
    }
    // 그사이 팝업에서 또 바꿨으면 덮어쓰지 않고 다음에 다시 맞춘다.
    const now = await chrome.storage.local.get('hnw-areas-edited');
    if (now['hnw-areas-edited'] !== edited) {
      setTimeout(() => void syncAreas(), 500);
      return;
    }
    await hnwWriteAreas(next, null);
  } finally {
    syncingAreas = false;
  }
}

/** 예전 저장 형식(켜진 지역만)이면 목록으로 옮긴다. */
async function migrateAreas() {
  const got = await chrome.storage.local.get(['hnw-area-list', 'hnw-areas']);
  if (!Array.isArray(got['hnw-area-list']) && Array.isArray(got['hnw-areas'])) await hnwWriteAreas(got['hnw-areas'], null);
}

// ---------- 새 버전 확인 ----------

async function checkVersion() {
  try {
    const res = await fetch(`${SERVER}/api/extension/version?v=${chrome.runtime.getManifest().version}`);
    const { version } = await res.json();
    if (version && version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch {
    /* 대시보드가 꺼져 있으면 다음에 본다 */
  }
}

async function start() {
  chrome.alarms.create('hnw-version', { periodInMinutes: 1 });
  await registerSiteScripts();
  await migrateAreas();
  await syncAreas();
  await flushPending();
}

chrome.runtime.onInstalled.addListener(() => void start());
chrome.runtime.onStartup.addListener(() => void start());
// 서비스 워커가 뜰 때마다(새 버전으로 다시 불러온 직후 포함) 버전을 바로 알린다. 대시보드가 이것으로 확장이 최신인지 안다.
void checkVersion();
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'hnw-version') return;
  void checkVersion();
  void syncAreas();
  // 대시보드가 다시 켜졌으면 모아 둔 것을 보낸다.
  void flush();
  void flushPending();
});
