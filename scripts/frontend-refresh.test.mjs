import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';
import * as sharedFilters from '../shared/filters.ts';
import { createListingsCache, encodeListings } from '../server/listings-cache.ts';

// 실제 App setup과 폴링을 실행하되 API, 브라우저, 타이머는 모두 메모리 안의 가짜 객체를 쓴다.
// 서버 모듈, 로컬 설정, 데이터베이스와 외부 네트워크는 읽거나 실행하지 않는다.
const appUrl = new URL('../web/src/App.vue', import.meta.url);
const requireFromApp = createRequire(appUrl);
const { descriptor } = parse(fs.readFileSync(appUrl, 'utf8'));
const script = compileScript(descriptor, { id: 'frontend-refresh-test' });
const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

function appHarness(t) {
  storage.clear();
  const state = { dataRevision: 'session-a:1', running: null, naverCapture: { total: 0 }, newNotices: 0, gus: [], areas: [], autoCheck: { visible: true } };
  const data = { listings: [], market: { fixture: 'market' }, failNotices: false, failMarket: false, failVerdict: false, failSeen: false, waitForListings: null };
  const calls = { listings: 0, since: [], deltas: 0, notices: 0, market: 0, zones: 0, verdict: 0, pollInterval: null };
  let now = Date.parse('2026-11-13T09:00:00.000Z');
  const mounted = [];
  // 서버처럼 지난번에 보낸 목록 버전(since)을 알면 바뀐 매물만, 모르면 전체를 보낸다. 매물은 JSON으로 오가 새 객체로 온다.
  let cache = createListingsCache();
  let remembered = null;
  const server = { restart() { cache = createListingsCache(); remembered = null; } };
  const api = {
    state: async () => ({ ...state }),
    listings: async (since = null) => {
      calls.listings += 1;
      calls.since.push(since);
      if (data.waitForListings) await data.waitForListings;
      if (remembered !== data.listings) {
        cache.remember(encodeListings(data.listings));
        remembered = data.listings;
      }
      const delta = since ? cache.since(since) : null;
      if (delta) {
        calls.deltas += 1;
        return JSON.parse(delta.toString());
      }
      return { token: cache.token(), listings: JSON.parse(cache.full().toString()) };
    },
    seen: async () => {
      if (data.failSeen) throw new Error('fixture unavailable');
      const before = state.dataRevision;
      state.dataRevision = `${before}+seen`;
      return { before, after: state.dataRevision };
    },
    notices: async () => { calls.notices += 1; if (data.failNotices) throw new Error('fixture unavailable'); return { notices: [], sources: {} }; },
    auctionResults: async () => ({ results: [], stats: [], compare: [] }),
    houseTrades: async () => ({ fetchedAt: null }),
    market: async () => { calls.market += 1; if (data.failMarket) throw new Error('fixture unavailable'); return data.market; },
    setAutoCheck: async () => ({}),
    // 서버처럼 저장하면 자료 버전이 바뀌고, 바꾸기 전후 버전을 돌려준다.
    setVerdict: async () => {
      calls.verdict += 1;
      if (data.failVerdict) throw new Error('fixture unavailable');
      const before = state.dataRevision;
      state.dataRevision = `${before}+verdict${calls.verdict}`;
      return { ok: true, before, after: state.dataRevision };
    },
  };
  const exports = {};
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => {
      if (id === 'vue') return { ...vue, onMounted: (fn) => mounted.push(fn), onBeforeUnmount: () => {} };
      if (id === './api') return { api };
      // 필터 판정은 실제 공통 함수를 쓰고 브라우저 저장·서버 동기화 경계는 격리한다.
      // 이 테스트의 대상인 자료 갱신이 Vite 환경 변수나 실제 알림 API에 의존하지 않게 한다.
      if (id === './filters') return { ...sharedFilters, loadFilters: () => sharedFilters.normalizeFilters(null), saveFilters() {} };
      if (id === './redevZones') return { reloadZones: async () => { calls.zones += 1; return true; }, zonesNeedReload: () => false };
      if (id.endsWith('.vue')) return { default: {} };
      return requireFromApp(id);
    },
    localStorage: globalThis.localStorage,
    location: { search: '', pathname: '/', origin: 'https://example.invalid' },
    history: { replaceState() {} },
    URLSearchParams,
    window: { clearTimeout() {}, setTimeout(_cb, delay) { calls.pollInterval = delay; return 1; }, addEventListener() {}, postMessage() {} },
    document: { addEventListener() {}, querySelector() { return null; } },
    Date: class extends Date { static now() { return now; } },
  }, { filename: 'App.synthetic-test.cjs' });
  const app = scope.run(() => exports.default.setup({}, { expose() {} }));
  return { app, state, data, calls, server, advance(ms) { now += ms; }, mount: async () => { for (const fn of mounted) await fn(); await settle(); } };
}

test('확장 응답 저장 뒤 지연 파싱이 끝나면 같은 네이버 건수에서도 목록을 갱신한다', async (t) => {
  const h = appHarness(t);
  await h.mount();
  h.state.dataRevision = 'session-a:2'; // 확장 응답 저장, 아직 매물로 파싱하지 않음
  await h.app.poll();
  assert.equal(h.app.listings.value.length, 0);
  h.state.dataRevision = 'session-a:3'; // 다른 사이트의 지연 파싱 저장 완료
  h.data.listings = [{ id: 'synthetic-room' }];
  await h.app.poll();
  assert.equal(h.app.listings.value[0].id, 'synthetic-room');
  assert.deepEqual([...h.app.liveListingIds.value], ['synthetic-room'], '확장 프로그램에서 새로 받아도 지도에서 강조한다');
  assert.equal(h.state.naverCapture.total, 0);
});

test('폴링 사이에 끝난 조회와 서버 재시작을 감지하고 안정된 버전은 다시 읽지 않는다', async (t) => {
  const h = appHarness(t);
  await h.mount();
  const initialCalls = h.calls.listings;
  await h.app.poll();
  assert.equal(h.calls.listings, initialCalls);
  h.state.dataRevision = 'session-a:8';
  h.data.listings = [{ id: 'completed-between-polls' }];
  await h.app.poll();
  assert.equal(h.app.listings.value[0].id, 'completed-between-polls');
  h.state.dataRevision = 'session-b:1';
  h.data.listings = [{ id: 'after-restart' }];
  await h.app.poll();
  assert.equal(h.app.listings.value[0].id, 'after-restart');
});

test('하나의 데이터 읽기가 실패하면 버전을 확인 완료로 처리하지 않고 재시도한다', async (t) => {
  const h = appHarness(t);
  await h.mount();
  h.state.dataRevision = 'session-a:2';
  h.data.failNotices = true;
  await h.app.poll();
  assert.ok(h.app.connectionError.value);
  h.data.failNotices = false;
  const failedCalls = h.calls.notices;
  // 연결 오류 강제 갱신이 없어도 미완료 버전 자체가 재시도되어야 한다.
  h.app.connectionError.value = null;
  await h.app.poll();
  assert.equal(h.calls.notices, failedCalls + 1);
  assert.equal(h.app.connectionError.value, null);
});

test('시세 탭 최초 읽기 실패는 데이터 버전이 그대로여도 자동 복구한다', async (t) => {
  const h = appHarness(t);
  await h.mount();
  h.data.failMarket = true;
  h.app.tab.value = 'market';
  await vue.nextTick();
  await settle();
  assert.equal(h.app.market.value, null);
  assert.ok(h.app.marketLoadError.value);
  h.data.failMarket = false;
  await h.app.poll();
  assert.equal(h.app.market.value.fixture, 'market');
  assert.equal(h.app.marketLoadError.value, null);
});

test('조회 중에는 공통 자료 버전이 바뀌어도 매물 저장 신호가 없으면 완료 뒤 반영한다', async (t) => {
  const h = appHarness(t);
  await h.mount();
  const initialCalls = h.calls.listings;
  h.state.running = { runId: 42 };
  h.state.dataRevision = 'session-a:2';
  await h.app.poll();
  h.state.dataRevision = 'session-a:3';
  await h.app.poll();
  assert.equal(h.calls.listings, initialCalls);
  h.state.running = null;
  await h.app.poll();
  assert.equal(h.calls.listings, initialCalls + 1);
});

test('조회 중 저장된 매물은 진행 상태를 기다리게 하지 않고 4초 간격의 변화분으로 반영한다', async (t) => {
  const h = appHarness(t);
  h.data.listings = [listing('old')];
  await h.mount();
  assert.equal(h.app.liveListingIds.value.size, 0, '페이지를 열 때 이미 저장된 매물은 강조하지 않는다');
  const initialCalls = h.calls.listings;
  const initialNotices = h.calls.notices;
  let releaseListings;
  h.data.waitForListings = new Promise(resolve => { releaseListings = resolve; });
  h.data.listings = [listing('old', { title: '새 제목' }), listing('a')];
  h.state.running = { runId: 42, listingRevision: 1 };
  await h.app.poll();
  assert.equal(h.calls.pollInterval, 1000, '매물 응답이 늦어도 진행 상태는 1초 뒤에 확인한다');
  assert.equal(h.calls.listings, initialCalls + 1);
  assert.ok(h.calls.since.at(-1));
  assert.deepEqual(h.app.listings.value.map(row => row.id), ['old']);
  h.advance(4000);
  await h.app.poll();
  assert.equal(h.calls.listings, initialCalls + 1, '같은 변화분이 아직 오는 중이면 추가 요청을 쌓지 않는다');
  releaseListings();
  h.data.waitForListings = null;
  await settle();
  assert.equal(h.calls.deltas, 1);
  assert.deepEqual(h.app.listings.value.map(row => row.id), ['old', 'a']);
  assert.deepEqual([...h.app.liveListingIds.value], ['a']);

  h.state.dataRevision = 'session-a:2';
  await h.app.poll();
  assert.equal(h.calls.listings, initialCalls + 1, '로그에만 새 기록이 있으면 매물을 요청하지 않는다');
  h.state.running = { runId: 42, listingRevision: 2 };
  h.data.listings = [...h.data.listings, listing('b')];
  await h.app.poll();
  await settle();
  assert.deepEqual(h.app.listings.value.map(row => row.id), ['old', 'a', 'b']);
  assert.deepEqual([...h.app.liveListingIds.value], ['a', 'b'], '다음 수집분이 들어와도 앞에서 받은 매물의 강조를 유지한다');
  h.advance(3999);
  h.state.running = { runId: 42, listingRevision: 3 };
  await h.app.poll();
  assert.equal(h.calls.listings, initialCalls + 2, '다음 저장 신호는 간격이 지날 때까지 합친다');
  assert.equal(h.calls.notices, initialNotices, '조회 중에는 공고와 시세를 함께 받지 않는다');

  h.data.listings = [...h.data.listings, listing('c')];
  h.state.running = null;
  await h.app.poll();
  await settle();
  assert.equal(h.calls.listings, initialCalls + 3, '종료 시에는 대기 중인 변화까지 포함해 다시 받는다');
  assert.equal(h.calls.notices, initialNotices + 1);
  assert.deepEqual([...h.app.liveListingIds.value], ['a', 'b', 'c'], '조회가 끝나도 마지막 저장분까지 새로고침 전에는 강조한다');
  h.advance(30_000);
  await h.app.poll();
  assert.deepEqual([...h.app.liveListingIds.value], ['a', 'b', 'c']);
});

/** 화면 계산에 필요한 칸만 채운 가짜 매물(같은 자리, 같은 층, 같은 면적이면 서로 '비슷'하다) */
const listing = (id, extra = {}) => ({
  id, source: 'naver', status: 'active', verdict: null, verdictReason: null, relistedOf: null, isNew: true, priceChange: null, seenAt: null,
  similarToDiscarded: false, prices: [{ deal: 'monthly', deposit: 1000, monthly: 50, price: null }], lat: 37.5, lng: 127, areaM2: 20, floor: 3,
  basement: false, firstSeenAt: '2026-11-01T00:00:00.000Z', ...extra,
});
const key = (k) => ({ key: k, target: { tagName: 'BODY', isContentEditable: false }, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });

test('관심, 별로, 버림은 화면에서 바로 바꾸고 매물 목록을 다시 받지 않는다(다음 폴링에서도)', async (t) => {
  const h = appHarness(t);
  h.data.listings = [listing('a'), listing('b', { lat: 37.6 })];
  await h.mount();
  const loads = h.calls.listings;
  const b = h.app.listings.value[1];
  await h.app.setVerdict(b, 'discard');
  assert.equal(b.verdict, 'discard');
  assert.equal(b.isNew, false);
  assert.ok(b.seenAt);
  assert.equal(h.calls.verdict, 1);
  assert.equal(h.calls.listings, loads, '버림 직후 목록 전체를 다시 받지 않는다');
  assert.ok(!h.app.current.value.some((l) => l.id === 'b'), '버린 매물은 목록에서 바로 빠진다');
  await h.app.poll();
  assert.equal(h.calls.listings, loads, '버림만 바뀐 버전이면 다음 폴링도 다시 받지 않는다');
  h.state.dataRevision = `${h.state.dataRevision}+other`;
  await h.app.poll();
  assert.equal(h.calls.listings, loads + 1, '다른 변화가 생기면 그때는 다시 받는다');
});

test('버림한 매물과 비슷한 매물에는 바로 배지를 붙이고, 되돌리면 뗀다', async (t) => {
  const h = appHarness(t);
  h.data.listings = [listing('a'), listing('twin', { source: 'dabang', lat: 37.50001 }), listing('far', { lat: 37.6 }), listing('starred', { verdict: 'star' })];
  await h.mount();
  const [a, twin, far, starred] = h.app.listings.value;
  await h.app.setVerdict(a, 'discard');
  assert.equal(twin.similarToDiscarded, true);
  assert.equal(far.similarToDiscarded, false);
  assert.equal(starred.similarToDiscarded, false, '내가 표시한 매물에는 붙이지 않는다');
  assert.equal(a.similarToDiscarded, false);
  await h.app.setVerdict(a, null);
  assert.equal(twin.similarToDiscarded, false);
});

test('저장하지 못하면 관심, 별로, 버림 표시를 되돌리고 알린다', async (t) => {
  const h = appHarness(t);
  h.data.listings = [listing('a', { verdict: 'discard', verdictReason: 'relisted:old', relistedOf: 'old' })];
  await h.mount();
  const a = h.app.listings.value[0];
  h.data.failVerdict = true;
  await h.app.setVerdict(a, null);
  assert.equal(a.verdict, 'discard');
  assert.equal(a.relistedOf, 'old');
  assert.equal(a.isNew, true);
  assert.equal(a.seenAt, null);
  assert.ok(h.app.error.value);
});

test('버림으로 고른 매물이 빠져 다음 매물이 골라지면 지도는 따라가지 않고, 직접 고르면 따라간다', async (t) => {
  const h = appHarness(t);
  await h.mount();
  const [a, b, c] = ['a', 'b', 'c'].map((id) => listing(id));
  h.app.setOverviewVisible([a, b, c]);
  h.app.selectListing(b);
  assert.equal(h.app.selectedId.value, 'b');
  assert.equal(h.app.panToSelected.value, true);
  h.app.setOverviewVisible([a, c]); // 버림으로 b가 목록에서 빠짐
  assert.equal(h.app.selectedId.value, 'c', '같은 순번의 다음 매물이 골라진다');
  assert.equal(h.app.panToSelected.value, false, '지도는 보던 자리에 둔다');
  h.app.onKey(key('k'));
  assert.equal(h.app.selectedId.value, 'a');
  assert.equal(h.app.panToSelected.value, true, '키로 직접 옮기면 지도도 따라간다');
});

test('매물 몇 건이 바뀌면 그 매물만 받아 합치고, 바뀌지 않은 매물은 같은 객체로 둔다', async (t) => {
  const h = appHarness(t);
  h.data.listings = [listing('a'), listing('b', { lat: 37.6 }), listing('c', { lat: 37.7 })];
  await h.mount();
  const before = h.app.listings.value;
  const [a, b, c] = before;
  h.data.listings = [listing('a'), listing('b', { lat: 37.6, prices: [{ deal: 'monthly', deposit: 2000, monthly: 40, price: null }] }), listing('c', { lat: 37.7 }), listing('d', { lat: 37.8 })];
  h.state.dataRevision = 'session-a:2';
  await h.app.poll();
  assert.ok(h.calls.since.at(-1), '지난번 목록 버전을 알려 바뀐 것만 달라고 한다');
  assert.equal(h.calls.deltas, 1);
  const after = h.app.listings.value;
  assert.notEqual(after, before, '바뀐 매물이 있으면 새 배열');
  assert.deepEqual(after.map((l) => l.id), ['a', 'b', 'c', 'd'], '서버 목록 순서를 지킨다');
  assert.equal(after[0], a);
  assert.equal(after[2], c);
  assert.notEqual(after[1], b);
  assert.equal(after[1].prices[0].deposit, 2000);

  h.state.dataRevision = 'session-a:3'; // 매물과 상관없는 쓰기
  await h.app.poll();
  assert.equal(h.calls.deltas, 2);
  assert.equal(h.app.listings.value, after, '바뀐 매물이 없으면 배열도 그대로 둔다(목록 계산과 카드가 다시 돌지 않게)');
});

test('봤음을 저장하지 못하면 다음 새로고침은 전체를 받아 서버 상태로 되돌린다', async (t) => {
  const h = appHarness(t);
  h.data.listings = [listing('a'), listing('b', { lat: 37.6 })];
  await h.mount();
  const a = h.app.listings.value[0];
  h.data.failSeen = true;
  await h.app.saveSeen([a]);
  assert.ok(a.seenAt, '화면에는 먼저 남긴다');
  h.state.dataRevision = 'session-a:2';
  await h.app.poll();
  assert.equal(h.calls.since.at(-1), null, '서버에서는 이 매물이 그대로라 변화분으로는 되돌릴 수 없어 전체를 받는다');
  assert.equal(h.app.listings.value[0].seenAt, null);
  assert.equal(h.app.listings.value[0].isNew, true);
  h.state.dataRevision = 'session-a:3';
  await h.app.poll();
  assert.ok(h.calls.since.at(-1), '그다음부터는 다시 변화분을 받는다');
});

test('서버를 다시 켜 지난 목록 버전을 모르면 전체를 받는다', async (t) => {
  const h = appHarness(t);
  h.data.listings = [listing('a')];
  await h.mount();
  h.server.restart();
  h.data.listings = [listing('a'), listing('b', { lat: 37.6 })];
  h.state.dataRevision = 'session-b:1';
  await h.app.poll();
  assert.ok(h.calls.since.at(-1));
  assert.equal(h.calls.deltas, 0);
  assert.deepEqual(h.app.listings.value.map((l) => l.id), ['a', 'b']);
  h.data.listings = [listing('b', { lat: 37.6 })];
  h.state.dataRevision = 'session-b:2';
  await h.app.poll();
  assert.equal(h.calls.deltas, 1, '새 서버가 준 버전으로 다시 변화분을 받는다');
  assert.deepEqual(h.app.listings.value.map((l) => l.id), ['b']);
});

test('지도는 첫 실패를 재시도하고 캐시와 진행 중인 이전 요청 뒤에도 새 파일을 읽는다', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const zones = await import('../web/src/redevZones.ts');
  let calls = 0;
  let response = { fixture: 'first' };
  let fail = true;
  globalThis.fetch = async () => {
    calls += 1;
    if (fail) throw new Error('fixture unavailable');
    return { ok: true, json: async () => response };
  };
  assert.equal(await zones.reloadZones(), true);
  assert.equal(calls, 0);
  assert.equal(await zones.loadZones(), false);
  assert.equal(zones.zonesNeedReload(), true);
  fail = false;
  assert.equal(await zones.reloadZones(), true);
  assert.equal(zones.zonesNeedReload(), false);
  response = { fixture: 'new-file' };
  await zones.reloadZones();
  assert.equal(zones.zones.value.fixture, 'new-file');

  const pending = [];
  globalThis.fetch = () => new Promise((resolve) => pending.push((body) => resolve({ ok: true, json: async () => body })));
  const oldRead = zones.loadZones(true);
  const freshRead = zones.reloadZones();
  assert.equal(pending.length, 1);
  pending.shift()({ fixture: 'old-in-flight' });
  await oldRead;
  await settle();
  assert.equal(pending.length, 1);
  pending.shift()({ fixture: 'new-after-write' });
  await freshRead;
  assert.equal(zones.zones.value.fixture, 'new-after-write');
});
