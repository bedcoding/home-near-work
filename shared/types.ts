// 서버와 화면이 함께 쓰는 타입. 금액 단위는 전부 만원이다.

import type { Filters } from './filters.js';

export type SourceId = 'naver' | 'dabang' | 'zigbang' | 'ziptoss' | 'peterpanz' | 'gobang' | 'courtauction' | 'onbid' | 'betterliving' | 'mangrove' | 'celib';

/** 크롬 확장이 받은 화면 데이터로 매물을 읽는 사이트('조회하기'가 돌지 않음) */
export const CAPTURE_SOURCES: SourceId[] = ['naver', 'dabang', 'zigbang'];

export type DealType = 'monthly' | 'jeonse' | 'sale' | 'short' | 'auction';

/** 신탁 공매 공고를 모으는 부동산신탁사 */
export type TrustSourceId =
  | 'kbtrust' | 'koreit' | 'reitpia' | 'ktrust' | 'hanatrust' | 'shinhantrust' | 'mghat' | 'shinyoung' | 'wooriat' | 'daishin' | 'kyobotrust' | 'koramco';

/** 공고를 모으는 곳(가격이 없는 공매, 임대 공고와 청약 공고, 집마다 올라오는 든든전세, LH 상가와 토지 공고, LH 선착순 계약). */
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

/** 탭 하나만 조회하는 범위(조회하기 옆 ▾ 메뉴, 경매 탭의 '경매 조회하기') */
export type RunScope = 'home' | 'auction' | 'room' | 'rent' | 'subscription';

/**
 * 범위마다 도는 매물 사이트(sources)와 공고 탭(sections, 그 탭에 공고가 보일 수 있는 곳을 모두 돈다). tabs는 그 범위가 채우는 탭.
 * 네이버, 다방, 직방은 크롬 확장이 모으므로 어느 범위에도 들지 않는다.
 */
export const RUN_SCOPES: { id: RunScope; label: string; tabs: string[]; sources: SourceId[]; sections: NoticeSection[] }[] = [
  { id: 'home', label: '매물', tabs: ['overview'], sources: ['ziptoss', 'peterpanz', 'gobang'], sections: [] },
  { id: 'auction', label: '경매, 집터, 서울 아파트', tabs: ['auction', 'plot', 'apt'], sources: ['courtauction', 'onbid'], sections: ['trust', 'shop', 'land'] },
  { id: 'room', label: '고시원과 쉐어', tabs: ['rooms'], sources: ['gobang', 'betterliving', 'mangrove', 'celib'], sections: [] },
  { id: 'rent', label: '임대 공고', tabs: ['notices'], sources: [], sections: ['rent'] },
  { id: 'subscription', label: '청약', tabs: ['subs'], sources: [], sections: ['subscription'] },
];

/** 청약홈은 종류에 '임대'가 있으면 임대 공고, LH 선착순 계약은 종류(선착순 토지, 상가, 분양주택, 그 밖의 임대)로 나눈다. */
export function noticeSection(n: { source: NoticeSourceId; kind: string | null }): NoticeSection {
  const kind = n.kind ?? '';
  if (n.source === 'applyhome' && /임대/.test(kind)) return 'rent';
  if (n.source === 'lhfirst') return /토지/.test(kind) ? 'land' : /상가/.test(kind) ? 'shop' : /분양주택/.test(kind) ? 'subscription' : 'rent';
  return SOURCE_SECTIONS[n.source][0];
}

/** 켜진 지역 근처 구로 거르는 공고(임대 공고와 상가, 토지). 청약과 공매는 거르지 않는다. */
export const regionalSection = (section: NoticeSection) => section === 'rent' || section === 'shop' || section === 'land';

/** 고방에서 다른 사이트 월세와 같은 종류인 유형(중개사 매물). 유형이 이것뿐이면 매매와 전월세 쪽에 둔다. */
const GOBANG_HOME_TYPES = ['원·투룸', '오피스텔'];

/** 매물이 모두 경매 탭(법원경매, 온비드 공매)이나 고시원, 쉐어 탭(코리빙)에만 보이는 사이트 */
const SECTION_OF_SOURCE: Partial<Record<SourceId, 'auction' | 'room'>> = {
  courtauction: 'auction',
  onbid: 'auction',
  betterliving: 'room',
  mangrove: 'room',
  celib: 'room',
};

/** 매매와 전월세 매물이 있는 사이트(사이트 칸에 넣는 곳) */
export const hasHomeListings = (source: SourceId) => !SECTION_OF_SOURCE[source];

/** 경매 물건 중 상업용(상가) 검색으로 모은 것은 buildingType을 이 글자로 시작한다('상업용: 근린시설'). */
export const SHOP_PREFIX = '상업용: ';
/** 경매 물건 중 땅만 파는 것(목록이 모두 토지)은 buildingType을 이 글자로 시작한다('토지: 대지'). */
export const LAND_PREFIX = '토지: ';

/**
 * 매물이 보이는 곳: home 매매와 전월세(매물 탭), auction 경매 탭(주거), shop 경매 탭의 상가, land 경매 탭의 토지,
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
  /** 주택형별 공급금액(최고가 기준) 가운데 가장 낮은 값, 높은 값 */
  priceMin: number | null;
  priceMax: number | null;
  /** 입주 예정월 'YYYY.MM' */
  moveIn: string | null;
  /** 당첨자 발표일 YYYY-MM-DD */
  winnersAt: string | null;
  /** 시공사(없으면 시행사) */
  builder: string | null;
}

/** 공고 줄에 칸을 따로 두고 보이는 숫자(든든전세 집마다의 보증금, 면적 등). 금액은 만원. */
export interface NoticeFacts {
  /** label: '전세', '최저가' 등 */
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
  /** 진행 상태(진행중, 유찰, 모집중, 공고중 등) */
  status: string | null;
  /** 종류(오피스텔, 행복주택, 무순위 등) */
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
  /** 신탁 공매 공고의 첨부 공고문을 읽은 결과(아직 안 읽었으면 없음) */
  doc?: TrustDocView | null;
}

/** 신탁 공매 공고문의 한 차수. 날짜는 YYYY-MM-DD, 금액은 만원. */
export interface TrustDocRound {
  no: number;
  /** 입찰(공매) 날짜 */
  bid: string | null;
  /** 개찰 날짜 */
  open: string | null;
  /** 최저입찰가(공매예정가격). 물건이 여럿이면 그 차수에서 가장 낮은 값. */
  price: number | null;
  /** 이 차수에 적힌 가격 수(호실이 여럿이면 2 이상) */
  count: number;
}

/** 신탁 공매 공고의 첨부 공고문(PDF, 한글)을 받아 읽은 결과. */
export interface TrustDocView {
  name: string;
  /** 공고문 주소(받을 때 POST가 필요한 곳은 null) */
  url: string | null;
  readAt: string;
  rounds: TrustDocRound[];
  /** 읽은 글자 줄 수(0이면 그림만 든 PDF 등) */
  lines: number;
  /** 그림 PDF라 글자 인식으로 읽음(숫자가 틀릴 수 있음) */
  ocr: boolean;
  /** 받거나 읽지 못한 까닭 */
  error: string | null;
}

/** 직접 받은 공고 첨부 파일에서 켜 둔 지역 근처나 근처 구가 나온 줄. */
export interface NoticeFileLine {
  /** 줄 글자. 표는 칸을 ' | '로 잇는다. */
  text: string;
  /** near: 근처 동이나 역, 지역 이름(match)이 들어 있음, gu: 근처 구 이름만 들어 있음 */
  level: 'near' | 'gu';
  match: string;
  /** 그 줄 위에서 가장 가까운 표 머리 줄(주소, 보증금 같은 칸 이름). 없으면 null. */
  header: string | null;
}

/** 직접 받은 공고 첨부 파일 하나를 읽은 결과. 근처 판단은 지금 켜 둔 지역 기준이다. */
export interface NoticeFileView {
  id: number;
  name: string;
  /** 받을 때 열려 있던 공고 화면 주소나 파일 이름으로 찾은 공고. 못 찾으면 null. */
  noticeId: number | null;
  noticeTitle: string | null;
  downloadedAt: string;
  /** ok: 읽음, unsupported: 읽을 수 없는 형식(까닭 error), error: 읽다가 실패 */
  status: 'ok' | 'unsupported' | 'error';
  error: string | null;
  /** 파일에서 읽은 줄 수 */
  lineCount: number;
  /** 근처 동이나 이름이 나온 줄 수, 근처 구 이름만 나온 줄 수 */
  nearCount: number;
  guCount: number;
  /** 서울 구마다 그 구 이름이 나온 줄 수(많은 순) */
  byGu: { gu: string; count: number }[];
  /** 근처 줄(near 먼저, 파일 순서), 100줄까지 */
  lines: NoticeFileLine[];
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
  /** 역이 있는 자치구(서울 밖은 시, 군) */
  gu?: string;
  /** 직방 지하철역 번호(바로 가기 주소에 씀) */
  zigbangId?: string;
  /** 역에서 가까운 호갱노노 단지 번호(바로 가기를 그 단지 화면으로 열어 지도를 이 근처로 맞춘다) */
  hogangnonoApt?: string;
  /** 서울과 경기, 인천 등 */
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
  /** 버림한 매물과 위치, 층, 면적이 비슷하다. */
  similarToDiscarded: boolean;
  seenRef: SeenRef | null;
  /**
   * 법원경매, 온비드만. 법원, 사건번호('2024타경12345'), 물건번호는 다른 경매 사이트 주소를 만들 때 쓴다(온비드는 court '온비드', caseNo 물건관리번호).
   * appraisal 감정가(만원, 모르면 null), failed 유찰 횟수, lots 함께 매각하는 목록 수(1이면 단독).
   * mgmt: 법원경매 물건 비고에 관리단이나 관리비 이야기가 있으면 짧은 이름표('관리단 유치권 1,500만')와 비고 전문.
   * share: 지분 매각(집이나 땅 전체가 아니라 일부 지분만 팔아 다른 공유자가 있음). 법원경매는 집합건물이 아닌 목록 글자의 'N분의 M', '지분'이나
   * 비고의 '지분', '공유자', 온비드는 물건명의 '지분'으로 본다.
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
    /** 법원경매 물건의 배당 순위 확인(court-claims). 아직 안 봤거나 온비드면 null. */
    claims: CourtClaims | null;
  } | null;
  /**
   * 옵션(가전, 가구). list는 사이트가 준 옵션 목록(집토스, 빈 배열이면 옵션 없음, 모르면 null),
   * full은 풀옵션 표시(집토스, 피터팬, 제목이나 소개 글의 '풀옵션'). 아무것도 모르면 null.
   */
  options: { list: string[] | null; full: boolean } | null;
  /** 서울 아파트면 구, 단지, 세대수(AptInfo). 아니면 null. */
  apt: AptInfo | null;
  /** 경매와 공매(단독주택 갈래, 토지, 아파트, 빌라)나 네이버 서울 아파트 매매면 재개발 구역 확인 정보(PlotZone). 아니면 null. */
  zone: PlotZone | null;
  /** 서울 아파트 경매와 공매와 네이버 매매면 같은 단지, 같은 전용면적의 국토부 실거래 비교(TradeRef). 그런 거래가 없거나 다른 매물이면 null. */
  trade: TradeRef | null;
  /** 사는 매물(매매, 경매, 공매)의 좌표가 정비사업 구역(서울플랜+ 파일) 안이면 그 구역들과 파일의 작성일. 아니면 null. */
  redev: { hits: RedevHit[]; fileDate: string | null } | null;
}

/**
 * 법원경매 물건에서 배당 때 대항력 임차인보다 먼저 받을 수 있는 청구와 대항력 임차인(court-claims). 날짜는 YYYY-MM-DD.
 * checkedAt 사건 기록(이해관계인, 문건 처리 내역)을 본 날, demandEnd 배당요구종기.
 * wage: 최우선 임금채권으로 보이는 것(가려진 이름이 근로복지공단 모양인 이해관계인, 임금, 퇴직금, 대지급금 문건). what은 역할과 문건 종류만(이름 없음).
 * taxDocs 교부청구 문건 수, taxParties 교부권자와 압류권자 수, tenantParties 임차인, 임차권자, 전세권자 수,
 * tenantDocs 임차인 쪽 권리신고나 배당요구 문건 수, waiver 대항력 포기 확약서를 낸 날(물건 비고에만 있으면 checkedAt).
 * senior: 물건 상세의 최선순위 설정(말소기준권리). survey: 현황조사서(매각기일 2주 전부터 열람)의 임차인과 읽은 날. 둘 다 아직 못 봤으면 null.
 */
export interface CourtClaims {
  checkedAt: string;
  demandEnd: string | null;
  wage: { date: string | null; what: string }[];
  taxDocs: number;
  taxParties: number;
  tenantParties: number;
  tenantDocs: number;
  waiver: string | null;
  senior: { date: string; right: string } | null;
  survey: { at: string; tenants: SurveyTenant[] } | null;
  /** 물건 비고, 명세서 비고, 소멸되지 않는 권리에 매수인에게 대항할 수 있는 임차인이나 임차권등기가 적혀 있음(이사 나간 등기 임차인은 현황조사서에 없음) */
  remarkSenior?: boolean;
}

/**
 * 법원 비고 글자에 매수인에게 대항할 수 있는 임차인이나 임차권등기가 적혀 있는지('매수인에게 대항할 수 있는 … 주택임차권 등기',
 * '대항력 있는 임차인', '보증금이 … 매수인이 인수함', 소멸되지 않는 권리의 임차권). 이사 나간 등기 임차인은 현황조사서에 없어서 비고로 본다.
 * '대항력 있는 임차인 없음'과 '공용부분 관리비는 매수인에게 인수될 수 있음'은 치지 않는다.
 */
export const seniorInRemarks = (text: string) =>
  /매수인에게\s*대항할\s*수\s*있|대항력\s*(이\s*)?있(?![^.]{0,20}없)|(임차|보증금)(?:(?!관리비)[^.]){0,60}매수인(이|에게)\s*인수|소멸되지 않는 권리:.*임차/.test(text);

/** 현황조사서 임차인 한 줄(이름과 주소는 뺌). moveIn 전입일, fixed 확정일자(YYYY-MM-DD, 모르면 null), deposit, rent, part는 조사서 글자 그대로. */
export interface SurveyTenant {
  moveIn: string | null;
  fixed: string | null;
  deposit: string | null;
  rent: string | null;
  part: string | null;
}

/** 경매 탭 칸(주거, 상가, 토지)에 맞춘 매각 결과 종류. other는 산업용, 용도복합용 등 세 칸에 들지 않는 것. */
export type AuctionResultKind = 'home' | 'shop' | 'land' | 'other';
/** 매각 결과 요약의 종류: 매각 결과 종류에 house(주거 중 단독주택, 다가구주택, 다중주택)를 더한 것 */
export type AuctionSummaryKind = AuctionResultKind | 'house';

/** 건물 용도 글자('단독주택다가구', '다가구주택' 등)가 단독주택 갈래(단독, 다가구, 다중주택)인지 */
export const isDetachedHouseType = (text: string | null | undefined) => /단독|다가구|다중주택/.test(text ?? '');

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

/** 서울 25개 구(행정 코드 순서) */
export const SEOUL_GUS = [
  '종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구', '강북구', '도봉구', '노원구', '은평구', '서대문구',
  '마포구', '양천구', '강서구', '구로구', '금천구', '영등포구', '동작구', '관악구', '서초구', '강남구', '송파구', '강동구',
];

/** 켜진 지역 반경 밖이라도 이만큼은 넉넉하게 저장해 둔다(보기에서 필터로 좁힌다). */
export const COLLECT_MARGIN_M = 500;

/**
 * 건물 용도 글자가 아파트인지(법원경매 '아파트', 온비드 '아파트', 네이버 '아파트'와 '재건축').
 * 아파트 분양권, 아파트형공장(지식산업센터), 경매 상가, 토지 표시가 붙은 것은 뺀다.
 */
export const isApartmentType = (text: string | null | undefined) => {
  const t = text ?? '';
  return /아파트(?!형)|재건축/.test(t) && !/분양권/.test(t) && !t.startsWith(SHOP_PREFIX) && !t.startsWith(LAND_PREFIX);
};

/** 주소 글자의 서울 구 이름(서울 주소가 아니거나 못 찾으면 null). '서울시 강남구 역삼동', '서울특별시 강남구 …', '강남구 역삼동 …'(서울 뺀 것) */
export function seoulGuOf(address: string | null | undefined): string | null {
  const words = (address ?? '').trim().split(/\s+/);
  if (words[0] && /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|충북|충남|전라|전북|전남|경상|경북|경남|제주)/.test(words[0]) && !words[0].startsWith('서울')) return null;
  return words.slice(0, 3).find((w) => SEOUL_GUS.includes(w)) ?? null;
}

/**
 * 건축물대장에서 읽은 단지 정보(경매와 공매 물건의 지번으로 조회, 공공데이터포털 키가 있을 때).
 * status: ok 세대수를 읽음, none 그 지번에 세대수가 있는 대장이 없음, error 조회 실패(다음에 다시 봄).
 * buildings 세대가 있는 동 수, floors 그중 가장 높은 지상층수, name 건물명, purpose 주용도(기타용도).
 * basis: recap 총괄표제부 세대수, title 동마다 표제부 세대수 합, ho 세대수가 비어 호수 합으로 셈.
 */
export interface AptRegistry {
  status: 'ok' | 'none' | 'error';
  households: number | null;
  buildings: number | null;
  floors: number | null;
  name: string | null;
  purpose: string | null;
  basis: 'recap' | 'title' | 'ho' | null;
  checkedAt: string;
  error: string | null;
}

/**
 * 서울 아파트 탭에 보이는 아파트 정보(법원경매, 온비드, 매매 매물 중 건물 용도가 아파트이고 서울 구를 아는 것).
 * complexKey: 세대수를 같이 쓰는 단지 키(법원경매, 온비드는 구, 법정동, 지번 'lot:강남구 대치동 316', 네이버는 단지 번호 'nv:1234',
 * 지번을 못 찾으면 매물 하나 'id:courtauction:…'). complexName: 세대수 칸과 찾기에 쓰는 단지 이름이나 주소.
 * households: 세대수(직접 넣은 값, 없으면 건축물대장 값, 둘 다 없으면 null), householdsFrom: 그 값이 어디서 왔는지.
 * registry: 건축물대장 조회 결과(조회한 적 없으면 null). property: 온비드 재산 종류('압류재산', '수탁재산' 등, 그 밖에는 null).
 */
export interface AptInfo {
  gu: string;
  complexKey: string;
  complexName: string;
  households: number | null;
  householdsFrom: 'manual' | 'registry' | null;
  registry: AptRegistry | null;
  property: string | null;
}

/**
 * 토지이용계획에 걸린 재개발 쪽 구역 하나(브이월드 토지이용계획 한 줄).
 * kind: redev 정비구역, 재개발구역, 재정비촉진지구 같은 정비사업 구역, small 소규모주택정비 관리지역(모아타운), limit 건축허가와 착공 제한.
 * name: 토지이용계획의 구역 이름 그대로('정비구역'), overlap: 필지가 구역에 '포함'(안), '저촉'(일부 걸침), '접함'(경계에 붙음).
 * notice: 관리번호에서 읽은 고시나 공고 번호('2024-448'), org: 그 번호를 낸 기관(관리번호 앞자리로 아는 것만, 모르면 null).
 */
export interface LandZone {
  kind: 'redev' | 'small' | 'limit';
  name: string;
  overlap: string;
  notice: string | null;
  org: string | null;
}

/**
 * 필지 하나의 재개발 구역 확인 결과(지번으로 브이월드 토지이용계획을 읽음).
 * status: ok 읽음(zones가 비면 걸린 구역이 없음), empty 응답이 비어 있음(구역이 없다는 뜻은 아님), error 조회 실패(다음에 다시 봄).
 */
export interface LandZoneCheck {
  status: 'ok' | 'empty' | 'error';
  zones: LandZone[];
  checkedAt: string;
  error: string | null;
}

/**
 * 경매와 공매(단독주택 갈래 주거, 토지, 아파트, 빌라)와 네이버 아파트 매매의 재개발 구역 정보.
 * lot: 조회에 쓰는 키(경매와 공매는 지번 키 'lot:강남구 대치동 316', 네이버는 단지 키 'nv:1234'), pnu: 필지 번호 19자리.
 * 못 정하면 pnu가 null이고 why가 그 까닭이다(네이버 단지의 필지를 아직 안 찾았으면 why도 null). check: 조회 결과(아직 안 봤으면 null).
 * form: 물건 갈래(house 단독주택, land 토지, apt 아파트, villa 다세대, 연립 같은 빌라). basis: lot 주소의 지번, point 네이버 단지 좌표로 찾은 필지(parcel이 그 필지 주소).
 * point: 네이버 단지 좌표(필지를 찾을 때 씀, 경매와 공매는 null).
 */
export interface PlotZone {
  lot: string | null;
  pnu: string | null;
  why: string | null;
  check: LandZoneCheck | null;
  form: 'house' | 'land' | 'apt' | 'villa';
  basis: 'lot' | 'point';
  parcel: string | null;
  point: { lat: number; lng: number } | null;
}

/**
 * 아파트 매물 값(경매와 공매는 최저가, 네이버는 매매가)과 같은 단지, 같은 전용면적(0.5㎡ 안) 국토부 실거래의 비교. 금액은 만원, 날짜는 YYYY-MM-DD.
 * complex: 실거래 쪽 단지명, jibun: 실거래 번지('노원구 상계동 1234'),
 * basis: 단지를 맞춘 방법(jibun 주소 지번이 같음, name 같은 법정동의 같은 단지 이름, parcel 네이버 단지 좌표의 필지 번지가 같음),
 * months: 비교한 기간(최근 6개월에 3건 이상이면 6, 아니면 12), count, median, min, max: 그 기간 거래 수와 중간값, 최저, 최고,
 * areaMin, areaMax: 그 거래들의 전용면적 범위, latest: 가장 최근 거래, diffPct: 매물 값이 중간값보다 몇 % 높은지(음수면 낮음).
 */
export interface TradeRef {
  complex: string;
  jibun: string;
  basis: 'jibun' | 'name' | 'parcel';
  months: 6 | 12;
  count: number;
  median: number;
  min: number;
  max: number;
  areaMin: number;
  areaMax: number;
  latest: { date: string; price: number; floor: number | null; areaM2: number };
  diffPct: number;
}

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
  kind: AuctionSummaryKind;
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

/**
 * 국토부 실거래가 단독주택 매매 한 건(화면용). date는 계약일(YYYY-MM-DD), price 매매가(만원), landM2 대지면적, floorM2 연면적(㎡),
 * builtYear 건축년도(모르면 null), road 도로조건('8m미만' 등), dealType '중개거래'나 '직거래'.
 */
export interface HouseTradeView {
  gu: string;
  dong: string;
  date: string;
  price: number;
  landM2: number | null;
  floorM2: number | null;
  builtYear: number | null;
  road: string | null;
  dealType: string | null;
}

/** 지역(구나 동) 하나의 오래된 단독주택 거래 요약. 금액은 만원, landPy는 대지 평당 중간값(만원, 대지면적을 모르면 null). */
export interface HouseTradeGroup {
  name: string;
  count: number;
  medianPrice: number;
  landPy: number | null;
  cheapest: HouseTradeView;
}

/**
 * 오래된 단독주택 실거래 요약(서울, 계약일 from ~ to). maxBuiltYear 이 해까지 지은 단독주택만 센다(해제된 거래와 건축년도를 모르는 거래는 뺌).
 * fetchedAt 마지막으로 받은 시각(ISO, 받은 적 없으면 null), error 마지막으로 받다가 난 오류.
 * buckets 매매가 칸마다 서울 전체와 근처 구(near) 건수. gus는 구마다 요약(near 켜 둔 지역 근처 구), dongs는 그 구의 동마다 요약.
 * cheapest 서울에서 싼 순 거래.
 */
export interface HouseTradeSummary {
  fetchedAt: string | null;
  error: string | null;
  from: string;
  to: string;
  maxBuiltYear: number;
  total: number;
  medianPrice: number | null;
  buckets: { label: string; seoul: number; near: number }[];
  gus: (HouseTradeGroup & { near: boolean; dongs: HouseTradeGroup[] })[];
  cheapest: HouseTradeView[];
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
  /** 탭 하나만 돈 조회의 범위(RUN_SCOPES), 전부 돈 조회면 null */
  scope: RunScope | null;
  /** 노선 탭에서 노선 역만 돈 조회면 그 노선('2호선'), 아니면 null */
  line: string | null;
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
  /**
   * 매매와 전월세 새 매물을 고를 매물 탭 필터(화면이 필터를 바꿀 때마다 알려 준다). 있으면 아래 거래 유형 줄의 상한 대신
   * 이 필터의 금액, 평, 매물 유형, 층, 무옵션, 지역 조건을 쓰고, 거래 유형 줄은 켜기만 본다. 아직 받지 못했으면 null.
   */
  homeFilter: Filters | null;
  /** 매매와 전월세 새 매물: 거래 유형마다 켜기와 상한 */
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
  /** 서울 아파트 탭에서 고른 구의 아파트 경매와 공매 새 물건(켜진 지역 반경과 상관없음), 최저가 상한 */
  aptAuction: { on: boolean; priceMax: number | null };
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
  /** 크롬 확장으로 본 사이트(다방 새 방, KB, 네이버 늘어난 매물 수) */
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

/** 사이트별 탭(GET /api/site-report): 소스마다 최근 조회 기록과, 크롬 확장 사이트가 화면에서 받은 것 요약 */
export interface SiteReport {
  /** 소스마다 그 소스가 들어간 조회(새것부터 12개까지). 크롬 확장 사이트는 하루치를 묶은 기록이다. */
  history: Partial<Record<SourceId, SiteRunRow[]>>;
  /** 크롬 확장 사이트(naver, dabang, zigbang, kbland, hogangnono, daangn)마다 받은 화면 데이터 요약 */
  captures: Record<string, SiteCaptureReport>;
}

export interface SiteRunRow {
  runId: number;
  /** 조회가 끝난 시각(조회 중이면 시작 시각) */
  at: string;
  auto: boolean;
  status: 'ok' | 'error';
  /** 사이트에서 받은 수, 지역 안이라 남긴 수, 새로 들어온 수, 가격이 바뀐 수 */
  fetched: number;
  kept: number;
  newCount: number;
  priceChanged: number;
  error: string | null;
}

/**
 * 크롬 확장 사이트 하나가 받은 화면 데이터 요약. days: 최근 14일 한국 날짜('2026-10-21')마다 받은 응답 수(새것부터, 받은 날만).
 * lines: 사이트 화면이 센 수와 매물 내용까지 받은 수 같은 줄(가장 최근 응답에서 읽음).
 */
export interface SiteCaptureReport {
  lastAt: string | null;
  days: { day: string; responses: number }[];
  lines: SiteCaptureLine[];
}

export interface SiteCaptureLine {
  /** 짧은 이름('지도 안 매물') */
  label: string;
  /** 보일 값('1,228건') */
  value: string;
  at: string;
  /** 바로 뜨는 설명(무엇을 센 것인지, 고른 조건) */
  tip: string;
  /** 사이트에 있는 것보다 받은 것이 적은 줄(눈에 띄게 보인다) */
  short?: boolean;
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
  /** 예전 지역 탭 '이 노선만 켜기'로 바꾸기 전 지역으로 되돌릴 수 있으면 마지막으로 고른 노선과 전에 켜 둔 지역 수 */
  areaRestore: { line: string; count: number } | null;
  /** 노선 탭에서 고른 노선과 역 반경(고르지 않았으면 null) */
  lineView: LineViewSetting | null;
  /** 조회할 때 역, 지역, 구 사이에 쉬는 시간(초) */
  restSeconds: number;
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
  /** 지역을 마지막으로 바꾼 시각(대시보드, 크롬 확장 어느 쪽이든). 확장이 어느 쪽 목록을 따를지 정할 때 쓴다. */
  areasUpdatedAt: string | null;
  autoCheck: AutoCheckState;
  alerts: AlertSettings;
  /** 크롬 확장 사이트(dabang, kbland, naver)마다 마지막 확인 결과 */
  captureNews: Partial<Record<string, CaptureNews>>;
  /** 켜진 지역 근처 서울 구(임대 공고를 지역으로 거를 때 쓴다) */
  gus: string[];
  /** 켜진 지역 바로 근처의 역과 지역 이름('역' 뺌). 공고 제목에 들었으면 '근처'로 표시한다(nearReason). */
  nearNames: string[];
  /** 서울 아파트 탭에서 고른 구: 법원경매와 온비드가 회사와 멀어도 이 구의 아파트를 모은다(SEOUL_GUS 순서) */
  aptGus: string[];
  /**
   * 건축물대장 세대수 채우기: key 공공데이터포털 키를 넣어 두었는지(config/local.json의 dataGoKrKey),
   * last 마지막으로 채운 결과(at 시각, ok 성공, text '세대수 채움 3곳, 대장에서 못 찾음 1곳' 또는 오류).
   */
  householdsFill: { key: boolean; last: { at: string; ok: boolean; text: string } | null };
  /**
   * 집터 재개발 구역 확인: key 브이월드 인증키를 넣어 두었는지(config/local.json의 vworldKey),
   * last 마지막으로 확인한 결과(at 시각, ok 성공, text '구역 확인 12곳: 정비구역 등 안 2곳, 없음 9곳, 응답 없음 1곳' 또는 오류).
   */
  zoneCheck: { key: boolean; last: { at: string; ok: boolean; text: string } | null };
  /** 한국은행 기준금리(연 %)와 바뀐 날(YYYY-MM-DD). 받아 둔 표가 없으면 null */
  baseRate: { value: number; date: string } | null;
}

// ---------- 시세 통계 탭 ----------

/** 시세 통계 그래프의 선 하나: 지역 하나의 값(MarketChart.dates와 같은 순서, 없는 날은 null) */
export interface MarketLine {
  /** KB 지역코드 */
  code: string;
  name: string;
  /** nation 전국, seoul 서울, region 그 밖의 시도와 권역, gu 서울 구 */
  kind: 'nation' | 'seoul' | 'region' | 'gu';
  /** 켜 둔 지역 근처 구 */
  near: boolean;
  values: (number | null)[];
}

/** 날짜(월간 YYYY-MM, 주간 YYYY-MM-DD)와 지역별 선 */
export interface MarketChart {
  dates: string[];
  lines: MarketLine[];
}

/** KB 월간 지수의 마지막 달까지 1년, 5년, 10년 변동률(%, 모르면 null) */
export interface MarketChanges {
  y1: number | null;
  y5: number | null;
  y10: number | null;
}

/** 서울 아파트 지금 흐름 요약. 변동률은 %, 모르면 null. */
export interface MarketNow {
  /** KB 주간 매매가격지수 마지막 기준일(YYYY-MM-DD) */
  week: string | null;
  /** 서울 주간 지수의 1주, 4주, 13주, 52주 변동률 */
  w1: number | null;
  w4: number | null;
  w13: number | null;
  w52: number | null;
  /** 4주 변동률로 본 방향: +0.1% 넘으면 up, -0.1% 밑이면 down, 그 사이 flat */
  trend: 'up' | 'down' | 'flat' | null;
  /** KB 월간 지수 마지막 달(YYYY-MM)과 그 달까지 1년, 5년, 10년 변동률(서울, 전국) */
  month: string | null;
  seoulChange: MarketChanges;
  nationChange: MarketChanges;
  /** KB 주간 매수우위지수 마지막 기준일, 서울과 전국 값, 서울 최근 4주 평균 */
  buyerWeek: string | null;
  buyerSeoul: number | null;
  buyerNation: number | null;
  buyerSeoul4: number | null;
  /** 실거래: 신고가 다 들어온 마지막 달(YYYY-MM)의 서울 건수와 1년 전 같은 달, 그 달까지 3개월 합과 1년 전 같은 3개월 합 */
  volumeMonth: string | null;
  volume: number | null;
  volumeLastYear: number | null;
  volume3: number | null;
  volume3LastYear: number | null;
}

/** 구별 급지표 한 줄(최근 1년 해제되지 않은 아파트 매매) */
export interface MarketTier {
  gu: string;
  /** 평당 중간값 순위(1이 가장 비쌈) */
  rank: number;
  /** 순위로 고르게 나눈 다섯 묶음(1 상급지 ~ 5 하급지) */
  tier: number;
  count: number;
  /** 전용면적 평당 중간값(만원) */
  pyeong: number;
  /** 전용 84㎡대(84㎡ 이상 85㎡ 미만) 거래만의 거래가 중간값(만원), 그런 거래가 없으면 null */
  median84: number | null;
  /** 전용 84㎡대 거래 수 */
  count84: number;
  /** 거래가 중간값(만원) */
  median: number;
  /** KB 월간 지수로 본 이 구의 1년, 5년, 10년 변동률 */
  change: MarketChanges;
  near: boolean;
  /** 법정동별(평당 중간값 높은 순) */
  dongs: { dong: string; count: number; pyeong: number }[];
  /** 이 구의 전철역(이름순) */
  stations: MarketStation[];
}

/**
 * 구별 급지표의 역 하나. dongs는 그 역을 붙일 법정동이고 how는 맞춘 방법:
 * listings 역 300m 안 모은 매물이 가장 많이 있는 동, name 역 이름이 붙은 동(그런 동이 하나일 때), null 못 맞춤.
 */
export interface MarketStation {
  name: string;
  lines: string[];
  dongs: string[];
  how: 'listings' | 'name' | null;
}

/** 시세 통계 탭 전체 */
export interface MarketView {
  kb: { fetchedAt: string | null; error: string | null };
  /** 실거래: coverageFrom 거래량을 끊김 없이 받아 둔 첫날(YYYY-MM-DD), missingYears 아직 안 받은 지난 해 */
  trades: { fetchedAt: string | null; error: string | null; missingYears: number[]; coverageFrom: string | null };
  now: MarketNow;
  /** KB 월간 아파트 매매가격지수 */
  price: MarketChart;
  /** KB 주간 매수우위지수 */
  buyer: MarketChart;
  /** 실거래 월별 건수(서울 합과 구별, months와 같은 순서). 끝에서 incomplete달은 신고 기한(계약 뒤 30일) 안이라 덜 들어왔다. */
  volume: { months: string[]; incomplete: number; seoul: number[]; gus: { gu: string; near: boolean; counts: number[] }[] };
  /** 지역별 아파트 매매 건수(전국, 수도권, 지방, 경기, 인천) */
  regionVolume: RegionVolumeView;
  /** 구별 급지표(계약일 from ~ to). 실거래를 아직 안 받았으면 null. */
  tiers: { from: string; to: string; gus: MarketTier[] } | null;
  /** 고점 신호 */
  peak: PeakSignals;
  /** 해마다 오른 비율 */
  yearly: MarketYearly;
}

/**
 * 지역별 아파트 매매 건수(계약한 달 기준, 국토부 실거래가 자료제공 화면의 건수라 해제된 거래도 셈). counts는 months와 같은 순서, 아직 안 받은 달은 null.
 * 수도권은 서울, 인천, 경기의 합, 지방은 전국에서 수도권을 뺀 수. 끝에서 incomplete달은 다 들어오기 전에 받았거나 아직 안 받은 달.
 * missing은 아직 안 받은 달 수(조회할 때 조금씩 채움).
 */
export interface RegionVolumeView {
  months: string[];
  incomplete: number;
  regions: { id: 'nation' | 'capital' | 'local' | 'gyeonggi' | 'incheon'; name: string; counts: (number | null)[] }[];
  fetchedAt: string | null;
  error: string | null;
  missing: number;
}

/**
 * KB 월간 매매가격지수로 본 해마다 오른 비율(%, 그해 12월 ÷ 지난해 12월 − 1). years와 같은 순서, 모르면 null.
 * 아파트(apt)와 주택종합(all), 서울과 전국. 마지막 해가 12월까지 안 찼으면 지난해 12월부터 lastMonth까지.
 */
export interface MarketYearly {
  years: string[];
  seoulApt: (number | null)[];
  nationApt: (number | null)[];
  seoulAll: (number | null)[];
  nationAll: (number | null)[];
  lastMonth: string | null;
}

/**
 * 실거래로 본 고점 신호(서울 아파트, 계약한 달 기준). months는 끊김 없이 받아 둔 달(YYYY-MM).
 * year: 그 달까지 12달 거래 합(신고 기한 안이라 덜 들어온 끝의 incomplete달과 12달이 안 찬 달은 null).
 * newHigh, low, high: 그 달까지 3달 동안 신고가 비율(%): 전체, 지난해 그 구 평당가 아래 3분의 1 단지, 위 3분의 1 단지.
 * 신고가는 같은 단지, 같은 전용면적의 앞선 최고가보다 비싼 거래이고, 앞선 거래가 2년 넘게 쌓인 from 달부터 센다.
 */
export interface TradePeakSignals {
  months: string[];
  year: (number | null)[];
  newHigh: (number | null)[];
  low: (number | null)[];
  high: (number | null)[];
  incomplete: number;
  from: string | null;
}

/** 시계열 하나(날짜 YYYY-MM 순, 값) */
export interface PeakSeries {
  dates: string[];
  values: number[];
}

/**
 * 시세 통계 탭의 고점 신호 묶음. pir: KB아파트담보대출 PIR(서울, 분기 끝 달), hai: KB 주택구매력지수(서울 아파트, 매달),
 * rate: 주택담보대출 금리(%, 매달, KB 주택구매력지수 자료의 값), jeonse: 아파트 매매가 대비 전세가 비율(서울, %, 매달)
 */
export interface PeakSignals {
  trades: TradePeakSignals;
  pir: PeakSeries;
  hai: PeakSeries;
  rate: PeakSeries;
  jeonse: PeakSeries;
  /** 한국은행 기준금리(바뀐 날 YYYY-MM-DD와 바뀐 뒤 금리 %) */
  baseRate: PeakSeries;
  /** 서울 청약 신청자 수와 당첨자 수(모집공고 달 YYYY-MM, dates와 같은 순서) */
  subs: { dates: string[]; apply: number[]; win: number[] };
  /** 서울 아파트 준공(사용검사, 세대, 달마다, provisional은 잠정치 달)과 입주예정(세대, 앞으로의 달) */
  supply: { done: PeakSeries; provisional: string[]; plan: PeakSeries };
  /** 서울 미분양(호, 달마다) */
  unsold: PeakSeries;
  /** 공공 자료(기준금리, 청약, 입주예정, 준공, 미분양)를 받은 상태 */
  sources: { fetchedAt: string | null; error: string | null };
}

/** 지도에 칠하는 정비사업 구역의 묶음: redev 정비사업(재개발, 재건축, 신속통합기획, 주거환경개선), small 소규모 정비(모아타운, 가로주택 등), promo 재정비촉진, public 공공주택지구, 도심 공공주택 복합사업 */
export type RedevZoneGroup = 'redev' | 'small' | 'promo' | 'public';

/**
 * 정비사업 구역 하나(GeoJSON Feature, 좌표는 [경도, 위도]). 서울 열린데이터광장 '서울시 도시계획사업 현황(서울플랜+)' 파일에서 읽는다.
 * id: 파일의 현황 번호, name: 구역 이름, type: 사업 종류(코드정의표 이름), outline: 테두리만 그리는 넓은 구역(재정비촉진지구, 모아타운, 존치관리구역),
 * stage: 추진 단계, date: 그 줄의 작성일(YYYY-MM-DD), gu: 구.
 */
export interface RedevZoneFeature {
  type: 'Feature';
  properties: { id: string; name: string; group: RedevZoneGroup; type: string; outline: boolean; stage: string | null; date: string | null; gu: string | null };
  geometry: { type: 'Polygon'; coordinates: [number, number][][] } | { type: 'MultiPolygon'; coordinates: [number, number][][][] };
}

/** 매물 좌표가 든 정비사업 구역 하나(RedevZoneFeature의 properties). edge: 구역 경계에서 25m 안이라 안팎을 지번으로 확인해야 함 */
export interface RedevHit {
  name: string;
  type: string;
  group: RedevZoneGroup;
  outline: boolean;
  stage: string | null;
  date: string | null;
  edge: boolean;
}

/**
 * 넣어 둔 정비사업 구역 파일: 넣은 때, 파일 안 가장 늦은 작성일, 파일 이름, 열린데이터광장 파일 번호와 목록 날짜(자동으로 받았을 때만),
 * 그리는 구역 수, 뺀 수(done 준공, 철회, other 다른 사업), 구역. check는 새 파일 자동 확인의 마지막 결과(GET /api/redev-zones가 붙임).
 */
export interface RedevZonesView {
  importedAt: string | null;
  fileDate: string | null;
  fileName: string | null;
  seq: number | null;
  listedAt: string | null;
  check?: RedevZonesCheck | null;
  count: number;
  skipped: { done: number; other: number };
  features: RedevZoneFeature[];
}

/** 정비구역 파일 새 판 확인의 마지막 결과: 확인한 때, 성공 여부, 결과 글('새 파일 없음(5번, 2026.09.10)' 등) */
export interface RedevZonesCheck {
  at: string;
  ok: boolean;
  text: string;
}

/** 노선 탭에서 고른 노선과 역 반경(m) */
export interface LineViewSetting {
  line: string;
  radiusM: number;
}

/** 조회할 때 역, 지역, 구 사이에 쉬는 시간으로 고를 수 있는 값(초)과 처음 값. 사이트와 이 컴퓨터에 요청이 한꺼번에 몰리지 않게 한다. */
export const REST_CHOICES = [0, 2, 3, 5, 10];
export const REST_DEFAULT = 3;

// ---------- 동별 전월세(국토부 실거래가 전월세) ----------

/** 동별 전월세의 종류 묶음(kinds는 실거래 자료의 주택 종류) */
export const RENT_KINDS = [
  { id: 'small', label: '아파트 뺌', kinds: ['단독다가구', '연립다세대', '오피스텔'] },
  { id: 'house', label: '단독다가구', kinds: ['단독다가구'] },
  { id: 'villa', label: '연립다세대', kinds: ['연립다세대'] },
  { id: 'officetel', label: '오피스텔', kinds: ['오피스텔'] },
  { id: 'apt', label: '아파트', kinds: ['아파트'] },
] as const;
export type RentKindId = (typeof RENT_KINDS)[number]['id'];

/** 동별 전월세의 면적 칸(전용면적 ㎡, min 초과 max 이하. 단독다가구는 계약면적) */
export const RENT_SIZES = [
  { id: 'one', label: '원룸 30㎡ 이하', min: 0, max: 30 },
  { id: 'two', label: '투룸 30~50㎡', min: 30, max: 50 },
  { id: 'mid', label: '50~85㎡', min: 50, max: 85 },
] as const;
export type RentSizeId = (typeof RENT_SIZES)[number]['id'];

/** 월세 계약 요약(만원): 건수, 환산 월세(월세 + 보증금 × 전환율 ÷ 12)의 중간값과 하위, 상위 4분의 1 경계, 보증금과 월세 중간값 */
export interface RentMonthlyStat {
  count: number;
  conv: number;
  convLow: number;
  convHigh: number;
  deposit: number;
  rent: number;
}

/** 전세 계약 요약(만원): 건수, 전세금 중간값과 하위, 상위 4분의 1 경계 */
export interface RentJeonseStat {
  count: number;
  median: number;
  low: number;
  high: number;
}

/** 동이나 구 하나. cells의 키는 '종류 id:면적 id'(RENT_KINDS, RENT_SIZES)이고 그 칸에 계약이 없으면 키가 없다. */
export interface RentPlace {
  name: string;
  cells: Record<string, { monthly: RentMonthlyStat | null; jeonse: RentJeonseStat | null }>;
}

/**
 * 시세 통계 탭 동별 전월세: 켜 둔 지역 근처 구의 계약일 from ~ to 신규 계약. rate는 환산에 쓴 전환율(연 %).
 * gus는 구 전체와 동마다(동에는 그 동에 맞춘 역), fetchedAt은 마지막으로 받은 때, error는 마지막으로 받다 난 오류.
 */
export interface RentView {
  fetchedAt: string | null;
  error: string | null;
  from: string;
  to: string;
  rate: number;
  gus: (RentPlace & { dongs: (RentPlace & { stations: MarketStation[] })[] })[];
}
