import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { warmDbFiles } from '../server/warm-db.ts';

// 서버를 켤 때 DB가 운영체제 캐시에 없으면 파일을 이어 읽어 올린다. 캐시에 있으면 몇 군데만 읽어 보고 끝낸다.
function files(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-warm-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'app.db');
  fs.writeFileSync(db, Buffer.alloc(3 * 1024 * 1024 + 123, 1));
  fs.writeFileSync(`${db}-wal`, Buffer.alloc(4567, 2));
  return { db, wal: `${db}-wal` };
}

test('캐시에 없다고 보면 DB와 WAL 파일을 끝까지 읽고, 캐시에 있다고 보면 읽지 않는다', (t) => {
  const { db, wal } = files(t);
  const cold = warmDbFiles([db, wal], { minBytes: 0, coldMs: -1 });
  assert.equal(cold.read, true);
  assert.equal(cold.bytes, 3 * 1024 * 1024 + 123 + 4567);
  const warm = warmDbFiles([db, wal], { minBytes: 0, coldMs: Infinity });
  assert.deepEqual([warm.read, warm.bytes], [false, 0]);
});

test('작은 DB와 없는 파일은 건너뛴다', (t) => {
  const { db } = files(t);
  assert.deepEqual(warmDbFiles([db, `${db}-wal-missing`], { coldMs: -1 }), { read: false, bytes: 0, ms: 0 }, '기본 크기 기준(64MB)보다 작다');
  const missingWal = warmDbFiles([db, `${db}-missing`], { minBytes: 0, coldMs: -1 });
  assert.deepEqual([missingWal.read, missingWal.bytes], [true, 3 * 1024 * 1024 + 123], 'WAL이 없으면 DB만 읽는다');
  assert.equal(warmDbFiles([path.join(path.dirname(db), 'none.db')], { minBytes: 0, coldMs: -1 }).read, false, 'DB가 없으면 아무것도 하지 않는다');
});
