import type { ListingView } from '../../shared/types';

// 대시보드에서 눌러 본 매물('봤음'). 지도 표시를 누르면 말풍선에 보인 매물이, 카드를 누르거나 원본을 열면 그 매물이 남는다.
// 매물 목록과 서버 저장은 App.vue가 맡아 onSeen으로 등록하고, 지도와 카드는 markSeen만 부른다.

let handler: (items: ListingView[]) => void = () => {};

export function onSeen(fn: (items: ListingView[]) => void) {
  handler = fn;
}

export function markSeen(items: ListingView[]) {
  handler(items);
}

/** '본 매물' 모양으로 그릴지: 본 뒤로 새 소식(신규, 가격 변동)이 없고 관심, 별로, 버림으로 고르지도 않은 매물 */
export const looksSeen = (l: ListingView) => !!l.seenAt && !l.isNew && !l.priceChange && !l.verdict;
