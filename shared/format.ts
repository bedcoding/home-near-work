import { DEAL_LABEL, type NormalizedListing, type PriceOption } from './types.js';

/** 만원 단위 금액을 '1억 3,000' 식으로. */
export function money(value: number | null): string {
  if (value == null) return '?';
  if (value >= 10000) {
    const eok = Math.floor(value / 10000);
    const rest = value % 10000;
    return rest ? `${eok}억 ${rest.toLocaleString('ko-KR')}` : `${eok}억`;
  }
  return value.toLocaleString('ko-KR');
}

/** 만원 단위 금액을 '50만', '2억', '2억 5,000만' 식으로. */
export function manwon(value: number): string {
  if (value >= 10000) {
    const eok = Math.floor(value / 10000);
    const rest = value % 10000;
    return rest ? `${eok}억 ${rest.toLocaleString('ko-KR')}만` : `${eok}억`;
  }
  return `${value.toLocaleString('ko-KR')}만`;
}

/** 거래 이름 없이 금액만: 월세, 단기 '1,000/60', 전세 '2억 1,000', 매매, 경매 '1억 3,000'. */
export function priceAmount(p: PriceOption): string {
  switch (p.deal) {
    case 'monthly':
    case 'short':
      return `${money(p.deposit)}/${p.monthly ?? '?'}`;
    case 'jeonse':
      return money(p.deposit);
    default:
      return money(p.price);
  }
}

export function priceText(p: PriceOption): string {
  return `${DEAL_LABEL[p.deal]} ${priceAmount(p)}`;
}

export function floorText(l: Pick<NormalizedListing, 'basement' | 'rooftop' | 'floor' | 'totalFloors'>): string {
  if (l.basement) return '반지하';
  if (l.rooftop) return '옥탑';
  if (l.floor == null) return '층 모름';
  return l.totalFloors ? `${l.floor}층/${l.totalFloors}층` : `${l.floor}층`;
}

export const yesNo = (v: boolean | null) => (v == null ? '모름' : v ? '있음' : '없음');
