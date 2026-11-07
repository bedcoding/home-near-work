import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { normalizeBrowseProgress } from '../server/browse-progress.ts';
import {page as naverPage} from './fixtures/naver-region.mjs';
import {snapshot,selectedFilter} from './fixtures/naver-context.mjs';
import naverContext from '../server/naver-context.ts';

// Execute the production queue with synthetic Chrome state. No private config,
// production database, browser profile, or external network is accessed.
const source = (name) => fs.readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
const copy = (value) => structuredClone(value);
const plain = (value) => JSON.parse(JSON.stringify(value));
const AREA = { name: '예시 지역', lat: 35.1, lng: 128.1, radiusM: 700 };
const DASH = { frameId: 0, url: 'http://localhost:8787/' };
const KEY = 'hnw-browse-state';
const PREFIX = 'hnw-browse-pending:';
const DONG = { kind: 'dabang-region', name: '예시구 예시동', dong: '예시동', url: 'https://www.dabangapp.com/map/onetwo?search_type=region&search_id=99991' };

test('예약 회차를 다시 받아도 같은 두 동 순회를 재사용하고 새 실행을 만들지 않는다', async () => {
  const h = harness();
  const request = { id: 'scheduled-123', sites: ['dabang'], areas: [{ ...AREA, dabangRegions: [DONG, { ...DONG, dong: '가상동', url: DONG.url.replace('99991', '99992') }] }] };
  const first = await h.api.startAutomatic(request);
  assert.equal(first.id, request.id);
  assert.equal(first.jobs.length, 2);
  assert.equal(first.jobs[0].id, `${request.id}:0`);
  await h.api.tick();
  await h.api.startAutomatic(request);
  assert.equal(h.windows(), 1);
  assert.equal(h.navigations.length, 1);
  assert.equal(h.saved['hnw-browse-auto-report'].requestId, request.id);
  assert.equal(h.saved['hnw-browse-auto-report'].status, 'running');
});

test('예약 조회는 동 범위 없이 실행되지 않고 수동 실행과 중단 작업을 덮어쓰지 않는다', async () => {
  const h = harness();
  const request = { id: 'scheduled-safe', sites: ['dabang'], areas: [{ ...AREA, dabangRegions: [DONG] }] };
  await assert.rejects(h.api.startAutomatic({ ...request, areas: [AREA] }), /invalid automatic request/);
  await h.start();
  const manualId = h.saved[KEY].id;
  await assert.rejects(h.api.startAutomatic(request), (error) => error.code === 'busy');
  await h.command('pause');
  await assert.rejects(h.api.startAutomatic(request), (error) => error.code === 'busy');
  assert.equal(h.saved[KEY].id, manualId);
});

test('시작 기록만 남기고 종료된 워커는 같은 예약 회차를 임의로 다시 실행하지 않는다', async () => {
  const h = harness({ 'hnw-browse-auto-started': 'consumed-run' });
  await assert.rejects(h.api.startAutomatic({ id: 'consumed-run', sites: ['dabang'], areas: [{ ...AREA, dabangRegions: [DONG] }] }), (error) => error.code === 'consumed');
  assert.equal(h.windows(), 0);
});

test('중단된 예약을 수동 새 조회로 대체하면 이전 예약은 실패 보고로 남긴다', async () => {
  const h = harness();
  await h.api.startAutomatic({ id: 'scheduled-replaced', sites: ['dabang'], areas: [{ ...AREA, dabangRegions: [DONG] }] });
  await h.command('pause');
  await h.command('start', { sites: ['dabang'], areas: [AREA] });
  assert.equal(h.saved[KEY].automaticRequestId, undefined);
  assert.equal(h.saved['hnw-browse-auto-report'].requestId, 'scheduled-replaced');
  assert.equal(h.saved['hnw-browse-auto-report'].status, 'failed');
  const replaced = h.writes.filter((v) => v['hnw-browse-auto-report']?.status === 'failed');
  assert.ok(replaced.length > 0);
  assert.ok(replaced.every((v) => v[KEY] && !v[KEY].automaticRequestId), '종료 보고와 새 상태를 같은 저장 작업으로 교체한다');
});

test('예약 수동 재시도도 이전 보고와 새 실행 상태를 함께 저장한다', async () => {
  const h = harness();
  await h.api.startAutomatic({ id: 'scheduled-retry', sites: ['dabang'], areas: [{ ...AREA, dabangRegions: [DONG] }] });
  await h.command('pause');
  h.saved[KEY].jobs[0].status = 'partial';
  await h.command('retry');
  const replacement = h.writes.find((v) => v['hnw-browse-auto-report']?.status === 'failed');
  assert.equal(replacement[KEY].automaticRequestId, undefined);
  assert.notEqual(replacement[KEY].id, 'scheduled-retry');
  assert.equal(replacement[KEY].status, 'running');
});

function harness(initial = {}) {
  const saved = copy(initial), tabs = new Map(), timers = new Map(), handlers = {};
  const posts = [], navigations = [], receipts = new Map(), batches = new Set(), alarms = [], writes = [], requests = [], naverLedgers = new Map();
  let requestResult = {status:200,json:true}, naverStorage = false, filterSnapshot = snapshot();
  let random=0.5,storeDelay=0;
  const math=Object.create(Math);math.random=()=>random;
  let sourceTabs=[{id:99,url:filterSnapshot.pageUrl,title:'Synthetic map'}],activeTab=sourceTabs[0];
  const filterReads=[],sourceReads=[];
  let now = 100000, seq = 0, timerId = 0, windowCount = 0, pageCalls = 0;
  let result = { kind: 'idle', note: '목록 끝' }, offline = false, loseAck = false;
  let stations = initial['hnw-stations'] || [];
  let getHints = async () => ({ stations: copy(stations) });
  const chrome = {
    scripting: { executeScript: async spec => { requests.push({target:copy(spec.target),world:spec.world,args:copy(spec.args)}); return [{result:copy(requestResult)}]; } },
    storage: { local: {
      get: async (keys) => {
        const names = keys == null ? Object.keys(saved) : Array.isArray(keys) ? keys : [keys];
        return copy(Object.fromEntries(names.filter((k) => k in saved).map((k) => [k, saved[k]])));
      },
      getKeys: async () => Object.keys(saved),
      set: async (value) => { writes.push(copy(value)); Object.assign(saved, copy(value)); },
      remove: async (keys) => { for (const k of Array.isArray(keys) ? keys : [keys]) delete saved[k]; },
    } },
    alarms: { create: async (name) => { alarms.push(name); }, clear: async () => {}, onAlarm: { addListener: (fn) => { handlers.alarm = fn; } } },
    runtime: { id: 'synthetic-extension', getURL: file => `chrome-extension://synthetic-extension/${file}`, onStartup: { addListener: (fn) => { handlers.startup = fn; } }, onInstalled: { addListener: (fn) => { handlers.installed = fn; } } },
    windows: { create: async () => { windowCount++; const tab = { id: 10, url: 'about:blank', status: 'complete' }; tabs.set(tab.id, tab); return { tabs: [copy(tab)] }; } },
    tabs: {
      query: async query => query.url ? copy(sourceTabs) : [copy(activeTab)],
      get: async (id) => { const source=sourceTabs.find(tab=>tab.id===id);if(source){sourceReads.push(id);return copy(source);}if (!tabs.has(id)) throw new Error('closed'); return copy(tabs.get(id)); },
      update: async (id, value) => { Object.assign(tabs.get(id), value); navigations.push({ id, ...value }); },
      reload: async (id) => { navigations.push({ id, reload: true }); },
      sendMessage: async (_id, message) => { if(message.type === 'naver-filter-context'){filterReads.push(_id);return copy(filterSnapshot);} if (message.type === 'browse-indicator') return {ok:true}; pageCalls++; return copy(result); },
    },
  };
  const context = vm.createContext({
    chrome, URL, console, Math:math, crypto: { randomUUID: () => `synthetic-${++seq}` },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id=>timers.delete(id),
    postJson: async (path, payload) => {
      if (path === '/api/browse/hints') return getHints();
      posts.push({ path, payload: copy(payload) });
      if (offline) throw new Error('offline');
      const receipt = receipts.get(payload.jobId) || { responses: 0, listings: 0, newCount: 0, changedCount: 0 };
      if (!batches.has(payload.batchId)) { receipt.responses++; receipt.listings += 2; batches.add(payload.batchId); receipts.set(payload.jobId, receipt); }
      if (naverStorage && payload.naverScope) {
        const api=context.HNW_NAVER_LEDGER;
        let ledger=naverLedgers.get(payload.jobId); if(!ledger){ledger=api.create(payload.naverScope);naverLedgers.set(payload.jobId,ledger);}
        for(const capture of payload.captures)api.accept(ledger,capture);
        receipt.naverCoverage=api.coverage(ledger,ledger.ids.length);
      }
      if (loseAck) { loseAck = false; throw new Error('ack lost'); }
      now+=storeDelay;
      return { receipt: copy(receipt) };
    },
  });
  const areaFrom = source('background.js').match(/function areaFrom\(input\) \{[\s\S]*?\n\}/)[0];
  vm.runInContext(`${source('sites.js')}\n${source('areas.js')}\n${source('naver-ledger.js')}\n${source('vendor/lz-string.js')}\n${source('naver-context.js')}\n${source('naver-fetch.js')}\n${areaFrom}\n${source('browse-queue.js')}\nglobalThis.api = HNW_BROWSE;`, context);
  const api = context.api;
  const command = async (command, extra = {}) => api.message({ type: 'browse-command', command, ...extra }, DASH);
  const start = async (sites = ['dabang'], areas = [AREA]) => { await command('start', { sites, areas }); await api.tick(); };
  const sender = () => ({ tab: { id: saved[KEY].tabId }, frameId: 0, url: saved[KEY].jobs[saved[KEY].index].url, documentId: `doc-${saved[KEY].index}` });
  const bind = async (token = 'token') => api.message({ type: 'browse-context', documentToken: token }, sender());
  const capture = async (overrides = {}, from = sender()) => {
    const job = saved[KEY].jobs[saved[KEY].index];
    return api.capture({ browseJobId: job.id, documentToken: 'token', capture: {
      site: job.site, pageUrl: job.url, status: 200, body: '{}', url: 'https://www.dabangapp.com/api/v5/room-list/search',
    }, ...overrides }, from);
  };
  return { api, saved, tabs, handlers, posts, navigations, alarms, writes, command, start, bind, capture,
    advance: (ms = 3000) => { now += ms; }, setResult: (r) => { result = r; },
    setOffline: (v) => { offline = v; }, loseAck: () => { loseAck = true; },
    setStations: (value) => { stations = value; },
    setHints: (fn) => { getHints = fn; },
    windows: () => windowCount, pageCalls: () => pageCalls, pending: () => Object.keys(saved).filter((k) => k.startsWith(PREFIX)),
    requests, setRequestResult: value => {requestResult=value;}, setNaverStorage: value => {naverStorage=value;},
    setFilter: value => {filterSnapshot=value;sourceTabs[0].url=value?.pageUrl || 'https://fin.land.naver.com/map';if(activeTab.id===sourceTabs[0].id)activeTab=sourceTabs[0];},
    setSourceTabs: value => {sourceTabs=value;},setActiveTab: value=>{activeTab=value;},filterReads,sourceReads,
    setRandom:value=>{random=value;},setStoreDelay:value=>{storeDelay=value;},now:()=>now,
  };
}

test('two selected regions reuse one owned tab and only server receipts count as partial results', async () => {
  const h = harness();
  await h.start(['dabang'], [AREA, { ...AREA, name: '두 번째 예시 지역', lat: 35.2 }]);
  assert.equal(h.windows(), 1);
  await h.bind();
  await h.capture();
  h.advance(9000);
  for (let i = 0; i < 4; i++) { await h.api.tick(); h.advance(); }
  assert.equal(h.saved[KEY].jobs[0].status, 'partial');
  assert.equal(h.saved[KEY].jobs[0].receipt.listings, 2);
  assert.equal(h.saved[KEY].jobs[1].status, 'running');
  assert.equal(h.windows(), 1);
  assert.equal(h.navigations.length, 2);
  await h.bind();
  h.advance(9000);
  for (let i = 0; i < 4; i++) { await h.api.tick(); h.advance(); }
  assert.equal(h.saved[KEY].jobs[1].status, 'failed', 'opening a page without captured responses is not success');
  assert.equal(h.saved[KEY].status, 'done');
});

test('only the genuine extension popup can start a pinned GU collection and completion needs server evidence',async()=>{
  const h=harness(), popup={id:'synthetic-extension',url:'chrome-extension://synthetic-extension/popup.html'};
  const area={...AREA,purpose:'collection',region:{kind:'gu',code:'99123',name:'예시도 가상구'}};
  await assert.rejects(h.api.message({type:'browse-status'},{...popup,id:'other-extension'}),/대시보드/);
  await h.api.message({type:'browse-command',command:'start',sites:['naver'],areas:[area]},popup);
  await h.api.tick(); await h.bind();
  let job=h.saved[KEY].jobs[0]; assert.equal(job.naverScope.code,'9912300000');
  assert.equal(new URL(job.url).searchParams.get('tradeTypes'),'A1-B1-B2-B3');
  await h.capture({capture:{...naverPage(['101','102'],{sort:'RANKING_DESC'}),pageUrl:job.url}});
  assert.equal(h.saved[h.pending()[0]].naverScope.code,'9912300000');
  h.advance(9000); h.setResult({kind:'complete',naverCoverage:{code:'9912300000',pages:1,total:2,received:2,complete:true}});
  await h.api.tick(); assert.notEqual(h.saved[KEY].jobs[0].status,'complete');
  h.saved[KEY].jobs[0].receipt.naverCoverage={code:'9912300000',pages:1,total:2,received:2,stored:2,complete:true};
  h.advance(); await h.api.tick(); assert.equal(h.saved[KEY].jobs[0].status,'complete');
});

test('resuming a region starts a new cursor ledger after saving its outbox',async()=>{
  const h=harness(), area={...AREA,purpose:'collection',region:{kind:'gu',code:'99123',name:'예시도 가상구'}};
  await h.start(['naver'],[area]); await h.bind();
  const id=h.saved[KEY].jobs[0].id;
  await h.capture({capture:{...naverPage(['101'],{sort:'RANKING_DESC'}),pageUrl:h.saved[KEY].jobs[0].url}});
  assert.equal(h.pending().length,1);
  await h.command('pause'); await h.command('resume');
  assert.equal(h.pending().length,0); assert.notEqual(h.saved[KEY].jobs[0].id,id);
  assert.equal(h.saved[KEY].jobs[0].receipt,undefined); assert.equal(h.saved[KEY].jobs[0].status,'pending');
});

const NAVER_AREA={...AREA,purpose:'collection',region:{kind:'gu',code:'99123',name:'예시도 가상구'}};
async function naverCapture(h,ids,options){return h.capture({capture:{...naverPage(ids,{sort:'RANKING_DESC',...options}),pageUrl:h.saved[KEY].jobs[0].url}});}

test('current filters are pinned before opening a window and remain fixed through requests, pause and retry',async()=>{
  const h=harness();h.setFilter(snapshot(selectedFilter));h.setNaverStorage(true);
  await h.start(['naver'],[NAVER_AREA]);await h.bind();
  const initial=plain(h.saved[KEY].jobs[0].naverScope.filter);
  assert.deepEqual(initial.rentPrice,selectedFilter.rentPrice);
  assert.equal(new URL(h.navigations[0].url).searchParams.get('rentPrice'),'0-770000');
  await naverCapture(h,['101'],{filter:selectedFilter,more:true,next:['a'],total:2});await h.api.tick();h.advance(9000);await h.api.tick();
  assert.equal(h.requests[0]!==undefined,true);
  assert.deepEqual(JSON.parse(h.requests[0].args[0]).filter.rentPrice,initial.rentPrice);
  await h.command('pause');h.setFilter(snapshot({rentPrice:{max:100}}));await h.command('resume');
  assert.deepEqual(plain(h.saved[KEY].jobs[0].naverScope.filter),initial);
  h.saved[KEY].jobs[0].status='partial';h.saved[KEY].status='done';await h.command('retry');
  assert.deepEqual(plain(h.saved[KEY].jobs[0].naverScope.filter),initial);
});

test('missing or changed preview context and nonregional targets cannot start unrestricted collection',async()=>{
  for(const variant of ['missing','stale','station']) {
    const h=harness();if(variant==='missing')h.setFilter(null);
    await assert.rejects(h.command('start',{sites:['naver'],areas:variant==='station'?[AREA]:[NAVER_AREA],...(variant==='stale'?{naverFilterKey:'outdated'}:{})}));
    assert.equal(h.windows(),0);assert.equal(h.requests.length,0);
  }
});

test('automatic Naver uses the frozen URL and filters without querying an open source tab',async()=>{
  const h=harness();h.setSourceTabs([]);h.setActiveTab({id:55,url:'http://localhost:8787/'});h.setNaverStorage(true);
  const preset=naverContext.read({pageUrl:snapshot(selectedFilter).pageUrl});
  const pinned=naverContext.forArea(NAVER_AREA,preset,'https://fin.land.naver.com/map?center=synthetic');
  const request={id:'scheduled-naver',sites:['naver'],areas:[{...NAVER_AREA,naver:pinned}]};
  await h.api.startAutomatic(request);await h.api.tick();await h.bind();
  assert.equal(h.saved[KEY].jobs.length,1);assert.deepEqual(h.sourceReads,[]);assert.deepEqual(h.filterReads,[]);
  assert.equal(h.saved[KEY].jobs[0].naverScope.filter.rentPrice.max,770000);
  await naverCapture(h,['101'],{filter:selectedFilter});await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].receipt.naverCoverage.complete,true);
  assert.equal(h.saved['hnw-browse-auto-report'].requestId,request.id);
});

test('automatic mixed-source planning keeps region and station jobs separate and rejects changed saved filters',async()=>{
  const h=harness(),preset=naverContext.read({pageUrl:snapshot(selectedFilter).pageUrl}),pinned=naverContext.forArea(NAVER_AREA,preset,'https://fin.land.naver.com/map?center=synthetic');
  await h.api.startAutomatic({id:'mixed-naver',sites:['dabang','naver'],areas:[{...AREA,dabangRegions:[DONG]},{...NAVER_AREA,naver:pinned}]});
  assert.deepEqual(plain(h.saved[KEY].jobs.map(job=>job.site)),['dabang','naver']);
  const broken=harness();
  await assert.rejects(broken.api.startAutomatic({id:'bad-naver',sites:['naver'],areas:[{...NAVER_AREA,naver:{...pinned,scope:{...pinned.scope,filter:{...pinned.scope.filter,rentPrice:{max:999}}}}}]}),/필터/);
  assert.equal(broken.windows(),0);
});

test('popup can select a source map while the dashboard is active and pins that exact tab through start',async()=>{
  const h=harness(),popup={id:'synthetic-extension',url:'chrome-extension://synthetic-extension/popup.html'};
  h.setActiveTab({id:55,url:'http://localhost:8787/'});h.setFilter(snapshot(selectedFilter));
  const available=await h.api.message({type:'naver-filter-tabs'},popup);
  assert.equal(available.tabs.length,1);assert.equal(available.tabs[0].active,false);assert.equal(available.tabs[0].id,99);
  const preview=await h.api.message({type:'naver-filter-state',tabId:99},popup);
  assert.equal(preview.context.tabId,99);assert.deepEqual(h.sourceReads,[99]);assert.deepEqual(h.filterReads,[]);
  await h.api.message({type:'browse-command',command:'start',sites:['naver'],areas:[NAVER_AREA],naverSourceTabId:99,naverFilterKey:preview.context.key},popup);
  await h.api.tick();assert.equal(h.windows(),1);assert.deepEqual(h.sourceReads,[99,99]);assert.deepEqual(h.filterReads,[]);
  assert.deepEqual(plain(h.saved[KEY].jobs[0].naverScope.filter.rentPrice),selectedFilter.rentPrice);
});

test('the dashboard lists Naver tabs and reads only preview text and the key before pinning that tab',async()=>{
  const h=harness();h.setActiveTab({id:55,url:'http://localhost:8787/'});h.setFilter(snapshot(selectedFilter));
  assert.deepEqual(plain((await h.api.message({type:'naver-filter-tabs'},DASH)).tabs.map(tab=>tab.id)),[99]);
  const preview=(await h.api.message({type:'naver-filter-state',tabId:99},DASH)).context;
  assert.deepEqual(Object.keys(preview).sort(),['conditions','key','tabId']);
  assert.ok(preview.conditions.some(row=>row.label==='월세'));
  await h.api.message({type:'browse-command',command:'start',sites:['naver'],areas:[NAVER_AREA],naverSourceTabId:99,naverFilterKey:preview.key},DASH);
  await h.api.tick();assert.equal(h.windows(),1);assert.deepEqual(h.sourceReads,[99,99]);
  assert.deepEqual(plain(h.saved[KEY].jobs[0].naverScope.filter.rentPrice),selectedFilter.rentPrice);
  for(const sender of [{frameId:0,url:'https://example.invalid/'},{frameId:1,url:'http://localhost:8787/'}]) {
    await assert.rejects(h.api.message({type:'naver-filter-tabs'},sender),/대시보드/);
    await assert.rejects(h.api.message({type:'naver-filter-state',tabId:99},sender),/대시보드/);
  }
});

test('the dashboard saves the previewed filter and regions for reservations through the extension',async()=>{
  const h=harness();h.setActiveTab({id:55,url:'http://localhost:8787/'});h.setFilter(snapshot(selectedFilter));
  const key=(await h.api.message({type:'naver-filter-state',tabId:99},DASH)).context.key;
  await h.api.message({type:'naver-preset-save',tabId:99,filterKey:key,areaIds:[7]},DASH);
  const saves=()=>h.posts.filter(post=>post.path==='/api/browse/naver-preset');
  assert.deepEqual(plain(saves()[0].payload.areaIds),[7]);
  assert.equal(new URL(saves()[0].payload.pageUrl).searchParams.get('rentPrice'),'0-770000');
  await assert.rejects(h.api.message({type:'naver-preset-save',tabId:99,filterKey:'outdated',areaIds:[7]},DASH),/달라졌습니다/);
  await assert.rejects(h.api.message({type:'naver-preset-save',tabId:99,filterKey:key,areaIds:[7]},{frameId:0,url:'https://example.invalid/'}),/대시보드/);
  assert.equal(saves().length,1,'stale previews and other pages do not save a preset');
});

test('a dashboard run gives region areas to Naver and station areas to the other sites',async()=>{
  const h=harness();h.setActiveTab({id:55,url:'http://localhost:8787/'});h.setFilter(snapshot(selectedFilter));
  const key=(await h.api.message({type:'naver-filter-state',tabId:99},DASH)).context.key;
  await h.command('start',{sites:['naver','dabang'],areas:[{...AREA,dabangRegions:[DONG]},NAVER_AREA],naverSourceTabId:99,naverFilterKey:key});
  assert.deepEqual(plain(h.saved[KEY].jobs.map(job=>[job.site,job.areaName])),[['dabang','예시 지역 · 예시동'],['naver','예시 지역']]);
  const regionOnly=harness();
  await assert.rejects(regionOnly.command('start',{sites:['dabang'],areas:[NAVER_AREA]}),/구나 동 지역/);
  assert.equal(regionOnly.windows(),0);
});

test('closed, unrelated or invalid source tabs are rejected rather than falling back to a different tab',async()=>{
  const popup={id:'synthetic-extension',url:'chrome-extension://synthetic-extension/popup.html'};
  for(const id of [77,0,'99']) {
    const h=harness();
    await assert.rejects(h.api.message({type:'naver-filter-state',tabId:id},popup));assert.equal(h.filterReads.length,0);
  }
  const h=harness();h.setSourceTabs([{id:77,title:'Unrelated page',url:'https://example.invalid/map'}]);
  assert.equal((await h.api.message({type:'naver-filter-tabs'},popup)).tabs.length,0);
  await assert.rejects(h.command('start',{sites:['naver'],areas:[NAVER_AREA],naverSourceTabId:77}));
  assert.equal(h.windows(),0);assert.equal(h.filterReads.length,0);
});

test('a window losing price filters stops before queuing or requesting unrestricted rows',async()=>{
  const h=harness();h.setFilter(snapshot(selectedFilter));await h.start(['naver'],[NAVER_AREA]);await h.bind();
  await naverCapture(h,['101']);
  assert.equal(h.pending().length,0);assert.match(h.saved[KEY].jobs[0].blocked,/필터/);
  h.advance(9000);await h.api.tick();assert.equal(h.requests.length,0);assert.notEqual(h.saved[KEY].jobs[0].status,'complete');
});

test('legacy unrestricted runs cannot resume but their unsent responses are saved before replacement',async()=>{
  const h=harness();await h.start(['naver'],[NAVER_AREA]);await h.bind();
  await naverCapture(h,['101']);await h.command('pause');delete h.saved[KEY].jobs[0].naverScope.filter;
  await assert.rejects(h.command('resume'),/필터/);await assert.rejects(h.command('retry'),/필터/);
  const previous=h.saved[KEY].jobs[0].id;h.setFilter(snapshot(selectedFilter));
  await h.command('start',{sites:['naver'],areas:[NAVER_AREA]});
  assert.equal(h.pending().length,0);assert.ok(h.posts.some(post=>post.path==='/api/browse/capture'&&post.payload.jobId===previous));
  assert.ok(h.saved[KEY].jobs[0].naverScope.filter.rentPrice);
});
test('Naver cursor requests continue beyond page two without depending on UI lazy loading',async()=>{
  const h=harness(); h.setNaverStorage(true); await h.start(['naver'],[NAVER_AREA]); await h.bind();
  await naverCapture(h,['101','102'],{next:['a'],more:true,total:6}); await h.api.tick();h.advance(9000); await h.api.tick();
  assert.equal(h.requests.length,1); assert.deepEqual(JSON.parse(h.requests[0].args[0]).articlePagingRequest.lastInfo,['a']);
  assert.deepEqual(h.requests[0].target.documentIds,['doc-0']); assert.equal(h.requests[0].world,'MAIN');
  h.advance(); await h.api.tick(); assert.equal(h.requests.length,1,'one pending request waits for durable capture');
  await naverCapture(h,['103','104'],{cursor:['a'],next:['b'],more:true,total:6}); await h.api.tick();h.advance(5000); await h.api.tick();
  assert.equal(h.requests.length,2); assert.deepEqual(JSON.parse(h.requests[1].args[0]).articlePagingRequest.lastInfo,['b']);
  assert.equal(JSON.parse(h.requests[1].args[0]).articlePagingRequest.seed,'synthetic-seed');
  await naverCapture(h,['105','106'],{cursor:['b'],total:6}); h.advance(); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status,'complete'); assert.equal(h.saved[KEY].jobs[0].receipt.naverCoverage.stored,6);
  assert.equal(h.pageCalls(),0,'network pagination needs no further card scrolls');
});
test('denied or unacknowledged page requests stop once and never fabricate completion',async()=>{
  for(const variant of ['denied','missing-capture']) {
    const h=harness(); h.setNaverStorage(true); if(variant==='denied')h.setRequestResult({status:429,json:false});
    await h.start(['naver'],[NAVER_AREA]); await h.bind();
    await naverCapture(h,['101','102'],{next:['a'],more:true,total:4}); await h.api.tick();h.advance(9000); await h.api.tick();
    h.advance(21000); await h.api.tick(); h.advance(); await h.api.tick();
    assert.equal(h.requests.length,1,variant); assert.notEqual(h.saved[KEY].jobs[0].status,'complete',variant);
    assert.equal(h.saved[KEY].jobs[0].receipt.naverCoverage.stored,2);
  }
});

test('worker recovery retains the pinned filter and advances from an acknowledged cursor',async()=>{
  const first=harness(); first.setNaverStorage(true); await first.start(['naver'],[NAVER_AREA]); await first.bind();
  await naverCapture(first,['101','102'],{next:['a'],more:true,total:6}); await first.api.tick();first.advance(9000); await first.api.tick();
  const resumed=harness(copy(first.saved)), job=resumed.saved[KEY].jobs[0];
  resumed.tabs.set(resumed.saved[KEY].tabId,{id:resumed.saved[KEY].tabId,url:job.url,status:'complete'});
  resumed.advance(12000);
  await naverCapture(resumed,['103','104'],{cursor:['a'],next:['b'],more:true,total:6}); await resumed.api.tick();
  resumed.advance(5000);await resumed.api.tick();
  assert.equal(resumed.requests.length,1); const request=JSON.parse(resumed.requests[0].args[0]);
  assert.deepEqual(request.articlePagingRequest.lastInfo,['b']);
  assert.equal(request.articlePagingRequest.seed,'synthetic-seed');
  assert.deepEqual(request.filter.legalDivisionNumbers,['9912300000']);
});

test('each next page waits its sampled 3 to 5 seconds after storage acknowledgement, including slow writes',async()=>{
  for(const [random,delay] of [[0,3000],[0.5,4000],[0.999999,5000]]) {
    const h=harness();h.setRandom(random);h.setNaverStorage(true);h.setStoreDelay(2500);
    await h.start(['naver'],[NAVER_AREA]);await h.bind();h.advance(9000);
    await naverCapture(h,['101'],{next:['a'],more:true,total:2});const receivedAt=h.now();
    await h.api.tick();const job=h.saved[KEY].jobs[0],ackAt=h.now();
    assert.equal(ackAt-receivedAt,2500);assert.equal(job.naverDelayMs,delay);assert.equal(job.naverNextAt,ackAt+delay);
    h.advance(delay-1);await h.api.tick();assert.equal(h.requests.length,0);
    h.setRandom(0);h.advance(1);await h.api.tick();assert.equal(h.requests.length,1);
    assert.equal(h.saved[KEY].jobs[0].naverDelayMs,delay,'polling must not reroll the wait');
  }
});

test('recovery and duplicate acknowledgements retain the deadline; a new page receives a new delay',async()=>{
  const h=harness();h.setRandom(0.5);h.setNaverStorage(true);await h.start(['naver'],[NAVER_AREA]);await h.bind();h.advance(9000);
  await naverCapture(h,['101'],{next:['a'],more:true,total:3});await h.api.tick();
  const due=h.saved[KEY].jobs[0].naverNextAt;
  h.setRandom(0);h.advance(1000);await naverCapture(h,['101'],{next:['a'],more:true,total:3});await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].naverNextAt,due,'a replay must not replace the sampled deadline');
  const resumed=harness(copy(h.saved)),job=resumed.saved[KEY].jobs[0];resumed.setNaverStorage(true);
  resumed.tabs.set(resumed.saved[KEY].tabId,{id:resumed.saved[KEY].tabId,url:job.url,status:'complete'});
  resumed.advance(due-resumed.now()-1);await resumed.api.tick();assert.equal(resumed.requests.length,0);
  resumed.advance(1);await resumed.api.tick();assert.equal(resumed.requests.length,1);
  resumed.setRandom(0.999999);await naverCapture(resumed,['102'],{cursor:['a'],next:['b'],more:true,total:3});await resumed.api.tick();
  assert.equal(resumed.saved[KEY].jobs[0].naverDelayMs,5000);assert.equal(resumed.saved[KEY].jobs[0].naverDelayPage,2);
});

test('dong jobs retain scope in durable batches and reject navigation to another region', async () => {
  const h = harness();
  await h.start(['dabang'], [{ ...AREA, dabangRegions: [DONG, { ...DONG, dong: '다른예시동', url: DONG.url.replace('99991', '99992') }] }]);
  assert.equal(h.saved[KEY].jobs.length, 2);
  assert.equal(h.saved[KEY].jobs[0].scope.dong, DONG.dong);
  await h.bind(); await h.capture();
  assert.equal(h.saved[h.pending()[0]].scope.dong, DONG.dong);
  const job = h.saved[KEY].jobs[0];
  await h.capture({ capture: { site: 'dabang', pageUrl: job.url.replace('99991', '99992'), body: '{}', url: 'https://www.dabangapp.com/api/v5/room-list/search' } });
  assert.equal(h.pending().length, 1);
  assert.equal(h.api.samePage(job.url, job.url.replace('99991', '99992')), false);
});

test('scoped Dabang runs past old bounds and completes only with matching server coverage', async () => {
  const h = harness(); await h.start(['dabang'], [{ ...AREA, dabangRegions: [DONG] }]);
  await h.bind(); await h.capture(); await h.api.tick();
  h.advance(130000); h.saved[KEY].jobs[0].actions = 45;
  h.setResult({ kind: 'action', note: '다음 페이지' }); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'running');
  assert.equal(h.pageCalls(), 1);
  h.setResult({ kind: 'complete', note: '마지막 페이지' }); h.advance(); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'running', 'page proof without durable server proof is insufficient');
  Object.assign(h.saved[KEY].jobs[0].receipt, { uniqueListings: 2, coverage: { complete: true, pages: 1, totalPages: 1, total: 2, regularUnique: 2, reason: 'complete' } });
  h.advance(); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'complete');
  const doneJob = h.saved[KEY].jobs[0];
  await h.api.capture({ browseJobId: doneJob.id, documentToken: 'token', capture: { site: 'dabang', pageUrl: doneJob.url, status: 200, body: '{}', url: 'https://www.dabangapp.com/api/v5/room-list/search' } },
    { tab: { id: 10 }, frameId: 0, documentId: 'doc-0' });
  assert.equal(h.pending().length, 0, 'finished jobs cannot accept a new response and leave stale completion behind');
});

const ZIGBANG_STATION = { name: '예시역', lat: AREA.lat, lng: AREA.lng, zigbangId: '99991' };
const ZIGBANG_PIN = { stationId: '99991', radiusKm: 1, url: 'https://www.zigbang.com/home/oneroom/subways/99991/items' };
const zigbangProof = (extra = {}) => ({ stationId: '99991', radiusKm: 1, total: 3, received: 3, missing: 0, complete: true, reason: 'complete', ...extra });
async function startZigbang() {
  const h = harness(); h.setStations([ZIGBANG_STATION]); await h.start(['zigbang']);
  await h.bind();
  const job = h.saved[KEY].jobs[0];
  await h.capture({ capture: { site: 'zigbang', pageUrl: job.url, status: 200, body: '{}', url: 'https://apis.zigbang.com/house/property/v1/items/list' } });
  await h.api.tick();
  return h;
}

test('numeric Zigbang station continues past two minutes and forty actions, then verifies page and durable storage', async () => {
  const h = await startZigbang();
  h.advance(130000); h.saved[KEY].jobs[0].actions = 45;
  h.setResult({ kind: 'action', note: '상세 2/3, 미수신 1' }); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'running');
  assert.equal(h.pageCalls(), 1);
  assert.equal(h.saved[KEY].jobs[0].actions, 46);
  h.setResult({ kind: 'complete', zigbangCoverage: zigbangProof() }); h.advance(); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'running', 'page completion alone must wait for durable proof');
  h.saved[KEY].jobs[0].receipt.zigbangCoverage = zigbangProof({ stored: 2, excluded: 1, unreadable: 0 });
  h.advance(); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'complete');
  assert.match(h.saved[KEY].jobs[0].note, /저장 2건, 설정한 지역 범위 밖 제외 1건/);
});

test('Zigbang completion rejects mismatched station, incomplete storage, absent page proof and capture gaps', async () => {
  for (const variant of ['station', 'storage', 'page', 'gap']) {
    const h = await startZigbang();
    const job = h.saved[KEY].jobs[0];
    job.receipt.zigbangCoverage = zigbangProof({ stored: 3, excluded: 0, unreadable: 0,
      ...(variant === 'station' ? { stationId: '99992' } : variant === 'storage' ? { stored: 2 } : {}) });
    if (variant === 'gap') job.captureGap = true;
    h.setResult({ kind: 'complete', ...(variant === 'page' ? {} : { zigbangCoverage: zigbangProof() }) });
    h.advance(9000); await h.api.tick();
    for (let i = 0; i < 9; i++) { h.advance(); await h.api.tick(); }
    assert.equal(h.saved[KEY].jobs[0].status, variant === 'gap' ? 'needs-input' : 'partial', variant);
  }
});

test('Zigbang zero-item station list can complete with matching empty server evidence', async () => {
  const h = await startZigbang();
  const proof = zigbangProof({ total: 0, received: 0 });
  h.saved[KEY].jobs[0].receipt.zigbangCoverage = { ...proof, stored: 0, excluded: 0, unreadable: 0 };
  h.setResult({ kind: 'complete', zigbangCoverage: proof }); h.advance(9000); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'complete');
});

test('Zigbang reaches a bounded partial result after thirty minutes without complete detail evidence', async () => {
  const h = await startZigbang(); h.advance(1800000); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'partial');
  assert.equal(h.pageCalls(), 0, 'no further page actions are issued after the safety bound');
});

test('automatic mixed tours keep server-pinned station and area-major job order despite changed extension hints', async () => {
  const h = harness(); h.setStations([{ ...ZIGBANG_STATION, zigbangId: '99992' }]);
  await h.api.startAutomatic({ id: 'mixed-request', sites: ['dabang', 'zigbang'], areas: [
    { ...AREA, dabangRegions: [DONG], zigbangStation: ZIGBANG_PIN },
    { ...AREA, lat: 35.2, dabangRegions: [{ ...DONG, url: DONG.url.replace('99991', '99992') }], zigbangStation: { ...ZIGBANG_PIN, stationId: '99993', url: ZIGBANG_PIN.url.replace('99991', '99993') } },
  ] });
  const jobs = h.saved[KEY].jobs;
  assert.deepEqual(plain(jobs.map(j => j.site)), ['dabang', 'zigbang', 'dabang', 'zigbang']);
  assert.equal(jobs[1].url, ZIGBANG_PIN.url, 'learned hints cannot replace the frozen station');
  assert.match(jobs[3].url, /99993\/items$/);
  assert.deepEqual(plain(jobs.map(j=>j.id)), ['mixed-request:0','mixed-request:1','mixed-request:2','mixed-request:3']);
});

test('Zigbang-only automatic request requires no Dabang scope and rejects an invalid station pin', async () => {
  const h = harness();
  await h.api.startAutomatic({ id: 'zigbang-request', sites: ['zigbang'], areas: [{ ...AREA, zigbangStation: ZIGBANG_PIN }] });
  assert.equal(h.saved[KEY].jobs.length, 1);
  assert.equal(h.saved[KEY].jobs[0].url, ZIGBANG_PIN.url);
  for (const pin of [undefined, { ...ZIGBANG_PIN, radiusKm: 2 }, { ...ZIGBANG_PIN, stationId: '99992' }, { ...ZIGBANG_PIN, url: ZIGBANG_PIN.url + '?radius=2' }]) {
    const invalid = harness();
    await assert.rejects(invalid.api.startAutomatic({ id: 'bad-pin', sites: ['zigbang'], areas: [{ ...AREA, zigbangStation: pin }] }));
    assert.equal(invalid.saved['hnw-browse-auto-started'], undefined);
    assert.equal(invalid.windows(), 0);
  }
});

test('automatic request cannot silently drop a disabled site or become stuck after preparation fails', async () => {
  const h = harness({ sites: { dabang: true, zigbang: false } });
  await assert.rejects(h.api.startAutomatic({ id: 'disabled-mixed', sites: ['dabang','zigbang'], areas: [{ ...AREA, dabangRegions: [DONG], zigbangStation: ZIGBANG_PIN }] }), /꺼져/);
  assert.equal(h.saved[KEY].jobs.length, 0);
  assert.equal(h.saved['hnw-browse-auto-report'].status, 'failed');
  assert.equal(h.windows(), 0);
  assert.equal(await h.api.automaticReady(), true);
});

test('retry preserves dong URL and scope instead of returning to radius URL', async () => {
  const h = harness(); await h.start(['dabang'], [{ ...AREA, dabangRegions: [DONG] }]);
  await h.bind(); await h.capture(); h.advance(9000);
  for (let i=0;i<4;i++) { await h.api.tick(); h.advance(); }
  assert.equal(h.saved[KEY].jobs[0].status, 'partial');
  const previousId = h.saved[KEY].jobs[0].id;
  assert.equal(h.saved[KEY].jobs[0].received, 1);
  await h.command('retry'); await h.api.tick();
  assert.notEqual(h.saved[KEY].jobs[0].id, previousId);
  assert.equal(new URL(h.saved[KEY].jobs[0].url).searchParams.get('search_id'), '99991');
  assert.equal(h.saved[KEY].jobs[0].scope.dong, DONG.dong);
  assert.equal(h.saved[KEY].jobs[0].received, 0, 'new request must not inherit the previous document response count');
  assert.equal(h.saved[KEY].jobs[0].receipt, undefined);
});

test('an acknowledged-but-lost response retries its original batch without duplicate counts', async () => {
  const h = harness();
  await h.start(); await h.bind(); await h.capture();
  h.loseAck();
  await h.api.tick();
  assert.equal(h.saved[KEY].status, 'paused');
  assert.equal(h.pending().length, 1);
  assert.equal(h.saved[KEY].jobs[0].receipt, undefined);
  await h.api.tick();
  assert.equal(h.pending().length, 0);
  assert.equal(h.saved[KEY].jobs[0].receipt.listings, 2);
  assert.equal(h.posts[0].payload.batchId, h.posts[1].payload.batchId);
  assert.equal(h.saved[KEY].status, 'paused', 'recovered server connection does not restart page actions');
  assert.equal(h.pageCalls(), 0);
  await h.command('resume'); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'running');
  assert.equal(h.navigations.at(-1).reload, true);
});

test('unrelated tabs, old documents, wrong sites and unrelated responses cannot enter the tour outbox', async () => {
  const h = harness(); await h.start(); await h.bind();
  const job = h.saved[KEY].jobs[0];
  const message = { browseJobId: job.id, documentToken: 'token', capture: { site: 'dabang', pageUrl: job.url, body: '{}', url: 'https://www.dabangapp.com/api/v5/room-list/search' } };
  for (const sender of [
    { tab: { id: 99 }, frameId: 0, documentId: 'doc-0' },
    { tab: { id: 10 }, frameId: 1, documentId: 'doc-0' },
    { tab: { id: 10 }, frameId: 0, documentId: 'old-doc' },
  ]) await h.api.capture(message, sender);
  await h.capture({ documentToken: 'stale-token' });
  await h.capture({ capture: { ...message.capture, site: 'naver' } });
  await h.capture({ capture: { ...message.capture, url: 'https://www.dabangapp.com/api/profile' } });
  assert.equal(h.pending().length, 0);
  await h.capture(); assert.equal(h.pending().length, 1);
  await assert.rejects(h.api.message({ type: 'browse-command', command: 'pause' }, { ...DASH, url: 'https://example.invalid/' }), /대시보드/);
});

test('missing region hints and disabled sites are never replaced by homepage visits', async () => {
  const h = harness({ sites: { naver: false } });
  await h.start(['naver', 'zigbang', 'hogangnono'],[AREA]);
  assert.equal(h.windows(), 0);
  assert.deepEqual(plain(h.saved[KEY].jobs.map((j) => j.status)), ['needs-input', 'needs-input']);
  assert.equal(h.saved[KEY].status, 'done');
  await h.command('retry'); await h.api.tick();
  assert.equal(h.windows(), 0);
});

test('the final allowed action settles before navigation and waiting replies reset idle detection', async () => {
  const h = harness(); await h.start(); await h.bind(); await h.capture();
  h.saved[KEY].jobs[0].actions = 39;
  h.advance(9000); h.setResult({ kind: 'action', note: 'scroll' });
  await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'running');
  h.advance(); await h.api.tick();
  assert.equal(h.pageCalls(), 1, 'no 41st action');
  assert.equal(h.saved[KEY].jobs[0].status, 'running');
  await h.capture();
  h.advance(9000); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'partial');
  assert.equal(h.saved[KEY].jobs[0].receipt.responses, 2, 'final response persisted before completion');

  const other = harness(); await other.start(); await other.bind();
  other.advance(9000); other.saved[KEY].jobs[0].idle = 2;
  other.setResult({ kind: 'idle', waiting: true, note: 'waiting' });
  await other.api.tick();
  assert.equal(other.saved[KEY].jobs[0].idle, 0);
  assert.equal(other.saved[KEY].jobs[0].status, 'running');
});

test('blocked responses, manual navigation and browser restart stop page actions', async () => {
  const h = harness(); await h.start(); await h.bind();
  const job = h.saved[KEY].jobs[0];
  await h.capture({ capture: { site: 'dabang', pageUrl: job.url, body: '{}', status: 429, url: 'https://www.dabangapp.com/api/v5/room-list/search' } });
  await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'needs-input');
  assert.equal(h.pageCalls(), 0);

  const moved = harness(); await moved.start(); await moved.bind();
  moved.tabs.get(10).url = 'https://www.dabangapp.com/another-page';
  await moved.api.tick();
  assert.equal(moved.saved[KEY].status, 'paused');
  assert.equal(moved.navigations.length, 1);
  const restarted = harness(moved.saved);
  restarted.handlers.startup();
  await restarted.api.tick(); // 상태 읽기는 이제 변경 작업의 완료를 기다리지 않는다.
  assert.equal(restarted.saved[KEY].tabId, null);
  await restarted.command('resume'); await restarted.api.tick();
  assert.equal(restarted.windows(), 1);
});

test('preparation is observable immediately and status never waits behind a slow hint request', { timeout: 1500 }, async () => {
  const h = harness();
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { entered = resolve; });
  h.setHints(async () => { entered(); return held; });
  const starting = h.command('start', { sites: ['dabang'], areas: [AREA] });
  await reached;
  const { state } = await h.api.message({ type: 'browse-status' }, DASH);
  assert.equal(state.phase, 'preparing');
  assert.equal(state.jobs.length, 0);
  assert.deepEqual(plain(state.logs.map((e) => e.code)), ['start', 'hints']);
  release({ stations: [] });
  await starting;
  assert.equal(h.saved[KEY].jobs.length, 1);
  assert.equal(h.saved[KEY].logs.at(-1).code, 'ready');
});

test('failed preparation leaves a visible explanation instead of a silent empty run', async () => {
  const h = harness();
  h.setHints(async () => { throw Object.assign(new Error('synthetic unavailable'), { status: 503 }); });
  await assert.rejects(h.command('start', { sites: ['dabang'], areas: [AREA] }), /synthetic unavailable/);
  assert.equal(h.saved[KEY].status, 'paused');
  assert.equal(h.saved[KEY].phase, 'error');
  assert.match(h.saved[KEY].detail, /503/);
  assert.equal(h.saved[KEY].logs.at(-1).code, 'error');
  await assert.rejects(h.command('resume'), /새 순회/);
});

test('coded progress records receipt and save separately, stays bounded and omits private page data', async () => {
  const h = harness(); await h.start(); await h.bind();
  for (let i = 0; i < 105; i++) await h.capture();
  assert.equal(h.saved[KEY].logs.length, 100);
  assert.equal(h.saved[KEY].logs.at(-1).code, 'received');
  assert.equal(h.saved[KEY].jobs[0].receipt, undefined);
  await h.api.tick();
  assert.ok(h.saved[KEY].logs.some((e) => e.code === 'saved'));
  const value = plain(h.api.diagnostic(h.saved[KEY]));
  assert.equal(normalizeBrowseProgress(value, 100001).totals.responses, 12);
  assert.equal(value.current.received, 105);
  const json = JSON.stringify(value);
  assert.equal(json.includes(AREA.name), false);
  assert.equal(json.includes('https://'), false);
  assert.equal(json.includes('pageUrl'), false);
});

test('worker recovery restores scheduling while extension updates pause invalidated page scripts', async () => {
  const h = harness(); await h.start(); await h.bind();
  const recovered = harness(h.saved);
  await recovered.api.recover();
  assert.ok(recovered.alarms.includes('hnw-browse'));
  assert.equal(recovered.saved[KEY].status, 'running');
  assert.equal(recovered.saved[KEY].logs.at(-1).code, 'recovered');
  recovered.handlers.installed();
  await recovered.api.tick();
  assert.equal(recovered.saved[KEY].status, 'paused');
  assert.equal(recovered.saved[KEY].phase, 'paused');
  assert.equal(recovered.pageCalls(), 0);
});

test('loading and missing page scripts fail visibly instead of reporting collection success', async () => {
  const loading = harness(); await loading.start(); loading.advance(46000); await loading.api.tick();
  assert.equal(loading.saved[KEY].jobs[0].status, 'failed');
  const missing = harness(); await missing.start(); await missing.bind(); missing.advance(9000); missing.setResult(null);
  await missing.api.tick();
  assert.equal(missing.saved[KEY].jobs[0].status, 'failed');
});

test('paused or redirected tour documents remain owned and never become manual capture documents', async () => {
  const h = harness(); await h.start(); await h.bind();
  await h.command('pause');
  assert.deepEqual(plain(await h.bind('new-document')), { owned: true, jobId: null });
  assert.equal(await h.api.ownsTab(10), true);
  assert.equal(await h.api.ownsTab(99), false);
  assert.equal(await h.api.ownsTab(undefined), false);
  h.tabs.delete(10);
  await h.command('resume'); await h.api.tick();
  assert.equal(h.windows(), 2, 'one resume click creates a replacement for a closed tour tab');
});

test('retry fetches newly learned station hints instead of revisiting missing hints from cache', async () => {
  const h = harness(); await h.start(['zigbang']);
  assert.equal(h.saved[KEY].jobs[0].status, 'needs-input');
  h.setStations([{ name: '예시역', lat: AREA.lat, lng: AREA.lng, zigbangId: 'synthetic-station' }]);
  await h.command('retry'); await h.api.tick();
  assert.equal(h.saved[KEY].jobs[0].status, 'running');
  assert.match(h.navigations[0].url, /subways\/synthetic-station\/items$/);
});

test('당근부동산은 대시보드 조회하기가 모으므로 순차 조회의 사이트로 받지 않는다', async () => {
  const h = harness({ 'hnw-stations': [{ name: '예시역', lat: 35.1, lng: 128.1 }] });
  await h.start(['zigbang', 'daangn'], [AREA]);
  assert.ok(!(h.saved[KEY]?.jobs ?? []).some((j) => j.site === 'daangn'));
});
