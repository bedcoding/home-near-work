import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { DABANG_CATEGORIES, DABANG_HEADERS, dabangBounds, dabangFilters, dabangListUrl, DabangPagination, dabangPriceScopes, dabangPricesMatch, dabangTargets } from '../server/dabang-client.ts';
import { parseDabangRoomList } from '../server/dabang-parse.ts';
import { regionBoundaries } from '../shared/region-geometry.ts';

const row = seq => ({ seq, roomTypeName: '투룸', randomLocation: { lat: 35.2, lng: 128.4 }, dongName: '가상동',
  roomTitle: 'Synthetic residence', roomDesc: '2층, 32m², 관리비 없음', priceTypeName: '월세', priceTitle: '500/30' });
const body = (page, total, ids, extra = {}) => JSON.stringify({ code: 200, result: { page, total, limit: 2,
  hasMore: page < Math.max(1, Math.ceil(total / 2)), roomList: ids.map(row), ...extra } });
const bounds = { sw: { lat: 35, lng: 128 }, ne: { lat: 36, lng: 129 } };

test('the query rectangle contains every point of each public district boundary, independently of a station radius', () => {
  for (const feature of regionBoundaries.features) {
    const box = dabangBounds({ lat: 0, lng: 0, radiusM: 1, region: { kind: 'gu', code: feature.properties.sggcd } });
    const rings = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : feature.geometry.coordinates.flat();
    for (const [lng, lat] of rings.flat()) {
      assert.ok(lng > box.sw.lng && lng < box.ne.lng);
      assert.ok(lat > box.sw.lat && lat < box.ne.lat);
    }
  }
  assert.equal(dabangBounds({ region: null }), null);
  assert.equal(dabangBounds({ region: { kind: 'dong', code: '9912310100' } }), null);
  assert.equal(dabangBounds({ region: { kind: 'gu', code: '99123' } }), null);
});

test('all four residential categories use unbounded prices and sizes, without notification filters', () => {
  assert.equal(DABANG_CATEGORIES.length, 4);
  for (const category of DABANG_CATEGORIES) {
    const filters = dabangFilters(category.id);
    assert.deepEqual(filters.pyeongRange, { min: 0, max: 999999 });
    assert.deepEqual(filters.priceRange, { min: 0, max: 999999 });
    assert.equal(filters.isShortLease, false);
    assert.deepEqual(filters.dealTypeList, ['AGENT']);
    assert.equal(filters.sellingTypeList.includes('SELL'), category.id !== 'one-two');
    const url = new URL(dabangListUrl(category.id, bounds, 12));
    assert.equal(url.pathname, `/api/v5/room-list/category/${category.id}/bbox`);
    assert.deepEqual(JSON.parse(url.searchParams.get('bbox')), bounds);
    assert.equal(url.searchParams.get('page'), '12');
  }
  assert.equal(Object.keys(DABANG_HEADERS).some(key => /cookie|authorization/i.test(key)), false);
});

const priceLimits = { saleMax: 65000, jeonseMax: 18000, monthlyDepositMax: 5000, monthlyMax: 65, excludeSale: false };

test('the provider receives separate deposit caps only when required, plus its distinct sale and monthly caps', () => {
  const scopes = dabangPriceScopes('apt', priceLimits);
  const query = scope => JSON.parse(new URL(dabangListUrl('apt', bounds, 1, scope)).searchParams.get('filters'));
  assert.equal(scopes.length, 2);
  assert.deepEqual(query(scopes[0]).sellingTypeList, ['MONTHLY_RENT', 'SELL']);
  assert.deepEqual(query(scopes[0]).depositRange, { min: 0, max: 5000 });
  assert.deepEqual(query(scopes[0]).priceRange, { min: 0, max: 65 });
  assert.deepEqual(query(scopes[0]).tradeRange, { min: 0, max: 65000 });
  assert.deepEqual(query(scopes[1]).sellingTypeList, ['LEASE']);
  assert.deepEqual(query(scopes[1]).depositRange, { min: 0, max: 18000 });
  const sameDeposit = { ...priceLimits, monthlyDepositMax: 18000, excludeSale: true };
  const combined = dabangPriceScopes('apt', sameDeposit);
  assert.equal(combined.length, 1);
  assert.deepEqual(query(combined[0]).sellingTypeList, ['MONTHLY_RENT', 'LEASE']);
  assert.deepEqual(query(combined[0]).tradeRange, { min: 0, max: 999999 });
  assert.equal(dabangPriceScopes('one-two', priceLimits).flatMap(scope => scope.deals).includes('sale'), false);
});

test('amounts at or beyond the provider sentinel are compared against the exact configured cap after retrieval', () => {
  const limits = { ...priceLimits, saleMax: 1000000 };
  const [scope] = dabangPriceScopes('apt', limits);
  assert.equal(scope.saleMax, null);
  const sale = price => ({ deal: 'sale', price, deposit: null, monthly: null });
  assert.equal(dabangPricesMatch([sale(1000000)], limits), true);
  assert.equal(dabangPricesMatch([sale(1000001)], limits), false);
  assert.equal(dabangPricesMatch([sale(null)], limits), false);
  assert.equal(dabangPricesMatch([sale(1000001)], limits, scope), true);
  assert.equal(dabangPricesMatch([sale(null)], limits, scope), false);
});

test('pagination verifies every page, excludes advertising from expected regular count and accepts empty lists', () => {
  const p = new DabangPagination();
  p.accept(body(1, 3, [101, 102], { premiumList: [{ roomList: [row(900)] }] }), 1, 'one-two');
  p.accept(body(2, 3, [103]), 2, 'one-two');
  assert.equal(p.result().complete, true);
  assert.equal(p.result().received, 3);
  const empty = new DabangPagination();
  empty.accept(body(1, 0, []), 1, 'apt');
  assert.equal(empty.result().complete, true);
});

test('a last page, duplicate responses, missing rows or changing totals cannot falsely complete', () => {
  assert.throws(() => new DabangPagination().accept(body(2, 4, [103, 104]), 2, 'apt'), /순서/);
  const duplicate = new DabangPagination();
  duplicate.accept(body(1, 4, [101, 102]), 1, 'apt');
  assert.equal(duplicate.accept(body(2, 4, [101, 102]), 2, 'apt').more, false);
  assert.equal(duplicate.result().complete, false);
  const missing = new DabangPagination();
  missing.accept(body(1, 2, [101]), 1, 'apt');
  assert.equal(missing.result().complete, false);
  const changed = new DabangPagination();
  changed.accept(body(1, 3, [101, 102]), 1, 'apt');
  changed.accept(body(2, 4, [103, 104]), 2, 'apt');
  assert.equal(changed.result().complete, false);
});

test('malformed responses, missing coordinates, contradictory last-page flags and page limits fail closed', () => {
  assert.throws(() => new DabangPagination().accept('{}', 1, 'apt'));
  assert.throws(() => new DabangPagination().accept(body(1, 1, [101]).replace('"code":200', '"code":400'), 1, 'apt'), /정상 목록/);
  const invalid = new DabangPagination();
  invalid.accept(body(1, 1, [101], { roomList: [{ ...row(101), randomLocation: { lat: null, lng: null } }] }), 1, 'apt');
  assert.equal(invalid.result().complete, false);
  const contradictory = new DabangPagination();
  assert.equal(contradictory.accept(body(1, 1, [101], { hasMore: true }), 1, 'apt').more, false);
  assert.equal(contradictory.result().complete, false);
  assert.throws(() => new DabangPagination().accept(body(1, 4001, [101, 102]), 1, 'apt'), /한도/);
});

test('normalisation preserves the residential category and its matching map link', () => {
  for (const [category, type, route] of [['apt', '아파트', 'apt'], ['house-villa', '빌라와 주택', 'house'], ['officetel', '오피스텔', 'officetel']]) {
    const parsed = parseDabangRoomList(body(1, 1, [101]), category);
    assert.equal(parsed.items[0].listing.buildingType, type);
    assert.equal(new URL(parsed.items[0].listing.url).pathname, `/map/${route}`);
  }
});

function collectorFixture(mode = 'ok') {
  const requests = [], savedFiles = [], coverage = [], partial = [];
  const code = ts.transpileModule(fs.readFileSync(new URL('../server/collectors/dabang.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const client = { DABANG_CATEGORIES, DABANG_HEADERS, dabangListUrl, DabangPagination, dabangPriceScopes, dabangPricesMatch,
    dabangTargets: areas => ({ targets: areas.filter(area => area.region?.kind === 'gu' || Number.isFinite(area.lat)).map(area => ({ area, bounds })), skipped: [],
      unreadable: areas.filter(area => area.region?.kind !== 'gu' && !Number.isFinite(area.lat)) }) };
  vm.runInNewContext(code, { exports, URLSearchParams, AbortSignal, fetch: async url => {
    const u = new URL(url), page = Number(u.searchParams.get('page'));
    requests.push(u);
    const first = u.pathname.includes('one-two');
    if (mode === 'blocked') return { status: 429, ok: false };
    if (mode === 'partial' && first && page === 2) throw new Error('synthetic network error');
    if ((mode === 'priced' || mode === 'conflicting-trade') && first) {
      const filters = JSON.parse(u.searchParams.get('filters'));
      const leaseId = mode === 'conflicting-trade' ? 101 : 111;
      const result = filters.sellingTypeList.includes('LEASE')
        ? body(1, 1, [], { roomList: [{ ...row(leaseId), priceTypeName: '전세', priceTitle: '1억8000' }] })
        : body(1, 2, [], { roomList: [row(101), { ...row(102), priceTitle: '5500/30' }],
          premiumList: [{ roomList: [{ ...row(901), dongName: '주변가상동' }, { ...row(902), priceTitle: '500/90' }] }] });
      return { status: 200, ok: true, text: async () => result };
    }
    if (mode === 'priced' || mode === 'conflicting-trade') return { status: 200, ok: true, text: async () => body(1, 0, []) };
    if (mode === 'high-cap') {
      const result = u.pathname.includes('apt')
        ? body(1, 2, [], { roomList: [
          { ...row(301), priceTypeName: '매매', priceTitle: '99억' },
          { ...row(302), priceTypeName: '매매', priceTitle: '101억' },
        ] })
        : body(1, 0, []);
      return { status: 200, ok: true, text: async () => result };
    }
    return { status: 200, ok: true, text: async () => first ? body(page, 3, page === 1 ? [101, 102] : [103],
      { premiumList: [{ roomList: [{ ...row(901), dongName: '주변가상동' }] }] }) : body(1, 0, []) };
  }, require: id => {
    if (id === 'node:fs') return { mkdirSync() {}, writeFileSync: (...args) => savedFiles.push(args) };
    if (id === 'node:path') return path;
    if (id === '../config.js') return { RUNS_DIR: '/synthetic', PAGE_DELAY_MS: 0 };
    if (id === '../dabang-client.js') return client;
    throw new Error(`Unexpected dependency ${id}`);
  } });
  const ctx = { runId: 1, areas: [{ id: 1, name: '가상구', region: { kind: 'gu', code: '99123' } }], log() {}, progress() {}, stopped: () => false,
    partial: (...args) => partial.push(args), coverage: (row, ids) => coverage.push({ ...row, ids }),
    session: { goto: async () => {}, screenshot: async () => null, rest: async () => {}, record() {}, page: { waitForTimeout: async () => {} } } };
  return { collector: exports.dabang, ctx, requests, savedFiles, partial, coverage };
}

test('collector reads all categories and pages, retains incidental advertising and saves evidence', async () => {
  const f = collectorFixture();
  const items = await f.collector.collect(f.ctx);
  assert.equal(f.requests.length, 5);
  assert.deepEqual(new Set(items.map(item => item.listing.sourceId)), new Set(['101', '102', '103', '901']));
  assert.equal(f.partial.length, 0);
  assert.equal(f.coverage.filter(row => row.complete).length, 4);
  assert.equal(f.savedFiles.filter(([name]) => name.endsWith('coverage.json')).length, 4);
  assert.equal(f.collector.retainMissing, true);
});

test('price-scoped runs retain eligible incidental rows and report unverified regular replies as partial', async () => {
  const f = collectorFixture('priced');
  f.ctx.priceLimits = { ...priceLimits, excludeSale: true };
  const items = await f.collector.collect(f.ctx);
  assert.deepEqual(new Set(items.map(item => item.listing.sourceId)), new Set(['101', '111', '901']));
  assert.equal(f.requests.length, 8);
  assert.equal(f.coverage.findLast(row => row.category === 'one-two-monthly').complete, false);
  assert.equal(f.coverage.findLast(row => row.category === 'one-two-jeonse').complete, true);
  assert.equal(f.partial.length, 1);
  assert.match(f.partial[0][0], /거래 조건과 일치/);
});

test('expected rows beyond a local-only upper bound do not make the upstream scope partial', async () => {
  const f = collectorFixture('high-cap');
  f.ctx.priceLimits = { saleMax: 1000000, jeonseMax: null, monthlyDepositMax: null, monthlyMax: null, excludeSale: false };
  const items = await f.collector.collect(f.ctx);
  assert.deepEqual(Array.from(items, item => item.listing.sourceId), ['301']);
  assert.equal(f.partial.length, 0);
  assert.equal(f.coverage.findLast(row => row.category === 'apt').complete, true);
});

test('a conflicting trade for the same ID keeps the earlier verified offer and marks the later scope partial', async () => {
  const f = collectorFixture('conflicting-trade');
  f.ctx.priceLimits = { ...priceLimits, excludeSale: true };
  const items = await f.collector.collect(f.ctx);
  const listing = items.find(item => item.listing.sourceId === '101').listing;
  assert.deepEqual(listing.prices.map(offer => offer.deal), ['monthly']);
  assert.equal(f.coverage.findLast(row => row.category === 'one-two-jeonse').complete, false);
});

test('a failed page retains prior rows and continues remaining categories; blocking stops further requests', async () => {
  const f = collectorFixture('partial');
  const items = await f.collector.collect(f.ctx);
  assert.equal(items.length, 3);
  assert.equal(f.requests.length, 5);
  assert.equal(f.partial.length, 1);
  assert.equal(f.coverage.at(-1).complete, true);
  const blocked = collectorFixture('blocked');
  assert.equal((await blocked.collector.collect(blocked.ctx)).length, 0);
  assert.equal(blocked.requests.length, 1);
  assert.equal(blocked.partial.length, 1);
});

test('unsupported or stopped collection never reports a completed GU', async () => {
  const f = collectorFixture(); f.ctx.areas[0].region = null;
  assert.equal((await f.collector.collect(f.ctx)).length, 0);
  assert.equal(f.partial.length, 1);
  assert.equal(f.requests.length, 0);
  const stopped = collectorFixture(); stopped.ctx.stopped = () => true;
  assert.equal((await stopped.collector.collect(stopped.ctx)).length, 0);
  assert.equal(stopped.coverage.length, 4);
  assert.equal(stopped.coverage.every(row => row.pages === 0 && !row.complete), true);
});

test('동과 지하철역은 반경 원을 덮는 사각형으로 조회하고, 이미 조회하는 구 안에 다 들어가면 건너뛴다', () => {
  const station = { id: 2, name: '가상역', lat: 37.5, lng: 127, radiusM: 1000, region: null };
  const box = dabangBounds(station);
  assert.ok(box.sw.lat < 37.491 && box.ne.lat > 37.509, '남북으로 반경 1km를 덮는다');
  assert.ok(box.sw.lng < 126.9887 && box.ne.lng > 127.0113, '동서로 반경 1km를 덮는다');
  assert.equal(dabangBounds({ ...station, radiusM: 0 }), null);
  const feature = regionBoundaries.features[0];
  const gu = { id: 1, name: '가상구', lat: 0, lng: 0, radiusM: 1, region: { kind: 'gu', code: feature.properties.sggcd } };
  const guBox = dabangBounds(gu);
  const centre = { lat: (guBox.sw.lat + guBox.ne.lat) / 2, lng: (guBox.sw.lng + guBox.ne.lng) / 2 };
  const insideStation = { ...station, id: 3, name: '안쪽역', ...centre, radiusM: 300 };
  const farStation = { ...station, id: 4, name: '먼역', lat: guBox.ne.lat + 0.2, lng: centre.lng };
  const plan = dabangTargets([insideStation, farStation, gu, { ...gu, id: 5 }]);
  assert.deepEqual(plan.targets.map(t => t.area.id), [1, 4], '구를 먼저, 같은 구는 한 번만, 구 밖 역은 따로 조회한다');
  assert.deepEqual(plan.skipped.map(s => [s.area.id, s.by]), [[3, '가상구']]);
  assert.deepEqual(plan.unreadable, []);
});

test('원본 열기 주소는 방 id로 그 방 상세를 바로 연다', async () => {
  const { dabangRoomUrl, withDabangRoom } = await import('../server/dabang-parse.ts');
  const id = 'a'.repeat(24);
  const parsed = parseDabangRoomList(body(1, 1, [101], { roomList: [{ ...row(101), id }] }), 'house-villa');
  const url = new URL(parsed.items[0].listing.url);
  assert.equal(url.pathname, '/map/house');
  assert.deepEqual([url.searchParams.get('detail_type'), url.searchParams.get('detail_id')], ['room', id]);
  assert.equal(parsed.items[0].listing.sourceId, '101', '저장 번호는 그대로 seq');
  assert.equal(new URL(dabangRoomUrl('apt', 35.2, 128.4, 'not-an-id')).searchParams.has('detail_id'), false, 'id 모양이 다르면 지도만 연다');
  const old = 'https://www.dabangapp.com/map/onetwo?m_lat=35.2&m_lng=128.4&m_zoom=17';
  assert.equal(new URL(withDabangRoom(old, id)).searchParams.get('detail_id'), id);
  assert.equal(withDabangRoom(old, 'bad'), null);
  assert.equal(withDabangRoom('https://example.invalid/map/onetwo', id), null, '다방 주소가 아니면 고치지 않는다');
});

test('주변 정보 응답에서 지번 주소만 읽고, 이상한 응답은 받지 않는다', async () => {
  const { dabangNearUrl, parseDabangNear } = await import('../server/dabang-parse.ts');
  const id = 'b'.repeat(24);
  assert.equal(dabangNearUrl(id), `https://www.dabangapp.com/api/v5/room/${id}/near`);
  assert.equal(dabangNearUrl('../x'), null);
  const ok = JSON.stringify({ code: 200, result: { address: '예시도  가상구 가상동 1-2', location: { lat: 35.2, lng: 128.4 } } });
  assert.deepEqual(parseDabangNear(ok), { address: '예시도 가상구 가상동 1-2', lat: 35.2, lng: 128.4 });
  assert.equal(parseDabangNear(JSON.stringify({ code: 400, result: { address: '예시도' } })), null);
  assert.equal(parseDabangNear(JSON.stringify({ code: 200, result: {} })), null);
  assert.equal(parseDabangNear(JSON.stringify({ code: 200, result: { address: '<b>x</b>' } })), null);
  assert.equal(parseDabangNear('not json'), null);
  assert.deepEqual(parseDabangNear(JSON.stringify({ code: 200, result: { address: '예시도 가상동 3' } })), { address: '예시도 가상동 3', lat: null, lng: null });
});
