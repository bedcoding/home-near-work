import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/dashboard.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(reply) {
  const messages = [], requests = [], timers = new Map();
  let listener, storageListener, nextTimer = 0;
  const origin = 'http://localhost:8787';
  const win = {
    postMessage: (value, targetOrigin) => messages.push({ ...plain(value), targetOrigin }),
    addEventListener: (_, fn) => { listener = fn; },
  };
  vm.runInNewContext(source, {
    window: win, location: { origin },
    setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
    HNW_SITES: [{ id: 'dabang' }], hnwEnabled: () => true,
    chrome: {
      storage: { local: { get: async () => ({}) }, onChanged: { addListener: (fn) => { storageListener = fn; } } },
      runtime: {
        getManifest: () => ({ version: 'synthetic' }),
        sendMessage: (message) => { requests.push(plain(message)); return reply(message); },
      },
    },
  });
  return {
    messages, requests, timers,
    receive: (type, overrides = {}) => listener({ source: win, origin, data: { source: 'hnw-dashboard', type }, ...overrides }),
    change: (changes) => storageListener(changes, 'local'),
  };
}

test('an old worker with no browse response is not advertised as ready and gives recovery steps', async () => {
  const h = harness(async () => undefined);
  await settle();
  const hello = h.messages.find((m) => m.type === 'hello');
  assert.equal(hello.browse, false);
  assert.match(hello.browseError, /chrome:\/\/extensions/);
  assert.match(hello.browseError, /대시보드.*새로고침/);
  h.receive('browse-status');
  await settle();
  assert.equal(h.messages.at(-1).type, 'browse-status');
  assert.match(h.messages.at(-1).error, /새로고침/);
  assert.equal(Object.hasOwn(h.messages.at(-1), 'state'), false);
  assert.equal(h.timers.size, 0);
});

test('command replies keep request identity and storage updates are independent progress messages', async () => {
  const h = harness(async () => ({ state: null }));
  await settle();
  h.receive('browse-command', { data: { source: 'hnw-dashboard', type: 'browse-command', command: 'start', requestId: 'synthetic-start' } });
  await settle();
  assert.equal(h.messages.at(-1).requestId, 'synthetic-start');
  assert.equal(h.messages.at(-1).requestType, 'browse-command');
  h.change({ 'hnw-browse-state': { newValue: { id: 'synthetic', phase: 'preparing' } } });
  assert.equal(h.messages.at(-1).state.phase, 'preparing');
  assert.equal(h.messages.at(-1).requestId, undefined);
});

test('a recovered worker must answer a fresh handshake before browse becomes available', async () => {
  let ready = false;
  const h = harness(async () => ready ? { state: null } : undefined);
  await settle();
  ready = true;
  h.receive('ping');
  await settle();
  assert.equal(h.messages.filter((m) => m.type === 'hello').at(-1).browse, true);
  assert.equal(h.messages.at(-1).state, null);
  assert.equal(h.messages.at(-1).targetOrigin, 'http://localhost:8787');
});

test('runtime rejection, invalidated context and a silent worker all expose recovery without claiming readiness', async () => {
  for (const reply of [
    () => Promise.reject(new Error('synthetic disconnected runtime')),
    () => { throw new Error('synthetic invalidated context'); },
    () => new Promise(() => {}),
  ]) {
    const h = harness(reply);
    await settle();
    for (const timer of h.timers.values()) timer();
    await settle();
    assert.equal(h.messages.find((m) => m.type === 'hello').browse, false);
    assert.match(h.messages.at(-1).error, /새로고침/);
    assert.equal(h.timers.size, 0);
  }
});

test('messages from another window or origin cannot ask the worker to start a tour', async () => {
  const h = harness(async () => ({ state: null }));
  await settle();
  const before = h.requests.length;
  h.receive('browse-command', { source: {} });
  h.receive('browse-command', { origin: 'https://example.invalid' });
  await settle();
  assert.equal(h.requests.length, before);
});

test('Naver tab and filter requests keep their identity and start passes the chosen tab and key', async () => {
  const tabs = [{ id: 99, title: 'Synthetic map', active: false }];
  const h = harness(async (message) => message.type === 'naver-filter-tabs' ? { tabs }
    : message.type === 'naver-filter-state' ? { context: { key: 'synthetic-key', tabId: message.tabId, conditions: [] } } : { state: null });
  await settle();
  h.receive('naver-filter-tabs', { data: { source: 'hnw-dashboard', type: 'naver-filter-tabs', requestId: 'synthetic-tabs' } });
  await settle();
  assert.deepEqual(h.messages.at(-1), { source: 'hnw-extension', type: 'naver-filter', requestId: 'synthetic-tabs', requestType: 'naver-filter-tabs', tabs, targetOrigin: 'http://localhost:8787' });
  h.receive('naver-filter-state', { data: { source: 'hnw-dashboard', type: 'naver-filter-state', tabId: 99, requestId: 'synthetic-filter' } });
  await settle();
  assert.deepEqual(h.requests.at(-1), { type: 'naver-filter-state', tabId: 99 });
  assert.equal(h.messages.at(-1).context.key, 'synthetic-key');
  h.receive('browse-command', { data: { source: 'hnw-dashboard', type: 'browse-command', command: 'start', sites: ['naver'], areas: [], naverSourceTabId: 99, naverFilterKey: 'synthetic-key', requestId: 'synthetic-start' } });
  await settle();
  assert.equal(h.requests.at(-1).naverSourceTabId, 99);
  assert.equal(h.requests.at(-1).naverFilterKey, 'synthetic-key');
});

test('a worker reply without the requested Naver field gives recovery steps instead of an empty list', async () => {
  const h = harness(async () => ({ state: null }));
  await settle();
  h.receive('naver-filter-tabs', { data: { source: 'hnw-dashboard', type: 'naver-filter-tabs', requestId: 'synthetic-old' } });
  await settle();
  assert.equal(h.messages.at(-1).type, 'naver-filter');
  assert.equal(h.messages.at(-1).requestId, 'synthetic-old');
  assert.match(h.messages.at(-1).error, /새로고침/);
  assert.equal(Object.hasOwn(h.messages.at(-1), 'tabs'), false);
});

test('saving a Naver preset forwards the tab, key and regions and returns the saved preset', async () => {
  const h = harness(async (message) => message.type === 'naver-preset-save' ? { preset: { areaIds: message.areaIds, updatedAt: 1, summary: 'Synthetic', conditions: [] } } : { state: null });
  await settle();
  h.receive('naver-preset-save', { data: { source: 'hnw-dashboard', type: 'naver-preset-save', tabId: 99, filterKey: 'synthetic-key', areaIds: [7], requestId: 'synthetic-preset' } });
  await settle();
  assert.deepEqual(h.requests.at(-1), { type: 'naver-preset-save', tabId: 99, filterKey: 'synthetic-key', areaIds: [7] });
  assert.equal(h.messages.at(-1).requestType, 'naver-preset-save');
  assert.deepEqual(h.messages.at(-1).preset.areaIds, [7]);
});
