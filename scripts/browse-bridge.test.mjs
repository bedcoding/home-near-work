import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/bridge.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function page(contextReply, failure = null, { site = 'naver', locationUrl = 'https://example.invalid/map', capture = {}, sites = {} } = {}) {
  let onCapture;
  const sent = [];
  const snapshots = [];
  const window = { addEventListener(_name, listener) { onCapture = listener; } };
  const context = {
    window, URL, location: new URL(locationUrl),
    crypto: { randomUUID: () => 'synthetic-document' },
    hnwSiteFor: () => ({ id: site }),
    hnwEnabled: (toggles, target) => toggles?.[target.id] === true,
    setTimeout(callback) { snapshots.push(callback); },
    document: { title: 'Synthetic page', documentElement: { outerHTML: '<html></html>' } },
    innerWidth: 1000, innerHeight: 700,
    chrome: { storage: { local: { get: async () => ({ sites }) } }, runtime: {
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
  onCapture({ source: window, origin: context.location.origin, data: {
    __hnw: 'capture', url: 'https://example.invalid/api/clusteredArticles',
    method: 'GET', status: 200, requestBody: null, body: '{"result":{"list":[]}}', ...capture,
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

test('Daangn ordinary tabs require passive opt-in, while a bound job still receives listing pages and denials', async () => {
  const locationUrl = 'https://realty.daangn.com/map?region_bounds=10%2C20%2C11%2C21%2C14';
  const context = { site: 'daangn', locationUrl };
  const base = { url: 'https://realty.kr.karrotmarket.com/graphql', requestPageUrl: locationUrl };
  const body = '{"data":{"articleFeed":{"edges":[],"pageInfo":{"hasNextPage":false}}}}';
  const normal = { ...context, capture: { ...base, body } };
  const disabled = await page(null, null, normal);
  assert.equal(disabled.snapshots.length, 0);
  assert.equal(disabled.sent.length, 0);

  const passive = await page(null, null, { ...normal, sites: { daangn: true } });
  assert.equal(passive.snapshots.length, 0);
  assert.equal(passive.sent.length, 1);
  assert.equal(passive.sent[0].capture.body, body);
  const owned = await page({ owned: true, jobId: 'synthetic-job' }, null, normal);
  assert.equal(owned.sent.length, 1);
  assert.equal(owned.sent[0].browseJobId, 'synthetic-job');

  const denial = { ...context, capture: { ...base, status: 403, requestBody: 'discard', body: 'discard' } };
  assert.equal((await page(null, null, { ...denial, sites: { daangn: true } })).sent.length, 0);
  const bound = await page({ owned: true, jobId: 'synthetic-job' }, null, denial);
  assert.equal(bound.sent[0].browseJobId, 'synthetic-job');
  assert.equal(bound.sent[0].capture.status, 403);
  assert.equal(bound.sent[0].capture.body, '');
  assert.equal(bound.sent[0].capture.requestBody, null);
  assert.equal(bound.snapshots.length, 0);
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
