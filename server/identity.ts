import { distanceM } from './geo.js';
import type { NormalizedListing, PriceChangeType, PriceOption } from '../shared/types.js';

const dealSet = (l: NormalizedListing) => [...new Set(l.prices.map((p) => p.deal))].sort().join('+') || '?';

/**
 * '같은 집 키'. 매물번호는 중개사가 다시 올리면 바뀌므로, 재등록해도 잘 바뀌지 않는 값으로 만든다.
 * 사이트 안의 건물 식별값 + 층 + 전용면적 + 거래유형. 가격은 넣지 않는다(가격이 바뀌면 '가격 변동'으로 잡는다).
 */
export function identityKey(l: NormalizedListing): string {
  const building =
    l.buildingKey ?? (l.lat != null && l.lng != null ? `geo:${l.lat.toFixed(4)},${l.lng.toFixed(4)}` : `addr:${l.address ?? '?'}`);
  const floor = l.basement ? 'B' : (l.floor ?? '?');
  const area = l.areaM2 != null ? Math.round(l.areaM2) : '?';
  return `${l.source}|${building}|${floor}|${area}|${dealSet(l)}`;
}

/**
 * 버림한 매물과 '비슷한지'. 사이트가 달라도 위치, 층, 면적이 거의 같으면 true.
 * 자동으로 숨기지 않고 배지만 붙이는 데 쓴다.
 */
export function looksSimilar(a: NormalizedListing, b: NormalizedListing): boolean {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return false;
  if (distanceM(a.lat, a.lng, b.lat, b.lng) > 30) return false;
  if (a.areaM2 == null || b.areaM2 == null || Math.abs(a.areaM2 - b.areaM2) > 1.5) return false;
  if (a.basement !== b.basement) return false;
  if (a.floor != null && b.floor != null && a.floor !== b.floor) return false;
  const deals = new Set(a.prices.map((p) => p.deal));
  return b.prices.some((p) => deals.has(p.deal));
}

export function priceSignature(prices: PriceOption[]): string {
  return JSON.stringify(
    [...prices]
      .map((p) => [p.deal, p.deposit ?? null, p.monthly ?? null, p.price ?? null])
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
  );
}

/** 거래유형별로 짝을 지어 비교한다. 모두 내리면 인하, 모두 올리면 인상, 섞이면 변동. */
export function comparePrices(before: PriceOption[], after: PriceOption[]): PriceChangeType | null {
  if (priceSignature(before) === priceSignature(after)) return null;
  let down = false;
  let up = false;
  for (const next of after) {
    const prev = before.find((p) => p.deal === next.deal);
    if (!prev) continue;
    for (const key of ['deposit', 'monthly', 'price'] as const) {
      const a = prev[key];
      const b = next[key];
      if (a == null || b == null || a === b) continue;
      if (b < a) down = true;
      else up = true;
    }
  }
  if (down && !up) return 'price_down';
  if (up && !down) return 'price_up';
  return 'price_changed';
}
