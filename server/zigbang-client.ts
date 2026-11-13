import { distanceM } from '../shared/geo.js';
import { pointInRegion, regionBounds } from '../shared/region-geometry.js';
import type { Area, CollectionPriceLimits, PriceOption } from '../shared/types.js';
import { parseZigbangItemRows } from './zigbang-parse.js';

/** 직방 공개 웹 클라이언트가 붙이는 헤더. 로그인, 쿠키, 개인 브라우저 정보는 쓰지 않는다. */
export const ZIGBANG_HEADERS = { 'X-Zigbang-Platform': 'www', Accept: 'application/json' };
export const ZIGBANG_API = 'https://apis.zigbang.com';
export const ZIGBANG_SUBWAYS_URL = `${ZIGBANG_API}/common/subway/all`;
export const ZIGBANG_DETAILS_URL = `${ZIGBANG_API}/house/property/v1/items/list`;
/** 직방 화면도 상세를 15개씩 나눠 받는다. */
export const ZIGBANG_DETAIL_PAGE = 15;
/** 역 1km. 확장의 역별 순회와 같은 범위다. */
export const ZIGBANG_RADIUS_KM = 1;
/** 한 지역에서 도는 역 수 상한. 넘으면 지역 가운데에서 가까운 역부터 돈다. */
export const ZIGBANG_MAX_STATIONS = 40;
const MAX_IDS = 20_000;
/** 역, 조건마다 마지막에 본 역 1km 방 번호(설정). 확장 저장과 자동조회가 함께 쓴다. */
export const ZIGBANG_STATION_IDS_KEY = 'zigbang_station_ids';

export interface ZigbangStationPlace { id: string; name: string; lat: number; lng: number }

const STATION_DEAL_LABELS = { monthly: '월세', short: '단기', jeonse: '전세', sale: '매매' } as const;
type StationDeal = keyof typeof STATION_DEAL_LABELS;

export interface ZigbangPriceScope {
  suffix: string;
  label: string;
  deals: readonly StationDeal[] | null;
  saleMax: number | null;
  depositMax: number | null;
  rentMax: number | null;
}

/** 전세금과 월세 보증금이 같은 조회 필드를 쓰므로 상한이 다를 때 목록을 나눈다. */
export function zigbangPriceScopes(limits?: CollectionPriceLimits, rentalOnly = false): (ZigbangPriceScope | null)[] {
  if (!limits && !rentalOnly) return [null];
  const excludeSale = rentalOnly || !!limits?.excludeSale;
  const jeonseMax = limits?.jeonseMax ?? null;
  const monthlyDepositMax = limits?.monthlyDepositMax ?? null;
  const monthlyMax = limits?.monthlyMax ?? null;
  const saleMax = excludeSale ? null : limits?.saleMax ?? null;
  const monthlyDeals: StationDeal[] = rentalOnly ? ['monthly'] : ['monthly', 'short'];
  if (jeonseMax === monthlyDepositMax) {
    return [{ suffix: rentalOnly ? '-rent' : '-price', label: rentalOnly ? '전세와 월세' : '가격 조건',
      deals: excludeSale ? [...monthlyDeals, 'jeonse'] : null,
      saleMax, depositMax: jeonseMax, rentMax: monthlyMax }];
  }
  const otherDeals: StationDeal[] = excludeSale ? monthlyDeals : [...monthlyDeals, 'sale'];
  return [
    { suffix: '-monthly', label: otherDeals.map(deal => STATION_DEAL_LABELS[deal]).join(', '),
      deals: otherDeals, saleMax, depositMax: monthlyDepositMax, rentMax: monthlyMax },
    { suffix: '-jeonse', label: '전세', deals: ['jeonse'], saleMax: null, depositMax: jeonseMax, rentMax: null },
  ];
}

export function zigbangPricesMatch(prices: readonly PriceOption[], limits?: CollectionPriceLimits, scope?: ZigbangPriceScope, rentalOnly = false): boolean {
  const within = (amount: number | null, max: number | null) => max === null || (amount !== null && amount >= 0 && amount <= max);
  return prices.some(({ deal, deposit, monthly, price }) => {
    if (scope?.deals && !scope.deals.some(type => type === deal)) return false;
    if (rentalOnly && deal !== 'monthly' && deal !== 'jeonse') return false;
    if (deal === 'monthly' || deal === 'short') return within(deposit, limits?.monthlyDepositMax ?? null) && within(monthly, limits?.monthlyMax ?? null);
    if (deal === 'jeonse') return within(deposit, limits?.jeonseMax ?? null);
    return deal === 'sale' && !limits?.excludeSale && within(price, limits?.saleMax ?? null);
  });
}

/** 역 1km 원룸 번호 목록. 거래 유형 배열은 공개 웹 클라이언트와 같은 인덱스 표기를 사용한다. */
export function zigbangStationListUrl(stationId: string, scope?: ZigbangPriceScope | null): string {
  if (!/^[1-9]\d{0,19}$/.test(stationId)) throw new Error('직방 역 번호가 올바르지 않습니다');
  const params = new URLSearchParams({ radius: String(ZIGBANG_RADIUS_KM), depositMin: '0', rentMin: '0' });
  if (scope) {
    scope.deals?.forEach((deal, index) => params.append(`salesTypes[${index}]`, STATION_DEAL_LABELS[deal]));
    if (scope.saleMax !== null) params.set('salesPriceMax', String(scope.saleMax));
    if (scope.depositMax !== null) params.set('depositMax', String(scope.depositMax));
    if (scope.rentMax !== null) params.set('rentMax', String(scope.rentMax));
  }
  return `${ZIGBANG_API}/house/property/v1/items/subways/${stationId}/onerooms?${params}`;
}

/** 원본 열기에 쓰는 직방 역 화면 주소 */
export const zigbangStationPage = (stationId: string) => `https://www.zigbang.com/home/oneroom/subways/${stationId}/items`;

/**
 * 지역 하나에서 돌 직방 역. 구: 구 경계 안에 있는 역. 동과 반경 지역: 역 1km가 지역 반경과 겹치는 역,
 * 없으면 2km 안 가장 가까운 역(확장 예약 순회와 같은 기준). 가까운 역부터, 많으면 상한까지만.
 */
export function zigbangStationsFor(area: Pick<Area, 'lat' | 'lng' | 'radiusM' | 'region'>, stations: ZigbangStationPlace[]):
  { stations: ZigbangStationPlace[]; skipped: number } {
  const valid = stations.filter((s) => /^[1-9]\d{0,19}$/.test(s.id) && Number.isFinite(s.lat) && Number.isFinite(s.lng));
  const withDistance = valid.map((station) => ({ station, d: distanceM(area.lat, area.lng, station.lat, station.lng) }))
    .sort((a, b) => a.d - b.d || a.station.id.localeCompare(b.station.id));
  let chosen = area.region?.kind === 'gu'
    ? withDistance.filter(({ station }) => pointInRegion(area.region!.code, station.lat, station.lng))
    : withDistance.filter(({ d }) => d <= area.radiusM + ZIGBANG_RADIUS_KM * 1000);
  if (!chosen.length && area.region?.kind !== 'gu') chosen = withDistance.filter(({ d }) => d <= 2000).slice(0, 1);
  const unique = [...new Map(chosen.map(({ station }) => [station.id, station])).values()];
  return { stations: unique.slice(0, ZIGBANG_MAX_STATIONS), skipped: Math.max(0, unique.length - ZIGBANG_MAX_STATIONS) };
}

/**
 * 고른 역들의 1km 원이 지역을 얼마나 덮는지(면적 비율, 0~100). 구는 구 경계, 동과 반경 지역은 설정 반경의 원을 기준으로
 * 약 200m 간격 격자로 센다. 매물이 아니라 면적 기준이라 산과 공원도 들어간다. 셀 수 없으면 null.
 */
export function zigbangAreaCoverage(area: Pick<Area, 'lat' | 'lng' | 'radiusM' | 'region'>, stations: ZigbangStationPlace[]):
  { stations: number; percent: number | null } {
  const chosen = zigbangStationsFor(area, stations).stations;
  const gu = area.region?.kind === 'gu' ? area.region.code : null;
  const bounds = gu ? regionBounds(gu) : null;
  const latStep = 0.0018, lngStep = 0.0023;
  const [west, south, east, north] = bounds ?? [
    area.lng - area.radiusM / (111320 * Math.cos(area.lat * Math.PI / 180)), area.lat - area.radiusM / 111320,
    area.lng + area.radiusM / (111320 * Math.cos(area.lat * Math.PI / 180)), area.lat + area.radiusM / 111320,
  ];
  if (![west, south, east, north].every(Number.isFinite) || (gu && !bounds)) return { stations: chosen.length, percent: null };
  let inside = 0, covered = 0;
  for (let lat = south + latStep / 2; lat < north; lat += latStep) {
    for (let lng = west + lngStep / 2; lng < east; lng += lngStep) {
      if (gu ? !pointInRegion(gu, lat, lng) : distanceM(area.lat, area.lng, lat, lng) > area.radiusM) continue;
      inside++;
      if (chosen.some((s) => distanceM(lat, lng, s.lat, s.lng) <= ZIGBANG_RADIUS_KM * 1000)) covered++;
    }
  }
  return { stations: chosen.length, percent: inside ? Math.round(covered / inside * 100) : null };
}

/** 역 번호 목록 응답 → 방 번호(중복, 이상한 값이 있으면 null) */
export function readZigbangStationIds(body: string): number[] | null {
  try {
    const items = JSON.parse(body)?.items;
    if (!Array.isArray(items) || items.length > MAX_IDS || items.some((x) => !Number.isSafeInteger(x?.id) || x.id <= 0)) return null;
    const ids = items.map((x: { id: number }) => x.id);
    return new Set(ids).size === ids.length ? ids : null;
  } catch { return null; }
}

/** 번호 목록을 상세 요청 묶음으로 */
export function zigbangDetailChunks(ids: number[]): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += ZIGBANG_DETAIL_PAGE) chunks.push(ids.slice(i, i + ZIGBANG_DETAIL_PAGE));
  return chunks;
}

/**
 * 역 하나의 확인 기록. 번호 목록의 모든 번호가 읽을 수 있는 상세로 돌아와야 완료다.
 * 목록에 없는 번호의 상세는 저장은 하되 완료 증거로 세지 않는다.
 */
export class ZigbangStationLedger {
  expected: number[] | null = null;
  pages = 0;
  readonly received = new Set<string>();
  readonly unreadable = new Set<string>();
  private issue = '';

  acceptList(body: string): number[] | null {
    const ids = readZigbangStationIds(body);
    if (!ids) { this.fail('번호 목록을 읽지 못함'); return null; }
    this.expected = ids;
    return ids;
  }

  acceptDetails(body: string, requested: number[]) {
    const parsed = parseZigbangItemRows(body);
    if (!parsed.valid) { this.fail('상세 응답을 읽지 못함'); return parsed.items; }
    this.pages += 1;
    const asked = new Set(requested.map(String));
    for (const id of parsed.unreadableIds) if (asked.has(id)) this.unreadable.add(id);
    for (const { listing } of parsed.items) if (asked.has(listing.sourceId)) this.received.add(listing.sourceId);
    return parsed.items;
  }

  fail(reason: string) { this.issue ||= reason; }

  result() {
    const expected = this.expected?.map(String) ?? [];
    const received = expected.filter((id) => this.received.has(id)).length;
    const unreadable = expected.filter((id) => !this.received.has(id) && this.unreadable.has(id)).length;
    const missing = expected.length - received - unreadable;
    const reason = this.issue || (this.expected == null ? '번호 목록 없음'
      : unreadable ? `상세 읽기 실패 ${unreadable}건` : missing ? `상세 미수신 ${missing}건` : '역 1km 번호 목록 전체 확인');
    return {
      total: this.expected?.length ?? null,
      totalPages: this.expected ? Math.ceil(this.expected.length / ZIGBANG_DETAIL_PAGE) : null,
      pages: this.pages, received, complete: !this.issue && this.expected != null && received === expected.length, reason,
    };
  }
}
