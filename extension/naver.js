// 네이버 부동산 지도의 동그라미(매물 묶음)에 '새 N'과 '봤음'을 붙인다.
// - 지도를 열거나 움직이면 화면이 묶음 목록(articleClusters: 묶음 번호, 좌표, 매물 수)을 받는다. 묶음마다 그 수를 기준으로 저장한다(누르지 않아도).
//   처음 보는 묶음은 지금 수가 기준이다. 전에 본 지도 범위 안이었는데 그때 없던 묶음(매물이 없던 칸)은 기준이 0이다.
// - 다음에 볼 때 수가 기준보다 많으면 빨간 '새 N'이고, 누를 때까지 그대로 둔다. 기준보다 적으면 기준을 낮춘다(다시 늘면 '새'로 보이게).
// - 동그라미를 누르면 화면이 그 묶음의 매물 목록(clusteredArticles)을 받는다. 그때 수가 기준이 되고 '봤음'(흐리게)이 붙는다.
// - 묶음 번호는 지도 타일 번호(확대/x/y)다. 큰 묶음을 누르면 그 안의 작은 묶음은 다음에 볼 때 그때 수로 기준을 다시 잡고,
//   작은 묶음을 누르면 그 묶음을 품은 큰 묶음의 기준을 늘어난 만큼 올린다(다른 확대에서 이미 본 매물이 '새'로 남지 않게).
// - 기록은 확장 저장소(chrome.storage.local)에 남아서, 대시보드를 켜지 않아도 표시된다. 검색 조건(filter)이 다르면 따로 기록한다.
// - 지역(역 반경, 확장 팝업이나 대시보드에서 정함)을 지도 위에 점선 원으로 그린다('어디까지 볼지' 범위).
// - 팝업에서 '네이버 지도에서 찍어 추가'를 누르면, 지도에서 누른 곳을 새 지역으로 추가한다.
//
// 네이버 화면 구조:
//   div#main_map.mapboxgl-map > … > div.mapboxgl-canvas-container > (canvas, 표시 층들)
//   표시 층 > div[style=position:absolute; transform:translate3d(x,y)] > div.marker-root > div > div.…wrapper(clip-path: circle)
//     > button.BubbleMarker-…(aria-checked: 누른 동그라미면 true)  "63" + <span class="blind">개의 매물</span>
//   wrapper가 원 모양으로 잘려서, 글자 표시는 위치 요소(translate3d div)에 붙인다.
(() => {
  if (!HNW_SITE || HNW_SITE.id !== 'naver') return;

  const KEY = 'seen:naver';
  const VIEWS = 'seen:naver:views';
  const BY = 'seen:naver:by';
  /** 검색 조건마다 남기는 본 지도 범위 수(오래된 것부터 버림) */
  const VIEWS_MAX = 1000;
  const BUBBLE = 'button[data-nlogs-area="pin*art.bubble"], button[class*="BubbleMarker"]';
  let areas = []; // 지도에 그릴 켜진 지역 [{ name, lat, lng, radiusM }]
  let showRange = true;
  // 필터 → 묶음 번호 → { count: 기준 매물 수, numbers?: 눌렀을 때 받은 매물 번호, at, auto?: 누르지 않고 잡은 기준, sync?: 다음에 볼 때 그때 수로 기준을 다시 잡음 }
  let seen = {};
  let views = {}; // 필터 → 본 지도 범위 [[확대, x0, y0, x1, y1]](타일 번호)
  let loaded = false; // 저장된 기록을 읽었는지(읽기 전에 쓰면 기록을 덮으므로 그때 온 응답은 waiting에 둠)
  const waiting = [];
  const me = `${Date.now()}-${Math.random()}`; // 이 탭이 쓴 기록인지 알아보는 표
  let writes = 0;
  let sig = null; // 지금 지도 필터
  let clusters = []; // 마지막으로 받은 지도 묶음 [{ id, lon, lat, count }]
  let lastDown = null; // 마지막으로 누른 곳
  const known = new Map(); // 묶음 번호 → 동그라미 버튼(방금 누른 것 등)
  let timer = null;

  const NS = 'http://www.w3.org/2000/svg';
  const style = document.createElement('style');
  style.textContent = `
    [data-hnw-seen="seen"] { filter: grayscale(1) opacity(.55) !important; }
    .hnw-mark { position: absolute; left: 0; transform: translateX(-50%); z-index: 5; pointer-events: none; }
    .hnw-mark::before {
      content: attr(data-t); display: block; padding: 1px 7px; border-radius: 9px; white-space: nowrap;
      font: 700 12px/1.4 "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; color: #fff; background: #16202e;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
    }
    .hnw-mark.new::before { background: #e5484d; }
    .hnw-range { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; }
    .hnw-range circle { fill: rgba(31, 95, 191, .06); stroke: #1f5fbf; stroke-width: 2; stroke-dasharray: 8 6; }
    .hnw-range text { font: 700 13px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; fill: #1f5fbf; paint-order: stroke; stroke: #fff; stroke-width: 4px; }
    .hnw-pick { position: fixed; z-index: 2147483646; cursor: crosshair; background: rgba(31, 95, 191, .05); }
    .hnw-pick svg { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; }
    .hnw-pick svg circle.area { fill: rgba(31, 95, 191, .1); stroke: #1f5fbf; stroke-width: 2; stroke-dasharray: 8 6; }
    .hnw-pick svg circle.dot { fill: #1f5fbf; }
    .hnw-pick-tip {
      position: absolute; left: 50%; top: 14px; transform: translateX(-50%); padding: 8px 14px; border-radius: 10px;
      background: rgba(22, 32, 46, .92); color: #fff; font: 700 14px/1.4 "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
      white-space: nowrap; pointer-events: none;
    }
    .hnw-pick-form {
      position: absolute; display: grid; gap: 8px; width: 300px; padding: 12px; border-radius: 12px; background: #fff; color: #16202e;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .28); font: 14px/1.5 "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; cursor: default;
    }
    .hnw-pick-form .t { font-weight: 700; }
    .hnw-pick-form .row { display: flex; gap: 6px; align-items: center; }
    .hnw-pick-form input, .hnw-pick-form select {
      height: 36px; padding: 0 8px; border: 1px solid #c9d0d8; border-radius: 8px; background: #fff; color: #16202e; font: inherit;
    }
    .hnw-pick-form input { flex: 1; min-width: 0; }
    .hnw-pick-form button {
      height: 38px; padding: 0 14px; border: 1px solid #c9d0d8; border-radius: 8px; background: #fff; color: #16202e;
      font: inherit; font-weight: 700; cursor: pointer;
    }
    .hnw-pick-form button.primary { background: #16202e; border-color: #16202e; color: #fff; }
  `;
  (document.head || document.documentElement).appendChild(style);

  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const pathName = (url) => {
    try {
      return new URL(url).pathname.split('/').pop();
    } catch {
      return '';
    }
  };
  /** 검색 조건 서명: '거래 유형|매물 종류'. 그 밖에 고른 조건(빈 목록, false, 빈 값이 아닌 것)이 있으면 '|이름=값'으로 뒤에 붙인다. */
  const filterSig = (filter) => {
    if (!filter) return null;
    const { tradeTypes, realEstateTypes, ...rest } = filter;
    const sorted = (v) => (Array.isArray(v) ? [...v].sort() : v);
    const extra = Object.keys(rest)
      .filter((k) => (Array.isArray(rest[k]) ? rest[k].length > 0 : rest[k] != null && rest[k] !== false && rest[k] !== ''))
      .sort()
      .map((k) => `${k}=${JSON.stringify(sorted(rest[k]))}`);
    return [`${sorted(tradeTypes || [])}`, `${sorted(realEstateTypes || [])}`, ...extra].join('|');
  };
  const save = () => {
    if (!loaded || !(chrome.runtime && chrome.runtime.id)) return;
    writes += 1;
    chrome.storage.local.set({ [KEY]: seen, [VIEWS]: views, [BY]: `${me}:${writes}` }).catch(() => {});
  };

  chrome.storage.local
    .get([KEY, VIEWS, 'hnw-areas', 'hnw-show-range'])
    .then((v) => {
      seen = v[KEY] || {};
      views = v[VIEWS] || {};
      areas = v['hnw-areas'] || [];
      showRange = v['hnw-show-range'] !== false;
      loaded = true;
      for (const c of waiting.splice(0)) onCapture(c);
      schedule(0);
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // 이 탭이 쓴 기록은 이미 들고 있으므로 다시 읽지 않는다(그 사이 바뀐 것을 덮지 않게).
    const mine = String(changes[BY]?.newValue ?? '').startsWith(`${me}:`);
    const other = !mine && !!(changes[KEY] || changes[VIEWS]);
    if (other && changes[KEY]) seen = changes[KEY].newValue || {};
    if (other && changes[VIEWS]) views = changes[VIEWS].newValue || {};
    if (changes['hnw-areas']) areas = changes['hnw-areas'].newValue || [];
    if (changes['hnw-show-range']) showRange = changes['hnw-show-range'].newValue !== false;
    if (other || changes['hnw-areas'] || changes['hnw-show-range']) schedule(0);
  });

  document.addEventListener('pointerdown', (e) => (lastDown = { el: e.target, t: Date.now() }), true);

  /** 동그라미 버튼에 적힌 매물 수(첫 글자 노드). */
  const bubbleCount = (button) => {
    const text = button.firstChild && button.firstChild.nodeType === Node.TEXT_NODE ? button.firstChild.nodeValue : button.textContent;
    const m = /\d+/.exec(text || '');
    return m ? Number(m[0]) : null;
  };

  function onCapture(c) {
    if (!loaded) {
      if (waiting.length < 100) waiting.push(c);
      return;
    }
    const name = pathName(c.url);
    const req = parse(c.requestBody || '');
    if (name === 'articleClusters') {
      const list = parse(c.body)?.result?.clusters;
      if (!Array.isArray(list)) return;
      const own = filterSig(req?.filter);
      sig = own ?? sig;
      clusters = list
        .map((x) => ({ id: x.clusterId, lon: x.coordinates?.xCoordinate, lat: x.coordinates?.yCoordinate, count: x.articleCount }))
        .filter((x) => typeof x.id === 'string' && Number.isFinite(x.lon) && Number.isFinite(x.lat));
      if (own) baseline(own, req, list);
      schedule(400);
    } else if (name === 'clusteredArticles') {
      const id = req?.clusterId;
      const result = parse(c.body)?.result;
      const key = filterSig(req?.filter) ?? sig;
      if (!id || !key || !result || !Array.isArray(result.list)) return;
      // 지도 묶음 요청에서 필터를 못 읽었으면 동그라미 요청의 필터를 쓴다.
      if (!sig) sig = key;
      const numbers = [];
      for (const item of result.list) {
        const rep = item.representativeArticleInfo;
        if (rep?.articleNumber) numbers.push(String(rep.articleNumber));
        for (const a of item.duplicatedArticleInfo?.articleInfoList || []) numbers.push(String(a.articleNumber));
      }
      // 목록을 더 내려 이어 받은 쪽이면(lastInfo가 있음) 앞서 받은 번호에 더한다.
      const nextPage = (req?.articlePagingRequest?.lastInfo || []).length > 0;
      const bySig = (seen[key] = seen[key] || {});
      const prev = bySig[id];
      const count = Number.isFinite(result.totalCount) ? result.totalCount : result.list.length;
      if (!nextPage) seenThrough(bySig, id, prev && !prev.sync ? count - prev.count : 0);
      bySig[id] = { count, numbers: [...new Set([...(nextPage && prev ? prev.numbers || [] : []), ...numbers])], at: Date.now() };
      save();
      // 방금 누른 동그라미(네이버가 aria-checked=true로 표시)에 바로 붙인다. 지도 좌표로 못 찾을 때 대비.
      const selected = document.querySelector(`${BUBBLE.split(',')[0]}[aria-checked="true"], button[class*="BubbleMarker"][aria-checked="true"]`);
      const clicked = selected || (lastDown && Date.now() - lastDown.t < 8000 && lastDown.el instanceof Element ? lastDown.el.closest(BUBBLE) : null);
      if (clicked) known.set(id, clicked);
      schedule(50);
    }
  }
  HNW_ADAPTERS.naver = { onCapture };

  /** 화면의 동그라미들과 위치(가운데), 매물 수. */
  function bubbles() {
    const out = [];
    for (const button of document.querySelectorAll(BUBBLE)) {
      const n = bubbleCount(button);
      const r = button.getBoundingClientRect();
      if (n == null || r.width < 8) continue;
      out.push({ el: button, x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height, n });
    }
    return out;
  }

  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const latOf = (m) => ((2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180) / Math.PI;

  function linfit(points) {
    const n = points.length;
    const mx = points.reduce((s, p) => s + p[0], 0) / n;
    const my = points.reduce((s, p) => s + p[1], 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (const [x, y] of points) {
      sxx += (x - mx) * (x - mx);
      sxy += (x - mx) * (y - my);
    }
    if (sxx === 0) return null;
    const a = sxy / sxx;
    return { a, b: my - a * mx };
  }

  /**
   * 묶음 좌표 → 화면 위치 변환을 구한다. 매물 수가 하나뿐인 묶음과 같은 숫자의 동그라미가 하나뿐이면 짝으로 보고,
   * 그 짝들로 직선 맞춤을 한다(가로는 경도, 세로는 메르카토르 위도). 어긋난 짝은 한 번 걸러 낸다.
   */
  function projection(cands) {
    const byCount = new Map();
    for (const c of cands) byCount.set(c.n, [...(byCount.get(c.n) || []), c]);
    const clByCount = new Map();
    for (const cl of clusters) clByCount.set(cl.count, [...(clByCount.get(cl.count) || []), cl]);
    let pairs = [];
    for (const [n, cls] of clByCount) {
      const cs = byCount.get(n);
      if (cls.length === 1 && cs && cs.length === 1) pairs.push([cls[0], cs[0]]);
    }
    for (let round = 0; round < 2; round += 1) {
      if (pairs.length < 3) return null;
      const fx = linfit(pairs.map(([g, c]) => [g.lon, c.x]));
      const fy = linfit(pairs.map(([g, c]) => [mercY(g.lat), c.y]));
      if (!fx || !fy || fx.a <= 0 || fy.a >= 0) return null;
      const at = (g) => ({ x: fx.a * g.lon + fx.b, y: fy.a * mercY(g.lat) + fy.b });
      const err = ([g, c]) => {
        const p = at(g);
        return Math.hypot(p.x - c.x, p.y - c.y);
      };
      const good = pairs.filter((p) => err(p) < 20);
      if (good.length === pairs.length || round === 1) {
        if (good.length < 3 || good.length < pairs.length * 0.6) return null;
        // 경도 1도가 화면에서 몇 px인지(반경을 px로 바꿀 때 씀). from은 반대로 화면 위치 → 좌표(지도에서 찍을 때 씀).
        return { at, pxPerLon: fx.a, from: (x, y) => ({ lon: (x - fx.b) / fx.a, lat: latOf((y - fy.b) / fy.a) }) };
      }
      pairs = good;
    }
    return null;
  }

  /** 켜진 지역을 지도 그림 바로 위(동그라미 아래)에 점선 원으로 그린다. 옆 목록 창을 가리지 않는다. */
  function drawRange(proj) {
    document.querySelectorAll('.hnw-range').forEach((n) => n.remove());
    if (!showRange || !areas.length || !proj) return;
    const box = document.querySelector('#main_map .mapboxgl-canvas-container') || document.querySelector('.mapboxgl-canvas-container');
    if (!box) return;
    const r = box.getBoundingClientRect();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'hnw-range');
    svg.setAttribute('width', String(r.width));
    svg.setAttribute('height', String(r.height));
    for (const a of areas) {
      const p = proj.at({ lon: a.lng, lat: a.lat });
      // 메르카토르 지도에서는 그 위도에서 경도 1도 = 111,320m × cos(위도)
      const radius = (a.radiusM / (111320 * Math.cos((a.lat * Math.PI) / 180))) * proj.pxPerLon;
      const cx = p.x - r.left;
      const cy = p.y - r.top;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(radius));
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(cx));
      label.setAttribute('y', String(Math.max(cy - radius - 6, 16)));
      label.setAttribute('text-anchor', 'middle');
      label.textContent = `${a.name} ${a.radiusM >= 1000 ? `${a.radiusM / 1000}km` : `${a.radiusM}m`}`;
      svg.append(circle, label);
    }
    // 지도 그림(canvas) 바로 다음에 넣어서, 동그라미와 단지 표시보다 아래에 그려지게 한다.
    const canvas = box.querySelector(':scope > canvas');
    if (canvas && canvas.nextSibling) box.insertBefore(svg, canvas.nextSibling);
    else box.appendChild(svg);
  }

  const tileOf = (id) => id.split('/').map(Number);
  /** 경도, 위도가 든 확대 z 타일의 x, y 번호 */
  const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const tileY = (lat, z) => Math.floor(((1 - mercY(lat) / Math.PI) / 2) * 2 ** z);
  const inBox = (b, [z, x, y]) => b[0] === z && x >= b[1] && x <= b[3] && y >= b[2] && y <= b[4];

  /** 지도 범위(boundingBox: left, right, top, bottom)가 걸친 확대 z 타일 범위 [z, x0, y0, x1, y1]. 모르면 null. */
  function tileBox(bb, z) {
    const e = 1e-7;
    if (!bb || !Number.isInteger(z) || ![bb.left, bb.right, bb.top, bb.bottom].every(Number.isFinite)) return null;
    const box = [z, tileX(bb.left + e, z), tileY(bb.top - e, z), tileX(bb.right - e, z), tileY(bb.bottom + e, z)];
    return box[1] <= box[3] && box[2] <= box[4] ? box : null;
  }

  /**
   * 지도 묶음 목록(articleClusters) 하나로 기준을 맞춘다. key: 그 요청의 검색 조건 서명, list: 응답의 clusters.
   * 처음 보는 묶음은 지금 수(전에 본 범위 안이었으면 0), 기준보다 적거나 다시 잡을 묶음(sync)은 지금 수로 바꾼다.
   * 요청한 지도 범위 안인데 목록에 없는 묶음은 매물이 없는 것이라 기준을 0으로 하고, 그 범위를 본 범위로 남긴다.
   * 묶음 타일 확대는 묶음 번호에서, 묶음이 없으면 요청의 precision(지도 확대)에 2를 더해 정한다.
   */
  function baseline(key, req, list) {
    const counts = list.filter((x) => typeof x?.clusterId === 'string' && Number.isFinite(x?.articleCount));
    const bySig = (seen[key] = seen[key] || {});
    const before = views[key] || [];
    const z = counts.length ? tileOf(counts[0].clusterId)[0] : Number.isFinite(req?.precision) ? Math.floor(req.precision) + 2 : null;
    // 읽지 못한 묶음이 섞였으면 빈 칸을 가려낼 수 없어 범위는 쓰지 않는다.
    const box = counts.length === list.length ? tileBox(req?.boundingBox, z) : null;
    const now = Date.now();
    let changed = false;
    const ids = new Set();
    for (const x of counts) {
      ids.add(x.clusterId);
      const rec = bySig[x.clusterId];
      if (!rec) {
        const t = tileOf(x.clusterId);
        bySig[x.clusterId] = { count: before.some((b) => inBox(b, t)) ? 0 : x.articleCount, at: now, auto: true };
        changed = true;
      } else if (rec.sync || x.articleCount < rec.count) {
        rec.count = x.articleCount;
        delete rec.sync;
        changed = true;
      }
    }
    if (box) {
      for (const [id, rec] of Object.entries(bySig)) {
        if (ids.has(id) || (!rec.count && !rec.sync) || !inBox(box, tileOf(id))) continue;
        rec.count = 0;
        delete rec.sync;
        changed = true;
      }
      const within = (a, b) => a[0] === b[0] && a[1] >= b[1] && a[2] >= b[2] && a[3] <= b[3] && a[4] <= b[4];
      if (!before.some((b) => within(box, b))) {
        views[key] = [...before.filter((b) => !within(b, box)), box].slice(-VIEWS_MAX);
        changed = true;
      }
    }
    if (changed) save();
  }

  /**
   * 묶음 id를 눌렀을 때 다른 확대의 기준을 맞춘다. added: 눌러서 기준보다 더 본 매물 수.
   * 그 안의 작은 묶음은 다음에 볼 때 그때 수로 다시 잡고(sync), 그 묶음을 품은 큰 묶음은 기준을 added만큼 올린다.
   */
  function seenThrough(bySig, id, added) {
    const [z, x, y] = tileOf(id);
    for (const [other, rec] of Object.entries(bySig)) {
      const [oz, ox, oy] = tileOf(other);
      if (oz > z && ox >> (oz - z) === x && oy >> (oz - z) === y) rec.sync = true;
      else if (oz < z && added > 0 && x >> (z - oz) === ox && y >> (z - oz) === oy) rec.count += added;
    }
  }

  /** 이 묶음을 어떻게 표시할지: 기준보다 많으면 '새 N', 눌러 본 묶음이면 '봤음', 아니면 null. */
  function statusFor(cl) {
    const rec = sig && seen[sig] && seen[sig][cl.id];
    if (!rec || !Number.isFinite(cl.count)) return null;
    if (!rec.sync && cl.count > rec.count) return { kind: 'new', text: `새 ${cl.count - rec.count}` };
    return rec.auto ? null : { kind: 'seen', text: '봤음' };
  }

  /** 동그라미를 흐리게 하고(봤음), 위에 글자 표시를 붙인다. 글자는 원 모양으로 잘리지 않게 위치 요소에 붙인다. */
  function mark(button, st) {
    if (st.kind === 'seen') button.setAttribute('data-hnw-seen', 'seen');
    const holder = button.closest('.marker-root')?.parentElement || button.parentElement;
    if (!holder) return;
    const tag = document.createElement('span');
    tag.className = `hnw-mark${st.kind === 'new' ? ' new' : ''}`;
    tag.setAttribute('data-t', st.text);
    const h = button.getBoundingClientRect().height || 46;
    tag.style.top = `${-(h / 2) - 22}px`;
    holder.appendChild(tag);
  }

  function clearMarks() {
    document.querySelectorAll('.hnw-mark').forEach((n) => n.remove());
    document.querySelectorAll('[data-hnw-seen]').forEach((n) => n.removeAttribute('data-hnw-seen'));
  }

  const observer = new MutationObserver(() => schedule(500));

  function refresh() {
    timer = null;
    observer.disconnect();
    try {
      clearMarks();
      if (!clusters.length) return;
      const hasSeen = !!(sig && seen[sig]);
      if (!hasSeen && !(showRange && areas.length)) {
        drawRange(null);
        return;
      }
      const cands = bubbles();
      const proj = projection(cands);
      drawRange(proj);
      if (!hasSeen) return;
      const used = new Set();
      for (const cl of clusters) {
        const st = statusFor(cl);
        if (!st) continue;
        let el = null;
        if (proj) {
          const p = proj.at(cl);
          let best = 28;
          for (const c of cands) {
            if (c.n !== cl.count || used.has(c.el)) continue;
            const d = Math.hypot(c.x - p.x, c.y - p.y);
            if (d < best) {
              best = d;
              el = c.el;
            }
          }
        }
        if (!el) {
          // 좌표로 못 찾으면 방금 누른 동그라미를 쓴다. 네이버가 같은 요소를 다른 묶음에 다시 쓸 수 있어서 숫자가 같을 때만.
          const k = known.get(cl.id);
          if (k && k.isConnected && bubbleCount(k) === cl.count) el = k;
        }
        if (el) {
          used.add(el);
          known.set(cl.id, el);
          mark(el, st);
        }
      }
    } finally {
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, ms);
  }

  // ---------- 지도에서 찍어 지역 추가 ----------
  // 팝업의 '네이버 지도에서 찍어 추가'를 누르면 지도 위에 투명한 판을 깐다. 판이 누름을 받으므로 네이버 지도는 눌리지 않는다.
  // 누른 곳의 좌표는 동그라미 위치로 맞춘 변환(projection)을 거꾸로 써서 구한다. Esc나 '취소'로 끝낸다.
  let picker = null;
  const round6 = (v) => Math.round(v * 1e6) / 1e6;

  function stopPick() {
    if (!picker) return;
    picker.layer.remove();
    document.removeEventListener('keydown', picker.onKey, true);
    picker = null;
  }

  function startPick() {
    stopPick();
    const map = document.querySelector('#main_map') || document.querySelector('.mapboxgl-map');
    if (!map) return { ok: false, error: '이 화면에서 지도를 찾지 못했습니다.' };
    const rect = map.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = 'hnw-pick';
    Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const tip = document.createElement('div');
    tip.className = 'hnw-pick-tip';
    tip.textContent = '새 지역의 가운데로 삼을 곳을 누르세요 (Esc: 취소)';
    layer.appendChild(tip);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      stopPick();
    };
    layer.addEventListener('click', (e) => {
      if (!(e.target instanceof Element) || e.target.closest('.hnw-pick-form')) return;
      void pickAt(e.clientX, e.clientY);
    });
    document.addEventListener('keydown', onKey, true);
    document.documentElement.appendChild(layer);
    picker = { layer, tip, rect, onKey };
    return { ok: true };
  }

  async function pickAt(x, y) {
    const proj = projection(bubbles());
    if (!picker) return;
    if (!proj) {
      picker.tip.textContent = '동그라미가 적어 위치를 계산하지 못했습니다. 지도를 조금 축소한 뒤 다시 누르세요 (Esc: 취소)';
      return;
    }
    const { lon, lat } = proj.from(x, y);
    const [got, list] = await Promise.all([chrome.storage.local.get('hnw-stations'), hnwReadAreas()]);
    if (!picker) return;
    const stations = got['hnw-stations'] || [];
    // 이름 제안: 1km 안의 가장 가까운 역. 없으면 '지역 N'. 이미 있는 이름이면 '근처'를 붙인다.
    const near = stations.map((s) => ({ s, d: hnwDistanceM(lat, lon, s.lat, s.lng) })).sort((a, b) => a.d - b.d)[0];
    let name = near && near.d <= 1000 ? near.s.name : `지역 ${list.length + 1}`;
    if (list.some((a) => a.name === name)) name = `${name} 근처`;
    showForm(x, y, { lat, lng: lon }, name, proj);
  }

  function showForm(x, y, point, name, proj) {
    const { layer, rect, tip } = picker;
    layer.querySelectorAll('.hnw-pick-form, svg').forEach((n) => n.remove());
    tip.textContent = '반경을 고르고 추가를 누르세요. 다른 곳을 누르면 옮깁니다 (Esc: 취소)';
    const px = x - rect.left;
    const py = y - rect.top;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(rect.width));
    svg.setAttribute('height', String(rect.height));
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('class', 'area');
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('class', 'dot');
    dot.setAttribute('r', '4');
    for (const c of [circle, dot]) {
      c.setAttribute('cx', String(px));
      c.setAttribute('cy', String(py));
    }
    svg.append(circle, dot);
    layer.appendChild(svg);

    const form = document.createElement('div');
    form.className = 'hnw-pick-form';
    form.innerHTML = `
      <div class="t">이 곳을 지역으로 추가</div>
      <div class="row"><input type="text" maxlength="40" aria-label="지역 이름" /><select aria-label="반경"></select></div>
      <div class="row"><button class="primary" data-act="add">추가</button><button data-act="cancel">취소</button></div>`;
    const input = form.querySelector('input');
    input.value = name;
    const select = form.querySelector('select');
    for (const m of HNW_RADII) {
      const option = document.createElement('option');
      option.value = String(m);
      option.textContent = hnwRadiusText(m);
      option.selected = m === 1000;
      select.appendChild(option);
    }
    // 메르카토르 지도에서는 그 위도에서 경도 1도 = 111,320m × cos(위도)
    const draw = () => circle.setAttribute('r', String((Number(select.value) / (111320 * Math.cos((point.lat * Math.PI) / 180))) * proj.pxPerLon));
    draw();
    select.addEventListener('change', draw);

    const add = async () => {
      const radiusM = Number(select.value);
      const areaName = input.value.trim() || name;
      await hnwEditAreas((l) => [...l, { id: null, name: areaName, lat: round6(point.lat), lng: round6(point.lng), radiusM, enabled: true }]);
      // 방금 추가한 지역이 바로 보이게 범위 표시를 켠다.
      await chrome.storage.local.set({ 'hnw-show-range': true });
      stopPick();
    };
    form.addEventListener('click', (e) => {
      const act = e.target instanceof Element ? e.target.closest('button')?.dataset.act : null;
      if (act === 'add') void add();
      else if (act === 'cancel') stopPick();
    });
    // 이름을 적는 동안 네이버 화면의 단축키가 받지 않게 한다(Esc는 위에서 취소로 받음).
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return;
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        void add();
      }
    });

    layer.appendChild(form);
    form.style.left = `${Math.min(Math.max(px + 16, 8), rect.width - form.offsetWidth - 8)}px`;
    form.style.top = `${Math.min(Math.max(py + 16, 8), rect.height - form.offsetHeight - 8)}px`;
    input.focus();
    input.select();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'pick-area') sendResponse(startPick());
  });
})();
