import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const HOUR = 3600000;
const DAY = 24 * HOUR;

// Run the production modules with an in-memory store and synthetic responses.
// Unknown imports, real network access, and private configuration reads fail closed.
function load(file, imports, clock, globals = {}) {
  const source = fs.readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    module, exports: module.exports, Date: ClockDate, URLSearchParams,
    process: { env: {} }, AbortSignal: { timeout: () => undefined },
    setTimeout: (fn) => { queueMicrotask(fn); return 0; },
    fetch: async () => { throw new Error('Unexpected network request'); },
    require: (name) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected module import: ${name}`);
      return imports[name];
    },
    ...globals,
  });
  vm.runInContext(js, context, { filename: file });
  return module.exports;
}

function memorySettings() {
  const settings = new Map();
  return {
    settings,
    getSetting: (key) => settings.get(key) ?? null,
    setSetting: (key, value) => settings.set(key, value),
  };
}

const freshClock = () => ({ now: Date.parse('2030-01-01T00:00:00Z') });

test('KB partial and total failures retry after six hours; only full success advances freshness', async () => {
  const clock = freshClock();
  const store = memorySettings();
  const original = new Date(clock.now - 4 * DAY).toISOString();
  store.settings.set('kb_stats_fetched_at', original);
  const saved = new Map();
  store.replaceMarketSeries = (id, points) => saved.set(id, points);
  let calls = 0;
  let failure = 'partial';
  const kb = load('kb-stats.ts', { './db.js': store }, clock, {
    fetch: async (url) => {
      calls++;
      if (failure === 'all' || (failure === 'partial' && calls === 2)) return { ok: false, status: 503 };
      const kind = url.includes('/maktTrnd') ? 'buyer' : url.includes('/husScurlnPir') ? 'pir' : 'price';
      const data = {
        날짜리스트: ['20300101'],
        데이터리스트: [{ 지역코드: '99', 지역명: 'Synthetic Region', dataList: [kind === 'buyer' ? { 매수우위지수: 101 } : kind === 'pir' ? { KB아파트PIR: 8 } : 101] }],
        주택구매력리스트: [{ 지역코드: '99', 지역명: 'Synthetic Region', 지역구분리스트: [{ 매물종별구분: '아파트', 매물종별구분리스트: [100] }] }],
        주담보월소득리스트: [{ 기준날짜: '20300101', 주택담보대출금리: 3 }],
      };
      return { ok: true, status: 200, json: async () => ({ dataBody: { resultCode: '11000', data } }) };
    },
  });
  assert.equal(kb.kbStatsDue(), true);
  await kb.collectKbStats();
  assert.equal(calls, kb.SERIES.length);
  assert.ok(saved.size > 0);
  assert.equal(JSON.parse(store.settings.get('kb_stats_status')).ok, false);
  assert.equal(store.settings.get('kb_stats_fetched_at'), original);
  assert.equal(kb.kbStatsDue(), false);
  clock.now += 6 * HOUR - 1;
  assert.equal(kb.kbStatsDue(), false);
  clock.now++;
  assert.equal(kb.kbStatsDue(), true);

  failure = 'none';
  await kb.collectKbStats();
  assert.equal(JSON.parse(store.settings.get('kb_stats_status')).ok, true);
  assert.equal(store.settings.get('kb_stats_fetched_at'), new Date(clock.now).toISOString());
  assert.equal(kb.kbStatsDue(), false);
  clock.now += 3 * DAY;
  assert.equal(kb.kbStatsDue(), true);

  failure = 'all';
  await assert.rejects(kb.collectKbStats());
  assert.equal(kb.kbStatsDue(), false);
  clock.now += 6 * HOUR;
  assert.equal(kb.kbStatsDue(), true);
});

test('Court partial and malformed responses do not mark the result search complete', async () => {
  const clock = freshClock();
  const store = memorySettings();
  const original = new Date(clock.now - DAY).toISOString();
  store.settings.set('court_results_searched_at', original);
  let saved = [];
  Object.assign(store, {
    saveAuctionResults: (rows) => { saved = rows; }, auctionResultKeys: () => new Set(),
    rawBySource: () => new Map(), allListings: () => [],
    courtRegionStatRows: () => [{ gu: 'Synthetic Region', at: new Date(clock.now).toISOString() }],
  });
  const row = { docid: 'synthetic-1', boCd: 'synthetic-court', saNo: '1', maeGiil: '2030-01-01' };
  let body = { data: { dlt_srchResult: [row], dma_pageInfo: { totalCnt: 2 } } };
  const response = { json: async () => body, url: () => 'https://example.invalid/result', status: () => 200 };
  const session = {
    goto: async () => response, record: () => {}, pause: async () => {}, click: async () => {}, screenshot: async () => {},
    page: {
      waitForSelector: async () => ({}), url: () => 'https://example.invalid/',
      waitForResponse: async () => response,
      locator: () => ({ inputValue: async () => '40', count: async () => 0 }),
    },
  };
  const court = load('court-results.ts', {
    './config.js': { PAGE_DELAY_MS: 0 }, './db.js': store,
    './collectors/courtauction.js': {
      choose: async () => {}, closeNotices: async () => {}, ID: { pageSize: 'size', pageLink: (n) => `page-${n}` },
      lotsOf: (rows) => rows.map((r) => [r]), normalizeLot: () => ({ address: null, areaM2: null, lat: null, lng: null }), ymd: (value) => value,
    },
    './collectors/gus.js': { gusFor: () => [] },
    './collectors/types.js': { BlockedError: class extends Error {}, toNumber: (value) => value == null ? null : Number(value) },
    '../shared/types.js': { SEOUL: 'Synthetic Region', LAND_PREFIX: 'Land:', SHOP_PREFIX: 'Shop:' },
  }, clock);
  const ctx = { areas: [], session, progress: () => {} };
  const partial = await court.collectCourtResults(ctx, () => false);
  assert.match(partial, /2줄 중 1줄만/);
  assert.equal(saved.length, 1);
  assert.equal(store.settings.get('court_results_searched_at'), original);
  assert.equal(court.courtResultsDue(), false);
  clock.now += 6 * HOUR;
  assert.equal(court.courtResultsDue(), true);

  body = { data: { dlt_srchResult: [row], dma_pageInfo: { totalCnt: 1 } } };
  await court.collectCourtResults(ctx, () => false);
  const complete = store.settings.get('court_results_searched_at');
  assert.equal(complete, new Date(clock.now).toISOString());
  assert.equal(court.courtResultsDue(), false);

  body = { error: 'synthetic service error' };
  clock.now += HOUR;
  assert.match(await court.collectCourtResults(ctx, () => false), /매각결과검색 실패/);
  assert.equal(store.settings.get('court_results_searched_at'), complete);
  assert.equal(JSON.parse(store.settings.get('court_results_search_status')).ok, false);
  clock.now += 6 * HOUR;
  assert.equal(court.courtResultsDue(), true);

  body = { data: { dlt_srchResult: [], dma_pageInfo: { totalCnt: 0 } } };
  await court.collectCourtResults(ctx, () => false);
  assert.equal(JSON.parse(store.settings.get('court_results_search_status')).ok, true);
  clock.now += 5 * DAY;
  assert.equal(court.courtResultsDue(), true);
});

test('Parcel misses expire, errors back off, and changed coordinates refresh the parcel and its zone', async () => {
  const clock = freshClock();
  const store = memorySettings();
  const key = 'nv:synthetic';
  let point = { lat: 1, lng: 1 };
  const parcels = new Map([[key, { status: 'none', pnu: null, addr: null, error: null, checkedAt: new Date(clock.now - 30 * DAY).toISOString(), ...point }]]);
  const zones = new Map();
  const zoneWrites = [];
  Object.assign(store, {
    pointParcels: () => new Map(parcels), zoneChecks: () => new Map(zones),
    savePointParcel: (id, coordinates, parcel) => {
      if (parcels.get(id)?.pnu !== parcel.pnu) zones.delete(id);
      parcels.set(id, { ...parcel, ...coordinates });
    },
    saveZoneCheck: (id, pnu, zone) => { zones.set(id, zone); zoneWrites.push({ id, pnu }); },
  });
  let calls = 0;
  let mode = 'none';
  const newPnu = '0000000000000000002';
  const land = load('land-zones.ts', {
    'node:fs': { default: { readFileSync: () => { throw new Error('Private configuration access is forbidden'); } } },
    './config.js': { LOCAL_CONFIG_PATH: 'unused' }, './db.js': store,
    './collectors/types.js': { toNumber: (value) => value == null ? null : Number(value) },
    './views.js': { buildListingViews: () => [{ status: 'active', zone: { lot: key, basis: 'point', point, pnu: parcels.get(key)?.pnu } }] },
  }, clock, {
    process: { env: { HNW_VWORLD_KEY: 'synthetic-key', HNW_VWORLD_DOMAIN: 'https://example.invalid' } },
    fetch: async (url) => {
      calls++;
      if (mode === 'error') throw new Error('Synthetic connection failure');
      const body = url.includes('getLandUseAttr') ? { landUses: { field: [], totalCount: 0 } }
        : mode === 'none' ? { response: { status: 'NOT_FOUND' } }
          : { response: { status: 'OK', result: { featureCollection: { features: [{ properties: { pnu: newPnu, addr: 'Synthetic Parcel' } }] } } } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  await land.checkZones();
  assert.equal(calls, 1);
  await land.checkZones();
  assert.equal(calls, 1);

  clock.now += 30 * DAY;
  mode = 'error';
  await land.checkZones();
  assert.equal(calls, 2);
  assert.equal(parcels.get(key).status, 'error');
  await land.checkZones();
  assert.equal(calls, 2);
  clock.now += HOUR;
  await land.checkZones();
  assert.equal(calls, 3);

  parcels.set(key, { status: 'ok', pnu: '0000000000000000001', addr: 'Old Synthetic Parcel', error: null, checkedAt: new Date(clock.now).toISOString(), ...point });
  zones.set(key, { status: 'ok', zones: [], checkedAt: new Date(clock.now).toISOString(), error: null });
  point = { lat: 2, lng: 2 };
  mode = 'ok';
  await land.checkZones();
  assert.equal(calls, 5);
  assert.equal(parcels.get(key).pnu, newPnu);
  assert.deepEqual(zoneWrites.at(-1), { id: key, pnu: newPnu });
  await land.checkZones();
  assert.equal(calls, 5);
});
