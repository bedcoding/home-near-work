import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { normalizeBrowseProgress } from '../server/browse-progress.ts';

// Execute the production queue with synthetic Chrome state. No private config,
// production database, browser profile, or external network is accessed.
const source = (name) => fs.readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
const copy = (value) => structuredClone(value);
const plain = (value) => JSON.parse(JSON.stringify(value));
const AREA = { name: '예시 지역', lat: 35.1, lng: 128.1, radiusM: 700 };
const DASH = { frameId: 0, url: 'http://localhost:8787/' };
const KEY = 'hnw-browse-state';
const PREFIX = 'hnw-browse-pending:';

function harness(initial = {}) {
  const saved = copy(initial), tabs = new Map(), timers = new Map(), handlers = {};
  const posts = [], navigations = [], receipts = new Map(), batches = new Set(), alarms = [];
  let now = 100000, seq = 0, timerId = 0, windowCount = 0, pageCalls = 0;
  let result = { kind: 'idle', note: '목록 끝' }, offline = false, loseAck = false;
  let stations = initial['hnw-stations'] || [];
  let getHints = async () => ({ stations: copy(stations) });
  const chrome = {
    storage: { local: {
      get: async (keys) => {
        const names = keys == null ? Object.keys(saved) : Array.isArray(keys) ? keys : [keys];
        return copy(Object.fromEntries(names.filter((k) => k in saved).map((k) => [k, saved[k]])));
      },
      getKeys: async () => Object.keys(saved),
      set: async (value) => Object.assign(saved, copy(value)),
      remove: async (keys) => { for (const k of Array.isArray(keys) ? keys : [keys]) delete saved[k]; },
    } },
    alarms: { create: async (name) => { alarms.push(name); }, clear: async () => {}, onAlarm: { addListener: (fn) => { handlers.alarm = fn; } } },
    runtime: { onStartup: { addListener: (fn) => { handlers.startup = fn; } }, onInstalled: { addListener: (fn) => { handlers.installed = fn; } } },
    windows: { create: async () => { windowCount++; const tab = { id: 10, url: 'about:blank', status: 'complete' }; tabs.set(tab.id, tab); return { tabs: [copy(tab)] }; } },
    tabs: {
      get: async (id) => { if (!tabs.has(id)) throw new Error('closed'); return copy(tabs.get(id)); },
      update: async (id, value) => { Object.assign(tabs.get(id), value); navigations.push({ id, ...value }); },
      reload: async (id) => { navigations.push({ id, reload: true }); },
      sendMessage: async () => { pageCalls++; return copy(result); },
    },
  };
  const context = vm.createContext({
    chrome, URL, console, crypto: { randomUUID: () => `synthetic-${++seq}` },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    postJson: async (path, payload) => {
      if (path === '/api/browse/hints') return getHints();
      posts.push({ path, payload: copy(payload) });
      if (offline) throw new Error('offline');
      const receipt = receipts.get(payload.jobId) || { responses: 0, listings: 0, newCount: 0, changedCount: 0 };
      if (!batches.has(payload.batchId)) { receipt.responses++; receipt.listings += 2; batches.add(payload.batchId); receipts.set(payload.jobId, receipt); }
      if (loseAck) { loseAck = false; throw new Error('ack lost'); }
      return { receipt: copy(receipt) };
    },
  });
  const areaFrom = source('background.js').match(/function areaFrom\(input\) \{[\s\S]*?\n\}/)[0];
  vm.runInContext(`${source('sites.js')}\n${source('areas.js')}\n${areaFrom}\n${source('browse-queue.js')}\nglobalThis.api = HNW_BROWSE;`, context);
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
  return { api, saved, tabs, handlers, posts, navigations, alarms, command, start, bind, capture,
    advance: (ms = 3000) => { now += ms; }, setResult: (r) => { result = r; },
    setOffline: (v) => { offline = v; }, loseAck: () => { loseAck = true; },
    setStations: (value) => { stations = value; },
    setHints: (fn) => { getHints = fn; },
    windows: () => windowCount, pageCalls: () => pageCalls, pending: () => Object.keys(saved).filter((k) => k.startsWith(PREFIX)),
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
  await h.start(['naver', 'zigbang', 'hogangnono', 'daangn']);
  assert.equal(h.windows(), 0);
  assert.deepEqual(plain(h.saved[KEY].jobs.map((j) => j.status)), ['needs-input', 'needs-input', 'needs-input']);
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
