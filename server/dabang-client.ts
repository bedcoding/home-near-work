import { regionBounds } from '../shared/region-geometry.js';
import type { Area } from '../shared/types.js';
import { parseDabangRoomList } from './dabang-parse.js';

export const DABANG_CATEGORIES = [
  { id: 'one-two', path: 'onetwo', label: '원·투룸' },
  { id: 'house-villa', path: 'house', label: '주택·빌라' },
  { id: 'officetel', path: 'officetel', label: '오피스텔' },
  { id: 'apt', path: 'apt', label: '아파트' },
] as const;
export type DabangCategory = typeof DABANG_CATEGORIES[number]['id'];
export interface DabangBounds { sw: { lat: number; lng: number }; ne: { lat: number; lng: number } }
// Public web client's protocol headers. No login, cookie or personal browser profile is used.
export const DABANG_HEADERS = {
  'D-Api-Version': '5.0.0', 'D-App-Version': '1', 'D-Call-Type': 'web',
  csrf: 'token', Accept: 'application/json', 'Content-Type': 'application/json',
};

/**
 * 조회 사각형. 구는 구 경계 전체를 덮는 사각형, 동과 지하철역은 설정 반경 원을 덮는 사각형이다.
 * 사이트가 좌표를 일부러 흐리게 주므로 여유를 두고, 주변 매물도 저장한다.
 */
export function dabangBounds(area: Pick<Area, 'lat' | 'lng' | 'radiusM' | 'region'>): DabangBounds | null {
  if (area.region?.kind === 'gu') {
    const bounds = regionBounds(area.region.code);
    if (!bounds) return null;
    const [west, south, east, north] = bounds;
    return { sw: { lat: south - .005, lng: west - .006 }, ne: { lat: north + .005, lng: east + .006 } };
  }
  if (![area.lat, area.lng, area.radiusM].every(Number.isFinite) || area.radiusM <= 0 || Math.abs(area.lat) > 90 || Math.abs(area.lng) > 180) return null;
  const dLat = area.radiusM / 111320 + .005;
  const dLng = area.radiusM / (111320 * Math.cos(area.lat * Math.PI / 180)) + .006;
  return { sw: { lat: area.lat - dLat, lng: area.lng - dLng }, ne: { lat: area.lat + dLat, lng: area.lng + dLng } };
}

const inside = (a: DabangBounds, b: DabangBounds) => a.sw.lat >= b.sw.lat && a.sw.lng >= b.sw.lng && a.ne.lat <= b.ne.lat && a.ne.lng <= b.ne.lng;

/**
 * 수집 지역마다 조회할 사각형. 구는 먼저, 이미 조회하는 구 사각형 안에 다 들어가는 동이나 지하철역은 건너뛴다(같은 범위를 두 번 받지 않게).
 * skipped: 건너뛴 지역과 그 지역을 덮는 구 이름
 */
export function dabangTargets<T extends Pick<Area, 'id' | 'name' | 'lat' | 'lng' | 'radiusM' | 'region'>>(areas: T[]) {
  const byKey = new Map<string, T>();
  for (const a of areas) { const key = a.region?.code ?? `area:${a.id}`; if (!byKey.has(key)) byKey.set(key, a); }
  const unique = [...byKey.values()]
    .sort((a, b) => Number(b.region?.kind === 'gu') - Number(a.region?.kind === 'gu'));
  const targets: { area: T; bounds: DabangBounds }[] = [];
  const skipped: { area: T; by: string }[] = [];
  const unreadable: T[] = [];
  for (const area of unique) {
    const bounds = dabangBounds(area);
    if (!bounds) { unreadable.push(area); continue; }
    const cover = targets.find((t) => t.area.region?.kind === 'gu' && inside(bounds, t.bounds));
    if (cover && area.region?.kind !== 'gu') skipped.push({ area, by: cover.area.name });
    else targets.push({ area, bounds });
  }
  return { targets, skipped, unreadable };
}

/** Same unbounded defaults as the public map, independently of notification and list filters. */
export function dabangFilters(category: DabangCategory) {
  const range = { min: 0, max: 999999 };
  const floors = ['GROUND_FIRST', 'GROUND_SECOND_OVER', 'SEMI_BASEMENT', 'ROOFTOP'];
  const common = {
    sellingTypeList: category === 'one-two' ? ['MONTHLY_RENT', 'LEASE'] : ['MONTHLY_RENT', 'LEASE', 'SELL'],
    depositRange: range, priceRange: range, isIncludeMaintenance: false, pyeongRange: range,
    useApprovalDateRange: range, dealTypeList: ['AGENT'], isShortLease: false,
  };
  if (category === 'one-two') return { ...common, roomFloorList: floors, roomTypeList: ['ONE_ROOM', 'TWO_ROOM'],
    canParking: false, hasElevator: false, hasPano: false, isDivision: false, isDuplex: false };
  const other = { ...common, tradeRange: range, roomCountList: ['ONE_ROOM', 'TWO_ROOM', 'THREE_ROOM', 'FOUR_ROOM'] };
  if (category === 'apt') return { ...other, householdNumRange: range, parkingNumRange: range, hasTakeTenant: false };
  return { ...other, canParking: false, hasElevator: false, hasPano: false,
    ...(category === 'house-villa' ? { roomFloorList: floors } : { parkingNumRange: range }) };
}

export function dabangListUrl(category: DabangCategory, bounds: DabangBounds, page: number): string {
  return `https://www.dabangapp.com/api/v5/room-list/category/${category}/bbox?${new URLSearchParams({
    filters: JSON.stringify(dabangFilters(category)), bbox: JSON.stringify(bounds), zoom: '13', useMap: 'naver', page: String(page),
  })}`;
}

/** Never infer completeness from the last visible page alone. */
export class DabangPagination {
  pages = 0;
  total: number | null = null;
  limit: number | null = null;
  readonly ids = new Set<string>();
  private signatures = new Set<string>();
  private issues = new Set<string>();
  private last = false;
  accept(body: string, requestedPage: number, category: DabangCategory) {
    let success = false;
    try { success = JSON.parse(body)?.code === 200; } catch { /* handled below */ }
    if (!success) throw new Error('사이트가 정상 목록 응답을 반환하지 않았습니다');
    const parsed = parseDabangRoomList(body, category);
    if (!parsed || parsed.page !== requestedPage || parsed.total === null || parsed.limit === null || parsed.hasMore === null)
      throw new Error('목록 페이지·총건수·마지막 페이지 정보를 확인하지 못했습니다');
    if (requestedPage !== this.pages + 1) throw new Error('페이지 순서가 이어지지 않습니다');
    if (this.total !== null && (this.total !== parsed.total || this.limit !== parsed.limit)) this.issues.add('조회 중 총건수 또는 페이지 크기가 바뀜');
    this.total ??= parsed.total;
    this.limit ??= parsed.limit;
    const pages = Math.max(1, Math.ceil(parsed.total / parsed.limit));
    if (pages > 2000 || requestedPage > 2000) throw new Error('페이지 한도를 넘어 조회 범위를 나누어야 합니다');
    const consistentLastPage = parsed.hasMore === (requestedPage < pages);
    if (!consistentLastPage) this.issues.add('마지막 페이지 표시와 총건수가 다름');
    if (parsed.unreadableRegular) this.issues.add('일부 매물의 번호·좌표를 읽지 못함');
    if (parsed.regularIds.length !== parsed.regularCount) this.issues.add('일부 매물 번호를 읽지 못함');
    const signature = [...parsed.regularIds].sort().join(',');
    const repeated = !!signature && this.signatures.has(signature);
    if (repeated) this.issues.add('같은 목록 페이지가 반복됨');
    this.signatures.add(signature);
    for (const id of parsed.regularIds) this.ids.add(id);
    this.pages += 1;
    this.last = !parsed.hasMore;
    return { parsed, more: parsed.hasMore && !repeated && consistentLastPage, totalPages: pages };
  }
  result() {
    if (!this.last) this.issues.add('마지막 페이지까지 확인하지 못함');
    if (this.total === null || this.ids.size !== this.total) this.issues.add(`표시 총건수 ${this.total ?? '?'}건과 실제 고유 매물 ${this.ids.size}건이 다름`);
    return { complete: this.issues.size === 0, reason: [...this.issues].join(' · ') || '모든 페이지와 고유 매물 번호 확인',
      pages: this.pages, totalPages: this.total !== null && this.limit ? Math.max(1, Math.ceil(this.total / this.limit)) : null,
      total: this.total, received: this.ids.size };
  }
}
