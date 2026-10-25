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

function harness(t, extension = { version: 'test', browse: true, sites: ['naver', 'dabang', 'kbland'] }) {
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
  vm.runInNewContext(compiled, {
    exports, window: win, location: { origin }, URL, Date: Clock,
    require: (id) => {
      if (id === 'vue') return { ...vue, onMounted: (fn) => mounted.push(fn), onBeforeUnmount: (fn) => unmounted.push(fn) };
      if (id === '../format') return { radiusText: () => '예시 반경' };
      throw new Error(`Unexpected import ${id}`);
    },
  }, { filename: 'BrowseQueue.synthetic-test.cjs' });
  const scope = vue.effectScope();
  const app = scope.run(() => exports.default.setup(props, { expose() {}, emit() {} }));
  const unmount = () => { unmounted.forEach((fn) => fn()); scope.stop(); };
  t.after(unmount);
  mounted.forEach((fn) => fn());
  const receive = (data, overrides = {}) => listeners.get('message')?.({ source: win, origin, data: { source: 'hnw-extension', type: 'browse-status', ...data }, ...overrides });
  return { app, props, messages, receive, win, intervals, timeouts, listeners, unmount, advance: (ms) => { now += ms; }, now: () => now, tick: () => intervals.forEach((fn) => fn()) };
}

test('선택 지역과 켜진 매물 사이트만 시작 메시지에 전달한다', (t) => {
  const h = harness(t);
  assert.deepEqual(clone(h.app.selectedAreas.value), [1, 2]);
  assert.deepEqual(clone(h.app.selectedSites.value), ['naver', 'dabang']);
  assert.equal(h.app.canStart.value, false, '최초 상태 확인 전 중복 시작을 막는다');
  h.receive({ state: null });
  h.app.selectedAreas.value = [2];
  h.app.command('start');
  const command = h.messages.at(-1);
  assert.equal(command.origin, 'https://example.invalid');
  assert.deepEqual(command.data.areas, [{ id: 2, name: '예시 지역 2', lat: 35.102000000000004, lng: 128.1, radiusM: 700 }]);
  assert.deepEqual(command.data.sites, ['naver', 'dabang']);
  const count = h.messages.length;
  h.app.command('start');
  assert.equal(h.messages.length, count, '응답 대기 중 중복 명령을 보내지 않는다');
});

test('브라우저 메시지 전송이 실패해도 시작하는 중에 갇히지 않고 다시 실행할 수 있다', (t) => {
  const h = harness(t);
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

test('다른 창과 origin 메시지 또는 잘못된 receipt를 저장 확인으로 표시하지 않는다', (t) => {
  const h = harness(t);
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

test('중단 상태를 복구하고 이어하기하며 패널 종료 시 폴링과 메시지 수신을 정리한다', (t) => {
  const h = harness(t);
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

test('응답이 끊기면 시작을 잠그고 연결 재확인 후 선택을 유지한 채 다시 활성화한다', (t) => {
  const h = harness(t);
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

test('시작 요청 직후 진행 안내와 로그를 보이고 응답 대기 중에도 상태를 계속 조회한다', (t) => {
  const h = harness(t);
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

test('명령 대기 중 작업 상태 푸시는 단계와 카운터를 갱신하되 대기를 해제하지 않는다', (t) => {
  const h = harness(t);
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

test('오래된 상태와 멈춘 작업 신호는 진행 중이라고 단정하지 않고 재시작을 막는다', (t) => {
  const h = harness(t);
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

test('타임아웃과 관련 없는 오류가 시작 성공으로 바뀌지 않고 명령 오류는 유지된다', (t) => {
  const h = harness(t);
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

test('잘못된 로그와 진행 필드는 거부하고 기존 상태는 호환하며 표시 로그 수를 제한한다', (t) => {
  const h = harness(t);
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
