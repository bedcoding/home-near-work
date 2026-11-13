import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLECTORS } from '../server/collectors/index.ts';
import { RUN_ALL_SOURCES, RUN_PARALLEL_SITES, RUN_SCOPES } from '../shared/types.ts';
import { collectionPriceLimitsChange, collectionPriceLimitsKey, collectionPriceLimitsState, collectionPriceLimitsToken, collectionPriceOverrides, runCollectionPriceLimits, validateCommonPriceLimits } from '../server/collection-price-limits.ts';

test('common collection prices replace site defaults only for selected sites that accept price limits', () => {
  const caps = { saleMax: null, jeonseMax: 21000, monthlyDepositMax: 0, monthlyMax: 50, excludeSale: false };
  const common = { ...caps, monthlyMax: 30 };
  const read = key => key === collectionPriceLimitsKey('dabang') ? JSON.stringify(caps) : null;
  const sites = ['dabang', 'zigbang', 'daangn', 'courtauction'];
  assert.deepEqual(validateCommonPriceLimits(common, sites), common);
  assert.throws(() => validateCommonPriceLimits(common, ['daangn']), /적용할 매물 사이트/);
  assert.throws(() => validateCommonPriceLimits(common, ['onbid']), /적용할 매물 사이트/);
  assert.throws(() => validateCommonPriceLimits({ ...common, monthlyMax: -1 }, sites), /상한/);
  assert.deepEqual(runCollectionPriceLimits(read, sites, 'home', { dabang: null }, common).limits,
    { dabang: common, zigbang: common });
  assert.deepEqual(runCollectionPriceLimits(read, sites, 'rentOnly', {}, common).limits,
    { dabang: { ...common, excludeSale: true }, zigbang: { ...common, excludeSale: true } });
  assert.deepEqual(runCollectionPriceLimits(read, sites, 'home').limits, { dabang: caps });
});

test('collection prices preserve zero caps and accept changes only for supported sites', () => {
  const limits = { saleMax: 1000000, jeonseMax: 21000, monthlyDepositMax: 0, monthlyMax: 50, excludeSale: false };
  const change = collectionPriceLimitsChange({ source: 'dabang', limits });
  const zigbang = collectionPriceLimitsChange({ source: 'zigbang', limits: { ...limits, monthlyMax: 55 } });
  const data = new Map([change, zigbang].map(row => [collectionPriceLimitsKey(row.source), JSON.stringify(row.limits)]));
  const read = key => data.get(key) ?? null;
  assert.deepEqual(collectionPriceLimitsState(read), { upstreamSites: ['dabang', 'zigbang'], limits: { dabang: limits, zigbang: zigbang.limits } });
  assert.deepEqual(collectionPriceLimitsState(read, ['zigbang']).limits, { zigbang: zigbang.limits });
  assert.throws(() => collectionPriceLimitsChange({ source: 'daangn', limits }), /지원/);
  for (const invalid of [-1, 0.5, '50', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => collectionPriceLimitsChange({ source: 'dabang', limits: { ...limits, monthlyMax: invalid } }), /상한/);
  }
  const reset = collectionPriceLimitsChange({ source: 'dabang', limits: null });
  data.set(collectionPriceLimitsKey(reset.source), JSON.stringify(reset.limits));
  assert.deepEqual(collectionPriceLimitsState(read).limits, { zigbang: zigbang.limits });
});

test('collection price tokens detect effective changes within the selected sources', () => {
  const source = 'dabang';
  const unset = { saleMax: null, jeonseMax: null, monthlyDepositMax: null, monthlyMax: null, excludeSale: false };
  const key = collectionPriceLimitsKey(source);
  const data = new Map();
  const read = setting => data.get(setting) ?? null;
  const token = sources => collectionPriceLimitsToken(collectionPriceLimitsState(read, sources).limits);

  const empty = token([source]);
  assert.match(empty, /^[0-9a-f]{64}$/);
  assert.equal(collectionPriceLimitsToken({ [source]: unset }), empty);

  const caps = { ...unset, saleMax: 50000, monthlyMax: 30 };
  data.set(key, JSON.stringify(caps));
  const first = token([source]);
  assert.notEqual(first, empty);
  assert.equal(token([]), empty);
  assert.equal(collectionPriceLimitsToken({ [source]: { monthlyMax: 30, saleMax: 50000, excludeSale: false, jeonseMax: null, monthlyDepositMax: null } }), first);
  const otherCaps = { ...unset, jeonseMax: 7500 };
  assert.equal(collectionPriceLimitsToken({ [source]: caps, zigbang: otherCaps }), collectionPriceLimitsToken({ zigbang: otherCaps, [source]: caps }));

  data.set(key, JSON.stringify({ ...caps, monthlyMax: 0 }));
  assert.notEqual(token([source]), first);
  assert.equal(token([]), empty);

  data.set(key, JSON.stringify({ ...caps, excludeSale: true }));
  const withoutSale = token([source]);
  assert.notEqual(withoutSale, first);
  data.set(key, JSON.stringify({ ...caps, saleMax: 60000, excludeSale: true }));
  assert.equal(token([source]), withoutSale);
  data.set(key, 'null');
  assert.equal(token([source]), empty);
});

test('rental-only preview and runner use a sale exclusion independent of the stored cap', () => {
  const caps = { saleMax: 50000, jeonseMax: 21000, monthlyDepositMax: 0, monthlyMax: 50, excludeSale: false };
  const read = key => key === collectionPriceLimitsKey('dabang') ? JSON.stringify(caps) : null;
  const selected = ['dabang', 'daangn'];
  assert.deepEqual(runCollectionPriceLimits(read, selected, 'rentOnly').limits, { dabang: { ...caps, excludeSale: true } });
  assert.deepEqual(runCollectionPriceLimits(read, selected, 'home').limits, { dabang: caps });
  assert.equal(runCollectionPriceLimits(() => null, ['dabang'], 'rentOnly').limits.dabang?.excludeSale, true);
  assert.equal(runCollectionPriceLimits(() => null, ['zigbang'], 'rentOnly').limits.zigbang?.excludeSale, true);
  assert.deepEqual(runCollectionPriceLimits(read, ['daangn'], 'rentOnly').limits, {});
});

test('temporary price overrides accept only enabled sites in the run and validate the whole condition', () => {
  const caps = { saleMax: null, jeonseMax: 20000, monthlyDepositMax: 0, monthlyMax: 55, excludeSale: false };
  assert.deepEqual(collectionPriceOverrides(undefined, ['dabang']), {});
  assert.deepEqual(collectionPriceOverrides({ dabang: caps, zigbang: null }, ['dabang', 'zigbang']), { dabang: caps, zigbang: null });
  assert.throws(() => collectionPriceOverrides({ zigbang: caps }, ['dabang']), /사이트/);
  assert.throws(() => collectionPriceOverrides({ daangn: caps }, ['daangn']), /사이트/);
  assert.throws(() => collectionPriceOverrides(JSON.parse('{"__proto__":null}'), ['dabang']), /사이트/);
  assert.throws(() => collectionPriceOverrides([{ dabang: caps }], ['dabang']), /가격 조건/);
  assert.throws(() => collectionPriceOverrides({ dabang: { ...caps, monthlyMax: -1 } }, ['dabang']), /상한/);
  assert.throws(() => collectionPriceOverrides({ dabang: { monthlyMax: 20, excludeSale: false } }, ['dabang']), /상한/);
});

test('temporary price overrides replace or clear saved caps without weakening rental-only scope', () => {
  const saved = { saleMax: 45000, jeonseMax: 18000, monthlyDepositMax: null, monthlyMax: 80, excludeSale: true };
  const edited = { ...saved, monthlyMax: 55, excludeSale: false };
  const read = key => key === collectionPriceLimitsKey('dabang') ? JSON.stringify(saved) : null;
  const selected = ['dabang', 'zigbang'];
  const overrides = collectionPriceOverrides({ dabang: edited, zigbang: null }, selected);
  assert.deepEqual(runCollectionPriceLimits(read, selected, 'home', overrides).limits, { dabang: edited });
  assert.deepEqual(runCollectionPriceLimits(read, selected, 'rentOnly', overrides).limits, {
    dabang: { ...edited, excludeSale: true },
    zigbang: { saleMax: null, jeonseMax: null, monthlyDepositMax: null, monthlyMax: null, excludeSale: true },
  });
  assert.deepEqual(runCollectionPriceLimits(read, selected, 'home', { dabang: null }).limits, {});
  assert.deepEqual(runCollectionPriceLimits(read, selected, 'home').limits, { dabang: saved });
});

test("화면에 적는 '조회하기' 사이트 목록이 실제로 도는 수집기와 순서까지 같다", () => {
  assert.deepEqual(COLLECTORS.map((c) => c.id), RUN_ALL_SOURCES);
});

test('탭 하나만 조회의 사이트는 모두 전부 조회에 들어 있다', () => {
  for (const scope of RUN_SCOPES) for (const id of scope.sources) assert.ok(RUN_ALL_SOURCES.includes(id), `${scope.id}: ${id}`);
});

test('빠른 조회 전월세만은 전월세 사이트만 돌고 고방(고시원), 경매, 공고는 돌지 않는다', () => {
  const quick = RUN_SCOPES.find((s) => s.id === 'rentOnly');
  assert.ok(quick?.quick);
  assert.deepEqual(quick.sources, ['dabang', 'zigbang', 'ziptoss', 'peterpanz', 'daangn']);
  assert.deepEqual(quick.sections, []);
  assert.deepEqual(quick.tabs, []);
});

test('당근: 수집용 지역마다 반경 네모 범위로 지도 매물 목록을 열고, 가까운 아는 역 화면을 길로 쓴다', async () => {
  const { daangnBox, daangnFeedUrl, daangnTargets } = await import('../server/collectors/daangn.ts');
  const box = daangnBox({ lat: 35, lng: 128, radiusM: 1000 });
  assert.equal(box.zoom, 15);
  assert.equal(daangnBox({ lat: 35, lng: 128, radiusM: 2000 }).zoom, 14);
  assert.equal(daangnBox({ lat: 35, lng: 128, radiusM: 3800 }).zoom, 13);
  const url = new URL(daangnFeedUrl('가상역', box));
  assert.equal(decodeURIComponent(url.pathname), '/map/subway/가상', '역 화면 주소는 끝의 역을 뺀 이름');
  assert.deepEqual(url.searchParams.get('region_bounds').split(',').map((v) => Math.round(Number(v) * 1000) / 1000), [34.991, 127.989, 35.009, 128.011, 15]);

  const st = (name, lat, lng) => ({ name, lat, lng });
  const gu = { id: 1, name: '가상 구', lat: 35, lng: 128, radiusM: 3000, enabled: true, purpose: 'collection', region: { kind: 'gu', code: '99999', name: '가상 구' } };
  const alert = { id: 2, name: '알림 역', lat: 35.01, lng: 128, radiusM: 2500, enabled: true, purpose: 'alert' };
  const targets = daangnTargets([gu, alert], [st('먼역', 35.2, 128), st('가상역', 35.002, 128)]);
  assert.deepEqual(targets.map((t) => [t.area.id, t.station?.name]), [[1, '가상역']], '구가 있으면 알림용 역 반경은 따로 돌지 않는다');
  assert.equal(daangnTargets([{ ...gu, lat: 36 }], [st('가상역', 35.002, 128)])[0].station, null, '5km 안에 아는 역이 없으면 길을 못 찾는다');
});

test('동시에 도는 사이트 수는 1 이상', () => {
  assert.ok(Number.isInteger(RUN_PARALLEL_SITES) && RUN_PARALLEL_SITES >= 1);
});

test('피터팬: 역 근처 지도만 통과하고, 역이 들어 있어도 서울 전체로 열린 지도는 다시 연다', async () => {
  const { openedNear } = await import('../server/collectors/peterpanz.ts');
  const area = { id: 1, name: '가상역', lat: 35, lng: 128, radiusM: 1000, enabled: true };
  const box = (dLat, dLng) => ({ latitudeFrom: area.lat - dLat, latitudeTo: area.lat + dLat, longitudeFrom: area.lng - dLng, longitudeTo: area.lng + dLng });
  assert.equal(openedNear(area, box(0.0126, 0.017), 15), true); // 남북 약 2.8km
  assert.equal(openedNear(area, box(0.025, 0.033), 14), true); // 남북 약 5.5km
  assert.equal(openedNear(area, box(0.1, 0.13), 15), false); // 남북 약 22km(서울 전체)
  assert.equal(openedNear(area, { ...box(0.0126, 0.017), latitudeFrom: area.lat + 0.01 }, 15), false); // 역이 지도 밖
  assert.equal(openedNear(area, null, 15), false);
});
