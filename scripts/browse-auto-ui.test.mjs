import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';

// Run the actual Vue setup with synthetic settings and an in-memory server.
// Do not read a personal database or launch a browser tour.
const file = new URL('../web/src/components/BrowseAuto.vue', import.meta.url);
const { descriptor } = parse(fs.readFileSync(file, 'utf8'));
const script = compileScript(descriptor, { id: 'browse-auto-ui-test' });
const compiled = ts.transpileModule(script.content, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const clone = (value) => JSON.parse(JSON.stringify(value));
const initial = () => ({ enabled: false, areaIds: [], configuredJobs: 0, configError: null,
  schedule: { time: '22:30', day: null }, last: null });
const configured = () => ({ ...initial(), areaIds: [1], configuredJobs: 1 });

function harness(t, data = initial()) {
  const mounted = [], unmounted = [], requests = [];
  const intervals = new Map(), timeouts = new Map();
  let nextTimer = 1, now = 1700000000000, response = clone(data), handler = null;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const window = {
    setInterval: (fn) => { const id = nextTimer++; intervals.set(id, fn); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { const id = nextTimer++; timeouts.set(id, fn); return id; },
    clearTimeout: (id) => timeouts.delete(id),
  };
  const props = vue.reactive({
    areas: [{ id: 1, name: '예시 지역', lat: 35.1, lng: 128.1, radiusM: 700, enabled: true }],
    scopes: { 1: [{ name: '예시구 예시동', dong: '예시동' }] }, scopesReady: true,
  });
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, window, Date: Clock, AbortController, Error,
    fetch: async (path, init) => {
      requests.push({ path, ...init });
      if (handler) return handler(path, init);
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body);
        response = { ...response, ...body, configuredJobs: body.areaIds.length * body.sites.length };
      }
      if (init.method === 'POST') response.last = { id: 'synthetic-request', trigger: 'manual',
        status: 'queued', createdAt: now, updatedAt: now, totalJobs: 1,
        completeJobs: 0, partialJobs: 0, failedJobs: 0 };
      return { ok: true, json: async () => clone(response) };
    },
    require: (id) => {
      if (id === 'vue') return { ...vue, onMounted: (fn) => mounted.push(fn), onBeforeUnmount: (fn) => unmounted.push(fn) };
      throw new Error(`Unexpected import ${id}`);
    },
  }, { filename: 'BrowseAuto.synthetic-test.cjs' });
  const scope = vue.effectScope();
  const app = scope.run(() => exports.default.setup(props, { expose() {} }));
  let disposed = false;
  const unmount = () => { if (disposed) return; disposed = true; unmounted.forEach((fn) => fn()); scope.stop(); };
  t.after(unmount);
  return { app, props, requests, intervals, timeouts, unmount,
    ready: Promise.all(mounted.map((fn) => fn())), now: () => now,
    advance: (ms) => { now += ms; }, setResponse: (value) => { response = clone(value); },
    setHandler: (fn) => { handler = fn; },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('mount only reads settings; polling preserves unsaved scope choices and saving never starts a tour', async (t) => {
  const h = harness(t);
  await h.ready;
  assert.deepEqual(h.requests.map((r) => r.method), ['GET']);
  assert.equal(h.app.state.value.enabled, false);
  assert.equal(h.app.canRun.value, false);
  h.app.openSettings();
  h.app.draftEnabled.value = true;
  h.app.draftAreaIds.value = [1];
  await h.app.refresh();
  assert.equal(h.app.draftEnabled.value, true);
  assert.deepEqual(clone(h.app.draftAreaIds.value), [1]);
  assert.equal(h.app.canRun.value, false, 'unsaved choices cannot be used by run');
  assert.equal(h.app.canSave.value, true);
  await h.app.mutate('save');
  await flush();
  assert.deepEqual(JSON.parse(h.requests.find((r) => r.method === 'PUT').body), { enabled: true, areaIds: [1], sites: ['dabang'] });
  assert.equal(h.requests.some((r) => r.method === 'POST'), false);
  assert.equal(h.app.editing.value, false);
  assert.equal(h.app.dirty.value, false);
  assert.equal(h.app.state.value.enabled, true);
});

test('queued, stale running and paused requests block duplicate starts; partial results permit an explicit retry', async (t) => {
  const h = harness(t, configured());
  await h.ready;
  const run = { id: 'synthetic-request', trigger: 'manual', createdAt: h.now(), updatedAt: h.now(),
    totalJobs: 1, completeJobs: 0, partialJobs: 0, failedJobs: 0 };
  for (const status of ['queued', 'running', 'paused']) {
    h.setResponse({ ...configured(), last: { ...run, status } });
    await h.app.refresh();
    assert.equal(h.app.canRun.value, false, status);
    const before = h.requests.length;
    await h.app.mutate('run');
    assert.equal(h.requests.length, before);
  }
  assert.equal(h.app.lastStatusText.value, '중단됨');
  h.setResponse({ ...configured(), last: { ...run, status: 'running' } });
  h.advance(180000);
  await h.app.refresh();
  assert.equal(h.app.lastStatusText.value, '진행 확인 필요');
  assert.equal(h.app.canRun.value, false);
  h.setResponse({ ...configured(), last: { ...run, status: 'partial', partialJobs: 1 } });
  await h.app.refresh();
  assert.equal(h.app.lastStatusText.value, '일부 확인');
  assert.equal(h.app.canRun.value, true, 'manual run does not require a recurring schedule');
  await h.app.mutate('run');
  await flush();
  assert.equal(h.requests.filter((r) => r.method === 'POST').length, 1);
  assert.equal(h.requests.find((r) => r.method === 'POST').path, '/api/browse/auto/run');
  assert.equal(h.app.state.value.last.status, 'queued');
  assert.equal(h.app.canRun.value, false);
});

test('a slow GET cannot overwrite a newer saved configuration even when the transport ignores abort', async (t) => {
  const h = harness(t);
  await h.ready;
  let finishOldGet;
  h.setHandler((_path, init) => init.method === 'GET'
    ? new Promise((resolve) => { finishOldGet = resolve; })
    : { ok: true, json: async () => ({ ...configured(), enabled: true }) });
  const oldGet = h.app.refresh();
  h.app.openSettings();
  h.app.draftEnabled.value = true;
  h.app.draftAreaIds.value = [1];
  await h.app.mutate('save');
  assert.equal(h.app.state.value.enabled, true);
  finishOldGet({ ok: true, json: async () => initial() });
  await oldGet;
  assert.equal(h.app.state.value.enabled, true);
  assert.deepEqual(clone(h.app.state.value.areaIds), [1]);
  assert.equal(h.app.loadError.value, null);
});

test('unknown scope cannot be enabled but an invalid existing schedule can always be disabled', async (t) => {
  const h = harness(t, { ...configured(), enabled: true, areaIds: [99], configError: '예시 범위 오류' });
  await h.ready;
  h.app.openSettings();
  assert.equal(h.app.selectedKnown.value, false);
  h.app.draftEnabled.value = false;
  assert.equal(h.app.canSave.value, true);
  await h.app.mutate('save');
  await flush();
  assert.equal(h.app.state.value.enabled, false);
  h.app.openSettings();
  h.app.draftEnabled.value = true;
  assert.equal(h.app.canSave.value, false);
  assert.equal(h.app.canRun.value, false);
});

test('unavailable saved selections remain removable so a valid replacement can be enabled', async (t) => {
  const h = harness(t, { ...configured(), areaIds: [1, 2, 99], configError: '예시 범위 오류' });
  h.props.areas.push({ id: 2, name: '꺼진 예시 지역', lat: 35.2, lng: 128.2, radiusM: 700, enabled: false });
  h.props.scopes[2] = [{ name: '예시구 다른동', dong: '다른동' }];
  await h.ready;
  h.app.openSettings();
  h.app.draftEnabled.value = true;
  assert.deepEqual(clone(h.app.availableAreas.value.map((area) => area.id)), [1]);
  assert.deepEqual(clone(h.app.unavailableAreaIds.value), [2, 99], 'disabled and missing selections both have removable rows');
  assert.equal(h.app.canSave.value, false);
  h.app.draftAreaIds.value = h.app.draftAreaIds.value.filter((id) => id !== 2);
  assert.deepEqual(clone(h.app.unavailableAreaIds.value), [99]);
  assert.equal(h.app.canSave.value, false);
  h.app.draftAreaIds.value = h.app.draftAreaIds.value.filter((id) => id !== 99);
  assert.deepEqual(clone(h.app.unavailableAreaIds.value), []);
  assert.equal(h.app.canSave.value, true);
  h.setHandler(() => ({ ok: true, json: async () => ({ ...configured(), enabled: true }) }));
  await h.app.mutate('save');
  await flush();
  assert.deepEqual(JSON.parse(h.requests.find((r) => r.method === 'PUT').body), { enabled: true, areaIds: [1], sites: ['dabang'] });
  assert.equal(h.app.state.value.configError, null);
  assert.equal(h.app.canRun.value, true);
});

test('failed or malformed refresh preserves prior data and blocks execution until a valid response returns', async (t) => {
  const h = harness(t, configured());
  await h.ready;
  h.setResponse({ ...configured(), last: { status: 'complete', completeJobs: -1 } });
  await h.app.refresh();
  assert.equal(h.app.state.value.last, null);
  assert.match(h.app.loadError.value, /마지막으로 확인한 내용/);
  assert.equal(h.app.canRun.value, false);
  h.setResponse(configured());
  await h.app.refresh();
  assert.equal(h.app.loadError.value, null);
  assert.equal(h.app.canRun.value, true);
});

test('unmount clears timers, aborts an outstanding request and ignores its eventual result', async (t) => {
  const h = harness(t, configured());
  await h.ready;
  let finish;
  h.setHandler(() => new Promise((resolve) => { finish = resolve; }));
  const pending = h.app.refresh();
  assert.equal(h.intervals.size, 1);
  assert.equal(h.timeouts.size, 1);
  h.unmount();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.requests.at(-1).signal.aborted, true);
  finish({ ok: true, json: async () => ({ ...configured(), enabled: true }) });
  await pending;
  assert.equal(h.app.state.value.enabled, false);
});

test('legacy Dabang settings remain Dabang-only and viewing settings never adds Zigbang', async (t) => {
  const h = harness(t, { ...configured(), enabled: true });
  await h.ready;
  assert.deepEqual(clone(h.app.state.value.sites), ['dabang']);
  assert.deepEqual(clone(h.app.state.value.zigbangAreaIds), []);
  h.app.openSettings();
  assert.deepEqual(clone(h.app.draftSites.value), ['dabang']);
  assert.equal(h.app.dirty.value, false);
  assert.equal(h.app.canSave.value, false);
  await h.app.refresh();
  assert.deepEqual(clone(h.app.draftSites.value), ['dabang']);
  assert.equal(h.requests.every((request) => request.method === 'GET'), true);
  assert.match(h.app.savedScopeText.value, /다방:.+예시동.+원\/투룸/);
  assert.doesNotMatch(h.app.savedScopeText.value, /직방/);
});

test('selected sites and areas survive polling and save explicitly without starting a tour', async (t) => {
  const data = { ...configured(), sites: ['dabang'], zigbangAreaIds: [1] };
  const h = harness(t, data);
  await h.ready;
  h.app.openSettings();
  h.app.draftSites.value = ['dabang', 'zigbang'];
  h.app.draftEnabled.value = true;
  assert.equal(h.app.canSave.value, true);
  assert.equal(h.app.canRun.value, false);
  await h.app.refresh();
  assert.deepEqual(clone(h.app.draftSites.value), ['dabang', 'zigbang']);
  assert.deepEqual(clone(h.app.state.value.sites), ['dabang']);
  await h.app.mutate('save');
  await flush();
  assert.deepEqual(JSON.parse(h.requests.find((request) => request.method === 'PUT').body), { enabled: true, areaIds: [1], sites: ['dabang', 'zigbang'] });
  assert.equal(h.requests.some((request) => request.method === 'POST'), false);
  assert.equal(h.app.state.value.configuredJobs, 2);
  assert.match(h.app.savedScopeText.value, /다방:.+직방: 역 1km, 원룸, 사이트 필터/);
  assert.equal(h.app.dirty.value, false);
});

test('area eligibility requires all selected sites, while Zigbang-only does not require Dabang scopes', async (t) => {
  const h = harness(t, { ...initial(), sites: ['dabang'], zigbangAreaIds: [1, 2] });
  h.props.areas.push({ id: 2, name: '다른 예시 지역', lat: 35.2, lng: 128.2, radiusM: 900, enabled: true });
  await h.ready;
  h.app.openSettings();
  h.app.draftSites.value = ['dabang', 'zigbang'];
  h.app.draftAreaIds.value = [2];
  h.app.draftEnabled.value = true;
  assert.deepEqual(clone(h.app.availableAreas.value.map((area) => area.id)), [1]);
  assert.deepEqual(clone(h.app.unavailableAreaIds.value), [2]);
  assert.equal(h.app.canSave.value, false);
  h.app.draftSites.value = ['zigbang'];
  h.props.scopesReady = false;
  assert.equal(h.app.availabilityReady.value, true);
  assert.deepEqual(clone(h.app.availableAreas.value.map((area) => area.id)), [1, 2]);
  assert.equal(h.app.canSave.value, true);
  assert.equal(h.app.areaScopeText(2, ['zigbang']), '직방: 역 1km, 원룸, 사이트 필터');
  h.setResponse({ ...initial(), sites: ['dabang'], zigbangAreaIds: [1] });
  await h.app.refresh();
  assert.deepEqual(clone(h.app.draftSites.value), ['zigbang'], 'eligibility refresh does not overwrite unsaved site choices');
  assert.deepEqual(clone(h.app.unavailableAreaIds.value), [2]);
  assert.equal(h.app.canSave.value, false);
  h.app.draftEnabled.value = false;
  assert.equal(h.app.canSave.value, true, 'an unavailable selection may still be switched off');
  h.app.draftSites.value = [];
  assert.equal(h.app.canSave.value, false, 'saving requires an explicit site even while off');
});

test('malformed site and eligibility responses preserve known settings and block execution', async (t) => {
  const h = harness(t, { ...configured(), sites: ['zigbang'], zigbangAreaIds: [1] });
  await h.ready;
  const before = h.app.state.value;
  for (const bad of [{ sites: ['unrelated'] }, { sites: [], enabled: true }, { sites: ['zigbang', 'zigbang'] }, { sites: null }, { zigbangAreaIds: [0] }, { zigbangAreaIds: '1' }]) {
    h.setResponse({ ...configured(), sites: ['zigbang'], zigbangAreaIds: [1], ...bad });
    await h.app.refresh();
    assert.equal(h.app.state.value, before);
    assert.equal(h.app.canRun.value, false);
  }
  h.setResponse({ ...configured(), sites: ['zigbang'], zigbangAreaIds: [1] });
  await h.app.refresh();
  assert.equal(h.app.canRun.value, true);
  assert.deepEqual(clone(h.app.draftSites.value), ['zigbang']);
});

test('a disabled empty-site configuration can reopen settings and recover by selecting a site', async (t) => {
  const h = harness(t, { ...initial(), sites: [], zigbangAreaIds: [1] });
  await h.ready;
  assert.equal(h.app.loadError.value, null);
  assert.deepEqual(clone(h.app.state.value.sites), []);
  assert.equal(h.app.canRun.value, false);
  h.app.openSettings();
  h.app.draftSites.value = ['zigbang'];
  h.app.draftAreaIds.value = [1];
  h.app.draftEnabled.value = true;
  assert.equal(h.app.canSave.value, true);
});

test('saved Naver filters allow district areas while station preferences remain selected for other sites',async t=>{
  const data={...initial(),sites:['zigbang'],areaIds:[1],zigbangAreaIds:[1],naverAreaIds:[2],naverPreset:{areaIds:[2],updatedAt:1700000000000,summary:'월세 77만원 이하',conditions:[]}};
  const h=harness(t,data);h.props.areas.push({id:2,name:'가상구',lat:35.2,lng:128.2,radiusM:1000,enabled:true,purpose:'collection',region:{kind:'gu',code:'99123'}});
  await h.ready;h.app.openSettings();h.app.draftSites.value=['zigbang','naver'];h.app.draftAreaIds.value=[1,2];h.app.draftEnabled.value=true;
  assert.deepEqual(clone(h.app.availableAreas.value.map(area=>area.id)),[1,2]);assert.equal(h.app.canSave.value,true);
  assert.match(h.app.areaScopeText(2,['zigbang','naver']),/네이버: 구나 동 전체/);
  assert.match(h.app.areaScopeText(1,['zigbang','naver']),/직방: 역 1km/);
  assert.deepEqual(clone(h.app.state.value.sites),['zigbang'],'editing must not change existing repeat preferences');
});

test('구 수집 지역이 있으면 예약 사이트에서 다방을 새로 고르지 않게 하고, 이미 저장된 다방은 해제할 수 있게 남긴다', async (t) => {
  const h = harness(t);
  await h.ready;
  assert.deepEqual(clone(h.app.siteOptions.value.map((s) => s.id)), ['dabang', 'naver'], '켜진 수집 지역이 있으면 직방은 서버 자동수집에 맡긴다');
  h.app.draftSites.value = ['zigbang'];
  assert.deepEqual(clone(h.app.siteOptions.value.map((s) => s.id)), ['dabang', 'zigbang', 'naver'], '이미 고른 직방은 해제할 수 있게 남긴다');
  h.app.draftSites.value = ['dabang'];
  h.props.areas = [...h.props.areas, { id: 2, name: '예시 구역', lat: 35.2, lng: 128.2, radiusM: 700, enabled: true, purpose: 'collection',
    region: { kind: 'gu', code: '99123', sido: '예시도', sigungu: '가상구', dong: null, name: '예시도 가상구' } }];
  h.app.draftSites.value = ['naver'];
  assert.deepEqual(clone(h.app.siteOptions.value.map((s) => s.id)), ['naver']);
  h.app.draftSites.value = ['dabang'];
  assert.deepEqual(clone(h.app.siteOptions.value.map((s) => s.id)), ['dabang', 'naver']);
});
