import { parentPort } from 'node:worker_threads';
import { db } from './db.js';
import { encodeListings } from './listings-cache.js';
import { buildListingViews } from './views.js';
import type { ListingsWorkerReply } from './listings-body.js';

/**
 * 매물 목록 응답(GET /api/listings의 JSON)을 본 스레드 밖에서 만드는 워커. listings-body.ts가 띄운다.
 * 이 스레드에서 db.ts를 다시 불러 자기 DB 연결로 읽고, 읽기 트랜잭션 하나 안에서 목록을 만들어 한 시점의 자료만 담는다.
 * 만든 JSON과 매물마다 경계(encodeListings)는 복사 없이 넘긴다(transfer). 매물 id 순서는 복사해 넘긴다.
 */

// 이 연결로는 아무것도 쓰지 않는다. 여기서 쓰면 본 스레드의 자료 버전(data_version)이 바뀌어 화면과 서버가 목록을 끝없이 다시 만든다.
db.pragma('query_only = ON');
const readViews = db.transaction(buildListingViews);

/** 메모리를 통째로 넘겨도 되는지(다른 배열과 나눠 쓰지 않는지). 아니면 넘기지 않고 복사한다. */
const whole = (a: Uint8Array | Uint32Array) => a.byteOffset === 0 && a.byteLength === a.buffer.byteLength;

parentPort?.on('message', () => {
  let reply: ListingsWorkerReply;
  let transfer: ArrayBuffer[] = [];
  try {
    const { body, ids, offsets } = encodeListings(readViews());
    reply = { ok: true, body, ids, offsets };
    transfer = [body, offsets].filter(whole).map((a) => a.buffer as ArrayBuffer);
  } catch (e) {
    reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  parentPort!.postMessage(reply, transfer);
});
