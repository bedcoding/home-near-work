import { mergeListings, type ListingsReply } from '../../shared/listings-delta';

/**
 * 화면의 매물 목록을 서버와 맞춘다. 지난번에 받은 목록 버전을 기억했다가 그 뒤로 바뀐 매물만 받아 가진 목록에 합친다
 * (shared/listings-delta.ts). 서버가 그 버전을 모르거나(서버를 다시 켬) 합친 결과가 서버 목록과 맞지 않으면 전체를 받는다.
 * 앞 결과에 다음 변화분을 합쳐야 해서 받기는 한 번에 하나씩 차례로 한다.
 */
export function createListingsSync<T extends { id: string }>(fetchListings: (since: string | null) => Promise<ListingsReply<T>>) {
  let token: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function pull(current: () => T[]): Promise<T[]> {
    const reply = await fetchListings(token);
    if ('listings' in reply) {
      token = reply.token;
      return reply.listings;
    }
    const merged = reply.since === token ? mergeListings(current(), reply) : null;
    if (merged) {
      token = reply.token;
      return merged;
    }
    // 가진 목록이 서버가 기억한 목록과 어긋났다. 전체를 다시 받는다.
    token = null;
    const full = await fetchListings(null);
    if (!('listings' in full)) throw new Error('매물 목록 전체를 받지 못했습니다.');
    token = full.token;
    return full.listings;
  }

  /** 서버 목록을 current()(지금 가진 목록)에 맞춘 새 목록. 바뀐 매물이 없으면 가진 목록을 그대로 돌려준다. */
  const sync = (current: () => T[]): Promise<T[]> => {
    const result = queue.catch(() => {}).then(() => pull(current));
    queue = result;
    return result;
  };
  /** 다음 받기는 전체를 받는다(화면이 먼저 바꾼 표시를 저장하지 못해 서버 상태로 되돌려야 할 때). 받는 중이면 그 뒤에 잊는다. */
  const forget = () => {
    queue = queue.catch(() => {}).then(() => {
      token = null;
    });
  };
  return Object.assign(sync, { forget });
}
