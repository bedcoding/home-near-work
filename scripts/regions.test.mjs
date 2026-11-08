import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as regions from '../shared/regions.ts';
import * as alertScope from '../shared/alert-scope.ts';
import * as filters from '../shared/filters.ts';
import * as types from '../shared/types.ts';
import * as identity from '../server/identity.ts';
import { pointInGeometry, regionBoundaries, regionBounds } from '../shared/region-geometry.ts';
import { canonicalRegion, regionArea, regionCatalog } from '../server/region-catalog.ts';

const region = { kind: 'gu', code: '99123', sido: '예시도', sigungu: '가상구', dong: null, name: '예시도 가상구' };
const area = { id: 1, name: '가상구', region, lat: 0, lng: 0, radiusM: 100, enabled: true };
const row = (id, address = '예시도 가상구 샘플동', extra = {}) => ({ source: 'ziptoss', sourceId: id, title: 'Synthetic listing', address, dong: '샘플동', lat: null, lng: null,
  prices: [{ deal: 'monthly', deposit: 100, monthly: 30 }], buildingType: '원룸', floor: 2, areaM2: 20, url: 'https://example.invalid/listing', ...extra });
const compile = (path, deps) => {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require: (id) => deps[id] ?? {} });
  return exports;
};

test('gu/dong identity requires jurisdiction and respects codes over approximate coordinates', () => {
  const dong = { ...region, kind: 'dong', code: '9912310100', dong: '샘플동', name: '예시도 가상구 샘플동' };
  assert.equal(regions.matchesRegion(row('1'), region), true);
  assert.equal(regions.matchesRegion(row('1'), dong), true);
  assert.equal(regions.matchesRegion(row('1', '다른도 가상구 샘플동'), dong), false);
  assert.equal(regions.matchesRegion(row('1', '예시도 다른구 샘플동'), dong), false);
  assert.equal(regions.matchesRegion(row('1', null), dong), false);
  assert.equal(regions.matchesRegion(row('1', null, { legalDongCode: '9912310200' }), region), true);
  assert.equal(regions.matchesRegion(row('1', null, { legalDongCode: '9912310200' }), dong), false);
  assert.equal(regions.validRegion(dong), true);
  assert.equal(regions.validRegion({ ...dong, dong: '<invalid>' }), false);
});

test('구 판정은 매물마다 기억하고, 판정에 쓰는 칸이 바뀌면 다시 낸다', () => {
  const listing = row('memo');
  assert.equal(regions.matchesRegion(listing, region), true);
  assert.equal(regions.matchesRegion(listing, region), true, '같은 매물과 같은 구는 기억한 값');
  listing.address = '다른도 다른구 샘플동';
  assert.equal(regions.matchesRegion(listing, region), false, '주소가 바뀌면 다시 판정한다');
  listing.address = '예시도 가상구 샘플동';
  listing.legalDongCode = '1111010100';
  assert.equal(regions.matchesRegion(listing, region), false, '법정동코드가 생기면 그것으로 다시 판정한다');
  const other = { ...region, code: '99999', sigungu: '다른구', name: '예시도 다른구' };
  assert.equal(regions.matchesRegion(row('memo2'), other), false, '구가 다르면 따로 판정한다');
});

test('list collection regions and station alert circles are independent', () => {
  const alerts = compile('../server/alerts.ts', { '../shared/alert-scope.js': alertScope, '../shared/filters.js': filters, '../shared/types.js': types });
  const settings = { ...alerts.DEFAULT_ALERTS, homeFilter: filters.DEFAULT_FILTERS };
  const legacy = { id: 2, name: 'Synthetic station', purpose: 'alert', lat: 0, lng: 0, radiusM: 100, enabled: true };
  const all = [area, legacy];
  for (const listing of [row('inside'), row('outside', '예시도 다른구 샘플동', { lat: 0, lng: 0 }), row('unknown', null)]) {
    const expected = listing.sourceId === 'inside';
    assert.equal(filters.passes(listing, { ...filters.DEFAULT_FILTERS, areaIds: [legacy.id], distanceMax: 1 }, all), expected);
    assert.equal(alerts.matchesAlert(listing, settings, all), listing.sourceId === 'outside');
    assert.equal(alerts.matchesAlert(listing, { ...settings, homeFilter: null }, all), listing.sourceId === 'outside');
    assert.equal(filters.passes(listing, { ...filters.DEFAULT_FILTERS, insideAreas: false }, all), true);
  }
  assert.equal(regions.regionRelation(row('unknown', null), all), 'unknown');
  assert.equal(regions.regionRelation(row('outside', '예시도 다른구'), all), 'surrounding');
  assert.equal(regions.areaMatches({ lat: 0, lng: 0 }, legacy), true, 'legacy radius remains supported');
  assert.equal(filters.passes(row('far', '예시도 다른구', { lat: 2, lng: 2 }), filters.DEFAULT_FILTERS, [legacy]), true, 'alert circles never hide map/list rows');
});

test('polygon membership handles holes and separate islands instead of accepting the bounding box', () => {
  const square = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const hole = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]];
  const polygon = { type: 'Polygon', coordinates: [square, hole] };
  assert.equal(pointInGeometry(polygon, 0.5, 0.5), true);
  assert.equal(pointInGeometry(polygon, 2, 2), false);
  assert.equal(pointInGeometry(polygon, 5, 2), false);
  const island = square.map(([x, y]) => [x + 10, y]);
  assert.equal(pointInGeometry({ type: 'MultiPolygon', coordinates: [[square], [island]] }, 2, 12), true);
  assert.equal(pointInGeometry({ type: 'MultiPolygon', coordinates: [[square], [island]] }, 2, 7), false);
});

test('public catalog binds canonical names/codes and provides all 25 district boundaries', () => {
  const catalog = regionCatalog();
  const gus = catalog.filter((r) => r.kind === 'gu');
  assert.equal(gus.length, 25);
  assert.equal(regionBoundaries.features.length, 25);
  for (const gu of gus) {
    const input = regionArea(gu.code);
    assert.deepEqual(canonicalRegion(input.region), gu);
    assert.equal(canonicalRegion({ ...gu, name: 'Forged name' }), null);
    assert.ok(regionBounds(gu.code));
    assert.ok(Number.isFinite(input.lat) && Number.isFinite(input.lng) && input.radiusM > 0);
    assert.ok(catalog.some((r) => r.kind === 'dong' && r.code.startsWith(gu.code)));
  }
  assert.equal(regionArea('99999'), null);
});

test('runner retains incidental raw rows, updates them and keeps alerts/baselines scoped', () => {
  const saved = new Map(), raw = new Map(), events = [], baselines = new Set(), gone = [];
  const store = {
    db: { transaction: (fn) => fn }, allVerdicts: () => [], hasBaseline: (key, id) => baselines.has(`${key}:${id}`),
    setBaseline: (key, id) => baselines.add(`${key}:${id}`), aptSpot: () => -1,
    getListing: (id) => saved.get(id), allListings: () => [...saved.values()], markGone: (ids) => gone.push(...ids),
    insertListing: (id, listing, key, sig, run, ref, body) => { saved.set(id, { id, source: listing.source, data: JSON.stringify(listing), price_sig: sig, status: 'active' }); raw.set(id, body); },
    updateListingSeen: (id, listing, key, sig, run, ref, changed, body) => { saved.set(id, { ...saved.get(id), data: JSON.stringify(listing), price_sig: sig }); raw.set(id, body); },
    addEvent: (run, id, type) => events.push({ id, type }),
  };
  const runner = compile('../server/runner.ts', { './db.js': store, '../shared/regions.js': regions, '../shared/types.js': types, './identity.js': identity, './config.js': { COLLECT_MARGIN_M: 500 } });
  const items = [row('target'), row('outside', '예시도 다른구 샘플동'), row('unknown', null)].map((listing) => ({ listing, raw: { payload: listing.sourceId } }));
  const news = [];
  const result = runner.applyResults(1, 'ziptoss', [...items, items[1]], [area], false, undefined, { isBaseline: () => false, news });
  assert.equal(result.kept, 3);
  assert.equal(result.incidentalCount, 2);
  assert.equal(result.newCount, 3);
  assert.equal(saved.size, 3);
  assert.equal(raw.get('ziptoss:outside').payload, 'outside');
  assert.deepEqual(events.map((e) => e.id), ['ziptoss:target', 'ziptoss:outside', 'ziptoss:unknown']);
  assert.equal(news.length, 3);
  const update = { ...items[1], listing: { ...items[1].listing, prices: [{ deal: 'monthly', deposit: 100, monthly: 20 }] }, raw: { payload: 'updated' } };
  runner.applyResults(2, 'ziptoss', [update], [area], false, undefined, { news });
  assert.equal(raw.get('ziptoss:outside').payload, 'updated');
  assert.equal(news.length, 4, 'incidental changes remain candidates for the independent alert gate');
  assert.equal(news[3].changeType, 'price_down');
  runner.applyResults(3, 'ziptoss', [], [area], true);
  assert.deepEqual(gone, ['ziptoss:target'], 'a complete selected-area run cannot expire incidental rows');
});
