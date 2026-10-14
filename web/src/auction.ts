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
