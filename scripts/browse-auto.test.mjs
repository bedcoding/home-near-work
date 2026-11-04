import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { distanceM } from '../server/geo.ts';
import naverLedger from '../server/naver-ledger.ts';
import naverContext from '../server/naver-context.ts';
import {snapshot,selectedFilter} from './fixtures/naver-context.mjs';
import {page as naverPage} from './fixtures/naver-region.mjs';

const sources = Object.fromEntries(['browse-auto', 'browse-settings', 'browse-scope','naver-preset'].map(name => [name, ts.transpileModule(
  fs.readFileSync(new URL(`../server/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText]));
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  let now = Date.UTC(2026, 9, 20, 12), serial = 0;
  const areas = [{ id: 1, name: '예시 지역', lat: 35.1, lng: 128.1, radiusM: 700, enabled: true }];
  const stations = [{ name: '예시역', lat: 35.1, lng: 128.1, zigbangId: '777' }];
  const regions = [1, 2].map(i => ({ kind: 'dabang-region', name: `예시구 가상${i}동`, dong: `가상${i}동`, url: `https://www.dabangapp.com/map/onetwo?search_id=${1000 + i}&search_type=region` }));
  const settings = new Map([['auto_check_time', '22:30']]);
  const setScopes = (scopes = regions) => settings.set('browse_area_scopes', JSON.stringify({ 1: { area: { name: areas[0].name, lat: areas[0].lat, lng: areas[0].lng }, regions: scopes } }));
  setScopes();
  const store = { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => settings.set(key, value), listAreas: () => areas };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const modules = {};
  function load(name) {
    if (modules[name]) return modules[name];
    const exports = {};
    modules[name] = exports;
    vm.runInNewContext(sources[name], { exports, URL, Date: Clock, require(id) {
      if (id === './db.js') return store;
      if (id === 'node:crypto') return { randomUUID: () => `request-${++serial}` };
      if (id === './station-catalog.js') return { knownStations: () => stations };
      if (id === './link-hints.js') return { withLinkHints: list => list.map(station => ({ ...station })) };
      if (id === './geo.js') return { distanceM };
      if(id==='./naver-context.js')return {default:naverContext};
      if(id==='./naver-ledger.js')return {default:naverLedger};
      const match = /^\.\/(browse-settings|browse-scope|naver-preset)\.js$/.exec(id);
      assert.ok(match, `unexpected dependency ${id}`);
      return load(match[1]);
    } });
    return exports;
  }
  const api = load('browse-auto');
  const client = { clientId: 'client-a', version: '0.8.5' };
  const start = (enabled = false) => { api.setBrowseAuto({ enabled, areaIds: [1] }); api.runBrowseAutoNow(); return clone(api.pollBrowseAuto(client).request); };
  const report = (request, overrides = {}) => api.reportBrowseAuto({ clientId: client.clientId, requestId: request.id, runId: request.id, status: 'done', totalJobs: 2, completeJobs: 2, partialJobs: 0, failedJobs: 0, ...overrides });
  const receipts = request => request.areas.flatMap(a => request.sites.flatMap(site => site === 'dabang'
    ? a.dabangRegions.map(scope => ({ scope, receipt: { coverage: { complete: true } } }))
    : [{ receipt: { responses: 2, uniqueListings: 2, excludedOutside: 0, zigbangCoverage: { stationId: a.zigbangStation.stationId, radiusKm: 1,
      total: 2, received: 2, stored: 2, excluded: 0, missing: 0, unreadable: 0, complete: true, reason: 'complete' } } }]))
    .map((entry, index) => ({ jobId: `${request.id}:${index}`, at: now, ...entry }));
  return { api, preset:load('naver-preset'),areas, stations, regions, settings, client, start, report, receipts, setScopes, advance(ms) { now += ms; }, now: () => now };
}

test('defaults off and requires configured legal-dong scopes before enabling or running', () => {
  const f = fixture();
  assert.equal(f.api.browseAutoState().enabled, false);
  assert.equal(f.api.browseAutoState().last, null);
  assert.throws(() => f.api.runBrowseAutoNow(), { statusCode: 409 });
  f.settings.delete('browse_area_scopes');
  assert.throws(() => f.api.setBrowseAuto({ enabled: true, areaIds: [1] }), { statusCode: 409 });
  assert.equal(f.settings.has('browse_auto_state'), false);
});

test('GU collection migrates only Dabang scheduling and preserves Zigbang and active requests', () => {
  for (const sites of [['dabang'], ['dabang', 'zigbang']]) {
    const f = fixture(); f.api.setBrowseAuto({ enabled: true, areaIds: [1], sites });
    f.areas.push({ id: 9, enabled: true, purpose: 'collection', region: { kind: 'gu', code: '99123' } });
    assert.equal(f.api.migrateDabangSchedule(), true);
    const state = f.api.browseAutoState();
    assert.deepEqual(clone(state.sites), sites.filter(site => site !== 'dabang'));
    assert.equal(state.enabled, sites.includes('zigbang'));
    assert.equal(f.api.migrateDabangSchedule(), false);
    assert.ok(f.settings.has('browse_auto_before_dabang_gu'));
  }
  const active = fixture(); active.start(true);
  active.areas.push({ id: 9, enabled: true, purpose: 'collection', region: { kind: 'gu', code: '99123' } });
  assert.equal(active.api.migrateDabangSchedule(), false);
  assert.equal(active.api.browseAutoState().last.status, 'queued');
});

test('switching a station alert off does not disable its saved source-query route', () => {
  const f = fixture();
  f.areas[0].purpose = 'alert';
  f.api.setBrowseAuto({ enabled: true, areaIds: [1] });
  f.areas[0].enabled = false;
  const state = f.api.browseAutoState();
  assert.equal(state.configuredJobs, 2);
  assert.equal(state.configError, null);
  f.api.runBrowseAutoNow();
  const request = f.api.pollBrowseAuto(f.client).request;
  assert.ok(request);
  assert.equal(request.areas[0].dabangRegions.length, 2);
});

test('a tour cannot exceed the retained server receipt capacity', () => {
  const f = fixture(), scopes = {};
  f.areas.splice(0);
  for (let id = 1; id <= 41; id++) {
    const area = { id, name: `가상 지역 ${id}`, lat: 35 + id / 1000, lng: 128.1, radiusM: 700, enabled: true };
    f.areas.push(area);
    scopes[id] = { area: { name: area.name, lat: area.lat, lng: area.lng }, regions: Array.from({ length: 50 }, (_, i) => ({ ...f.regions[0], url: `https://www.dabangapp.com/map/onetwo?search_id=${id * 100 + i}&search_type=region` })) };
  }
  f.settings.set('browse_area_scopes', JSON.stringify(scopes));
  assert.throws(() => f.api.setBrowseAuto({ enabled: true, areaIds: f.areas.map(a => a.id) }), /2,000/);
  assert.equal(f.api.setBrowseAuto({ enabled: true, areaIds: f.areas.slice(0, 40).map(a => a.id) }).configuredJobs, 2000);
});

test('scheduled slots start after enabling, cannot duplicate, and do not replay after completion', () => {
  const f = fixture();
  const oldSlot = f.now();
  f.api.setBrowseAuto({ enabled: true, areaIds: [1, 1] });
  assert.equal(f.api.enqueueScheduledBrowse(oldSlot), false);
  f.advance(60_000);
  const slot = f.now();
  assert.equal(f.api.enqueueScheduledBrowse(slot), true);
  assert.equal(f.api.enqueueScheduledBrowse(slot), false);
  const request = f.api.pollBrowseAuto(f.client).request;
  f.report(request);
  assert.equal(f.api.enqueueScheduledBrowse(slot), false);
  f.advance(86400_000);
  assert.equal(f.api.enqueueScheduledBrowse(f.now()), true);
});

test('claim retries preserve the request and another client cannot claim it', () => {
  const f = fixture(), request = f.start();
  assert.deepEqual(clone(f.api.pollBrowseAuto(f.client).request), request);
  assert.equal(f.api.pollBrowseAuto({ ...f.client, clientId: 'client-b' }).request, null);
  assert.throws(() => f.api.runBrowseAutoNow(), { statusCode: 409 });
  assert.throws(() => f.report(request, { clientId: 'client-b' }), { statusCode: 409 });
  const visible = f.api.browseAutoState().last;
  assert.equal('areas' in visible, false);
  assert.equal('clientId' in visible, false);
});

test('old extensions cannot claim and changed scope before claim fails closed', () => {
  const f = fixture();
  f.api.setBrowseAuto({ enabled: false, areaIds: [1] });
  f.api.runBrowseAutoNow();
  assert.equal(f.api.pollBrowseAuto({ ...f.client, version: '0.8.4' }).request, null);
  f.setScopes([f.regions[0]]);
  assert.equal(f.api.pollBrowseAuto(f.client).request, null);
  assert.equal(f.api.browseAutoState().last.status, 'failed');
});

test('client completion without matching server receipts is only partial', () => {
  const f = fixture(), request = f.start();
  f.report(request);
  const last = f.api.browseAutoState().last;
  assert.equal(last.status, 'partial');
  assert.equal(last.completeJobs, 0);
  assert.equal(last.partialJobs, 2);
});

test('completion needs current receipts for every exact immutable scope', () => {
  for (const invalid of ['wrongScope', 'oldReceipt', 'incomplete', 'wrongJob']) {
    const f = fixture(), request = f.start(), entries = f.receipts(request);
    if (invalid === 'wrongScope') entries[1].scope = entries[0].scope;
    if (invalid === 'oldReceipt') entries[1].at -= 1;
    if (invalid === 'incomplete') entries[1].receipt.coverage.complete = false;
    if (invalid === 'wrongJob') entries[1].jobId = 'other-tour:1';
    f.settings.set('browse_receipts', JSON.stringify(entries));
    f.report(request);
    assert.equal(f.api.browseAutoState().last.status, 'partial', invalid);
    assert.equal(f.api.browseAutoState().last.completeJobs, 1, invalid);
  }
  const f = fixture(), request = f.start();
  f.settings.set('browse_receipts', JSON.stringify(f.receipts(request)));
  f.report(request);
  assert.equal(f.api.browseAutoState().last.status, 'complete');
  assert.equal(f.api.browseAutoState().last.completeJobs, 2);
  assert.equal(f.report(request, { status: 'running' }).ignored, true);
  assert.equal(f.api.browseAutoState().last.status, 'complete');
});

test('unclaimed requests expire after 24 hours while claimed stale requests prevent duplicates', () => {
  const f = fixture();
  f.api.setBrowseAuto({ enabled: false, areaIds: [1] });
  f.api.runBrowseAutoNow();
  f.advance(86400_000);
  assert.equal(f.api.browseAutoState().last.status, 'expired');
  const request = f.start();
  f.report(request, { status: 'running', completeJobs: 0 });
  f.advance(86400_000);
  const state = f.api.browseAutoState();
  assert.equal(state.last.status, 'running');
  assert.equal(state.last.stale, true);
  assert.throws(() => f.api.runBrowseAutoNow(), { statusCode: 409 });
});

test('invalid or disabled area configuration can always be switched off', () => {
  const f = fixture();
  f.api.setBrowseAuto({ enabled: true, areaIds: [1] });
  f.areas[0].enabled = false;
  const state = f.api.setBrowseAuto({ enabled: false, areaIds: [1] });
  assert.equal(state.enabled, false);
  assert.ok(state.configError);
  f.advance(60_000);
  assert.equal(f.api.enqueueScheduledBrowse(f.now()), false);
});

test('preparation may report zero jobs but completion cannot change the expected count', () => {
  const f = fixture(), request = f.start();
  f.report(request, { status: 'running', totalJobs: 0, completeJobs: 0 });
  assert.equal(f.api.browseAutoState().last.totalJobs, 2);
  assert.equal(f.api.browseAutoState().last.status, 'running');
  assert.throws(() => f.report(request, { totalJobs: 0, completeJobs: 0 }), { statusCode: 400 });
  assert.throws(() => f.report(request, { totalJobs: 1, completeJobs: 1 }), { statusCode: 400 });
  assert.throws(() => f.report(request, { completeJobs: 2, partialJobs: 1 }), { statusCode: 400 });
  f.report(request, { status: 'failed', totalJobs: 0, completeJobs: 0 });
  assert.equal(f.api.browseAutoState().last.status, 'failed');
});

test('schedule reset cancels unclaimed scheduled work and starts with the next slot', () => {
  const f = fixture();
  f.api.setBrowseAuto({ enabled: true, areaIds: [1] });
  f.advance(60_000);
  assert.equal(f.api.enqueueScheduledBrowse(f.now()), true);
  f.advance(60_000);
  f.api.resetBrowseAutoSchedule();
  assert.equal(f.api.browseAutoState().last.status, 'expired');
  assert.equal(f.api.enqueueScheduledBrowse(f.now()), false);
  f.advance(60_000);
  assert.equal(f.api.enqueueScheduledBrowse(f.now()), true);
});

test('invalid scheduled scopes produce one failed result without radius fallback', () => {
  const f = fixture();
  f.api.setBrowseAuto({ enabled: true, areaIds: [1] });
  f.areas[0].name = '다른 예시 지역';
  f.advance(60_000);
  assert.equal(f.api.enqueueScheduledBrowse(f.now()), false);
  const state = f.api.browseAutoState();
  assert.equal(state.last.status, 'failed');
  assert.equal(state.last.totalJobs, 0);
  assert.equal(f.api.enqueueScheduledBrowse(f.now()), false);
  assert.equal(f.api.browseAutoState().last.id, state.last.id);
});

test('legacy configuration defaults to Dabang and omitted sites preserve an explicitly saved selection', () => {
  const f = fixture();
  const legacy = JSON.stringify({ config: { enabled: false, areaIds: [1], enabledAt: 0 }, last: null, lastScheduledSlot: 0 });
  f.settings.set('browse_auto_state', legacy);
  assert.deepEqual(clone(f.api.browseAutoState().sites), ['dabang']);
  assert.equal(f.settings.get('browse_auto_state'), legacy, 'reading compatibility must not change persistent preferences');
  f.api.setBrowseAuto({ enabled: false, areaIds: [1], sites: ['zigbang'] });
  assert.deepEqual(clone(f.api.setBrowseAuto({ enabled: true, areaIds: [1] }).sites), ['zigbang']);
  const last = f.api.runBrowseAutoNow();
  assert.equal(last.last.totalJobs, 1);
  assert.equal(f.api.pollBrowseAuto({ ...f.client, version: '0.8.7' }).request, null);
  assert.equal(f.api.pollBrowseAuto({ ...f.client, version: '0.8.8' }).request, null, 'Zigbang requires the corrected virtual-list recovery');
  assert.equal(f.api.browseAutoState().last.status, 'queued', 'an outdated extension must not claim the request');
  assert.deepEqual(clone(f.api.pollBrowseAuto({ ...f.client, version: '0.8.9' }).request.sites), ['zigbang']);
});

test('site selection is canonical, supports turning invalid settings off and rejects unsupported or empty enabled selection', () => {
  const f = fixture();
  assert.deepEqual(clone(f.api.setBrowseAuto({ enabled: true, areaIds: [1], sites: ['zigbang', 'dabang', 'zigbang'] }).sites), ['dabang', 'zigbang']);
  assert.equal(f.api.browseAutoState().configuredJobs, 3);
  for (const sites of [[], ['unrelated'], ['dabang', null], 'zigbang', null]) {
    assert.throws(() => f.api.setBrowseAuto({ enabled: true, areaIds: [1], sites }), { statusCode: sites?.length === 0 ? 409 : 400 });
  }
  assert.equal(f.api.setBrowseAuto({ enabled: false, areaIds: [1], sites: [] }).enabled, false);
  assert.throws(() => f.api.runBrowseAutoNow(), { statusCode: 409 });
});

function naverFixture() {
  const f=fixture();
  f.areas.push({id:2,name:'가상구',lat:35.2,lng:128.2,radiusM:1000,enabled:true,purpose:'collection',region:{kind:'gu',code:'99123',name:'예시도 가상구'}});
  f.preset.saveNaverPreset({pageUrl:snapshot(selectedFilter).pageUrl,areaIds:[2]});
  f.client.version='0.8.21';
  return f;
}
function naverReceipt(f,request,index=0) {
  const job=request.areas.find(area=>area.naver).naver,ledger=naverLedger.create(job.scope);
  naverLedger.accept(ledger,naverPage(['101'],{filter:job.scope.filter,sort:job.scope.sort}));
  return {jobId:`${request.id}:${index}`,at:f.now(),naverLedger:ledger,receipt:{responses:1,listings:1,naverCoverage:naverLedger.coverage(ledger,1)}};
}

test('Naver preset saving is independent of repeat preferences and refuses absent or invalid scopes',()=>{
  const f=fixture(),before=clone(f.api.browseAutoState());
  assert.throws(()=>f.api.setBrowseAuto({enabled:true,areaIds:[1],sites:['naver']}),{statusCode:409});
  assert.throws(()=>f.preset.saveNaverPreset({pageUrl:snapshot().pageUrl,areaIds:[1]}),{statusCode:409});
  assert.throws(()=>f.preset.saveNaverPreset({pageUrl:'https://example.invalid/map',areaIds:[1]}),{statusCode:409});
  assert.deepEqual(clone(f.api.browseAutoState().sites),before.sites);assert.equal(f.api.browseAutoState().enabled,false);
  const n=naverFixture();assert.equal(n.api.browseAutoState().naverPreset.conditions.find(row=>row.label==='월세').value,'77만원 이하');
  assert.equal(n.api.browseAutoState().last,null);assert.equal(n.api.browseAutoState().enabled,false);
});

test('Naver scheduling pins a saved GU filter, requires a new worker, and proves completion from exact receipts',()=>{
  const f=naverFixture();f.api.setBrowseAuto({enabled:true,areaIds:[2],sites:['naver']});f.advance(60000);
  assert.equal(f.api.enqueueScheduledBrowse(f.now()),true);
  assert.equal(f.api.pollBrowseAuto({...f.client,version:'0.8.20'}).request,null);
  const request=clone(f.api.pollBrowseAuto(f.client).request);assert.deepEqual(request.sites,['naver']);assert.equal(request.areas[0].naver.scope.filter.rentPrice.max,770000);
  f.settings.set('browse_receipts',JSON.stringify([naverReceipt(f,request)]));
  f.report(request,{totalJobs:1,completeJobs:1});assert.equal(f.api.browseAutoState().last.status,'complete');
  assert.equal(f.api.enqueueScheduledBrowse(f.now()),false);
});

test('Naver changed filters before claim fail closed and claimed requests retain their original filter',()=>{
  const f=naverFixture();f.api.runBrowseAutoNow({areaIds:[2],sites:['naver']});
  f.preset.saveNaverPreset({pageUrl:snapshot({...selectedFilter,rentPrice:{min:0,max:990000}}).pageUrl,areaIds:[2]});
  assert.equal(f.api.pollBrowseAuto(f.client).request,null);assert.equal(f.api.browseAutoState().last.status,'failed');
  f.api.runBrowseAutoNow({areaIds:[2],sites:['naver']});const claimed=clone(f.api.pollBrowseAuto(f.client).request);
  f.preset.saveNaverPreset({pageUrl:snapshot(selectedFilter).pageUrl,areaIds:[2]});
  assert.equal(f.api.pollBrowseAuto(f.client).request.areas[0].naver.scope.filter.rentPrice.max,990000);
  assert.equal(claimed.areas[0].naver.scope.filter.rentPrice.max,990000);
});

test('Naver completion cannot reuse a different filter, incomplete storage or old evidence',()=>{
  for(const variant of ['filter','storage','pages','old','missing']) {
    const f=naverFixture();f.api.runBrowseAutoNow({areaIds:[2],sites:['naver']});const request=clone(f.api.pollBrowseAuto(f.client).request),entry=naverReceipt(f,request);
    if(variant==='filter')entry.naverLedger.scope.filter.rentPrice.max=990000;
    if(variant==='storage')entry.receipt.naverCoverage.stored=0;
    if(variant==='pages')entry.receipt.naverCoverage.pages=2;
    if(variant==='old')entry.at-=1;
    f.settings.set('browse_receipts',JSON.stringify(variant==='missing'?[]:[entry]));
    f.report(request,{totalJobs:1,completeJobs:1});assert.equal(f.api.browseAutoState().last.status,'partial',variant);
  }
});

test('mixed Naver and station sources use their own areas without treating a station as a whole district',()=>{
  const f=naverFixture();f.api.setBrowseAuto({enabled:true,areaIds:[1,2],sites:['zigbang','naver']});
  assert.equal(f.api.browseAutoState().configuredJobs,2);f.api.runBrowseAutoNow();
  const request=clone(f.api.pollBrowseAuto(f.client).request);
  assert.equal(request.areas[0].naver,undefined);assert.ok(request.areas[0].zigbangStation);
  assert.equal(request.areas[1].zigbangStation,undefined);assert.ok(request.areas[1].naver);
  assert.throws(()=>naverFixture().api.setBrowseAuto({enabled:true,areaIds:[2],sites:['zigbang','naver']}),{statusCode:409});
});

test('Zigbang-only planning pins the nearest known station and does not require Dabang scopes', () => {
  const f = fixture();
  f.settings.set('browse_area_scopes', 'invalid scopes');
  f.areas.push({ ...f.areas[0], id: 2, name: '먼 예시 지역', lat: 36 });
  f.areas.push({ ...f.areas[0], id: 3, name: '꺼진 예시 지역', enabled: false });
  const state = f.api.setBrowseAuto({ enabled: true, areaIds: [1], sites: ['zigbang'] });
  assert.equal(state.configuredJobs, 1);
  assert.deepEqual(clone(state.zigbangAreaIds), [1]);
  f.api.runBrowseAutoNow();
  const request = clone(f.api.pollBrowseAuto({ ...f.client, version: '0.8.9' }).request);
  assert.equal('dabangRegions' in request.areas[0], false);
  assert.deepEqual(request.areas[0].zigbangStation, { stationId: '777', radiusKm: 1,
    url: 'https://www.zigbang.com/home/oneroom/subways/777/items' });
  assert.equal(request.areas[0].radiusM, 700, 'the app radius remains distinct from the pinned station scope');
});

test('Zigbang eligibility requires the nearest station within 2km and a positive numeric pin', () => {
  for (const replacement of [
    [], [{ name: '먼 가상역', lat: 36, lng: 128.1, zigbangId: '777' }],
    [{ name: '잘못된 가상역', lat: 35.1, lng: 128.1, zigbangId: '0' }],
    [{ name: '잘못된 가상역', lat: 35.1, lng: 128.1, zigbangId: '../bad' }],
    [{ name: '잘못된 가상역', lat: 35.1, lng: 128.1, zigbangId: '1'.repeat(21) }],
    [{ name: '가까운 미확인역', lat: 35.1, lng: 128.1 }, { name: '먼 확인역', lat: 35.11, lng: 128.1, zigbangId: '778' }],
  ]) {
    const f = fixture(); f.stations.splice(0, f.stations.length, ...replacement);
    assert.deepEqual(clone(f.api.browseAutoState().zigbangAreaIds), []);
    assert.throws(() => f.api.setBrowseAuto({ enabled: true, areaIds: [1], sites: ['zigbang'] }), { statusCode: 409 });
  }
  const f = fixture();
  f.stations[0].lat += 0.01;
  assert.deepEqual(clone(f.api.browseAutoState().zigbangAreaIds), [1], 'a known station within 2km can be pinned');
});

test('unreadable station hints fail Zigbang closed without breaking existing Dabang scheduling', () => {
  const f = fixture();
  Object.defineProperty(f.stations[0], 'zigbangId', { enumerable: true, get() { throw new Error('synthetic hint failure'); } });
  const state = f.api.setBrowseAuto({ enabled: true, areaIds: [1], sites: ['dabang'] });
  assert.equal(state.configuredJobs, 2);
  assert.deepEqual(clone(state.zigbangAreaIds), []);
  assert.throws(() => f.api.setBrowseAuto({ enabled: true, areaIds: [1], sites: ['zigbang'] }), { statusCode: 409 });
});

test('changed Zigbang hints before claim fail closed while a claimed request retains its frozen station', () => {
  const f = fixture(); f.client.version = '0.8.9';
  f.api.setBrowseAuto({ enabled: true, areaIds: [1], sites: ['zigbang'] });
  f.api.runBrowseAutoNow();
  f.stations[0].zigbangId = '778';
  assert.equal(f.api.pollBrowseAuto(f.client).request, null);
  assert.equal(f.api.browseAutoState().last.status, 'failed');
  f.api.runBrowseAutoNow();
  const request = clone(f.api.pollBrowseAuto(f.client).request);
  f.stations[0].zigbangId = '779';
  assert.deepEqual(clone(f.api.pollBrowseAuto(f.client).request), request, 'a claimed run never switches station midway');
});

test('mixed scheduling and receipt indexes follow area-major Dabang-then-Zigbang order', () => {
  const f = fixture(); f.client.version = '0.8.9';
  const area = { ...f.areas[0], id: 2, name: '둘째 예시 지역', lat: 35.11 };
  f.areas.push(area);
  f.stations.push({ name: '둘째 예시역', lat: area.lat, lng: area.lng, zigbangId: '778' });
  const scopes = JSON.parse(f.settings.get('browse_area_scopes'));
  scopes[2] = { area: { name: area.name, lat: area.lat, lng: area.lng }, regions: [f.regions[0]] };
  f.settings.set('browse_area_scopes', JSON.stringify(scopes));
  const state = f.api.setBrowseAuto({ enabled: true, areaIds: [1, 2], sites: ['zigbang', 'dabang'] });
  assert.equal(state.configuredJobs, 5);
  f.api.runBrowseAutoNow();
  assert.equal(f.api.pollBrowseAuto({ ...f.client, version: '0.8.5' }).request, null, 'any Zigbang job raises the minimum extension version');
  assert.equal(f.api.pollBrowseAuto({ ...f.client, version: '0.8.8' }).request, null, 'mixed schedules also require the corrected Zigbang recovery');
  const request = clone(f.api.pollBrowseAuto(f.client).request);
  const receipts = f.receipts(request);
  assert.deepEqual(receipts.map(e => e.scope ? 'dabang' : 'zigbang'), ['dabang', 'dabang', 'zigbang', 'dabang', 'zigbang']);
  const swapped = clone(receipts);
  [swapped[1], swapped[2]] = [{ ...swapped[2], jobId: swapped[1].jobId }, { ...swapped[1], jobId: swapped[2].jobId }];
  f.settings.set('browse_receipts', JSON.stringify(swapped));
  f.report(request, { status: 'running', totalJobs: 5, completeJobs: 5 });
  assert.equal(f.api.browseAutoState().last.completeJobs, 3, 'a valid receipt at another site index is not interchangeable');
  f.settings.set('browse_receipts', JSON.stringify(receipts));
  f.report(request, { totalJobs: 5, completeJobs: 5 });
  assert.equal(f.api.browseAutoState().last.status, 'complete');
  assert.equal(f.api.browseAutoState().last.completeJobs, 5);
});

test('Zigbang completion requires a fresh matching pin and consistent expected/detail/storage counters', () => {
  for (const invalid of ['partial', 'missing', 'unreadable', 'station', 'radius', 'received', 'storage', 'unique', 'excluded', 'old', 'job', 'scope', 'responses']) {
    const f = fixture(); f.client.version = '0.8.9';
    f.api.setBrowseAuto({ enabled: false, areaIds: [1], sites: ['zigbang'] }); f.api.runBrowseAutoNow();
    const request = clone(f.api.pollBrowseAuto(f.client).request), entries = f.receipts(request), entry = entries[0], coverage = entry.receipt.zigbangCoverage;
    if (invalid === 'partial') { coverage.complete = false; coverage.reason = 'missing-details'; }
    if (invalid === 'missing') coverage.missing = 1;
    if (invalid === 'unreadable') coverage.unreadable = 1;
    if (invalid === 'station') coverage.stationId = '778';
    if (invalid === 'radius') coverage.radiusKm = 2.5;
    if (invalid === 'received') coverage.received = 1;
    if (invalid === 'storage') coverage.stored = 1;
    if (invalid === 'unique') entry.receipt.uniqueListings = 1;
    if (invalid === 'excluded') entry.receipt.excludedOutside = 1;
    if (invalid === 'old') entry.at -= 1;
    if (invalid === 'job') entry.jobId = 'other-request:0';
    if (invalid === 'scope') entry.scope = f.regions[0];
    if (invalid === 'responses') entry.receipt.responses = 0;
    f.settings.set('browse_receipts', JSON.stringify(entries));
    f.report(request, { totalJobs: 1, completeJobs: 1 });
    assert.equal(f.api.browseAutoState().last.status, 'partial', invalid);
    assert.equal(f.api.browseAutoState().last.completeJobs, 0, invalid);
  }
  for (const empty of [false, true]) {
    const f = fixture(); f.client.version = '0.8.9';
    f.api.setBrowseAuto({ enabled: false, areaIds: [1], sites: ['zigbang'] }); f.api.runBrowseAutoNow();
    const request = clone(f.api.pollBrowseAuto(f.client).request), entries = f.receipts(request), receipt = entries[0].receipt;
    Object.assign(receipt.zigbangCoverage, empty ? { total: 0, received: 0, stored: 0, excluded: 0 } : { stored: 1, excluded: 1 });
    receipt.uniqueListings = receipt.zigbangCoverage.stored; receipt.excludedOutside = receipt.zigbangCoverage.excluded;
    f.settings.set('browse_receipts', JSON.stringify(entries));
    f.report(request, { totalJobs: 1, completeJobs: 1 });
    assert.equal(f.api.browseAutoState().last.status, 'complete', empty ? 'verified empty result' : 'verified configured-radius exclusion');
  }
});

test('one-off site and area overrides freeze their own plan without changing repeat preferences', () => {
  const f = fixture(); f.client.version = '0.8.9';
  f.api.setBrowseAuto({ enabled: true, areaIds: [1], sites: ['dabang'] });
  const savedConfig = clone(JSON.parse(f.settings.get('browse_auto_state')).config);
  const state = f.api.runBrowseAutoNow({ areaIds: [1], sites: ['zigbang'] });
  assert.deepEqual(clone(state.sites), ['dabang']);
  assert.equal(state.configuredJobs, 2);
  assert.equal(state.last.totalJobs, 1);
  assert.deepEqual(clone(JSON.parse(f.settings.get('browse_auto_state')).config), savedConfig);
  const request = clone(f.api.pollBrowseAuto(f.client).request);
  assert.deepEqual(request.sites, ['zigbang']);
  assert.equal(request.areas[0].zigbangStation.stationId, '777');
  f.settings.set('browse_receipts', JSON.stringify(f.receipts(request)));
  f.report(request, { totalJobs: 1, completeJobs: 1 });
  assert.equal(f.api.browseAutoState().last.status, 'complete');
  f.api.runBrowseAutoNow({});
  assert.deepEqual(clone(f.api.pollBrowseAuto(f.client).request.sites), ['dabang'], 'an empty body keeps the saved repeat selection');
});

test('one-off overrides require both fields and revalidate hints before claim', () => {
  for (const overrides of [{ sites: ['zigbang'] }, { areaIds: [1] }, { areaIds: null, sites: ['zigbang'] }, null]) {
    assert.throws(() => fixture().api.runBrowseAutoNow(overrides), { statusCode: 400 });
  }
  const f = fixture(); f.client.version = '0.8.9';
  f.api.runBrowseAutoNow({ areaIds: [1], sites: ['zigbang'] });
  f.stations[0].zigbangId = '778';
  assert.equal(f.api.pollBrowseAuto(f.client).request, null);
  assert.equal(f.api.browseAutoState().last.status, 'failed');
  assert.deepEqual(clone(f.api.browseAutoState().sites), ['dabang']);
});
