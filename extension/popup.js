// 아이콘을 누르면 뜨는 창. 사이트별 켜기/끄기, 지역(지도에 그릴 범위) 고르기, 바로가기 버튼('한 번에 열기' 포함).
const statusEl = document.getElementById('status');
const say = (text) => (statusEl.textContent = text);

async function render() {
  const { sites: toggles = {} } = await chrome.storage.local.get('sites');
  const list = document.getElementById('sites');
  list.textContent = '';
  for (const site of HNW_SITES) {
    const on = hnwEnabled(toggles, site);
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="site">
        <span class="name"></span>
        <span class="state"></span>
      </div>
      <label class="switch"><input type="checkbox" /><span class="track"></span></label>`;
    li.querySelector('.name').textContent = site.name;
    const state = li.querySelector('.state');
    state.textContent = site.ready ? '동그라미 새 N, 봤음 표시' : '데이터 모음';
    if (site.ready) state.classList.add('ready');
    const input = li.querySelector('input');
    input.checked = on;
    input.setAttribute('aria-label', `${site.name} 켜기`);
    input.addEventListener('change', async () => {
      const { sites: current = {} } = await chrome.storage.local.get('sites');
      await chrome.storage.local.set({ sites: { ...current, [site.id]: input.checked } });
      say(`${site.name}: ${input.checked ? '켰습니다' : '껐습니다'}. 그 사이트 탭을 새로고침하면 적용됩니다.`);
    });
    list.appendChild(li);
  }
}

const rangeBox = document.getElementById('show-range');
chrome.storage.local.get('hnw-show-range').then((v) => (rangeBox.checked = v['hnw-show-range'] !== false));
rangeBox.addEventListener('change', async () => {
  await chrome.storage.local.set({ 'hnw-show-range': rangeBox.checked });
  say(rangeBox.checked ? '지도에 지역 범위를 점선 원으로 표시합니다.' : '지도에서 지역 범위 표시를 껐습니다.');
});

// ---------- 지역 ----------
// 여기서 바꾼 지역은 확장에 저장되고, 대시보드가 켜져 있으면 대시보드 '지역' 탭과 맞춰진다(나중에 바꾼 쪽을 따름).

function radiusSelect(select, value) {
  select.textContent = '';
  for (const m of [...new Set([...HNW_RADII, value])].sort((a, b) => a - b)) {
    const option = document.createElement('option');
    option.value = String(m);
    option.textContent = hnwRadiusText(m);
    option.selected = m === value;
    select.appendChild(option);
  }
}

async function renderAreas() {
  const [areas, got] = await Promise.all([hnwReadAreas(), chrome.storage.local.get(['hnw-stations', 'hnw-areas-edited'])]);
  const list = document.getElementById('areas');
  list.textContent = '';
  areas.forEach((area, i) => {
    const li = document.createElement('li');
    li.className = area.enabled ? 'area' : 'area off';
    li.innerHTML = `
      <label class="switch small"><input type="checkbox" /><span class="track"></span></label>
      <span class="area-name"></span>
      <select class="radius"></select>
      <button class="icon" title="지우기">✕</button>`;
    li.querySelector('.area-name').textContent = area.name;
    const toggle = li.querySelector('input');
    toggle.checked = area.enabled;
    toggle.setAttribute('aria-label', `${area.name} 켜기`);
    toggle.addEventListener('change', () => void edit((l) => l.map((a, j) => (j === i ? { ...a, enabled: toggle.checked } : a)), `${area.name}: ${toggle.checked ? '켰습니다' : '껐습니다'}.`));
    const radius = li.querySelector('.radius');
    radius.setAttribute('aria-label', `${area.name} 반경`);
    radiusSelect(radius, area.radiusM);
    radius.addEventListener('change', () => void edit((l) => l.map((a, j) => (j === i ? { ...a, radiusM: Number(radius.value) } : a)), `${area.name}: 반경 ${hnwRadiusText(Number(radius.value))}`));
    li.querySelector('.icon').addEventListener('click', () => {
      if (!confirm(`${area.name} 지역을 지울까요? 잠깐 안 보이게만 하려면 스위치를 끄세요.`)) return;
      void edit((l) => l.filter((_, j) => j !== i), `${area.name} 지역을 지웠습니다.`);
    });
    list.appendChild(li);
  });
  document.getElementById('areas-empty').hidden = areas.length > 0;

  // 역으로 추가: 대시보드에서 받아 둔 역 목록 중 아직 없는 역
  const stations = (got['hnw-stations'] || []).filter((s) => !areas.some((a) => a.name === s.name));
  const box = document.getElementById('station-add');
  box.hidden = stations.length === 0;
  const select = document.getElementById('station');
  select.length = 1;
  for (const s of stations) {
    const option = document.createElement('option');
    option.value = s.name;
    option.textContent = s.label || s.name;
    select.appendChild(option);
  }
  document.getElementById('areas-sync').textContent = got['hnw-areas-edited']
    ? '확장에 저장했습니다. 대시보드가 켜지면 대시보드 지역 탭에도 맞춥니다.'
    : '대시보드가 켜져 있으면 대시보드 지역 탭과 같은 목록입니다.';
}

async function edit(change, message) {
  await hnwEditAreas(change);
  say(message);
  await renderAreas();
}

radiusSelect(document.getElementById('station-radius'), 1000);
document.getElementById('add-station').addEventListener('click', async () => {
  const name = document.getElementById('station').value;
  const { 'hnw-stations': stations = [] } = await chrome.storage.local.get('hnw-stations');
  const station = stations.find((s) => s.name === name);
  if (!station) return say('추가할 역을 고르세요.');
  const radiusM = Number(document.getElementById('station-radius').value);
  await edit((l) => [...l, { id: null, name: station.name, lat: station.lat, lng: station.lng, radiusM, enabled: true }], `${station.name} ${hnwRadiusText(radiusM)}를 추가했습니다.`);
});

// 네이버 지도 탭에 '찍기' 판을 깐다. 지도에서 누른 곳이 새 지역의 가운데가 된다.
document.getElementById('pick-area').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https:\/\/fin\.land\.naver\.com\/map/.test(tab.url || '')) {
    return say('네이버 부동산 지도 탭(fin.land.naver.com/map)을 띄운 채 눌러 주세요.');
  }
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'pick-area' }).catch(() => null);
  if (!res) return say('이 네이버 탭을 새로고침한 뒤 다시 눌러 주세요.');
  if (!res.ok) return say(res.error);
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes['hnw-area-list'] || changes['hnw-stations'])) {
    void renderAreas();
    void renderLinks();
  }
  if (area === 'local' && changes.sites) void renderLinks();
});
// 창을 열 때 대시보드와 한 번 맞춘다(대시보드에서 바꾼 것을 먼저 받아 오게).
chrome.runtime.sendMessage({ type: 'sync-areas' }).catch(() => {});
void renderAreas();

// ---------- 바로 가기 ----------
// 고른 지역(켜진 지역 중) 가운데로 지도 사이트를 연다. 지역이 없으면 네이버는 마지막으로 본 지도를 연다.
// '한 번에 열기'는 켜 둔 사이트를 새 창 하나에 연다(백그라운드가 연다, sites.js의 hnwOpenLinks).

/** 지금 고른 지역('한 번에 열기'에 넘김) */
let goArea = null;

async function renderLinks() {
  const [areas, got] = await Promise.all([hnwReadAreas(), chrome.storage.local.get(['hnw-stations', 'hnw-go-area', 'lastNaverUrl', 'sites'])]);
  const on = areas.filter((a) => a.enabled);
  const select = document.getElementById('go-area');
  select.textContent = '';
  for (const a of on) {
    const option = document.createElement('option');
    option.value = a.name;
    option.textContent = `${a.name} ${hnwRadiusText(a.radiusM)}`;
    select.appendChild(option);
  }
  select.hidden = on.length === 0;
  const area = on.find((a) => a.name === got['hnw-go-area']) || on[0] || null;
  if (area) select.value = area.name;
  goArea = area;

  const { open, rest } = hnwOpenLinks(area, got['hnw-stations'], got.sites);
  const names = (list) => list.map((l) => hnwShortName(l.name)).join(', ');
  const auto = rest.filter((l) => HNW_AUTO_SITES.includes(l.id));
  const off = rest.filter((l) => !HNW_AUTO_SITES.includes(l.id));
  const openAll = document.getElementById('open-all');
  openAll.textContent = open.length ? `켜 둔 ${open.length}곳 한 번에 열기` : '한 번에 열기';
  openAll.disabled = open.length === 0;
  document.getElementById('open-all-hint').textContent = [
    open.length ? `새 창 하나에 엽니다: ${names(open)}` : '켜 둔 사이트가 없습니다. 아래 사이트 목록에서 켜 주세요.',
    auto.length ? `안 열어도 되는 곳: ${names(auto)} ('조회하기'가 모음)` : '',
    off.length ? `꺼 둔 곳: ${names(off)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const box = document.getElementById('go-links');
  box.textContent = '';
  for (const link of hnwSiteLinks(area, got['hnw-stations'])) {
    const button = document.createElement('button');
    button.textContent = link.name;
    button.title = link.where;
    if (link.main) button.className = 'main';
    button.addEventListener('click', async () => {
      await chrome.tabs.create({ url: link.url || got.lastNaverUrl || HNW_NAVER_DEFAULT_URL });
      window.close();
    });
    box.appendChild(button);
  }
  const dashboard = document.createElement('button');
  dashboard.textContent = '대시보드';
  dashboard.title = '대시보드(localhost:8787)를 엽니다';
  dashboard.addEventListener('click', async () => {
    await chrome.tabs.create({ url: 'http://localhost:8787' });
    window.close();
  });
  box.appendChild(dashboard);
}

document.getElementById('open-all').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'open-sites', area: goArea }).catch(() => null);
  if (!res) return say('열지 못했습니다. 확장을 다시 불러온 뒤 눌러 주세요.');
  if (!res.ok) return say(res.error);
  window.close();
});

document.getElementById('go-area').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ 'hnw-go-area': e.target.value });
  await renderLinks();
});
void renderLinks();


// 지금 보고 있는 사이트의 화면 구조와 스크린샷을 대시보드로 보낸다.
document.getElementById('snapshot').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('보고 있는 탭을 찾지 못했습니다');
    const snap = await chrome.tabs.sendMessage(tab.id, { type: 'snapshot' }).catch(() => null);
    if (!snap) throw new Error('이 탭은 켜진 사이트가 아니거나 새로고침이 필요합니다');
    let screenshot = null;
    try {
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    } catch {
      /* 스크린샷을 못 찍으면 화면 구조만 보낸다 */
    }
    const res = await fetch('http://127.0.0.1:8787/api/naver/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...snap, kind: 'icon', screenshot }),
    });
    if (!res.ok) throw new Error(`대시보드 응답 ${res.status}`);
    say('지금 화면 구조를 보냈습니다.');
  } catch (e) {
    say(`못 보냈습니다: ${e.message}`);
  }
});

void render();
