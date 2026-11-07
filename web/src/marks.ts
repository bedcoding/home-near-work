import { ref, watch } from 'vue';
import type { ListingView } from '../../shared/types';

// 대시보드에서 매물에 남기는 내 표시: '봤음'(눌러 본 매물)과 '문의함'(중개사에게 문의한 매물, 📞).
// 지도 표시를 누르면 말풍선에 보인 매물이, 카드를 누르거나 원본을 열면 그 매물이 '봤음'이 된다. '문의함'은 단추로 남기고 푼다.
// 매물 목록과 서버 저장은 App.vue가 맡아 onMarks로 등록하고, 지도와 카드는 markSeen, setContacted만 부른다.

interface Handlers {
  seen: (items: ListingView[]) => void;
  contact: (l: ListingView, on: boolean) => void;
}
let handlers: Handlers = { seen: () => {}, contact: () => {} };

/**
 * 표시를 바꿀 때마다 늘린다. 매물은 수만 건이라 깊이 감시하지 않아서(App.vue), 카드가 이 값을 읽어 표시가 바뀌면 다시 그린다.
 */
export const marksVersion = ref(0);

export function onMarks(h: Handlers) {
  handlers = h;
}

export function markSeen(items: ListingView[]) {
  handlers.seen(items);
}

export function setContacted(l: ListingView, on: boolean) {
  handlers.contact(l, on);
}

/** '본 매물' 모양으로 그릴지: 본 뒤로 새 소식(신규, 가격 변동)이 없고 관심, 별로, 버림으로 고르지도 않은 매물 */
export const looksSeen = (l: ListingView) => !!l.seenAt && !l.isNew && !l.priceChange && !l.verdict;

/** 관심을 눌렀거나 '📞 문의함'을 누른 매물 */
export const isPick = (l: ListingView) => l.verdict === 'star' || !!l.contactedAt;

const PICKS_KEY = 'hnw-picks-only';
function readPicksOnly() {
  try {
    return localStorage.getItem(PICKS_KEY) === '1';
  } catch {
    return false;
  }
}
/**
 * 필터 칸 맨 위 '관심이나 문의한 매물만 보기'. 켜면 목록, 지도, 탭 숫자가 모두 그 매물만 센다.
 * 알림 조건으로도 저장되는 필터(Filters)와 섞이지 않게 화면 보기 옵션으로 따로 두고 브라우저에만 기억한다.
 */
export const picksOnly = ref(readPicksOnly());
watch(picksOnly, (on) => {
  try {
    localStorage.setItem(PICKS_KEY, on ? '1' : '0');
  } catch {
    /* 저장이 막혀도 동작한다 */
  }
});
