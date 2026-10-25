import { ref } from 'vue';
import { DEAL_LABEL, type ListingView, type PriceOption } from '../../shared/types';
import { manwon, priceAmount } from '../../shared/format';
import { profile } from './profile';

// 보증금을 월세로 바꾼 값(환산 월세): 월세 + 보증금 × 전환율 ÷ 12(전세는 월세 0). 금액은 만원, 비율은 연 %.
// 전환율은 모은 매물 중 같은 방에 보증금 선택지가 여럿인 것(보증금을 올리면 월세를 얼마나 깎아 주는지)의 중간값을 쓰고,
// 그런 쌍이 모자라면 법정 상한(한국은행 기준금리 + 2%, 연 10% 넘지 않음)을 쓴다.

export interface RentRate {
  /** 모은 매물에서 낸 전환율(연 %, 소수 한 자리). 쌍이 모자라면 null */
  local: number | null;
  /** local을 낸 쌍 수 */
  pairs: number;
  /** 법정 상한(연 %): 기준금리 + 2%와 10% 중 낮은 것. 기준금리를 모르면 null */
  legal: number | null;
  baseRate: { value: number; date: string } | null;
}

/** local을 쓰려면 있어야 하는 쌍 수 */
const MIN_PAIRS = 10;

/** 한국부동산원 전국주택가격동향조사의 지역별 전월세전환율(연 %)과 그 달 */
export const BOARD_RATES = { month: '2026.7', seoul: { all: 5.5, apt: 4.7, villa: 4.6, house: 6.6 }, nation: 6.7 };

/** App이 매물과 상태를 받을 때마다 채운다(카드가 같이 쓴다). */
export const rentRate = ref<RentRate>({ local: null, pairs: 0, legal: null, baseRate: null });

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/**
 * 같은 매물의 월세 선택지를 보증금 순으로 놓고 이웃한 둘마다 '깎아 준 월세 × 12 ÷ 더 낸 보증금'을 낸 뒤 그 중간값과 법정 상한을 rentRate에 둔다.
 * 고시원과 쉐어처럼 가격 둘이 서로 다른 방(가장 싼 방, 비싼 방)인 매물은 뺀다(isRoomStay).
 */
export function updateRentRate(listings: ListingView[], baseRate: RentRate['baseRate'], isRoomStay: (l: ListingView) => boolean) {
  const rates: number[] = [];
  for (const l of listings) {
    if (l.status !== 'active' || isRoomStay(l)) continue;
    const options = l.prices
      .filter((p) => p.deal === 'monthly' && p.deposit != null && p.monthly != null)
      .sort((a, b) => a.deposit! - b.deposit!);
    for (let i = 0; i + 1 < options.length; i++) {
      const more = options[i + 1].deposit! - options[i].deposit!;
      const less = options[i].monthly! - options[i + 1].monthly!;
      if (more > 0 && less > 0) rates.push(((less * 12) / more) * 100);
    }
  }
  const legal = baseRate ? Math.min(10, baseRate.value + 2) : null;
  rentRate.value = { local: rates.length >= MIN_PAIRS ? Math.round(median(rates) * 10) / 10 : null, pairs: rates.length, legal, baseRate };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const pct = (v: number) => `${v.toFixed(1)}%`;

/**
 * 카드에 보일 환산 월세(text)와 설명(tip). 월세는 월세 + 보증금 × 전환율 ÷ 12, 전세는 전세금 × 전환율 ÷ 12.
 * 가격 선택지마다 하나씩 가격 줄 순서대로 쉼표로 잇고, 매매처럼 바꿀 수 없는 가격이 섞여 있으면 값 앞에 거래 이름을 붙인다.
 * 보증금 있는 월세나 전세가 없거나 쓸 전환율이 없으면 null.
 */
export function convertedRent(l: Pick<ListingView, 'prices'>): { text: string; tip: string } | null {
  const r = rentRate.value;
  const rate = r.local ?? r.legal;
  if (rate == null) return null;
  const options = l.prices.filter(
    (p) => p.deposit != null && ((p.deal === 'monthly' && p.monthly != null) || (p.deal === 'jeonse' && p.deposit > 0)),
  );
  if (!options.some((p) => p.deposit! > 0)) return null;
  const at = (p: PriceOption, x: number) => round1((p.deal === 'monthly' ? p.monthly! : 0) + (p.deposit! * x) / 100 / 12);
  const mixed = options.length < l.prices.length;
  const text = options.map((p) => `${mixed ? `${DEAL_LABEL[p.deal]} ` : ''}${manwon(at(p, rate))}`).join(', ');
  const formula = (p: PriceOption) =>
    p.deal === 'jeonse'
      ? `전세 ${priceAmount(p)}: 전세금 ${manwon(p.deposit!)} × ${pct(rate)} ÷ 12 = ${manwon(at(p, rate))}`
      : `월세 ${priceAmount(p)}: 월세 ${manwon(p.monthly!)} + 보증금 ${manwon(p.deposit!)} × ${pct(rate)} ÷ 12 = ${manwon(at(p, rate))}`;
  const lines = [
    '보증금을 월세로 바꾼 값',
    ...options.map(formula),
    `보증금 1,000만원을 월세 ${manwon(round1((1000 * rate) / 1200))}으로 친 값이라, 보증금이 다른 집이나 전세와 월세를 이 값으로 견줄 수 있습니다.`,
    r.local != null
      ? `${pct(rate)}: 모은 매물 중 같은 방에 보증금 선택지가 여럿인 ${r.pairs}쌍에서 보증금을 올리면 월세를 얼마나 깎아 주는지의 중간값`
      : `${pct(rate)}: 법정 상한(아래). 보증금 선택지가 여럿인 매물이 모자라 대신 썼습니다.`,
  ];
  if (r.legal != null && r.baseRate) {
    const legalRate = r.legal;
    const legal = r.local != null ? `, 이 비율로는 ${options.map((p) => manwon(at(p, legalRate))).join(', ')}` : '';
    lines.push(
      `법정 상한 ${pct(r.legal)}${legal}: 기준금리 ${r.baseRate.value}%(${r.baseRate.date.replace(/-/g, '.')}) + 2%. 계약 중에 보증금을 월세로 바꿀 때 넘을 수 없는 비율입니다(주택임대차보호법 제7조의2).`,
    );
  }
  const b = BOARD_RATES;
  lines.push(
    `한국부동산원 평균(${b.month}): 서울 아파트 ${pct(b.seoul.apt)}, 연립다세대 ${pct(b.seoul.villa)}, 단독 ${pct(b.seoul.house)}, 서울 전체 ${pct(b.seoul.all)}, 전국 ${pct(b.nation)}`,
    '보증금이 클수록 떼일 때 잃는 돈도 커서, 반환보증에 들 수 있는 집인지도 같이 봅니다.',
  );
  return { text, tip: lines.join('\n') };
}

// ---------- 대출 시 매달 나가는 돈 ----------
// 환산 월세(그 집의 값을 견줄 때)와 달리, 보증금을 전세대출로 낼 때 실제로 매달 나가는 돈(월세 + 대출 이자)이다.
// 내 돈으로 낸 나머지 보증금은 매달 나가는 돈이 없어 넣지 않는다.

/** 전세대출 기본 금리(연 %)와 근거 */
export const LOAN_RATE = { rate: 4.5, basis: '한국주택금융공사 보증 전세대출의 2026년 9월 은행별 평균(3.81~4.87%) 가운데 값' };
/** 보증금 중 대출로 낼 몫 기본값(%, HUG 전세안심대출 일반 한도) */
export const LOAN_RATIO = 80;
/** 대출 한도(만원, HUG 전세안심대출 일반 수도권 한도) */
const LOAN_CAP = 40000;
/** 월세가 있는 계약에서 보증금에서 먼저 빼는 월세 개월 수(2년 계약) */
const RENT_MONTHS = 24;

/**
 * 카드에 보일 '대출 시 월'(text)과 설명(tip). 보증금 있는 월세와 전세의 가격 선택지마다 월세 + 이자를 가격 줄 순서대로 쉼표로 잇는다.
 * 대출 = (보증금 - 월세 × 24) × 대출 비율, 4억까지. 이자 = 대출 × 금리 ÷ 12.
 * 금리와 비율은 내 조건(profile.ts), 없으면 기본값. 해당 선택지가 없으면 null.
 */
export function loanMonthly(l: Pick<ListingView, 'prices'>): { text: string; tip: string } | null {
  const me = profile.value;
  const rate = me.loanRate ?? LOAN_RATE.rate;
  const ratio = me.loanRatio ?? LOAN_RATIO;
  const options = l.prices.filter(
    (p) => p.deposit != null && p.deposit > 0 && ((p.deal === 'monthly' && p.monthly != null) || p.deal === 'jeonse'),
  );
  if (!options.length) return null;
  const rentSum = (p: PriceOption) => (p.deal === 'monthly' ? p.monthly! * RENT_MONTHS : 0);
  const base = (p: PriceOption) => Math.max(0, p.deposit! - rentSum(p));
  const loanOf = (p: PriceOption) => Math.round(Math.min((base(p) * ratio) / 100, LOAN_CAP));
  const interest = (p: PriceOption) => round1((loanOf(p) * rate) / 100 / 12);
  const total = (p: PriceOption) => round1((p.deal === 'monthly' ? p.monthly! : 0) + interest(p));
  const mixed = options.length < l.prices.length;
  const text = options.map((p) => `${mixed ? `${DEAL_LABEL[p.deal]} ` : ''}${manwon(total(p))}`).join(', ');
  const line = (p: PriceOption) => {
    const loan = loanOf(p);
    const head = `${DEAL_LABEL[p.deal]} ${priceAmount(p)}: `;
    if (!loan) return `${head}대출 안 됨(보증금에서 월세 2년치 ${manwon(rentSum(p))}을 빼면 남는 것이 없음), 월 ${manwon(total(p))}`;
    const capped = (base(p) * ratio) / 100 > LOAN_CAP;
    const rent = p.deal === 'monthly' ? `월세 ${manwon(p.monthly!)} + ` : '';
    return `${head}${rent}이자 ${manwon(interest(p))} = 월 ${manwon(total(p))}(대출 ${manwon(loan)}${capped ? ', 4억 한도' : ''}, 내 돈 ${manwon(p.deposit! - loan)})`;
  };
  const lines = [
    '보증금을 전세대출로 내면 매달 나가는 돈',
    ...options.map(line),
    `대출은 보증금의 ${ratio}%(월세가 있으면 보증금에서 월세 2년치를 먼저 빼고, 4억까지), 금리 연 ${rate}%로 셌습니다${me.loanRate == null ? `(${LOAN_RATE.basis})` : ''}. 설정 탭 내 조건에서 바꿉니다.`,
    '내 돈으로 낸 나머지 보증금은 매달 나가는 돈이 없어 넣지 않았고, 관리비도 따로입니다.',
    '한도는 HUG 전세안심대출 일반 기준(보증금의 80%, 수도권 4억, 월세가 있으면 보증 기간 월세 합계를 뺀 보증금으로 셈, 1년 이자가 인정소득의 40% 이내)을 따랐고, 실제 한도와 금리는 은행과 보증 상품마다 다릅니다.',
  ];
  return { text, tip: lines.join('\n') };
}
