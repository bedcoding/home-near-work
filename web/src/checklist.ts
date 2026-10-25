import { LOAN_CLAUSES, type SupportSource } from './support';

// 체크리스트 탭(ChecklistView): 집을 볼 때 확인할 것(집 하자)과 계약금을 넣기 전에 확인할 것(계약 전)을 거래 유형(전세, 월세, 매매, 경매)마다
// 손으로 정리한 표다. 모으는 데이터가 아니라 조사한 날(CHECKLIST_CHECKED) 기준이다. 법과 제도가 든 항목을 고칠 때는 CHECKLIST_CHECKED와
// 근거(sources)도 같이 고친다.

/** 법과 제도가 든 항목을 확인한 날 */
export const CHECKLIST_CHECKED = '2026-10-25';

/** 목록: house 집을 볼 때 눈과 손으로, contract 계약금을 넣기 전에 서류와 돈으로 */
export type CheckList = 'house' | 'contract';
export const CHECK_LISTS: { id: CheckList; name: string; title: string }[] = [
  { id: 'house', name: '집 하자', title: '집을 볼 때 눈과 손으로 확인할 것: 물, 곰팡이, 창, 전기와 난방, 건물, 위반건축물 흔적, 동네' },
  { id: 'contract', name: '계약 전', title: '계약금을 넣기 전에 서류와 돈으로 확인할 것: 시세, 집주인과 중개사, 서류, 대출, 보험, 계약서, 지금 집 나갈 때, 잔금 날' },
];

export type CheckDeal = 'jeonse' | 'monthly' | 'buy' | 'auction';
export const CHECK_DEALS: { id: CheckDeal; name: string; title: string }[] = [
  { id: 'jeonse', name: '전세', title: '전세나 반전세로 들어갈 때' },
  { id: 'monthly', name: '월세', title: '보증금을 낸 월세로 들어갈 때' },
  { id: 'buy', name: '매매', title: '집을 살 때' },
  { id: 'auction', name: '경매', title: '경매로 살 때. 보통 집 안에 들어가 볼 수 없어 밖과 서류로 확인합니다' },
];

/** 집 종류. 항목의 kinds가 이 중 일부면 그 종류의 집에만 보인다. */
export type CheckKind = 'apt' | 'villa' | 'officetel' | 'house';
export const CHECK_KINDS: { id: CheckKind; name: string; title: string }[] = [
  { id: 'apt', name: '아파트', title: '아파트' },
  { id: 'villa', name: '빌라', title: '다세대, 연립' },
  { id: 'officetel', name: '오피스텔', title: '오피스텔' },
  { id: 'house', name: '단독과 다가구', title: '단독주택, 다가구, 다중주택' },
];

/** 칸(목록마다 이 순서로 보임) */
export type CheckPlace =
  | 'before' | 'outside' | 'illegal' | 'bath' | 'kitchen' | 'room' | 'utility' | 'town'
  | 'money' | 'people' | 'papers' | 'loan' | 'insurance' | 'terms' | 'leaving' | 'closing';
export const CHECK_PLACES: { id: CheckPlace; list: CheckList; name: string }[] = [
  { id: 'before', list: 'house', name: '가기 전' },
  { id: 'outside', list: 'house', name: '건물과 밖' },
  { id: 'illegal', list: 'house', name: '위반건축물 흔적' },
  { id: 'bath', list: 'house', name: '화장실' },
  { id: 'kitchen', list: 'house', name: '주방과 세탁' },
  { id: 'room', list: 'house', name: '방과 창' },
  { id: 'utility', list: 'house', name: '전기, 가스, 난방' },
  { id: 'town', list: 'house', name: '동네' },
  { id: 'money', list: 'contract', name: '시세와 돈' },
  { id: 'people', list: 'contract', name: '집주인과 중개사' },
  { id: 'papers', list: 'contract', name: '서류' },
  { id: 'loan', list: 'contract', name: '대출' },
  { id: 'insurance', list: 'contract', name: '보험' },
  { id: 'terms', list: 'contract', name: '계약서와 특약' },
  { id: 'leaving', list: 'contract', name: '지금 집 나갈 때' },
  { id: 'closing', list: 'contract', name: '잔금 날' },
];

/** 이 대시보드에서 같이 볼 탭 */
export type CheckGoto = 'fraud' | 'support' | 'market' | 'auction' | 'apt';

/** 신청이나 가입처럼 순서가 있는 일의 한 단계와 그 단계에서 쓰는 공식 화면 */
export interface CheckStep {
  text: string;
  links?: { label: string; url: string }[];
}

/** 같은 일을 하는 상품 하나(항목 아래 '상품 예시' 칸). facts는 [이름, 내용] 줄, note는 근거의 한계. */
export interface CheckProvider {
  name: string;
  facts: [string, string][];
  note?: string;
  links?: { label: string; url: string }[];
}

/** 계약서에 옮겨 쓸 특약 문구 하나(항목 아래 '특약 문구 예' 칸, 복사 버튼) */
export interface CheckClause {
  name: string;
  text: string;
}

/**
 * 확인할 것 하나. name 짧은 이름, how 어떻게 보는지, why 왜 보는지와 문제면 생기는 일(이름에 마우스를 올리면 바로 뜸).
 * steps 순서대로 할 일(항목 아래 번호로 보임, 칸 이름은 stepsTitle), clauses 특약 문구 예, providers 상품 예시,
 * deals 이 항목이 보이는 거래 유형, kinds 이 집 종류에만(없으면 모든 집), tag 층이나 자리 조건.
 */
export interface CheckItem {
  id: string;
  place: CheckPlace;
  name: string;
  how: string;
  why?: string;
  steps?: CheckStep[];
  stepsTitle?: string;
  clauses?: CheckClause[];
  providers?: CheckProvider[];
  deals: CheckDeal[];
  kinds?: CheckKind[];
  tag?: string;
  goto?: { tab: CheckGoto; label: string };
  sources?: SupportSource[];
}

const RENT: CheckDeal[] = ['jeonse', 'monthly'];
const INSIDE: CheckDeal[] = ['jeonse', 'monthly', 'buy'];
const ALL: CheckDeal[] = ['jeonse', 'monthly', 'buy', 'auction'];
const OWN: CheckDeal[] = ['buy', 'auction'];

const LAW = 'https://law.go.kr/LSW/lsLinkProc.do?lsClsCd=L&mode=11&lsNm=';
/** 법령 조문 근거(jo는 조 번호 6자리: 제18조의4는 '001804') */
const law = (title: string, name: string, jo: string, date = ''): SupportSource => ({ title, url: `${LAW}${encodeURIComponent(name)}&joNo=${jo}`, date });
const prec = (title: string, no: string, date: string): SupportSource => ({ title, url: `https://law.go.kr/LSW/precInfoP.do?mode=0&evtNo=${encodeURIComponent(no)}`, date });

const BROKER_SEARCH: SupportSource = { title: '서울부동산정보광장 개업공인중개사 사무소 조회', url: 'https://land.seoul.go.kr/land/broker/brokerInfo.do', date: '' };
const VWORLD_BROKER: SupportSource = { title: '브이월드 부동산 중개업 조회(전국, 사무소와 중개사, 보조원 이름)', url: 'https://www.vworld.kr/dtld/broker/dtld_list_s001.do', date: '' };
const KAR_BROKER: SupportSource = { title: '한국공인중개사협회 개업공인중개사 검색(영업 중인 사무소만, 달마다 반영)', url: 'https://www.kar.or.kr/pinfo/brokersearch.asp', date: '' };
const SAFE_APP: SupportSource = { title: 'HUG 안심전세 앱 안내(시세조회, 집주인조회, 공인중개사 정보조회)', url: 'https://www.khug.or.kr/jeonse/web/s01/s010102.jsp', date: '' };
const HUG_LANDLORD_INFO: SupportSource = { title: 'HUG 공지: 임대인 동의 없이 보는 임대인 정보와 조회 조건', url: 'https://www.khug.or.kr/khmb/m/cc/nn/ccnn000002.jsp?idx=35946&tabIdx=1', date: '2025-05-27' };
const HUG_DEFAULTERS: SupportSource = { title: 'HUG 상습 채무불이행자 조회(지정 요건과 공개 내용)', url: 'https://www.khug.or.kr/jeonse/web/s01/s010320.jsp', date: '' };
const SEOUL_FEE: SupportSource = { title: '서울부동산정보광장 부동산 중개보수(요율표, 적용기준, 계산)', url: 'https://land.seoul.go.kr/land/broker/brokerageCommission.do', date: '' };
const LEASE_INFO_RULE = '주택임대차계약증서상의 확정일자 부여 및 임대차 정보제공에 관한 규칙';
const PAY_OWNER: SupportSource = { title: '서울부동산정보광장: 대금은 등기부 명의 통장으로', url: 'https://land.seoul.go.kr/land/broker/estateBrokerageGuide.do', date: '' };
const ID_CHECK: SupportSource = { title: '주민등록증 진위확인(행정안전부)', url: 'https://www.mois.go.kr/frt/sub/a06/b06/IDCard_7/screen.do', date: '' };
const SEAL_CHECK: SupportSource = { title: '정부24 인감증명발급 사실확인', url: 'https://m.gov.kr/ingam/ingam.jsp?img=031', date: '' };
const COMMON_FEES: SupportSource = prec('대법원 2001다8677 전원합의체(공용부분 체납관리비 승계)', '2001다8677', '2001-09-20');
const REGISTRY_AGAIN: SupportSource = {
  title: '생활법령: 대금 지급 직전 등기부 다시 확인',
  url: 'https://www.easylaw.go.kr/CSP/CnpClsMain.laf?popMenu=ov&csmSeq=1894&ccfNo=2&cciNo=2&cnpClsNo=2',
  date: '',
};
const RT_SEARCH: SupportSource = { title: '국토교통부 실거래가 공개시스템', url: 'https://rt.molit.go.kr/', date: '' };
const LAND_USE: SupportSource = { title: '토지이음(토지이용계획)', url: 'https://www.eum.go.kr/', date: '' };
const HUG_HOUSE_CHECK: SupportSource = { title: 'HUG 전세사기예방센터: 이 집, 괜찮을까?(주택 내외부 확인 표)', url: 'https://www.khug.or.kr/jeonse/web/s03/s030103.jsp', date: '' };
const HUG_RETURN: SupportSource = { title: 'HUG 전세보증금반환보증 상품 안내', url: 'https://www.khug.or.kr/hug/web/ig/dr/igdr000001.jsp', date: '' };
const HUG_LOAN: SupportSource = { title: 'HUG 전세금안심대출보증 상품 안내', url: 'https://www.khug.or.kr/hug/web/ig/dl/igdl000001.jsp', date: '' };
const HF_JEONSE: SupportSource = { title: 'HF 일반전세자금보증(등기상 주택이나 오피스텔, 실제 주거용)', url: 'https://www.hf.go.kr/ko/sub02/sub02_01_02.do', date: '' };
const HF_KEEP: SupportSource = { title: 'HF 전세지킴보증(위반건축물, 신탁 주택)', url: 'https://www.hf.go.kr/ko/sub02/sub02_05_06.do', date: '' };
const MOLIT_JEONSE_TIPS: SupportSource = { title: '정책브리핑: 전세계약 전 확인할 것(시세 80%, 위반건축물 대출 안 됨)', url: 'https://www.korea.kr/news/policyNewsView.do?newsId=148940099', date: '2025-02-28' };
const REALTY_PRICE: SupportSource = { title: '부동산 공시가격 알리미', url: 'https://www.realtyprice.kr/', date: '' };
const HUG_TERMS: SupportSource = { title: 'HUG 전세보증금반환보증 약관(제2조 보증 안 하는 채무, 제3조 면책)', url: 'https://www.khug.or.kr/hug/homepage_file_upload/jeonse_guarantee_terms_20240426_rev.pdf', date: '2024-04-26' };
const HUG_PROCEDURE: SupportSource = { title: 'HUG 전세보증금반환보증 이용절차와 제출서류', url: 'https://www.khug.or.kr/hug/web/ig/dr/igdr000002.jsp?tabMenu=Y', date: '' };
/** 가입 순서에 붙이는 공식 화면 */
const L = {
  realty: { label: '공시가격 알리미', url: 'https://www.realtyprice.kr/' },
  safeApp: { label: '안심전세 앱 안내', url: 'https://www.khug.or.kr/jeonse/web/s01/s010102.jsp' },
  hugCheck: { label: 'HUG 가입가능여부 확인', url: 'https://khig.khug.or.kr/index.jsp?fromLink=Y&MENUID=200800' },
  hugProcedure: { label: '이용절차와 제출서류', url: 'https://www.khug.or.kr/hug/web/ig/dr/igdr000002.jsp?tabMenu=Y' },
  hugBranches: { label: 'HUG 지점 안내', url: 'https://www.khug.or.kr/hug/web/ig/dr/igdr000004.jsp?tabFocus=Y' },
  hugInternet: { label: 'HUG 인터넷보증', url: 'https://khig.khug.or.kr/' },
  rtms: { label: '임대차 신고필증(rtms)', url: 'https://rtms.molit.go.kr/' },
  iros: { label: '인터넷등기소', url: 'https://www.iros.go.kr/' },
  gov24: { label: '정부24', url: 'https://www.gov.kr/' },
  hana: { label: '하나손해보험 권리보험', url: 'https://m.hanainsure.co.kr/honeQ/product/realestateright/honeQRealEstateRightIntro?origin=m' },
  naezip: { label: '내집스캔 매매지킴보증', url: 'https://www.naezipscan.com/insurance/firstamerican/title-001/landing' },
  firstam: { label: '퍼스트어메리칸 묻고 답하기', url: 'https://www.firstam.co.kr/FAQ' },
};
const ILLEGAL_TYPES: SupportSource = {
  title: '생활법령: 흔한 위반건축물(경계벽으로 가구 늘리기, 1층 근생을 주거로)',
  url: 'https://easylaw.go.kr/CSP/CnpClsMain.laf?popMenu=ov&csmSeq=1406&ccfNo=3&cciNo=2&cnpClsNo=2',
  date: '',
};
/** 위반건축물 흔적 칸 항목들이 같이 쓰는 설명(걸리면 누가 떠안는지) */
/** 지원 제도 탭의 특약 문구를 해제 특약 항목에 같은 글로 보인다(숨긴 선순위가 먼저) */
const CANCEL_CLAUSES: CheckClause[] = ['guarantee', 'hidden', 'loan', 'cooperate']
  .flatMap((id) => LOAN_CLAUSES.filter((c) => c.id === id))
  .map(({ name, text }) => ({ name, text }));
const ILLEGAL_WHY_SHORT ='대장에 아직 안 올랐어도 걸리면 그때 소유자에게 시정명령과 이행강제금이 나오고, 세입자는 전세대출과 반환보증이 막힐 수 있습니다(층수와 집 수 항목 설명).';

export const CHECK_ITEMS: CheckItem[] = [
  // ---------- 집 하자: 가기 전 ----------
  {
    id: 'two-visits', place: 'before', name: '낮과 저녁에 한 번씩', deals: ALL,
    how: '처음은 해가 있을 때 가서 채광과 집 상태를 보고, 마음에 들면 저녁에 다시 가서 골목, 소음, 주차를 봅니다.',
  },
  {
    id: 'tools', place: 'before', name: '챙길 것', deals: INSIDE,
    how: '줄자, 휴대폰 손전등, 나침반과 수평계 앱, 휴대폰 충전기(콘센트 확인용).',
  },
  {
    id: 'photos', place: 'before', name: '사진 남기기', deals: RENT,
    how: '본 집마다 문제 있는 곳을 찍어 둡니다. 들어갈 집은 이삿날 짐을 들이기 전에 다시 찍습니다.',
    why: '나갈 때 원래 있던 흠인지 내가 낸 흠인지 다투지 않게 남깁니다.',
  },
  {
    id: 'companion', place: 'before', name: '같이 가 줄 사람', deals: RENT,
    how: '서울에 살거나 살 예정인 1인가구면 서울시 1인가구 전월세 안심계약 도움서비스로 공인중개사 자격이 있는 주거안심매니저와 무료로 집을 같이 볼 수 있습니다. 구마다 요일이 달라 2~3일 전에 신청합니다.',
    why: '계약 상담, 등기부 점검, 계약 때 동행도 해 줍니다. 매물을 골라 주지는 않습니다.',
    sources: [{ title: '서울시 1인가구 전월세 안심계약 도움서비스', url: 'https://1in.seoul.go.kr/front/sport/sportView.do?sport_id=a97db018d11c44af845fd028fde7104c', date: '2026-01-11' }],
  },
  {
    id: 'auction-inside', place: 'before', name: '집 안 가늠', deals: ['auction'],
    how: '감정평가서 사진과 현황조사서로 집 안을 보고, 같은 단지나 같은 건물에 나온 매물을 중개사와 보면 구조와 상태를 가늠할 수 있습니다.',
  },

  // ---------- 집 하자: 건물과 밖 ----------
  {
    id: 'walls', place: 'outside', name: '외벽 금과 물 자국', deals: ALL,
    how: '외벽의 굵은 금, 창 아래로 흘러내린 물 자국, 들뜬 타일과 벽돌을 봅니다.',
    why: '금과 들뜬 곳으로 빗물이 들어와 안쪽 벽이 젖습니다. 굵고 비스듬한 금이 여러 곳이면 전문가에게 보일 만합니다.',
  },
  {
    id: 'roof', place: 'outside', name: '옥상 방수', tag: '꼭대기층', deals: INSIDE,
    how: '천장 모서리 얼룩을 보고, 옥상에 올라가 바닥 방수층이 갈라지거나 들떴는지 봅니다. 여름 더위와 겨울 추위도 묻습니다.',
  },
  {
    id: 'flood', place: 'outside', name: '습기와 침수 흔적', tag: '반지하와 1층', deals: ALL,
    how: '벽 아래쪽 물자국과 곰팡이 냄새, 현관과 창의 물막이판, 하수구 역류를 막는 장치를 봅니다. 생활안전지도의 침수흔적도로 그 동네가 잠긴 적이 있는지 봅니다.',
    why: '중개사가 확인설명서에 적어야 하는 항목에 침수 이력은 없어서 직접 봐야 합니다.',
    sources: [
      { title: '생활안전지도(침수흔적도, 도시침수지도)', url: 'https://www.safemap.go.kr/main/smap.do?flag=2', date: '' },
      { title: '서울 열린데이터광장: 서울시 침수흔적도(GIS 파일)', url: 'https://data.seoul.go.kr/dataList/OA-15636/F/1/datasetView.do', date: '' },
      law('자연재해대책법 제21조(침수흔적도 작성과 보존)', '자연재해대책법', '002100'),
    ],
  },
  {
    id: 'security', place: 'outside', name: '현관과 방범', deals: INSIDE,
    how: '공동현관 잠금, CCTV, 저층 창의 방범창, 택배 두는 곳, 현관문 걸쇠와 도어락을 봅니다.',
  },
  {
    id: 'exit', place: 'outside', name: '피난길', deals: INSIDE,
    how: '불이 났을 때 나갈 계단과 비상구가 짐으로 막혀 있지 않은지 봅니다.',
    sources: [HUG_HOUSE_CHECK],
  },
  {
    id: 'move', place: 'outside', name: '이삿짐 길', deals: INSIDE,
    how: '엘리베이터 크기를 보고, 없으면 사다리차가 설 자리와 골목 폭을 봅니다.',
  },
  {
    id: 'parking', place: 'outside', name: '주차', deals: ALL,
    how: '자리 수와 비용, 기계식인지, 저녁에 꽉 차는지 봅니다.',
  },
  {
    id: 'care', place: 'outside', name: '관리 상태', deals: ALL,
    how: '복도와 계단 청소, 쓰레기 내놓는 곳, 게시판 공지(단수, 공사, 누수, 관리비 미납 안내)를 봅니다.',
  },
  {
    id: 'occupant', place: 'outside', name: '누가 사는지', deals: ['auction'],
    how: '우편함의 우편물, 전기와 가스 계량기가 도는지, 현관 앞 짐으로 사람이 사는지 봅니다.',
    why: '집을 비우게 하는 데(명도) 드는 시간과 돈을 가늠합니다. 누가 사는지는 현황조사서와 같이 봅니다.',
  },
  {
    id: 'house-roof', place: 'outside', name: '지붕과 담장', kinds: ['house'], deals: OWN,
    how: '지붕 재료(슬레이트인지)와 새는 곳, 홈통, 담장 금과 기울기, 담이 옆집 땅에 걸쳤는지 봅니다.',
    why: '고치거나 헐 때 큰돈이 드는 곳입니다.',
  },
  {
    id: 'house-road', place: 'outside', name: '길과 경사', kinds: ['house'], deals: OWN,
    how: '차가 다니는 길에 땅이 2m 넘게 붙어 있는지, 골목 경사와 폭을 봅니다.',
    why: '헐고 새로 지으려면 대지가 도로에 2m 이상 붙어 있어야 합니다.',
    sources: [law('건축법 제44조(대지와 도로의 관계)', '건축법', '004400')],
  },

  // ---------- 집 하자: 위반건축물 흔적 ----------
  {
    id: 'il-count', place: 'illegal', name: '층수와 집 수', deals: ALL,
    how: '건축물대장의 층수, 층별 용도, 세대수(호수)를 실제 층, 현관문, 우편함, 초인종 수와 견줍니다. 실제가 더 많으면 증축이나 방 쪼개기를 의심합니다.',
    why: '대장에 아직 안 올랐어도 걸리면 그때 소유자에게 시정명령이 나오고, 고치지 않으면 이행강제금이 1년에 2번까지 되풀이해 나옵니다. 위반을 내가 만들지 않았어도 소유자면 대상입니다(전 주인에게 나온 이행강제금 자체는 넘어오지 않음).\n살 때 딱 봐도 알 만했으면 판 사람에게 하자로 묻기 어렵습니다(알았거나 과실로 몰랐으면 담보책임이 없음).\n세입자도 점유자로 시정명령 대상에 들고, 대장에 위반으로 오르면 전세대출과 반환보증이 막힙니다(반환보증은 아파트 예외).',
    sources: [
      law('건축법 제79조(시정명령: 소유자, 관리자, 점유자)', '건축법', '007900'),
      law('건축법 제80조(이행강제금)', '건축법', '008000'),
      prec('대법원 2012두20137(위법을 만들지 않은 소유자도 시정명령 대상)', '2012두20137', '2013-09-13'),
      prec('대법원 2006마470(이행강제금 납부의무는 넘어가지 않음)', '2006마470', '2006-12-08'),
      law('민법 제580조(알았거나 과실로 몰랐으면 하자담보 없음)', '민법', '058000'),
      prec('대법원 79다827(미리 조사하지 않은 매수인은 과실)', '79다827', '1979-07-24'),
      ILLEGAL_TYPES,
      HUG_HOUSE_CHECK,
    ],
  },
  {
    id: 'il-addon', place: 'illegal', name: '덧지은 방', deals: ALL,
    how: '옥상이나 베란다에 샌드위치 패널이나 새시로 덧댄 방, 옥탑방을 봅니다.',
    why: ILLEGAL_WHY_SHORT,
  },
  {
    id: 'il-split', place: 'illegal', name: '쪼갠 방', deals: INSIDE,
    how: '한 집을 벽으로 나눠 현관이나 화장실을 따로 낸 방, 집 수보다 많은 전기나 가스 계량기를 봅니다.',
    why: ILLEGAL_WHY_SHORT,
    sources: [ILLEGAL_TYPES],
  },
  {
    id: 'il-shop', place: 'illegal', name: '상가를 집으로', kinds: ['villa', 'house'], deals: ALL,
    how: '대장 용도가 근린생활시설(사무소, 소매점 등)인 층을 집으로 꾸몄는지 봅니다.',
    why: '근린생활시설은 HUG 반환보증 대상 주택이 아니고, HF 전세보증은 등기상 주택이나 오피스텔이어야 해서 전세대출이 막힙니다.\n' + ILLEGAL_WHY_SHORT,
    sources: [HUG_RETURN, HF_JEONSE, ILLEGAL_TYPES],
  },
  {
    id: 'il-parking', place: 'illegal', name: '주차장을 막은 방', kinds: ['villa'], deals: ALL,
    how: '1층 필로티 주차장을 막아 방이나 창고로 쓴 곳을 봅니다.',
    why: ILLEGAL_WHY_SHORT,
  },

  // ---------- 집 하자: 화장실 ----------
  {
    id: 'pressure', place: 'bath', name: '수압', deals: INSIDE,
    how: '세면대와 샤워기를 같이 틀어 둔 채 변기 물을 내립니다. 줄기가 확 약해지는지 봅니다.',
    sources: [HUG_HOUSE_CHECK],
  },
  {
    id: 'hot-water', place: 'bath', name: '온수', deals: INSIDE,
    how: '온수를 틀고 따뜻한 물이 나오기까지 몇 초 걸리는지, 쓰는 동안 온도가 오르내리는지 봅니다.',
  },
  {
    id: 'drain', place: 'bath', name: '물 빠짐과 냄새', deals: INSIDE,
    how: '세면대와 바닥 배수구에 물을 흘려 고이지 않고 빠지는지, 배수구에서 냄새가 올라오는지 봅니다.',
  },
  {
    id: 'toilet', place: 'bath', name: '변기', deals: INSIDE,
    how: '물을 내려 잘 내려가고 다시 차는지, 밑동에 물기나 누런 자국이 없는지 봅니다.',
  },
  {
    id: 'bath-mold', place: 'bath', name: '곰팡이와 환기', deals: INSIDE,
    how: '천장 모서리, 실리콘, 타일 줄눈의 검은 곰팡이를 보고, 창문이나 환풍기가 있는지 봅니다.',
  },
  {
    id: 'rust', place: 'bath', name: '녹물', deals: INSIDE,
    how: '오래 안 쓴 수도를 틀어 처음 나오는 물 색을 봅니다.',
    why: '배관이 오래되면 녹물이 나옵니다. 매매면 배관을 바꾼 적이 있는지 묻습니다.',
  },

  // ---------- 집 하자: 주방과 세탁 ----------
  {
    id: 'sink-under', place: 'kitchen', name: '싱크대 아래', deals: INSIDE,
    how: '수납장 바닥이 젖었거나 부풀었는지, 배수관 이음새에서 새는지 손전등으로 봅니다. 물을 세게 틀어 빠지는 속도도 봅니다.',
  },
  {
    id: 'cooktop', place: 'kitchen', name: '가스레인지와 후드', deals: INSIDE,
    how: '불이 켜지는지, 가스인지 인덕션인지, 후드가 도는지 봅니다.',
  },
  {
    id: 'appliance-spots', place: 'kitchen', name: '가전 자리', deals: INSIDE,
    how: '세탁기 자리에 수도꼭지, 배수구, 콘센트가 있는지 보고, 냉장고와 세탁기 자리 크기를 잽니다.',
  },
  {
    id: 'options', place: 'kitchen', name: '옵션 작동', deals: RENT,
    how: '에어컨을 켜 찬바람과 냄새를 보고, 냉장고와 세탁기가 도는지, 제조연월은 언제인지 봅니다. 고장 나면 누가 고치는지도 묻습니다.',
  },

  // ---------- 집 하자: 방과 창 ----------
  {
    id: 'stains', place: 'room', name: '천장과 벽 얼룩', deals: INSIDE,
    how: '누렇게 번진 얼룩, 벽지가 들뜬 곳, 한 군데만 새로 도배한 곳을 봅니다.',
    why: '윗집이나 옥상, 외벽에서 물이 샌 흔적입니다. 새로 바른 벽지가 얼룩을 가린 경우가 있습니다.',
  },
  {
    id: 'condensation', place: 'room', name: '결로와 곰팡이', deals: INSIDE,
    how: '창틀, 바깥쪽 벽 모서리, 붙박이장 뒤를 봅니다. 가구로 가려진 곳은 들춰 봅니다.',
    why: '겨울에 창과 바깥벽에 물이 맺히는 집은 닦아도 곰팡이가 다시 생깁니다.',
  },
  {
    id: 'smell', place: 'room', name: '냄새', deals: INSIDE,
    how: '들어서자마자 곰팡내, 담배 냄새, 하수구 냄새가 나는지 맡습니다. 방향제가 유난히 진하면 의심합니다.',
  },
  {
    id: 'windows', place: 'room', name: '창문과 외풍', deals: INSIDE,
    how: '창을 다 열고 닫아 보고, 이중창인지, 틈으로 바람이 드는지, 방충망이 찢어졌는지 봅니다.',
  },
  {
    id: 'light', place: 'room', name: '해와 방향', deals: INSIDE,
    how: '불을 끄고 밝기를 보고, 나침반 앱으로 큰 창 방향을 봅니다. 앞 건물이 해를 가리는지 봅니다.',
  },
  {
    id: 'noise', place: 'room', name: '소음', deals: INSIDE,
    how: '창을 닫고 1분쯤 조용히 들어 봅니다(차, 가게, 윗집, 옆집). 벽을 두드려 속이 빈 소리가 나면 얇은 벽입니다.',
  },
  {
    id: 'floor', place: 'room', name: '바닥', deals: INSIDE,
    how: '들뜨거나 꺼진 곳을 밟아 보고, 수평계 앱으로 기운 곳을 봅니다.',
  },
  {
    id: 'bugs', place: 'room', name: '벌레 흔적', deals: INSIDE,
    how: '싱크대 아래와 구석에 바퀴벌레 약, 끈끈이, 배설물 자국이 있는지 봅니다.',
  },
  {
    id: 'signal', place: 'room', name: '휴대폰과 인터넷', deals: INSIDE,
    how: '방 안에서 신호와 데이터 속도를 보고, 인터넷이 어느 회사 것인지 묻습니다.',
  },
  {
    id: 'size', place: 'room', name: '실제 넓이', deals: INSIDE,
    how: '줄자로 침대, 책상, 옷장 자리를 잽니다. 광고 면적보다 좁게 느껴지면 전용면적을 다시 묻습니다. 1인 가구 최저주거기준은 14㎡입니다.',
    sources: [HUG_HOUSE_CHECK],
  },

  // ---------- 집 하자: 전기, 가스, 난방 ----------
  {
    id: 'outlets', place: 'utility', name: '콘센트', deals: INSIDE,
    how: '수와 위치를 보고 충전기를 꽂아 전기가 들어오는지 봅니다. 멀티탭이 줄줄이 꽂혀 있었다면 콘센트가 모자란 집입니다.',
  },
  {
    id: 'breaker', place: 'utility', name: '차단기', deals: INSIDE,
    how: '두꺼비집(분전함) 자리와 누전차단기가 있는지 봅니다.',
  },
  {
    id: 'boiler', place: 'utility', name: '보일러와 난방', deals: INSIDE,
    how: '보일러 명판의 제조연월, 도시가스인지 기름이나 전기인지, 개별난방인지 봅니다. 바닥 난방을 켜서 따뜻해지는지 봅니다.',
    why: '세입자면 기본 설비 고장은 집주인이 고칠 몫입니다(계약 전 목록의 고칠 것). 사는 사람은 바꿀 때 드는 돈을 셈합니다.',
  },
  {
    id: 'gas-hose', place: 'utility', name: '가스 호스와 밸브', deals: INSIDE,
    how: '가스레인지 호스가 갈라지거나 낡았는지, 중간 밸브가 잘 잠기는지 봅니다.',
    sources: [HUG_HOUSE_CHECK],
  },
  {
    id: 'fire', place: 'utility', name: '화재감지기와 소화기', kinds: ['villa', 'house'], deals: INSIDE,
    how: '천장의 단독경보형 감지기와 소화기가 있는지 봅니다.',
    why: '아파트와 기숙사를 뺀 주택은 소유자가 소화기와 단독경보형 감지기를 달아야 합니다.',
    sources: [law('소방시설 설치 및 관리에 관한 법률 제10조(주택용 소방시설)', '소방시설 설치 및 관리에 관한 법률', '001000')],
  },
  {
    id: 'meters', place: 'utility', name: '계량기', deals: RENT,
    how: '전기, 수도, 가스 계량기가 집마다 따로인지 봅니다. 같이 쓰면 요금을 어떻게 나누는지 묻습니다.',
  },
  {
    id: 'aircon-spot', place: 'utility', name: '에어컨 자리', deals: INSIDE,
    how: '에어컨이 없으면 배관 구멍과 실외기 둘 곳이 있는지 봅니다.',
  },

  // ---------- 집 하자: 동네 ----------
  {
    id: 'walk', place: 'town', name: '역까지 걸어 보기', deals: ALL,
    how: '지도에 나온 시간 말고 실제로 걸어 봅니다(오르막, 신호, 출구 위치).',
  },
  {
    id: 'night', place: 'town', name: '저녁 골목', deals: ALL,
    how: '가로등, 골목 폭, 술집과 유흥가가 가까운지 저녁에 봅니다.',
  },
  {
    id: 'shops', place: 'town', name: '가게와 병원', deals: ALL,
    how: '편의점, 마트, 세탁소, 병원과 약국까지 거리를 봅니다.',
  },
  {
    id: 'construction', place: 'town', name: '공사와 빈 땅', deals: ALL,
    how: '근처 공사장(소음, 먼지), 앞의 빈 땅이나 낮은 건물(나중에 높게 지으면 해를 가림)을 봅니다.',
  },
  {
    id: 'town-sound', place: 'town', name: '냄새와 소리', deals: ALL,
    how: '식당 배기구, 쓰레기장, 큰길과 철길, 학교와 공장 소리를 봅니다.',
  },
  {
    id: 'zone-rent', place: 'town', name: '재개발과 재건축 구역', deals: RENT,
    how: '매물 탭 지도의 정비구역 칠하기로 구역 안인지 봅니다.',
    why: '관리처분계획 인가가 나면 2년 보장 같은 임대차 기간 규정이 적용되지 않아 계약 중에도 나가야 할 수 있습니다. 그때는 계약을 해지하고 보증금을 사업시행자에게 청구할 수 있습니다.',
    sources: [law('도시 및 주거환경정비법 제70조(임차인의 해지와 보증금)', '도시 및 주거환경정비법', '007000'), law('제81조(인가 고시 뒤 사용 제한)', '도시 및 주거환경정비법', '008100')],
  },
  {
    id: 'zone-own', place: 'town', name: '재개발과 재건축 구역', deals: OWN,
    how: '매물 탭 지도의 정비구역 칠하기와 매물 카드의 물딱지 이름표로 구역 안인지, 조합원이 될 수 있는지 봅니다.',
    goto: { tab: 'apt', label: '서울 아파트 탭 정비구역 조건' },
  },

  // ---------- 계약 전: 시세와 돈 ----------
  {
    id: 'jeonse-rate', place: 'money', name: '전세가율', deals: ['jeonse'],
    how: '전세금을 매매 시세로 나눕니다. 같은 단지 매매 실거래나 비슷한 집 시세를 쓰고, 등기부 을구 근저당(채권최고액)까지 더해 집값의 몇 %인지도 봅니다. 이 목록의 계산기에 넣으면 바로 나옵니다.',
    why: '법으로 정한 위험 기준은 없습니다. HUG 전세사기예방센터와 국토부는 보증금이 시세의 80%를 넘는 집은 피하라고 하고, 서울시 안내는 전세가율 70%를 넘지 않는 것이 좋다고 합니다.\n집값이 내려 보증금과 근저당 합보다 낮아지면 경매로 팔려도 보증금을 다 못 돌려받습니다(깡통전세).',
    goto: { tab: 'market', label: '서울 평균 전세가율(시세 통계 탭)' },
    sources: [
      { title: 'HUG 전세사기예방센터: 보증금이 시세의 80%를 넘으면 피하기', url: 'https://www.khug.or.kr/jeonse/web/s03/s030104.jsp', date: '' },
      MOLIT_JEONSE_TIPS,
      { title: '서울시: 전세가율 70%를 넘지 않는 것이 좋다', url: 'https://mediahub.seoul.go.kr/archives/2015838', date: '2025-10-14' },
      { title: 'KOSIS: 유형별 매매가격 대비 전세가격 비율(한국부동산원)', url: 'https://kosis.kr/statHtml/statHtml.do?orgId=408&tblId=DT_30404_N0006_R1', date: '' },
      RT_SEARCH,
    ],
  },
  {
    id: 'fees', place: 'money', name: '관리비', deals: RENT,
    how: '얼마이고 무엇이 들어가는지(수도, 전기, 인터넷, TV, 청소, 승강기) 묻고, 지난달 고지서를 보여 달라고 합니다. 겨울 난방비도 묻습니다.',
    why: '정액관리비가 월 10만원 이상이면 광고에 비목별 금액(일반관리비, 전기, 수도, 가스, 난방, 인터넷, TV, 기타)을 적어야 합니다. 임대차는 확인설명서에도 관리비 금액과 내역을 적습니다(2024.7.10부터).',
    sources: [
      { title: '국토교통부고시: 중개대상물의 표시광고 명시사항 세부기준', url: 'https://www.law.go.kr/LSW/admRulInfoP.do?admRulSeq=2100000250356', date: '' },
      { title: '국토교통부: 관리비 세부 내역 표시 시행', url: 'https://www.molit.go.kr/USR/NEWS/m_71/dtl.jsp?id=95088842', date: '2023-09-21' },
      law('공인중개사법 시행령 제21조(확인설명 사항)', '공인중개사법 시행령', '002100'),
    ],
  },
  {
    id: 'small-deposit', place: 'money', name: '최우선변제', deals: RENT,
    how: '서울은 보증금이 1억 6,500만원 이하면 집이 경매로 넘어가도 5,500만원까지는 근저당보다 먼저 받습니다. 기준은 계약한 날이 아니라 그 집에 먼저 잡힌 근저당 날짜로 정해서, 2021.5.11부터 2023.2.20 사이에 잡힌 근저당이 있으면 1억 5천만원 이하 5천만원까지, 2018.9.18부터 2021.5.10 사이면 1억 1천만원 이하 3,700만원까지입니다.',
    why: '경매 신청 등기 전에 입주와 전입을 마쳐야 하고, 경매가 열리면 배당요구를 해야 받습니다.\n먼저 받는 돈은 경매로 팔린 집값의 절반까지입니다. 다가구처럼 소액 세입자가 여럿이고 그 몫을 다 더한 돈이 절반을 넘으면, 절반을 몫의 비율대로 나눕니다. 예를 들어 12억에 팔린 다가구에 보증금 5천만원 세입자가 15명이면 몫 합 7억 5천만원이 절반인 6억을 넘어 한 사람에 4천만원씩이고, 나머지 1천만원은 먼저 잡힌 근저당이 가져간 뒤 남는 돈이 있어야 받습니다.',
    sources: [
      law('주택임대차보호법 제8조(소액보증금 우선변제)', '주택임대차보호법', '000800'),
      law('시행령 제10조(일정액, 집값 절반 한도와 여럿이면 나누기)', '주택임대차보호법 시행령', '001000'),
      law('시행령 제11조(소액임차인 범위)', '주택임대차보호법 시행령', '001100'),
      { title: '정책브리핑: 서울 1억 1천만원과 3,700만원에서 1억 5천만원과 5천만원으로(시행 전 담보물권자는 종전 규정)', url: 'https://www.korea.kr/news/policyNewsView.do?newsId=148886994', date: '2021-05-04' },
    ],
  },
  {
    id: 'converted', place: 'money', name: '환산 월세', deals: ['monthly'],
    how: '보증금과 월세가 다른 집끼리는 매물 카드의 환산 월세(보증금을 월세로 바꾼 값)로 견줍니다.',
  },
  {
    id: 'sale-trades', place: 'money', name: '실거래와 호가', deals: ['buy'],
    how: '같은 단지 같은 전용면적 실거래를 봅니다. 아파트 매매 매물 카드에는 실거래 중간값이 붙습니다.',
    sources: [RT_SEARCH],
  },
  {
    id: 'bid-limit', place: 'money', name: '입찰가 상한', deals: ['auction'],
    how: '같은 단지 실거래와 그 구의 낙찰가율을 보고 넘지 않을 값을 미리 정합니다.',
    goto: { tab: 'auction', label: '경매 탭 매각 결과' },
    sources: [RT_SEARCH],
  },
  {
    id: 'auction-extra', place: 'money', name: '더 들 돈', deals: ['auction'],
    how: '입찰보증금(보통 최저가의 10%)을 준비하고, 대항력 있는 세입자에게 돌려줄 보증금, 밀린 공용관리비, 내보내는 비용(명도), 수리비를 낙찰가에 더해 봅니다.',
    sources: [law('민사집행규칙 제63조(입찰보증금)', '민사집행규칙', '006300')],
  },
  {
    id: 'auction-defect', place: 'money', name: '수리비는 내 몫', deals: ['auction'],
    how: '경매는 집에 하자가 있어도 판 사람에게 물을 수 없어서, 감정평가서 사진과 밖에서 본 상태로 수리비를 미리 셈합니다.',
    why: '민법의 물건 하자 담보책임은 경매에 적용하지 않습니다. 권리에 흠이 있으면 채무자나 배당받은 채권자에게 물을 수 있습니다.',
    sources: [law('민법 제580조 제2항(경매에는 하자담보 없음)', '민법', '058000'), law('민법 제578조(경매와 권리 흠결)', '민법', '057800')],
  },
  {
    id: 'arrears', place: 'money', name: '밀린 관리비', kinds: ['apt', 'officetel', 'villa'], deals: OWN,
    how: '관리사무소에 밀린 관리비가 있는지, 그중 공용부분이 얼마인지 묻습니다.',
    why: '전 주인이 밀린 관리비 중 공용부분은 산 사람(낙찰자 포함)이 물려받습니다.',
    sources: [COMMON_FEES],
  },

  // ---------- 계약 전: 집주인과 중개사 ----------
  {
    id: 'agent', place: 'people', name: '눈앞의 사람이 공인중개사인지', deals: INSIDE,
    how: '집을 보여 주고 계약을 맡을 사람이 등록된 공인중개사인지 아래 순서로 봅니다. 전국 조회는 국토교통부 브이월드가 기본이고, 서울 사무소는 서울부동산정보광장에서 대표자 사진까지 봅니다.',
    stepsTitle: '확인 순서',
    steps: [
      { text: '사무소 벽에 걸린 중개사무소 등록증에서 등록번호와 대표자 이름을, 공인중개사 자격증과 보증 서류도 봅니다(걸어 두는 것이 의무).' },
      {
        text: '브이월드 부동산 중개업 조회에서 시도와 시군구를 고르고 상호나 등록번호로 사무소를 찾아 상태가 영업인지 봅니다(상태의 시작일과 종료일도 나옴). 상세검색 기준을 중개사/보조원으로 바꾸면 명함 속 사람 이름으로도 찾습니다.',
        links: [{ label: '브이월드 부동산 중개업 조회', url: VWORLD_BROKER.url }],
      },
      { text: '상세에서 대표자가 공인중개사인지(구분), 보증보험 유무, 소속공인중개사와 중개보조원 명단을 보고 명함 속 이름과 직위를 맞춰 봅니다.' },
      {
        text: '서울 사무소면 서울부동산정보광장 개업공인중개사 사무소 조회에서 대표자 사진을 얼굴과 맞춰 보고 행정처분 이력도 봅니다.',
        links: [{ label: '서울부동산정보광장 중개사무소 조회', url: BROKER_SEARCH.url }],
      },
      { text: '명단에 없거나 중개보조원이면 설명과 계약서 작성은 공인중개사에게 받습니다. 계약서와 확인설명서에 서명한 사람이 명단의 공인중개사인지 봅니다.' },
    ],
    why: '집을 보여 주는 사람이 중개보조원이면 그 사실을 미리 알려야 합니다(어기면 500만원 이하 과태료).\n확인설명서에는 개업공인중개사가, 그 일을 한 소속 공인중개사가 있으면 그 사람도 서명하고 도장을 찍습니다. 서명한 사람이 조회 명단에 있는지 봅니다.\n중개사가 잘못 설명해 손해가 나면 배상해야 하고, 그 돈을 위해 개인은 2억원 이상 보증(보험, 공제, 공탁)에 들어 있어야 합니다.\n브이월드는 전국 시군구 등록 정보를 모아 보여 줘서 시군구 정보보다 조금 늦을 수 있습니다. 한국공인중개사협회 개업공인중개사 검색은 영업 중인 사무소만 나오고 휴업과 폐업을 달마다 받아 넣으며, 소속공인중개사와 중개보조원은 나오지 않아 협회도 브이월드를 안내합니다. 협회 검색의 공제 표시는 협회 공제만 보여 줘서, 다른 보증보험에 든 사무소는 미가입처럼 보일 수 있습니다.',
    sources: [
      VWORLD_BROKER,
      KAR_BROKER,
      BROKER_SEARCH,
      law('공인중개사법 제17조(등록증 등 게시)', '공인중개사법', '001700'),
      law('시행규칙 제10조(게시할 서류)', '공인중개사법 시행규칙', '001000'),
      law('제18조의4(중개보조원 고지의무)', '공인중개사법', '001804', '2023-04-18'),
      law('제25조(확인설명서 서명과 날인)', '공인중개사법', '002500'),
      law('제30조(손해배상과 보증)', '공인중개사법', '003000'),
      law('제51조(과태료)', '공인중개사법', '005100'),
    ],
  },
  {
    id: 'owner-id', place: 'people', name: '집주인이 진짜 소유자인지', deals: INSIDE,
    how: '계약하는 사람이 등기부의 소유자 본인인지 아래 순서로 봅니다. 신분증 진위확인은 사진을 보지 않아서, 얼굴은 내가 직접 맞춰 봐야 합니다.',
    stepsTitle: '확인 순서',
    steps: [
      {
        text: '계약 당일 뗀 등기부 갑구에서 지금 소유자의 이름과 생년월일을 봅니다. 공동명의면 명의자와 지분을 모두 보고, 세를 얻을 때는 지분을 더해 절반이 넘는 사람들과(둘이 반씩이면 둘 다), 살 때는 명의자 모두와 계약합니다. 안 나온 명의자는 아래 대리인처럼 위임장과 인감증명서로 확인합니다.',
        links: [{ label: '인터넷등기소', url: 'https://www.iros.go.kr/' }],
      },
      { text: '신분증 원본을 받아 이름과 생년월일이 등기부와 같은지, 사진이 눈앞의 얼굴인지 봅니다.' },
      {
        text: '신분증이 진짜인지 확인합니다. 주민등록증은 ☎1382(번호와 발급일자 입력)나 정부24, 운전면허증은 경찰청 이파인에서 봅니다.',
        links: [{ label: '주민등록증 진위확인', url: 'https://www.mois.go.kr/frt/sub/a06/b06/IDCard_7/screen.do' }, { label: '이파인', url: 'https://www.efine.go.kr/' }],
      },
      { text: '계약금과 잔금은 등기부 소유자 이름의 계좌로만 보내고, 보내기 전에 예금주 이름을 확인합니다.' },
      { text: '집주인 대신 대리인이 나오면 바로 아래 대리인 항목의 순서로 확인합니다.' },
    ],
    why: '진위확인은 이름, 번호, 발급일자만 맞춰 보고 사진은 확인하지 않습니다. 남의 신분증 정보에 다른 사람 사진을 붙인 위조는 진위확인을 통과할 수 있습니다.\n공동명의 집을 세놓는 일은 지분 과반수로 정하고, 파는 일은 명의자 모두가 동의해야 합니다. 여럿이 함께 세를 놓고 받은 보증금은 그중 누구에게나 전부 돌려 달라고 할 수 있습니다.',
    goto: { tab: 'fraud', label: '사기 사례 탭' },
    sources: [
      ID_CHECK,
      SEAL_CHECK,
      law('민법 제265조(공유물 관리는 지분 과반수)', '민법', '026500'),
      prec('대법원 2010다37905(공유물을 세놓는 것은 지분 과반수로)', '2010다37905', '2010-09-09'),
      law('민법 제264조(공유물 처분은 모두 동의)', '민법', '026400'),
      prec('대법원 98다43137(함께 세놓은 공유자의 보증금 반환은 불가분채무)', '98다43137', '1998-12-08'),
    ],
  },
  {
    id: 'proxy', place: 'people', name: '대리인이 나왔을 때', deals: INSIDE,
    how: '집주인 대신 가족, 관리인, 중개사가 대리인으로 나오면 아래 순서로 대리 권한과 집주인 뜻을 확인합니다. 서류를 나중에 주겠다거나 집주인과 통화를 피하면 계약하지 않습니다.',
    stepsTitle: '확인 순서',
    steps: [
      {
        text: '대리인 신분증 원본을 받아 위임장에 적힌 대리인 이름, 생년월일과 맞춰 보고, 신분증 진위도 확인합니다(주민등록증은 ☎1382나 정부24, 운전면허증은 이파인).',
        links: [{ label: '주민등록증 진위확인', url: ID_CHECK.url }, { label: '이파인', url: 'https://www.efine.go.kr/' }],
      },
      { text: '위임장에 집 주소, 집주인과 대리인 인적사항, 보증금과 월세 같은 계약 조건, 맡긴 범위, 보증금 받을 사람이 적혀 있고 집주인 인감이 찍혀 있는지 봅니다. 서명만 된 위임장이면 본인서명사실확인서를 받습니다.' },
      { text: '인감증명서 원본을 받아 위임장과 계약서에 찍힌 도장이 인감과 같은지 대조합니다. 인감증명서의 본인란과 대리인란 중 어디에 ○가 있는지 보고, 대리인이 뗀 것이면 더 의심합니다. 매매면 용도가 부동산 매도용이고 매수자란에 내 이름이 있어야 합니다.' },
      {
        text: '정부24에서 인감증명서의 발급기관, 발급일자, 주민등록번호, 발급번호를 넣어 진짜 발급됐는지 봅니다.',
        links: [{ label: '인감증명발급 사실확인', url: SEAL_CHECK.url }],
      },
      { text: '집주인 본인과 통화해 위임한 것이 맞는지, 보증금과 월세, 기간, 입금 계좌를 다시 확인하고 녹음합니다. 계약서나 위임장에 적힌 집주인 번호가 대리인 번호와 같지 않은지 보고, 대리인이 알려 준 번호만 믿지 않습니다.' },
      { text: '보증금은 등기부 소유자 이름의 계좌로 보냅니다. 대리인 계좌로 보내야 하면 집주인 요청이라는 것을 특약에 적습니다. 위임장과 인감증명서 원본은 계약하는 날 받아 보관합니다.' },
    ],
    clauses: [{
      name: '대리인 계좌로 보낼 때',
      text: '임차인은 임대인의 요청에 따라 보증금(계약금과 잔금)을 임대인의 대리인 ○○○ 명의 계좌(○○은행 ○○○○)로 보내며, 이 계좌로 보낸 돈은 임대인이 받은 것으로 한다.',
    }],
    why: '대리권 없는 사람과 맺은 계약은 집주인이 추인하지 않으면 집주인에게 효력이 없습니다. 서류 확인을 소홀히 하면 표현대리로 집주인에게 책임을 묻기 어렵고, 대리인에게 책임을 묻는 길도 막힐 수 있습니다. 판례는 계약할 때를 기준으로 판단해서 계약 뒤에 받은 서류는 도움이 안 됩니다.\n인감증명서는 발급 위임장과 신분증만 있으면 대리로도 받을 수 있어서, 집주인 도장과 신분증에 손이 닿는 가족이 몰래 받아 쓴 판례가 있습니다. 본인서명사실확인서는 본인이 직접 가야만 나옵니다.\n임대차 계약에는 인감증명서 유효기간이 따로 없습니다(3개월은 등기 신청 서류 기준).\n통화도 완벽하지 않습니다. 계약서에 적힌 임대인 번호로 건 전화를 공범이 받아 임대인 행세를 한 판결이 있고, 계약서의 임대인과 대리인 연락처가 모두 대리인 번호였던 사건도 있습니다. 집주인 번호를 따로 얻는 공식 방법은 찾지 못했습니다.\n매매면 특약의 임대인, 임차인, 보증금을 매도인, 매수인, 대금으로 바꿔 씁니다.',
    goto: { tab: 'fraud', label: '사기 사례 탭 대리인 사칭' },
    sources: [
      { title: 'HUG 전세사기예방센터: 대리인 확인(위임장에 적을 것, 인감 대조, 통화 녹음)', url: 'https://www.khug.or.kr/jeonse/web/s03/s030203.jsp', date: '' },
      { title: 'HUG 사례: 가짜 임대인과의 계약(대리인 계좌면 특약에 적기)', url: 'https://www.khug.or.kr/jeonse/web/s02/s020301.jsp', date: '' },
      { title: '정책브리핑: 대리인이 오면 위임장과 인감증명서 대조, 임대인과 통화', url: 'https://www.korea.kr/news/policyNewsView.do?newsId=148940366', date: '2025-03-10' },
      { title: '찾기쉬운 생활법령: 임대차계약의 당사자 확인(위임장에 적을 것)', url: 'https://m.easylaw.go.kr/MOB/CsmInfoRetrieve.laf?csmSeq=629&ccfNo=2&cciNo=2&cnpClsNo=1', date: '' },
      SEAL_CHECK,
      law('인감증명법 시행령 제13조(대리 발급, 매도용 매수자란)', '인감증명법 시행령', '001300'),
      law('본인서명사실 확인 등에 관한 법률 제5조(본인이 직접 방문)', '본인서명사실 확인 등에 관한 법률', '000500'),
      law('부동산등기규칙 제62조(3개월은 등기 신청 서류)', '부동산등기규칙', '006200'),
      law('민법 제130조(무권대리)', '민법', '013000'),
      law('민법 제126조(권한을 넘은 표현대리)', '민법', '012600'),
      law('민법 제135조(무권대리인의 책임, 알 수 있었으면 못 물음)', '민법', '013500'),
      prec('대법원 98다18988(위조한 발급 위임장으로 대리 발급, 용도란 공란)', '98다18988', '1998-07-10'),
      prec('대법원 2017다2472(계약 당시 기준, 계약 뒤 서류는 안 봄)', '2017다2472', '2018-07-24'),
      prec('대법원 2009도10139(공범이 임대인 행세로 확인 전화를 받음)', '2009도10139', '2010-01-28'),
      prec('대법원 2007다73611(중개사의 대리관계 확인 의무)', '2007다73611', '2008-03-13'),
      { title: '서울고법 2013나79810(공동임대인 한 명의 대리권 없음, 중개사 책임 50%)', url: 'https://www.law.go.kr/LSW/precInfoP.do?precSeq=175318', date: '2014-06-25' },
      { title: '파이낸셜뉴스: 계약서 연락처가 모두 대리인 번호(김해)', url: 'https://www.fnnews.com/news/202305101453511051', date: '2023-05-10' },
    ],
  },
  {
    id: 'owner-account', place: 'people', name: '돈 보낼 계좌', deals: INSIDE,
    how: '계약금과 잔금은 등기부 소유자 이름의 계좌로만 보냅니다.',
    sources: [PAY_OWNER],
  },
  {
    id: 'owner-taxes', place: 'people', name: '집주인 세금 미납', deals: RENT,
    how: '집주인 세금이 밀렸는지 봅니다. 가장 쉬운 길은 집주인에게 납세증명서를 떼어 달라는 것이고, 더 넓게 보려면 세무서와 시군구청 창구에서 미납 세금을 열람합니다(전화나 온라인 열람 경로는 공식 안내를 못 찾았습니다).',
    stepsTitle: '확인 순서',
    steps: [
      {
        text: '집주인에게 국세와 지방세 납세증명서를 떼어 보여 달라고 합니다. 온라인 발급(정부24, 홈택스, 위택스)은 집주인 본인 인증으로만 되고, 대리 발급은 위임장을 들고 창구에 가야 해서 세입자가 정부24에서 대신 뗄 수는 없습니다. 정부24에서 뗀 국세 납세증명서에는 진위를 확인하는 QR코드가 있습니다. 발급한 날 밀린 세금만 보여 줘서 계약 직전에 뗀 것을 봅니다.',
        links: [
          { label: '정부24 국세 납세증명서', url: 'https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=12100000011' },
          { label: '정부24 지방세 납세증명서', url: 'https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=13100000056' },
        ],
      },
      { text: '열람을 하려면 신분증을 들고 국세는 아무 세무서 민원실(집 관할이 아니어도 됨), 지방세는 시군구청 세무 부서에 가서 미납국세 등 열람신청서와 미납지방세 등 열람신청서를 씁니다.' },
      { text: '계약 전에는 집주인 동의를 증명하는 서류가 필요합니다. 지방세 열람신청서에는 임대인 동의서 칸이 있어 집주인이 서명하거나 도장을 찍어 주면 되고, 국세는 창구에 동의서 양식을 묻습니다.' },
      { text: '계약한 뒤 입주일 전까지는 보증금이 1천만원을 넘으면 동의 없이 계약서 사본으로 열람할 수 있습니다(집주인에게 통지됨).' },
      { text: '밀린 세금이 나오면 잔금 전에 다 내게 하고 납세증명서로 다시 확인하거나, 해제 특약에 따라 계약을 정리합니다.' },
    ],
    why: '집주인은 계약할 때 납세증명서를 보여 줘야 하고, 열람에 동의하면 대신할 수 있습니다(2023.4.18부터). 중개사도 열람할 수 있다는 것을 설명해야 합니다.\n집주인 세금 중 법정기일이 내 확정일자보다 앞선 것은 집이 경매나 공매로 넘어갈 때 내 보증금보다 먼저 가져갑니다.\n납세증명서는 발급한 날 밀린 세금만 보여 주고, 열람에는 신고하고 안 낸 세금과 고지됐지만 납기가 안 된 세금까지 나옵니다. 국세 열람은 집 관할이 아닌 세무서에 신청해도 됩니다.',
    sources: [
      law('주택임대차보호법 제3조의7(임대인 정보 제시)', '주택임대차보호법', '000307', '2023-04-18'),
      law('공인중개사법 제25조의3(임차인에게 설명)', '공인중개사법', '002503'),
      law('국세징수법 제109조(미납국세 열람)', '국세징수법', '010900'),
      law('시행령 제97조(동의 없이는 보증금 1천만원 초과)', '국세징수법 시행령', '009700'),
      law('지방세징수법 제6조(미납지방세 열람)', '지방세징수법', '000600'),
      law('시행령 제8조(1천만원)', '지방세징수법 시행령', '000800'),
      law('국세기본법 제35조(국세와 확정일자 보증금의 순서)', '국세기본법', '003500'),
    ],
  },
  {
    id: 'safe-app', place: 'people', name: '안심전세 앱으로 집과 집주인 보기', deals: RENT,
    how: 'HUG 안심전세 앱(무료)으로 계약 전에 집 시세와 적정 보증금, 집주인의 HUG 보증 이력, 상습 채무불이행자 명단을 봅니다.',
    stepsTitle: '앱에서 볼 것',
    steps: [
      {
        text: '안심조회의 시세조회와 위험성진단: 주소와 보증금을 넣어 매매시세, 지역 평균 전세가율과 경매 낙찰가율, 적정 보증금, HUG 반환보증에 들 수 있는지를 봅니다. 시세는 연립, 다세대, 아파트, 오피스텔만 나옵니다.',
        links: [L.safeApp],
      },
      {
        text: '임대인 정보조회의 안심임대인 조회: 집주인 동의 없이 HUG 반환보증 가입 건수, 보증 가입 금지 대상인지, 최근 3년 HUG가 대신 갚아 준 보증사고 건수를 봅니다. 계약하려는 사람은 공인중개사의 계약 의사 확인과 집주인 정보 입력을 마친 뒤에, 계약한 사람은 임대차 신고나 확정일자를 받은 뒤에 조회됩니다.',
        links: [{ label: 'HUG 임대인 정보조회 안내', url: HUG_LANDLORD_INFO.url }],
      },
      { text: '집주인이 앱에서 동의해 주면 세금 체납 여부와 HUG, HF 보증 가입 금지 여부, 보증사고 이력을 한 번에 봅니다.' },
      {
        text: '임대인 정보조회의 상습 채무불이행자 명단 조회: 보증금을 여러 번 안 돌려줘 이름이 공개된 집주인인지 봅니다. 동의가 필요 없습니다.',
        links: [{ label: 'HUG 상습 채무불이행자 조회', url: HUG_DEFAULTERS.url }],
      },
      { text: '공인중개사 정보조회로 중개사 경력을 보고, 계약한 뒤에는 앱의 보증가입에서 반환보증을 신청할 수 있습니다(보험 칸).' },
    ],
    why: 'HUG 보증 가입 금지 대상 집주인이면 HUG 반환보증과 HUG 보증이 붙은 대출이 막힙니다. 보증사고 건수가 있으면 HUG가 대신 보증금을 돌려준 적이 있다는 뜻입니다.\n상습 채무불이행자는 HUG가 보증금을 대신 갚은 뒤 그 전 3년 안에 다른 보증금도 안 돌려줬고, HUG 구상채권 합계가 2억원 이상이며, HUG가 강제집행이나 보전처분을 신청해 효력이 생긴 집주인입니다(2023.9.29부터 공개).\n앱 시세에 단독과 다가구는 없어서, 이 집들은 공시가격의 140%로 따로 계산합니다(보증한도와 전세가율 계산기).',
    sources: [
      SAFE_APP,
      HUG_LANDLORD_INFO,
      { title: '정책브리핑: 전세계약 전부터 임대인 동의 없이도 정보 확인 가능', url: 'https://www.korea.kr/news/policyNewsView.do?newsId=148943643', date: '2025-05-26' },
      HUG_DEFAULTERS,
      law('주택도시기금법 제34조의5(상습 채무불이행자 공개)', '주택도시기금법', '003405'),
    ],
  },
  {
    id: 'seller-taxes', place: 'people', name: '판 사람 세금', deals: ['buy'],
    how: '판 사람에게 국세와 지방세 납세증명서를 받습니다. 발급일부터 30일만 유효해서 잔금 날이 그 안에 들어야 합니다. 등기부 갑구에 압류가 있으면 풀린 뒤 잔금을 냅니다.',
    why: '산 사람이 판 사람 세금을 열람하는 제도는 없습니다(열람은 세입자용).\n세금 압류는 등기돼야 효력이 생겨서, 내 이전등기 접수 전에 압류가 없었으면 그 뒤에 판 사람 체납으로 내 집을 압류할 수 없습니다.',
    sources: [
      law('국세징수법 시행령 제96조(납세증명서 30일)', '국세징수법 시행령', '009600'),
      law('국세징수법 제109조(열람은 임차하려는 사람)', '국세징수법', '010900'),
      law('국세징수법 제46조(압류 효력은 등기 때)', '국세징수법', '004600'),
      prec('대법원 92누12117(체납자 아닌 사람 재산 압류는 무효)', '92누12117', '1993-04-27'),
    ],
  },

  // ---------- 계약 전: 서류 ----------
  {
    id: 'registry', place: 'papers', name: '등기부', deals: INSIDE,
    how: '등기사항전부증명서(말소사항 포함)를 떼서 갑구의 소유자, 신탁, 가등기, 압류와 가압류, 을구의 근저당(채권최고액)을 봅니다. 누구나 뗄 수 있고 집주인 허락도 필요 없습니다. 계약서를 쓰기 직전에 그날 뗀 것으로 보고, 잔금 직전에 한 번 더 뗍니다.',
    stepsTitle: '떼는 법',
    steps: [
      {
        text: '대법원 인터넷등기소 누리집이나 인터넷등기소 앱에서 부동산 열람이나 발급을 고르고 주소(도로명이나 지번)로 집을 찾습니다. 아파트와 빌라는 동과 호수까지 고릅니다.',
        links: [{ label: '인터넷등기소', url: 'https://www.iros.go.kr/' }, { label: '인터넷등기소 앱(앱스토어)', url: 'https://apps.apple.com/kr/app/id952161112' }],
      },
      { text: "종류는 '등기사항전부증명서(말소사항 포함)'를 고릅니다. 지워진 근저당과 예전 소유자까지 보입니다." },
      { text: '보기만 할 때는 열람(700원), 서류로 낼 때는 발급(1,000원)을 고르고 카드나 휴대폰, 간편결제로 냅니다. 등기소 창구 발급은 1,200원입니다.' },
      { text: '계약 당일과 잔금 직전에 다시 떼서 그사이 바뀐 것이 없는지 봅니다.' },
    ],
    why: '갑구에 지워지지 않은 압류, 가압류, 가처분, 가등기, 경매개시결정이 있으면 기본은 계약하지 않습니다. 압류와 가압류는 세금이나 빚 때문에 채권자가 이미 집을 묶어 둔 것이라, 그 뒤에 들어온 세입자는 그 일로 경매가 열리면 낙찰자에게 대항하지 못합니다. 가처분은 그 집을 두고 다툼이 있다는 뜻이라 가처분한 사람이 이기면 그 뒤에 된 등기가 지워집니다. HUG 반환보증도 이런 권리침해 사항이 있으면 가입이 안 됩니다.\n을구의 근저당은 흔해서 금액(전세가율과 선순위)으로 보고, 지워지지 않은 주택임차권이 있으면 앞 세입자의 임차권등기 항목대로 봅니다.\n갑구에 신탁 등기가 있으면 소유자는 신탁회사입니다. 신탁회사 동의 없이 맺은 계약은 보호받기 어렵습니다.\n최근에 지워진 근저당이 있으면 아래 항목대로 한 번 더 확인합니다.',
    goto: { tab: 'fraud', label: '사기 사례 탭' },
    sources: [
      { title: '인터넷등기소', url: 'https://www.iros.go.kr/', date: '' },
      law('등기사항증명서 등 수수료규칙 제2조(발급 1,000원, 창구 1,200원)', '등기사항증명서 등 수수료규칙', '000200'),
      law('제3조(인터넷 열람 700원)', '등기사항증명서 등 수수료규칙', '000300'),
      HUG_RETURN,
      law('부동산등기법 제94조(가처분 이후 등기 말소)', '부동산등기법', '009400'),
      { title: '경기일보 박용길의 경매이야기: 저당, 가압류, 압류, 가등기 뒤에 들어온 세입자는 낙찰자에게 대항 못함', url: 'https://kyeonggi.com/article/201301270493179', date: '2013-01-27' },
    ],
  },
  {
    id: 'erased-mortgage', place: 'papers', name: '최근에 지워진 근저당', deals: INSIDE,
    how: '말소사항 포함 등기부 을구에서 지워진 근저당을 봅니다. 지워진 것을 다 은행에 물을 수는 없으니, 대출받고 몇 달 안 돼 지워졌거나 지워지고 몇 달 안에 매물로 나온 것처럼 최근 것을 아래 순서로 확인합니다.',
    stepsTitle: '최근에 지워진 근저당이 있으면',
    steps: [
      { text: '지워진 근저당의 은행 이름, 설정 접수일, 말소 접수일을 적어 둡니다.', links: [L.iros] },
      { text: '집주인(판 사람)에게 그 은행의 대출완제확인서나 부채증명서를 받습니다.' },
      { text: '은행은 본인 동의 없이 대출 정보를 알려 주지 않아서, 집주인 동의를 받거나 같이 은행에 확인합니다. 서류에 적힌 번호가 아니라 은행 누리집의 원본 확인 화면이나 은행 공식 번호로 묻습니다.' },
      { text: '집주인이 확인을 거부하면 계약하지 않습니다. 매매면 권원보험을 들 때 이 경우도 보상되는지 서면으로 받아 둡니다.' },
    ],
    why: '등기는 권리가 생기는 요건일 뿐 남아 있는 요건이 아니라서, 위조 서류로 지워진 근저당도 그대로 살아 있습니다. 은행이 회복등기를 구하면 그 뒤에 산 사람은 몰랐어도 승낙해야 하고, 되살아난 근저당은 원래 순위로 돌아갑니다.\n등기관은 서류의 형식만 심사합니다. 통상의 주의로 쉽게 알아볼 위조를 놓쳤으면 국가도 배상하는데(위조로 지운 근저당이 되살아난 다세대를 산 사람이 위조한 사람, 대리한 변호사, 국가에게 1억 5천만원을 받은 판결), 정교한 위조라 쉽게 알 수 없었으면 국가 책임이 부정됩니다.\n집을 사려는 사람은 말소에 쓰인 등기 서류를 열람할 수 없습니다.',
    goto: { tab: 'fraud', label: '사기 사례 탭 근저당 지우고 팔기' },
    sources: [
      prec('대법원 81다카923(원인 없이 말소돼도 물권 효력 그대로)', '81다카923', '1982-09-14'),
      law('부동산등기법 제59조(말소 회복에 이해관계 있는 제3자 승낙)', '부동산등기법', '005900'),
      prec('대법원 2003다13048(등기관은 형식적 심사, 쉽게 알 위조를 놓치면 과실)', '2003다13048', '2005-02-25'),
      { title: '서울고법 2011나32206(위조 말소 뒤 산 사람에게 국가 등이 1억 5천만원 배상)', url: 'https://korea.legal/wiki/2011%eb%82%9832206/', date: '2013-01-24' },
      { title: '등기선례 제8-107호(매수하려는 사람은 등기 부속서류 열람 이해관계인 아님)', url: 'https://korea.legal/wiki/%eb%93%b1%ea%b8%b0%ec%84%a0%eb%a1%80-%ec%a0%9c8-107%ed%98%b8/', date: '2004-10-12' },
      law('신용정보법 제32조(정보 제공은 본인 동의)', '신용정보의 이용 및 보호에 관한 법률', '003200'),
      { title: '한국경제: 화곡동 빌라, 위조로 지운 근저당 회복과 경매(다음 전재)', url: 'https://v.daum.net/v/20221108164407863', date: '2022-11-08' },
      { title: 'MBC: 위조 서류로 근저당 말소, 고양 다세대 4가구', url: 'https://imnews.imbc.com/replay/2025/nwtoday/article/6692498_36807.html', date: '2025-03-05' },
    ],
  },
  {
    id: 'provisional', place: 'papers', name: '가등기', deals: ALL,
    how: '등기부 갑구에 지워지지 않은 가등기(소유권이전청구권가등기, 소유권이전담보가등기)가 있으면 계약하지 않거나, 잔금 전에 가등기한 사람의 말소 서류를 받아 지워진 등기부를 본 뒤 잔금을 냅니다. 경매는 말소기준권리보다 앞선 가등기가 매각물건명세서에 매수인이 인수하는 권리로 나오면 피합니다.',
    why: '가등기는 나중에 할 본등기의 순위를 미리 잡아 두는 등기입니다. 가등기한 사람이 본등기를 하면 순위가 가등기 날짜로 올라가고, 그 사이에 된 등기(산 사람의 소유권이전, 근저당, 임차권등기 등)는 등기관이 직권으로 지웁니다. 그래서 가등기 뒤에 산 사람은 돈을 내고도 소유권을 잃고, 가등기 뒤에 들어온 세입자도 본등기 순위보다 뒤가 됩니다.\nHUG 반환보증은 갑구에 가등기 같은 권리침해 사항이 있으면 가입이 안 됩니다.\n경매에서 순위를 잡아 두는 가등기는 앞선 담보권이나 가압류가 없으면 매각으로 지워지지 않고 매수인이 떠안습니다. 돈을 빌려주고 담보로 한 담보가등기는 저당권처럼 매각으로 지워지지만, 어느 쪽인지는 등기 이름만으로 단정하기 어렵습니다.',
    goto: { tab: 'fraud', label: '사기 사례 탭 이중매매' },
    sources: [
      law('부동산등기법 제91조(본등기 순위는 가등기 순위)', '부동산등기법', '009100'),
      law('부동산등기법 제92조(가등기 이후 등기는 직권말소)', '부동산등기법', '009200'),
      HUG_RETURN,
      { title: '세종 판례 소개: 대법원 2025다217707(순위보전 가등기는 경매 매수인이 인수)', url: 'https://www.shinkim.com/kor/media/lawinfo/517', date: '2026-03-12' },
      law('가등기담보법 제13조(담보가등기는 저당권으로 봄)', '가등기담보 등에 관한 법률', '001300'),
      law('가등기담보법 제15조(담보가등기는 매각으로 소멸)', '가등기담보 등에 관한 법률', '001500'),
    ],
  },
  {
    id: 'lease-reg-seen', place: 'papers', name: '앞 세입자의 임차권등기', deals: ALL,
    how: '등기부 을구에 지워지지 않은 주택임차권(임차권등기)이 있으면 앞 세입자가 계약이 끝났는데 보증금을 못 돌려받았다는 뜻입니다. 기본은 계약하지 않습니다. 경매면 매각물건명세서에 그 보증금을 매수인이 떠안는다고 나오는지 봅니다.',
    why: '임차권등기가 된 집(집 일부만 빌린 것이면 그 부분)을 그 뒤에 빌린 세입자는 최우선변제(소액 보증금을 먼저 받는 것)를 받을 수 없습니다. 등기한 앞 세입자는 이사해도 대항력과 우선변제권이 남아 내 보증금보다 앞섭니다.\n집을 사면 대항력 있는 앞 세입자에게 보증금을 돌려줄 의무를 산 사람이 이어받고, 경매에서도 대항력 있는 임차권은 보증금을 다 받기 전에는 매각으로 지워지지 않아 매수인이 떠안습니다.',
    sources: [
      law('주택임대차보호법 제3조의3 제5항과 제6항(등기한 세입자는 이사해도 유지, 그 뒤 세입자는 최우선변제 없음)', '주택임대차보호법', '000303'),
      law('주택임대차보호법 제3조 제4항(산 사람이 임대인 지위 승계)', '주택임대차보호법', '000300'),
      law('주택임대차보호법 제3조의5(대항력 있는 임차권은 경매로 안 지워짐)', '주택임대차보호법', '000305'),
    ],
  },
  {
    id: 'trust-rent', place: 'papers', name: '신탁 등기된 집인지', deals: RENT,
    how: '등기부 갑구에 신탁 등기가 있으면 소유자는 신탁회사(수탁자)이고, 지금 집주인은 집을 맡긴 사람(위탁자)일 뿐입니다. 이런 집은 피하거나, 아래 순서를 다 거친 뒤에만 계약합니다. 말소사항 포함으로 떼면 이미 지워진 신탁도 보이는데, 신탁등기가 말소됐으면 끝난 신탁입니다.',
    stepsTitle: '신탁 집이면 확인할 순서',
    steps: [
      { text: '인터넷등기소나 등기소 창구에서 신탁원부를 열람해 임대할 권한이 누구에게 있는지, 신탁회사 사전승낙과 우선수익자 동의가 필요한지 봅니다.', links: [L.iros] },
      { text: '신탁회사의 임대차 동의서를 받습니다. 신탁원부에 우선수익자(대출해 준 금융기관) 동의가 필요하다고 돼 있으면 그 동의서도 받습니다. 동의서는 신탁회사와 금융기관이 내주는 서류라 집주인이 받아 오고, 받은 동의서는 신탁회사 누리집에 나온 대표번호로 직접 물어 확인합니다. 될 수 있으면 신탁회사와 직접 계약합니다.' },
      { text: '보증금을 누구 계좌로 넣는지(신탁회사 계좌인지) 계약서와 동의서에서 봅니다. 집주인 개인 계좌로 보내라고 하면 계약하지 않습니다.' },
      { text: '반환보증에 들 수 있는지 보증기관에 주소를 대고 먼저 묻습니다(HF는 신탁회사와 맺은 계약이고 신탁원부로 임대 권한이 확인돼야 가입).' },
    ],
    why: '신탁하면 소유권이 신탁회사로 완전히 넘어갑니다. 대출 담보로 맡긴 담보신탁이면 돈을 빌려준 금융기관이 우선수익자라서, 집주인이 빚을 못 갚으면 신탁회사가 집을 팔아 그 금융기관부터 갚습니다. 신탁회사 승낙 없이 집주인과만 맺은 계약은 신탁회사에 주장할 수 없어 명도소송에서 집을 비워 줘야 하고, 보증금은 집주인에게만 청구할 수 있습니다.\n동의를 받아도 보증금은 집주인이 돌려주기로 한 경우가 대부분이라 신탁회사에 청구하지 못하고, 집이 팔리면 산 사람에게 대항하지 못할 수 있습니다(국토부 안내).\n2024.12.21부터 신탁 등기에는 신탁원부를 확인하라는 주의 문구가 함께 등기됩니다.',
    goto: { tab: 'fraud', label: '사기 사례 탭 신탁 집 전세와 월세' },
    sources: [
      { title: '정책브리핑: 신탁회사의 동의 없는 임대차계약 체결 괜찮을까?', url: 'https://www.korea.kr/news/policyNewsView.do?newsId=148939915', date: '2025-02-25' },
      prec('대법원 2000다70460(신탁하면 소유권이 수탁자에게)', '2000다70460', '2002-04-12'),
      { title: '경기일보 법률플러스: 담보신탁의 우선수익권(채권자가 우선수익자)', url: 'https://kyeonggi.com/article/201712260961251', date: '2017-12-26' },
      { title: '대법원 2012다62561(수탁자 사전승낙 없는 임대차)', url: 'https://casenote.kr/대법원/2012다62561', date: '2014-07-24' },
      { title: '대법원 보도자료: 신탁 부동산 거래 주의사항 등기', url: 'https://www.scourt.go.kr/portal/news/NewsViewAction.work?pageIndex=1&searchWord=&searchOption=&seqnum=2745&gubun=6', date: '2024-12-19' },
      HF_KEEP,
    ],
  },
  {
    id: 'trust-buy', place: 'papers', name: '신탁 등기된 집인지', deals: ['buy'],
    how: '등기부 갑구에 신탁 등기가 있으면 소유자는 신탁회사입니다. 신탁원부로 처분 권한과 동의 조건을 보고, 신탁회사 동의 없이는 사지 않습니다.',
    why: '파는 사람이 소유자가 아니라서 돈을 내도 소유권을 받을 수 없습니다. 계약을 해제할 수는 있지만, 신탁을 알고 샀으면 손해배상은 못 받습니다.',
    goto: { tab: 'fraud', label: '사기 사례 탭 신탁 맡긴 집' },
    sources: [
      prec('대법원 2000다70460(신탁하면 소유권이 수탁자에게)', '2000다70460', '2002-04-12'),
      law('민법 제570조(남의 권리를 판 경우)', '민법', '057000'),
      { title: '대법원 보도자료: 신탁 부동산 거래 주의사항 등기', url: 'https://www.scourt.go.kr/portal/news/NewsViewAction.work?pageIndex=1&searchWord=&searchOption=&seqnum=2745&gubun=6', date: '2024-12-19' },
    ],
  },
  {
    id: 'ledger', place: 'papers', name: '건축물대장', deals: ALL,
    how: '정부24나 세움터에서 떼서 위반건축물 표시, 용도(주택인지 근린생활시설인지), 층수와 세대수, 전용면적을 봅니다. 집 하자 목록의 위반건축물 흔적과 견줍니다.',
    why: '대장에 위반건축물로 오른 집은 HUG 반환보증(아파트는 예외), HUG 전세대출보증, HF 전세지킴보증에 못 들고, 근린생활시설은 반환보증 대상 주택이 아닙니다. 위반건축물은 매물 광고에도 그렇게 적어야 합니다.\n근린생활시설이어도 실제로 살면 전입신고는 받아 줍니다(건물 용도나 무허가는 전입신고를 거부할 까닭이 아님). 주택임대차보호법도 서류상 용도가 아니라 실제로 주거로 쓰는지로 판단해서 보호받을 수 있지만, 실제 주거용인지 다툼이 생길 수 있고 반환보증과 전세대출은 막힙니다.',
    sources: [
      prec('대법원 2008두10997 전원합의체(전입신고는 30일 이상 살 목적인지만 심사)', '2008두10997', '2009-06-18'),
      prec('대법원 94다52522(공부상 근린생활시설도 실제 주거로 쓰면 주거용)', '94다52522', '1995-03-10'),
      prec('대법원 95다51953(방과 주방 딸린 다방은 주거용 아님)', '95다51953', '1996-03-12'),
      { title: '세움터(건축물대장)', url: 'https://www.eais.go.kr/', date: '' },
      law('건축법 제79조 제4항(시정명령하면 대장에 적음)', '건축법', '007900'),
      HUG_RETURN,
      HUG_LOAN,
      HF_KEEP,
      { title: '국토교통부고시: 표시광고 명시사항 세부기준(위반건축물 표시)', url: 'https://www.law.go.kr/LSW/admRulInfoP.do?admRulSeq=2100000250356', date: '' },
    ],
  },
  {
    id: 'households', place: 'papers', name: '전입세대확인서', deals: RENT,
    how: '그 집 주소에 전입한 세대주와 동거인(말소, 거주불명 포함)의 이름과 전입일이 나오는 서류입니다. 집주인 말고 다른 세대가 있는지, 있으면 언제 들어왔는지 봅니다. 단독, 다중, 다가구는 건물 전체로 뗍니다.',
    stepsTitle: '떼는 법',
    steps: [
      { text: '계약 전에는 집주인이 써 준 위임장(주민센터 서식)과 집주인 신분증명서, 내 신분증을 들고 주민센터나 시군구청에서 뗍니다.' },
      {
        text: '계약한 날부터는 내 계약서와 신분증만으로 뗍니다. 집 주소와 상관없이 아무 주민센터나 시군구청에서 되고, 온라인 발급은 안 됩니다(열람 300원, 발급 400원이나 500원).',
        links: [{ label: '정부24 전입세대확인서 안내', url: 'https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=13100000305' }],
      },
      { text: '들은 것과 다른 세대가 있으면 잔금을 멈추고 해제 특약(숨긴 선순위)을 씁니다. 잔금 날 한 번 더 떼서 그사이 들어온 세대가 없는지 봅니다.' },
    ],
    why: '전입신고한 세입자는 다음 날부터 대항력이 생겨서, 나보다 먼저 전입한 사람의 보증금이 먼저입니다.\n계약서를 쓰면 임대차계약자 본인으로 직접 뗄 수 있고, 그 전에는 집주인 위임이 있어야 합니다. 중개사는 이 서류를 열람하거나 뗄 수 있다는 것을 설명해야 합니다(2024.7.10부터).',
    sources: [
      law('주민등록법 제29조의2(신청할 수 있는 사람)', '주민등록법', '002902'),
      law('주민등록법 시행규칙 제14조(위임 서류, 다른 관할 집도 발급)', '주민등록법 시행규칙', '001400'),
      { title: '정부24 전입세대확인서(방문 신청)', url: 'https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=13100000305', date: '' },
      HUG_PROCEDURE,
      law('공인중개사법 시행령 제21조 제11호(전입세대확인서 설명)', '공인중개사법 시행령', '002100'),
    ],
  },
  {
    id: 'senior-deposit', place: 'papers', name: '먼저 들어온 세입자', kinds: ['house'], deals: RENT,
    how: '단독과 다가구는 한 건물에 세입자가 여럿이라, 나보다 먼저 들어온 세입자 보증금 합계를 봅니다. 방마다 확정일자, 보증금, 차임, 기간이 나오는 확정일자 부여 현황은 계약하기 전에 봐야 다른 방 것까지 나옵니다. 계약한 뒤 내 계약서로 떼면 내 계약 것만 나옵니다.',
    stepsTitle: '계약 전에 보는 법',
    steps: [
      { text: '집주인이 떼어 보여 주게 합니다. 계약할 때 보여 줄 의무가 있습니다.' },
      { text: '아니면 집주인 동의서와 집주인 신분증 사본(또는 인감증명서나 본인서명사실확인서)을 받아, 주민센터나 등기소에서 임대차 정보제공 요청서를 써 냅니다.' },
      { text: '확정일자 없이 전입만 한 세입자는 이 현황에 안 나옵니다. 건물 전체 전입세대확인서와 맞춰 보고, 현황에 없는 세대는 집주인에게 보증금을 묻습니다.' },
      { text: 'HUG 반환보증을 들 거라면 집주인이나 중개사가 확인해 준 타 전세계약체결내역 확인서(HUG 양식)도 냅니다.', links: [L.hugProcedure] },
    ],
    why: '경매로 팔리면 먼저 들어온 세입자 보증금이 내 것보다 먼저 나갑니다. 확정일자가 없어도 전입과 입주만 했으면 최우선변제를 먼저 받는 세입자가 있습니다.\n확정일자 정보는 계약 당사자에게는 그 계약 것만, 소유자와 집주인 동의를 받은 계약하려는 사람에게는 그 집 전체의 확정일자, 보증금, 차임, 기간이 나옵니다(이름은 빠짐).\nHUG 반환보증도 근저당과 다른 세입자 보증금(빈 방의 최우선변제금 포함) 합이 집값의 72%(주택가액의 80%) 이내여야 합니다.',
    sources: [
      law('주택임대차보호법 제3조의7(확정일자 부여 현황 제시)', '주택임대차보호법', '000307', '2023-04-18'),
      law('주택임대차보호법 제3조의6(임대차 정보제공 요청)', '주택임대차보호법', '000306'),
      law('시행령 제6조(당사자는 그 계약만, 계약하려는 사람은 집 전체)', '주택임대차보호법 시행령', '000600'),
      law('규칙 제7조(동의서와 집주인 신분 서류)', LEASE_INFO_RULE, '000700'),
      law('주택임대차보호법 제8조(최우선변제는 대항요건만)', '주택임대차보호법', '000800'),
      HUG_RETURN,
      HUG_PROCEDURE,
    ],
  },
  {
    id: 'explain-doc', place: 'papers', name: '확인설명서', deals: INSIDE,
    how: '중개사가 주는 중개대상물 확인설명서의 시설물 상태(수도, 전기, 가스, 소방, 난방, 승강기, 배수), 벽면과 바닥과 도배, 일조와 소음과 진동 칸이 본 것과 같은지 봅니다.',
    why: '시설물과 벽면 칸은 중개사가 집주인에게 자료를 받아 확인해 적는 칸이라, 틀리게 적혔으면 수리나 손해배상을 요구할 근거가 됩니다(국토부 문답).\n임대차는 2024.7.10부터 관리비 내역, 확정일자 부여 현황, 집주인 세금 체납, 전입세대, 최우선변제도 확인해 적고 중개사, 집주인, 세입자가 같이 서명합니다.',
    sources: [
      law('공인중개사법 시행령 제21조(확인설명 사항)', '공인중개사법 시행령', '002100'),
      law('공인중개사법 제25조(확인과 설명)', '공인중개사법', '002500'),
      { title: '정책브리핑: 공인중개사, 임차인에 임대인 세금 체납 등 고지해야', url: 'https://m.korea.kr/news/policyNewsView.do?newsId=148931177', date: '2024-07-08' },
      { title: '국토교통부: 확인설명서 작성 문답', url: 'https://www.molit.go.kr/USR/policyTarget/dtl.jsp?idx=416', date: '2012-11-19' },
    ],
  },
  {
    id: 'land-use', place: 'papers', name: '토지이용계획', deals: OWN,
    how: '토지이음에서 지번으로 용도지역, 도시계획시설(도로 예정지 등), 허가구역을 봅니다.',
    sources: [LAND_USE],
  },
  {
    id: 'auction-sheet', place: 'papers', name: '매각물건명세서', deals: ['auction'],
    how: '매각기일 1주 전부터 법원경매정보에서 매각물건명세서, 현황조사보고서, 감정평가서를 볼 수 있습니다. 명세서에서 최선순위 설정일, 대항력 있는 임차인, 매수인이 떠안는 권리, 비고를 봅니다.',
    why: '경매 카드의 대항력과 매우 주의 이름표가 이 내용을 읽어 붙입니다.',
    goto: { tab: 'auction', label: '경매 탭' },
    sources: [law('민사집행법 제105조(매각물건명세서 비치)', '민사집행법', '010500'), law('민사집행규칙 제55조(1주 전 비치)', '민사집행규칙', '005500')],
  },
  {
    id: 'auction-survey', place: 'papers', name: '현황조사서와 감정평가서', deals: ['auction'],
    how: '누가 사는지(전입일, 확정일자, 보증금)와 감정평가서 사진, 도면으로 집 안을 봅니다.',
  },
  {
    id: 'auction-taxes', place: 'papers', name: '세금 교부청구', deals: ['auction'],
    how: '경매 사건의 문건과 송달 내역에서 세무서나 구청의 교부청구와 압류가 있는지 봅니다. 경매 카드의 매우 주의 표시가 이것과 대항력 있는 세입자를 같이 봅니다.',
    why: '세금이 먼저 배당돼 대항력 있는 세입자가 보증금을 다 못 받으면, 남은 보증금은 낙찰자가 돌려줘야 합니다.',
    goto: { tab: 'auction', label: '경매 탭' },
    sources: [
      law('국세기본법 제35조(국세의 우선)', '국세기본법', '003500'),
      law('주택임대차보호법 제3조의5(경매와 임차권)', '주택임대차보호법', '000305'),
    ],
  },
  {
    id: 'hidden-tenant', place: 'papers', name: '숨은 세입자', deals: ['buy'],
    how: '계약서를 쓴 뒤 전입세대확인서를 떼서 대항력 있는 세입자가 있는지 봅니다.',
    why: '대항력 있는 세입자가 있으면 보증금을 돌려줄 의무가 산 사람에게 넘어옵니다.',
    sources: [
      law('주민등록법 제29조의2(전입세대확인서)', '주민등록법', '002902'),
      law('주택임대차보호법 제3조 제4항(산 사람이 임대인 지위 승계)', '주택임대차보호법', '000300'),
    ],
  },

  // ---------- 계약 전: 대출과 보증 ----------
  {
    id: 'jeonse-loan', place: 'loan', name: '전세대출 되는 집인지', deals: ['jeonse'],
    how: '정식 신청은 계약서를 쓰고 보증금의 5% 이상(계약금)을 낸 뒤에야 됩니다. 그래서 계약금을 넣기 전에 한도는 앱과 누리집으로, 이 집으로 되는지는 은행 상담으로 미리 봅니다.',
    stepsTitle: '확인 순서',
    steps: [
      {
        text: '내 한도를 봅니다. 버팀목 같은 정책대출은 기금e든든에서, 은행 전세대출은 은행 앱의 전세대출 한도 조회에서 봅니다. 하나은행은 HF전세ON으로 HF 누리집이나 스마트주택금융 앱에서 보증한도를 미리 조회합니다.',
        links: [{ label: '기금e든든', url: 'https://nhuf.molit.go.kr/' }, { label: 'HF전세ON(하나은행)', url: 'https://hf.go.kr/ko/sub02/sub02_01_10.do' }],
      },
      { text: '이 집으로 되는지는 대출받을 은행에 전화하거나 창구에 가서 주소, 보증금, 계약 조건을 대고 묻습니다. 위반건축물, 근린생활시설, 선순위가 많은 집, 신탁 등기된 집은 여기서 걸립니다.' },
      { text: '같은 주소로 HUG 반환보증 가입가능여부도 봅니다(보험 칸).' },
      { text: '계약서에 대출이 안 되거나 필요한 금액보다 적게 나오면 해제하고 받은 돈을 돌려준다는 특약(계약서와 특약 칸의 해제 특약)을 넣고, 계약 뒤 잔금일 전에 정식 신청합니다.' },
      { text: '거절되거나 한도가 줄면 은행에 까닭을 묻고, 되도록 문자나 서류로 받아 둡니다. 내 소득이나 신용 문제가 아니었다는 것을 보여 줄 근거가 되어 해제 특약을 쓸 때 필요합니다.' },
    ],
    why: '전세대출은 HUG나 HF 보증을 받아야 나와서 보증이 안 되는 집은 대출도 막힙니다. 대장에 위반건축물로 오른 집, 건물과 땅 주인이 다른 집, 압류나 가압류가 걸린 집, 선순위가 많은 집은 HUG 대출보증이 안 되고, HF 보증은 등기상 주택이나 오피스텔이고 실제로 사는 집이어야 합니다.\n신탁 등기된 집은 신탁회사(수탁자)와 계약해야 합니다.',
    goto: { tab: 'support', label: '지원 제도 탭 전세 대출' },
    sources: [HUG_LOAN, HF_JEONSE, HF_KEEP, MOLIT_JEONSE_TIPS, { title: 'HF전세ON(With.하나은행): 보증한도 미리 조회, 5% 이상 지급 요건', url: 'https://hf.go.kr/ko/sub02/sub02_01_10.do', date: '' }],
  },
  {
    id: 'guarantee', place: 'insurance', name: '전세보증금 반환보증(보증보험)', deals: RENT,
    how: '계약이 끝났는데 집주인이 보증금을 못 돌려주면 보증기관이 대신 돌려주고 집주인에게 받아 냅니다. 깡통전세처럼 만기에 못 받는 위험을 막고, 계약할 때의 사기(가짜 집주인, 위조 서류)는 따로 막아야 합니다. 계약금을 넣기 전에 이 집으로 들 수 있는지 봅니다.',
    stepsTitle: '들 수 있는지 보는 순서(HUG 기준)',
    steps: [
      {
        text: '집값을 정합니다. 아파트와 오피스텔은 KB 같은 시세, 빌라와 단독과 다가구는 공시가격 × 140%입니다. 전세는 이 목록의 계산기에 넣고, 보증금이 있는 월세는 월세를 전환율 6.5%로 보증금에 더해 셉니다.',
        links: [L.realty],
      },
      { text: '등기부 을구의 근저당(채권최고액)을 더해, 보증금과 합이 집값의 90%, 근저당이 집값의 54%를 넘지 않는지 봅니다.', links: [L.iros] },
      { text: '안심전세 앱에서 집주인이 HUG 보증사고를 낸 적이 있는지, 보증 가입 금지 대상인지 봅니다.', links: [L.safeApp] },
      { text: 'HUG 인터넷보증의 가입가능여부 확인에 넣어 보거나 콜센터(1566-9009)에 주소를 대고 묻습니다.', links: [L.hugCheck] },
      { text: '계약서에 반환보증에 들 수 없으면 잔금 전에는 잔금을 멈추고 해제하고, 잔금 뒤에는 보증금 전액을 돌려받는다는 특약(계약서와 특약 칸의 해제 특약)을 넣습니다. 실제 신청은 잔금과 전입 뒤라서(잔금 날 목록의 반환보증 신청), 막히는지는 위 순서로 미리 봅니다.' },
      { text: 'HUG가 2026년 10월 30일 신청분부터 잔금 전 사전한도심사를 한다는 보도가 있습니다(아파트, 주거용 오피스텔, 연립, 다세대만, 계약금 5% 이상을 내고 임대차 신고를 한 뒤). 시행되면 계약 뒤 잔금 전에 받아 봅니다.' },
    ],
    providers: [
      {
        name: '주택도시보증공사(HUG) 전세보증금반환보증',
        facts: [
          ['대상', '전세와 보증금 있는 월세, 보증금 수도권 7억원 이하, 계약 1년 이상, 공인중개사를 거친 계약'],
          ['기준', '보증금과 선순위 합이 집값의 90% 이내, 선순위는 집값의 54% 이내. 근린생활시설, 위반건축물(아파트 제외)은 안 됨'],
          ['보증료', '연 0.097~0.211%(보증금, 아파트인지, 부채비율에 따라)'],
          ['가입 시기', '잔금일과 전입일 중 늦은 날부터 계약 기간 절반이 지나기 전'],
          ['신청', 'HUG 지사나 위탁은행, 네이버페이, 카카오페이, 토스, 안심전세 앱'],
        ],
        links: [L.hugCheck, L.hugProcedure],
      },
      {
        name: '한국주택금융공사(HF) 전세지킴보증',
        facts: [
          ['대상', 'HF 보증 전세대출을 쓰는 세입자만(반환보증만 따로는 안 됨)'],
          ['기준', '집값 × 90% − 선순위가 보증금보다 커야 함, 보증금 수도권 7억원, 집값 12억원 이하'],
          ['보증료', '연 0.04%(부채비율 70% 이하), 0.11%, 0.18%'],
          ['가입 시기', '계약 기간 절반이 지나기 전'],
          ['신청', 'HF 전세자금보증을 다루는 은행(국민, 신한, 우리, 하나, 농협, 기업, 카카오뱅크 등), 문의 1688-8114'],
        ],
        links: [{ label: 'HF 전세지킴보증', url: 'https://www.hf.go.kr/ko/sub02/sub02_05_01.do' }],
      },
      {
        name: 'SGI서울보증 전세금보장신용보험',
        facts: [
          ['대상', '공인중개사를 거친 1년 이상 계약의 세입자'],
          ['한도', '보증금 전액(아파트 외 주택은 10억원 이내). 아파트는 상한이 적혀 있지 않아 7억원 넘는 전세에 씀'],
          ['보험료', '아파트 연 0.229%, 그 밖 0.260%(부채비율과 신용도로 오르내림)'],
          ['신청', 'SGI 누리집, 모바일, 지점, 대리점'],
        ],
        note: '요율과 신청 기한이 SGI 화면마다 조금 달라 상담 때 확인합니다.',
        links: [{ label: 'SGI 상품 안내', url: 'https://m.sgic.co.kr/biz/cmw/index.html?p=CMWPRD030101F01' }],
      },
    ],
    why: '반환보증은 가짜 집주인이나 위조 서류를 걸러 주지 않습니다. 계약할 때의 사기는 본인 확인과 전월세 권원보험으로 따로 막습니다.\nHUG 약관상 천재지변, 전쟁, 내란으로 집주인이 계약을 못 지켜 생긴 빚은 보증하지 않고, 임차권등기 전에 이사하거나 전입을 옮겨 대항력과 우선변제권을 잃으면 보증책임이 없습니다.\nHUG 전세금안심대출보증으로 전세대출을 받으면 반환보증이 함께 들어갑니다.\nHUG 신규 계약 신청 기한은 잔금일과 전입신고일 중 늦은 날부터 계약 기간의 절반이 지나기 전까지라, 신청은 보증금을 다 낸 뒤에야 됩니다. 2026년 10월부터는 SGI서울보증이나 HF에 보증금을 안 돌려준 집주인의 집도 HUG 가입이 막힌다는 보도가 있습니다.',
    goto: { tab: 'support', label: '지원 제도 탭 보증보험' },
    sources: [
      HUG_RETURN, HUG_PROCEDURE, HUG_TERMS, REALTY_PRICE,
      { title: '파이낸셜뉴스: HUG 사전한도심사 10월 30일 신청분부터, 보증3사 미반환 임대인 정보 공유', url: 'https://www.fnnews.com/news/202610041758090827', date: '2026-10-04' },
      { title: 'HUG 공지: 전월세전환율 변경', url: 'https://khug.or.kr/hug/web/cs/no/csno000001.jsp?id=16&mode=S&currentPage=1&articleId=37801', date: '2026-06-24' },
      { title: 'HF 일반전세지킴보증', url: 'https://www.hf.go.kr/ko/sub02/sub02_05_01.do', date: '' },
      { title: 'HF 전세지킴보증 보증료율 변경', url: 'https://www.hf.go.kr/ko/sub04/sub04_08.do?mode=view&articleNo=597995', date: '2025-03-01' },
      { title: 'SGI서울보증 전세금보장신용보험', url: 'https://m.sgic.co.kr/biz/cmw/index.html?p=CMWPRD030101F01', date: '' },
    ],
  },
  {
    id: 'title-insurance-rent', place: 'insurance', name: '전월세 권원보험(사기 피해 보험)', deals: RENT,
    how: '계약할 때의 사기(가짜 집주인, 위조 등기부나 신분증, 이중계약, 전입신고 당일 집주인이 잡은 근저당)로 보증금을 잃으면 보상합니다. 반환보증과 막는 위험이 달라 같이 들 수 있고, 입주 전에도 듭니다. 들지 말지는 보험료와 견줘 정합니다.',
    stepsTitle: '드는 순서',
    steps: [
      { text: '공인중개사를 거친 계약인지, 집주인과 직접 맺은 계약인지에 맞는 상품을 고릅니다(아래 상품 예시).' },
      { text: '계약서에 확정일자를 받고 계약금 이체 내역을 준비합니다.' },
      { text: '잔금 날보다 며칠 앞서 신청합니다(상품마다 기한이 다름). 보험사 권리조사가 끝나면 가입됩니다.' },
      { text: '가입 뒤에도 잔금 직전과 전입 다음 날 등기부를 다시 봅니다.' },
    ],
    providers: [
      {
        name: '카카오페이손해보험 전월세보험(전 이름 전세안심보험)',
        facts: [
          ['대상', '공인중개사를 거쳐 확정일자를 받은 전세와 월세(아파트, 다세대, 연립, 주거용 오피스텔), 보장 1,000만원~10억원'],
          ['보장', '이중계약, 위조된 등기부, 전입신고 당일 근저당 설정, 가짜 임대인, 공모한 중개사의 위조 서류'],
          ['보험료', '한 번 냄. 알뜰형(계약금만) 계약금 3,000만원 41,300원, 든든형(보증금 전액) 1억원 147,700원'],
          ['가입 시기', '잔금일이 7영업일 뒤부터 3개월 안일 때'],
          ['신청', '카카오톡이나 카카오페이 앱에서 확정일자 계약서와 계약금 이체 내역을 올리면 권리조사 뒤 가입'],
        ],
        note: '2025.2 출시 보도 기준이고, 2026.2 보도로 판매 중인 것을 확인했습니다. 지금 조건은 가입 화면에서 확인합니다.',
      },
      {
        name: '카카오페이손해보험 직거래전월세보험',
        facts: [
          ['대상', '공인중개사 없이 집주인과 직접 맺은 전세와 월세(당근, 피터팬 직거래 포함), 보장 1,000만원~5억원'],
          ['보장', '가짜 집주인(신분증, 등기부 위조), 무권대리(위임장, 인감 위조), 이중계약, 전입신고 당일 대출로 생긴 선순위, 이전 세입자 점유로 입주 못 함'],
          ['보험료', '한 번 냄. 보증금 3,000만원 50,700원, 1억원 181,600원'],
          ['기간', '이사 전부터 계약이 끝날 때까지, 최대 3년'],
          ['가입 시기', '확정일자 계약서와 계약금 이체 내역으로 계약 시작일 6영업일 전까지'],
        ],
        note: '2025.8 출시 보도 기준입니다.',
      },
      {
        name: '퍼스트어메리칸 퍼스트 전월세 권리보험',
        facts: [['대상', '임대차계약을 맺은 세입자를 보호하는 상품으로 누리집에 올라 있음']],
        note: '보장, 보험료, 가입 경로는 누리집에 없어 상담 신청으로 확인합니다.',
        links: [{ label: '퍼스트어메리칸', url: 'https://www.firstam.co.kr/' }],
      },
    ],
    why: '보험사 설명으로는 반환보증으로 해결되지 않던 계약 시점 사기를 보상합니다. 반환보증은 만기에 보증금을 못 받는 위험을, 이 보험은 계약할 때 속는 위험을 맡습니다.\n보상하지 않는 경우와 청구 요건은 약관으로 확인합니다.',
    sources: [
      { title: '뉴데일리: 카카오페이손보 전세안심보험 출시(알뜰형, 든든형)', url: 'https://biz.newdaily.co.kr/site/data/html/2025/02/25/2025022500347.amp.html', date: '2025-02-25' },
      { title: '더팩트: 카카오페이손보 직거래전월세보험 출시', url: 'https://news.tf.co.kr/read/economy/2234116.htm', date: '2025-08-14' },
      { title: '트윅: 전월세보험 출시 1년 가입자 분석', url: 'https://www.twig24.com/news/2026/02/09/20260209500084', date: '2026-02-09' },
      { title: '퍼스트어메리칸 묻고 답하기(전월세 권리보험 가입 대상)', url: 'https://www.firstam.co.kr/FAQ', date: '' },
    ],
  },
  {
    id: 'title-insurance', place: 'insurance', name: '권원보험(부동산 권리보험)', deals: ['buy'],
    how: '등기부만 봐서는 모르는 권리 하자(위조, 사기 등)로 산 집의 권리를 잃거나 손해를 보면 보상합니다. 매매계약서를 쓴 뒤 잔금 전에 듭니다.',
    stepsTitle: '드는 순서',
    steps: [
      { text: '이전등기를 누구에게 맡길지에 맞춰 상품을 고릅니다(아래 상품 예시).' },
      { text: '잔금 날보다 며칠 앞서 신청합니다(하나손해보험 5영업일, 퍼스트어메리칸 3일).' },
      { text: '가입 전에 위조로 지워진 근저당이 되살아나는 경우도 보상하는지 서면으로 받아 둡니다.' },
    ],
    providers: [
      {
        name: '하나손해보험 내집마련 부동산 권리보험(소유권용)',
        facts: [
          ['조건', '연계 법무법인이 소유권 이전을 같이 맡아야 가입(보험만 따로는 안 됨)'],
          ['가입 시기', '매매계약 뒤 잔금 5영업일 전까지(최대 25일 전부터)'],
          ['보험료', '한 번 냄, 매매가 5억원 기준 173,400원, 효력은 잔금을 낸 때부터'],
          ['문의', '1566-3000'],
        ],
        links: [L.hana],
      },
      {
        name: '퍼스트어메리칸 퍼스트 주거용 권리보험',
        facts: [
          ['가입 시기', '매매계약 뒤 잔금 3일 전까지'],
          ['신청', '내집스캔 매매지킴보증에서 계약정보 입력과 본인인증'],
          ['보험료', '한 번 냄, 3억원 예시 199,000원(권리조사비 11,000원은 보험료에 들어가고 철회하면 못 돌려받음)'],
        ],
        links: [L.naezip, L.firstam],
      },
    ],
    why: '알던 하자, 등기부에 이미 나온 권리, 보장이 시작된 뒤 생긴 권리, 현장을 봐야 아는 것(유치권 등)은 보상하지 않고, 소송이 걸리면 판결이 확정될 때까지 보상하지 않습니다.\n위조로 지워진 근저당이 되살아나는 경우를 보상하는지는 두 회사 약관에 따로 적혀 있지 않습니다.',
    goto: { tab: 'apt', label: '서울 아파트 탭 등기 위조 사기와 권원보험' },
    sources: [
      { title: '하나손해보험 내집마련 부동산 권리보험 안내', url: 'https://m.hanainsure.co.kr/honeQ/product/realestateright/honeQRealEstateRightIntro?origin=m', date: '' },
      { title: '하나손해보험 소유권용 약관', url: 'https://www.hanainsure.co.kr/download/prd?instype=18001&type=agree&spctype=0', date: '' },
      { title: '퍼스트어메리칸 묻고 답하기', url: 'https://www.firstam.co.kr/FAQ', date: '' },
      { title: '퍼스트 주거용 권리보험 보통약관', url: 'https://www.firstam.co.kr/Docs/owner_terms.pdf', date: '' },
      { title: '내집스캔 매매지킴보증(퍼스트어메리칸) 안내', url: 'https://www.naezipscan.com/insurance/firstamerican/title-001/landing', date: '' },
      { title: '중앙SUNDAY: 위조 말소와 권원보험 보상 어려움(다음 전재)', url: 'https://v.daum.net/v/20221224000154386', date: '2022-12-24' },
    ],
  },
  {
    id: 'loan-blockers', place: 'loan', name: '전세대출이 안 나오는 집', deals: ['jeonse'],
    how: '은행은 등기부, 건축물대장, 계약서로 심사하고, 대출은 HF나 HUG 보증이 붙어야 나옵니다. 아래 경우는 보증 기준에 걸려 거절됩니다. 기준은 은행과 보증기관마다 조금씩 달라서 마지막 확인은 은행 상담으로 합니다.',
    stepsTitle: '이런 집은 거절됩니다',
    steps: [
      { text: '빚이 많은 집: 등기부의 근저당 채권최고액(남은 빚이 아니라 적힌 금액)과 내 보증금 합이 집값의 90%를 넘으면 HF 전세자금보증이 안 됩니다. 집주인이 법인이면 80%입니다. 다가구는 먼저 들어온 세입자 보증금도 앞순위로 셉니다.', links: [{ label: 'HF 일반전세자금보증', url: 'https://www.hf.go.kr/ko/sub02/sub02_01_02.do' }] },
      { text: '등기부에 문제가 있는 집: 신탁 등기(신탁회사와 계약하고 임대 권한이 확인돼야 함), 갑구의 압류, 가압류, 가처분, 가등기, 경매신청, 건물과 땅 주인이 다른 집.' },
      { text: '건물에 문제가 있는 집: 건축물대장에 위반건축물로 오른 집(옥탑 증축, 방 쪼개기가 흔함), 등기상 용도가 주택이나 오피스텔이 아닌 근린생활시설(사람이 살아도 안 됨), 실제로 살지 않는 집.' },
      { text: '매매와 엮인 전세: 집을 사는 사람이 내 전세금으로 잔금을 치르는 소유권 이전 조건부 전세는 2025.6.28부터 수도권과 규제지역에서 대출이 금지됐습니다. 계약서의 임대인과 지금 소유자가 다르면 은행이 다루지 않습니다.' },
      { text: '한도를 넘는 집: HF 일반전세자금보증은 보증금 7억원(서울, 경기, 인천 밖은 5억원) 이하, 버팀목은 전용 85㎡ 이하에 보증금 수도권 3억원 이하입니다.' },
      { text: '집주인 쪽 사정: HUG 보증 가입 금지 대상 집주인이면 HUG 보증이 붙은 대출과 반환보증이 막힙니다(안심전세 앱으로 확인). 대출 때 은행이 보증금 반환채권에 질권을 잡거나 채권을 넘겨받으면서 집주인에게 통지가 가니 미리 알려 둡니다.' },
    ],
    why: '수도권과 규제지역은 2025.7.21부터 전세대출 보증비율이 90%에서 80%로 낮아졌습니다(HF, HUG, SGI).\n위 기준은 바뀔 수 있어 계약 직전에 은행 창구에서 한 번 더 확인하고, 대출이 안 되면 해제한다는 특약을 넣습니다.',
    goto: { tab: 'support', label: '지원 제도 탭 전세 대출' },
    sources: [
      { title: 'HF 일반전세자금보증(선순위 90%, 법인 80%, 보증금 7억원, 채권보전조치)', url: 'https://www.hf.go.kr/ko/sub02/sub02_01_02.do', date: '' },
      HUG_LOAN,
      HUG_RETURN,
      HF_KEEP,
      { title: '금융위원회: 6.27 가계부채 관리 강화 방안(소유권 이전 조건부 전세대출 금지, 보증비율 80%)', url: 'https://www.fsc.go.kr/no010101/84824', date: '2025-06-27' },
      { title: '마이홈포털: 버팀목 전세대출(85㎡, 보증금 3억원)', url: 'https://www.myhome.go.kr/hws/portal/cont/selectSupLeaseLoanView.do', date: '' },
      MOLIT_JEONSE_TIPS,
    ],
  },
  {
    id: 'pre-deposit', place: 'loan', name: '가계약금 보내기 전에', deals: RENT,
    how: '대출과 보증은 계약한 뒤 정식 심사에서 정해져서 100% 미리 알 수는 없습니다. 대신 거절되는 흔한 까닭을 가계약 전에 직접 거르고, 안 될 때 돈을 돌려받을 조건을 남깁니다.',
    stepsTitle: '가계약 전에 할 것',
    steps: [
      { text: '건축물대장(위반건축물, 근린생활시설), 등기부(신탁, 압류와 가압류, 선순위 근저당), 이 목록의 계산기(보증금과 선순위 합이 집값의 90%, 선순위가 54%)로 거절 사유를 먼저 거릅니다.' },
      {
        text: 'HUG 가입가능여부 확인과 HF 신청가능여부 확인에 주소와 조건을 넣어 봅니다. 둘 다 사전 확인용이라 최종은 심사에서 정해집니다.',
        links: [L.hugCheck, { label: 'HF 신청가능여부 확인', url: 'https://www.hf.go.kr/ko/sub02/sub02_05_06.do' }],
      },
      { text: '안심전세 앱에서 집주인의 HUG 보증사고 이력과 보증 가입 금지 여부를 봅니다.', links: [L.safeApp] },
      { text: '대출받을 은행에 주소와 조건을 대고 상담하고, 한도는 은행 앱이나 기금e든든으로 봅니다.' },
      { text: "가계약금을 보낼 때 '대출이나 반환보증이 안 되면 가계약금을 돌려받는다'는 조건을 문자로 남기고, 본계약서에 같은 특약을 넣습니다." },
    ],
    why: '가계약이라도 집, 금액, 지급 방법 같은 중요한 것이 합의됐으면 정식 계약서 없이도 계약이 성립했다고 본 판례(매매)가 있습니다. 그러면 특약이 없을 때 계약금을 포기해야 해제할 수 있는 해약금 규정이 적용될 수 있습니다.\n안심전세 앱에서 잔금 전에 전세보증 가입 여부를 미리 심사해 준다는 보도(2026년 10월 말부터)가 있지만 HUG 공식 공지는 못 찾았고, 이것도 계약한 뒤의 일입니다.',
    goto: { tab: 'support', label: '지원 제도 탭 특약 문구' },
    sources: [
      prec('대법원 2005다39594(가계약서라도 중요 사항 합의면 계약 성립)', '2005다39594', '2006-11-24'),
      law('민법 제565조(해약금)', '민법', '056500'),
      law('민법 제567조(유상계약에 준용)', '민법', '056700'),
      HUG_RETURN,
      { title: 'HF 전세지킴보증 신청가능여부 확인(사전 확인용)', url: 'https://www.hf.go.kr/ko/sub02/sub02_05_06.do', date: '' },
      { title: '파이낸셜뉴스: 잔금 전 전세보증 가입여부 확인 가능해진다', url: 'https://www.fnnews.com/news/202610041758090827', date: '2026-10-04' },
    ],
  },
  {
    id: 'buy-loan', place: 'loan', name: '대출 한도', deals: ['buy'],
    how: '매물 카드의 대출 표시(디딤돌, 보금자리, 주담대)를 보고, 은행 사전 상담으로 한도를 정한 뒤 계약합니다. 서울에서 주담대를 받으면 6개월 안에 전입해야 합니다.',
    goto: { tab: 'apt', label: '서울 아파트 탭 살 때 조건' },
  },
  {
    id: 'permit', place: 'papers', name: '토지거래허가', kinds: ['apt'], deals: ['buy'],
    how: '서울 아파트는 계약 전에 구청 허가를 받고, 허가받은 날부터 4개월 안에 들어가 2년을 살아야 합니다(지정 기간 2026.12.31까지).',
    goto: { tab: 'apt', label: '서울 아파트 탭 살 때 조건' },
  },
  {
    id: 'auction-loan', place: 'loan', name: '잔금 대출', deals: ['auction'],
    how: '낙찰 뒤 잔금(경락잔금대출)이 되는지 은행에 먼저 묻습니다. 대출을 받으면 6개월 안에 전입해야 합니다.',
    goto: { tab: 'apt', label: '서울 아파트 탭 살 때 조건' },
  },

  // ---------- 계약 전: 계약서와 특약 ----------
  {
    id: 'contract-read', place: 'terms', name: '계약서', deals: INSIDE,
    how: '주소와 면적이 등기부, 건축물대장과 같은지, 금액, 잔금일, 특약을 읽고 서명합니다.',
  },
  {
    id: 'fee-rent', place: 'terms', name: '중개보수', deals: RENT,
    how: '서명하기 전에 확인설명서의 중개보수 칸(금액과 산출내역)을 보고 요율표로 계산해 봅니다. 요율은 상한이라 그 안에서 협의하고, 부가세는 따로입니다.',
    stepsTitle: '계산하는 법',
    steps: [
      { text: '거래금액을 냅니다. 전세는 보증금, 월세는 보증금 + 월세 × 100이고, 이 합이 5천만원 미만이면 보증금 + 월세 × 70입니다.' },
      { text: '서울 주택 임대차 상한: 5천만원 미만 0.5%(20만원까지), 5천만원 이상 1억 미만 0.4%(30만원까지), 6억 미만 0.3%, 12억 미만 0.4%, 15억 미만 0.5%, 15억 이상 0.6%.' },
      { text: '예: 보증금 1,000만원에 월세 50만원은 6,000만원 × 0.4% = 24만원, 보증금 500만원에 월세 40만원은 합이 4,500만원이라 500만원 + 2,800만원 = 3,300만원 × 0.5% = 16만 5천원까지입니다.' },
      { text: '주거용 오피스텔(전용 85㎡ 이하에 전용 부엌, 화장실, 목욕시설)은 0.4%, 그 밖의 오피스텔과 상가는 0.9% 안에서 정합니다.' },
      {
        text: '서울부동산정보광장 중개보수 계산이나 협회 시도별 요율로 맞춰 보고, 넘게 적혀 있으면 서명 전에 고쳐 달라고 합니다. 내는 날을 따로 정하지 않았으면 잔금을 다 치른 날입니다.',
        links: [{ label: '서울 중개보수 요율과 계산', url: SEOUL_FEE.url }, { label: '협회 시도별 중개보수 요율', url: 'https://www.kar.or.kr/pinfo/brokerfeeall.asp' }],
      },
    ],
    why: '중개보수는 시도 조례의 상한 안에서 중개사와 협의해 정하고, 어떤 이름으로든 그보다 더 받으면 안 됩니다. 중개사의 고의나 과실로 계약이 무효, 취소, 해제되면 보수를 받을 수 없습니다.\n사무소가 다른 시도에 있으면 사무소가 있는 시도의 조례를 따르고, 건물 중 주택 면적이 절반 이상이면 주택 요율을 씁니다.',
    sources: [
      SEOUL_FEE,
      law('공인중개사법 제32조(중개보수, 고의나 과실이면 못 받음)', '공인중개사법', '003200'),
      law('공인중개사법 제33조 제1항 제3호(초과 수수 금지)', '공인중개사법', '003300'),
      law('시행규칙 제20조(한도, 월세 거래금액, 오피스텔)', '공인중개사법 시행규칙', '002000'),
      law('시행령 제27조의2(지급 시기는 잔금 완료일)', '공인중개사법 시행령', '002702'),
      law('시행령 제21조 제3호(확인설명서에 중개보수 산출내역)', '공인중개사법 시행령', '002100'),
    ],
  },
  {
    id: 'fee-buy', place: 'terms', name: '중개보수', deals: ['buy'],
    how: '서명하기 전에 확인설명서의 중개보수 칸(금액과 산출내역)을 보고 요율표로 계산해 봅니다. 요율은 상한이라 그 안에서 협의하고, 부가세는 따로입니다.',
    stepsTitle: '계산하는 법',
    steps: [
      { text: '서울 주택 매매 상한: 5천만원 미만 0.6%(25만원까지), 5천만원 이상 2억 미만 0.5%(80만원까지), 9억 미만 0.4%, 12억 미만 0.5%, 15억 미만 0.6%, 15억 이상 0.7%.' },
      { text: '예: 6억원 집은 6억 × 0.4% = 240만원까지입니다.' },
      { text: '주거용 오피스텔(전용 85㎡ 이하에 전용 부엌, 화장실, 목욕시설)은 0.5%, 그 밖의 오피스텔과 상가, 토지는 0.9% 안에서 정합니다.' },
      {
        text: '서울부동산정보광장 중개보수 계산이나 협회 시도별 요율로 맞춰 보고, 넘게 적혀 있으면 서명 전에 고쳐 달라고 합니다. 내는 날을 따로 정하지 않았으면 잔금을 다 치른 날입니다.',
        links: [{ label: '서울 중개보수 요율과 계산', url: SEOUL_FEE.url }, { label: '협회 시도별 중개보수 요율', url: 'https://www.kar.or.kr/pinfo/brokerfeeall.asp' }],
      },
    ],
    why: '중개보수는 시도 조례의 상한 안에서 중개사와 협의해 정하고, 어떤 이름으로든 그보다 더 받으면 안 됩니다. 중개사의 고의나 과실로 계약이 무효, 취소, 해제되면 보수를 받을 수 없습니다.',
    sources: [
      SEOUL_FEE,
      law('공인중개사법 제32조(중개보수)', '공인중개사법', '003200'),
      law('공인중개사법 제33조 제1항 제3호(초과 수수 금지)', '공인중개사법', '003300'),
      law('시행규칙 제20조(한도, 오피스텔)', '공인중개사법 시행규칙', '002000'),
      law('시행령 제27조의2(지급 시기)', '공인중개사법 시행령', '002702'),
    ],
  },
  {
    id: 'special', place: 'terms', name: '해제 특약', deals: RENT,
    how: '전세에서 가장 중요한 것은 반환보증에 못 들면 잔금 전에는 잔금을 멈추고 해제하고, 잔금 뒤에는 보증금 전액을 돌려받는다는 특약입니다. 숨긴 선순위나 세금 체납이 나올 때, 대출이 안 될 때도 해제 특약을 넣고, 집주인이 대출과 보증 서류에 협조한다는 특약을 같이 넣어 둡니다.',
    why: '법무부 표준계약서에는 집주인이 보여 준 정보가 사실과 다르면 세입자가 계약을 해제할 수 있는 특약이 있습니다(2023.4.18 수정).',
    clauses: CANCEL_CLAUSES,
    goto: { tab: 'support', label: '지원 제도 탭 특약 문구' },
    sources: [{ title: '법무부: 주택임대차 표준계약서 2023년 수정(정보가 사실과 다르면 해제 특약)', url: 'https://www.moj.go.kr/bbs/moj/118/569781/artclView.do', date: '2023-04-18' }],
  },
  {
    id: 'no-new-loan', place: 'terms', name: '등기부 상태 유지 특약', deals: RENT,
    how: '계약한 날의 등기부 권리관계를 내가 입주하고 전입신고와 확정일자를 마친 다음 날까지 그대로 두고, 그사이 근저당 같은 새 권리를 만들지 않으며, 새 권리가 등기되면 계약을 해제하고 받은 돈을 돌려준다는 특약을 넣습니다. 법무부 표준계약서의 담보권 설정 금지 특약을 넓힌 것입니다.',
    why: '근저당은 등기를 접수한 날부터 효력이 생기는데 전입신고로 생기는 대항력과 우선변제권은 다음 날부터라서, 잔금 날 집주인이 대출을 받으면 그 근저당이 내 보증금보다 먼저입니다. 근저당 등기와 전입이 같은 날이라 세입자가 뒤 순위가 된 판례가 있습니다.\n기간을 잔금일 다음 날로 적으면 전입이 잔금일보다 늦을 때 빈틈이 생겨서, 입주와 전입신고, 확정일자를 마친 다음 날로 적습니다. 잔금으로 갚아 지우기로 한 근저당은 유지할 것에서 뺍니다.\n압류나 가압류처럼 집주인 뜻과 상관없이 생기는 등기도 있어서, 해제는 새 등기가 생기기만 하면 되게 하고 손해배상은 집주인이 어긴 경우로 둡니다.\n특약을 어겨도 이미 들어간 근저당이 지워지지는 않습니다. 잔금 직전과 전입 다음 날 등기부를 다시 떼 봅니다.',
    clauses: [{
      name: '입주 전까지 등기부 그대로',
      text: '임대인은 계약일 현재 등기사항증명서의 권리관계를 임차인이 입주하고 전입신고와 확정일자를 마친 다음 날까지 유지하며, 그 사이 근저당권, 전세권, 가등기 같은 새 권리를 설정하거나 매매나 신탁으로 소유권을 넘기지 않는다(잔금으로 갚아 지우기로 한 권리의 말소는 뺀다). 이 기간에 새 권리가 등기되면(압류, 가압류, 가처분 포함) 임차인은 계약을 해제할 수 있고, 임대인은 받은 돈 전액을 즉시 돌려주며, 임대인이 이를 어겼으면 임차인의 손해도 배상한다.',
    }],
    sources: [
      law('부동산등기법 제6조(등기는 접수한 때부터 효력)', '부동산등기법', '000600'),
      law('주택임대차보호법 제3조(대항력은 다음 날부터)', '주택임대차보호법', '000300'),
      prec('대법원 98다46938(근저당과 전입이 같은 날이면 근저당이 먼저)', '98다46938', '1999-03-23'),
      { title: '법무부: 주택임대차 표준계약서 2022년 수정(입주 전 담보권 설정 금지 특약 신설)', url: 'https://www.moj.go.kr/bbs/moj/118/564974/artclView.do', date: '2022-11-21' },
      { title: '뉴시스: 대항력 확보 전 근저당 설정 시 계약 해지 특약(정부 전세사기 예방 방안)', url: 'https://mobile.newsis.com/view/NISX20230201_0002177909', date: '2023-02-02' },
    ],
  },
  {
    id: 'owner-change', place: 'terms', name: '집주인이 바뀌면 알리는 특약', deals: RENT,
    how: '계약 중에 집주인이 집을 팔거나 소유권을 넘기려 하면 미리(늦어도 그 계약 뒤 바로) 세입자에게 알리고 새 소유자의 이름과 연락처를 알려 준다는 특약을 넣습니다. 승계를 거부할 수 있다는 특약은 넣지 않습니다(HUG 반환보증 가입이 안 됨).',
    clauses: [{
      name: '집주인이 바뀌면 알림',
      text: '임대인은 계약 기간 중 이 주택을 팔거나 소유권을 넘기려 하면 미리 임차인에게 알리고(늦어도 그 계약을 맺은 뒤 지체 없이), 새 소유자의 이름과 연락처를 알려 준다.',
    }],
    stepsTitle: '집주인이 바뀌었으면',
    steps: [
      { text: '등기부 갑구에서 새 소유자와 소유권이 넘어간 날을 봅니다.', links: [L.iros] },
      {
        text: 'HUG 반환보증에 들었으면 임대인 변경을 신청합니다. 은행에서 들었으면 그 은행에서, HUG 지사에서 들었으면 지사나 인터넷보증(보증해지/변경, 보증변경신청)에서, 카카오페이로 들었으면 인터넷보증에서 합니다. 등기부, 매매계약서 사본이나 새 임대인 인적사항이 나온 서류, 내 신분증 사본을 냅니다.',
        links: [L.hugInternet],
      },
      { text: '반환보증이 없고 새 소유자를 믿기 어려우면, 집이 팔린 것을 안 뒤 바로 원래 집주인에게 승계를 원하지 않는다고 문자나 내용증명으로 알리고 계약을 끝내 원래 집주인에게 보증금을 청구할 수 있습니다. 반환보증이 있으면 이렇게 하지 않습니다.' },
    ],
    why: '집이 팔리면 새 소유자가 임대인 자리를 그대로 이어받습니다. 지금 법에는 그때 세입자에게 알릴 의무가 없고, 새 집주인이 1개월 안에 서면으로 알리게 하는 개정안이 2026년 6월 발의됐다는 보도가 있습니다(통과 여부는 확인 못 함).\n세입자는 집이 팔린 것을 안 뒤 곧 이의하면 승계에서 빠지고 계약을 끝내 원래 집주인에게 보증금을 받을 수 있습니다. HUG는 이렇게 이의하면 그 집에 대한 우선변제권을 잃어 보증책임을 지지 않는다고 보아, 승계거부 특약이 있는 계약은 반환보증 가입이 안 된다고 안내합니다.',
    goto: { tab: 'fraud', label: '사기 사례 탭 바지 임대인' },
    sources: [
      law('주택임대차보호법 제3조 제4항(양수인이 임대인 지위 승계)', '주택임대차보호법', '000300'),
      prec('대법원 98마100(곧 이의하면 승계에서 빠지고 해지)', '98마100', '1998-09-02'),
      prec('대법원 2001다64615(안 때부터 상당한 기간 안에 이의하면 양도인 책임 남음)', '2001다64615', '2002-09-04'),
      { title: 'HUG 전세보증금반환보증 자주하는 질문(승계거부 특약, 임대인 변경 신청)', url: 'https://www.khug.or.kr/hug/web/ig/dr/igdr000003.jsp?tabMenu=Y', date: '' },
      { title: '경기신문: 집주인 바뀌면 1개월 안에 서면 통지하는 개정안 발의', url: 'https://www.kgnews.co.kr/news/article.html?no=899323', date: '2026-06-09' },
    ],
  },
  {
    id: 'repair', place: 'terms', name: '고칠 것', deals: RENT,
    how: '집을 볼 때 찾은 하자는 누가 언제까지 고치는지 특약에 적습니다.',
    why: '집주인은 계약 동안 살기에 필요한 상태를 유지해야 합니다. 큰 수선과 기본 설비 교체는 집주인 몫이고, 손쉽게 고칠 작은 것만 세입자 몫으로 본 판례가 있습니다. 구조 탓에 생긴 결로를 집주인 몫으로 본 판례도 있습니다.\n세입자가 대신 고친 필요비는 바로 청구할 수 있습니다.',
    sources: [
      law('민법 제623조(임대인의 의무)', '민법', '062300'),
      law('민법 제626조(비용상환청구권)', '민법', '062600'),
      prec('대법원 94다34692(작은 수선만 임차인)', '94다34692,94다34708', '1994-12-09'),
      prec('대법원 2010다89876(구조 탓 결로는 임대인)', '2010다89876,89883', '2012-06-14'),
    ],
  },
  {
    id: 'defects-buy', place: 'terms', name: '하자 특약', deals: ['buy'],
    how: '본 하자와 들은 하자(누수, 결로, 배관, 보일러)를 계약서에 적고, 판 사람이 잔금 전에 고칠지 값을 깎을지 정합니다.',
    why: '숨은 하자는 안 날부터 6개월 안에 판 사람에게 해제나 손해배상을 물을 수 있습니다. 알았거나 조금만 살폈으면 알았을 하자는 물을 수 없어서, 본 것은 계약서에 따로 정해 둡니다.',
    sources: [law('민법 제580조(매도인의 하자담보책임)', '민법', '058000'), law('민법 제582조(6개월)', '민법', '058200'), prec('대법원 79다827(미리 조사하지 않은 매수인은 과실)', '79다827', '1979-07-24')],
  },
  {
    id: 'no-change-buy', place: 'terms', name: '권리 변동 금지 특약', deals: ['buy'],
    how: '계약일부터 잔금일까지 판 사람이 계약 때 등기부에 없던 권리(근저당, 전세권, 가압류, 가처분, 가등기 등)를 새로 생기게 하지 않고, 어기면 산 사람이 계약을 해제할 수 있으며 판 사람이 계약금의 배액을 배상한다는 특약을 넣습니다. 판 사람 뜻과 상관없이 압류나 가압류가 들어와도 해제하고 돈을 돌려받을 수 있게 적습니다.',
    why: '특약이 새 등기 자체를 막지는 못하고, 어겼을 때 해제와 배상의 근거가 됩니다. 그래서 잔금 직전에 등기부를 다시 떼고 잔금 날 소유권이전등기를 바로 접수합니다.\n특약이 없어도 산 사람은 권리를 잃을 염려가 있으면 그 한도에서 잔금 지급을 거절할 수 있습니다. 배상액을 미리 정해 두면 그 금액으로 배상을 청구하고(위약금 약정은 손해배상액의 예정으로 추정), 너무 많으면 법원이 줄일 수 있습니다.',
    clauses: [{
      name: '권리 변동 금지',
      text: '매도인은 잔금일까지 이 부동산에 계약일 현재 등기사항증명서에 없는 권리(근저당권, 전세권, 가압류, 가처분, 가등기 등)를 설정하거나 생기게 하지 않는다. 이를 위반하면 매수인은 계약을 해제할 수 있고, 매도인은 매수인에게 계약금의 배액을 배상한다. 매도인의 뜻과 상관없이 새 권리가 등기된 때에도 매수인은 계약을 해제할 수 있고, 매도인은 받은 돈 전액을 즉시 돌려준다.',
    }],
    sources: [
      law('민법 제588조(권리를 잃을 염려가 있으면 대금 지급 거절)', '민법', '058800'),
      law('민법 제398조(배상액의 예정, 위약금은 예정으로 추정)', '민법', '039800'),
      REGISTRY_AGAIN,
    ],
  },
  {
    id: 'renewal', place: 'terms', name: '계약갱신', deals: RENT,
    how: '2년 뒤 한 번 더 2년을 요구할 수 있습니다(계약갱신요구권, 끝나기 6개월 전부터 2개월 전까지). 집주인이 들어와 살 계획이 있는지 묻습니다.',
    sources: [law('주택임대차보호법 제6조의3(계약갱신 요구)', '주택임대차보호법', '000603')],
  },
  {
    id: 'pets', place: 'terms', name: '반려동물과 못', deals: RENT,
    how: '반려동물, 벽에 못 박기, 도배를 바꿔도 되는지 묻고, 되면 특약에 적습니다.',
  },

  // ---------- 계약 전: 지금 집 나갈 때 ----------
  {
    id: 'notice-end', place: 'leaving', name: '나간다고 알리기', deals: RENT,
    how: '지금 집 계약이 끝나기 2개월 전까지 집주인에게 나간다고 문자처럼 기록이 남게 알립니다.',
    why: '알리지 않으면 같은 조건으로 2년 다시 계약한 것으로 봅니다.\n이미 그렇게 이어진 집은 언제든 나간다고 알릴 수 있고, 집주인이 받은 날부터 3개월 뒤에 끝납니다.',
    sources: [
      law('주택임대차보호법 제6조(계약의 갱신)', '주택임대차보호법', '000600'),
      law('제6조의2(묵시적 갱신 뒤 해지)', '주택임대차보호법', '000602'),
    ],
  },
  {
    id: 'date-match', place: 'leaving', name: '날짜 맞추기', deals: RENT,
    how: '새 집 잔금일을 지금 집 보증금을 돌려받는 날에 맞춥니다. 돌려줄 날짜는 집주인에게 문자로 받아 두고, 새 세입자가 들어와야 돌려준다는 식이면 새 집 계약을 서두르지 않습니다. 못 받을 수도 있으면 새 집 잔금일을 지금 집 계약이 끝나는 날에 바로 붙이지 말고, 임차권등기가 오를 만큼 며칠 뒤로 잡습니다.',
    why: '임차권등기는 지금 집 계약이 끝난 뒤에야 신청되고 결정과 등기에 며칠이 걸립니다(결정까지 3~4일이라는 보도). 그 전에 지금 집 전입을 빼면 지금 집 보증금 순위를 잃을 수 있고, 새 집 전입을 미루면 새 집 대항력이 그만큼 늦게 생깁니다.',
    sources: [
      law('주택임대차보호법 제3조의3(임차권등기명령)', '주택임대차보호법', '000303'),
      { title: '뉴시스: 임차권등기 신청 서류와 비용, 결정까지 3~4일', url: 'https://mobile.newsis.com/view/NISX20230126_0002171068', date: '2023-01-28' },
    ],
  },
  {
    id: 'lease-registration', place: 'leaving', name: '못 받고 나가면 임차권등기', deals: RENT,
    how: '계약이 끝났는데 보증금을 다 못 받은 채 먼저 이사해야 하면, 법원에 임차권등기명령을 신청하고 등기부에 임차권등기가 올라간 것을 본 뒤 전입을 옮깁니다. 보증금 크기와 상관없이 신청할 수 있습니다.',
    stepsTitle: '신청 순서',
    steps: [
      { text: '계약이 끝난 뒤에만 신청됩니다. 계약 기간이 끝났거나 해지 통지가 효력을 낸 뒤인지 보고, 끝낸다는 문자나 내용증명을 남겨 둡니다.' },
      { text: '서류를 모읍니다: 임차권등기명령 신청서와 부동산 목록(법원 양식), 등기사항증명서, 확정일자 받은 계약서 사본, 주소 변동이 나온 주민등록초본, 계약을 끝낸다고 알린 증빙(문자 출력이나 내용증명). 집 일부만 빌렸으면 그 부분 도면도 냅니다.' },
      {
        text: '집이 있는 곳을 맡은 지방법원(지원, 시군법원 포함) 민원실에 내거나 대법원 전자소송으로 냅니다. 직접 하면 비용은 4만 원대(송달료 포함), 법무사에 맡기면 40만 원 안팎이라는 보도가 있습니다.',
        links: [{ label: '대법원 전자소송', url: 'https://ecfs.scourt.go.kr/' }],
      },
      { text: '결정이 나도 바로 이사하지 말고, 인터넷등기소에서 등기부에 임차권등기가 올라간 것을 확인한 뒤 이사하고 전입을 옮깁니다. 결정문을 받은 것만으로는 순위가 지켜지지 않습니다.', links: [L.iros] },
      { text: '든 비용은 집주인에게 청구합니다. 보증금을 돌려받을 때 같이 받는 경우가 많습니다.' },
    ],
    why: '대항력과 우선변제권은 전입과 거주가 이어져야 지켜집니다(우선변제는 경매 배당요구 종기까지 이어져야 한다는 판례). 등기 전에 전입을 옮기면 순위를 잃을 수 있고, HUG 반환보증도 임차권등기가 끝나기 전에 이사하거나 전입을 옮기면 보증책임을 지지 않습니다.\n임차권등기가 된 뒤에는 이사하고 전입을 옮겨도 대항력과 우선변제권이 남고, 신청과 등기에 든 비용은 집주인에게 청구할 수 있습니다.\n먼저 들어와 살았어도 이사하거나 전입을 빼면 그때 대항력이 사라지고, 나중에 임차권등기를 하면 등기를 마친 날부터 새로 생깁니다(예전 순위로 돌아가지 않음). 그래서 내가 살던 동안 잡힌 근저당까지 모두 나보다 앞서게 됩니다. 임차권등기명령 결정만 받고 등기가 오르기 며칠 전에 이사한 세입자가, 자기보다 늦게 잡힌 근저당으로 열린 경매의 낙찰자에게 대항하지 못한 판결이 있습니다.\n집주인 동의 없이 세입자 혼자 신청하고, 2023.4.18 개정으로 집주인에게 결정문이 가기 전에도 등기할 수 있습니다. 다만 결정문이 집주인에게도 가고 등기부에 올라가서 끝까지 모르게 할 수는 없습니다.',
    sources: [
      law('주택임대차보호법 제3조의3(임차권등기명령, 제3항 2023.4.18 개정)', '주택임대차보호법', '000303'),
      law('민사집행법 제292조 제3항(송달 전에도 집행)', '민사집행법', '029200'),
      prec('대법원 2007다17475(배당요구 종기까지 대항요건 유지)', '2007다17475', '2007-06-14'),
      { title: '경기일보 법률플러스: 이사 뒤 임차권등기를 하면(대법원 2024다326398, 먼저 든 세입자도 등기 전 이사로 대항력 소멸)', url: 'https://kyeonggi.com/article/20250618580122', date: '2025-06-18' },
      HUG_TERMS,
      { title: '뉴시스: 임차권등기 신청 서류와 비용(직접 약 4만 3천원, 법무사 약 40만원)', url: 'https://mobile.newsis.com/view/NISX20230126_0002171068', date: '2023-01-28' },
    ],
  },

  {
    id: 'ltr-fund', place: 'leaving', name: '장기수선충당금 돌려받기', kinds: ['apt'], deals: RENT,
    how: '관리비에 장기수선충당금이 들어 있었으면 나갈 때 관리사무소에서 납부확인서를 받아 집주인에게 돌려받습니다.',
    why: '장기수선충당금은 소유자가 내는 돈이라 세입자가 대신 낸 만큼 소유자가 돌려줘야 합니다. 300세대 이상이거나 승강기가 있거나 중앙집중식이나 지역난방인 아파트 등이 적립합니다.',
    sources: [law('공동주택관리법 시행령 제31조(장기수선충당금)', '공동주택관리법 시행령', '003100'), law('공동주택관리법 제29조(적립 대상)', '공동주택관리법', '002900')],
  },

  // ---------- 계약 전: 잔금 날 ----------
  {
    id: 'move-in', place: 'closing', name: '전입신고와 확정일자', deals: RENT,
    how: '잔금 날 이사하고 그날 전입신고와 확정일자를 같이 받습니다. 보증금을 못 받고 먼저 나가야 하면 임차권등기를 마친 뒤 전입을 옮깁니다.',
    why: '들어가 살면서 전입신고를 마치면 다음 날부터 대항력이 생깁니다. 확정일자를 그날이나 그 전에 받았으면 우선변제권도 같은 다음 날부터 생기고, 그보다 늦게 생긴 근저당과 세금보다 먼저 보증금을 받습니다.\n세금은 법정기일(신고일이나 고지서 발송일)로 순서를 정해서, 계약 뒤에 생긴 집주인 세금은 내 보증금보다 뒤입니다. 그 집에 매긴 세금(종합부동산세, 재산세 등)도 법정기일이 내 확정일자보다 늦으면 그 몫만큼 내 보증금이 먼저입니다.',
    sources: [
      law('주택임대차보호법 제3조(대항력)', '주택임대차보호법', '000300'),
      law('제3조의2(확정일자와 우선변제)', '주택임대차보호법', '000302'),
      prec('대법원 97다22393(같은 날 확정일자면 우선변제권도 다음 날)', '97다22393', '1997-12-12'),
      law('제3조의3(임차권등기명령)', '주택임대차보호법', '000303'),
      law('국세기본법 제35조(제1항 제3호, 제7항)', '국세기본법', '003500'),
      law('지방세기본법 제71조(제1항 제3호, 제6항)', '지방세기본법', '007100'),
    ],
  },
  {
    id: 'rent-report', place: 'closing', name: '전월세 신고', deals: RENT,
    how: '보증금이 6천만원을 넘거나 월세가 30만원을 넘으면 계약일부터 30일 안에 신고합니다. 전입신고를 하면 신고한 것으로 보고, 계약서를 내고 신고하면 확정일자가 같이 붙습니다.',
    why: '안 하면 과태료입니다(2025.6.1 뒤 계약부터, 2만원부터 30만원까지).',
    sources: [
      law('부동산 거래신고 등에 관한 법률 제6조의2(주택 임대차 계약의 신고)', '부동산 거래신고 등에 관한 법률', '000602'),
      law('제6조의5(전입신고와 확정일자 의제)', '부동산 거래신고 등에 관한 법률', '000605'),
      { title: '국토교통부: 전월세 신고 과태료 낮추고 6월부터 부과', url: 'https://www.molit.go.kr/USR/NEWS/m_71/dtl.jsp?id=95090898', date: '2025-04-28' },
    ],
  },
  {
    id: 'guarantee-apply', place: 'closing', name: '반환보증 신청', deals: RENT,
    how: '잔금일과 전입일 중 늦은 날부터 계약 기간의 절반이 지나기 전까지 아래 순서로 신청합니다. HUG 전세금안심대출보증으로 대출을 받았으면 반환보증이 이미 들어 있습니다.',
    steps: [
      { text: '잔금 날 전입신고를 하고 계약서에 확정일자를 받습니다(전월세 신고를 했으면 그 신고필증도 됩니다).', links: [L.rtms] },
      {
        text: '서류를 신청일 1개월 안에 발급받아 모읍니다: 신분증, 공인중개사가 날인하고 확정일자를 받은 계약서, 보증금을 계약서의 집주인 계좌로 보낸 증빙(계좌이체증명서 등), 등기사항전부증명서, 주민등록등본, 전입세대확인서(주민센터 방문만 됨), 건축물대장(아파트는 빼도 됨). 단독과 다가구는 건물과 토지 등기부, 확정일자 부여현황, 다른 세입자 계약 내역 확인서(HUG 양식)도 냅니다.',
        links: [L.hugProcedure, L.iros, L.gov24],
      },
      {
        text: '신청합니다: HUG 지사나 위탁은행 창구, 또는 휴대폰으로 네이버페이(부동산, 부동산금융, 전세금반환보증), 카카오페이(부동산, 전세반환보증), 토스(전체, 부동산, 내 전세금 지키기), 안심전세 앱.',
        links: [L.hugBranches, L.safeApp],
      },
      { text: 'HUG가 심사하고 보증서를 발급합니다(보증서는 HUG 인터넷보증에서도 받음). 보증료는 연 0.097~0.211%입니다.', links: [L.hugInternet] },
    ],
    sources: [HUG_RETURN, HUG_PROCEDURE],
  },
  {
    id: 'auction-pay', place: 'closing', name: '대금 내고 인도명령', deals: ['auction'],
    how: '대금을 낸 뒤 6개월 안에 법원에 인도명령을 신청합니다. 대항력 있는 점유자는 인도명령 대상이 아닙니다.',
    sources: [law('민사집행법 제136조(부동산의 인도명령)', '민사집행법', '013600')],
  },
  {
    id: 'registry-again', place: 'closing', name: '등기부 다시', deals: INSIDE,
    how: '잔금 직전에 등기부를 다시 떼서 계약 뒤 새 근저당이나 압류가 생겼는지 봅니다. 세입자면 전입 다음 날에도 한 번 더 봅니다.',
    sources: [REGISTRY_AGAIN],
  },
  {
    id: 'buy-register', place: 'closing', name: '소유권 이전', deals: ['buy'],
    how: '잔금 날 소유권이전등기를 바로 접수하고, 관리비와 공과금을 날짜로 나눠 정산합니다.',
  },
];
