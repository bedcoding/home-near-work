import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { parseZigbangStationIds } from '../server/zigbang-parse.ts';

// No production database or configuration is loaded. The production receiver runs
// against a transactional memory store; parsers and range filtering use synthetic rows.
function receiver({ initialDabangMax = 100 } = {}) {
  let rows = [];
  let saved = new Map();
  let runs = new Map();
  let settings = new Map();
  let calls = 0;
  let failReceipt = false;
  const notices = [];
  const area = { id: 1, name: 'Synthetic Region', lat: 36, lng: 128, radiusM: 500, enabled: true };
  const store = {
    db: { transaction(fn) { return () => {
      const before = structuredClone({ rows, saved, runs, settings, calls });
      try { return fn(); } catch (error) {
        ({ rows, saved, runs, settings, calls } = before);
        throw error;
      }
    }; } },
    getSetting: (key) => settings.get(key) ?? null,
    setSetting: (key, value) => {
      if (failReceipt && key === 'browse_receipts') throw new Error('synthetic storage failure');
      settings.set(key, value);
    },
    addNaverCaptures: (items) => rows.push(...items.map((r, i) => ({ ...r, id: rows.length + i + 1, parsed: false }))),
    pendingNaverCaptures: (site = 'naver') => rows.filter((r) => r.site === site && !r.parsed),
    markNaverCapturesParsed: (ids) => { for (const row of rows) if (ids.includes(row.id)) row.parsed = true; },
    enabledAreas: () => [area],
    aptGus: () => [],
    naverRunFor: () => settings.get('run') ?? null,
    setNaverRun: (_day, id) => settings.set('run', id),
    createRun: () => 1,
    getRun: (id) => runs.get(id),
    finishRun: (id, status, summary, error, log) => runs.set(id, { id, status, summary, error, log }),
    naverCluster: () => ({ id: 'known' }),
    lastNaverListAt: () => null,
    saveNaverCluster: () => {},
    maxNumericSourceId: (source) => {
      const ids = [...saved.keys()].filter((key) => key.startsWith(`${source}:`)).map((key) => Number(key.split(':')[1]));
      if (source === 'dabang' && initialDabangMax != null) ids.push(initialDabangMax);
      return ids.length ? Math.max(...ids) : null;
    },
    touchListings: () => {},
  };
  const parsed = (body) => {
    const data = JSON.parse(body);
    return { items: data.items.map((listing) => ({ listing, raw: listing, numbers: [listing.sourceId] })), total: data.items.length };
  };
  const applyResults = (_run, source, items, _areas, _complete, _extra, options) => {
    calls++;
    const eligible = new Map(items.filter((i) => i.listing.inRange).map((i) => [i.listing.sourceId, i.listing]));
    let fresh = 0;
    let changed = 0;
    for (const [id, listing] of eligible) {
      const key = `${source}:${id}`;
      const old = saved.get(key);
      const isNew = !old && !options.isBaseline(listing);
      const isChanged = !!old && old.price !== listing.price;
      fresh += Number(isNew);
      changed += Number(isChanged);
      if (isNew || isChanged) options.news?.push({ type: 'listing', listing, changed: isChanged });
      saved.set(key, listing);
    }
    return { source, status: 'ok', fetched: items.length, kept: eligible.size, newCount: fresh, priceChanged: changed, relisted: 0 };
  };
  const imports = {
    'node:fs': { existsSync: () => false }, 'node:path': path,
    './config.js': { DASHBOARD_URL: 'http://example.invalid', DATA_DIR: '/synthetic-data', ROOT: '/synthetic-root' },
    './db.js': store,
    './alerts.js': { alertSettings: () => ({ captureSites: true }), matchesAlert: () => true },
    './capture-news.js': {
      compareCount: () => null, compareNaverClusters: () => ({ compared: [], increase: 0 }),
      kbAreaCount: () => null, naverClusterCounts: () => null, readMarks: () => ({}), readViews: () => ({}),
      saveCaptureNews: () => {}, writeMarks: () => {}, writeViews: () => {},
    },
    './dabang-parse.js': { parseDabangRoomList: parsed },
    './naver-parse.js': { parseNaverList: parsed },
    './zigbang-parse.js': { parseZigbangItems: (body) => parsed(body).items, parseZigbangStationIds },
    './link-hints.js': { learnLinkHints: () => {}, zigbangStationName: () => null },
    './notify.js': { notify: (...args) => notices.push(args) },
    './runner.js': { applyResults, coveringArea: () => area },
    './line-areas.js': { activeLineAreas: () => [] },
    '../shared/types.js': { isApartmentType: () => false, seoulGuOf: () => null },
  };
  const source = fs.readFileSync(new URL('../server/naver-capture.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module, exports: module.exports, URL, setTimeout: () => 1, clearTimeout: () => {},
    require(name) { assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name]; },
  }, { filename: 'naver-capture.ts' });
  return { api: module.exports, store, notices, rows: () => rows, calls: () => calls,
    failReceipt: (value) => { failReceipt = value; } };
}

const listing = (id = '1', inRange = true, price = 100) => ({ sourceId: id, inRange, price, lat: 36, lng: 128, prices: [] });
function capture(site = 'naver', items = [listing()]) {
  return { site, status: 200, pageUrl: `https://${site === 'naver' ? 'fin.land.naver.com' : 'www.dabangapp.com'}/map`,
    url: site === 'naver' ? 'https://fin.land.naver.com/front-api/v1/clusteredArticles' : 'https://www.dabangapp.com/api/v5/room-list/search',
    requestBody: JSON.stringify({ clusterId: 'known' }), body: JSON.stringify({ items }) };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const zigbangCapture = (station, items) => ({
  site: 'zigbang', status: 200, pageUrl: 'https://www.zigbang.com/home/oneroom/subways/123/items',
  url: `https://apis.zigbang.com/house/property/v1/items/${station ? 'subways/123/onerooms?radius=0.5' : 'list'}`,
  body: JSON.stringify({ items: station ? items.map((id) => ({ id })) : items }),
});

test('receipts confirm in-range writes and an acknowledged batch can replay without duplicate effects', () => {
  const r = receiver();
  const batch = { jobId: 'job-1', batchId: 'batch-1', captures: [capture('naver', [listing(), listing('2', false)])] };
  const receipt = r.api.acceptBrowseCaptures(batch);
  assert.deepEqual(plain(receipt), { responses: 1, listings: 1, newCount: 1, changedCount: 0 });
  assert.equal(r.calls(), 1);
  assert.deepEqual(plain(r.api.acceptBrowseCaptures(batch)), plain(receipt));
  assert.equal(r.calls(), 1);
  assert.equal(r.rows().length, 1);
  const updated = r.api.acceptBrowseCaptures({ ...batch, batchId: 'batch-2', captures: [capture('naver', [listing('1', true, 200)])] });
  assert.deepEqual(plain(updated), { responses: 2, listings: 2, newCount: 1, changedCount: 1 });
  assert.deepEqual(plain(r.api.browseReceipt('job-1')), plain(updated));
});

test('manual pending work is drained outside a browse receipt and tour batches suppress notifications', () => {
  const r = receiver();
  r.api.acceptCaptures([capture('dabang', [listing('101')])]);
  assert.equal(r.calls(), 0);
  const receipt = r.api.acceptBrowseCaptures({ jobId: 'job-1', batchId: 'batch-1', captures: [capture('dabang', [listing('102')])] });
  assert.equal(r.calls(), 2);
  assert.equal(receipt.listings, 1);
  assert.equal(receipt.responses, 1);
  assert.equal(r.notices.length, 1, 'only pre-existing manual work notifies');
  assert.equal(r.rows().every((row) => row.parsed), true);
});

test('receipt write failure rolls back captured data and can safely retry the same batch', () => {
  const r = receiver();
  const batch = { jobId: 'job-1', batchId: 'batch-1', captures: [capture()] };
  r.failReceipt(true);
  assert.throws(() => r.api.acceptBrowseCaptures(batch), /synthetic storage failure/);
  assert.equal(r.rows().length, 0);
  assert.equal(r.api.browseReceipt('job-1'), null);
  r.failReceipt(false);
  assert.deepEqual(plain(r.api.acceptBrowseCaptures(batch)), { responses: 1, listings: 1, newCount: 1, changedCount: 0 });
});

test('invalid jobs and response counts are rejected without storing payloads; unapproved hosts are not counted', () => {
  const r = receiver();
  for (const bad of ['', '../secret', 'x'.repeat(121), null]) assert.throws(() => r.api.acceptBrowseCaptures({ jobId: bad, batchId: 'batch', captures: [] }));
  assert.throws(() => r.api.acceptBrowseCaptures({ jobId: 'job', batchId: 'batch', captures: Array(201).fill(capture()) }));
  const receipt = r.api.acceptBrowseCaptures({ jobId: 'job', batchId: 'batch', captures: [{ ...capture(), url: 'https://example.invalid/clusteredArticles' }] });
  assert.deepEqual(plain(receipt), { responses: 0, listings: 0, newCount: 0, changedCount: 0 });
  assert.equal(r.rows().length, 0);
});

test('Zigbang station IDs arriving before details keep new-listing attribution across durable batches', () => {
  const r = receiver();
  r.store.setSetting('zigbang_station_ids', JSON.stringify({ 'zigbang|123|radius=0.5': [101] }));
  const ids = { jobId: 'station-tour', batchId: 'ids', captures: [zigbangCapture(true, [101, 102])] };
  assert.deepEqual(plain(r.api.acceptBrowseCaptures(ids)), { responses: 1, listings: 0, newCount: 0, changedCount: 0 });

  // A replayed ID response sees the updated station baseline, so the per-job ledger
  // must retain 102 as fresh until the separately delivered detail response arrives.
  r.api.acceptBrowseCaptures(ids);
  const receipt = r.api.acceptBrowseCaptures({ jobId: 'station-tour', batchId: 'details', captures: [zigbangCapture(false, [listing('101'), listing('102')])] });
  assert.deepEqual(plain(receipt), { responses: 2, listings: 2, newCount: 1, changedCount: 0 });
  assert.equal(r.notices.length, 0);

  // Fresh IDs belong to that job, not unrelated browsing of another station.
  const unrelated = r.api.acceptBrowseCaptures({ jobId: 'other-tour', batchId: 'details', captures: [zigbangCapture(false, [listing('103')])] });
  assert.equal(unrelated.newCount, 0);
});

test('failed Zigbang ID batch rolls back its station baseline and freshness before safe retry', () => {
  const r = receiver();
  const baseline = JSON.stringify({ 'zigbang|123|radius=0.5': [101] });
  r.store.setSetting('zigbang_station_ids', baseline);
  const batch = { jobId: 'station-tour', batchId: 'ids', captures: [zigbangCapture(true, [101, 102])] };
  r.failReceipt(true);
  assert.throws(() => r.api.acceptBrowseCaptures(batch), /synthetic storage failure/);
  assert.equal(r.store.getSetting('zigbang_station_ids'), baseline);
  r.failReceipt(false);
  r.api.acceptBrowseCaptures(batch);
  const result = r.api.acceptBrowseCaptures({ jobId: 'station-tour', batchId: 'details', captures: [zigbangCapture(false, [listing('102')])] });
  assert.equal(result.newCount, 1);
});

test('Dabang later pages compare against the initial job baseline, including a completely new area', () => {
  for (const initialDabangMax of [100, null]) {
    const r = receiver({ initialDabangMax });
    r.api.acceptBrowseCaptures({ jobId: 'dabang-tour', batchId: 'first', captures: [capture('dabang', [listing('130')])] });
    const result = r.api.acceptBrowseCaptures({ jobId: 'dabang-tour', batchId: 'second', captures: [capture('dabang', [listing('120')])] });
    assert.deepEqual(plain(result), { responses: 2, listings: 2, newCount: initialDabangMax == null ? 0 : 2, changedCount: 0 });
    const next = r.api.acceptBrowseCaptures({ jobId: 'next-tour', batchId: 'first', captures: [capture('dabang', [listing('125')])] });
    assert.equal(next.newCount, 0, 'a new job must take its own current baseline');
  }
});
