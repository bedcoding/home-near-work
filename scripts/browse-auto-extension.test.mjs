import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = fs.readFileSync(new URL('../extension/browse-auto.js', import.meta.url), 'utf8');
const REPORT = 'hnw-browse-auto-report', ACK = 'hnw-browse-auto-ack';
const snapshot = (token = 'token-1') => ({ requestId: 'request-1', runId: 'request-1', status: 'done', totalJobs: 2, completeJobs: 1, partialJobs: 1, failedJobs: 0, token });
function worker(saved = {}, options = {}) {
  const posts = [], starts = [];
  let sequence = 0;
  const state = { ready: true, current: null, request: { id: 'request-1', sites: ['dabang'], areas: [] }, reportStatus: 200, ...options };
  const context = vm.createContext({
    crypto: { randomUUID: () => `synthetic-${++sequence}` },
    chrome: { storage: { local: {
      get: async keys => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in saved).map(k => [k, saved[k]]))),
      set: async value => Object.assign(saved, structuredClone(value)),
    } }, runtime: { getManifest: () => ({ version: '0.8.5' }) } },
    HNW_BROWSE: {
      automaticReady: async () => state.ready,
      read: async () => state.current,
      startAutomatic: async request => {
        starts.push(request.id);
        if (state.startError) throw state.startError;
        saved[REPORT] = { ...snapshot('started'), status: 'running', completeJobs: 0, partialJobs: 0 };
        state.ready = false;
      },
    },
    postJson: async (url, payload) => {
      posts.push({ url, payload: structuredClone(payload) });
      if (url.endsWith('/report')) {
        if (state.reportStatus !== 200) throw Object.assign(new Error('synthetic transport failure'), { status: state.reportStatus });
        if (state.onReport) state.onReport(saved);
        return { ok: true };
      }
      return { request: state.request };
    },
  });
  vm.runInContext(source + '\nglobalThis.testApi = HNW_AUTO_BROWSE;', context);
  return { api: context.testApi, posts, starts, state, saved };
}

test('서버 응답 실패 후 워커가 다시 떠도 완료 보고를 다시 보내며 성공으로 바꾸지 않는다', async () => {
  const saved = { [REPORT]: snapshot() };
  const offline = worker(saved, { reportStatus: 503 });
  await assert.rejects(offline.api.poll());
  assert.equal(saved[ACK], undefined);
  assert.equal(offline.starts.length, 0);
  const restarted = worker(saved, { request: null });
  await restarted.api.poll();
  const report = restarted.posts.find(p => p.url.endsWith('/report')).payload;
  assert.equal(report.status, 'done');
  assert.equal(report.partialJobs, 1);
  assert.equal(report.token, undefined, '로컬 ACK 식별자는 서버에 보내지 않는다');
  assert.equal(saved[ACK], 'token-1');
});

test('보고 중 새 상태가 도착해도 오래된 ACK로 지우지 않는다', async () => {
  const saved = { [REPORT]: snapshot() };
  const h = worker(saved, { request: null, onReport: storage => { storage[REPORT] = snapshot('newer-token'); } });
  await h.api.poll();
  assert.equal(saved[ACK], 'token-1');
  assert.equal(saved[REPORT].token, 'newer-token');
  h.state.onReport = null;
  await h.api.poll();
  assert.equal(h.posts.filter(p => p.url.endsWith('/report')).length, 2);
  assert.equal(saved[ACK], 'newer-token');
});

test('수동 순회 중에는 기존 보고만 보내고 새 예약을 가져오지 않는다', async () => {
  const h = worker({ [REPORT]: snapshot() }, { ready: false });
  await h.api.poll();
  assert.equal(h.posts.length, 1);
  assert.ok(h.posts[0].url.endsWith('/report'));
  assert.equal(h.starts.length, 0);
});

test('같은 알람이 겹쳐도 요청 수신과 시작은 한 번이며 시작 확인을 보고한다', async () => {
  const h = worker();
  await Promise.all([h.api.poll(), h.api.poll()]);
  assert.deepEqual(h.starts, ['request-1']);
  assert.equal(h.posts.filter(p => p.url.endsWith('/poll')).length, 1);
  assert.equal(h.posts.find(p => p.url.endsWith('/report')).payload.status, 'running');
});

test('이미 소비된 회차는 실패로 보고하며 다른 수동 상태를 건드리지 않는다', async () => {
  const h = worker({}, { startError: Object.assign(new Error('consumed'), { code: 'consumed' }), current: { id: 'manual-run' } });
  await h.api.poll();
  assert.equal(h.posts.find(p => p.url.endsWith('/report')).payload.status, 'failed');
  assert.equal(h.state.current.id, 'manual-run');
});

test('회차 전환 뒤 거절된 이전 보고는 끝내고 새 요청을 확인한다', async () => {
  const h = worker({ [REPORT]: snapshot() }, { reportStatus: 409, request: null });
  await h.api.poll();
  assert.equal(h.saved[ACK], 'token-1');
  assert.ok(h.posts.some(p => p.url.endsWith('/poll')));
});
