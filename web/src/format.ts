import type { Area, ListingView } from '../../shared/types';
import { money } from '../../shared/format';
import { distanceM } from '../../shared/geo';

export { floorText, money, priceAmount, priceText } from '../../shared/format';

export const M2_PER_PYEONG = 3.3058;

export const pyeong = (m2: number) => (m2 / M2_PER_PYEONG).toFixed(1);

/** 만원 단위 금액에 '만'을 붙인다: 2150 → '2,150만', 10200 → '1억 200만', 10000 → '1억', 0 → '0'. */
export const manwon = (v: number) => `${money(v)}${v % 10000 ? '만' : ''}`;

/** 전용 1평당 가격(만원). 첫 가격이 매매, 경매, 전세일 때 그 금액 ÷ 전용 평수, 월세나 단기이거나 금액이나 면적을 모르면 null. */
export function perPyeong(l: Pick<ListingView, 'prices' | 'areaM2'>): number | null {
  const p = l.prices[0];
  if (!p || !l.areaM2) return null;
  const amount = p.deal === 'jeonse' ? p.deposit : p.deal === 'sale' || p.deal === 'auction' ? p.price : null;
  return amount ? Math.round(amount / (l.areaM2 / M2_PER_PYEONG)) : null;
}

/** 전용 평수(소수 둘째 자리까지, 평당 계산 설명용). */
export const pyeongExact = (m2: number) => (m2 / M2_PER_PYEONG).toFixed(2);

export function ago(iso: string | null): string {
  if (!iso) return '?';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 30) return `${days}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR');
}

export function dateTime(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 지역 반경: 1000 → '1km', 1500 → '1.5km', 800 → '800m'. */
export const radiusText = (m: number) => (m >= 1000 ? `${m / 1000}km` : `${m}m`);

export function distanceText(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`;
}

export { distanceM };

/** 켜진 지역 중 가장 가까운 곳과 거리. */
export function nearest(l: ListingView, areas: Area[]): { area: Area; distance: number } | null {
  if (l.lat == null || l.lng == null) return null;
  let best: { area: Area; distance: number } | null = null;
  for (const area of areas) {
    const distance = distanceM(area.lat, area.lng, l.lat, l.lng);
    if (!best || distance < best.distance) best = { area, distance };
  }
  return best;
}
