import { distanceM } from './geo.js';
import type { AlertLimits, Area } from './types.js';
import type { RegionalListing } from './regions.js';

export const alertAreas = (areas: Area[]) => areas.filter((a) => a.enabled !== false && !a.region && a.purpose !== 'collection');
export function withinAlertArea(listing: RegionalListing, area: Area): boolean {
  return listing.lat != null && listing.lng != null && Number.isFinite(listing.lat) && Number.isFinite(listing.lng) &&
    distanceM(area.lat, area.lng, listing.lat, listing.lng) <= area.radiusM;
}
export const matchingAlertAreas = (listing: RegionalListing, areas: Area[]) => alertAreas(areas).filter((a) => withinAlertArea(listing, a));
export function normalizeAlertLimits(value: unknown): AlertLimits | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('역별 알림 금액이 올바르지 않습니다.');
  const input = value as Record<string, unknown>;
  const limits = { monthlyMax: null, depositMax: null, priceMax: null } as AlertLimits;
  for (const key of Object.keys(limits) as (keyof AlertLimits)[]) {
    const v = input[key];
    if (v == null || v === '') continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > 100_000_000) throw new Error('알림 금액은 만원 단위 양의 정수로 적어 주세요.');
    limits[key] = v;
  }
  return limits;
}
