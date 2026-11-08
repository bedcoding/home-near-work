import { distanceM } from './geo.js';
import type { NormalizedListing } from './types.js';

/** looksSimilar가 보는 매물 칸(서버의 저장 매물과 화면의 ListingView가 같이 쓴다) */
export type SimilarTarget = Pick<NormalizedListing, 'lat' | 'lng' | 'areaM2' | 'basement' | 'floor' | 'prices'>;

/**
 * 버림한 매물과 '비슷한지'. 사이트가 달라도 위치(30m), 층, 면적(1.5㎡)이 거의 같고 같은 거래 유형이 있으면 true.
 * 자동으로 숨기지 않고 배지만 붙이는 데 쓴다. a와 b를 바꿔도 결과가 같다.
 * 서버는 매물 목록을 만들 때, 화면은 버림을 바꾼 뒤 그 매물 둘레만 다시 낼 때 쓴다.
 */
export function looksSimilar(a: SimilarTarget, b: SimilarTarget): boolean {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return false;
  if (distanceM(a.lat, a.lng, b.lat, b.lng) > 30) return false;
  if (a.areaM2 == null || b.areaM2 == null || Math.abs(a.areaM2 - b.areaM2) > 1.5) return false;
  if (a.basement !== b.basement) return false;
  if (a.floor != null && b.floor != null && a.floor !== b.floor) return false;
  const deals = new Set(a.prices.map((p) => p.deal));
  return b.prices.some((p) => deals.has(p.deal));
}
