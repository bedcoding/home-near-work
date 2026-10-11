import type { DealType, PriceOption } from '../../shared/types';

/** 한눈에 탭의 가격대. 금액은 만원이고, 구간은 '앞 경계 초과 ~ 뒤 경계 이하'다. */
export interface Band {
  id: string;
  label: string;
  /** 정확한 범위(마우스를 올리면 보인다) */
  range: string;
}

/** 한눈에 탭에 보이는 거래 유형 순서. 숫자 키 1~4도 이 순서를 따른다. 경매는 경매 탭에서 본다. */
export const OVERVIEW_DEALS: DealType[] = ['monthly', 'jeonse', 'sale', 'short'];

/**
 * 기본 가격대 경계. 사용자가 한눈에 탭의 '가격대 나누기'에서 바꾸면 그 값을 쓴다(화면에 저장).
 * 전세는 5천만 원씩, 매매는 5억씩 나눈다.
 */
export const DEFAULT_EDGES: Record<DealType, number[]> = {
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

/** 사용자가 바꾼 경계가 있으면 그것, 없으면 기본값. */
export function edgesFor(deal: DealType, custom: number[] | undefined): number[] {
  return custom && custom.length ? custom : DEFAULT_EDGES[deal];
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

/** 입력칸에 보여 줄 경계: 월세는 '50, 60', 나머지는 '8000만, 1억, 1.5억'. */
export function edgesText(deal: DealType, edges: number[]): string {
  return edges.map((e) => (isRent(deal) ? `${e}` : text(deal, e))).join(', ');
}

/** '1억 5천', '1.5억', '8000', '8천', '8000만(원)' → 만원. 읽지 못하면 null. */
export function parseMoney(input: string): number | null {
  const s = input.replace(/\s+/g, '').replace(/원$/, '');
  const m = /^(?:(\d+(?:\.\d+)?)억)?(?:(\d+(?:\.\d+)?)천)?(?:(\d+(?:\.\d+)?)만?)?$/.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const v = (m[1] ? Number(m[1]) * 10000 : 0) + (m[2] ? Number(m[2]) * 1000 : 0) + (m[3] ? Number(m[3]) : 0);
  return Number.isFinite(v) ? Math.round(v) : null;
}

/** 쉼표로 나눈 경계를 읽는다. 작은 순서로 정렬하고 겹치는 값은 하나로 합친다. */
export function parseEdges(input: string): { edges: number[] } | { error: string } {
  const tokens = input.split(/[,，、\n]+/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return { error: '경계를 하나 이상 적어 주세요.' };
  const values: number[] = [];
  for (const t of tokens) {
    const v = parseMoney(t);
    if (v == null || v <= 0) return { error: `'${t}'을(를) 금액으로 읽지 못했습니다. 예: 30, 50 또는 1억, 1.5억` };
    values.push(v);
  }
  const edges = [...new Set(values)].sort((a, b) => a - b);
  if (edges.length > 12) return { error: '경계는 12개까지 적을 수 있습니다.' };
  return { edges };
}
