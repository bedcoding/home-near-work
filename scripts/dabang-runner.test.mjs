import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as types from '../shared/types.ts';
import * as regions from '../shared/regions.ts';
import * as identity from '../server/identity.ts';
import * as collectionPriceLimits from '../server/collection-price-limits.ts';

const code = ts.transpileModule(fs.readFileSync(new URL('../server/runner.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const monthly = { deal: 'monthly', deposit: 100, monthly: 30, price: null };
const jeonse = { deal: 'jeonse', deposit: 10000, monthly: null, price: null };
const sale = { deal: 'sale', deposit: null, monthly: null, price: 20000 };
const short = { deal: 'short', deposit: 100, monthly: 40, price: null };

async function run({
  skipWrite = false, wrongRun = false, auto = false, limits = null, priceOverrides, commonPriceLimits, scope = 'dabang',
  source = 'dabang', offers = [[monthly]],
} = {}) {
  const rows = new Map(), gone = [], notes = [];
  const settingWrites = [];
  let goneChecks = 0;
  let savedLimits = limits;
  let collectorLimits;
  const area = { id: 1, name: '가상구', lat: 35, lng: 128, radiusM: 1, enabled: true, purpose: 'collection',
    region: { kind: 'gu', code: '99123', sido: '예시도', sigungu: '가상구', dong: null, name: '예시도 가상구' } };
  const listings = offers.map((prices, i) => ({
    source, sourceId: String(101 + i), title: 'Synthetic listing', address: '예시도 다른구 가상동',
    lat: 36, lng: 129, url: 'https://example.invalid/listing', buildingType: '아파트', prices,
  }));
  const collector = { id: source, label: types.SOURCE_LABEL[source], emptyOk: source === 'dabang', retainMissing: source === 'dabang', collect: async ctx => {
    collectorLimits = ctx.priceLimits;
    ctx.coverage({ areaId: 1, areaName: '가상구', category: 'apt', label: '아파트', pages: 1, totalPages: 1,
      total: listings.length, received: listings.length, stored: 0, complete: true, reason: 'verified' }, listings.map(listing => listing.sourceId));
    return listings.map(listing => ({ listing, raw: { seq: listing.sourceId }, pageUrl: 'https://example.invalid/data', screenshot: null }));
  } };
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const store = {
    enabledAreas: () => [area], createRun: () => 12, aptGus: () => [], allVerdicts: () => [],
    db: { transaction: fn => fn }, getListing: id => rows.get(id), allListings: () => [...rows.values()],
    insertListing: (id, listing, key, sig, runId) => { if (!skipWrite) rows.set(id, { source: listing.source, data: JSON.stringify(listing), price_sig: sig, last_seen_run: wrongRun ? 11 : runId }); },
    hasBaseline: () => false, setBaseline() {}, aptSpot: () => -1, markGone: ids => { goneChecks++; gone.push(...ids); },
    tidyListings: () => ({ stale: 0, purged: 0 }), finishRun: (_id, _status, summary) => finish(summary),
    getSetting: key => key === collectionPriceLimits.collectionPriceLimitsKey('dabang') ? JSON.stringify(savedLimits) : null,
    setSetting: key => { settingWrites.push(key); }, addEvent() {},
  };
  const dependencies = {
    './db.js': store, './collectors/index.js': { COLLECTORS: [collector] }, './collectors/notices.js': { NOTICE_COLLECTORS: [] },
    './collection-price-limits.js': collectionPriceLimits,
    './browser.js': { restSeconds: () => 0, BrowserSession: { open: async () => { const tab = { banner: async () => {}, close: async () => {}, closePage: async () => {}, fork: async () => tab }; return tab; } } },
    './collectors/types.js': { BlockedError: class extends Error {} },
    '../shared/types.js': types, '../shared/regions.js': regions, './identity.js': identity,
    './config.js': { COLLECT_MARGIN_M: 500 }, './geo.js': { distanceM: () => 10000 },
    './collectors/gus.js': { gusFor: () => [], nearNamesFor: () => [] },
    './building-register.js': { registryKey: () => null }, './land-zones.js': { vworldKey: () => null },
    './alerts.js': { buildAlerts: () => [], coveredRows: () => new Set(), alertSettings: () => ({}) },
    './notify.js': { notify: (...args) => notes.push(args) },
  };
  const context = { exports: {}, console: { log() {} }, require: id => dependencies[id] ?? {} };
  vm.runInNewContext(code, context);
  context.exports.startRun(false, auto ? undefined : scope, { quiet: true, auto, priceOverrides, commonPriceLimits });
  savedLimits = null;
  const summary = await completed;
  return { summary, rows, gone, notes, collectorLimits, goneChecks, settingWrites };
}

test('Dabang server collection persists incidental rows and reads storage back before declaring complete', async () => {
  const f = await run();
  assert.equal(f.rows.size, 1);
  assert.equal(f.summary.complete, true, JSON.stringify(f.summary));
  const source = f.summary.sources[0];
  assert.equal(source.kept, 1);
  assert.equal(source.incidentalCount, 1);
  assert.equal(source.coverage[0].stored, 1);
  assert.equal(source.coverage[0].complete, true);
  assert.equal(f.gone.length, 0);
  assert.equal(f.notes.length, 0);
});

test('missing or previously stored rows cannot satisfy the current collection storage proof', async () => {
  for (const options of [{ skipWrite: true }, { wrongRun: true }]) {
    const f = await run(options);
    assert.equal(f.summary.complete, false);
    assert.equal(f.summary.retryable, true);
    assert.equal(f.summary.sources[0].status, 'error');
    assert.equal(f.summary.sources[0].coverage[0].stored, 0);
    assert.equal(f.summary.sources[0].coverage[0].complete, false);
    assert.equal(f.gone.length, 0);
  }
});

test('manual and automatic runs keep the collection limits saved when the run starts', async () => {
  const limits = { saleMax: null, jeonseMax: 21000, monthlyDepositMax: 4000, monthlyMax: 50, excludeSale: true };
  for (const auto of [false, true]) {
    const f = await run({ auto, limits });
    assert.deepEqual(f.collectorLimits, limits);
    assert.deepEqual(f.summary.sources[0].collectionPriceLimits, limits);
  }
});

test('a rental-only run makes the provider request exclude sale without dropping saved rental caps', async () => {
  const limits = { saleMax: 50000, jeonseMax: 21000, monthlyDepositMax: 4000, monthlyMax: 50, excludeSale: false };
  const f = await run({ scope: 'rentOnly', limits });
  assert.deepEqual(f.collectorLimits, { ...limits, excludeSale: true });
  assert.deepEqual(f.summary.sources[0].collectionPriceLimits, f.collectorLimits);
});

test('common price limits reach a supported collector without filtering responses from other sites', async () => {
  const commonPriceLimits = { saleMax: null, jeonseMax: null, monthlyDepositMax: null, monthlyMax: 20, excludeSale: true };
  const native = await run({ commonPriceLimits, offers: [[{ ...monthly, monthly: 20 }]] });
  assert.deepEqual(native.collectorLimits, commonPriceLimits);
  assert.deepEqual(native.summary.sources[0].collectionPriceLimits, commonPriceLimits);
  assert.deepEqual(native.settingWrites, []);

  const other = await run({ scope: 'home', source: 'daangn', commonPriceLimits, offers: [[monthly], [sale]] });
  assert.equal(other.collectorLimits, undefined);
  assert.equal(other.summary.sources[0].collectionPriceLimits, undefined);
  assert.equal(other.summary.sources[0].coverage[0].complete, true);
  assert.deepEqual([...other.rows.keys()], ['daangn:101', 'daangn:102']);
});

test('a run passes edited prices to the collector and records the effective conditions without saving them as defaults', async () => {
  const limits = { saleMax: 50000, jeonseMax: 21000, monthlyDepositMax: 4000, monthlyMax: 50, excludeSale: false };
  const edited = { ...limits, monthlyMax: 35 };
  const oneRun = await run({ limits, priceOverrides: { dabang: edited } });
  assert.deepEqual(oneRun.collectorLimits, edited);
  assert.deepEqual(oneRun.summary.sources[0].collectionPriceLimits, edited);
  assert.ok(!oneRun.settingWrites.includes(collectionPriceLimits.collectionPriceLimitsKey('dabang')));

  const cleared = await run({ limits, priceOverrides: { dabang: null } });
  assert.equal(cleared.collectorLimits, undefined);
  assert.equal(cleared.summary.sources[0].collectionPriceLimits, null);
  assert.ok(!cleared.settingWrites.includes(collectionPriceLimits.collectionPriceLimitsKey('dabang')));
});

test('rental-only storage keeps mixed offers, excludes sale and short stays, and verifies only eligible storage', async () => {
  const offers = [[sale], [monthly, sale], [jeonse], [short]];
  const f = await run({ scope: 'rentOnly', source: 'daangn', offers });
  assert.deepEqual([...f.rows.keys()], ['daangn:102', 'daangn:103']);
  assert.deepEqual(JSON.parse(f.rows.get('daangn:102').data).prices, [monthly, sale]);
  assert.equal(f.goneChecks, 0);
  const summary = f.summary.sources[0];
  assert.equal(summary.fetched, 4);
  assert.equal(summary.kept, 2);
  assert.equal(summary.coverage[0].received, 4);
  assert.equal(summary.coverage[0].stored, 2);
  assert.equal(summary.coverage[0].complete, true);
  assert.match(summary.coverage[0].reason, /전월세 조건으로 2건 제외/);
  assert.equal(f.summary.complete, true);
  assert.equal(f.summary.retryable, false);

  const unfiltered = await run({ scope: 'home', source: 'daangn', offers });
  assert.equal(unfiltered.rows.size, 4);
  assert.equal(unfiltered.goneChecks, 1);

  const failedWrite = await run({ scope: 'rentOnly', source: 'daangn', offers, skipWrite: true });
  assert.equal(failedWrite.summary.complete, false);
  assert.equal(failedWrite.summary.retryable, true);
  assert.match(failedWrite.summary.sources[0].coverage[0].reason, /서버 저장 0\/2건 확인/);
});

test('rental-only succeeds with a populated sale-only response and retains empty collector failure semantics', async () => {
  const saleOnly = await run({ scope: 'rentOnly', source: 'daangn', offers: [[sale]] });
  assert.equal(saleOnly.summary.complete, true);
  assert.equal(saleOnly.summary.sources[0].kept, 0);
  assert.equal(saleOnly.summary.sources[0].coverage[0].complete, true);

  const empty = await run({ scope: 'rentOnly', source: 'daangn', offers: [] });
  assert.equal(empty.summary.complete, false);
  assert.match(empty.summary.sources[0].error, /받은 매물이 0건/);
});
