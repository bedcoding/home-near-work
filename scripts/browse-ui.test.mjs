import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';

// 실제 Vue setup을 실행하고 메시지와 타이머만 메모리에서 흉내 낸다.
// 개인 설정, 실제 지역, 데이터베이스, 외부 사이트는 읽지 않는다.
const file = new URL('../web/src/components/BrowseQueue.vue', import.meta.url);
const { descriptor } = parse(fs.readFileSync(file, 'utf8'));
const script = compileScript(descriptor, { id: 'browse-ui-test' });
const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const clone = (value) => JSON.parse(JSON.stringify(value));
const area = (id) => ({ id, name: `예시 지역 ${id}`, lat: 35.1 + id * 0.001, lng: 128.1, radiusM: 700, enabled: true });
const job = (status, receipt) => ({ id: 'synthetic-job', areaName: '예시 지역', site: 'dabang', siteName: '다방', url: 'https://www.dabangapp.com/map/onetwo', status, note: '', ...(receipt ? { receipt } : {}) });
const state = (jobs, status = 'done') => ({ id: 'synthetic-run', status, jobs, index: jobs.length, updatedAt: 1 });

function harness(t, extension = { version: '0.8.4', browse: true, sites: ['naver', 'dabang', 'kbland'] }, options = {}) {
  const mounted = [];
  const unmounted = [];
  const messages = [];
  const listeners = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  let nextTimer = 1;
  let now = 1700000000000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const win = {
    // 브라우저의 postMessage처럼 Proxy 등 복제할 수 없는 값을 거절한다.
    postMessage: (data, origin) => messages.push({ data: structuredClone(data), origin }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    setInterval: (fn) => { const id = nextTimer++; intervals.set(id, fn); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { const id = nextTimer++; timeouts.set(id, fn); return id; },
    clearTimeout: (id) => timeouts.delete(id),
  };
  const origin = 'https://example.invalid';
  const props = vue.reactive({ areas: [area(1), area(2)], extension });
  const exports = {};
  let scopeResponse = options.scopeResponse || (() => ({ scopes: {} }));
  const fetches = [];
  vm.runInNewContext(compiled, {
    exports, window: win, location: { origin }, URL, Date: Clock, AbortController,
    fetch: async (url, init) => {
      fetches.push({ url, init });
      const result = await scopeResponse();
      return { ok: true, json: async () => result };
    },
    require: (id) => {
      if (id === 'vue') return { ...vue, onMounted: (fn) => mounted.push(fn), onBeforeUnmount: (fn) => unmounted.push(fn) };
      if (id === '../format') return { radiusText: () => '예시 반경' };
      if (id === './BrowseAuto.vue') return { default: {} };
      if (id === './NaverManual.vue') return { default: {} };
      throw new Error(`Unexpected import ${id}`);
    },
  }, { filename: 'BrowseQueue.synthetic-test.cjs' });
  const scope = vue.effectScope();
  const app = scope.run(() => exports.default.setup(props, { expose() {}, emit() {} }));
  const unmount = () => { unmounted.forEach((fn) => fn()); scope.stop(); };
  t.after(unmount);
  const ready = Promise.all(mounted.map((fn) => fn()));
  const receive = (data, overrides = {}) => listeners.get('message')?.({ source: win, origin, data: { source: 'hnw-extension', type: 'browse-status', ...data }, ...overrides });
  return { app, props, messages, receive, win, intervals, timeouts, listeners, unmount, ready, fetches,
    setScopeResponse: (next) => { scopeResponse = next; },
    advance: (ms) => { now += ms; }, now: () => now, tick: () => intervals.forEach((fn) => fn()) };
}

test('선택 지역과 켜진 매물 사이트만 시작 메시지에 전달한다', async (t) => {
  const h = harness(t);
  await h.ready;
  assert.deepEqual(clone(h.app.selectedAreas.value), [1, 2]);
  assert.deepEqual(clone(h.app.selectedSites.value), ['dabang'], '직접 확인하는 사이트는 순회 기본 선택에서 제외한다');
  assert.equal(h.app.canStart.value, false, '최초 상태 확인 전 중복 시작을 막는다');
  h.receive({ state: null });
  h.app.selectedAreas.value = [2];
  h.app.command('start');
  const command = h.messages.at(-1);
  assert.equal(command.origin, 'https://example.invalid');
  assert.deepEqual(command.data.areas, [{ id: 2, name: '예시 지역 2', lat: 35.102000000000004, lng: 128.1, radiusM: 700 }]);
  assert.deepEqual(command.data.sites, ['dabang']);
  const count = h.messages.length;
  h.app.command('start');
  assert.equal(h.messages.length, count, '응답 대기 중 중복 명령을 보내지 않는다');
});

test('브라우저 메시지 전송이 실패해도 시작하는 중에 갇히지 않고 다시 실행할 수 있다', async (t) => {
  const h = harness(t);
  await h.ready;
  h.receive({ state: null });
  const post = h.win.postMessage;
  h.win.postMessage = () => { throw new Error('synthetic DataCloneError'); };
  assert.doesNotThrow(() => h.app.command('start'));
  assert.equal(h.app.pending.value, null);
  assert.equal(h.app.pendingRequestId.value, null);
  assert.equal(h.timeouts.size, 0);
  assert.match(h.app.error.value, /전달하지 못했습니다/);
  assert.match(h.app.activity.value[0].text, /시작|전송/);
  h.win.postMessage = post;
  h.app.command('start');
  assert.equal(h.messages.at(-1).data.type, 'browse-command');
  assert.equal(h.app.pending.value, 'start');
});

test('다른 창과 origin 메시지 또는 잘못된 receipt를 저장 확인으로 표시하지 않는다', async (t) => {
  const h = harness(t);
  await h.ready;
  const valid = state([job('partial', { responses: 2, listings: 3, newCount: 1, changedCount: 1 })]);
  h.receive({ state: valid }, { source: {} });
  h.receive({ state: valid }, { origin: 'https://unrelated.invalid' });
  h.receive({ state: state([job('partial', { responses: 2, listings: -1, newCount: 0, changedCount: 0 })]) });
  assert.equal(h.app.state.value, null);
  h.receive({ state: valid });
  assert.equal(h.app.totals.value.listings, 3);
  assert.equal(h.app.incomplete.value, 1);
  assert.equal(h.app.stateLabel.value, '순회가 끝났습니다');
  assert.equal(h.app.safeLink('javascript:alert(1)'), null);
  assert.equal(h.app.safeLink('https://unrelated.invalid/'), null);
});

test('중단 상태를 복구하고 이어하기하며 패널 종료 시 폴링과 메시지 수신을 정리한다', async (t) => {
  const h = harness(t);
  await h.ready;
  h.receive({ state: state([job('running')], 'paused') });
  assert.equal(h.app.totals.value.listings, 0);
  assert.equal(h.app.state.value.jobs[0].receipt, undefined);
  h.app.command('resume');
  const sent = h.messages.at(-1).data;
  assert.equal(typeof sent.requestId, 'string');
  assert.deepEqual(sent, { source: 'hnw-dashboard', type: 'browse-command', command: 'resume', requestId: sent.requestId });
  assert.equal(h.intervals.size, 1);
  assert.equal(h.timeouts.size, 1);
  h.unmount();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.listeners.size, 0);
});

test('꺼진 지역과 사이트는 선택에서 빠지고 구버전 확장은 실행하지 않는다', async (t) => {
  const h = harness(t);
  await h.ready;
  h.props.areas = [area(2)];
  h.props.extension.sites = ['dabang'];
  await vue.nextTick();
  assert.deepEqual(clone(h.app.selectedAreas.value), [2]);
  assert.deepEqual(clone(h.app.selectedSites.value), ['dabang']);
  h.receive({ state: null });
  h.props.extension.browse = false;
  await vue.nextTick();
  const before = h.messages.length;
  h.app.command('start');
  assert.equal(h.messages.length, before);
  assert.equal(h.app.ready.value, false);
});

test('응답이 끊기면 시작을 잠그고 연결 재확인 후 선택을 유지한 채 다시 활성화한다', async (t) => {
  const h = harness(t);
  await h.ready;
  h.receive({ state: null });
  h.app.selectedAreas.value = [2];
  h.app.selectedSites.value = ['dabang'];
  assert.equal(h.app.canStart.value, true);
  h.receive({ error: 'synthetic disconnected worker' });
  assert.equal(h.app.received.value, false);
  assert.equal(h.app.canStart.value, false);
  h.app.reconnect();
  assert.equal(h.app.error.value, null);
  assert.ok(h.messages.some((m) => m.data.type === 'ping'));
  assert.equal(h.app.canStart.value, false, '재확인 버튼만으로 실행을 허용하지 않는다');
  h.receive({ state: null });
  assert.equal(h.app.canStart.value, true);
  assert.deepEqual(clone(h.app.selectedAreas.value), [2]);
  assert.deepEqual(clone(h.app.selectedSites.value), ['dabang']);
});

test('시작 요청 직후 진행 안내와 로그를 보이고 응답 대기 중에도 상태를 계속 조회한다', async (t) => {
  const h = harness(t);
  await h.ready;
  h.receive({ state: null });
  h.app.command('start');
  const command = h.messages.at(-1).data;
  assert.equal(h.app.progressTitle.value, '시작 요청을 보냈습니다');
  assert.match(h.app.progressDetail.value, /아직 페이지 탐색이 시작됐다는 확인은 없습니다/);
  assert.match(h.app.activity.value[0].text, /시작 요청을 보냈습니다/);
  h.advance(4000);
  h.tick();
  const poll = h.messages.at(-1).data;
  assert.equal(poll.type, 'browse-status');
  assert.notEqual(poll.requestId, command.requestId);
  assert.equal(h.app.elapsed.value, '4초');
  h.receive({ state: null, requestType: 'browse-status', requestId: poll.requestId });
  assert.equal(h.app.pending.value, 'start', '상태 조회 응답은 명령 확인을 대신하지 않는다');
  assert.equal(h.timeouts.size, 1);
  h.receive({ state: null, requestType: 'browse-command', requestId: 'unrelated-command' });
  assert.equal(h.app.pending.value, 'start');
  h.receive({ state: null, requestType: 'browse-command', requestId: command.requestId });
  assert.equal(h.app.pending.value, null);
  assert.equal(h.timeouts.size, 0);
});

test('명령 대기 중 작업 상태 푸시는 단계와 카운터를 갱신하되 대기를 해제하지 않는다', async (t) => {
  const h = harness(t);
  await h.ready;
  h.receive({ state: null });
  h.app.command('start');
  const stamp = h.now();
  h.tick();
  const oldPoll = h.messages.at(-1).data;
  const next = { ...state([{ ...job('running'), actions: 3, received: 2, startedAt: stamp, receipt: { responses: 1, listings: 5, newCount: 2, changedCount: 0 } }], 'running'),
    index: 0, updatedAt: stamp, createdAt: stamp, heartbeatAt: stamp, phase: 'saving', detail: '받은 데이터를 저장하는 중입니다.',
    logs: [{ at: stamp, code: 'saved', jobIndex: 0, site: 'dabang', responses: 1, listings: 5 }] };
  h.receive({ state: next });
  assert.equal(h.app.pending.value, 'start');
  assert.equal(h.app.progressTitle.value, '받은 데이터를 서버에 저장하고 있습니다');
  assert.equal(h.app.progressDetail.value, next.detail);
  assert.equal(h.app.capturedCount.value, 2);
  assert.equal(h.app.actionCount.value, 3);
  assert.equal(h.app.totals.value.listings, 5);
  assert.ok(h.app.activity.value.some((e) => /서버 저장 확인, 응답 1건, 매물 저장 처리 5건/.test(e.text)));
  h.receive({ state: null, requestType: 'browse-status', requestId: oldPoll.requestId });
  assert.equal(h.app.state.value.phase, 'saving', '이전 조회의 지연 응답이 새 작업 상태를 지우지 않는다');
  h.receive({ state: { ...next, updatedAt: stamp - 1, phase: 'opening' } });
  assert.equal(h.app.state.value.phase, 'saving', '뒤늦게 도착한 과거 상태로 진행 단계를 되돌리지 않는다');
});

test('오래된 상태와 멈춘 작업 신호는 진행 중이라고 단정하지 않고 재시작을 막는다', async (t) => {
  const h = harness(t);
  await h.ready;
  h.receive({ state: null });
  assert.equal(h.app.canStart.value, true);
  h.advance(14000);
  h.tick();
  assert.equal(h.app.connectionStale.value, true);
  assert.equal(h.app.canStart.value, false);
  assert.equal(h.app.progressTitle.value, '현재 진행 상태를 확인할 수 없습니다');
  assert.match(h.app.lastReplyText.value, /14초 전, 연결 확인 필요/);
  const staleWorker = { ...state([job('running')], 'running'), updatedAt: h.now(), heartbeatAt: h.now() - 21000, phase: 'exploring' };
  h.receive({ state: staleWorker });
  assert.equal(h.app.connectionStale.value, false);
  assert.equal(h.app.workerStale.value, true);
  assert.equal(h.app.progressTitle.value, '작업 진행 신호가 늦습니다');
});

test('타임아웃과 관련 없는 오류가 시작 성공으로 바뀌지 않고 명령 오류는 유지된다', async (t) => {
  const h = harness(t);
  await h.ready;
  h.receive({ state: null });
  h.app.command('start');
  h.receive({ error: '다른 명령 오류', requestType: 'browse-command', requestId: 'unrelated' });
  assert.equal(h.app.pending.value, 'start');
  assert.equal(h.app.error.value, null);
  const timeout = [...h.timeouts.values()][0];
  h.advance(12000);
  timeout();
  assert.equal(h.app.pending.value, null);
  assert.match(h.app.error.value, /실행 확인을 받지 못했습니다/);
  h.receive({ state: null, requestType: 'browse-status' });
  assert.match(h.app.error.value, /실행 확인을 받지 못했습니다/, '단순 상태 응답이 명령 타임아웃을 숨기지 않는다');
  assert.notEqual(h.app.progressTitle.value, '지역을 차례로 확인하고 있습니다');
});

test('잘못된 로그와 진행 필드는 거부하고 기존 상태는 호환하며 표시 로그 수를 제한한다', async (t) => {
  const h = harness(t);
  await h.ready;
  const base = state([job('partial')]);
  for (const bad of [
    { logs: [{ at: 1, code: 'unexpected', site: 'dabang' }] },
    { logs: [{ at: 1, code: 'saved', listings: -1 }] },
    { logs: [{ at: 1, code: 'received', site: 'unknown' }] },
    { logs: Array.from({ length: 101 }, () => ({ at: 1, code: 'saved' })) },
    { heartbeatAt: -1 }, { phase: 'invented' }, { detail: 3 },
  ]) {
    h.receive({ state: { ...base, ...bad } });
    assert.equal(h.app.state.value, null);
  }
  h.receive({ state: base });
  assert.equal(h.app.stateLabel.value, '순회가 끝났습니다', '이전 확장의 선택 필드 없는 상태도 표시한다');
  h.receive({ state: { ...base, logs: Array.from({ length: 100 }, (_, i) => ({ at: i, code: 'action', actions: i })) } });
  h.app.localEvent('테스트 요청을 보냈습니다.');
  assert.equal(h.app.activity.value.length, 100);
  assert.equal(h.app.activity.value[0].text, '테스트 요청을 보냈습니다.');
});

const region = (id = 70001) => ({ kind: 'dabang-region', name: '예시시 예시구 가상동', dong: '가상동', url: `https://www.dabangapp.com/map/onetwo?search_type=region&search_id=${id}` });

test('예정 항목은 선택 지역 수가 아니라 사이트와 중복 없는 동별 작업 수로 계산한다', async (t) => {
  const first = region();
  const second = { ...region(70002), name: '예시시 예시구 상상동', dong: '상상동' };
  const h = harness(t, undefined, { scopeResponse: () => ({ scopes: { 1: [first, second, { ...first, url: `${first.url}&m_zoom=14` }] } }) });
  await h.ready;
  h.app.selectedAreas.value = [1];
  h.app.selectedSites.value = ['dabang'];
  assert.equal(h.app.plannedJobs.value.length, 2, '같은 동 ID의 다른 지도 URL은 한 번만 조회한다');
  h.app.selectedSites.value = ['naver', 'dabang'];
  assert.equal(h.app.plannedJobs.value.length, 2, '직접 확인하는 사이트는 예전 선택값이 남아도 순회하지 않는다');
  h.app.selectedAreas.value = [1, 2];
  assert.equal(h.app.plannedJobs.value.length, 3, '동 설정이 없는 지역은 지원하는 사이트마다 하나의 작업이다');
  h.app.selectedSites.value = ['naver'];
  assert.equal(h.app.plannedJobs.value.length, 0, '수동 사이트만 선택한 값으로는 순회를 만들지 않는다');
  h.app.selectedAreas.value = [];
  assert.equal(h.app.plannedJobs.value.length, 0);
});

test('복구한 이전 결과는 접고 현재 실행과 중단 상태는 펼치며 완료 폴링은 사용자의 접기를 유지한다', async (t) => {
  const h = harness(t);
  await h.ready;
  assert.equal(h.app.runExpanded.value, false);
  h.receive({ state: state([job('partial')]) });
  await vue.nextTick();
  assert.equal(h.app.runExpanded.value, false, '복구한 완료 기록이 현재 선택보다 먼저 펼쳐지지 않는다');
  const live = { ...state([job('running')], 'running'), id: 'new-synthetic-run', updatedAt: 2 };
  h.receive({ state: live });
  await vue.nextTick();
  assert.equal(h.app.runExpanded.value, true);
  const done = { ...live, status: 'done', jobs: [job('partial')], updatedAt: 3 };
  h.receive({ state: done });
  await vue.nextTick();
  assert.equal(h.app.runExpanded.value, true, '방금 끝난 작업의 일부 확인 결과를 계속 보여 준다');
  h.app.runExpanded.value = false;
  h.receive({ state: { ...done, updatedAt: 4 } });
  await vue.nextTick();
  assert.equal(h.app.runExpanded.value, false, '같은 완료 기록의 상태 응답이 접힌 기록을 다시 펼치지 않는다');
  h.app.runExpanded.value = true;
  h.receive({ state: { ...done, id: 'other-synthetic-run', updatedAt: 5 } });
  await vue.nextTick();
  assert.equal(h.app.runExpanded.value, false, '다른 완료 기록으로 바뀌면 이전 펼침 상태를 이어받지 않는다');
  h.receive({ state: { ...live, status: 'paused', updatedAt: 6 } });
  await vue.nextTick();
  assert.equal(h.app.runExpanded.value, true, '복구한 중단 작업은 이어하기를 찾을 수 있게 펼친다');
});

test('이전 미확인 재조회에는 현재 선택을 섞지 않고 새 조회만 새 동 범위를 전달한다', async (t) => {
  const h = harness(t, undefined, { scopeResponse: () => ({ scopes: { 1: [region(), region(70002)] } }) });
  await h.ready;
  const previous = state([{ ...job('partial'), areaName: '이전 예시 지역' }]);
  h.receive({ state: previous });
  await vue.nextTick();
  h.app.selectedAreas.value = [1];
  h.app.selectedSites.value = ['dabang'];
  assert.equal(h.app.plannedJobs.value.length, 2);
  h.app.command('retry');
  await vue.nextTick();
  const retry = h.messages.at(-1).data;
  assert.deepEqual(retry, { source: 'hnw-dashboard', type: 'browse-command', command: 'retry', requestId: retry.requestId }, '재시도는 확장에 저장된 이전 작업을 사용한다');
  assert.equal(h.app.activeState.value.id, previous.id);
  assert.equal(h.app.runExpanded.value, true, '재시도 응답 대기 상태도 기록 안에서 확인할 수 있다');
  h.receive({ requestId: retry.requestId, requestType: 'browse-command', state: { ...previous, updatedAt: 2 } });
  await vue.nextTick();
  h.app.command('start');
  await vue.nextTick();
  const start = h.messages.at(-1).data;
  assert.equal(start.command, 'start');
  assert.deepEqual(start.areas.map((a) => a.id), [1]);
  assert.deepEqual(start.areas[0].dabangRegions, [region(), region(70002)]);
  assert.deepEqual(start.sites, ['dabang']);
  assert.equal(h.app.activeState.value, null, '새 실행을 기다리는 동안 이전 결과를 새 실행의 결과로 표시하지 않는다');
  assert.equal(h.app.runExpanded.value, true);
});

test('동별 범위를 무시하는 구버전 확장에서는 시작하지 않는다', async (t) => {
  const h = harness(t, { version: '0.8.3', browse: true, sites: ['dabang'] }, { scopeResponse: () => ({ scopes: { 1: [region()] } }) });
  await h.ready; h.receive({ state: null });
  assert.equal(h.app.canStart.value, false);
  h.app.command('start');
  assert.equal(h.messages.filter((x) => x.data.type === 'browse-command').length, 0);
  h.props.extension.version = '0.8.4';
  assert.equal(h.app.canStart.value, true);
});

test('저장된 동 범위를 확인한 뒤 선택한 지역에만 복제 가능한 동 설정을 전달한다', async (t) => {
  let resolveScopes;
  const h = harness(t, undefined, { scopeResponse: () => new Promise((resolve) => { resolveScopes = resolve; }) });
  h.receive({ state: null });
  assert.equal(h.app.canStart.value, false, '범위 조회 전에는 역 반경으로 잘못 시작하지 않는다');
  resolveScopes({ scopes: { 1: [region(), { ...region(70002), name: '예시시 예시구 상상동', dong: '상상동' }] } });
  await h.ready;
  assert.equal(h.app.canStart.value, true);
  h.app.selectedSites.value = ['dabang'];
  h.app.command('start');
  const sent = h.messages.at(-1).data;
  assert.equal(sent.type, 'browse-command');
  assert.deepEqual(sent.areas[0].dabangRegions, [region(), { ...region(70002), name: '예시시 예시구 상상동', dong: '상상동' }]);
  assert.equal(sent.areas[1].dabangRegions, undefined, '설정 없는 지역은 기존 동작을 유지한다');
  assert.doesNotThrow(() => structuredClone(sent), 'Vue Proxy가 중첩된 동 목록에 남지 않는다');
  assert.equal(h.fetches[0].url, '/api/browse/scopes');
  assert.equal(h.fetches[0].init.cache, 'no-store');
});

test('동 범위 조회 실패와 잘못된 범위는 반경 조회로 우회하지 않고 재조회 성공 후 풀린다', async (t) => {
  const h = harness(t, undefined, { scopeResponse: () => { throw new Error('offline'); } });
  await h.ready;
  h.receive({ state: null });
  assert.equal(h.app.canStart.value, false);
  assert.match(h.app.scopeError.value, /동별 조회 범위를 불러오지 못했습니다/);
  h.app.command('start');
  assert.equal(h.messages.some((message) => message.data.type === 'browse-command'), false);
  for (const scopes of [{ 1: [region(), { ...region(), url: 'https://unrelated.invalid/' }] }, { 1: [] }, []]) {
    h.setScopeResponse(() => ({ scopes }));
    await h.app.loadScopes();
    assert.equal(h.app.canStart.value, false);
  }
  h.setScopeResponse(() => ({ scopes: { 1: [region()] } }));
  await h.app.loadScopes();
  assert.equal(h.app.scopeError.value, null);
  assert.equal(h.app.canStart.value, true);
  assert.equal(h.timeouts.size, 0, '범위 조회 제한 타이머를 정리한다');
});

test('서버가 확인한 페이지와 동 제외 건수를 표시하고 일부 확인과 완료를 구분한다', async (t) => {
  const h = harness(t);
  await h.ready;
  const coverage = { pages: 3, totalPages: 3, total: 51, regularUnique: 51, complete: true, reason: 'verified' };
  const receipt = { responses: 3, listings: 57, newCount: 5, changedCount: 1, uniqueListings: 51, excludedOutside: 4, excludedUnknown: 2, coverage };
  const complete = { ...job('complete', receipt), scope: region() };
  h.receive({ state: state([complete, { ...job('partial'), id: 'incomplete-job' }]) });
  assert.equal(h.app.finished.value, 2);
  assert.equal(h.app.incomplete.value, 1);
  assert.equal(h.app.STATUS.complete, '선택 목록 저장 완료');
  assert.equal(h.app.coverageText(h.app.state.value.jobs[0].receipt.coverage), '페이지 3/3 · 중복 없는 일반 매물 51/51건');
  assert.equal(h.app.coverageReason(coverage), '');
  assert.equal(h.app.coverageReason({ ...coverage, complete: false, reason: 'unverified-region' }), '동별 검색 범위 확인 필요');
  const previous = h.app.state.value;
  for (const changedReceipt of [{ ...receipt, uniqueListings: -1 }, { ...receipt, coverage: { ...coverage, pages: '3' } }, { ...receipt, coverage: null }]) {
    h.receive({ state: state([{ ...complete, receipt: changedReceipt }]) });
    assert.equal(h.app.state.value, previous, '잘못된 저장 결과는 완료 표시를 덮어쓰지 않는다');
  }
});

const zigbangJob = (status, coverage) => ({
  ...job(status, { responses: 4, listings: 8, newCount: 1, changedCount: 0, ...(coverage ? { zigbangCoverage: coverage } : {}) }),
  site: 'zigbang', siteName: '직방', url: 'https://www.zigbang.com/home/oneroom/subways/990001/items',
});
const zigbangCoverage = () => ({ stationId: '990001', radiusKm: 1, total: 8, received: 8, stored: 6, excluded: 2, missing: 0, unreadable: 0, complete: true, reason: 'complete' });

test('직방 완료는 같은 역의 전체 상세와 저장 증거가 있어야 표시하며 구기록은 범위 확인 필요로 남긴다', async (t) => {
  const h = harness(t);
  await h.ready;
  const complete = zigbangJob('complete', zigbangCoverage());
  h.receive({ state: state([complete]) });
  assert.equal(h.app.statusLabel(h.app.state.value.jobs[0]), '역 1km 목록 확인 완료');
  assert.equal(h.app.zigbangCoverageText(complete.receipt.zigbangCoverage), '상세 수신 8/8건 · 저장 6건 · 범위 밖 제외 2건');
  assert.equal(h.app.zigbangMissingText(complete.receipt.zigbangCoverage), '상세 미수신 0건 · 읽기 실패 0건');
  for (const old of [zigbangJob('complete'), { ...complete, url: 'https://www.zigbang.com/home/oneroom/subways/990002/items' }, { ...complete, url: 'https://www.zigbang.com/' }]) {
    h.receive({ state: state([old]) });
    assert.equal(h.app.statusLabel(h.app.state.value.jobs[0]), '이전 조회 결과 · 범위 확인 필요');
  }
  assert.equal(h.app.statusLabel(job('complete')), '선택 목록 저장 완료', '다방의 완료 문구는 유지한다');
});

test('직방 누락과 읽기 실패를 구분하고 불완전한 완료 증거는 상태를 덮어쓰지 않는다', async (t) => {
  const h = harness(t);
  await h.ready;
  const partial = { ...zigbangCoverage(), received: 5, stored: 3, excluded: 1, missing: 3, unreadable: 1, complete: false, reason: 'missing-details' };
  h.receive({ state: state([zigbangJob('partial', partial)]) });
  assert.equal(h.app.incomplete.value, 1);
  assert.equal(h.app.zigbangMissingText(partial), '상세 미수신 3건 · 읽기 실패 1건');
  assert.match(h.app.zigbangCoverageReason(partial), /받지 못한/);
  assert.match(h.app.zigbangCoverageReason({ ...partial, reason: 'unverified-storage' }), /서버 저장 확인/);
  assert.match(h.app.zigbangCoverageReason({ ...partial, reason: 'query-changed' }), /검색 조건/);
  const previous = h.app.state.value;
  for (const changed of [null, { ...partial, complete: true }, { ...zigbangCoverage(), stored: 7 }, { ...zigbangCoverage(), missing: 1 }, { ...zigbangCoverage(), radiusKm: 2 }, { ...zigbangCoverage(), received: -1 }]) {
    const incoming = zigbangJob('complete');
    incoming.receipt.zigbangCoverage = changed;
    h.receive({ state: state([incoming]) });
    assert.equal(h.app.state.value, previous);
  }
  const empty = { ...zigbangCoverage(), total: 0, received: 0, stored: 0, excluded: 0 };
  h.receive({ state: state([zigbangJob('complete', empty)]) });
  assert.equal(h.app.statusLabel(h.app.state.value.jobs[0]), '역 1km 목록 확인 완료');
});

test('예전 확장에서는 네이버를 고를 수 없고 시작 명령에도 넣지 않는다', async (t) => {
  const h = harness(t);
  await h.ready;
  assert.equal(h.app.naverEnabled.value, true);
  assert.equal(h.app.naverVersionReady.value, false);
  assert.equal(h.app.sites.value.some((s) => s.id === 'naver'), false);
  h.receive({ state: null });
  h.app.command('start');
  assert.deepEqual(h.messages.at(-1).data.sites, ['dabang']);
  const off = harness(t, { version: '0.8.4', browse: true, sites: ['dabang'] });
  await off.ready;
  assert.equal(off.app.naverEnabled.value, false, '확장에서 꺼 둔 네이버는 안내도 숨긴다');
});

test('네이버 수집의 페이지와 수신 건수를 같은 진행 표시에 보인다', async (t) => {
  const h = harness(t);
  await h.ready;
  const naver = { id: 'synthetic-naver', areaName: '예시구', site: 'naver', siteName: '네이버', url: 'https://fin.land.naver.com/map', status: 'running', note: '현재 필터를 유지한 목록 조회 대기 중',
    naverScope: { kind: 'naver-region', code: '9900000000', name: '예시구' },
    receipt: { responses: 2, listings: 40, newCount: 3, changedCount: 1, naverCoverage: { pages: 2, received: 40, total: 80, stored: 40, complete: false } } };
  h.receive({ state: { ...state([naver], 'running'), index: 0, logs: [{ at: 1, code: 'received', jobIndex: 0, site: 'naver', responses: 2 }] } });
  assert.equal(h.app.current.value?.site, 'naver');
  assert.equal(h.app.totals.value.listings, 40);
  assert.equal(h.app.naverCoverageText(h.app.naverCoverageFor(h.app.current.value)), '2페이지, 목록 수신 40/80건, 저장 40건');
  assert.equal(h.app.naverCoverageFor({ ...naver, receipt: { ...naver.receipt, naverCoverage: { pages: -1, received: 40, total: 80, stored: 40, complete: false } } }), null);
  assert.match(h.app.activity.value[0].text, /네이버/);
});

const NAVER_EXT = { version: '0.8.22', browse: true, sites: ['naver', 'dabang', 'zigbang'] };
const regionArea = (id, kind = 'gu') => ({ ...area(id), name: `예시 구역 ${id}`, purpose: 'collection',
  region: { kind, code: `9912${id}`, sido: '예시도', sigungu: '가상구', dong: kind === 'gu' ? null : '가상동', name: `예시도 가상구 ${id}` } });
const naverReply = (h, data) => h.receive({ type: 'naver-filter', ...data });
async function readNaver(h, tabs = [{ id: 99, title: 'Synthetic map', active: false }], context = { key: 'synthetic-key', tabId: 99, conditions: [{ label: '월세', value: '77만원 이하' }] }) {
  await vue.nextTick();
  const list = h.messages.at(-1).data;
  assert.equal(list.type, 'naver-filter-tabs');
  naverReply(h, { requestId: list.requestId, requestType: 'naver-filter-tabs', tabs });
  const read = h.messages.at(-1).data;
  assert.deepEqual([read.type, read.tabId], ['naver-filter-state', context.tabId]);
  naverReply(h, { requestId: read.requestId, requestType: 'naver-filter-state', context });
}

test('네이버를 고르면 열린 탭의 필터를 읽은 뒤 구 지역과 역 지역을 한 번에 시작한다', async (t) => {
  const h = harness(t, { ...NAVER_EXT, sites: [...NAVER_EXT.sites, 'kbland'] });
  h.props.areas = [area(1), regionArea(3)];
  h.app.selectedAreas.value = h.props.areas.map((a) => a.id);
  await h.ready;
  await vue.nextTick();
  h.receive({ state: null });
  assert.deepEqual(clone(h.app.selectedSites.value), [], '네이버는 처음에 고르지 않고, 다방과 직방은 서버 자동수집에 맡긴다');
  h.app.selectedSites.value = ['kbland'];
  await vue.nextTick();
  assert.deepEqual(clone(h.app.skippedAreas.value.map((a) => a.id)), [3]);
  assert.match(h.app.skipNote.value, /네이버를 고르면/);
  h.app.selectedSites.value = ['naver', 'kbland'];
  await vue.nextTick();
  assert.equal(h.app.canStart.value, false, '필터를 읽기 전에는 시작하지 않는다');
  await readNaver(h);
  assert.equal(h.app.canStart.value, true);
  assert.deepEqual(clone(h.app.plannedJobs.value.map((j) => [j.areaId, j.site, j.label])), [[1, 'kbland', '지도와 필터 범위'], [3, 'naver', '구 전체']]);
  assert.equal(h.app.skipNote.value, '');
  h.app.command('start');
  const start = h.messages.at(-1).data;
  assert.equal(start.type, 'browse-command');
  assert.deepEqual(start.sites, ['naver', 'kbland']);
  assert.deepEqual(start.areas, [
    { id: 1, name: '예시 지역 1', lat: 35.101, lng: 128.1, radiusM: 700 },
    { id: 3, name: '예시 구역 3', lat: 35.103, lng: 128.1, radiusM: 700, region: { kind: 'gu', code: '99123', name: '예시도 가상구 3' } },
  ]);
  assert.equal(start.naverSourceTabId, 99);
  assert.equal(start.naverFilterKey, 'synthetic-key');
});

test('네이버만 고르면 역 지역은 빠지는 지역으로 알리고, 구나 동이 없으면 필터 없이 다른 사이트를 시작한다', async (t) => {
  const h = harness(t, NAVER_EXT);
  h.props.areas = [area(1), regionArea(3, 'dong')];
  h.app.selectedAreas.value = h.props.areas.map((a) => a.id);
  await h.ready;
  h.receive({ state: null });
  h.app.selectedSites.value = ['naver'];
  await readNaver(h, [{ id: 99, title: 'Synthetic map', active: true }]);
  assert.deepEqual(clone(h.app.skippedAreas.value.map((a) => a.id)), [1]);
  assert.match(h.app.skipNote.value, /역 지역은 네이버가 아닌 사이트/);
  assert.equal(h.app.plannedJobs.value[0].label, '동 전체');
  h.app.command('start');
  assert.deepEqual(h.messages.at(-1).data.sites, ['naver']);
  assert.deepEqual(h.messages.at(-1).data.areas.map((a) => a.id), [3]);

  const stationOnly = harness(t, NAVER_EXT);
  await stationOnly.ready;
  stationOnly.receive({ state: null });
  stationOnly.app.selectedSites.value = ['naver', 'dabang'];
  await vue.nextTick();
  assert.equal(stationOnly.app.naverJobs.value.length, 0);
  assert.equal(stationOnly.app.canStart.value, true, '네이버 작업이 없으면 필터를 기다리지 않는다');
  stationOnly.app.command('start');
  const sent = stationOnly.messages.at(-1).data;
  assert.deepEqual(sent.sites, ['dabang']);
  assert.equal(Object.hasOwn(sent, 'naverSourceTabId'), false);
});

test('네이버 응답은 마지막 요청만 받고, 닫힌 탭을 다른 탭으로 바꾸지 않으며, 답이 없으면 안내한다', async (t) => {
  const h = harness(t, NAVER_EXT);
  h.props.areas = [regionArea(3)];
  h.app.selectedAreas.value = h.props.areas.map((a) => a.id);
  await h.ready;
  h.receive({ state: null });
  h.app.selectedSites.value = ['naver'];
  await vue.nextTick();
  const list = h.messages.at(-1).data;
  naverReply(h, { requestId: 'unrelated', requestType: 'naver-filter-tabs', tabs: [{ id: 5, title: 'Other', active: true }] });
  assert.deepEqual(clone(h.app.naverTabs.value), [], '다른 요청의 응답은 무시한다');
  naverReply(h, { requestId: list.requestId, requestType: 'naver-filter-tabs', tabs: [{ id: 98, title: 'A', active: false }, { id: 99, title: 'B', active: false }] });
  assert.equal(h.app.naverTabId.value, null, '탭이 여러 개면 직접 고르게 한다');
  h.app.chooseNaverTab('99');
  const read = h.messages.at(-1).data;
  naverReply(h, { requestId: read.requestId, requestType: 'naver-filter-state', context: { key: 'k', tabId: 98, conditions: [] } });
  assert.equal(h.app.naverSource.value, null, '다른 탭의 필터는 쓰지 않는다');
  assert.match(h.app.naverError.value, /다시 읽어/);
  h.app.loadNaverTabs();
  const reload = h.messages.at(-1).data;
  naverReply(h, { requestId: reload.requestId, requestType: 'naver-filter-tabs', tabs: [{ id: 98, title: 'A', active: true }] });
  assert.equal(h.app.naverTabId.value, null, '고른 탭이 닫혀도 남은 탭으로 바꾸지 않는다');
  assert.match(h.app.naverError.value, /닫혔습니다/);
  h.app.chooseNaverTab('98');
  assert.equal(h.app.naverBusy.value, 'naver-filter-state');
  [...h.timeouts.values()].at(-1)();
  assert.equal(h.app.naverBusy.value, null);
  assert.match(h.app.naverError.value, /새로고침/);
  assert.equal(h.app.canStart.value, false);
  for (const context of [{ key: '', tabId: 98, conditions: [] }, { key: 'k', tabId: 98, conditions: [{ label: 1, value: 'x' }] }]) {
    h.app.readNaverFilter();
    naverReply(h, { requestId: h.messages.at(-1).data.requestId, requestType: 'naver-filter-state', context });
    assert.equal(h.app.naverSource.value, null, '모양이 다른 필터 응답은 받지 않는다');
  }
});

test('읽은 네이버 필터와 고른 구나 동을 예약용으로 저장하고 결과를 알린다', async (t) => {
  const h = harness(t, { ...NAVER_EXT, version: '0.8.23' });
  h.props.areas = [area(1), regionArea(3), regionArea(4, 'dong')];
  h.app.selectedAreas.value = h.props.areas.map((a) => a.id);
  await h.ready;
  h.receive({ state: null });
  h.app.selectedSites.value = ['naver'];
  assert.equal(h.app.canSaveNaverPreset.value, false, '필터를 읽기 전에는 저장하지 않는다');
  await readNaver(h);
  assert.equal(h.app.canSaveNaverPreset.value, true);
  h.app.saveNaverPreset();
  const save = h.messages.at(-1).data;
  assert.deepEqual([save.type, save.tabId, save.filterKey, save.areaIds], ['naver-preset-save', 99, 'synthetic-key', [3, 4]]);
  assert.equal(h.app.canStart.value, false, '저장 중에는 시작하지 않는다');
  naverReply(h, { requestId: save.requestId, requestType: 'naver-preset-save', preset: { areaIds: [3, 4], updatedAt: 1, summary: 'Synthetic', conditions: [] } });
  assert.match(h.app.naverPresetNotice.value, /예약용으로 저장했습니다/);
  assert.equal(h.app.canStart.value, true);
  h.app.saveNaverPreset();
  naverReply(h, { requestId: h.messages.at(-1).data.requestId, requestType: 'naver-preset-save', error: '예약에는 켜진 구나 동 수집 지역을 선택해 주세요.' });
  assert.equal(h.app.naverPresetNotice.value, null);
  assert.match(h.app.naverError.value, /구나 동/);

  const old = harness(t, NAVER_EXT);
  await old.ready;
  assert.equal(old.app.naverPresetVersionReady.value, false, '0.8.22 확장에는 대시보드 예약용 저장을 열지 않는다');
});

test('수집 지역에 구가 있으면 다방은 구 전체 자동수집에 맡기고 순차 조회에서 뺀다', async (t) => {
  const h = harness(t, { version: '0.8.22', browse: true, sites: ['dabang', 'kbland'] });
  await h.ready;
  h.receive({ state: null });
  assert.deepEqual(clone(h.app.sites.value.map((s) => s.id)), ['dabang', 'kbland'], '구가 없으면 다방을 그대로 고를 수 있다');
  h.app.selectedSites.value = ['dabang', 'kbland'];
  h.props.areas = [area(1), regionArea(3)];
  h.app.selectedAreas.value = [1, 3];
  await vue.nextTick();
  assert.equal(h.app.dabangByServer.value, true);
  assert.deepEqual(clone(h.app.sites.value.map((s) => s.id)), ['kbland']);
  assert.deepEqual(clone(h.app.selectedSites.value), ['kbland'], '이미 고른 다방도 선택에서 빠진다');
  h.app.command('start');
  assert.deepEqual(h.messages.at(-1).data.sites, ['kbland']);
  h.props.areas = [area(1), { ...regionArea(3), purpose: 'alert' }];
  await vue.nextTick();
  assert.equal(h.app.dabangByServer.value, false, '알림용 지역은 다방 구 전체 수집 대상이 아니다');
});

test('켜진 구, 동이나 지하철역이 있으면 직방은 서버 자동수집에 맡기고 순차 조회에서 뺀다', async (t) => {
  const h = harness(t, { version: '0.8.22', browse: true, sites: ['zigbang', 'kbland'] });
  h.props.areas = [{ ...area(1), enabled: false }];
  await h.ready;
  h.receive({ state: null });
  assert.equal(h.app.zigbangByServer.value, false, '켜진 지역이 없으면 서버가 직방을 모으지 않는다');
  assert.deepEqual(clone(h.app.sites.value.map((s) => s.id)), ['zigbang', 'kbland']);
  h.app.selectedSites.value = ['zigbang', 'kbland'];
  h.props.areas = [{ ...area(1), purpose: 'alert' }];
  await vue.nextTick();
  assert.equal(h.app.zigbangByServer.value, true, '알림용 지하철역도 서버가 모은다');
  assert.deepEqual(clone(h.app.sites.value.map((s) => s.id)), ['kbland']);
  assert.deepEqual(clone(h.app.selectedSites.value), ['kbland'], '이미 고른 직방도 선택에서 빠진다');
});
