import type { CollectionPriceLimits, PriceOption } from '../shared/types.js';
import { DAANGN_HOME_SALES_TYPES } from './daangn-parse.js';

// 당근 지도 주소의 af 조건에 거래 종류와 금액 상한을 넣는다. 금액은 만원.
// 주소 하나에는 보증금 범위가 하나뿐이라, 상한이 걸린 거래 종류는 종류별로 지도를 따로 연다.

/** 목록 조건에 넣는 거래 종류. 연세(YEAR)는 받지 않는다. */
type DaangnTrade = 'MONTH' | 'SHORT' | 'BORROW' | 'BUY';

/** 가격 조건이 있을 때 지도 목록을 나눠 여는 한 묶음 */
export interface DaangnPriceView {
  /** 조회 범위 기록과 스크린샷 이름에 붙이는 꼬리 */
  suffix: string;
  label: string;
  tradeTypes: readonly DaangnTrade[];
  monthlyMax: number | null;
  depositMax: number | null;
  saleMax: number | null;
}

/**
 * 가격 조건에 맞춰 열 지도 목록들. 조건이 없으면 [null](거래 종류를 가리지 않는 목록 하나).
 * 월세 보증금과 전세금이 같은 조건 칸을 쓰므로 상한이 걸린 종류는 따로 열고, 상한이 없는 종류끼리는 한 목록으로 묶는다.
 */
export function daangnPriceViews(limits?: CollectionPriceLimits, rentalOnly = false): (DaangnPriceView | null)[] {
  if (!limits && !rentalOnly) return [null];
  const excludeSale = rentalOnly || !!limits?.excludeSale;
  const groups: DaangnPriceView[] = [
    { suffix: '-monthly', label: rentalOnly ? '월세' : '월세와 단기', tradeTypes: rentalOnly ? ['MONTH'] : ['MONTH', 'SHORT'],
      monthlyMax: limits?.monthlyMax ?? null, depositMax: limits?.monthlyDepositMax ?? null, saleMax: null },
    { suffix: '-jeonse', label: '전세', tradeTypes: ['BORROW'], monthlyMax: null, depositMax: limits?.jeonseMax ?? null, saleMax: null },
  ];
  if (!excludeSale) {
    groups.push({ suffix: '-sale', label: '매매', tradeTypes: ['BUY'], monthlyMax: null, depositMax: null, saleMax: limits?.saleMax ?? null });
  }
  const capped = groups.filter(view => view.monthlyMax !== null || view.depositMax !== null || view.saleMax !== null);
  const open = groups.filter(view => !capped.includes(view));
  if (!capped.length && !excludeSale) return [null];
  if (!open.length) return capped;
  return [...capped, {
    suffix: open.map(view => view.suffix).join(''), label: open.map(view => view.label).join(', '),
    tradeTypes: open.flatMap(view => view.tradeTypes), monthlyMax: null, depositMax: null, saleMax: null,
  }];
}

interface AmountScale { max: number; ranges: readonly { until: number; step: number }[] }

/** 사이트 금액 조건이 받는 눈금. 눈금에 없는 값이나 끝을 넘는 값을 보내면 사이트가 조건을 버린다. */
const SCALES = {
  monthly: { max: 300, ranges: [{ until: Infinity, step: 10 }] },
  deposit: { max: 200000, ranges: [{ until: 10000, step: 1000 }, { until: Infinity, step: 5000 }] },
  sale: { max: 400000, ranges: [{ until: Infinity, step: 5000 }] },
} as const satisfies Record<string, AmountScale>;

/**
 * 상한 이상인 가장 작은 눈금. 눈금 끝을 넘으면 null이며 그때는 조건을 보내지 않는다.
 * 올림한 값으로 넉넉히 받고, 정확한 상한은 받은 매물에서 다시 거른다(daangnPricesMatch).
 */
export function daangnUpstreamMax(cap: number, scale: AmountScale): number | null {
  if (cap > scale.max) return null;
  let value = 0;
  for (const { until, step } of scale.ranges) {
    while (value < until && value < scale.max) {
      if (value >= cap) return value;
      value += step;
    }
  }
  return value >= cap ? value : null;
}

/** 지도 주소의 af 조건. 주거 종류는 항상 걸고, 가격 묶음이 있으면 거래 종류와 금액 상한을 더한다. */
export function daangnFilter(view: DaangnPriceView | null = null): Record<string, unknown> {
  const filter: Record<string, unknown> = { salesTypes: DAANGN_HOME_SALES_TYPES };
  if (!view) return filter;
  filter.tradeTypes = view.tradeTypes;
  const add = (key: string, cap: number | null, scale: AmountScale) => {
    const max = cap === null ? null : daangnUpstreamMax(cap, scale);
    if (max !== null) filter[key] = { minAmount: 0, maxAmount: max };
  };
  add('monthlyPay', view.monthlyMax, SCALES.monthly);
  add('depositPay', view.depositMax, SCALES.deposit);
  add('pricePay', view.saleMax, SCALES.sale);
  return filter;
}

/** 받은 매물의 거래 조건 중 하나라도 이번 조회의 가격 조건 안인지. 조건이 없으면 항상 참. */
export function daangnPricesMatch(prices: readonly PriceOption[], limits?: CollectionPriceLimits, rentalOnly = false): boolean {
  if (!limits && !rentalOnly) return true;
  const within = (amount: number | null, max: number | null) => max === null || (amount !== null && amount >= 0 && amount <= max);
  return prices.some(({ deal, deposit, monthly, price }) => {
    if (rentalOnly && deal !== 'monthly' && deal !== 'jeonse') return false;
    if (deal === 'monthly' || deal === 'short') return within(deposit, limits?.monthlyDepositMax ?? null) && within(monthly, limits?.monthlyMax ?? null);
    if (deal === 'jeonse') return within(deposit, limits?.jeonseMax ?? null);
    return deal === 'sale' && !limits?.excludeSale && within(price, limits?.saleMax ?? null);
  });
}
