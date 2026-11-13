import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ZIGBANG_DETAIL_PAGE, ZIGBANG_HEADERS, ZIGBANG_MAX_STATIONS, ZigbangStationLedger, readZigbangStationIds, zigbangDetailChunks,
  zigbangPriceScopes, zigbangStationListUrl, zigbangStationsFor,
} from '../server/zigbang-client.ts';
import { createZigbangCollector } from '../server/zigbang-collect.ts';
import { pointInRegion, regionBoundaries } from '../shared/region-geometry.ts';

// 합성 데이터: 실제 매물 문구나 번호를 쓰지 않는다.
const detail = (id, extra = {}) => ({ item_id: id, sales_type: '월세', deposit: 500, rent: 40, title: `Synthetic room ${id}`,
  location: { lat: 37.5 + id / 1e6, lng: 127 + id / 1e6 }, floor_string: '2', building_floor: '4', manage_cost: 50000,
  reg_date: '2026-11-01T00:00:00', service_type: '원룸', ...extra });
const list = (ids) => JSON.stringify({ items: ids.map((id) => ({ id, lat: 37.5, lng: 127, userNo: 1 })), sections: [], subways: [] });
const details = (ids, mutate = (x) => x) => JSON.stringify({ items: ids.map((id) => mutate(detail(id))), itemSummaries: [], totalCount: ids.length });
const area = { id: 1, name: '가상 지역', lat: 37.5, lng: 127, radiusM: 500, region: null, enabled: true, purpose: 'collection' };
const caps = (overrides = {}) => ({
  saleMax: null, jeonseMax: null, monthlyDepositMax: null, monthlyMax: null, excludeSale: false, ...overrides,
});

test('station list URL keeps the verified one-kilometre query and refuses malformed station numbers', () => {
  const url = new URL(zigbangStationListUrl('123'));
  assert.equal(url.origin, 'https://apis.zigbang.com');
  assert.equal(url.pathname, '/house/property/v1/items/subways/123/onerooms');
  assert.deepEqual([...url.searchParams].sort(), [['depositMin', '0'], ['radius', '1'], ['rentMin', '0']]);
  assert.throws(() => zigbangStationListUrl('0'));
  assert.throws(() => zigbangStationListUrl('12/../1'));
  assert.equal(Object.keys(ZIGBANG_HEADERS).some((key) => /cookie|authorization/i.test(key)), false);
});

test('station query uses indexed trade values and sends finite caps including zero', () => {
  const [scope] = zigbangPriceScopes(caps({ saleMax: 53000, jeonseMax: 10000, monthlyDepositMax: 10000, monthlyMax: 0 }));
  const params = new URL(zigbangStationListUrl('123', scope)).searchParams;
  assert.equal(params.get('salesPriceMax'), '53000');
  assert.equal(params.get('depositMax'), '10000');
  assert.equal(params.get('rentMax'), '0');
  assert.equal(params.has('salesTypes[0]'), false);
  const [rent] = zigbangPriceScopes(caps({ saleMax: 53000, excludeSale: true }));
  const exclude = new URL(zigbangStationListUrl('123', rent)).searchParams;
  assert.deepEqual([...exclude].filter(([key]) => key.startsWith('salesTypes')), [
    ['salesTypes[0]', '월세'], ['salesTypes[1]', '단기'], ['salesTypes[2]', '전세'],
  ]);
  assert.equal(exclude.has('salesPriceMax'), false);
});

test('radius areas use stations whose 1km overlaps the area, falling back to the nearest within 2km', () => {
  const near = { id: '1', name: '가상역 가', lat: 37.5, lng: 127.01 }; // 약 880m
  const edge = { id: '2', name: '가상역 나', lat: 37.5, lng: 127.016 }; // 약 1.4km, 반경 500m + 1km 안
  const far = { id: '3', name: '가상역 다', lat: 37.5, lng: 127.05 };
  assert.deepEqual(zigbangStationsFor(area, [far, edge, near]).stations.map((s) => s.id), ['1', '2']);
  const tiny = { ...area, radiusM: 1 };
  assert.deepEqual(zigbangStationsFor(tiny, [edge, far]).stations.map((s) => s.id), ['2']);
  assert.deepEqual(zigbangStationsFor(tiny, [far]).stations, []);
  assert.deepEqual(zigbangStationsFor(area, [{ ...near, id: 'abc' }]).stations, []);
});

test('a district uses only stations inside its boundary and caps the count nearest-first', () => {
  const feature = regionBoundaries.features[0];
  const ring = (feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0][0]);
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const code = feature.properties.sggcd;
  // 경계 상자 가운데가 구 밖일 수 있어 격자에서 구 안의 점을 찾는다.
  let centre = null;
  for (let i = 1; i < 20 && !centre; i++) for (let j = 1; j < 20 && !centre; j++) {
    const lat = Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * i / 20;
    const lng = Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * j / 20;
    if (pointInRegion(code, lat, lng)) centre = { lat, lng };
  }
  assert.ok(centre);
  const gu = { ...area, lat: centre.lat, lng: centre.lng, region: { kind: 'gu', code } };
  const outside = { id: '9', name: '바깥역', lat: Math.max(...ys) + 0.05, lng: centre.lng };
  const inside = Array.from({ length: ZIGBANG_MAX_STATIONS + 3 }, (_, i) => ({ id: String(i + 10), name: `역${i}`, lat: centre.lat, lng: centre.lng }));
  const plan = zigbangStationsFor(gu, [outside, ...inside]);
  assert.equal(plan.stations.some((s) => s.id === '9'), false);
  assert.equal(plan.stations.length, ZIGBANG_MAX_STATIONS);
  assert.equal(plan.skipped, 3);
});

test('station IDs fail closed on duplicates or malformed rows and detail chunks match the site page size', () => {
  assert.deepEqual(readZigbangStationIds(list([1, 2])), [1, 2]);
  assert.equal(readZigbangStationIds(list([1, 1])), null);
  assert.equal(readZigbangStationIds('{"items":[{"id":"1"}]}'), null);
  assert.equal(readZigbangStationIds('not json'), null);
  const ids = Array.from({ length: 31 }, (_, i) => i + 1);
  assert.deepEqual(zigbangDetailChunks(ids).map((c) => c.length), [ZIGBANG_DETAIL_PAGE, ZIGBANG_DETAIL_PAGE, 1]);
});

test('each room opens its own page instead of the station list it was read from', () => {
  const [item] = new ZigbangStationLedger().acceptDetails(details([7]), [7]);
  assert.equal(item.listing.url, 'https://www.zigbang.com/home/oneroom/items/7');
});

test('the ledger completes only when every listed ID returns a readable detail', () => {
  const ok = new ZigbangStationLedger();
  ok.acceptList(list([1, 2]));
  ok.acceptDetails(details([1, 2]), [1, 2]);
  assert.equal(ok.result().complete, true);
  const missing = new ZigbangStationLedger();
  missing.acceptList(list([1, 2]));
  missing.acceptDetails(details([1]), [1, 2]);
  assert.equal(missing.result().complete, false);
  assert.match(missing.result().reason, /미수신 1건/);
  const unreadable = new ZigbangStationLedger();
  unreadable.acceptList(list([1]));
  unreadable.acceptDetails(details([1], (x) => ({ ...x, location: null })), [1]);
  assert.match(unreadable.result().reason, /읽기 실패 1건/);
  const unrequested = new ZigbangStationLedger();
  unrequested.acceptList(list([1]));
  unrequested.acceptDetails(details([5]), [1]);
  assert.equal(unrequested.result().complete, false);
  const none = new ZigbangStationLedger();
  assert.equal(none.result().complete, false);
  const empty = new ZigbangStationLedger();
  empty.acceptList(list([]));
  assert.equal(empty.result().complete, true);
});

function fixture({
  status = 200, stations = [{ id: '7', name: '가상역', lat: 37.5, lng: 127.001 }], ids = [1, 2, 3],
  drop = [], stopAfter = Infinity, idsFor = () => ids, detailOf = row => row, initialSeen = { old: [1] },
} = {}) {
  const requests = [], coverage = [], partial = [], touched = [], saved = [];
  let seen = initialSeen;
  let known = stations;
  let calls = 0;
  const fetchStub = async (url, init = {}) => {
    calls += 1;
    requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const u = new URL(String(url));
    let body;
    if (u.pathname === '/common/subway/all') body = JSON.stringify([{ id: 7, name: '가상역', lat: 37.5, lng: 127.001, subway_area: '수도권' }]);
    else if (u.pathname.endsWith('/onerooms')) body = list(idsFor(u.searchParams));
    else body = details(JSON.parse(init.body).itemIds.filter((id) => !drop.includes(id)), detailOf);
    return new Response(body, { status: u.pathname.endsWith('/onerooms') ? status : 200 });
  };
  const collector = createZigbangCollector({
    fetch: fetchStub,
    stations: () => known,
    learnStations: () => { known = [{ id: '7', name: '가상역', lat: 37.5, lng: 127.001 }]; return true; },
    touch: (list) => touched.push(...list),
    readSeen: () => seen,
    writeSeen: (value) => { seen = value; },
    save: (_run, name) => saved.push(name),
    delayMs: 0,
  });
  const ctx = { runId: 5, areas: [area], aptGus: [], log() {}, progress() {}, classify: () => new Map(),
    stopped: () => calls >= stopAfter,
    partial: (reason, retry = true) => partial.push({ reason, retry }), coverage: (row, list) => coverage.push({ row, ids: list }),
    session: { record() {}, rest: async () => {}, page: { waitForTimeout: async () => {} } } };
  return { collector, ctx, requests, coverage, partial, touched, saved, get seen() { return seen; } };
}

test('collector requests the ID list, then every detail in POST batches, and proves the station complete', async () => {
  const f = fixture({ ids: Array.from({ length: 16 }, (_, i) => i + 1) });
  const items = await f.collector.collect(f.ctx);
  assert.equal(items.length, 16);
  assert.equal(f.requests[0].method, 'GET');
  assert.deepEqual(f.requests.slice(1).map((r) => [r.method, r.body.itemIds.length]), [['POST', 15], ['POST', 1]]);
  assert.equal(f.requests.every((r) => r.headers['X-Zigbang-Platform'] === 'www'), true);
  const last = f.coverage.at(-1);
  assert.equal(last.row.complete, true);
  assert.equal(last.row.category, 'zigbang-7');
  assert.equal(last.ids.length, 16);
  assert.equal(f.partial.length, 0);
  assert.equal(f.touched.length, 16);
  assert.equal(items[0].pageUrl, 'https://www.zigbang.com/home/oneroom/subways/7/items');
  assert.deepEqual(Object.keys(f.seen).sort(), ['old', 'zigbang|7|depositMin=0&radius=1&rentMin=0']);
});

test('different rental caps use separate station queries and preserve the previous unfiltered baseline', async () => {
  const prior = 'zigbang|7|depositMin=0&radius=1&rentMin=0';
  const f = fixture({
    idsFor: params => params.get('salesTypes[0]') === '전세' ? [2] : [1],
    detailOf: row => row.item_id === 2 ? { ...row, sales_type: '전세', deposit: 17000 } : { ...row, deposit: 0 },
    initialSeen: { [prior]: [9] },
  });
  f.ctx.priceLimits = caps({ excludeSale: true, monthlyDepositMax: 0, monthlyMax: 43, jeonseMax: 17300 });
  assert.deepEqual((await f.collector.collect(f.ctx)).map(item => item.listing.sourceId), ['1', '2']);
  const [monthly, lease] = f.requests.filter(request => request.method === 'GET').map(request => new URL(request.url).searchParams);
  assert.deepEqual([monthly.get('depositMax'), monthly.get('rentMax'), lease.get('depositMax'), lease.get('rentMax')], ['0', '43', '17300', null]);
  assert.deepEqual(f.coverage.filter(({ row }) => row.complete).map(({ row }) => row.category), ['zigbang-7-monthly', 'zigbang-7-jeonse']);
  assert.deepEqual(f.seen[prior], [9]);
  assert.equal(Object.keys(f.seen).length, 3);
  assert.deepEqual(f.touched, []);
  assert.deepEqual(f.partial, []);
});

test('details outside the requested caps do not enter storage or establish a verified station baseline', async () => {
  const f = fixture({
    detailOf: row => row.item_id === 2 ? { ...row, rent: 44 } : row.item_id === 3 ? { ...row, rent: null } : row,
  });
  f.ctx.priceLimits = caps({ monthlyMax: 43 });
  const items = await f.collector.collect(f.ctx);
  assert.deepEqual(items.map(item => item.listing.sourceId), ['1']);
  assert.equal(f.coverage.at(-1).row.complete, false);
  assert.match(f.partial[0].reason, /2건이 요청한 가격/);
  assert.deepEqual(f.touched, []);
  assert.deepEqual(f.seen, { old: [1] });
});

test('rental-only lookup requests and retains only monthly and jeonse rows with no saved caps', async () => {
  const f = fixture({
    detailOf: row => row.item_id === 2 ? { ...row, sales_type: '전세' } : row.item_id === 3 ? { ...row, sales_type: '매매' } : row,
  });
  f.ctx.rentalOnly = true;
  assert.deepEqual((await f.collector.collect(f.ctx)).map(item => item.listing.sourceId), ['1', '2']);
  const params = new URL(f.requests[0].url).searchParams;
  assert.deepEqual([...params].filter(([key]) => key.startsWith('salesTypes')), [['salesTypes[0]', '월세'], ['salesTypes[1]', '전세']]);
  assert.match(f.partial[0].reason, /1건이 요청한 가격 또는 거래 조건/);
  assert.deepEqual(f.seen, { old: [1] });
});

test('missing details, blocking and stopping leave partial results instead of a false completion', async () => {
  const missing = fixture({ drop: [2] });
  assert.equal((await missing.collector.collect(missing.ctx)).length, 2);
  assert.equal(missing.coverage.at(-1).row.complete, false);
  assert.match(missing.partial[0].reason, /미수신 1건/);

  const blocked = fixture({ status: 429 });
  assert.equal((await blocked.collector.collect(blocked.ctx)).length, 0);
  assert.equal(blocked.partial[0].retry, false);
  assert.match(blocked.coverage.at(-1).row.reason, /429/);

  const stopped = fixture({ ids: Array.from({ length: 30 }, (_, i) => i + 1), stopAfter: 2 });
  await stopped.collector.collect(stopped.ctx);
  assert.equal(stopped.coverage.at(-1).row.complete, false);
  assert.match(stopped.coverage.at(-1).row.reason, /중단/);
});

test('without learned stations the collector fetches the public station list once, and reports areas without stations', async () => {
  const f = fixture({ stations: [] });
  assert.equal((await f.collector.collect(f.ctx)).length, 3);
  assert.equal(new URL(f.requests[0].url).pathname, '/common/subway/all');
  const far = fixture({ stations: [{ id: '8', name: '먼역', lat: 38, lng: 128 }] });
  assert.equal((await far.collector.collect(far.ctx)).length, 0);
  assert.match(far.partial[0].reason, /직방 역을 찾지 못했습니다/);
  assert.equal(far.requests.length, 0);
});

test('area coverage counts the share of a radius area inside the chosen stations 1km circles', async () => {
  const { zigbangAreaCoverage } = await import('../server/zigbang-client.ts');
  const centre = { id: '1', name: '가운데역', lat: 37.5, lng: 127 };
  assert.deepEqual(zigbangAreaCoverage({ ...area, radiusM: 800 }, [centre]), { stations: 1, percent: 100 });
  const partly = zigbangAreaCoverage({ ...area, radiusM: 2000 }, [centre]);
  assert.equal(partly.stations, 1);
  assert.ok(partly.percent > 15 && partly.percent < 35, `1km 원은 2km 원의 약 25%: ${partly.percent}`);
  assert.deepEqual(zigbangAreaCoverage({ ...area, radiusM: 800 }, [{ ...centre, lat: 37.6 }]), { stations: 0, percent: 0 });
  assert.equal(zigbangAreaCoverage({ ...area, radiusM: 1 }, [centre]).percent, null, '격자 점이 하나도 안 들어가면 셀 수 없음');
  assert.equal(zigbangAreaCoverage({ ...area, region: { kind: 'gu', code: '99999' } }, [centre]).percent, null);
});
