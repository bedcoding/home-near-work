import { manwon } from './format.js';
import { distanceM } from './geo.js';
import { KINDS, KIND_LABEL, kindOf, type Kind } from './kinds.js';
import type { Area, DealType, ListingView, NormalizedListing, PriceOption } from './types.js';

// 매물 탭의 1차 필터. 화면은 매물을 가리는 데, 서버는 같은 조건으로 알림 매물을 고르는 데 쓴다.
// 금액은 만원, 면적은 ㎡. 정보가 없는 매물은 가리지 않는다(무옵션만은 예외).

export interface Filters {
  deals: DealType[];
  /** 매물 유형(비어 있으면 전체) */
  kinds: Kind[];
  depositMin: number | null;
  depositMax: number | null;
  monthlyMin: number | null;
  monthlyMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  areaMin: number | null;
  areaMax: number | null;
  distanceMax: number | null;
  /** 볼 지역(켜진 지역 중 고른 것의 번호). 비어 있으면 켜진 지역 전체. */
  areaIds: number[];
  insideAreas: boolean;
  excludeBasement: boolean;
  excludeFirstFloor: boolean;
  excludeRooftop: boolean;
  /** 무옵션만: 옵션(가전, 가구)이 없다고 알려진 집만 보인다(옵션을 모르는 집도 가린다). 매매와 전월세 매물에만 쓴다. */
  noOptionsOnly: boolean;
  text: string;
}

export const DEFAULT_FILTERS: Filters = {
  deals: [],
  kinds: [],
  depositMin: null,
  depositMax: null,
  monthlyMin: null,
  monthlyMax: null,
  priceMin: null,
  priceMax: null,
  areaMin: null,
  areaMax: null,
  distanceMax: null,
  areaIds: [],
  insideAreas: true,
  excludeBasement: false,
  excludeFirstFloor: false,
  excludeRooftop: false,
  noOptionsOnly: false,
  text: '',
};

/** 필터 '거래 유형' 칸에서 고르는 것. 경매는 경매 탭이 따로 보여 준다. */
export const FILTER_DEALS: DealType[] = ['monthly', 'jeonse', 'sale', 'short'];

/** 필터가 보는 매물 칸: 화면의 ListingView, 서버는 저장된 매물에 옵션 정보를 붙인 것 */
export type FilterTarget = Pick<
  NormalizedListing,
  'prices' | 'buildingType' | 'areaM2' | 'basement' | 'rooftop' | 'floor' | 'lat' | 'lng' | 'title' | 'address' | 'dong' | 'roomLabel'
> &
  Pick<ListingView, 'options'>;

/**
 * 저장된 필터 값을 지금 필터 모양으로 맞춘다. 모르는 항목과 맞지 않는 값은 버리고 기본값을 쓴다.
 * 목록 값은 새 배열로 만든다(기본값 배열을 같이 쓰지 않게).
 */
export function normalizeFilters(saved: unknown): Filters {
  const o = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const amount = (key: keyof Filters) => {
    const v = o[key];
    return v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : (DEFAULT_FILTERS[key] as number | null);
  };
  const flag = (key: keyof Filters) => (typeof o[key] === 'boolean' ? (o[key] as boolean) : (DEFAULT_FILTERS[key] as boolean));
  const list = (key: keyof Filters) => (Array.isArray(o[key]) ? (o[key] as unknown[]) : []);
  return {
    deals: list('deals').filter((d): d is DealType => FILTER_DEALS.includes(d as DealType)),
    kinds: list('kinds').filter((k): k is Kind => KINDS.includes(k as Kind)),
    depositMin: amount('depositMin'),
    depositMax: amount('depositMax'),
    monthlyMin: amount('monthlyMin'),
    monthlyMax: amount('monthlyMax'),
    priceMin: amount('priceMin'),
    priceMax: amount('priceMax'),
    areaMin: amount('areaMin'),
    areaMax: amount('areaMax'),
    distanceMax: amount('distanceMax'),
    areaIds: list('areaIds').filter((id): id is number => Number.isInteger(id)),
    insideAreas: flag('insideAreas'),
    excludeBasement: flag('excludeBasement'),
    excludeFirstFloor: flag('excludeFirstFloor'),
    excludeRooftop: flag('excludeRooftop'),
    noOptionsOnly: flag('noOptionsOnly'),
    text: typeof o.text === 'string' ? o.text.slice(0, 200) : '',
  };
}

/** 범위 안인지. 값이 없으면 통과한다. */
function inRange(value: number | null, min: number | null, max: number | null) {
  if (value == null) return true;
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

function priceOk(p: PriceOption, f: Filters) {
  if (p.deal === 'monthly' || p.deal === 'short') return inRange(p.deposit, f.depositMin, f.depositMax) && inRange(p.monthly, f.monthlyMin, f.monthlyMax);
  if (p.deal === 'jeonse') return inRange(p.deposit, f.depositMin, f.depositMax);
  return inRange(p.price, f.priceMin, f.priceMax);
}

/**
 * 매물 탭: 그 거래 유형으로 봤을 때 필터를 통과한 가격 선택지. 통과하지 못하면 빈 배열.
 * 거래 유형 체크는 매물 탭의 거래 유형 탭이 대신하므로 여기서는 보지 않는다.
 */
export function dealOptions(l: FilterTarget, deal: DealType, f: Filters, areas: Area[]): PriceOption[] {
  if (!passes(l, { ...f, deals: [deal] }, areas)) return [];
  return l.prices.filter((p) => p.deal === deal && priceOk(p, f));
}

/** 옵션이 없다고 알려진 집: 풀옵션 표시가 없고, 사이트가 준 옵션 목록이 비었거나 글에 '무옵션'이 있다. */
export const isNoOption = (l: Pick<ListingView, 'options'>) => !!l.options && !l.options.full && l.options.list?.length === 0;

export function passes(l: FilterTarget, f: Filters, areas: Area[]): boolean {
  const options = l.prices.filter((p) => f.deals.length === 0 || f.deals.includes(p.deal));
  if (!options.some((p) => priceOk(p, f))) return false;
  if (f.kinds.length && !f.kinds.includes(kindOf(l))) return false;
  if (!inRange(l.areaM2, f.areaMin, f.areaMax)) return false;
  if (f.excludeBasement && l.basement) return false;
  if (f.excludeRooftop && l.rooftop) return false;
  if (f.excludeFirstFloor && l.floor === 1 && !l.basement) return false;
  if (f.noOptionsOnly && !isNoOption(l)) return false;

  // 고른 지역(없거나 모두 꺼졌으면 켜진 지역 전체)
  const picked = areas.filter((a) => f.areaIds.includes(a.id));
  const chosen = picked.length ? picked : areas;
  if ((f.insideAreas || f.distanceMax != null || picked.length) && l.lat != null && l.lng != null) {
    const distances = areas.map((a) => ({ a, d: distanceM(a.lat, a.lng, l.lat!, l.lng!) }));
    const mine = distances.filter(({ a }) => chosen.includes(a));
    if (f.insideAreas && !mine.some(({ a, d }) => d <= a.radiusM)) return false;
    // 반경 밖도 볼 때는 가장 가까운 지역이 고른 지역인 매물만 보인다.
    if (!f.insideAreas && picked.length) {
      const closest = distances.reduce((x, y) => (y.d < x.d ? y : x), distances[0]);
      if (closest && !chosen.includes(closest.a)) return false;
    }
    if (f.distanceMax != null && !mine.some(({ d }) => d <= f.distanceMax!)) return false;
  }

  if (f.text.trim()) {
    const hay = [l.title, l.address, l.dong, l.buildingType, l.roomLabel].join(' ').toLowerCase();
    if (!hay.includes(f.text.trim().toLowerCase())) return false;
  }
  return true;
}

const M2_PER_PYEONG = 3.3058;
const pyeong = (m2: number) => Math.round((m2 / M2_PER_PYEONG) * 10) / 10;

/** '월세 30만~50만', '보증금 1억 이하', '매매가 3억 이상'. 둘 다 없으면 null. */
export function rangeText(label: string, min: number | null, max: number | null, unit: (v: number) => string): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${label} ${unit(min)}~${unit(max)}`;
  return max != null ? `${label} ${unit(max)} 이하` : `${label} ${unit(min!)} 이상`;
}

/**
 * 필터 조건을 짧은 글 조각으로(거래 유형 칸은 뺌). prices가 false면 금액 칸도 뺀다. areas는 고른 지역 이름을 찾는 데 쓴다.
 * 예: ['역삼역만', '보증금 1억 이하', '월세 50만 이하', '10~20평', '빌라와 주택, 오피스텔', '반지하 빼기']
 */
export function filterSummary(f: Filters, areas: Pick<Area, 'id' | 'name' | 'enabled'>[], prices = true): string[] {
  const picked = areas.filter((a) => a.enabled && f.areaIds.includes(a.id)).map((a) => a.name);
  const area = rangeText('', f.areaMin, f.areaMax, (v) => `${pyeong(v)}평`)?.trim() ?? null;
  return [
    picked.length ? `${picked.join(', ')}만` : null,
    f.insideAreas ? null : '반경 밖 포함',
    f.distanceMax != null ? `역까지 ${f.distanceMax}m` : null,
    ...(prices
      ? [rangeText('보증금', f.depositMin, f.depositMax, manwon), rangeText('월세', f.monthlyMin, f.monthlyMax, manwon), rangeText('매매가', f.priceMin, f.priceMax, manwon)]
      : []),
    area,
    f.kinds.length ? f.kinds.map((k) => KIND_LABEL[k]).join(', ') : null,
    f.excludeBasement ? '반지하 빼기' : null,
    f.excludeFirstFloor ? '1층 빼기' : null,
    f.excludeRooftop ? '옥탑 빼기' : null,
    f.noOptionsOnly ? '무옵션만' : null,
    f.text.trim() ? `"${f.text.trim()}"` : null,
  ].filter((x): x is string => !!x);
}
