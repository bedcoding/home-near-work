import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as regions from '../shared/regions.ts';

const code = ts.transpileModule(fs.readFileSync(new URL('../server/runner.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function fixture() {
  const gone = [];
  const statuses = new Map();
  const saved = [];
  const store = {
    db: { transaction: fn => fn }, allVerdicts: () => [],
    allListings: () => [{ id: 'synthetic-old', source: 'ziptoss', status: 'active', lat: 0, lng: 0 }],
    markGone: ids => gone.push(...ids),
    saveNotices: (id, items) => { saved.push([id, items]); return { added: [], baseline: false }; },
    setNoticeStatus: (id, value) => statuses.set(id, value),
  };
  const dependencies = {
    './db.js': store,
    './collectors/gus.js': { gusFor: () => [], nearNamesFor: () => [] },
    './collectors/types.js': { BlockedError: class extends Error {} },
    '../shared/types.js': { SEOUL_GUS: [] },
    './geo.js': { distanceM: () => 0 },
    '../shared/regions.js': regions,
  };
  const context = { exports: {}, require: id => dependencies[id] ?? {} };
  vm.runInNewContext(code + '\nexports.testCollectNotices = collectNotices;', context);
  return { ...context.exports, gone, statuses, saved };
}

test('incomplete collection never marks previously saved listings gone', () => {
  const f = fixture();
  const areas = [{ id: 1, lat: 0, lng: 0, radiusM: 100 }];
  f.applyResults(1, 'ziptoss', [], areas, false, 'synthetic missing district');
  assert.equal(f.gone.length, 0);
  f.applyResults(2, 'ziptoss', [], areas, true);
  assert.deepEqual(f.gone, ['synthetic-old']);
});

test('notice partial failures preserve results and stay isolated from the next collector', async () => {
  const f = fixture();
  const collectors = [
    { id: 'partial', label: 'Synthetic A', collect: async ctx => { ctx.partial('missing page'); return [{ sourceId: 'one' }]; } },
    { id: 'complete', label: 'Synthetic B', collect: async () => [] },
  ];
  const result = await f.testCollectNotices({}, [], collectors, () => {}, () => false, []);
  assert.equal(result.complete, false);
  assert.equal(result.retryable, true);
  assert.equal(f.saved.length, 2);
  assert.equal(f.statuses.get('partial').ok, false);
  assert.equal(f.statuses.get('partial').count, 1);
  assert.equal(f.statuses.get('complete').ok, true);
});

test('unsupported pagination is visible without triggering futile scheduled retries', async () => {
  const f = fixture();
  const result = await f.testCollectNotices({}, [], [{ id: 'limited', label: 'Synthetic C', collect: async ctx => { ctx.partial('unsupported page', false); return []; } }], () => {}, () => false, []);
  assert.equal(result.complete, false);
  assert.equal(result.retryable, false);
  assert.equal(f.statuses.get('limited').ok, false);
});
