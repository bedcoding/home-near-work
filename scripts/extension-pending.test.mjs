import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function worker(storage, status = 503, { ownedTabId = null, ownershipFails = false } = {}) {
  let handler;
  const sent = [];
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
      action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
      runtime: { onMessage: { addListener(fn) { handler = fn; } }, onInstalled: event, onStartup: event, getManifest: () => ({ version: 'test' }) },
      downloads: { onChanged: event }, alarms: { onAlarm: event },
    },
    fetch: async (url, options) => {
      if (!url.endsWith('/api/naver/capture')) throw new Error('test ignores version checks');
      sent.push(JSON.parse(options.body).captures);
      return { ok: status === 200, status, json: async () => ({ total: sent.flat().length }) };
    },
  };
  vm.runInNewContext(source + '\nglobalThis.testApi = { flushPending, isListing };', context);
  return {
    ...context.testApi, sent,
    capture: (capture, sender = {}) => new Promise(resolve => assert.equal(handler({ type: 'capture', capture }, sender, resolve), true)),
  };
}
const captures = [
  { site: 'naver', url: 'https://example.invalid/api/clusteredArticles' },
  { site: 'dabang', url: 'https://example.invalid/api/v5/room-list/search' },
  { site: 'zigbang', url: 'https://example.invalid/house/property/v1/items/list' },
  { site: 'zigbang', url: 'https://example.invalid/house/property/v1/items/subways/123/onerooms?radius=1' },
].map((capture, i) => ({ ...capture, body: JSON.stringify({ synthetic: i }) }));

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
