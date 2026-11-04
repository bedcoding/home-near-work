import assert from 'node:assert/strict';
import test from 'node:test';
import { browseConsole, normalizeBrowseProgress } from '../server/browse-progress.ts';

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

test('page progress preserves numeric evidence and last successful list time without private region data',()=>{
  const raw=input(); Object.assign(raw.current,{site:'naver',pages:3,listings:90,total:8000,lastListAt:2500,areaName:'Synthetic private region'});
  const result=normalizeBrowseProgress(raw,4000);
  assert.equal(result.current.pages,3); assert.equal(result.current.lastListAt,2500); assert.equal(result.current.areaName,undefined);
  for(const key of ['pages','listings','total','lastListAt']) rejects({...raw,current:{...raw.current,[key]:-1}});
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

test('extension tour events become one console line each, without region names or events from before the server started', () => {
  const lines = browseConsole(1500);
  const base = { id: 'synthetic-run:2', status: 'running', phase: 'saving', createdAt: 1000, updatedAt: 2000, heartbeatAt: 2000, receivedAt: 2000,
    index: 1, totalJobs: 3, totals: { responses: 3, listings: 40, newCount: 2, changedCount: 1 },
    current: { site: 'naver', actions: 2, received: 2, pages: 2, listings: 40, total: 120 }, logs: [] };
  const logs = [
    { at: 1000, code: 'ready' },
    { at: 1600, code: 'open', jobIndex: 1, site: 'naver' },
    { at: 1700, code: 'action', jobIndex: 1, site: 'naver', actions: 1 },
    { at: 1750, code: 'received', jobIndex: 1, site: 'naver', responses: 1 },
    { at: 1800, code: 'saved', jobIndex: 1, site: 'naver', responses: 1, listings: 20 },
    { at: 1900, code: 'saved', jobIndex: 1, site: 'naver', responses: 2, listings: 40 },
  ];
  assert.deepEqual(lines({ ...base, logs }), [
    '[확장 조회] 2/3 네이버: 페이지를 엽니다',
    '[확장 조회] 2/3 네이버: 서버 저장 확인, 응답 1건, 매물 저장 처리 20건',
    '[확장 조회] 2/3 네이버: 서버 저장 확인, 응답 2건, 매물 저장 처리 40건, 2페이지, 목록 40/120건',
  ]);
  assert.deepEqual(lines({ ...base, logs }), [], 'the same snapshot does not print again');
  const done = [...logs, { at: 2100, code: 'job-end', jobIndex: 1, site: 'naver', responses: 2, listings: 40 }, { at: 2200, code: 'done' }];
  assert.deepEqual(lines({ ...base, status: 'done', index: 3, current: undefined, logs: done }), [
    '[확장 조회] 2/3 네이버: 조회 종료, 응답 2건, 매물 저장 처리 40건',
    '[확장 조회] 조회 끝, 3개 조회, 신규 2건, 가격 변경 1건',
  ]);
  assert.deepEqual(lines({ ...base, id: 'synthetic-run:3', status: 'running', logs: [...done, { at: 2300, code: 'retry' }] }),
    ['[확장 조회] 미확인 항목을 처음부터 다시 조회합니다'], 'a retried run with a new id keeps earlier events printed once');
  for (const line of lines({ ...base, logs: [{ at: 2400, code: 'error', jobIndex: 2, site: 'zigbang' }] })) assert.doesNotMatch(line, /undefined|null/);
});
