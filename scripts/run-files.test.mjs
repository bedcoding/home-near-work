import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { purgeOldRunFiles, runFoldersToPurge, screenshotPurged } from '../server/run-files.ts';

const DAY = 86400000;
const now = Date.parse('2026-11-05T12:00:00Z');
const iso = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();
const runs = [
  { id: 1, status: 'done', startedAt: iso(40), finishedAt: iso(40) },
  { id: 2, status: 'error', startedAt: iso(31), finishedAt: null },
  { id: 3, status: 'done', startedAt: iso(31), finishedAt: iso(29) },
  { id: 4, status: 'running', startedAt: iso(45), finishedAt: null },
  { id: 5, status: 'done', startedAt: iso(1), finishedAt: iso(1) },
];

test('끝난 지 30일 지난 조회 폴더만 고르고, 조회 중이거나 기록에 없거나 숫자가 아닌 것은 둔다', () => {
  assert.deepEqual(runFoldersToPurge(['5', '1', '2', '3', '4', '9', 'notes', '01'], runs, now), [1, 2]);
  assert.deepEqual(runFoldersToPurge(['1'], runs, now, 50), []);
});

test('오래된 폴더를 지우고 스크린샷 목록과 지운 범위를 기록한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-runs-'));
  try {
    for (const id of ['1', '2', '3', '5']) {
      fs.mkdirSync(path.join(dir, id, 'dabang'), { recursive: true });
      fs.writeFileSync(path.join(dir, id, 'dabang', 'page.json'), 'x'.repeat(100));
    }
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    let forgotten = [], through = 0;
    const result = purgeOldRunFiles({ runsDir: dir, runs: () => runs, forgetScreenshots: (ids) => { forgotten = ids; },
      purgedThrough: () => through, setPurgedThrough: (id) => { through = id; }, now });
    assert.deepEqual(result, { removed: 2, bytes: 200 });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['3', '5', 'keep.txt']);
    assert.deepEqual(forgotten, [1, 2]);
    assert.equal(through, 2);
    // 다시 돌려도 지울 것이 없으면 기록을 바꾸지 않는다.
    assert.deepEqual(purgeOldRunFiles({ runsDir: dir, runs: () => runs, forgetScreenshots: () => assert.fail(),
      purgedThrough: () => through, setPurgedThrough: () => assert.fail(), now }), { removed: 0, bytes: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('지운 조회의 스크린샷만 숨긴다', () => {
  assert.equal(screenshotPurged({ runId: 2 }, 2), true);
  assert.equal(screenshotPurged({ runId: 3 }, 2), false);
  assert.equal(screenshotPurged(null, 2), false);
  assert.equal(screenshotPurged({ runId: '1' }, 2), false);
});
