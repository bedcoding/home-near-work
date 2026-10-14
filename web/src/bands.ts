import type { DealType, PriceOption } from '../../shared/types';

/** 매물 탭의 가격대. 금액은 만원이고, 구간은 '앞 경계 초과 ~ 뒤 경계 이하'다. */
export interface Band {
  id: string;
  label: string;
  /** 정확한 범위(마우스를 올리면 보인다) */
  range: string;
}

/** 매물 탭에 보이는 거래 유형 순서. 숫자 키 1~4도 이 순서를 따른다. 경매는 경매 탭에서 본다. */
export const OVERVIEW_DEALS: DealType[] = ['monthly', 'jeonse', 'sale', 'short'];

/** 가격대 경계(만원). 전세는 5천만 원씩, 매매는 5억씩 나눈다. */
export const EDGES: Record<DealType, number[]> = {
  monthly: [50, 60, 70, 100, 150],
  short: [50, 60, 70, 100, 150],
  jeonse: [10000, 15000, 20000, 25000, 30000, 40000],
  sale: [50000, 100000, 150000, 200000, 250000, 300000],
  auction: [50000, 100000, 150000, 200000, 250000, 300000],
};

const WHAT: Record<DealType, string> = { monthly: '월세', short: '월세', jeonse: '보증금', sale: '매매가', auction: '최저가' };

export const isRent = (deal: DealType) => deal === 'monthly' || deal === 'short';

/** 숫자 부분과 단위. 월세는 만원, 나머지는 1억 이상이면 억, 아래면 만. */
function parts(deal: DealType, v: number): { num: string; unit: string } {
  if (isRent(deal)) return { num: `${v}`, unit: '만원' };
  if (v >= 10000) return { num: `${Math.round((v / 10000) * 1e4) / 1e4}`, unit: '억' };
  return { num: v.toLocaleString('ko-KR'), unit: '만' };
}
const text = (deal: DealType, v: number) => {
  const p = parts(deal, v);
  return `${p.num}${p.unit}`;
};
/** '30~50만원', '1~1.5억'처럼 단위가 같으면 앞쪽 단위를 줄인다. */
function span(deal: DealType, a: number, b: number) {
  const pa = parts(deal, a);
  const pb = parts(deal, b);
  return pa.unit === pb.unit ? `${pa.num}~${pb.num}${pb.unit}` : `${text(deal, a)}~${text(deal, b)}`;
}

/** 가격대를 정하는 값: 월세는 월세, 전세는 보증금, 매매는 매매가, 경매는 최저가. */
export function bandValue(deal: DealType, p: PriceOption): number | null {
  return isRent(deal) ? p.monthly : deal === 'jeonse' ? p.deposit : p.price;
}

export function bandsFor(deal: DealType, edges: number[]): Band[] {
  const last = edges[edges.length - 1];
  const w = WHAT[deal];
  return [
    ...edges.map((e, i) =>
      i === 0
        ? { id: `le${e}`, label: `${text(deal, e)} 이하`, range: `${w} ${text(deal, e)} 이하` }
        : { id: `le${e}`, label: span(deal, edges[i - 1], e), range: `${w} ${text(deal, edges[i - 1])} 초과 ${text(deal, e)} 이하` },
    ),
    { id: `gt${last}`, label: `${text(deal, last)} 초과`, range: `${w} ${text(deal, last)} 초과` },
    { id: 'unknown', label: '금액 모름', range: `사이트가 ${w} 정보를 주지 않은 매물` },
  ];
}

export function bandIdOf(value: number | null, edges: number[]): string {
  if (value == null) return 'unknown';
  const edge = edges.find((e) => value <= e);
  return edge != null ? `le${edge}` : `gt${edges[edges.length - 1]}`;
}

/** 처음 순서는 싼 순서. 끌어서 바꾼 순서는 화면(localStorage)에 저장된다. */
export function defaultOrder(deal: DealType, edges: number[]): string[] {
  return bandsFor(deal, edges).map((b) => b.id);
}

/** 저장한 순서에서 없어진 가격대는 빼고, 새로 생긴 가격대는 뒤에 붙인다. */
export function orderFor(deal: DealType, saved: string[] | undefined, edges: number[]): string[] {
  const ids = new Set(bandsFor(deal, edges).map((b) => b.id));
  const kept = (saved ?? []).filter((id) => ids.has(id));
  return [...kept, ...defaultOrder(deal, edges).filter((id) => !kept.includes(id))];
}
