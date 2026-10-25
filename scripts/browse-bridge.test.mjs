import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/bridge.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function page(contextReply, failure = null) {
  let onCapture;
  const sent = [];
  const snapshots = [];
  const window = { addEventListener(_name, listener) { onCapture = listener; } };
  const context = {
    window, URL, location: { hostname: 'example.invalid', href: 'https://example.invalid/map' },
    crypto: { randomUUID: () => 'synthetic-document' },
    hnwSiteFor: () => ({ id: 'naver' }),
    setTimeout(callback) { snapshots.push(callback); },
    document: { title: 'Synthetic page', documentElement: { outerHTML: '<html></html>' } },
    innerWidth: 1000, innerHeight: 700,
    chrome: { runtime: {
      id: 'synthetic-extension',
      onMessage: { addListener() {} },
      sendMessage(message) {
        if (message.type === 'browse-context') {
          if (failure === 'throw') throw new Error('synthetic unavailable worker');
          if (failure === 'reject') return Promise.reject(new Error('synthetic unavailable worker'));
          return Promise.resolve(contextReply);
        }
        sent.push(message);
        return Promise.resolve({ ok: true });
      },
    } },
  };
  vm.runInNewContext(source, context);
  onCapture({ source: window, data: {
    __hnw: 'capture', url: 'https://example.invalid/api/clusteredArticles',
    method: 'GET', status: 200, requestBody: null, body: '{"result":{"list":[]}}',
  } });
  await settle();
  return { sent, snapshots };
}

test('a bound tour document keeps its job and document identity on every captured response', async () => {
  const { sent } = await page({ owned: true, jobId: 'synthetic-job' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].browseJobId, 'synthetic-job');
  assert.equal(sent[0].documentToken, 'synthetic-document');
});

test('only an explicitly ordinary document enters normal capture', async () => {
  const { sent, snapshots } = await page(null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].browseJobId, undefined);
  assert.equal(snapshots.length, 1);
});

test('paused or redirected tour documents and failed handshakes cannot fall back to normal capture or snapshots', async () => {
  for (const [reply, failure] of [
    [{ owned: true, jobId: null }, null],
    [{ error: 'synthetic context error' }, null],
    [undefined, null],
    [null, 'throw'],
    [null, 'reject'],
  ]) {
    const { sent, snapshots } = await page(reply, failure);
    assert.equal(sent.length, 0);
    assert.equal(snapshots.length, 0);
  }
});
