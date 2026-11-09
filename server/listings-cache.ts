import { randomUUID } from 'node:crypto';
import { orderPatch } from '../shared/listings-delta.js';

/**
 * 매물 목록 응답 JSON. body는 [매물,매물,...] 그대로이고, 매물 i의 JSON은 body의 offsets[i]부터 offsets[i + 1] - 1 앞까지다
 * (뒤의 쉼표나 닫는 괄호를 뺀 자리). offsets는 매물 수보다 하나 길다. 변화분을 만들 때 매물 JSON을 다시 만들지 않고 잘라 쓴다.
 */
export interface ListingsJson {
  body: Buffer;
  ids: string[];
  offsets: Uint32Array;
}

/** 매물 목록을 응답 JSON으로 만든다. body는 JSON.stringify(views)와 바이트까지 같다. */
export function encodeListings(views: readonly { id: string }[]): ListingsJson {
  const items = views.map((v) => JSON.stringify(v));
  const offsets = new Uint32Array(items.length + 1);
  let size = 1;
  for (let i = 0; i < items.length; i++) {
    offsets[i] = size;
    size += Buffer.byteLength(items[i]) + 1;
  }
  offsets[items.length] = size;
  // 워커는 body를 복사 없이 넘기므로 다른 Buffer와 메모리를 나눠 쓰지 않게 alloc으로 따로 잡는다.
  const body = Buffer.alloc(Math.max(size, 2));
  body[0] = 0x5b;
  for (let i = 0; i < items.length; i++) {
    body.write(items[i], offsets[i]);
    body[offsets[i + 1] - 1] = 0x2c;
  }
  body[body.length - 1] = 0x5d;
  return { body, ids: views.map((v) => v.id), offsets };
}

/** 매물 i의 JSON 바이트 */
const itemOf = (json: ListingsJson, i: number) => json.body.subarray(json.offsets[i], json.offsets[i + 1] - 1);
const COMMA = Buffer.from(',');
const CLOSE = Buffer.from(']}');

/** 지난 목록을 몇 벌까지 기억할지. 창을 여러 개 열었거나 숨긴 탭이 드문드문 물어도 변화분으로 답하게 한 벌보다 넉넉히 둔다. */
const KEEP = 6;

/**
 * 매물 목록 응답을 기억해 두고, 화면이 지난번에 받은 목록 버전(since)을 알려 오면 그 뒤로 바뀐 매물만 보낸다(shared/listings-delta.ts).
 * 지금 목록은 응답 JSON 그대로 두고, 지난 목록은 매물 순서와 그 목록에서 바뀐 매물 id만 둔다(매물 내용은 두지 않는다).
 */
export function createListingsCache(keep = KEEP) {
  // 서버를 다시 켜면 예전 버전과 겹치지 않게 켤 때마다 머리를 바꾼다.
  const head = randomUUID().slice(0, 8);
  let made = 0;
  let now: ListingsJson = encodeListings([]);
  /** 지금 목록에서 매물 id의 자리 */
  let index = new Map<string, number>();
  /** 오래된 것부터, 마지막이 지금 목록. changed는 바로 앞 목록과 견줘 바뀌었거나 새로 생긴 매물 id */
  let kept: { token: string; ids: string[]; changed: Set<string> }[] = [];
  /** 기억한 적 있는 목록. 늦게 끝난 요청이 예전 목록을 다시 주면 지금 목록을 되돌리지 않는다. */
  const seen = new WeakSet<ListingsJson>();

  return {
    /** 지금 목록 버전(아직 기억한 목록이 없으면 null) */
    token: (): string | null => kept.at(-1)?.token ?? null,

    /**
     * 새로 만든 목록을 기억하고 지금 목록 버전을 돌려준다. 이미 기억한 것을 다시 주면 바로 돌려주고,
     * 다시 만든 목록이 앞 목록과 순서와 매물마다 바이트까지 같으면 버전을 그대로 둔다.
     */
    remember(json: ListingsJson): string {
      const last = kept.at(-1);
      if (last && seen.has(json)) return last.token;
      seen.add(json);
      const changed = new Set<string>();
      const nextIndex = new Map<string, number>();
      for (let i = 0; i < json.ids.length; i++) {
        const id = json.ids[i];
        nextIndex.set(id, i);
        const j = index.get(id);
        if (j === undefined) {
          changed.add(id);
          continue;
        }
        // 길이부터 보고, 같으면 바이트를 견준다(매물마다 조각 객체를 만들지 않는다).
        const [a0, a1, b0, b1] = [now.offsets[j], now.offsets[j + 1] - 1, json.offsets[i], json.offsets[i + 1] - 1];
        if (a1 - a0 !== b1 - b0 || json.body.compare(now.body, a0, a1, b0, b1) !== 0) changed.add(id);
      }
      const same = !!last && !changed.size && last.ids.length === json.ids.length && last.ids.every((id, i) => id === json.ids[i]);
      now = json;
      index = nextIndex;
      if (same) return last.token;
      kept = [...kept.slice(Math.max(0, kept.length - keep + 1)), { token: `${head}-${++made}`, ids: json.ids, changed }];
      return kept[kept.length - 1].token;
    },

    /** 지금 목록 전체(JSON 배열, 예전 응답과 같은 모양) */
    full: (): Buffer => now.body,

    /** since 버전 목록에서 지금 목록으로 가는 변화분(JSON). 모르는 버전(서버를 다시 켰거나 너무 오래됨)이면 null */
    since(token: string): Buffer | null {
      const from = kept.findIndex((g) => g.token === token);
      if (from < 0) return null;
      const changed = new Set<string>();
      for (const g of kept.slice(from + 1)) for (const id of g.changed) if (index.has(id)) changed.add(id);
      const base = kept[from].ids;
      const removed = base.filter((id) => !index.has(id));
      const order = orderPatch(base, now.ids, new Set(removed));
      const meta = JSON.stringify({ since: token, token: kept[kept.length - 1].token, size: now.ids.length, removed, ...(order ? { order } : {}) });
      // 바뀐 매물은 만들어 둔 JSON을 그대로 잘라 잇는다(다시 만들지 않는다).
      const parts: Buffer[] = [Buffer.from(`${meta.slice(0, -1)},"changed":[`)];
      for (const id of changed) {
        if (parts.length > 1) parts.push(COMMA);
        parts.push(itemOf(now, index.get(id)!));
      }
      parts.push(CLOSE);
      return Buffer.concat(parts);
    },
  };
}
