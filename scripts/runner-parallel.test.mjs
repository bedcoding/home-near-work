import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as types from '../shared/types.ts';
import * as regions from '../shared/regions.ts';
import * as identity from '../server/identity.ts';
import * as collectionPriceLimits from '../server/collection-price-limits.ts';

const code = ts.transpileModule(fs.readFileSync(new URL('../server/runner.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

/** 가짜 수집기 ids를 돌린다. 수집기마다 ms만큼 걸리고 failId는 오류를 낸다. 동시에 돈 최대 수와 탭 연 수, 조회 요약을 돌려준다. */
async function run(ids, { ms = 20, failId = null, scope = 'home', withNotice = false, selection = {} } = {}) {
  let active = 0, maxActive = 0, opened = 0, closed = 0;
  let supplementalChecks = 0;
  const visitedNotices = [];
  const snapshots = [];
  const area = { id: 1, name: '가상역', lat: 35, lng: 128, radiusM: 1000, enabled: true, purpose: 'collection' };
  const collectors = ids.map((id) => ({ id, label: types.SOURCE_LABEL[id], emptyOk: true, collect: async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    snapshots.push(JSON.parse(JSON.stringify(context.exports.getProgress())));
    await new Promise((resolve) => setTimeout(resolve, ms));
    active--;
    if (id === failId) throw new Error('가짜 오류');
    return [];
  } }));
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const store = {
    enabledAreas: () => [area], createRun: () => 7, aptGus: () => [], allVerdicts: () => [],
    db: { transaction: (fn) => fn }, getListing: () => undefined, allListings: () => [],
    insertListing() {}, hasBaseline: () => true, setBaseline() {}, aptSpot: () => -1, markGone() {},
    tidyListings: () => ({ stale: 0, purged: 0 }), finishRun: (_id, _status, summary) => finish(summary),
    getSetting: () => null, setSetting() {}, addEvent() {},
    saveNotices: () => ({ added: [], baseline: false }), setNoticeStatus() {},
  };
  const root = {
    banner: async () => {}, close: async () => {},
    fork: async () => { opened++; return { banner: async () => {}, closePage: async () => { closed++; } }; },
  };
  const dependencies = {
    './db.js': store, './collectors/index.js': { COLLECTORS: collectors },
    './collectors/notices.js': { NOTICE_COLLECTORS: withNotice ? [{ id: 'lh', label: 'Notice example', collect: async () => {
      visitedNotices.push('lh');
      return [];
    } }] : [] },
    './collection-price-limits.js': collectionPriceLimits,
    './browser.js': { restSeconds: () => 0, BrowserSession: { open: async () => root } },
    './collectors/types.js': { BlockedError: class extends Error {} },
    '../shared/types.js': types, '../shared/regions.js': regions, './identity.js': identity,
    './config.js': { COLLECT_MARGIN_M: 500 }, './geo.js': { distanceM: () => 10000 },
    './collectors/gus.js': { gusFor: () => [], nearNamesFor: () => [] },
    './building-register.js': { registryKey: () => null }, './land-zones.js': { vworldKey: () => null },
    './house-trades.js': { houseTradesDue: () => { supplementalChecks++; return false; } },
    './court-results.js': { courtResultsDue: () => false },
    './kb-stats.js': { kbStatsDue: () => false }, './peak-sources.js': { peakSourcesDue: () => false },
    './region-volume.js': { regionVolumeDue: () => false }, './apt-trades.js': { aptTradesDue: () => false, aptRecentDue: () => false },
    './rent-trades.js': { rentTradesDue: () => false }, './redev-zones-update.js': { zoneUpdateDue: () => false },
    './alerts.js': { buildAlerts: () => [], coveredRows: () => new Set(), alertSettings: () => ({}) },
    './notify.js': { notify() {} },
  };
  const context = { exports: {}, console: { log() {} }, require: (id) => dependencies[id] ?? {} };
  vm.runInNewContext(code, context);
  context.exports.startRun(false, scope ?? undefined, { quiet: true, ...selection });
  const summary = await completed;
  return { summary, maxActive, opened, closed, snapshots, supplementalChecks, visitedNotices };
}

test(`매물 사이트를 ${types.RUN_PARALLEL_SITES}곳씩 동시에 돌고, 사이트마다 탭을 열고 닫는다`, async () => {
  const ids = ['dabang', 'zigbang', 'ziptoss', 'peterpanz', 'gobang'];
  const f = await run(ids);
  assert.equal(f.maxActive, Math.min(types.RUN_PARALLEL_SITES, ids.length));
  assert.equal(f.opened, ids.length);
  assert.equal(f.closed, ids.length);
  // 요약은 끝난 순서가 아니라 사이트 순서대로
  assert.deepEqual(JSON.parse(JSON.stringify(f.summary.sources.map((s) => s.source))), ids);
});

test('도는 중에는 사이트마다 상태가 보이고, 한 곳이 실패해도 나머지는 돈다', async () => {
  const ids = ['dabang', 'zigbang', 'ziptoss', 'peterpanz'];
  const f = await run(ids, { failId: 'zigbang' });
  const first = f.snapshots[0];
  assert.deepEqual(first.sites.map((s) => s.source), ids);
  assert.equal(first.sites[0].status, 'running');
  assert.equal(first.sites[ids.length - 1].status, 'waiting');
  assert.deepEqual(JSON.parse(JSON.stringify(f.summary.sources.map((s) => [s.source, s.status]))), [['dabang', 'ok'], ['zigbang', 'error'], ['ziptoss', 'ok'], ['peterpanz', 'ok']]);
});

test('only selected sites run, and unchecked notices and full-run tasks are skipped', async () => {
  const ids = ['dabang', 'zigbang', 'courtauction'];
  const f = await run(ids, { scope: null, withNotice: true, selection: { selectedSources: ['zigbang'], includeNotices: false } });
  assert.equal(f.opened, 1);
  assert.deepEqual(f.snapshots[0].sites.map(site => site.source), ['zigbang']);
  assert.equal(f.snapshots[0].noticeCount, 0);
  assert.equal(f.summary.selectedSubset, true);
  assert.deepEqual([...f.summary.sources].map(s => s.source), ['zigbang']);
  assert.equal(f.supplementalChecks, 0);
  assert.deepEqual(f.visitedNotices, []);

  const noticesOnly = await run(['dabang'], { scope: null, withNotice: true, selection: { selectedSources: [], includeNotices: true } });
  assert.equal(noticesOnly.opened, 0);
  assert.equal(noticesOnly.supplementalChecks, 0);
  assert.deepEqual(noticesOnly.visitedNotices, ['lh']);
  assert.equal(noticesOnly.summary.selectedSubset, true);
});

test('selection preserves full runs when nothing is unchecked and rejects invalid or empty choices', async () => {
  const ids = ['dabang', 'zigbang'];
  const full = await run(ids, { scope: null, withNotice: true, selection: { selectedSources: ids, includeNotices: true } });
  assert.equal(full.summary.selectedSubset, undefined);
  assert.equal(full.supplementalChecks, 1);
  assert.deepEqual(full.visitedNotices, ['lh']);

  await assert.rejects(run(ids, { selection: { selectedSources: [] } }), /하나 이상/);
  await assert.rejects(run(ids, { selection: { selectedSources: ['dabang', 'dabang'] } }), /사이트/);
  await assert.rejects(run(ids, { selection: { selectedSources: ['courtauction'] } }), /사이트/);
  await assert.rejects(run(ids, { selection: { selectedSources: { id: 'dabang' } } }), /사이트/);
  await assert.rejects(run(ids, { selection: { includeNotices: 'false' } }), /공고/);
});
