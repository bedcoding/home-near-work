import { ref, watch } from 'vue';

// 내 조건(설정 탭): 연소득과 가구, 전세대출 금리와 대출 비율. 연소득을 넣으면 소득 기준을 넘어 받을 수 없는 정책대출과 지원을
// 지원 제도 탭과 매물 카드 대출 표시에서 빼고, 금리와 비율은 매물 카드의 '대출 시 월'에 쓴다. 이 브라우저(localStorage)에만 둔다. 금액은 만원.

export interface MyProfile {
  /** 연소득(세전, 결혼했으면 부부 합산). null이면 거르지 않는다. */
  income: number | null;
  /** 혼인 7년 안이거나 결혼 예정 */
  newlywed: boolean;
  /** 2년 안에 아이를 낳거나 입양함 */
  newborn: boolean;
  /** 미성년 자녀 수(2는 2명 이상) */
  kids: 0 | 1 | 2;
  /** 전세대출 금리(연 %). null이면 기본값(rentRate.ts LOAN_RATE) */
  loanRate: number | null;
  /** 보증금 중 대출로 낼 몫(%). null이면 기본값(rentRate.ts LOAN_RATIO) */
  loanRatio: number | null;
}

const KEY = 'hnw-my-profile';
const EMPTY: MyProfile = { income: null, newlywed: false, newborn: false, kids: 0, loanRate: null, loanRatio: null };

/** 0보다 크고 max 이하인 숫자면 그 값, 아니면 null */
const within = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : null);

function load(): MyProfile {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<MyProfile> | null;
    if (!v || typeof v !== 'object') return { ...EMPTY };
    const kids = v.kids === 1 || v.kids === 2 ? v.kids : 0;
    return {
      income: within(v.income, 1_000_000),
      newlywed: v.newlywed === true,
      newborn: v.newborn === true,
      kids,
      loanRate: within(v.loanRate, 30),
      loanRatio: within(v.loanRatio, 100),
    };
  } catch {
    return { ...EMPTY };
  }
}

/** 지금 내 조건(설정 탭에서 바꾸면 바로 저장되고 화면 곳곳에 바로 반영된다) */
export const profile = ref<MyProfile>(load());
watch(
  profile,
  (p) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      // 저장소를 못 쓰면 이번 화면에서만 쓴다.
    }
  },
  { deep: true },
);

/**
 * 제도와 대출의 소득 기준(만원)을 가구에 맞춰 돌려준다. 그 가구가 대상이 아니면 0, 소득으로 거를 수 없으면 null.
 * 확실히 못 받는 것만 빼도록 기준이 여럿이면 넉넉한 쪽을 쓴다(디딤돌은 생애최초 7천만원, 신혼은 부부 중 1명 소득 특례가 있어 거르지 않음).
 * 키는 지원 제도 id(web/src/support.ts)와 매물 카드 대출 표시 id(web/src/loans.ts).
 */
const INCOME_CAPS: Record<string, (p: MyProfile) => number | null> = {
  beotimmok: (p) => (p.newlywed ? 7500 : p.kids >= 2 ? 6000 : 5000),
  'beotimmok-youth': (p) => (p.newlywed ? 7500 : p.kids >= 2 ? 6000 : 5000),
  'beotimmok-newlywed': (p) => (p.newlywed ? 7500 : 0),
  'beotimmok-newborn': (p) => (p.newborn ? (p.newlywed ? 20000 : 13000) : 0),
  'sme-youth': () => 3500,
  'seoul-youth-interest': () => 5000,
  'seoul-newlywed-interest': (p) => (p.newlywed ? 13000 : 0),
  'guarantee-fee-support': (p) => (p.newlywed ? 7500 : 6000),
  'stable-rent-loan': () => 5000,
  'youth-deposit-rent-loan': () => 5000,
  'rent-tax-credit': (p) => (p.newlywed ? null : 8000),
  didimdol: (p) => (p.newlywed ? null : 7000),
  bogeumjari: (p) => (p.newlywed ? null : p.kids >= 2 ? 10000 : p.kids === 1 ? 9000 : 7000),
  newborn: (p) => (p.newborn ? (p.newlywed ? 20000 : 13000) : 0),
};

/** 내 조건으로는 받을 수 없는 제도나 대출인지(연소득을 안 넣었으면 늘 false) */
export function cannotGet(id: string): boolean {
  const p = profile.value;
  if (p.income == null) return false;
  const cap = INCOME_CAPS[id]?.(p);
  return cap != null && p.income > cap;
}
