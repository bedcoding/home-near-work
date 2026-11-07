import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { parseZigbangStationIds, parseZigbangItemRows } from '../server/zigbang-parse.ts';
import * as zigbangCoverage from '../server/zigbang-coverage.ts';
import * as daangnParse from '../server/daangn-parse.ts';
import { parseDabangRoomList } from '../server/dabang-parse.ts';
import * as browseScope from '../server/browse-scope.ts';
import naverLedger from '../server/naver-ledger.ts';
import { parseNaverList } from '../server/naver-parse.ts';
import {target as naverTarget,page as naverPage} from './fixtures/naver-region.mjs';
import {selectedFilter} from './fixtures/naver-context.mjs';

// No production database or configuration is loaded. The production receiver runs
// against a transactional memory store; parsers and range filtering use synthetic rows.
function receiver({ initialDabangMax = 100, skipWrites = false, noAreas = false, regionMode = false } = {}) {
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
    enabledAreas: () => noAreas ? [] : [area],
    getListing: (id) => saved.has(id) ? { data: JSON.stringify(saved.get(id)), last_seen_run: 1 } : undefined,
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
    return data.items ? { items: data.items.map((listing) => ({ listing, raw: listing, numbers: [listing.sourceId] })), total: data.items.length } : parseNaverList(body);
  };
  const applyResults = (_run, source, items, _areas, _complete, _extra, options) => {
    calls++;
    const eligible = new Map(items.map((i) => [i.listing.sourceId, i.listing]));
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
      if (!skipWrites) saved.set(key, listing);
    }
    return { source, status: 'ok', fetched: items.length, kept: eligible.size, newCount: fresh, priceChanged: changed, relisted: 0 };
  };
  const imports = {
    './naver-ledger.js': naverLedger,
    'node:fs': { existsSync: () => false }, 'node:path': path,
    './config.js': { DASHBOARD_URL: 'http://example.invalid', DATA_DIR: '/synthetic-data', ROOT: '/synthetic-root' },
    './db.js': store,
    './alerts.js': { alertSettings: () => ({ captureSites: true, priceChanges: true }), matchesAlert: (listing) => listing.inRange ?? (listing.lat === 36 && listing.lng === 128) },
    './capture-news.js': {
      compareCount: () => null, compareNaverClusters: () => ({ compared: [], increase: 0 }),
      kbAreaCount: () => null, naverClusterCounts: () => null, readMarks: () => ({}), readViews: () => ({}),
      saveCaptureNews: () => {}, writeMarks: () => {}, writeViews: () => {},
    },
    './dabang-parse.js': { parseDabangRoomList: (body) => JSON.parse(body).result ? parseDabangRoomList(body) : parsed(body) },
    './browse-scope.js': browseScope,
    './naver-parse.js': { parseNaverList: parsed },
    './zigbang-parse.js': { parseZigbangItemRows: (body) => {
      try {
        const rows = JSON.parse(body)?.items;
        if (Array.isArray(rows) && rows.length && rows.every((x) => x?.sourceId)) return { valid: true, items: parsed(body).items, unreadableIds: [] };
      } catch { /* Real parser supplies malformed-detail evidence. */ }
      return parseZigbangItemRows(body);
    }, parseZigbangStationIds },
    './zigbang-coverage.js': zigbangCoverage,
    './daangn-parse.js': daangnParse,
    './link-hints.js': { learnLinkHints: () => {}, zigbangStationName: () => null },
    './notify.js': { notify: (...args) => notices.push(args) },
    './runner.js': { applyResults, coveringArea: (_areas, lat, lng) => lat === 36 && lng === 128 ? area : null },
    '../shared/regions.js': { hasRegions: () => regionMode, selectedArea: (listing) => (listing.inRange ?? (listing.lat === 36 && listing.lng === 128)) ? area : null },
    './line-areas.js': { activeLineAreas: () => [] },
    '../shared/types.js': { isApartmentType: () => false, seoulGuOf: () => null },
  };
  const source = fs.readFileSync(new URL('../server/naver-capture.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  function load() {
    const module = { exports: {} };
    vm.runInNewContext(js, {
      module, exports: module.exports, URL, structuredClone, setTimeout: () => 1, clearTimeout: () => {},
      require(name) { assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name]; },
    }, { filename: 'naver-capture.ts' });
    return module.exports;
  }
  return { api: load(), restart: load, store, notices, rows: () => rows, calls: () => calls, saved: () => saved,
    failReceipt: (value) => { failReceipt = value; } };
}

const listing = (id = '1', inRange = true, price = 100) => ({ sourceId: id, inRange, price, lat: 36, lng: 128, prices: [] });
function capture(site = 'naver', items = [listing()]) {
  return { site, status: 200, pageUrl: `https://${site === 'naver' ? 'fin.land.naver.com' : 'www.dabangapp.com'}/map`,
    url: site === 'naver' ? 'https://fin.land.naver.com/front-api/v1/clusteredArticles' : 'https://www.dabangapp.com/api/v5/room-list/search',
    requestBody: JSON.stringify({ clusterId: 'known' }), body: JSON.stringify({ items }) };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test('extension region receipts persist cursor proof across restarts and verify every stored row',()=>{
  const r=receiver();
  const first=r.api.acceptBrowseCaptures({jobId:'naver-region',batchId:'page-1',naverScope:naverTarget,captures:[naverPage(['101'],{more:true,next:['a'],total:2})]});
  assert.equal(first.naverCoverage.complete,false);
  const api=r.restart();
  const complete=api.acceptBrowseCaptures({jobId:'naver-region',batchId:'page-2',naverScope:naverTarget,captures:[naverPage(['102'],{cursor:['a'],total:2})]});
  assert.equal(complete.naverCoverage.complete,true); assert.equal(complete.naverCoverage.stored,2); assert.equal(r.saved().size,2);
  assert.equal(r.notices.length,0);
  assert.throws(()=>api.acceptBrowseCaptures({jobId:'naver-region',batchId:'page-3',naverScope:{...naverTarget,code:'9988800000'},captures:[]}),/범위/);
  const fail=receiver({skipWrites:true});
  const failed=fail.api.acceptBrowseCaptures({jobId:'missing-write',batchId:'page-1',naverScope:naverTarget,captures:[naverPage()]});
  assert.equal(failed.naverCoverage.complete,false); assert.equal(failed.naverCoverage.stored,0);
});
const zigbangCapture = (station, items) => ({
  site: 'zigbang', status: 200, pageUrl: 'https://www.zigbang.com/home/oneroom/subways/123/items',
  url: `https://apis.zigbang.com/house/property/v1/items/${station ? 'subways/123/onerooms?radius=0.5' : 'list'}`,
  body: JSON.stringify({ items: station ? items.map((id) => ({ id })) : items }),
});

test('filtered region receipts reject unrestricted rows independently of the extension and preserve scope after restart',()=>{
  const firstPage=naverPage(['101'],{filter:selectedFilter,more:true,next:['a'],total:2});
  const scope={...naverTarget,filter:JSON.parse(firstPage.requestBody).filter,sort:'DATE_DESC'};
  const wrong=receiver();
  const rejected=wrong.api.acceptBrowseCaptures({jobId:'lost-filter',batchId:'first',naverScope:scope,captures:[naverPage(['999'])]});
  assert.equal(wrong.saved().size,0);assert.equal(rejected.listings,0);assert.equal(rejected.naverCoverage.complete,false);
  const r=receiver();
  r.api.acceptBrowseCaptures({jobId:'filtered',batchId:'first',naverScope:scope,captures:[firstPage]});
  const api=r.restart();
  const complete=api.acceptBrowseCaptures({jobId:'filtered',batchId:'last',naverScope:scope,captures:[naverPage(['102'],{filter:selectedFilter,cursor:['a'],total:2})]});
  assert.equal(complete.naverCoverage.complete,true);assert.equal(complete.naverCoverage.stored,2);
  assert.equal(r.saved().size,2);assert.equal(r.notices.length,0);
  assert.throws(()=>api.acceptBrowseCaptures({jobId:'filtered',batchId:'changed',naverScope:{...scope,filter:{...scope.filter,rentPrice:null}},captures:[]}),/범위/);
});

test('receipts confirm target and incidental writes and replay without duplicate effects', () => {
  const r = receiver();
  const batch = { jobId: 'job-1', batchId: 'batch-1', captures: [capture('naver', [listing(), listing('2', false)])] };
  const receipt = r.api.acceptBrowseCaptures(batch);
  assert.deepEqual(plain(receipt), { responses: 1, listings: 2, newCount: 2, changedCount: 0 });
  assert.equal(r.calls(), 1);
  assert.deepEqual(plain(r.api.acceptBrowseCaptures(batch)), plain(receipt));
  assert.equal(r.calls(), 1);
  assert.equal(r.rows().length, 1);
  const updated = r.api.acceptBrowseCaptures({ ...batch, batchId: 'batch-2', captures: [capture('naver', [listing('1', true, 200)])] });
  assert.deepEqual(plain(updated), { responses: 2, listings: 3, newCount: 2, changedCount: 1 });
  assert.deepEqual(plain(r.api.browseReceipt('job-1')), plain(updated));
});

test('manual district and dong lists are stored and replayed without duplicate rows', () => {
  const r = receiver();
  const page = { ...capture(), requestBody: JSON.stringify({ filter: { legalDivisionType: 'GUN' } }),
    url: 'https://fin.land.naver.com/front-api/v1/article/legalDivisionArticleList' };
  r.api.acceptCaptures([page]);
  r.api.finishCaptureSession(false);
  assert.equal(r.saved().has('naver:1'), true);
  assert.equal(r.rows().every(row => row.parsed), true);
  r.api.acceptCaptures([{ ...page, url: `${page.url}/?next=synthetic` }]);
  r.api.finishCaptureSession(false);
  assert.equal(r.saved().size, 1);
  assert.equal(r.calls(), 2);
  assert.equal(r.notices.length, 0);
});

test('map counts and aggregation cannot be saved as individual listings', () => {
  for (const name of ['boundedArticlesCount', 'articleClusters', 'unrelatedArticles']) {
    const r = receiver();
    r.api.acceptCaptures([{ ...capture(), url: `https://fin.land.naver.com/front-api/v1/article/${name}` }]);
    r.api.finishCaptureSession(false);
    assert.equal(r.saved().size, 0);
  }
});

test('a station ID increase outside a selected region is retained without a desktop notification', () => {
  const r = receiver({ regionMode: true });
  r.api.acceptCaptures([zigbangCapture(true, [1])]);
  r.api.finishCaptureSession(true);
  r.api.acceptCaptures([zigbangCapture(true, [1, 2]), zigbangCapture(false, [listing('2', false)])]);
  r.api.finishCaptureSession(true);
  assert.equal(r.saved().has('zigbang:2'), true);
  assert.equal(r.notices.length, 0);
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
  const first = r.api.acceptBrowseCaptures(ids);
  assert.deepEqual([first.responses, first.listings, first.newCount, first.changedCount], [1, 0, 0, 0]);
  assert.equal(first.zigbangCoverage.reason, 'radius-mismatch');

  // A replayed ID response sees the updated station baseline, so the per-job ledger
  // must retain 102 as fresh until the separately delivered detail response arrives.
  r.api.acceptBrowseCaptures(ids);
  const receipt = r.api.acceptBrowseCaptures({ jobId: 'station-tour', batchId: 'details', captures: [zigbangCapture(false, [listing('101'), listing('102')])] });
  assert.deepEqual([receipt.responses, receipt.listings, receipt.newCount, receipt.changedCount], [2, 2, 1, 0]);
  assert.equal(receipt.zigbangCoverage.complete, false);
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

const scope = { kind: 'dabang-region', name: '예시시 예시구 예시동', dong: '예시동',
  url: 'https://www.dabangapp.com/map/onetwo?m_lat=36&m_lng=128&m_zoom=14&search_type=region&search_id=12345' };
const room = (seq, dongName = '예시동') => ({ seq, dongName, randomLocation: { lat: 35, lng: 129 },
  roomTypeName: '원룸', roomDesc: '2층, 20m², 관리비 없음', priceTypeName: '월세', priceTitle: '500/30', roomTitle: '예시 매물' });
const regionCapture = ({ page = 1, total = 2, limit = 2, hasMore = false, rooms = [room(201), room(202)], premium = [] } = {}) => ({
  site: 'dabang', status: 200, pageUrl: scope.url,
  url: `https://www.dabangapp.com/api/v5/room-list/category/one-two/region?code=99999101&filters=example&page=${page}`,
  body: JSON.stringify({ result: { roomList: rooms, premiumList: [{ roomList: premium }],
    region: { gid: 12345, code: '99999101', name: '예시동' }, total, limit, hasMore, page } }),
});

test('scoped Dabang retains surrounding and unknown dong rows without counting them as target coverage', () => {
  const r = receiver();
  const batch = { jobId: 'scoped', batchId: 'first', scope,
    captures: [regionCapture({ rooms: [room(201), room(202, '다른동'), room(203, null)], total: 3, limit: 3,
      premium: [room(201), room(204, '다른동')] })] };
  const receipt = r.api.acceptBrowseCaptures(batch);
  assert.equal(receipt.responses, 1);
  assert.equal(receipt.listings, 4);
  assert.equal(receipt.uniqueListings, 1);
  assert.equal(receipt.retainedOutside, 2);
  assert.equal(receipt.retainedUnknown, 1);
  assert.equal(receipt.excludedOutside, 0);
  assert.equal(receipt.excludedUnknown, 0);
  assert.deepEqual([...r.saved().keys()].sort(), ['dabang:201', 'dabang:202', 'dabang:203', 'dabang:204']);
  assert.equal(receipt.coverage.regularUnique, 3, 'advertisements never increase regular coverage');
  assert.equal(receipt.coverage.complete, false);
  assert.equal(receipt.coverage.reason, 'unverified-dong');
  const replay = r.api.acceptBrowseCaptures(batch);
  assert.deepEqual(plain(replay), plain(receipt));
  assert.equal(r.calls(), 1);
  const repeated = r.api.acceptBrowseCaptures({ ...batch, batchId: 'repeated' });
  assert.equal(repeated.listings, 8, 'processing count may include repeated updates');
  assert.equal(repeated.uniqueListings, 1, 'unique saved and exclusion counters remain deduplicated across batches');
  assert.equal(repeated.retainedOutside, 2);
});

test('scope is immutable across batches and replays; wrong pages and sites cannot enter a scoped receipt', () => {
  const r = receiver();
  const batch = { jobId: 'scoped', batchId: 'first', scope, captures: [regionCapture()] };
  r.api.acceptBrowseCaptures(batch);
  for (const nextScope of [null, { ...scope, dong: '다른동' }, { ...scope, url: scope.url.replace('12345', '54321') }]) {
    assert.throws(() => r.api.acceptBrowseCaptures({ ...batch, scope: nextScope }), /범위/);
    assert.throws(() => r.api.acceptBrowseCaptures({ ...batch, batchId: 'next', scope: nextScope }), /범위/);
  }
  const before = r.rows().length;
  for (const c of [{ ...regionCapture(), pageUrl: scope.url.replace('12345', '54321') }, capture('naver')]) {
    assert.throws(() => r.api.acceptBrowseCaptures({ ...batch, batchId: 'bad-page', captures: [c] }), /범위/);
  }
  assert.equal(r.rows().length, before);
  for (const url of ['https://example.invalid/map/onetwo?search_type=region&search_id=12345',
    'https://www.dabangapp.com/map/onetwo?search_type=region&search_id=12345&search_id=54321']) {
    assert.throws(() => r.api.acceptBrowseCaptures({ ...batch, jobId: 'bad-scope', scope: { ...scope, url } }), /범위/);
  }
});

test('coverage requires all proven region pages and regular IDs while keeping premium rows outside the regular total', () => {
  const r = receiver();
  const batch = { jobId: 'scoped', batchId: 'page-1', scope,
    captures: [regionCapture({ total: 3, hasMore: true })] };
  const first = r.api.acceptBrowseCaptures(batch);
  assert.deepEqual(plain(first.coverage), { pages: 1, totalPages: 2, total: 3, regularUnique: 2, complete: false, reason: 'missing-pages' });
  const final = r.api.acceptBrowseCaptures({ ...batch, batchId: 'page-2',
    captures: [regionCapture({ page: 2, total: 3, rooms: [room(203)], premium: [room(999)] })] });
  assert.deepEqual(plain(final.coverage), { pages: 2, totalPages: 2, total: 3, regularUnique: 3, complete: true, reason: 'complete' });
  assert.equal(final.uniqueListings, 4, 'advertisements can be saved while remaining outside regular coverage');
  const missing = r.api.acceptBrowseCaptures({ ...batch, jobId: 'missing-first', captures: [regionCapture({ page: 2, total: 3, rooms: [room(203)] })] });
  assert.equal(missing.coverage.reason, 'missing-pages');
});

test('initial bbox responses are ignored for scoped collection and do not poison later region coverage', () => {
  const r = receiver();
  const map = regionCapture({ rooms: [room(990), room(991, '다른동')] });
  map.url = map.url.replace('/region?', '/bbox?');
  const batch = { jobId: 'scoped', batchId: 'initial-map', scope, captures: [map] };
  const initial = r.api.acceptBrowseCaptures(batch);
  assert.equal(initial.listings, 0);
  assert.equal(initial.uniqueListings, 0);
  assert.equal(initial.excludedOutside, 0);
  assert.equal(initial.coverage.pages, 0);
  assert.equal(initial.coverage.reason, 'unverified-region');
  const final = r.api.acceptBrowseCaptures({ ...batch, batchId: 'selected-region', captures: [regionCapture()] });
  assert.equal(final.coverage.complete, true);
  assert.deepEqual([...r.saved().keys()], ['dabang:201', 'dabang:202']);
});

test('region ID, legal-dong code, name and endpoint must all agree before scoped rows can be saved', () => {
  const original = regionCapture();
  const regionChange = (change) => {
    const body = JSON.parse(original.body);
    body.result.region = { ...body.result.region, ...change };
    return { ...original, body: JSON.stringify(body) };
  };
  for (const bad of [regionChange({ gid: 54321 }), regionChange({ code: '99999202' }), regionChange({ name: '다른동' }),
    { ...original, url: original.url.replace('www.dabangapp.com', 'example.invalid') },
    { ...original, url: original.url.replace('/region?', '/subway?') },
    { ...original, url: `${original.url}&code=99999202` },
    { ...original, url: `${original.url}&filters=changed` }]) {
    const r = receiver();
    const receipt = r.api.acceptBrowseCaptures({ jobId: 'scoped', batchId: 'bad', scope, captures: [bad] });
    assert.equal(receipt.coverage.complete, false);
    assert.equal(receipt.coverage.reason, new URL(bad.url).hostname === 'example.invalid' ? 'unverified-region' : 'response-scope');
    assert.equal(receipt.listings, 0);
    assert.equal(r.saved().size, 0);
  }
});

test('viewport changes do not change the region query; outside premium rows do not block valid regular coverage', () => {
  const r = receiver();
  const first = regionCapture({ total: 3, hasMore: true });
  first.url += '&zoom=13&bbox=first&useMap=naver';
  const batch = { jobId: 'scoped', batchId: 'first', scope, captures: [first] };
  r.api.acceptBrowseCaptures(batch);
  const last = regionCapture({ page: 2, total: 3, rooms: [room(203)], premium: [room(204, '다른동')] });
  last.url += '&zoom=14&bbox=second&useMap=naver';
  const receipt = r.api.acceptBrowseCaptures({ ...batch, batchId: 'last', captures: [last] });
  assert.equal(receipt.coverage.complete, true);
  assert.equal(receipt.retainedOutside, 1);
  assert.equal(receipt.uniqueListings, 3);
});

test('verified empty lists complete, but invalid pages, unreadable rows and duplicate rows never complete', () => {
  const empty = receiver().api.acceptBrowseCaptures({ jobId: 'empty', batchId: 'first', scope,
    captures: [regionCapture({ total: 0, rooms: [] })] });
  assert.equal(empty.coverage.complete, true);
  assert.equal(empty.uniqueListings, 0);
  const wrongPage = regionCapture(); wrongPage.url = wrongPage.url.replace('page=1', 'page=2');
  for (const bad of [wrongPage,
    regionCapture({ rooms: [room(201), { ...room(202), randomLocation: null }] }),
    regionCapture({ rooms: [room(201), room(201)] }),
    regionCapture({ rooms: [room(201)] }),
    regionCapture({ rooms: [room(201), room(0)] }),
    regionCapture({ rooms: [room(201), room(-5)] }),
  ]) {
    const r = receiver();
    const receipt = r.api.acceptBrowseCaptures({ jobId: 'scoped', batchId: 'first', scope, captures: [bad] });
    assert.equal(receipt.coverage.complete, false);
  }
});

test('changed totals, repeated page contents and filters invalidate coverage rather than combining incompatible lists', () => {
  for (const [reason, next] of [
    ['total-changed', regionCapture({ page: 2, total: 4, rooms: [room(203), room(204)] })],
    ['page-changed', regionCapture({ total: 3, hasMore: true, rooms: [room(201), room(205)] })],
    ['query-changed', { ...regionCapture({ page: 2, total: 3, rooms: [room(203)] }), url: regionCapture().url.replace('example', 'changed') }],
  ]) {
    const r = receiver();
    const batch = { jobId: 'scoped', batchId: 'page-1', scope, captures: [regionCapture({ total: 3, hasMore: true })] };
    r.api.acceptBrowseCaptures(batch);
    const receipt = r.api.acceptBrowseCaptures({ ...batch, batchId: 'next', captures: [next] });
    assert.equal(receipt.coverage.reason, reason);
    assert.equal(receipt.coverage.complete, false);
  }
});

test('scoped rollback preserves receipt and scope context never leaks into later manual collection', () => {
  const r = receiver();
  const batch = { jobId: 'scoped', batchId: 'first', scope, captures: [regionCapture()] };
  r.failReceipt(true);
  assert.throws(() => r.api.acceptBrowseCaptures(batch), /synthetic storage failure/);
  assert.equal(r.saved().size, 0);
  assert.equal(r.api.browseReceipt('scoped'), null);
  r.failReceipt(false);
  const receipt = r.api.acceptBrowseCaptures(batch);
  assert.equal(receipt.uniqueListings, 2);
  r.api.acceptCaptures([capture('dabang', [listing('500')])]);
  r.api.finishCaptureSession(false);
  assert.equal(r.saved().has('dabang:500'), true, 'manual capture retains legacy radius admission');
  assert.equal(r.api.browseReceipt('scoped').uniqueListings, 2);
});

const stationPage = 'https://www.zigbang.com/home/oneroom/subways/777/items';
const stationList = (ids = [501, 502], query = 'radius=1') => ({ site: 'zigbang', status: 200, pageUrl: stationPage,
  url: `https://apis.zigbang.com/house/property/v1/items/subways/777/onerooms?${query}`,
  body: JSON.stringify({ items: ids.map((id) => ({ id })) }) });
const stationRoom = (item_id, lat = 36, lng = 128) => ({ item_id, location: { lat, lng }, sales_type: '월세', deposit: 500, rent: 30,
  floor_string: '2', title: 'Synthetic listing', service_type: '원룸' });
const stationDetails = (...items) => ({ site: 'zigbang', status: 200, pageUrl: stationPage,
  url: 'https://apis.zigbang.com/house/property/v1/items/list', body: JSON.stringify({ items }) });
const stationBatch = (batchId, captures, jobId = 'coverage-tour') => ({ jobId, batchId, captures });

test('Zigbang coverage verifies every expected ID across durable batches and excludes advertisements from counts', () => {
  const r = receiver();
  const first = r.api.acceptBrowseCaptures(stationBatch('ids', [stationList()]));
  assert.deepEqual(plain(first.zigbangCoverage), { stationId: '777', radiusKm: 1, total: 2, received: 0, stored: 0,
    excluded: 0, missing: 2, unreadable: 0, complete: false, reason: 'missing-details' });
  const middle = r.api.acceptBrowseCaptures(stationBatch('one', [stationDetails(stationRoom(501), stationRoom(999))]));
  assert.equal(middle.zigbangCoverage.stored, 1);
  assert.equal(middle.uniqueListings, 1);
  assert.equal(middle.listings, 2, 'processing counts may include advertisements');
  const restarted = r.restart();
  const finalBatch = stationBatch('two', [stationDetails(stationRoom(502))]);
  const final = restarted.acceptBrowseCaptures(finalBatch);
  assert.deepEqual(plain(final.zigbangCoverage), { stationId: '777', radiusKm: 1, total: 2, received: 2, stored: 2,
    excluded: 0, missing: 0, unreadable: 0, complete: true, reason: 'complete' });
  assert.equal(final.uniqueListings, 2);
  assert.deepEqual(plain(restarted.acceptBrowseCaptures(finalBatch)), plain(final));
});

test('Zigbang details arriving before station IDs retain storage proof after server restart', () => {
  const r = receiver();
  const first = r.api.acceptBrowseCaptures(stationBatch('details-first', [stationDetails(stationRoom(501), stationRoom(502))]));
  assert.equal(first.zigbangCoverage.reason, 'missing-list');
  assert.equal(first.zigbangCoverage.total, null);
  assert.equal(first.uniqueListings, 0, 'no unknown expected IDs may count as verified coverage');
  const final = r.restart().acceptBrowseCaptures(stationBatch('ids-later', [stationList()]));
  assert.equal(final.zigbangCoverage.complete, true);
  assert.equal(final.uniqueListings, 2);
});

test('Zigbang surrounding rows are retained while absent areas or writes stay unverified', () => {
  const captures = [stationList(), stationDetails(stationRoom(501), stationRoom(502, 35, 129))];
  const result = receiver().api.acceptBrowseCaptures(stationBatch('outside', captures));
  assert.equal(result.zigbangCoverage.complete, true);
  assert.equal(result.zigbangCoverage.stored, 2);
  assert.equal(result.zigbangCoverage.excluded, 0);
  assert.equal(result.uniqueListings, 2);
  assert.equal(result.excludedOutside, 0);
  for (const options of [{ noAreas: true }, { skipWrites: true }]) {
    const unverified = receiver(options).api.acceptBrowseCaptures(stationBatch('unverified', captures));
    assert.equal(unverified.zigbangCoverage.complete, false);
    assert.equal(unverified.zigbangCoverage.reason, 'unverified-storage');
    assert.equal(unverified.zigbangCoverage.stored, 0, 'a claimed kept count is insufficient without a persisted row');
  }
});

test('Zigbang malformed expected details remain unreadable until a valid response is received', () => {
  const r = receiver();
  const badRoom = { ...stationRoom(502), location: null };
  const partial = r.api.acceptBrowseCaptures(stationBatch('bad-detail', [stationList(), stationDetails(stationRoom(501), badRoom)]));
  assert.equal(partial.zigbangCoverage.received, 2);
  assert.equal(partial.zigbangCoverage.missing, 0);
  assert.equal(partial.zigbangCoverage.unreadable, 1);
  assert.equal(partial.zigbangCoverage.reason, 'unreadable-details');
  const fixed = r.api.acceptBrowseCaptures(stationBatch('good-detail', [stationDetails(stationRoom(502))]));
  assert.equal(fixed.zigbangCoverage.complete, true);
});

test('Zigbang empty proven list completes, but invalid list bodies, IDs, radius and statuses fail closed', () => {
  const empty = receiver().api.acceptBrowseCaptures(stationBatch('empty', [stationList([])]));
  assert.equal(empty.zigbangCoverage.complete, true);
  assert.equal(empty.zigbangCoverage.total, 0);
  for (const [reason, bad] of [
    ['unreadable-list', { ...stationList(), body: 'not json' }],
    ['unreadable-list', stationList([0, 502])],
    ['unreadable-list', stationList([-1, 502])],
    ['unreadable-list', stationList([501.5, 502])],
    ['duplicate-list-id', stationList([501, 501])],
    ['radius-mismatch', stationList([501, 502], 'radius=2.5')],
    ['radius-mismatch', stationList([501, 502], 'radius=1&radius=1')],
    ['response-status', { ...stationList(), status: 500 }],
    ['response-scope', { ...stationDetails(stationRoom(501)), url: 'http://apis.zigbang.com/house/property/v1/items/list' }],
  ]) {
    const result = receiver().api.acceptBrowseCaptures(stationBatch('invalid', [bad, stationDetails(stationRoom(501), stationRoom(502))]));
    assert.equal(result.zigbangCoverage.complete, false, reason);
    assert.equal(result.zigbangCoverage.reason, reason);
  }
});

test('Zigbang changed station, query or expected IDs stay invalid even if every seen detail is stored', () => {
  for (const [reason, next] of [
    ['station-changed', { ...stationList(), pageUrl: stationPage.replace('/777/', '/778/') }],
    ['station-changed', { ...stationList(), url: stationList().url.replace('/777/', '/778/') }],
    ['query-changed', stationList([501, 502], 'radius=1&depositMin=100')],
    ['list-changed', stationList([501, 503])],
  ]) {
    const r = receiver();
    r.api.acceptBrowseCaptures(stationBatch('initial', [stationList()]));
    const result = r.api.acceptBrowseCaptures(stationBatch('changed', [next, stationDetails(stationRoom(501), stationRoom(502), stationRoom(503))]));
    assert.equal(result.zigbangCoverage.complete, false, reason);
    assert.equal(result.zigbangCoverage.reason, reason);
    const later = r.api.acceptBrowseCaptures(stationBatch('original-again', [stationList()]));
    assert.equal(later.zigbangCoverage.reason, reason, 'an incompatible batch cannot be repaired by merging the old list');
  }
  const r = receiver();
  r.api.acceptBrowseCaptures(stationBatch('ordered', [stationList([501, 502], 'rentMax=50&radius=1')]));
  const equivalent = r.api.acceptBrowseCaptures(stationBatch('reordered', [stationList([502, 501], 'radius=1&rentMax=50'), stationDetails(stationRoom(501), stationRoom(502))]));
  assert.equal(equivalent.zigbangCoverage.complete, true, 'query and ID ordering alone do not change a list');
});

test('Zigbang failed receipt transactions roll back coverage and do not leak scope into manual collection', () => {
  const r = receiver();
  const batch = stationBatch('first', [stationList(), stationDetails(stationRoom(501), stationRoom(502))]);
  r.failReceipt(true);
  assert.throws(() => r.api.acceptBrowseCaptures(batch), /synthetic storage failure/);
  assert.equal(r.api.browseReceipt('coverage-tour'), null);
  assert.equal(r.saved().size, 0);
  r.failReceipt(false);
  assert.equal(r.api.acceptBrowseCaptures(batch).zigbangCoverage.complete, true);
  r.api.acceptCaptures([stationDetails(stationRoom(503))]);
  r.api.finishCaptureSession(false);
  assert.equal(r.saved().has('zigbang:503'), true);
  assert.equal(r.api.browseReceipt('coverage-tour').uniqueListings, 2);
});

const DAANGN_PAGE = 'https://realty.daangn.com/map/subway/%EC%98%88%EC%8B%9C';
const daangnArticle = (id, type = 'ONE_ROOM') => ({ originalId: String(id), salesTypeV3: { type }, trades: [{ type: 'MONTH', deposit: 1000, monthlyPay: 50 }],
  publicCoordinate: { lat: '36', lon: '128' }, area: '20', floor: '2', region: { name3: '가상동' } });
const daangnCapture = (rows, after, hasNextPage, endCursor) => ({
  site: 'daangn', status: 200, pageUrl: DAANGN_PAGE, url: 'https://realty.kr.karrotmarket.com/graphql',
  requestBody: JSON.stringify({ variables: { after, first: 10, propertyFilter: { salesTypes: [] }, subwayStationPoiId: '900' } }),
  body: JSON.stringify({ data: { subwayStationArticleConnection: { edges: rows.map(([id, type]) => ({ node: { article: daangnArticle(id, type) } })), pageInfo: { endCursor, hasNextPage } } } }),
});

test('Daangn station lists store residential rows only and complete across restarts when the last page and writes agree', () => {
  const r = receiver();
  const first = r.api.acceptBrowseCaptures({ jobId: 'daangn-1', batchId: 'p1', captures: [daangnCapture([[401], [402, 'STORE']], null, true, 'c1')] });
  assert.equal(first.daangnCoverage.complete, false);
  assert.equal(first.daangnCoverage.reason, 'more-pages');
  const api = r.restart();
  const done = api.acceptBrowseCaptures({ jobId: 'daangn-1', batchId: 'p2', captures: [daangnCapture([[403, 'OFFICETEL']], 'c1', false, 'c2')] });
  assert.deepEqual(plain(done.daangnCoverage), { stationPoiId: '900', pages: 2, received: 3, stored: 2, excluded: 1, unreadable: 0, complete: true, reason: 'complete' });
  assert.deepEqual([...r.saved().keys()].sort(), ['daangn:401', 'daangn:403']);
  const broken = receiver();
  const skipped = broken.api.acceptBrowseCaptures({ jobId: 'daangn-2', batchId: 'p1', captures: [daangnCapture([[501]], 'not-the-first', false, 'c9')] });
  assert.equal(skipped.daangnCoverage.reason, 'list-changed');
  const unwritten = receiver({ skipWrites: true });
  const pending = unwritten.api.acceptBrowseCaptures({ jobId: 'daangn-3', batchId: 'p1', captures: [daangnCapture([[601]], null, false, 'c1')] });
  assert.equal(pending.daangnCoverage.reason, 'unverified-storage');
});

test('Daangn account responses are never stored and identity fields are masked', () => {
  const r = receiver();
  r.api.acceptCaptures([{ site: 'daangn', status: 200, pageUrl: DAANGN_PAGE, url: 'https://realty.kr.karrotmarket.com/graphql',
    body: JSON.stringify({ data: { viewer: { nickname: 'synthetic', karrotUserIdentification: { realName: 'synthetic', di: 'synthetic-di' } } } }) }], false);
  assert.equal(r.rows().length, 0);
  assert.equal(r.api.redact('{"realName":"x","di":"abc","ci":"def","name":"y"}'), '{"realName":"***","di":"***","ci":"***","name":"y"}');
});
