import { isDetachedHouseType, type ListingView } from '../../shared/types';
import { kindOf } from './kinds';

// 대출 신호등(ListingCard): 사는 매물(매매, 경매, 공매)의 값, 전용면적, 집 종류로 정책대출(디딤돌, 신생아 특례 디딤돌, 보금자리론)을
// 받을 수 있는지와 일반 주택담보대출 한도 구간을 본다. 자산, 무주택 여부, 신용은 보지 않고, 소득은 내 조건(profile.ts)으로 못 받는 대출을 뺄 때만 쓴다. 금액은 만원.
// ok 가격과 집 조건이 맞음, maybe 모르는 값이 있거나 경계라 확인 필요, no 아는 값으로 안 됨.
// 고칠 때는 LOANS_CHECKED와 LOAN_SOURCES도 같이 고친다.

/** 대출 조건을 공식 페이지에서 확인한 날 */
export const LOANS_CHECKED = '2026-10-19';

export type LoanState = 'ok' | 'maybe' | 'no';
export interface LoanLight {
  id: 'didimdol' | 'newborn' | 'bogeumjari';
  name: string;
  state: LoanState;
  /** 판단 까닭(툴팁에 씀) */
  why: string[];
}
export interface LoanView {
  lights: LoanLight[];
  /** 일반 주택담보대출 한도(10.15 구간, 만원). 오피스텔처럼 구간을 모르면 null. */
  cap: number | null;
  tip: string;
}

/** 근거(툴팁 맨 아래 한 줄) */
const LOAN_SOURCES = '주택도시기금 디딤돌과 신생아 특례 상품 안내, 한국주택금융공사 보금자리론 안내와 묻고 답하기, 금융위원회 10.15 대책 문답';

const EOK = 10000;
const eok = (manwon: number) => (manwon % EOK === 0 ? `${manwon / EOK}억` : `${(manwon / EOK).toFixed(1)}억`);
const money = (manwon: number) => (manwon >= EOK ? `${Math.floor(manwon / EOK)}억${manwon % EOK ? ` ${(manwon % EOK).toLocaleString('ko-KR')}만` : ''}` : `${manwon.toLocaleString('ko-KR')}만`);
const STATE_TEXT: Record<LoanState, string> = { ok: '가격과 집 조건 맞음', maybe: '확인 필요', no: '안 됨' };

/** 집 종류 판단: ok 아파트, 연립, 다세대, 단독, maybe 다가구나 상가주택 또는 모름, no 오피스텔(준주택)이나 집이 아닌 것 */
function typeCheck(l: Pick<ListingView, 'buildingType'>): { state: LoanState; why: string } {
  const kind = kindOf(l);
  const t = l.buildingType ?? '';
  if (kind === 'officetel') return { state: 'no', why: '오피스텔은 준주택이라 대상 주택이 아님' };
  if (kind === 'apt' || kind === 'villa') return { state: 'ok', why: '' };
  if (kind === 'house') {
    if (/다가구|다중/.test(t)) return { state: 'maybe', why: '다가구(다중)주택은 공식 안내에 문구가 없음' };
    if (/상가주택/.test(t)) return { state: 'maybe', why: '상가주택은 주택 면적이 절반 이상이어야 함(보금자리론 기준)' };
    return { state: 'ok', why: '' };
  }
  return { state: 'maybe', why: '집 종류를 모름' };
}

const worst = (states: LoanState[]): LoanState => (states.includes('no') ? 'no' : states.includes('maybe') ? 'maybe' : 'ok');

/**
 * 사는 매물의 대출 신호등. 매매나 경매 값이 없거나 집이 아닌 것(토지, 상가, 기타)이면 null.
 * 값: 매매가(경매는 이번 회차 최저가, 낙찰가는 그보다 높을 수 있음), 시세 대신 같은 단지 같은 전용면적 실거래 중간값(TradeRef), 경매 감정가.
 * skip이 true를 돌려주는 정책대출(내 소득으로는 못 받는 것)은 신호등과 설명에서 뺀다.
 */
export function loanView(
  l: Pick<ListingView, 'buildingType' | 'prices' | 'areaM2' | 'trade' | 'auction' | 'source'>,
  skip: (id: LoanLight['id']) => boolean = () => false,
): LoanView | null {
  const kind = kindOf(l);
  if (kind === 'land' || kind === 'shop' || kind === 'etc') return null;
  const auction = l.source === 'courtauction' || l.source === 'onbid' || l.prices.some((p) => p.deal === 'auction');
  const found = l.prices.find((p) => p.deal === (auction ? 'auction' : 'sale'))?.price ?? null;
  if (found == null) return null;
  const price: number = found;
  const median = l.trade?.median ?? null;
  const appraisal = l.auction?.appraisal ?? null;
  const area = l.areaM2;
  const type = typeCheck(l);
  const house = kind === 'house' || isDetachedHouseType(l.buildingType);
  const priceName = auction ? '최저가' : '매매가';

  /** 디딤돌과 신생아 특례: 평가액(시세, 없으면 공시가격, 분양가, 감정가 순서)이 cap 이하, 주거전용 85㎡ 이하 */
  function didimdol(id: 'didimdol' | 'newborn', name: string, cap: number): LoanLight {
    const why: string[] = [];
    const states: LoanState[] = [type.state];
    if (type.why) why.push(type.why);
    if (area == null) states.push('maybe'), why.push('전용면적 모름(85㎡ 이하여야 함)');
    else if (area > 85) {
      states.push(house ? 'maybe' : 'no');
      why.push(`전용 ${area.toFixed(1)}㎡로 85㎡를 넘음${house ? '(단독은 주거전용 면적을 어떻게 재는지 확인)' : ''}`);
    }
    // 아파트는 시세가 평가액이라 실거래 중간값(없으면 감정가나 값)으로 보고, 빌라와 단독은 공시가격으로 볼 수 있어 값이 넘어도 확인 필요로 둔다.
    const value = kind === 'apt' ? (median ?? appraisal ?? price) : (appraisal ?? price);
    const basis = kind === 'apt' ? (median != null ? '실거래 중간값' : appraisal != null ? '감정가' : priceName) : appraisal != null ? '감정가' : priceName;
    if (value > cap) {
      const state: LoanState = kind === 'apt' ? (value > cap * 1.1 ? 'no' : 'maybe') : 'maybe';
      states.push(state);
      why.push(`${basis} ${money(value)}이 ${eok(cap)}을 넘음${kind === 'apt' ? '' : '(시세가 없으면 공시가격으로 보므로 확인)'}`);
    } else why.push(`${basis} ${money(value)}으로 ${eok(cap)} 이하`);
    return { id, name, state: worst(states), why };
  }

  /** 보금자리론: 시세, 감정평가액, 매매가(낙찰가 포함)가 모두 6억 이하. 면적 제한 없음. */
  function bogeumjari(): LoanLight {
    const cap = 6 * EOK;
    const why: string[] = [];
    const states: LoanState[] = [type.state];
    if (type.why) why.push(type.why);
    if (price > cap) states.push('no'), why.push(`${priceName} ${money(price)}이 6억을 넘음`);
    else if (auction) states.push('maybe'), why.push(`낙찰가도 6억 이하여야 함(최저가 ${money(price)})`);
    else why.push(`매매가 ${money(price)}으로 6억 이하`);
    if (median != null) {
      if (median > cap) states.push('no'), why.push(`시세 대신 본 실거래 중간값 ${money(median)}이 6억을 넘음`);
    } else if (kind === 'apt' && price <= cap) states.push('maybe'), why.push('KB 시세를 몰라 확인 필요');
    if (appraisal != null && appraisal > cap && price <= cap) states.push('maybe'), why.push(`법원 감정가 ${money(appraisal)}이 6억을 넘어 은행 감정이나 시세도 넘을 수 있음`);
    return { id: 'bogeumjari', name: '보금자리', state: worst(states), why };
  }

  const lights = [didimdol('didimdol', '디딤돌', 5 * EOK), didimdol('newborn', '신생아', 9 * EOK), bogeumjari()].filter((x) => !skip(x.id));

  // 일반 주택담보대출(10.15): 시가 15억 이하 6억, 25억 이하 4억, 넘으면 2억. 오피스텔은 이 구간이 아니라 빼고 보인다.
  const market = median ?? appraisal ?? price;
  const marketBasis = median != null ? '실거래 중간값' : appraisal != null ? '감정가' : priceName;
  const cap = kind === 'officetel' ? null : market <= 15 * EOK ? 6 * EOK : market <= 25 * EOK ? 4 * EOK : 2 * EOK;
  if (!lights.length && cap == null) return null;

  /** 정책대출 한도(남은 것만) */
  const LIMITS: Record<LoanLight['id'], string> = {
    didimdol: '디딤돌 일반 2억(생애최초 2.4억, 신혼과 2자녀 3.2억)',
    newborn: '신생아 특례 4억',
    bogeumjari: '보금자리론 3.6억(생애최초 4.2억)',
  };
  const policy = lights.length
    ? [
        '정책대출(가격과 집 조건만 봄, 자산, 무주택 여부, 신용은 안 봄, 소득은 설정 탭 내 조건으로 거름)',
        ...lights.map((x) => `${x.name === '신생아' ? '신생아 특례 디딤돌(9억, 85㎡)' : x.name === '디딤돌' ? '디딤돌(일반 5억, 신혼과 2자녀 6억, 85㎡)' : '보금자리론(시세, 감정가, 매매가 모두 6억 이하)'}: ${STATE_TEXT[x.state]}${x.why.length ? `\n  ${x.why.join(', ')}` : ''}`),
        '',
      ]
    : [];
  const tip = [
    ...policy,
    cap != null
      ? `일반 주택담보대출 한도 ${eok(cap)}: 시가(${marketBasis} ${money(market)}) 15억 이하 6억, 25억 이하 4억, 넘으면 2억(10.15 대책). 서울은 LTV 40%(생애최초 70%)도 같이 걸리고, 대출을 받으면 6개월 안에 전입해야 합니다.${auction ? ' 경락잔금대출에도 같다는 보도가 있습니다(공식 문답 없음).' : ''}`
      : '오피스텔은 주택담보대출 구간 한도가 아니라 비주택 담보대출 기준을 따릅니다.',
    '',
    `${lights.length ? `정책대출 한도: ${lights.map((x) => LIMITS[x.id]).join(', ')}. ` : ''}시세는 같은 단지 같은 면적 실거래 중간값으로 대신 봤습니다. ${LOANS_CHECKED.replace(/-/g, '.')} 확인(${LOAN_SOURCES}).`,
  ].join('\n');
  return { lights, cap, tip };
}
