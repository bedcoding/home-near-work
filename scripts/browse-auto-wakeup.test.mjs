import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// A reloaded worker can have no installed/startup event. The dashboard may keep
// it alive, so a one-time startup poll cannot pick up a later user request.
const code = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

function worker({ existingAlarm = undefined } = {}) {
  const alarmHandlers = [], created = [], requests = [];
  let polls = 0;
  const event = { addListener() {} };
  const chrome = {
    storage: { local: { get: async () => ({}), getKeys: async () => [] }, onChanged: event },
    runtime: { onMessage: event, onInstalled: event, onStartup: event, getManifest: () => ({ version: '0.8.5' }) },
    downloads: { onChanged: event },
    alarms: {
      create: async (name, config) => { created.push({ name, config }); },
      get: async () => existingAlarm,
      onAlarm: { addListener(fn) { alarmHandlers.push(fn); } },
    },
  };
  const context = vm.createContext({
    chrome, URL, AbortSignal, console,
    importScripts() {},
    HNW_AUTO_BROWSE: { poll: async () => { polls++; } },
    HNW_BROWSE: {},
    fetch: async (url) => {
      requests.push(url);
      if (url.includes('/api/extension/version')) return { json: async () => ({ version: '0.8.5' }) };
      throw new Error('synthetic offline');
    },
  });
  vm.runInContext(code, context);
  return { created, requests, polls: () => polls, alarm(name) { for (const handler of alarmHandlers) handler({ name }); } };
}

test('worker reload restores automatic polling without relying on installed or startup events', async () => {
  const h = worker();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.polls(), 1);
  assert.ok(h.created.some(a => a.name === 'hnw-browse-auto'), 'the reloaded worker must restore its automatic polling alarm');
});

test('an existing version alarm retries queued requests when no automatic alarm survived', async () => {
  const h = worker();
  await new Promise(resolve => setImmediate(resolve));
  const before = h.polls();
  h.alarm('hnw-version');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.polls(), before + 1, 'the next version tick must pick up a request created after worker load');
});

test('routine worker wakeups preserve the next tick of an existing automatic alarm', async () => {
  const h = worker({ existingAlarm: { name: 'hnw-browse-auto', periodInMinutes: 0.5 } });
  await new Promise(resolve => setImmediate(resolve));
  h.alarm('hnw-version');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.created.filter(a => a.name === 'hnw-browse-auto').length, 0, 'do not continually reset the alarm while dashboard polling keeps waking the worker');
});
