import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as types from '../shared/types.ts';
import * as regions from '../shared/regions.ts';
import * as identity from '../server/identity.ts';

const code = ts.transpileModule(fs.readFileSync(new URL('../server/runner.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function run({ skipWrite = false, wrongRun = false } = {}) {
  const rows = new Map(), gone = [], notes = [];
  const area = { id: 1, name: '가상구', lat: 35, lng: 128, radiusM: 1, enabled: true, purpose: 'collection',
    region: { kind: 'gu', code: '99123', sido: '예시도', sigungu: '가상구', dong: null, name: '예시도 가상구' } };
  const listing = { source: 'dabang', sourceId: '101', title: 'Synthetic listing', address: '예시도 다른구 가상동',
    lat: 36, lng: 129, url: 'https://example.invalid/listing', buildingType: '아파트', prices: [{ deal: 'monthly', deposit: 100, monthly: 30, price: null }] };
  const collector = { id: 'dabang', label: '다방', emptyOk: true, retainMissing: true, collect: async ctx => {
    ctx.coverage({ areaId: 1, areaName: '가상구', category: 'apt', label: '아파트', pages: 1, totalPages: 1,
      total: 1, received: 1, stored: 0, complete: true, reason: 'verified' }, ['101']);
    return [{ listing, raw: { seq: 101 }, pageUrl: 'https://example.invalid/data', screenshot: null }];
  } };
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const store = {
    enabledAreas: () => [area], createRun: () => 12, aptGus: () => [], allVerdicts: () => [],
    db: { transaction: fn => fn }, getListing: id => rows.get(id), allListings: () => [...rows.values()],
    insertListing: (id, listing, key, sig, runId) => { if (!skipWrite) rows.set(id, { source: listing.source, data: JSON.stringify(listing), price_sig: sig, last_seen_run: wrongRun ? 11 : runId }); },
    hasBaseline: () => false, setBaseline() {}, aptSpot: () => -1, markGone: ids => gone.push(...ids),
    tidyListings: () => ({ stale: 0, purged: 0 }), finishRun: (_id, _status, summary) => finish(summary),
    getSetting: () => null, setSetting() {}, addEvent() {},
  };
  const dependencies = {
    './db.js': store, './collectors/index.js': { COLLECTORS: [collector] }, './collectors/notices.js': { NOTICE_COLLECTORS: [] },
    './browser.js': { restSeconds: () => 0, BrowserSession: { open: async () => ({ banner: async () => {}, close: async () => {} }) } },
    './collectors/types.js': { BlockedError: class extends Error {} },
    '../shared/types.js': types, '../shared/regions.js': regions, './identity.js': identity,
    './config.js': { COLLECT_MARGIN_M: 500 }, './geo.js': { distanceM: () => 10000 },
    './collectors/gus.js': { gusFor: () => [], nearNamesFor: () => [] },
    './building-register.js': { registryKey: () => null }, './land-zones.js': { vworldKey: () => null },
    './alerts.js': { buildAlerts: () => [], coveredRows: () => new Set(), alertSettings: () => ({}) },
    './notify.js': { notify: (...args) => notes.push(args) },
  };
  const context = { exports: {}, console: { log() {} }, require: id => dependencies[id] ?? {} };
  vm.runInNewContext(code, context);
  context.exports.startRun(false, 'dabang', { quiet: true });
  return { summary: await completed, rows, gone, notes };
}

test('Dabang server collection persists incidental rows and reads storage back before declaring complete', async () => {
  const f = await run();
  assert.equal(f.rows.size, 1);
  assert.equal(f.summary.complete, true, JSON.stringify(f.summary));
  const source = f.summary.sources[0];
  assert.equal(source.kept, 1);
  assert.equal(source.incidentalCount, 1);
  assert.equal(source.coverage[0].stored, 1);
  assert.equal(source.coverage[0].complete, true);
  assert.equal(f.gone.length, 0);
  assert.equal(f.notes.length, 0);
});

test('missing or previously stored rows cannot satisfy the current collection storage proof', async () => {
  for (const options of [{ skipWrite: true }, { wrongRun: true }]) {
    const f = await run(options);
    assert.equal(f.summary.complete, false);
    assert.equal(f.summary.retryable, true);
    assert.equal(f.summary.sources[0].status, 'error');
    assert.equal(f.summary.sources[0].coverage[0].stored, 0);
    assert.equal(f.summary.sources[0].coverage[0].complete, false);
    assert.equal(f.gone.length, 0);
  }
});
