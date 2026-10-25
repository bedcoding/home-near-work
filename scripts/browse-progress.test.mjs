import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrowseProgress } from '../server/browse-progress.ts';

const input = () => ({
  id: 'synthetic-run:1', status: 'running', phase: 'exploring',
  createdAt: 1000, updatedAt: 2000, heartbeatAt: 3000, index: 0, totalJobs: 2,
  totals: { responses: 3, listings: 8, newCount: 2, changedCount: 1 },
  current: { site: 'dabang', actions: 4, received: 3 },
  logs: [
    { at: 1000, code: 'start' },
    { at: 2000, code: 'action', jobIndex: 0, site: 'dabang', actions: 4 },
    { at: 3000, code: 'saved', jobIndex: 0, responses: 3, listings: 8 },
  ],
});
const rejects = (value) => assert.throws(() => normalizeBrowseProgress(value, 4000), (error) => error.statusCode === 400);

test('progress preserves counts and coded events with a server-controlled receipt timestamp', () => {
  const raw = input();
  raw.receivedAt = 999999;
  const result = normalizeBrowseProgress(raw, 4000);
  assert.deepEqual(result, { ...input(), receivedAt: 4000 });
  result.logs[0].at = 42;
  result.totals.responses = 99;
  result.current.actions = 99;
  assert.equal(raw.logs[0].at, 1000);
  assert.equal(raw.totals.responses, 3);
  assert.equal(raw.current.actions, 4);
});

test('private-looking extra fields are stripped at every nesting level', () => {
  const raw = input();
  const extras = { areaName: 'Synthetic private label', url: 'https://example.invalid/private', note: 'Synthetic private note', lat: 35.1, lng: 128.1, error: 'Synthetic private exception' };
  Object.assign(raw, extras, { jobs: [{ ...extras }], region: { ...extras } });
  Object.assign(raw.totals, extras);
  Object.assign(raw.current, extras);
  for (const event of raw.logs) Object.assign(event, extras);
  const result = normalizeBrowseProgress(raw, 4000);
  assert.deepEqual(result, { ...input(), receivedAt: 4000 });
  assert.doesNotMatch(JSON.stringify(result), /Synthetic private|example\.invalid|areaName|lat|lng/);
});

test('all recognized event codes survive while retained history is limited to the latest100', () => {
  const codes = ['start', 'hints', 'ready', 'open', 'connected', 'action', 'received', 'saved', 'waiting', 'pause', 'resume', 'retry', 'job-end', 'done', 'error', 'recovered'];
  const raw = input();
  raw.logs = Array.from({ length: 120 }, (_, at) => ({ at, code: codes[at % codes.length] }));
  const result = normalizeBrowseProgress(raw, 4000);
  assert.equal(result.logs.length, 100);
  assert.equal(result.logs[0].at, 20);
  assert.equal(result.logs.at(-1).at, 119);
  assert.deepEqual(new Set(result.logs.map((event) => event.code)), new Set(codes));
  raw.logs[0].code = 'unrecognized';
  rejects(raw);
});

test('malformed containers, enums, IDs and unsafe numeric data are rejected without echoing input', () => {
  for (const value of [null, [], 'invalid', {}]) rejects(value);
  for (const [key, value] of [
    ['id', 'https://example.invalid/private'], ['id', 'x'.repeat(121)], ['id', ''],
    ['status', 'success'], ['phase', 'collecting'], ['index', 3], ['logs', null], ['current', null],
  ]) rejects({ ...input(), [key]: value });
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    for (const key of ['createdAt', 'updatedAt', 'heartbeatAt', 'index', 'totalJobs']) rejects({ ...input(), [key]: value });
    for (const key of ['responses', 'listings', 'newCount', 'changedCount']) {
      const raw = input(); raw.totals[key] = value; rejects(raw);
    }
    for (const key of ['actions', 'received']) {
      const raw = input(); raw.current[key] = value; rejects(raw);
    }
    for (const key of ['at', 'jobIndex', 'responses', 'listings', 'actions']) {
      const raw = input(); raw.logs[0][key] = value; rejects(raw);
    }
  }
  rejects({ ...input(), current: { site: 'unknown', actions: 0, received: 0 } });
  rejects({ ...input(), logs: [{ at: 1, code: 'private exception text' }] });
  rejects({ ...input(), logs: [{ at: 1, code: 'start', site: 'unknown' }] });
  assert.throws(() => normalizeBrowseProgress(input(), -1), (error) => error.statusCode === 400);
  assert.throws(() => normalizeBrowseProgress({ ...input(), id: 'Synthetic private identifier /' }), (error) => !error.message.includes('Synthetic'));
});

test('an empty run and snapshots without a current job remain valid', () => {
  const raw = input();
  delete raw.current;
  raw.status = 'done'; raw.phase = 'done'; raw.index = 0; raw.totalJobs = 0; raw.logs = [];
  raw.totals = { responses: 0, listings: 0, newCount: 0, changedCount: 0 };
  const result = normalizeBrowseProgress(raw, 4000);
  assert.equal(Object.hasOwn(result, 'current'), false);
  assert.deepEqual(result.logs, []);
  assert.equal(result.totalJobs, 0);
});
