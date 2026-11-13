import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync(new URL('../server/auto-check.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ busy = false, failStart = false, recent = [], notices = false } = {}) {
  let now = new Date(2026, 9, 20, 22, 31).getTime();
  const settings = new Map([['auto_check_time', '22:30'], ['notice_check_time', notices ? '22:30' : 'off']]);
  const runs = [...recent];
  const state = { busy, failStart, starts: 0, tick: null, browseSlots: [], browseResets: 0 };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const store = {
    getSetting: key => settings.get(key) ?? null,
    setSetting: (key, value) => settings.set(key, value),
    runsSince: since => runs.filter(run => Date.parse(run.startedAt) >= since),
    runInfo: id => runs.find(run => run.id === id) ?? null,
  };
  const runner = {
    isRunning: () => state.busy,
    startRun: (_visible, _scope, options) => {
      if (state.failStart) throw new Error('synthetic prerequisite failure');
      state.busy = true;
      const id = ++state.starts;
      runs.unshift({ id, startedAt: new Clock().toISOString(), finishedAt: null, status: 'running', scope: null, line: null, noticesOnly: !!options.noticesOnly, summary: null });
      return id;
    },
  };
  const dependencies = {
    'node:child_process': { spawn() { throw new Error('OS access forbidden'); } },
    'node:path': {}, './db.js': store, './config.js': {}, './runner.js': runner,
    '../shared/types.js': { CAPTURE_SOURCES: ['naver', 'dabang', 'zigbang'] },
    './browse-auto.js': {
      enqueueScheduledBrowse: slot => { state.browseSlots.push(slot); return true; },
      resetBrowseAutoSchedule: () => { state.browseResets++; },
    },
  };
  const context = {
    exports: {}, Date: Clock, console: { log() {}, warn() {} }, process: { platform: 'test', env: {} },
    setInterval: fn => { state.tick = fn; },
    require: name => { assert.ok(name in dependencies, name); return dependencies[name]; },
  };
  vm.runInNewContext(code, context);
  return {
    api: context.exports, state, settings, runs,
    advance: ms => { now += ms; },
    finish(status = 'done', complete = true) {
      state.busy = false;
      Object.assign(runs[0], { status, finishedAt: new Clock().toISOString(), summary: { complete, sources: [{ source: 'ziptoss', status: complete ? 'ok' : 'error' }] } });
    },
  };
}

test('busy catch-up remains pending and starts on a later scheduler tick', () => {
  const f = fixture({ busy: true });
  assert.equal(f.api.runMissedCheck(), 'skipped');
  assert.equal(f.settings.has('auto_check_last_day'), false);
  f.state.busy = false;
  f.api.startAutoCheck();
  assert.equal(f.state.starts, 1);
  f.finish();
  assert.equal(f.api.runMissedCheck(), 'done');
  assert.equal(f.api.autoCheckState().missed, false);
});

test('a server Dabang GU run counts as a recent full collection, while extension-only capture does not', () => {
  const startedAt = new Date(2026, 9, 20, 22, 20).toISOString();
  for (const isServerRun of [true, false]) {
    const f = fixture({ recent: [{ id: 90, startedAt, scope: null, line: null, summary: {
      sources: [{ source: 'dabang', ...(isServerRun ? { coverage: [{ complete: true }] } : {}) }],
    } }] });
    f.api.runMissedCheck();
    assert.equal(f.state.starts, isServerRun ? 0 : 1);
  }
});

test('a manually narrowed collection does not suppress the scheduled full run', () => {
  const startedAt = new Date(2026, 9, 20, 22, 20).toISOString();
  const f = fixture({ recent: [{ id: 90, startedAt, scope: null, line: null, summary: {
    selectedSubset: true, sources: [{ source: 'dabang', coverage: [{ complete: true }] }],
  } }] });
  assert.equal(f.api.runMissedCheck(), 'started');
  assert.equal(f.state.starts, 1);
});

test('failed start is not retried in the same slot', () => {
  const f = fixture({ failStart: true });
  assert.equal(f.api.runMissedCheck(), 'skipped');
  f.state.failStart = false;
  assert.equal(f.api.runMissedCheck(), 'done');
  f.advance(15 * 60_000);
  assert.equal(f.api.runMissedCheck(), 'done');
  assert.equal(f.state.starts, 0);
});

test('partial and failed runs are not retried in the same slot', () => {
  for (const status of ['done', 'error']) {
    const f = fixture();
    assert.equal(f.api.runMissedCheck(), 'started');
    f.finish(status, false);
    assert.equal(f.api.runMissedCheck(), 'done');
    f.advance(15 * 60_000);
    assert.equal(f.api.runMissedCheck(), 'done');
    assert.equal(f.state.starts, 1);
    assert.equal(f.api.autoCheckState().missed, false);
  }
});

test('explicit stop is respected instead of automatically restarting', () => {
  const f = fixture();
  assert.equal(f.api.runMissedCheck(), 'started');
  f.finish('stopped', false);
  f.advance(15 * 60_000);
  assert.equal(f.api.runMissedCheck(), 'done');
  assert.equal(f.state.starts, 1);
});

test('recent manual runs suppress the scheduled run even when partial, failed or stopped', () => {
  for (const status of ['error', 'stopped', 'done']) {
    const f = fixture({ recent: [{ id: 100, startedAt: new Date(2026, 9, 20, 22).toISOString(), status, summary: { complete: false, sources: [{ source: 'ziptoss', status: 'error' }] } }] });
    assert.equal(f.api.runMissedCheck(), 'skipped');
    assert.equal(f.state.starts, 0);
  }
});

test('successful full check covers the notice slot without another run', () => {
  const f = fixture({ notices: true });
  assert.equal(f.api.runMissedCheck(), 'started');
  assert.equal(f.api.runMissedCheck(), 'skipped');
  f.finish();
  assert.equal(f.api.runMissedCheck(), 'skipped');
  assert.equal(f.api.runMissedCheck(), 'done');
  assert.equal(f.state.starts, 1);
});

test('known collection limits are reported without repeating an unfixable run', () => {
  const f = fixture();
  assert.equal(f.api.runMissedCheck(), 'started');
  f.finish('done', false);
  f.runs[0].summary.retryable = false;
  f.advance(15 * 60_000);
  assert.equal(f.api.runMissedCheck(), 'done');
  assert.equal(f.state.starts, 1);
});

test('browser schedule is offered even when regular collectors are busy, recent or already handled', () => {
  const fixtures = [fixture({ busy: true }), fixture({ recent: [{ id: 100, startedAt: new Date(2026, 9, 20, 22).toISOString(), summary: { sources: [{ source: 'ziptoss' }] } }] }), fixture()];
  fixtures[2].settings.set('auto_check_last_day', '2026-10-20');
  for (const f of fixtures) {
    f.api.runMissedCheck();
    assert.deepEqual(f.state.browseSlots, [new Date(2026, 9, 20, 22, 30).getTime()]);
  }
});

test('notice-only slots do not enqueue a browser tour', () => {
  const f = fixture({ notices: true });
  f.settings.set('auto_check_time', 'off');
  assert.equal(f.api.runMissedCheck(), 'started');
  assert.deepEqual(f.state.browseSlots, []);
});

test('only changes to full schedule reset the browser schedule baseline', async () => {
  const f = fixture();
  await f.api.setAutoCheck({ visible: false });
  await f.api.setAutoCheck({ noticeTime: '19:00' });
  assert.equal(f.state.browseResets, 0);
  await f.api.setAutoCheck({ time: '21:00' });
  await f.api.setAutoCheck({ day: 2 });
  assert.equal(f.state.browseResets, 2);
});
