// 매물 목록 변화분. 매물은 수만 건(수십 MB)이라, 크롬 확장이 순회하는 동안 캡처마다 몇십 건만 바뀌어도
// 화면이 폴링마다 목록 전체를 다시 받아 읽고 모든 카드를 다시 그렸다. 서버는 지난번에 보낸 목록과 견줘
// 바뀐 매물, 새 매물, 없어진 매물 id만 보내고(server/listings-cache.ts), 화면은 가진 목록에 합친다(mergeListings).

/** 전체 목록 응답에 그 목록 버전을 싣는 응답 머리. 전체 목록은 예전처럼 배열로 보낸다. */
export const LISTINGS_TOKEN_HEADER = 'x-listings-token';

/**
 * 기준 목록의 순서를 새 순서로 바꾸는 방법. 숫자 n은 기준 목록에서 아직 놓지 않은 매물을 앞에서부터 n개 가져오고,
 * 글자는 그 id의 매물을 그 자리에 놓는다(새 매물이나 자리를 옮긴 매물). 기준 목록을 읽을 때 없어진 매물과 이미 놓은 매물은 건너뛴다.
 * 매물 순서는 대개 그대로이고 새 매물이 뒤에 붙어서 [38000, 'naver:1', 'naver:2']처럼 짧다.
 */
export type OrderPatch = (number | string)[];

/** 서버가 보내는 매물 목록 변화분. since 버전 목록에 합치면 token 버전 목록이 된다. */
export interface ListingsDelta<T> {
  since: string;
  token: string;
  /** 합친 뒤 매물 수(맞게 합쳤는지 본다) */
  size: number;
  /** 바뀌었거나 새로 생긴 매물 */
  changed: T[];
  /** 없어진 매물 id */
  removed: string[];
  /** 순서가 '기준 목록에서 없어진 매물만 뺀 것'과 다를 때만 온다. */
  order?: OrderPatch;
}

/** 화면이 받는 매물 목록: 전체(token은 그 목록 버전, 서버가 알려 주지 않으면 null)나 변화분 */
export type ListingsReply<T> = { token: string | null; listings: T[] } | ListingsDelta<T>;

/** 기준 순서(base)에서 새 순서(next)로 가는 방법. 없어진 매물만 빠지고 순서가 그대로면 undefined. */
export function orderPatch(base: readonly string[], next: readonly string[], removed: ReadonlySet<string>): OrderPatch | undefined {
  let kept = 0;
  let same = true;
  for (const id of base) {
    if (removed.has(id)) continue;
    if (next[kept++] !== id) {
      same = false;
      break;
    }
  }
  if (same && kept === next.length) return undefined;
  const patch: OrderPatch = [];
  const placed = new Set<string>();
  let at = 0;
  let run = 0;
  for (const id of next) {
    while (at < base.length && (removed.has(base[at]) || placed.has(base[at]))) at++;
    if (base[at] === id) {
      run++;
      at++;
      continue;
    }
    if (run) patch.push(run);
    run = 0;
    patch.push(id);
    placed.add(id);
  }
  if (run) patch.push(run);
  return patch;
}

/** 기준 순서에 orderPatch를 따라 새 순서를 만든다. 기준 순서가 서버가 기억한 것과 달라 모자라면 null. */
export function applyOrder(base: readonly string[], patch: OrderPatch, removed: ReadonlySet<string>): string[] | null {
  const out: string[] = [];
  const placed = new Set<string>();
  let at = 0;
  for (const step of patch) {
    if (typeof step === 'string') {
      out.push(step);
      placed.add(step);
      continue;
    }
    for (let k = 0; k < step; k++) {
      while (at < base.length && (removed.has(base[at]) || placed.has(base[at]))) at++;
      if (at >= base.length) return null;
      out.push(base[at++]);
    }
  }
  return out;
}

/**
 * 가진 목록(list, 서버 순서)에 변화분을 합친 새 목록. 바뀌지 않은 매물은 가진 객체를 그대로 두어 그 카드는 다시 그리지 않는다.
 * 바뀐 것이 없으면 list를 그대로 돌려준다(목록을 쓰는 계산이 다시 돌지 않게). 가진 목록이 서버가 기억한 목록과 맞지 않으면 null.
 */
export function mergeListings<T extends { id: string }>(list: T[], delta: ListingsDelta<T>): T[] | null {
  if (!delta.changed.length && !delta.removed.length && !delta.order) return delta.size === list.length ? list : null;
  const removed = new Set(delta.removed);
  const byId = new Map<string, T>();
  for (const l of list) byId.set(l.id, l);
  for (const l of delta.changed) byId.set(l.id, l);
  const base = list.map((l) => l.id);
  const ids = delta.order ? applyOrder(base, delta.order, removed) : base.filter((id) => !removed.has(id));
  if (!ids || ids.length !== delta.size) return null;
  const out = new Array<T>(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const l = byId.get(ids[i]);
    if (!l) return null;
    out[i] = l;
  }
  return out;
}
