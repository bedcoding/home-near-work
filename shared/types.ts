// 서버와 화면이 함께 쓰는 타입. 금액 단위는 전부 만원이다.

export type SourceId = 'naver' | 'dabang' | 'zigbang' | 'ziptoss' | 'peterpanz' | 'gobang' | 'courtauction' | 'onbid' | 'betterliving' | 'mangrove' | 'celib';

/** 크롬 확장이 받은 화면 데이터로 매물을 읽는 사이트('조회하기'가 돌지 않음) */
export const CAPTURE_SOURCES: SourceId[] = ['naver', 'dabang', 'zigbang'];

export type DealType = 'monthly' | 'jeonse' | 'sale' | 'short' | 'auction';

/** 신탁 공매 공고를 모으는 부동산신탁사 */
export type TrustSourceId =
  | 'kbtrust' | 'koreit' | 'reitpia' | 'ktrust' | 'hanatrust' | 'shinhantrust' | 'mghat' | 'shinyoung' | 'wooriat' | 'daishin' | 'kyobotrust' | 'koramco';

/** 공고를 모으는 곳(가격이 없는 공매·임대 공고와 청약 공고, 집마다 올라오는 든든전세, LH 상가와 토지 공고, LH 선착순 계약). */
export type NoticeSourceId =
  | TrustSourceId
  | 'sh' | 'lh' | 'gobang' | 'myhome' | 'hugjeonse' | 'hugtrust' | 'applyhome' | 'shsale' | 'lhsale' | 'lhshop' | 'lhland' | 'lhfirst';

export const NOTICE_SOURCE_LABEL: Record<NoticeSourceId, string> = {
  kbtrust: 'KB부동산신탁 공매',
  koreit: '한국토지신탁 공매',
  reitpia: '대한토지신탁 공매',
  ktrust: '코리아신탁 공매',
  hanatrust: '하나자산신탁 공매',
  shinhantrust: '신한자산신탁 공매',
  mghat: '무궁화신탁 공매',
  shinyoung: '신영부동산신탁 공매',
  wooriat: '우리자산신탁 공매',
  daishin: '대신자산신탁 공매',
  kyobotrust: '교보자산신탁 공매',
  koramco: '코람코자산신탁 공매',
  sh: 'SH 임대 공고',
  lh: 'LH 임대 공고(서울)',
  gobang: '고방 청년과 공공 임대 공고',
  myhome: '마이홈 공공임대(서울, LH 외)',
  hugjeonse: 'HUG 든든전세주택',
  hugtrust: 'HUG 전월세 안심신탁 매물(서울)',
  applyhome: '청약홈 청약(서울)',
  shsale: 'SH 공공분양',
  lhsale: 'LH 공공분양(서울)',
  lhshop: 'LH 상가 공고(서울)',
  lhland: 'LH 토지 공고(서울)',
  lhfirst: 'LH 선착순 계약(서울)',
};

/** 공고 줄과 알림에 쓰는 짧은 출처 이름 */
export const NOTICE_SHORT: Record<NoticeSourceId, string> = {
  sh: 'SH',
  lh: 'LH',
  gobang: '고방',
  myhome: '마이홈',
  hugjeonse: 'HUG 든든전세',
  hugtrust: 'HUG 안심신탁',
  kbtrust: 'KB부동산신탁',
  koreit: '한국토지신탁',
  reitpia: '대한토지신탁',
  ktrust: '코리아신탁',
  hanatrust: '하나자산신탁',
  shinhantrust: '신한자산신탁',
  mghat: '무궁화신탁',
  shinyoung: '신영부동산신탁',
  wooriat: '우리자산신탁',
  daishin: '대신자산신탁',
  kyobotrust: '교보자산신탁',
  koramco: '코람코자산신탁',
  applyhome: '청약홈',
  shsale: 'SH',
  lhsale: 'LH',
  lhshop: 'LH',
  lhland: 'LH',
  lhfirst: 'LH 선착순',
};

/**
 * 공고가 보이는 탭: rent 임대 공고 탭, trust 경매 탭(신탁 공매), subscription 청약 탭,
 * shop 경매 탭 상가 칸(LH 상가), land 경매 탭 토지 칸(LH 토지).
 */
export type NoticeSection = 'rent' | 'trust' | 'subscription' | 'shop' | 'land';

/** 곳마다 공고가 보이는 탭. 청약홈과 LH 선착순 계약은 공고마다 다르다(noticeSection). */
const SOURCE_SECTIONS: Record<NoticeSourceId, NoticeSection[]> = {
  sh: ['rent'],
  lh: ['rent'],
  gobang: ['rent'],
  myhome: ['rent'],
  hugjeonse: ['rent'],
  hugtrust: ['rent'],
  kbtrust: ['trust'],
  koreit: ['trust'],
  reitpia: ['trust'],
  ktrust: ['trust'],
  hanatrust: ['trust'],
  shinhantrust: ['trust'],
  mghat: ['trust'],
  shinyoung: ['trust'],
  wooriat: ['trust'],
  daishin: ['trust'],
  kyobotrust: ['trust'],
  koramco: ['trust'],
  applyhome: ['subscription', 'rent'],
  shsale: ['subscription'],
  lhsale: ['subscription'],
  lhshop: ['shop'],
  lhland: ['land'],
  lhfirst: ['subscription', 'rent', 'shop', 'land'],
};

/** 그 탭에 공고가 보일 수 있는 곳 */
export const noticeSourcesOf = (section: NoticeSection) =>
  (Object.keys(SOURCE_SECTIONS) as NoticeSourceId[]).filter((s) => SOURCE_SECTIONS[s].includes(section));

/** 청약홈은 종류에 '임대'가 있으면 임대 공고, LH 선착순 계약은 종류(선착순 토지, 상가, 분양주택, 그 밖의 임대)로 나눈다. */
export function noticeSection(n: { source: NoticeSourceId; kind: string | null }): NoticeSection {
  const kind = n.kind ?? '';
  if (n.source === 'applyhome' && /임대/.test(kind)) return 'rent';
  if (n.source === 'lhfirst') return /토지/.test(kind) ? 'land' : /상가/.test(kind) ? 'shop' : /분양주택/.test(kind) ? 'subscription' : 'rent';
  return SOURCE_SECTIONS[n.source][0];
}

/** 켜진 지역 근처 구로 거르는 공고(임대 공고와 상가, 토지). 청약과 공매는 거르지 않는다. */
export const regionalSection = (section: NoticeSection) => section === 'rent' || section === 'shop' || section === 'land';

/** 고방에서 다른 사이트 월세와 같은 종류인 유형(중개사 매물). 유형이 이것뿐이면 매매·전월세 쪽에 둔다. */
const GOBANG_HOME_TYPES = ['원·투룸', '오피스텔'];

/** 매물이 모두 경매 탭(법원경매·온비드 공매)이나 고시원·쉐어 탭(코리빙)에만 보이는 사이트 */
const SECTION_OF_SOURCE: Partial<Record<SourceId, 'auction' | 'room'>> = {
  courtauction: 'auction',
  onbid: 'auction',
  betterliving: 'room',
  mangrove: 'room',
  celib: 'room',
};

/** 매매·전월세 매물이 있는 사이트(사이트 칸에 넣는 곳) */
export const hasHomeListings = (source: SourceId) => !SECTION_OF_SOURCE[source];

/** 경매 물건 중 상업용(상가) 검색으로 모은 것은 buildingType을 이 글자로 시작한다('상업용: 근린시설'). */
export const SHOP_PREFIX = '상업용: ';
/** 경매 물건 중 땅만 파는 것(목록이 모두 토지)은 buildingType을 이 글자로 시작한다('토지: 대지'). */
export const LAND_PREFIX = '토지: ';

/**
 * 매물이 보이는 곳: home 매매와 전월세(한눈에, 새 소식), auction 경매 탭(주거), shop 경매 탭의 상가, land 경매 탭의 토지,
 * room 고시원과 쉐어 탭(코리빙, 고방의 원룸, 투룸, 오피스텔이 아닌 것).
 */
export function listingSection(l: { source: SourceId; buildingType: string | null }): 'home' | 'auction' | 'shop' | 'land' | 'room' {
  const fixed = SECTION_OF_SOURCE[l.source];
  if (fixed === 'auction' && (l.buildingType ?? '').startsWith(SHOP_PREFIX)) return 'shop';
  if (fixed === 'auction' && (l.buildingType ?? '').startsWith(LAND_PREFIX)) return 'land';
  if (fixed) return fixed;
  if (l.source !== 'gobang') return 'home';
  const types = (l.buildingType ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return types.length && types.every((t) => GOBANG_HOME_TYPES.includes(t)) ? 'home' : 'room';
}

/** 공고의 지역(구 이름)이 켜진 지역 근처 구에 드는지. 구를 모르는 공고(서울 전체 등)는 든다고 본다. */
export const inGus = (regions: string[], gus: string[]) => regions.length === 0 || regions.some((r) => gus.includes(r));

/**
 * 공고가 켜 둔 지역 바로 근처일 가능성이 높으면 그 까닭, 아니면 null.
 * 제목이나 지역 글자에 근처 역과 지역 이름(names, '역'을 뺀 것)이 들었거나, 모집 지역(구)이 모두 근처 구(gus)일 때 높다고 본다.
 */
export function nearReason(n: { title: string; place?: string | null; regions?: string[] }, gus: string[], names: string[]): string | null {
  const text = `${n.title} ${n.place ?? ''}`;
  const name = names.find((x) => x.length >= 2 && text.includes(x));
  if (name) return `'${name}' 들어 있음`;
  const regions = n.regions ?? [];
  if (regions.length && regions.every((r) => gus.includes(r))) return `모집 지역 ${regions.join(', ')}`;
  return null;
}

/** 청약 공고 상세. 금액은 만원. */
export interface SubscriptionDetail {
  /** 공급 위치(주소) */
  address: string | null;
  /** 공급 세대수 */
  households: number | null;
  /** 주택형별 공급금액(최고가 기준) 가운데 가장 낮은 값·높은 값 */
  priceMin: number | null;
  priceMax: number | null;
  /** 입주 예정월 'YYYY.MM' */
  moveIn: string | null;
  /** 당첨자 발표일 YYYY-MM-DD */
  winnersAt: string | null;
  /** 시공사(없으면 시행사) */
  builder: string | null;
}

/** 공고 줄에 칸을 따로 두고 보이는 숫자(든든전세 집마다의 보증금·면적 등). 금액은 만원. */
export interface NoticeFacts {
  /** label: '전세'·'최저가' 등 */
  amount: { label: string; value: number } | null;
  areaM2: number | null;
  /** 그 밖의 짧은 값('신청 74명') */
  note: string | null;
}

export interface NoticeView {
  id: number;
  source: NoticeSourceId;
  title: string;
  url: string | null;
  /** 진행 상태(진행중·유찰·모집중·공고중 등) */
  status: string | null;
  /** 종류(오피스텔·행복주택·무순위 등) */
  kind: string | null;
  place: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 그 곳을 마지막으로 모았을 때도 목록에 있었다. 아니면 상태는 마지막으로 본 때 기준이다. */
  current: boolean;
  isNew: boolean;
  /** 모집 지역의 서울 구 이름. 비어 있으면 모름 또는 서울 전체. */
  regions: string[];
  /** regions를 같은 제목의 다른 곳 공고(고방)에서 가져왔으면 그 곳 */
  regionsFrom: NoticeSourceId | null;
  /** 접수 기간(YYYY-MM-DD). 모르면 null. */
  period: { start: string; end: string } | null;
  /** 청약 공고 상세(청약홈). */
  detail: SubscriptionDetail | null;
  facts: NoticeFacts | null;
}

/** 공고 수집 곳별 마지막 결과. */
export interface NoticeSourceStatus {
  at: string;
  ok: boolean;
  count: number;
  error: string | null;
}

export const DEAL_LABEL: Record<DealType, string> = {
  monthly: '월세',
  jeonse: '전세',
  sale: '매매',
  short: '단기',
  auction: '경매',
};

/** 사이트 탭 순서도 이 순서를 따른다. */
export const SOURCE_LABEL: Record<SourceId, string> = {
  naver: '네이버',
  dabang: '다방',
  zigbang: '직방',
  ziptoss: '집토스',
  peterpanz: '피터팬',
  gobang: '고방',
  courtauction: '법원경매',
  onbid: '온비드',
  betterliving: '에피소드',
  mangrove: '맹그로브',
  celib: '셀립',
};

export interface PriceOption {
  deal: DealType;
  deposit: number | null; // 보증금(전세금)
  monthly: number | null; // 월세
  price: number | null; // 매매가, 경매 최저가
}

/** 수집기가 사이트 데이터를 공통 형식으로 바꾼 결과. 모르는 값은 null로 둔다. */
export interface NormalizedListing {
  source: SourceId;
  sourceId: string;
  url: string;
  title: string;
  thumbnail: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  dong: string | null;
  /** 사이트 안에서 건물을 구분하는 값. 재등록 판정에 쓴다. */
  buildingKey: string | null;
  buildingType: string | null;
  roomLabel: string | null;
  rooms: number | null;
  areaM2: number | null;
  floor: number | null;
  totalFloors: number | null;
  basement: boolean | null;
  rooftop: boolean | null;
  builtYear: number | null;
  maintenance: number | null;
  elevator: boolean | null;
  parking: boolean | null;
  availableFrom: string | null;
  updatedAt: string | null;
  prices: PriceOption[];
  /** 사이트가 준 원래 값과 도구가 바꾼 값을 나란히 보여 주기 위한 표. */
  explain?: ExplainRow[];
}

export interface ExplainRow {
  label: string;
  /** 사이트 데이터의 어느 항목에서 왔는지와 그 원래 값 */
  raw: string;
  /** 도구가 저장한 값 */
  value: string;
  note?: string;
}

export interface RequestRow {
  at: string;
  source: string;
  kind: 'page' | 'data' | 'action';
  url: string;
  status: number | null;
  note: string | null;
}

export interface ExcludedRow {
  source: string;
  sourceId: string;
  title: string;
  priceText: string;
  address: string | null;
  distanceM: number | null;
  areaName: string | null;
  url: string;
}

export interface Area {
  id: number;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  enabled: boolean;
}

export interface Station {
  name: string;
  label: string;
  lat: number;
  lng: number;
  /** 역이 있는 자치구(서울 밖은 시·군) */
  gu?: string;
  /** 직방 지하철역 번호(바로 가기 주소에 씀) */
  zigbangId?: string;
  /** 역에서 가까운 호갱노노 단지 번호(바로 가기를 그 단지 화면으로 열어 지도를 이 근처로 맞춘다) */
  hogangnonoApt?: string;
  /** 서울·경기·인천 등 */
  sido?: string;
}

export type Verdict = 'discard' | 'star';

export type PriceChangeType = 'price_down' | 'price_up' | 'price_changed';

export interface SeenRef {
  runId: number;
  pageUrl: string | null;
  screenshot: string | null;
}

export interface ListingView extends NormalizedListing {
  id: string;
  identityKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: 'active' | 'gone';
  verdict: Verdict | null;
  verdictReason: string | null;
  /** 확인하지 않은 '신규' 표시가 있다. */
  isNew: boolean;
  priceChange: { type: PriceChangeType; before: PriceOption[]; after: PriceOption[]; at: string } | null;
  /** 버림한 매물과 같은 집으로 판정돼 자동으로 숨긴 경우, 원래 매물 id. */
  relistedOf: string | null;
  /** 버림한 매물과 위치·층·면적이 비슷하다. */
  similarToDiscarded: boolean;
  seenRef: SeenRef | null;
  /**
   * 법원경매·온비드만. 법원·사건번호('2024타경12345')·물건번호는 다른 경매 사이트 주소를 만들 때 쓴다(온비드는 court '온비드', caseNo 물건관리번호).
   * appraisal 감정가(만원, 모르면 null), failed 유찰 횟수, lots 함께 매각하는 목록 수(1이면 단독).
   * mgmt: 법원경매 물건 비고에 관리단이나 관리비 이야기가 있으면 짧은 이름표('관리단 유치권 1,500만')와 비고 전문.
   * share: 땅만 파는 법원경매 물건 중 지분 매각(목록 글자에 'N분의 M')
   * gu와 dong: 법원경매 물건 소재지의 구와 법정동('역삼동', 지역별 매각통계의 이름과 같음). 온비드는 null.
   */
  auction: {
    court: string;
    caseNo: string;
    itemNo: string;
    appraisal: number | null;
    failed: number;
    lots: number;
    mgmt: { label: string; text: string } | null;
    share: boolean;
    gu: string | null;
    dong: string | null;
  } | null;
  /**
   * 옵션(가전, 가구). list는 사이트가 준 옵션 목록(집토스, 빈 배열이면 옵션 없음, 모르면 null),
   * full은 풀옵션 표시(집토스, 피터팬, 제목이나 소개 글의 '풀옵션'). 아무것도 모르면 null.
   */
  options: { list: string[] | null; full: boolean } | null;
}

/** 경매 탭 칸(주거, 상가, 토지)에 맞춘 매각 결과 종류. other는 산업용, 용도복합용 등 세 칸에 들지 않는 것. */
export type AuctionResultKind = 'home' | 'shop' | 'land' | 'other';

/**
 * 법원경매 물건 하나의 매각기일 결과. 금액은 만원.
 * key: 법원 코드-사건 번호-물건번호('B000211-20250130051286-1'), 대시보드가 모은 매물이면 listingId가 그 매물.
 * status: 법원 물건 상태 이름('매각', '유찰', '매각허가결정', '매각불허가결정', '대금납부', '대금미납', '매각허가취소결정'),
 * 경매사건검색으로 볼 때 그 날 뒤 기일로 넘어가 있었으면 '기일 넘어감'.
 * sold: 낙찰가가 있는 결과(매각, 매각허가결정, 대금납부, 대금미납, 매각허가취소결정).
 * via: result 매각결과검색(매각기일 다음 날부터 7일 동안 나옴), case 경매사건검색.
 */
export interface AuctionResultView {
  key: string;
  saleDate: string;
  court: string;
  caseNo: string;
  itemNo: string;
  gu: string | null;
  dong: string | null;
  address: string | null;
  usage: string | null;
  kind: AuctionResultKind;
  areaM2: number | null;
  lots: number;
  failed: number | null;
  appraisal: number | null;
  minPrice: number | null;
  amount: number | null;
  status: string;
  sold: boolean;
  lat: number | null;
  lng: number | null;
  via: 'result' | 'case';
  listingId: string | null;
}

/** 지역별 매각통계와 매각 결과 요약에서 서울 전체를 가리키는 이름(구 이름 자리에 쓴다) */
export const SEOUL = '서울';

/** 비율(%) 여러 개의 요약: count 센 수, median 중간값, mean 평균, min 가장 낮은 값, max 가장 높은 값 */
export interface RatioStats {
  count: number;
  median: number;
  mean: number;
  min: number;
  max: number;
}

/**
 * 최근 1년 법원경매 매각 결과 요약(지역 하나, 종류 하나). area는 구 이름이나 SEOUL(서울 전체).
 * held 그 날 매각이 열린 결과 수(낙찰, 유찰, 불허가), sold 낙찰 수, from과 to는 그중 가장 이른 매각기일과 늦은 매각기일(YYYY-MM-DD).
 * appraisal 낙찰가 ÷ 감정가, weighted 낙찰가 합 ÷ 감정가 합(%), minPrice 낙찰가 ÷ 그 회차 최저가,
 * minPriceByFailed 낙찰가 ÷ 그 회차 최저가를 그때까지 유찰 횟수('0', '1', '2', '3+')별로. 낙찰이 없으면 null이나 빈 배열.
 */
export interface AuctionResultSummary {
  area: string;
  kind: AuctionResultKind;
  held: number;
  sold: number;
  from: string | null;
  to: string | null;
  appraisal: RatioStats | null;
  weighted: number | null;
  minPrice: RatioStats | null;
  minPriceByFailed: { failed: string; stats: RatioStats }[];
}

/**
 * 법원 지역별 매각통계 한 번(구 하나나 서울 전체, 검색 기간 하나, 모든 용도). gu는 구 이름이나 SEOUL.
 * period는 검색 기간('2025.09 ~ 2026.10'), at은 읽은 시각(ISO).
 * auctions 경매 건수(유찰 포함), sold 매각 건수, soldRate 매각률(%), amountRate 매각가율(매각가 합 ÷ 감정가 합, %).
 * dongs는 동별(서울 전체면 구별) 같은 숫자.
 */
export interface CourtRegionStat {
  gu: string;
  period: string;
  at: string;
  auctions: number;
  sold: number;
  soldRate: number;
  amountRate: number;
  dongs: { name: string; auctions: number; sold: number; soldRate: number; amountRate: number }[];
}

export interface RunSourceSummary {
  source: SourceId;
  status: 'ok' | 'error';
  fetched: number;
  kept: number;
  newCount: number;
  priceChanged: number;
  relisted: number;
  baselineAreas: string[];
  error?: string;
}

export interface RunSummary {
  sources: RunSourceSummary[];
  newCount: number;
  changedCount: number;
}

export interface RunInfo {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  /** stopped: 사용자가 중단함 */
  status: 'running' | 'done' | 'error' | 'stopped';
  visible: boolean;
  /** 자동 확인으로 시작한 조회 */
  auto: boolean;
  /** 공고만 확인한 조회(매물 사이트는 안 돎) */
  noticesOnly: boolean;
  summary: RunSummary | null;
  error: string | null;
}

/** 자동 확인(정한 요일과 시각에 '조회하기'와 같은 조회). */
export interface AutoCheckState {
  /** 'HH:MM'(이 컴퓨터 시각). 끄면 null. */
  time: string | null;
  /** 요일(0 일요일 ~ 6 토요일). null이면 매일. */
  day: number | null;
  /** 자동 확인 때 조회용 브라우저 창을 띄울지 */
  visible: boolean;
  /** 공고만 매일 확인하는 시각('HH:MM', 창 없이). 끄면 null. */
  noticeTime: string | null;
  /** 마지막 확인 시각에 대시보드가 꺼져 있어 못 했고, 그 뒤로 조회도 하지 않았다 */
  missed: boolean;
}

/** 조회가 끝나면 띄울 알림 고르기('조회하기'와 자동 확인 모두). 금액은 만원, null이면 제한 없음. */
export interface AlertSettings {
  /** 매매·전월세 새 매물: 거래 유형마다 켜기와 상한 */
  monthly: { on: boolean; monthlyMax: number | null; depositMax: number | null };
  jeonse: { on: boolean; depositMax: number | null };
  short: { on: boolean; monthlyMax: number | null };
  sale: { on: boolean; priceMax: number | null };
  /** 고시원과 쉐어 새 방(월세 상한은 가장 싼 방 기준) */
  rooms: { on: boolean; monthlyMax: number | null };
  /** 경매(법원경매, 온비드) 새 물건(주거), 최저가 상한 */
  auction: { on: boolean; priceMax: number | null };
  /** 상가 경매 새 물건, 최저가 상한(만원)과 면적 상한(㎡) */
  shopAuction: { on: boolean; priceMax: number | null; areaMax: number | null };
  /** 토지 경매(땅만 파는 물건) 새 물건, 최저가 상한(만원)과 면적 상한(㎡, 지분이면 지분만큼) */
  landAuction: { on: boolean; priceMax: number | null; areaMax: number | null };
  /** 임대 공고(켜진 지역 근처) */
  rentNotices: boolean;
  /** 신탁 공매 공고 */
  trustNotices: boolean;
  subscriptions: boolean;
  /** LH 상가 공고와 선착순 상가(켜진 지역 근처) */
  shopNotices: boolean;
  /** LH 토지 공고와 선착순 토지(켜진 지역 근처) */
  landNotices: boolean;
  /** 위 매물 조건에 맞는 매물의 가격 변동 */
  priceChanges: boolean;
  /** 매물 사이트 수집 실패 */
  failures: boolean;
  /** 매물은 켜진 지역 반경 안만 센다 */
  insideAreas: boolean;
  /** 크롬 확장으로 본 사이트(다방 새 방, KB·네이버 늘어난 매물 수) */
  captureSites: boolean;
}

/** 크롬 확장으로 본 사이트의 마지막 확인 결과(사이트 탭에 보임). text: '새 방 2', '역삼동 120 → 125', '변화 없음' 등 */
export interface CaptureNews {
  at: string;
  text: string;
  /** 새 방이나 늘어난 매물이 있었다 */
  hot: boolean;
}

export interface RunProgress {
  runId: number;
  message: string;
  log: string[];
  /** 중단을 눌러 멈추는 중 */
  stopping: boolean;
}

/** 소스 하나를 마지막으로 조회한 결과. */
export interface SourceRunInfo {
  /** 그 조회가 끝난 시각 */
  at: string;
  status: 'ok' | 'error';
  kept: number;
  error: string | null;
}

export interface RunDetail extends RunInfo {
  log: string[];
  screenshots: { source: string; label: string; file: string }[];
  requests: RequestRow[];
  excluded: ExcludedRow[];
}

export interface AppState {
  /** 확인하지 않은 새 공고 수 */
  newNotices: number;
  areas: Area[];
  stations: Station[];
  running: RunProgress | null;
  lastRun: RunInfo | null;
  /** 소스마다 그 소스가 들어간 마지막 조회 결과(경매만 조회처럼 일부만 돈 조회가 있어서 따로 둔다) */
  lastBySource: Partial<Record<SourceId, SourceRunInfo>>;
  unackedCount: number;
  /** 크롬 확장이 보낸 네이버 화면 데이터 현황. */
  naverCapture: { total: number; lastAt: string | null; snapshots: number };
  /** 크롬 확장이 보낸 화면 데이터 수(사이트별). */
  captureSites: { site: string; total: number; lastAt: string | null }[];
  /** 지역을 마지막으로 바꾼 시각(대시보드·크롬 확장 어느 쪽이든). 확장이 어느 쪽 목록을 따를지 정할 때 쓴다. */
  areasUpdatedAt: string | null;
  autoCheck: AutoCheckState;
  alerts: AlertSettings;
  /** 크롬 확장 사이트(dabang·kbland·naver)마다 마지막 확인 결과 */
  captureNews: Partial<Record<string, CaptureNews>>;
  /** 켜진 지역 근처 서울 구(임대 공고를 지역으로 거를 때 쓴다) */
  gus: string[];
  /** 켜진 지역 바로 근처의 역과 지역 이름('역' 뺌). 공고 제목에 들었으면 '근처'로 표시한다(nearReason). */
  nearNames: string[];
}
