import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const sitesSource = fs.readFileSync(new URL('../extension/sites.js', import.meta.url), 'utf8');
const daangnCaptureSource = fs.readFileSync(new URL('../extension/daangn-capture.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function worker(storage, status = 503, { ownedTabId = null, ownershipFails = false, existingBridge = null } = {}) {
  let handler;
  const sent = [];
  const registeredScripts = [];
  const updatedScripts = [];
  const event = { addListener() {} };
  const local = {
    getKeys: async () => Object.keys(storage),
    get: async keys => Object.fromEntries((keys == null ? Object.keys(storage) : typeof keys === 'string' ? [keys] : keys).map(key => [key, storage[key]])),
    set: async values => Object.assign(storage, values),
    remove: async keys => { for (const key of typeof keys === 'string' ? [keys] : keys) delete storage[key]; },
  };
  const context = {
    importScripts() {}, URL, AbortSignal, crypto: { randomUUID },
    setTimeout() {},
    HNW_BROWSE: {
      ownsTab: async (id) => {
        if (ownershipFails) throw new Error('synthetic storage failure');
        return id != null && id === ownedTabId;
      },
      capture: async () => {},
    },
    chrome: {
      storage: { local, onChanged: event },
      scripting: {
        getRegisteredContentScripts: async () => existingBridge ? [existingBridge] : [],
        registerContentScripts: async scripts => registeredScripts.push(...scripts),
        updateContentScripts: async scripts => updatedScripts.push(...scripts),
      },
      action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
      runtime: { onMessage: { addListener(fn) { handler = fn; } }, onInstalled: event, onStartup: event, getManifest: () => ({ version: 'test' }) },
      downloads: { onChanged: event }, alarms: { onAlarm: event, clear: async () => {} },
    },
    fetch: async (url, options) => {
      if (!url.endsWith('/api/naver/capture')) throw new Error('test ignores version checks');
      sent.push(JSON.parse(options.body).captures);
      return { ok: status === 200, status, json: async () => ({ total: sent.flat().length }) };
    },
  };
  vm.runInNewContext(sitesSource + '\n' + daangnCaptureSource + '\n' + source + '\nglobalThis.testApi = { flushPending, isListing, registerSiteScripts };', context);
  return {
    ...context.testApi, sent, registeredScripts, updatedScripts,
    capture: (capture, sender = {}) => new Promise(resolve => assert.equal(handler({ type: 'capture', capture }, sender, resolve), true)),
  };
}
const captures = [
  { site: 'naver', url: 'https://example.invalid/api/clusteredArticles' },
  { site: 'naver', url: 'https://example.invalid/api/boundedArticles' },
  { site: 'naver', url: 'https://example.invalid/api/legalDivisionArticleList?query=synthetic' },
  { site: 'dabang', url: 'https://example.invalid/api/v5/room-list/search' },
  { site: 'zigbang', url: 'https://example.invalid/house/property/v1/items/list' },
  { site: 'zigbang', url: 'https://example.invalid/house/property/v1/items/subways/123/onerooms?radius=1' },
].map((capture, i) => ({ ...capture, body: JSON.stringify({ synthetic: i }) }));

test('manual list pages are durable while map counts and aggregation are not listing pages', () => {
  const background = worker({});
  for (const name of ['boundedArticles', 'clusteredArticles', 'legalDivisionArticleList/']) {
    assert.equal(background.isListing({ site: 'naver', url: `https://example.invalid/api/${name}` }), true);
  }
  for (const name of ['boundedArticlesCount', 'articleClusters', 'unrelatedArticles']) {
    assert.equal(background.isListing({ site: 'naver', url: `https://example.invalid/api/${name}` }), false);
  }
});

test('listing captures survive an offline worker restart and replay successfully', async () => {
  const storage = {};
  const offline = worker(storage);
  await Promise.all(captures.map(capture => offline.capture(capture)));
  await settle();
  assert.equal(Object.keys(storage).length, captures.length);
  const restarted = worker(storage, 200);
  await restarted.flushPending();
  assert.equal(Object.keys(storage).length, 0);
  assert.deepEqual(restarted.sent.flat().map(c => c.body).sort(), captures.map(c => c.body).sort());
});

test('the worker keeps Daangn scripts available for the dedicated tour with passive capture disabled', async () => {
  const background = worker({ sites: { daangn: false, naver: false } });
  await background.registerSiteScripts();
  assert.deepEqual(background.registeredScripts.map(script => script.id), ['hnw-hook', 'hnw-bridge']);
  const [main, isolated] = background.registeredScripts;
  assert.ok(main.js.includes('daangn-capture.js'));
  assert.ok(!main.js.some(file => isolated.js.includes(file)), 'Chrome must get distinct script resources in each world');
  for (const script of background.registeredScripts) {
    assert.ok(script.matches.includes('https://realty.daangn.com/*'));
    assert.ok(!script.matches.includes('https://fin.land.naver.com/*'));
  }
});

test('a worker-only reload removes the duplicate parser from the existing isolated registration', async () => {
  const background = worker({}, 200, { existingBridge: { id: 'hnw-bridge', js: ['sites.js', 'daangn-capture.js', 'bridge.js'] } });
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(background.updatedScripts)), [{ id: 'hnw-bridge', js: ['sites.js', 'bridge.js'] }]);
  assert.deepEqual(background.registeredScripts, []);
});

test('the worker retains only the opted-in public fields of passive Daangn map responses', async () => {
  const storage = { sites: { daangn: false } };
  const offline = worker(storage);
  const pageUrl = 'https://realty.daangn.com/map?region_bounds=10%2C20%2C11%2C21%2C14';
  const capture = { site: 'daangn', url: 'https://realty.kr.karrotmarket.com/graphql', status: 200, pageUrl,
    requestBody: '{"variables":{"after":"synthetic","private":"discard"}}',
    body: '{"data":{"articleFeed":{"edges":[],"pageInfo":{"hasNextPage":false}},"viewer":{"private":"discard"}}}' };
  const disabled = await offline.capture(capture, { url: pageUrl });
  assert.equal(disabled.reason, 'passive-capture-disabled');
  assert.equal(Object.keys(storage).filter(key => key.startsWith('pending:')).length, 0);
  assert.equal(offline.sent.length, 0);

  storage.sites.daangn = true;
  assert.equal((await offline.capture(capture, { url: pageUrl })).ok, true);
  assert.equal((await offline.capture({ ...capture, status: 403 }, { url: pageUrl })).ok, false);
  await settle();
  const pending = Object.entries(storage).filter(([key]) => key.startsWith('pending:')).map(([, value]) => value);
  assert.equal(pending.length, 1);
  assert.doesNotMatch(JSON.stringify(pending), /viewer|private|discard/);
  assert.equal(pending[0].requestBody, null);
});

test('temporary 429 responses retain the durable queue; invalid requests are discarded', async () => {
  const storage = {};
  await worker(storage, 429).capture(captures[1]);
  await settle();
  assert.equal(Object.keys(storage).length, 1);
  await worker(storage, 400).flushPending();
  assert.equal(Object.keys(storage).length, 0);
});

test('untagged captures from the reserved tour tab never enter the ordinary capture queue', async () => {
  const storage = {};
  const background = worker(storage, 503, { ownedTabId: 7 });
  const result = await background.capture(captures[0], { tab: { id: 7 } });
  await settle();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unbound-browse');
  assert.equal(Object.keys(storage).length, 0);
  assert.equal(background.sent.length, 0);

  await background.capture(captures[0], { tab: { id: 8 } });
  await settle();
  assert.equal(Object.keys(storage).length, 1, 'an unrelated manual tab still persists its capture');
});

test('an ownership lookup failure cannot silently reroute a tour response into ordinary capture', async () => {
  const storage = {};
  const background = worker(storage, 200, { ownershipFails: true });
  assert.equal((await background.capture(captures[0], { tab: { id: 7 } })).ok, false);
  assert.equal(Object.keys(storage).length, 0);
  assert.equal(background.sent.length, 0);
});
