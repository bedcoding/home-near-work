import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';
import * as sharedFilters from '../shared/filters.ts';

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
  const data = { listings: [], market: { fixture: 'market' }, failNotices: false, failMarket: false };
  const calls = { listings: 0, notices: 0, market: 0, zones: 0 };
  const mounted = [];
  const api = {
    state: async () => ({ ...state }),
    listings: async () => { calls.listings += 1; return data.listings; },
    notices: async () => { calls.notices += 1; if (data.failNotices) throw new Error('fixture unavailable'); return { notices: [], sources: {} }; },
    auctionResults: async () => ({ results: [], stats: [], compare: [] }),
    houseTrades: async () => ({ fetchedAt: null }),
    market: async () => { calls.market += 1; if (data.failMarket) throw new Error('fixture unavailable'); return data.market; },
    setAutoCheck: async () => ({}),
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
    window: { clearTimeout() {}, setTimeout() { return 1; }, addEventListener() {}, postMessage() {} },
    document: { addEventListener() {} },
  }, { filename: 'App.synthetic-test.cjs' });
  const app = scope.run(() => exports.default.setup({}, { expose() {} }));
  return { app, state, data, calls, mount: async () => { for (const fn of mounted) await fn(); await settle(); } };
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

test('조회 중 버전 변경은 큰 응답을 반복 요청하지 않고 완료 뒤 반영한다', async (t) => {
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
