import { distanceM } from './geo.js';
import { pointInRegion } from './region-geometry.js';
import type { Area, AdministrativeRegion } from './types.js';

export type RegionalListing = { address?: string | null; dong?: string | null; legalDongCode?: string | null; lat?: number | null; lng?: number | null };
export type RegionRelation = 'selected' | 'surrounding' | 'unknown';

const aliases: Record<string, string> = { 서울: '서울특별시', 서울시: '서울특별시', 부산: '부산광역시', 부산시: '부산광역시', 인천: '인천광역시', 인천시: '인천광역시', 경기: '경기도' };
const tokens = (text: string) => text.normalize('NFC').replace(/[(),]/g, ' ').trim().split(/\s+/).map((token) => aliases[token] ?? token);
export const hasRegions = (areas: Area[]) => areas.some((area) => area.enabled !== false && !!area.region);
export function primaryAreas(areas: Area[]): Area[] {
  const enabled = areas.filter((area) => area.enabled !== false && area.purpose !== 'alert');
  return hasRegions(enabled) ? enabled.filter((area) => area.region) : enabled;
}

/** 켜진 구나 동(수집 대상) */
export const regionAreas = (areas: Area[]) => areas.filter((area) => area.enabled !== false && !!area.region && area.purpose !== 'alert');
/** 켜진 지하철역 반경(알림용 역 포함). 역 기준으로만 모으는 사이트가 쓴다. */
export const stationAreas = (areas: Area[]) => areas.filter((area) => area.enabled !== false && !area.region);

/**
 * 조회하기와 자동 확인이 모으는 지역: 켜진 구나 동과 켜진 지하철역 둘 다. 사이트마다 쓸 수 있는 쪽을 쓴다
 * (다방은 구 경계나 반경을 덮는 범위, 직방, 집토스, 피터팬은 역 기준). 목록에서 '수집 구·동 안'을 가리는 기준(primaryAreas)과는 따로다.
 */
export const collectionAreas = (areas: Area[]) => [...regionAreas(areas), ...stationAreas(areas)];

/** 구나 동과 지하철역이 하나 이상씩 켜져 있어야 모든 사이트가 모은다. 빠진 쪽을 돌려준다. */
export function missingAreaKinds(areas: Area[]): ('region' | 'station')[] {
  return [...(regionAreas(areas).length ? [] : ['region' as const]), ...(stationAreas(areas).length ? [] : ['station' as const])];
}

/**
 * 지역 하나를 끄거나 지운 뒤에도 구나 동과 지하철역이 하나 이상씩 남는지. 마지막 하나를 끄려 하면 그 이유를 돌려준다.
 * 이미 한쪽이 비어 있는 상태에서 다른 지역을 바꾸는 것은 막지 않는다(빈 쪽은 화면 경고로 알린다).
 */
export function lastAreaKindError(areas: Area[], areaId: number, next: { enabled?: boolean; deleted?: boolean }): string | null {
  const before = missingAreaKinds(areas);
  const after = missingAreaKinds(areas.flatMap((a) => a.id !== areaId ? [a] : next.deleted ? [] : [{ ...a, enabled: next.enabled ?? a.enabled }]));
  const lost = after.filter((kind) => !before.includes(kind));
  if (!lost.length) return null;
  return lost.includes('region')
    ? '마지막 구나 동은 끄거나 지울 수 없습니다. 구나 동과 지하철역을 하나 이상씩 켜 두어야 모든 사이트가 모읍니다. 다른 구나 동을 먼저 켜 주세요.'
    : '마지막 지하철역은 끄거나 지울 수 없습니다. 구나 동과 지하철역을 하나 이상씩 켜 두어야 직방, 집토스, 피터팬 같은 역 기준 사이트가 모읍니다. 다른 역을 먼저 켜 주세요.';
}

export function validRegion(value: unknown): value is AdministrativeRegion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const region = value as AdministrativeRegion;
  return ['gu', 'dong'].includes(region.kind) && typeof region.code === 'string' &&
    (region.kind === 'gu' ? /^[1-9]\d{4}$/ : /^[1-9]\d{9}$/).test(region.code) &&
    (region.kind === 'gu' ? region.dong === null : typeof region.dong === 'string' && !!region.dong.trim() && region.dong.length <= 160 && !/[\u0000-\u001f<>]/.test(region.dong)) &&
    ['sido', 'sigungu', 'name'].every((key) => typeof region[key as 'sido' | 'sigungu' | 'name'] === 'string' &&
      region[key as 'sido' | 'sigungu' | 'name'].trim().length > 0 && region[key as 'sido' | 'sigungu' | 'name'].length <= 160 && !/[\u0000-\u001f<>]/.test(region[key as 'sido' | 'sigungu' | 'name']));
}

/**
 * 매물과 구(또는 동)를 견준 결과를 매물 객체마다 기억한다. 화면은 매물이 바뀔 때마다 수만 건을 지역마다 다시 견주는데
 * (지역 칸 건수, 고른 지역 필터, 카드의 지역 이름), 주소를 낱말로 나누고 구 경계 안인지 보는 일이 무거워서다.
 * 판정에 쓰는 칸(법정동코드, 주소, 좌표, 동)이 바뀌면 기억을 버리고 다시 낸다.
 */
interface RegionMemo { legalDongCode: unknown; address: unknown; lat: unknown; lng: unknown; dong: unknown; hits: Map<string, boolean> }
const regionMemo = new WeakMap<object, RegionMemo>();
const regionKey = (region: AdministrativeRegion) => `${region.kind}|${region.code}|${region.sido}|${region.sigungu}|${region.dong ?? ''}`;

/** Full jurisdiction is required: a same-named dong in another city must not match. */
export function matchesRegion(listing: RegionalListing, region: AdministrativeRegion): boolean {
  let memo = regionMemo.get(listing);
  if (!memo || memo.legalDongCode !== listing.legalDongCode || memo.address !== listing.address || memo.lat !== listing.lat || memo.lng !== listing.lng || memo.dong !== listing.dong) {
    memo = { legalDongCode: listing.legalDongCode, address: listing.address, lat: listing.lat, lng: listing.lng, dong: listing.dong, hits: new Map() };
    regionMemo.set(listing, memo);
  }
  const key = regionKey(region);
  let hit = memo.hits.get(key);
  if (hit === undefined) {
    hit = judgeRegion(listing, region);
    memo.hits.set(key, hit);
  }
  return hit;
}

function judgeRegion(listing: RegionalListing, region: AdministrativeRegion): boolean {
  if (listing.legalDongCode && /^[1-9]\d{9}$/.test(listing.legalDongCode)) return region.kind === 'gu' ? listing.legalDongCode.startsWith(region.code) : listing.legalDongCode === region.code;
  const address = tokens(listing.address ?? '');
  const jurisdiction = [...tokens(region.sido), ...tokens(region.sigungu)];
  // Explicit address jurisdictions take precedence over approximate site coordinates.
  const city = address.find((part) => /(?:특별시|광역시|특별자치시|특별자치도|도)$/.test(part));
  const gu = address.find((part) => /(?:구|군|시)$/.test(part) && !/(?:특별시|광역시|특별자치시)$/.test(part));
  if (city && city !== region.sido || gu && !tokens(region.sigungu).includes(gu)) return false;
  if (!jurisdiction.every((part) => address.includes(part)) && listing.lat != null && listing.lng != null) {
    return pointInRegion(region.code, listing.lat, listing.lng) && (region.kind === 'gu' || listing.dong === region.dong);
  }
  return jurisdiction.every((part) => address.includes(part)) &&
    (region.kind === 'gu' || !!region.dong && (address.includes(region.dong) || listing.dong?.trim().normalize('NFC') === region.dong));
}

export function areaMatches(listing: RegionalListing, area: Area, marginM = 0): boolean {
  if (area.region) return matchesRegion(listing, area.region);
  return listing.lat != null && listing.lng != null && Number.isFinite(listing.lat) && Number.isFinite(listing.lng) &&
    distanceM(area.lat, area.lng, listing.lat, listing.lng) <= area.radiusM + marginM;
}

export function selectedArea(listing: RegionalListing, areas: Area[], marginM = 0): Area | null {
  return primaryAreas(areas).find((area) => areaMatches(listing, area, marginM)) ?? null;
}

export function regionRelation(listing: RegionalListing, areas: Area[]): RegionRelation {
  if (selectedArea(listing, areas)) return 'selected';
  if (hasRegions(areas)) {
    const address = tokens(listing.address ?? '');
    const hasJurisdiction = address.some((part) => /(?:특별시|광역시|특별자치시|특별자치도|도)$/.test(part)) &&
      (address.some((part) => /(?:시|군|구)$/.test(part) && !/(?:특별시|광역시|특별자치시)$/.test(part)) || address.includes('세종특별자치시'));
    return listing.legalDongCode && /^[1-9]\d{9}$/.test(listing.legalDongCode) || hasJurisdiction ? 'surrounding' : 'unknown';
  }
  return listing.lat == null || listing.lng == null ? 'unknown' : 'surrounding';
}
