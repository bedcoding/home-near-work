import { isDetachedHouseType, listingSection, SEOUL, type CourtRegionStat, type ListingView } from '../../shared/types';
import { manwon, perPyeong } from './format';

/** 경매 매물(법원경매와 온비드 공매, 주거와 상가). 매물 탭에는 넣지 않고 경매 탭에서 따로 본다. */
export const isAuction = (l: Pick<ListingView, 'source' | 'buildingType'>) => ['auction', 'shop', 'land'].includes(listingSection(l));


/** 경매 탭의 칸: home 주거, house 단독(주거 중 단독주택, 다가구주택, 다중주택), shop 상가, land 토지(땅만 파는 것) */
export type AuctionKind = 'home' | 'house' | 'shop' | 'land';
/** 경매 물건이 속한 칸(house는 home에 들어 있어서 따로 주지 않는다) */
export const auctionKindOf = (l: Pick<ListingView, 'source' | 'buildingType'>): Exclude<AuctionKind, 'house'> => {
  const section = listingSection(l);
  return section === 'shop' || section === 'land' ? section : 'home';
};
/** 경매 물건이 칸 kind에 보이는지: 단독 칸은 주거 중 건물 용도가 단독주택 갈래인 것 */
export const inAuctionKind = (l: Pick<ListingView, 'source' | 'buildingType'>, kind: AuctionKind): boolean =>
  kind === 'house' ? auctionKindOf(l) === 'home' && isDetachedHouseType(l.buildingType) : auctionKindOf(l) === kind;

/** 매각기일(YYYY-MM-DD, 온비드는 개찰일). 두 수집기 모두 이 날을 updatedAt에 둔다. */
export function saleDateOf(l: ListingView): string | null {
  return isAuction(l) && /^\d{4}-\d{2}-\d{2}$/.test(l.updatedAt ?? '') ? l.updatedAt : null;
}

/** 오늘(이 컴퓨터 시각) YYYY-MM-DD */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const hasNews = (l: ListingView) => l.isNew || !!l.priceChange;
const minPrice = (l: ListingView) => Math.min(...l.prices.map((p) => p.price ?? Infinity), Infinity);

/**
 * 경매 목록 순서: 다가오는 매각기일(가까운 날부터) → 지난 매각기일(최근부터) → 매각기일 모름.
 * 같은 날은 새 소식 → 최저가 낮은 순. byPyeong이면 같은 날 안에서 평당(최저가 ÷ 전용 평) 낮은 순, 평당을 모르면 뒤.
 */
export function sortAuctions(list: ListingView[], byPyeong = false): ListingView[] {
  const now = today();
  const rank = (l: ListingView) => {
    const d = saleDateOf(l);
    return d == null ? 2 : d >= now ? 0 : 1;
  };
  return [...list].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const da = saleDateOf(a) ?? '';
    const db = saleDateOf(b) ?? '';
    if (da !== db) return ra === 1 ? db.localeCompare(da) : da.localeCompare(db);
    if (byPyeong) return (perPyeong(a) ?? Infinity) - (perPyeong(b) ?? Infinity) || minPrice(a) - minPrice(b);
    return Number(hasNews(b)) - Number(hasNews(a)) || minPrice(a) - minPrice(b);
  });
}

/** 경매마당 법원 번호(물건 주소 m_code의 앞 두 자리). 조회하는 서울 법원 다섯 곳. */
const MADANG_COURT: Record<string, string> = {
  서울중앙지방법원: '01',
  서울동부지방법원: '02',
  서울서부지방법원: '03',
  서울남부지방법원: '04',
  서울북부지방법원: '05',
};

/**
 * 경매마당에서 법원경매 물건을 여는 주소. 모르는 법원이나 사건번호 모양이면 null.
 * caview?m_code=법원 번호 2자리 + 사건 연도 4자리 + 사건 번호 7자리 + 물건번호 3자리(앞을 0으로 채움).
 */
export function madangUrl(courtName: string, caseNo: string, itemNo: string): string | null {
  const m = /^(\d{4})타경(\d+)$/.exec(caseNo);
  const court = MADANG_COURT[courtName];
  if (!m || !court || !/^\d+$/.test(itemNo)) return null;
  return `https://madangs.com/caview?m_code=${court}${m[1]}${m[2].padStart(7, '0')}${itemNo.padStart(3, '0')}`;
}

/** 다른 경매 사이트에서 이 물건을 여는 주소. 모르면 빈 배열. */
export function auctionSiteLinks(l: ListingView): { name: string; url: string }[] {
  const a = l.auction;
  const url = a ? madangUrl(a.court, a.caseNo, a.itemNo) : null;
  return url ? [{ name: '경매마당', url }] : [];
}

/**
 * 감정가 × 법원 지역별 매각통계 매각가율로 낸 예상 낙찰가 하나.
 * label '역삼동 평균', rate 매각가율(%), price 예상 낙찰가(만원, 10만 원 단위), belowMin 이번 회차 최저가보다 낮음, title 근거.
 */
export interface ExpectedPrice {
  label: string;
  rate: number;
  price: number;
  belowMin: boolean;
  title: string;
}

/**
 * 법원경매 물건의 예상 낙찰가: 그 동의 매각가율(동 통계가 없거나 동에서 매각된 것이 없으면 구), 서울 전체 매각가율.
 * stats는 지역마다 읽은 시각 최근 순(가장 최근 것을 쓴다). 감정가나 통계가 없으면 그 값은 뺀다.
 */
export function expectedPrices(l: ListingView, stats: CourtRegionStat[]): ExpectedPrice[] {
  const a = l.auction;
  if (l.source !== 'courtauction' || !a?.appraisal) return [];
  const appraisal = a.appraisal;
  const min = l.prices[0]?.price ?? null;
  const latest = (area: string) => stats.find((s) => s.gu === area) ?? null;
  const make = (label: string, rate: number, s: CourtRegionStat, counts: { auctions: number; sold: number }): ExpectedPrice => {
    const price = Math.round((appraisal * rate) / 100 / 10) * 10;
    const belowMin = min != null && price < min;
    return {
      label,
      rate,
      price,
      belowMin,
      title: [
        `예상 낙찰가 ${manwon(price)} = 감정가 ${manwon(appraisal)} × ${label} 매각가율 ${rate}%`,
        `법원 지역별 매각통계 ${s.period}, 모든 용도, 경매 ${counts.auctions.toLocaleString('ko-KR')}건 중 매각 ${counts.sold.toLocaleString('ko-KR')}건(매각가 합 ÷ 감정가 합)`,
        ...(belowMin && min != null ? [`이번 회차 최저가 ${manwon(min)}보다 낮음`] : []),
      ].join('\n'),
    };
  };
  const out: ExpectedPrice[] = [];
  const guStat = a.gu ? latest(a.gu) : null;
  const dongStat = guStat && a.dong ? guStat.dongs.find((d) => d.name === a.dong) : undefined;
  if (guStat && dongStat && dongStat.sold > 0 && dongStat.amountRate > 0) out.push(make(`${dongStat.name} 평균`, dongStat.amountRate, guStat, dongStat));
  else if (guStat && guStat.sold > 0 && guStat.amountRate > 0) out.push(make(`${guStat.gu} 평균`, guStat.amountRate, guStat, guStat));
  const seoul = latest(SEOUL);
  if (seoul && seoul.amountRate > 0) out.push(make('서울 평균', seoul.amountRate, seoul, seoul));
  return out;
}

/** 온비드 통합검색(물건관리번호): 그 물건의 지금 회차가 나온다. */
const onbidSearchUrl = (mngNo: string) =>
  `https://www.onbid.co.kr/op/cltrpbancinf/toppagemng/unfsrch/UnfSrchController/mvmnUnfSrchClg.do?swd=${encodeURIComponent(mngNo)}&srvcDiv=search&bfhdDiv=Y`;

/**
 * '원본 열기' 주소(법원경매는 따로 연다).
 * 온비드 상세 주소에는 회차가 들어 있어서, 개찰일이 지났거나 목록에서 사라진 물건은 지난 회차 화면이나
 * '공매 보류 및 종결된 압류재산의 상세정보는 확인할 수 없습니다'가 뜬다. 그런 물건은 물건관리번호 통합검색으로 연다.
 */
export function originalUrl(l: ListingView): string {
  if (l.source !== 'onbid' || !l.auction) return l.url;
  const sale = saleDateOf(l);
  return l.status === 'gone' || (sale != null && sale < today()) ? onbidSearchUrl(l.auction.caseNo) : l.url;
}

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

/** 매각기일 칸 제목: day '10월 8일 (수)', when 'D-8', '오늘', '지남'. */
export function saleDay(date: string | null): { day: string; when: string; past: boolean } {
  if (!date) return { day: '매각기일 모름', when: '', past: false };
  const [y, m, d] = date.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  const [ty, tm, td] = today().split('-').map(Number);
  const days = Math.round((target - Date.UTC(ty, tm - 1, td)) / 86400000);
  const weekday = WEEKDAY[new Date(target).getUTCDay()];
  return { day: `${m}월 ${d}일 (${weekday})`, when: days > 0 ? `D-${days}` : days === 0 ? '오늘' : '지남', past: days < 0 };
}

/** 배당 순위 표시: danger 매우 주의(대항력 임차인과 앞 순위 청구), warn 대항력 임차인이나 임금채권(임차인 확인 전), muted 대항력 포기. */
export interface ClaimsChip {
  tone: 'danger' | 'warn' | 'muted';
  label: string;
  tip: string;
}

const dotDay = (d: string | null) => (d ? d.replace(/-/g, '.') : '모름');

/** 최우선 임금채권이 먼저인 경우의 조건 */
const WAGE_NOTE =
  '집주인(채무자)이 그 근로자의 사업주일 때만 해당합니다. 근로복지공단이 대지급금을 줬으면 공단이 그 순위를 이어받습니다(임금채권보장법 제8조, 대법원 2022. 12. 1. 선고 2018다300586).';

/**
 * 법원경매 물건의 배당 순위 표시. 볼 것이 없으면 null.
 * 대항력 임차인은 현황조사서 전입일이 최선순위 설정일보다 앞선 임차인이다(같은 날이면 설정이 먼저). 이사 나간 등기 임차인은
 * 조사서에 없어서 법원 비고의 대항력 문구(remarkSenior)로 본다. 그런 임차인이 있고 최우선 임금채권이나 세금 청구(당해세일 수 있음)가
 * 보이면 매우 주의, 없으면 대항력 임차인만 알린다. 대항력 포기 확약서가 들어왔으면 그것을 알린다.
 */
export function claimsChip(l: Pick<ListingView, 'auction'>): ClaimsChip | null {
  const c = l.auction?.claims;
  if (!c) return null;
  const known = !!(c.senior && c.survey);
  const seniorTenants = known ? c.survey!.tenants.filter((t) => t.moveIn != null && t.moveIn < c.senior!.date) : [];
  const others = known ? c.survey!.tenants.length - seniorTenants.length : 0;
  const remark = !!c.remarkSenior;
  const wageDocs = c.wage.filter((w) => w.date);
  const wageLines = (wageDocs.length ? wageDocs : c.wage).map((w) => `${w.what}${w.date ? ` ${dotDay(w.date)}` : ''}`);
  const taxText = [c.taxDocs ? `교부청구 ${c.taxDocs}건` : '', c.taxParties ? `교부권자와 압류권자 ${c.taxParties}곳` : ''].filter(Boolean).join(', ');
  const tenantLines = seniorTenants.map(
    (t) => `임차인: 전입 ${dotDay(t.moveIn)}, 확정일자 ${dotDay(t.fixed)}, 보증금 ${t.deposit ?? '모름'}${t.rent ? `, 차임 ${t.rent}` : ''}${t.part ? `, ${t.part}` : ''}`,
  );
  if (remark) tenantLines.push('법원 비고: 매수인에게 대항할 수 있는 임차인이나 임차권등기가 있다고 적혀 있음');
  // 일괄매각은 목록마다 날짜가 든 글 전체(right)가 오고, 대항력은 그중 가장 늦은 날(date)로 가린다.
  const seniorLine = c.senior ? `최선순위 설정: ${/\d{4}\./.test(c.senior.right) ? `${c.senior.right}(대항력은 ${dotDay(c.senior.date)} 기준)` : `${dotDay(c.senior.date)} ${c.senior.right}`}` : '';
  const footer = [`배당요구종기 ${dotDay(c.demandEnd)}, 사건 기록 ${dotDay(c.checkedAt)}${c.survey ? `, 현황조사서 ${dotDay(c.survey.at)}` : ''} 확인`];

  if (c.waiver) {
    return {
      tone: 'muted',
      label: '대항력 포기',
      tip: [
        `${dotDay(c.waiver)}에 대항력 포기 확약서가 들어왔습니다(보증기관이 임차인 보증금을 넘겨받은 사건에 흔함).`,
        '확약서를 낸 쪽이 낙찰자에게 남은 보증금을 청구하지 않겠다는 뜻이라, 누가 어느 보증금에 대해 냈는지 매각물건명세서와 문건으로 확인하세요.',
        ...(tenantLines.length ? ['', ...tenantLines, seniorLine] : []),
        '',
        ...footer,
      ].join('\n'),
    };
  }
  if (!known && !remark) {
    if (!c.wage.length || !c.tenantParties) return null;
    return {
      tone: 'warn',
      label: '임금채권',
      tip: [
        '최우선 임금채권으로 보이는 청구가 있습니다. 최종 3개월 임금과 최종 3년 퇴직금은 확정일자 임차인, 저당권, 세금보다 먼저 배당받습니다(근로기준법 제38조 제2항, 근로자퇴직급여 보장법 제12조 제2항).',
        WAGE_NOTE,
        ...wageLines,
        '',
        '대항력 있는 임차인이 있으면 그 임차인이 배당에서 덜 받고, 못 받은 보증금은 낙찰자가 떠안습니다.',
        `현황조사서는 매각기일 2주 전부터 열려 대항력은 아직 못 가렸습니다(이해관계인 중 임차인 ${c.tenantParties}명).`,
        '',
        ...footer,
      ].join('\n'),
    };
  }
  if (!seniorTenants.length && !remark) return null;
  const ahead: string[] = [];
  if (c.wage.length) ahead.push('최우선 임금채권(최종 3개월 임금, 최종 3년 퇴직금): 확정일자 임차인과 세금보다 먼저', `  ${WAGE_NOTE}`, ...wageLines.map((x) => `  ${x}`));
  if (taxText) {
    ahead.push(
      `세금과 공과금: ${taxText}`,
      '  법정기일이 임차인 확정일자보다 앞선 세금은 임차인보다 먼저입니다(국세기본법 제35조 제1항 제3호, 지방세기본법 제71조 제1항 제3호).',
      '  그 집에 매긴 당해세(재산세, 종합부동산세, 상속세, 증여세 등)는 법정기일이 더 늦어도 먼저입니다(국세기본법 제35조 제3항, 지방세기본법 제71조 제5항).',
      '  다만 주택 임차인은 2023년 개정으로 확정일자보다 법정기일이 늦은 당해세보다는 먼저 받습니다(국세기본법 제35조 제7항, 지방세기본법 제71조 제6항).',
    );
  }
  // 대항력은 있어도 확정일자가 최선순위 담보권(근저당 등)보다 늦으면 배당에서는 그 담보권이 먼저다.
  const late = c.senior && /저당|전세권|담보/.test(c.senior.right) ? seniorTenants.filter((t) => t.fixed && t.fixed > c.senior!.date) : [];
  if (late.length) {
    ahead.push(
      `최선순위 설정(${dotDay(c.senior!.date)}): 임차인 확정일자 ${late.map((t) => dotDay(t.fixed)).join(', ')}보다 앞서 먼저 배당받음(주택임대차보호법 제3조의2 제2항)`,
    );
  }
  if (others > 0) ahead.push(`다른 임차인 ${others}명: 소액임차인이면 보증금 중 일정액을 최우선변제로 먼저 받음(주택임대차보호법 제8조)`);
  const unpaid =
    seniorTenants.length && !c.tenantDocs
      ? ['임차인 쪽 배당요구 문건이 없습니다. 배당요구를 안 한 임차인은 배당을 받지 않아 보증금 전액을 떠안습니다(임차권등기를 한 임차인은 배당요구 없이도 배당받음).']
      : [];
  const danger = c.wage.length > 0 || !!taxText || late.length > 0;
  return {
    tone: danger ? 'danger' : 'warn',
    label: danger ? '매우 주의' : '대항력 임차인',
    tip: [
      '대항력 있는 임차인이 배당에서 보증금을 다 못 받으면 남은 돈은 낙찰자가 떠안습니다(주택임대차보호법 제3조의5, 상가건물 임대차보호법 제8조).',
      ...tenantLines,
      seniorLine,
      ...(ahead.length ? ['', '임차인보다 먼저 배당받을 수 있는 것', ...ahead] : []),
      '',
      '금액은 사건 기록에 없어 배당표가 나와야 압니다. 보증금을 다 떠안는다고 보고 값을 정하세요.',
      ...unpaid,
      '',
      ...footer,
    ].join('\n'),
  };
}
