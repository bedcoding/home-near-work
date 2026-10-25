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
