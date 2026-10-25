import type { DealType, PriceOption } from '../../shared/types';

/** 매물 탭의 가격대. 금액은 만원이고, 구간은 '앞 경계 초과 ~ 뒤 경계 이하'다. */
export interface Band {
  id: string;
  label: string;
  /** 정확한 범위(마우스를 올리면 보인다) */
  range: string;
}

/** 매물 탭의 거래 유형 카드: rent 전월세(월세와 전세를 함께), sale 매매, short 단기 */
export type OverviewDeal = 'rent' | 'sale' | 'short';

/** 카드 순서. 숫자 키 1~3도 이 순서를 따른다. 경매는 경매 탭에서 본다. */
export const OVERVIEW_DEALS: OverviewDeal[] = ['rent', 'sale', 'short'];
export const OVERVIEW_LABEL: Record<OverviewDeal, string> = { rent: '전월세', sale: '매매', short: '단기' };
/** 카드에 드는 가격 선택지의 거래 유형(왼쪽 필터의 거래 유형 값). 전월세 카드는 월세 가격대 다음에 전세 가격대를 잇는다. */
export const DEALS_OF: Record<OverviewDeal, DealType[]> = { rent: ['monthly', 'jeonse'], sale: ['sale'], short: ['short'] };
/** 거래 유형이 드는 카드(경매는 없음) */
export const overviewDealOf = (d: DealType): OverviewDeal | null =>
  d === 'monthly' || d === 'jeonse' ? 'rent' : d === 'sale' ? 'sale' : d === 'short' ? 'short' : null;

/** 거래 유형별 가격대 경계(만원). 월세와 단기는 월세, 전세는 전세금(5천만 원씩), 매매는 매매가(5억씩). */
const EDGES: Partial<Record<DealType, number[]>> = {
  monthly: [50, 60, 70, 100, 150],
  short: [50, 60, 70, 100, 150],
  jeonse: [10000, 15000, 20000, 25000, 30000, 40000],
  sale: [50000, 100000, 150000, 200000, 250000, 300000],
};
const WHAT: Partial<Record<DealType, string>> = { monthly: '월세', short: '월세', jeonse: '전세금', sale: '매매가' };
/** 전월세 카드에서 가격대 이름 앞에 붙이는 거래 이름 */
const NAME: Partial<Record<DealType, string>> = { monthly: '월세', jeonse: '전세' };

/** 월세 단위(만원)로 나누는 거래 유형 */
export const isRent = (d: DealType) => d === 'monthly' || d === 'short';

/** 숫자 부분과 단위. 월세 단위는 만원, 나머지는 1억 이상이면 억, 아래면 만. */
function parts(d: DealType, v: number): { num: string; unit: string } {
  if (isRent(d)) return { num: `${v}`, unit: '만원' };
  if (v >= 10000) return { num: `${Math.round((v / 10000) * 1e4) / 1e4}`, unit: '억' };
  return { num: v.toLocaleString('ko-KR'), unit: '만' };
}
const text = (d: DealType, v: number) => {
  const p = parts(d, v);
  return `${p.num}${p.unit}`;
};
/** '50~60만원', '1~1.5억'처럼 단위가 같으면 앞쪽 단위를 줄인다. */
function span(d: DealType, a: number, b: number) {
  const pa = parts(d, a);
  const pb = parts(d, b);
  return pa.unit === pb.unit ? `${pa.num}~${pb.num}${pb.unit}` : `${text(d, a)}~${text(d, b)}`;
}

/** 가격대를 정하는 값: 월세와 단기는 월세, 전세는 전세금, 매매는 매매가. */
export function bandValue(p: PriceOption): number | null {
  return isRent(p.deal) ? p.monthly : p.deal === 'jeonse' ? p.deposit : p.price;
}

/** 가격대 id 앞붙이: 전월세 카드는 'monthly:', 'jeonse:'로 월세와 전세 가격대를 나눈다. */
const prefix = (deal: OverviewDeal, d: DealType) => (deal === 'rent' ? `${d}:` : '');

function partBands(deal: OverviewDeal, d: DealType): Band[] {
  const edges = EDGES[d] ?? [];
  const last = edges[edges.length - 1];
  const w = WHAT[d] ?? '';
  const pre = prefix(deal, d);
  const name = deal === 'rent' ? `${NAME[d]} ` : '';
  return [
    ...edges.map((e, i) =>
      i === 0
        ? { id: `${pre}le${e}`, label: `${name}${text(d, e)} 이하`, range: `${w} ${text(d, e)} 이하` }
        : { id: `${pre}le${e}`, label: `${name}${span(d, edges[i - 1], e)}`, range: `${w} ${text(d, edges[i - 1])} 초과 ${text(d, e)} 이하` },
    ),
    { id: `${pre}gt${last}`, label: `${name}${text(d, last)} 초과`, range: `${w} ${text(d, last)} 초과` },
  ];
}

export function bandsFor(deal: OverviewDeal): Band[] {
  return [
    ...DEALS_OF[deal].flatMap((d) => partBands(deal, d)),
    { id: 'unknown', label: '금액 모름', range: '사이트가 금액 정보를 주지 않은 매물' },
  ];
}

/** 가격 선택지가 드는 가격대 id(금액을 모르면 'unknown') */
export function bandIdOf(deal: OverviewDeal, p: PriceOption): string {
  const v = bandValue(p);
  const edges = EDGES[p.deal];
  if (v == null || !edges) return 'unknown';
  const edge = edges.find((e) => v <= e);
  return `${prefix(deal, p.deal)}${edge != null ? `le${edge}` : `gt${edges[edges.length - 1]}`}`;
}

/** 가격대 줄의 거래 유형(전월세 카드는 id 앞붙이로). 금액 모름이면 null. */
export function bandDeal(deal: OverviewDeal, id: string): DealType | null {
  if (id === 'unknown') return null;
  if (deal === 'rent') return id.startsWith('jeonse:') ? 'jeonse' : 'monthly';
  return DEALS_OF[deal][0];
}

/** 처음 순서는 월세 싼 순서, 그다음 전세 싼 순서. 끌어서 바꾼 순서는 화면(localStorage)에 저장된다. */
export function defaultOrder(deal: OverviewDeal): string[] {
  return bandsFor(deal).map((b) => b.id);
}

/** 저장한 순서에서 없어진 가격대는 빼고, 새로 생긴 가격대는 뒤에 붙인다. */
export function orderFor(deal: OverviewDeal, saved: string[] | undefined): string[] {
  const ids = new Set(bandsFor(deal).map((b) => b.id));
  const kept = (saved ?? []).filter((id) => ids.has(id));
  return [...kept, ...defaultOrder(deal).filter((id) => !kept.includes(id))];
}
