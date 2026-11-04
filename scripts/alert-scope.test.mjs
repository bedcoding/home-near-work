import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as scope from '../shared/alert-scope.ts';
import * as filters from '../shared/filters.ts';
import * as types from '../shared/types.ts';
import * as format from '../shared/format.ts';
import { primaryAreas } from '../shared/regions.ts';
import { loadFilters, saveFilters } from '../web/src/filters.ts';

const js = ts.transpileModule(fs.readFileSync(new URL('../server/alerts.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const context = { exports: {}, require: (id) => ({ '../shared/alert-scope.js': scope, '../shared/filters.js': filters, '../shared/types.js': types, '../shared/format.js': format }[id] ?? {}) };
vm.runInNewContext(js, context);
const alerts = context.exports;
const station = (id, limits = null) => ({ id, name: `Synthetic Station ${id}`, purpose: 'alert', lat: 0, lng: 0, radiusM: 800, enabled: true, alertLimits: limits });
const listing = (id = 'one', overrides = {}) => ({ source: 'ziptoss', sourceId: id, title: 'Synthetic home', buildingType: '원룸', lat: 0, lng: 0,
  address: '예시도 다른구 샘플동', dong: '샘플동', prices: [{ deal: 'monthly', deposit: 100, monthly: 30 }], url: 'https://example.invalid/home', ...overrides });
const collection = { id: 10, name: 'Synthetic collection', purpose: 'collection', enabled: true, lat: 2, lng: 2, radiusM: 1000,
  region: { kind: 'gu', code: '99123', sido: '예시도', sigungu: '가상구', dong: null, name: '예시도 가상구' } };
const settings = () => structuredClone(alerts.DEFAULT_ALERTS);

test('collection/list changes cannot gate an opportunity inside an alert circle', () => {
  const config = settings();
  config.homeFilter = { ...filters.DEFAULT_FILTERS, areaIds: [collection.id], insideAreas: true, distanceMax: 1 };
  const home = listing();
  assert.equal(filters.passes(home, filters.DEFAULT_FILTERS, [collection, station(1)]), false);
  assert.equal(alerts.matchesAlert(home, config, [collection, station(1)]), true);
  assert.equal(alerts.matchesAlert(home, config, [{ ...collection, enabled: false }, station(1)]), true);
  assert.equal(alerts.matchesAlert(home, config, [collection, { ...station(1), enabled: false }]), false);
  assert.equal(alerts.matchesAlert(home, config, [collection]), false, 'a gu is not an alert circle');
  assert.equal(primaryAreas([collection, station(1)]).length, 1);
  assert.equal(primaryAreas([station(1)]).length, 0);
});

test('station limits can be stricter or looser than common limits and stay within one circle', () => {
  const config = settings();
  const home = listing('budget', { prices: [{ deal: 'monthly', deposit: 200, monthly: 60 }] });
  assert.equal(alerts.matchesAlert(home, config, [station(1)]), false);
  assert.equal(alerts.matchesAlert(home, config, [station(1, { monthlyMax: 70, depositMax: null, priceMax: null })]), true);
  assert.equal(alerts.matchesAlert(listing(), config, [station(1, { monthlyMax: 20, depositMax: null, priceMax: null })]), false);
  const a = station(1, { monthlyMax: 40, depositMax: 1000, priceMax: null });
  const b = station(2, { monthlyMax: 100, depositMax: 100, priceMax: null });
  assert.equal(alerts.matchesAlert(home, config, [a, b]), false, 'caps from different circles cannot be combined');
  assert.equal(alerts.matchesAlert(listing('unknown', { lat: null }), config, [a]), false);
  assert.equal(alerts.matchesAlert(listing('unknown-price', { prices: [{ deal: 'monthly', deposit: 100, monthly: null }] }), config, [station(1)]), false);
});

test('overlapping circles deduplicate new/down notifications and never announce price increases', () => {
  const config = settings();
  const home = listing();
  const zones = [station(1), station(2)];
  const build = (news) => alerts.buildAlerts({ news, settings: config, areas: zones, sources: [], quiet: true, covered: new Set() });
  const event = (changeType) => ({ type: 'listing', listing: home, changed: true, changeType });
  assert.equal(build([event('price_up')]).length, 0);
  assert.equal(build([event('price_changed')]).length, 0);
  assert.equal(build([event(undefined)]).length, 0);
  assert.equal(build([event('price_down')]).length, 1);
  const result = build([{ type: 'listing', listing: home, changed: false }, { type: 'listing', listing: home, changed: false }]);
  assert.equal(result.length, 1);
  assert.match(result[0].title, /1건/);
  assert.doesNotMatch(result[0].title, /2건/);
  const own = station(1, { monthlyMax: 70, depositMax: null, priceMax: null });
  const custom = alerts.buildAlerts({ news: [{ type: 'listing', listing: { ...home, prices: [{ deal: 'monthly', deposit: 100, monthly: 60 }] }, changed: false }], settings: config, areas: [own], sources: [], quiet: true, covered: new Set() });
  assert.equal(custom.length, 1);
  assert.doesNotMatch(custom[0].title, /50/, 'notification must not claim the common cap when a station overrides it');
});

test('legacy filter budgets migrate once while geographic browsing state is removed', () => {
  const migrated = alerts.normalizeAlerts({ homeFilter: { ...filters.DEFAULT_FILTERS, areaIds: [999], distanceMax: 500, monthlyMax: 42, kinds: ['officetel'] } });
  assert.equal(migrated.scopeVersion, 2);
  assert.equal(migrated.stationAreasOnly, true);
  assert.equal(migrated.monthly.monthlyMax, 42);
  assert.equal(migrated.homeFilter.areaIds.length, 0);
  assert.equal(migrated.homeFilter.distanceMax, null);
  assert.equal(migrated.homeFilter.insideAreas, false);
  assert.equal(migrated.homeFilter.monthlyMax, null);
  const updated = alerts.normalizeAlerts({ monthly: { monthlyMax: 33 } }, migrated);
  assert.equal(alerts.normalizeAlerts(updated).monthly.monthlyMax, 33, 'reloading must not restore the old linked cap');
  assert.equal(alerts.normalizeAlerts({ homeFilter: filters.DEFAULT_FILTERS }).monthly.monthlyMax, alerts.DEFAULT_ALERTS.monthly.monthlyMax, 'an unlimited browsing filter cannot erase a configured alert budget');
  const fullLegacy = { ...settings(), homeFilter: { ...filters.DEFAULT_FILTERS, monthlyMax: 41 } };
  delete fullLegacy.scopeVersion;
  assert.equal(alerts.normalizeAlerts(fullLegacy).monthly.monthlyMax, 41, 'a previously effective finite cap survives migration from a complete saved record');
  assert.throws(() => scope.normalizeAlertLimits({ monthlyMax: -1 }));
  assert.throws(() => scope.normalizeAlertLimits({ monthlyMax: '30' }));
});

test('saving and loading map/list filters cannot write alert settings', () => {
  const storage = new Map();
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  let requests = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { requests++; throw new Error('No network expected'); };
  try {
    saveFilters({ ...filters.DEFAULT_FILTERS, areaIds: [123], monthlyMax: 90 });
    assert.equal(loadFilters().monthlyMax, 90);
    assert.equal(loadFilters().areaIds[0], 123);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = oldFetch; delete globalThis.localStorage; }
});
