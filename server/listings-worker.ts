import { parentPort } from 'node:worker_threads';
import { ALL_ROWS, db, type RowRange } from './db.js';
import { encodeListings } from './listings-cache.js';
import { buildListingViews } from './views.js';
import type { ListingsWorkerReply, ListingsWorkerRequest } from './listings-body.js';

/**
 * 매물 목록 응답(GET /api/listings의 JSON)을 본 스레드 밖에서 만드는 워커. listings-body.ts가 띄운다.
 * 이 스레드에서 db.ts를 다시 불러 자기 DB 연결로 읽고, 읽기 트랜잭션 하나 안에서 목록을 만들어 한 시점의 자료만 담는다.
 * 행 번호 구간(from, to)을 받으면 그 구간의 매물만 만든다. 워커 여럿이 구간을 나눠 만들면 본 스레드가 이어 붙인다.
 * 만든 JSON과 매물마다 경계(encodeListings)는 복사 없이 넘긴다(transfer). 매물 id 순서는 복사해 넘긴다.
 */

// 이 연결로는 아무것도 쓰지 않는다. 여기서 쓰면 본 스레드의 자료 버전(data_version)이 바뀌어 화면과 서버가 목록을 끝없이 다시 만든다.
db.pragma('query_only = ON');
const readViews = db.transaction((range: RowRange) => {
  // 트랜잭션에서 처음 읽을 때 이 워커가 볼 자료의 시점이 정해진다. 여럿이 나눠 만들 때 본 스레드는 모든 워커가 이 알림을 보낼 때까지
  // 자료 버전이 그대로인지(그 사이에 쓴 것이 없어 모두 같은 시점을 보는지) 확인한다.
  db.prepare('SELECT 1 FROM listings LIMIT 1').get();
  parentPort!.postMessage({ started: true } satisfies ListingsWorkerReply);
  return buildListingViews(range);
});

/** 메모리를 통째로 넘겨도 되는지(다른 배열과 나눠 쓰지 않는지). 아니면 넘기지 않고 복사한다. */
const whole = (a: Uint8Array | Uint32Array) => a.byteOffset === 0 && a.byteLength === a.buffer.byteLength;

/** 받은 부탁의 구간. 예전 모양('build')이나 모르는 모양이면 전부. */
function rangeOf(message: unknown): RowRange {
  const m = message as Partial<ListingsWorkerRequest> | null;
  if (!m || typeof m !== 'object') return ALL_ROWS;
  const bound = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { from: bound(m.from), to: bound(m.to) };
}

parentPort?.on('message', (message: unknown) => {
  let reply: ListingsWorkerReply;
  let transfer: ArrayBuffer[] = [];
  try {
    const { body, ids, offsets } = encodeListings(readViews(rangeOf(message)));
    reply = { ok: true, body, ids, offsets };
    transfer = [body, offsets].filter(whole).map((a) => a.buffer as ArrayBuffer);
  } catch (e) {
    reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  parentPort!.postMessage(reply, transfer);
});
