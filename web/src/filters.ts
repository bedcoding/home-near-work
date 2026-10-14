import type { Area, DealType, ListingView, PriceOption } from '../../shared/types';
import { distanceM } from './format';
import { KINDS, kindOf, type Kind } from './kinds';

/** 1차 필터. 화면에서만 숨긴다. 금액은 만원, 면적은 ㎡. 정보가 없는 매물은 가리지 않는다. */
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

const KEY = 'hnw-filters-v1';

/** 저장된 필터를 읽는다. 지금 필터에 없는 항목과 값은 버린다. 목록 값은 새 배열로 만든다(기본값 배열을 같이 쓰지 않게). */
export function loadFilters(): Filters {
  let f: Filters = { ...DEFAULT_FILTERS };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? {};
    const known = Object.fromEntries(Object.keys(DEFAULT_FILTERS).filter((k) => k in saved).map((k) => [k, saved[k]]));
    f = { ...DEFAULT_FILTERS, ...known };
  } catch {
    /* 저장된 값을 못 읽으면 기본값 */
  }
  return { ...f, deals: f.deals.filter((d) => FILTER_DEALS.includes(d)), areaIds: [...f.areaIds], kinds: f.kinds.filter((k) => KINDS.includes(k)) };
}

export function saveFilters(f: Filters) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* 저장이 막혀도 필터는 동작한다 */
  }
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
export function dealOptions(l: ListingView, deal: DealType, f: Filters, areas: Area[]): PriceOption[] {
  if (!passes(l, { ...f, deals: [deal] }, areas)) return [];
  return l.prices.filter((p) => p.deal === deal && priceOk(p, f));
}

/** 옵션이 없다고 알려진 집: 풀옵션 표시가 없고, 사이트가 준 옵션 목록이 비었거나 글에 '무옵션'이 있다. */
export const isNoOption = (l: Pick<ListingView, 'options'>) => !!l.options && !l.options.full && l.options.list?.length === 0;

export function passes(l: ListingView, f: Filters, areas: Area[]): boolean {
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
