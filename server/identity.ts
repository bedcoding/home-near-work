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

/** 버림한 매물과 '비슷한지'. 화면도 같은 판정을 써야 해서 공통 모듈로 옮겼다. */
export { looksSimilar } from '../shared/similar.js';

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
