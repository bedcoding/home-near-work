import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function memoryStore(t) {
  const dependencies = {
    'node:fs': { mkdirSync() {} }, 'node:crypto': { randomUUID }, 'better-sqlite3': Database,
    './config.js': { DATA_DIR: '', RUNS_DIR: '', DB_PATH: ':memory:' },
    './stations.js': { DEFAULT_AREAS: [], findStation() { throw new Error('No station lookup in test'); } },
    '../shared/types.js': { CAPTURE_SOURCES: ['naver', 'dabang', 'zigbang'], SEOUL_GUS: [] },
  };
  const context = { exports: {}, require: id => { assert.ok(id in dependencies, id); return dependencies[id]; } };
  vm.runInNewContext(code, context);
  t.after(() => context.exports.db.close());
  return context.exports;
}

test('data revision is stable for reads and changes after DB/file writes or server restart', t => {
  const store = memoryStore(t);
  const initial = store.dataRevision();
  store.getSetting('synthetic');
  store.listRuns();
  assert.equal(store.dataRevision(), initial);
  store.setSetting('synthetic', 'updated');
  const changed = store.dataRevision();
  assert.notEqual(changed, initial);
  store.touchDataRevision();
  assert.notEqual(store.dataRevision(), changed);
  assert.notEqual(memoryStore(t).dataRevision(), initial);
});

test('administrative metadata survives area updates and replacement without changing legacy rows', t => {
  const store = memoryStore(t);
  const region = { kind: 'gu', code: '99123', sido: '예시도', sigungu: '가상구', dong: null, name: '예시도 가상구' };
  const area = store.createArea({ name: '가상구', region, lat: 0, lng: 0, radiusM: 6000, enabled: true });
  const legacy = store.createArea({ name: 'Synthetic station', lat: 0, lng: 0, radiusM: 1000, enabled: false });
  assert.deepEqual(JSON.parse(JSON.stringify(store.listAreas()[0].region)), region);
  store.updateArea(area.id, { enabled: false });
  assert.equal(store.listAreas()[0].region.code, region.code);
  const old = { ...area, enabled: true }; delete old.region;
  store.replaceAreas([old, legacy]);
  assert.equal(store.listAreas()[0].region.code, region.code, 'an old client cannot downgrade identity through a partial update');
  assert.equal(store.listAreas()[1].region, undefined);
  assert.equal(store.listAreas()[0].purpose, 'collection');
  assert.equal(store.listAreas()[1].purpose, 'alert');
  const limits = { monthlyMax: 35, depositMax: 1000, priceMax: null };
  store.updateArea(legacy.id, { alertLimits: limits, enabled: true });
  store.updateArea(legacy.id, { enabled: false });
  assert.deepEqual(JSON.parse(JSON.stringify(store.listAreas()[1].alertLimits)), limits);
  assert.equal(store.listAreas()[0].enabled, true, 'switching station alerts off leaves collection enabled');
});

test('parcel coordinates round-trip and changed PNU clears obsolete zone results', t => {
  const store = memoryStore(t);
  const at = '2026-01-01T00:00:00.000Z';
  const parcel = { status: 'ok', pnu: 'synthetic-a', addr: null, error: null, checkedAt: at };
  store.savePointParcel('synthetic-complex', { lat: 0, lng: 0 }, parcel);
  store.saveZoneCheck('synthetic-complex', 'synthetic-a', { status: 'ok', zones: [], error: null, checkedAt: at });
  assert.equal(store.pointParcels().get('synthetic-complex').lat, 0);
  store.savePointParcel('synthetic-complex', { lat: 1, lng: 1 }, { ...parcel, pnu: 'synthetic-b' });
  assert.equal(store.zoneChecks().has('synthetic-complex'), false);
  assert.equal(store.pointParcels().get('synthetic-complex').lng, 1);
  store.saveZoneCheck('synthetic-complex', 'synthetic-b', { status: 'ok', zones: [], error: null, checkedAt: at });
  store.savePointParcel('synthetic-complex', { lat: 1, lng: 1 }, { ...parcel, status: 'none', pnu: null });
  assert.equal(store.zoneChecks().has('synthetic-complex'), false);
});
