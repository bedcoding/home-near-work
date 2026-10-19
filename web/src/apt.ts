import type { ListingView } from '../../shared/types';
import type { SupportSource } from './support';

// 서울 아파트 탭(AptView): 회사와 멀어도 고른 서울 구의 아파트 경매(법원경매), 공매(온비드), 매매(네이버)를 모아 본다.
// 살 때 붙는 실거주, 대출, 양도세 조건은 모으는 데이터가 아니라 조사한 날 기준으로 손으로 정리했다.
// 고칠 때는 APT_CHECKED와 근거(sources)도 같이 고친다.

/** 조사한 날 */
export const APT_CHECKED = '2026-10-19';
/** 서울 전역 토지거래허가구역 지정 기간 끝(아파트). 이 날이 지나면 매매 표시를 '기간 확인'으로 바꾼다. */
export const PERMIT_UNTIL = '2026-12-31';

/** 탭 안 종류: 법원경매, 온비드 공매, 매매 매물 */
export type AptKind = 'court' | 'onbid' | 'sale';

export const APT_KINDS: { id: AptKind; name: string; title: string }[] = [
  { id: 'court', name: '경매', title: '법원경매 아파트. 토지거래허가를 받지 않습니다' },
  { id: 'onbid', name: '공매', title: '온비드 공매 아파트. 토지거래허가는 재산 종류에 따라 다릅니다' },
  { id: 'sale', name: '매매', title: '네이버 부동산에서 본 아파트 매매 매물(크롬 확장이 모음). 토지거래허가를 받아 2년 살아야 합니다' },
];

/** 매물이 탭의 어느 종류인지(경매와 공매가 아니고 매매 가격도 없으면 null) */
export const aptKindOf = (l: Pick<ListingView, 'source' | 'prices'>): AptKind | null =>
  l.source === 'courtauction' ? 'court' : l.source === 'onbid' ? 'onbid' : l.prices.some((p) => p.deal === 'sale') ? 'sale' : null;

/** 가격 상한에 견주는 금액(만원): 경매와 공매는 최저가, 매매는 매매가. 모르면 null. */
export function aptPrice(l: Pick<ListingView, 'source' | 'prices'>): number | null {
  const kind = aptKindOf(l);
  const p = kind === 'sale' ? l.prices.find((x) => x.deal === 'sale') : l.prices[0];
  return p?.price ?? null;
}

/** 세대수 최소, 최대 고르기 칸의 값('없음'은 따로 둔다) */
export const HOUSEHOLD_STEPS = [100, 150, 200, 250, 300, 500, 700, 1000, 1500, 2000, 3000];

/**
 * 살 때 붙는 조건 한 줄. live: 실거주 조건(짧게), status: ok 법령이나 공식 자료, 여러 보도로 확인,
 * news 보도로만 확인한 것이 섞임, check 해설만 보고 법령 원문은 확인하지 못함.
 */
export interface AptRule {
  id: string;
  name: string;
  live: string;
  text: string;
  notes: string[];
  status: 'ok' | 'news' | 'check';
  sources: SupportSource[];
}

export const APT_STATUS_TEXT: Record<AptRule['status'], string> = { ok: '확인', news: '보도 기준', check: '확인 필요' };

/** 맨 위 한 줄 요약 */
export const APT_SUMMARY =
  '대출 없이 법원경매로 사면 실거주 의무가 없습니다. 다만 팔 때 양도세 비과세를 받으려면 2년은 살아야 합니다. 매매는 허가받고 2년, 대출을 받으면 6개월 안 전입이 붙습니다.';

/** 법령 조문 링크 앞부분(lsNm에 법령 이름, joNo에 조 번호 6자리) */
const LAW_LINK = 'https://law.go.kr/LSW/lsLinkProc.do?lsClsCd=L&mode=11&lsNm=';

export const APT_RULES: AptRule[] = [
  {
    id: 'sale',
    name: '매매',
    live: '허가 후 4개월 안 입주, 2년 거주',
    text: '서울 전역이 토지거래허가구역입니다(2025.10.20 ~ 2026.12.31). 계약 전에 구청 허가를 받아야 하고, 허가받은 날부터 4개월 안에 들어가 2년 동안 살아야 합니다.',
    notes: [
      '세입자가 사는 집은 임대차가 끝날 때까지 입주를 미룰 수 있습니다. 2026.5.12에 무주택이었던 사람이 대상이고, 신청 기한이 2027년 말까지로 늘었다는 보도입니다(갱신계약 1회까지 합쳐 최장 3년 3개월). 조건은 구청에 확인하세요.',
      '지정 기간(2026.12.31)이 끝난 뒤 연장되는지는 그때 다시 확인해야 합니다.',
    ],
    status: 'ok',
    sources: [
      { title: '헤럴드경제: 서울과 경기 37곳, 실거주 안 하면 집 못산다(10.15 대책)', url: 'https://www.heraldk.com/article/2025101417000026673', date: '2025-10-14' },
      { title: 'thecheck.co.kr: 10.15 부동산대책, 조정지역과 투과지구 확대(허가 후 2년 실거주)', url: 'https://thecheck.co.kr/?p=1387', date: '' },
      { title: '한국경제: 토허구역 주택은 허가일부터 4개월 안 입주(국토부 지침)', url: 'https://www.hankyung.com/article/202504214468Y', date: '2025-04-21' },
      { title: 'SBS Biz: 토허구역 세 낀 집 사도 입주 최대 3년 미룬다', url: 'https://biz.sbs.co.kr/amp/article/20000335216', date: '2026-09-17' },
      { title: '한국경제: 무주택자는 3년간 세낀 매매 가능', url: 'https://www.hankyung.com/article/202609171789i', date: '2026-09-17' },
    ],
  },
  {
    id: 'court',
    name: '법원경매',
    live: '없음(토지거래허가 예외)',
    text: '민사집행법에 따른 경매는 토지거래허가를 받지 않습니다(부동산거래신고법 제14조 제2항). 그래서 허가에 따른 실거주 의무가 없습니다.',
    notes: ['낙찰 잔금을 대출받으면 아래 대출 조건(6개월 안 전입)이 붙습니다.', '팔 때 양도세 비과세를 받으려면 2년 거주가 필요합니다(아래 양도세 줄).'],
    status: 'ok',
    sources: [
      {
        title: '부동산 거래신고 등에 관한 법률 제14조(국가 등의 토지거래계약에 관한 특례 등)',
        url: 'https://korea.legal/wiki/%eb%b6%80%eb%8f%99%ec%82%b0-%ea%b1%b0%eb%9e%98%ec%8b%a0%ea%b3%a0-%eb%93%b1%ec%97%90-%ea%b4%80%ed%95%9c-%eb%b2%95%eb%a5%a0-%ec%a0%9c14%ec%a1%b0/',
        date: '',
      },
      { title: '헤럴드경제: 경매로 낙찰 받으면 토허제 예외', url: 'https://heraldk.com/?p=2522976', date: '' },
    ],
  },
  {
    id: 'onbid',
    name: '온비드 공매',
    live: '재산 종류에 따라 다름',
    text: '압류재산(세금 체납으로 압류된 것), 국유재산, 공유재산, 유입자산은 허가가 필요 없고, 수탁재산(캠코에 매각을 맡긴 것)은 3번 이상 유찰된 뒤에 파는 것만 허가가 필요 없다는 해설입니다(시행령 제11조 제3항 제16호). 카드에는 온비드가 준 재산 종류로 표시합니다.',
    notes: ['변호사 칼럼 기준이고 법령 원문은 확인하지 못했습니다. 입찰 전에 구청에 확인하세요.'],
    status: 'check',
    sources: [
      {
        title: '이데일리 김용일의 부동산톡: 토지거래허가구역내 허가를 받지 않아도 되는 경우(경매와 공매의 예외)',
        url: 'https://www.edaily.co.kr/news/read?newsId=01167686628920672&mediaCodeNo=257',
        date: '',
      },
    ],
  },
  {
    id: 'loan',
    name: '대출(주담대, 경락잔금대출)',
    live: '대출받으면 6개월 안 전입',
    text: '서울에서 집을 사며 주택담보대출을 받으면 6개월 안에 그 집으로 전입해야 하고, 어기면 대출을 회수합니다(2025.6.28부터). 경매 낙찰 잔금을 빌리는 경락잔금대출에도 같은 한도와 6개월 전입이 적용된다는 보도가 있습니다. 대출 없이 사면 이 조건은 없습니다.',
    notes: [
      '한도는 시세 15억 이하 6억, 15억 넘고 25억 이하 4억, 25억 넘으면 2억입니다. 규제지역 LTV는 무주택자 40%(생애최초 70%)입니다(10.15 대책).',
      '전입한 뒤 얼마나 살아야 하는지는 확인하지 못했습니다(대출 약정서 확인).',
    ],
    status: 'news',
    sources: [
      { title: '파이낸셜뉴스: 6월 28일부터 6억 한도와 6개월 내 전입 규제', url: 'https://www.fnnews.com/news/202507041542469482', date: '2025-07-04' },
      { title: '비즈워치: 6억 한도와 6개월 전입, 경락잔금대출에도 적용', url: 'https://news.bizwatch.co.kr/article/real_estate/2025/07/03/0040', date: '2025-07-03' },
      { title: '머니투데이방송: 25억 주택 주담대 최대 2억, 규제지역 LTV 40%(10.15 대책)', url: 'https://news.mtn.co.kr/news-detail/2025101507523614845', date: '2025-10-15' },
    ],
  },
  {
    id: 'tax',
    name: '팔 때 양도세 비과세(1세대 1주택)',
    live: '2년 보유, 2년 거주',
    text: '2년 넘게 갖고 있어야 하고, 산 날 그 집이 조정대상지역이었으면 갖고 있는 동안 2년을 살아야 합니다(전입일부터 전출일까지). 서울은 2025.10.16부터 전역이 조정대상지역이라 그 뒤에 산 집은 경매로 샀어도 2년 거주가 필요하고, 나중에 지정이 풀려도 산 날 기준으로 봅니다. 경매는 매각대금을 다 낸 날이 산 날입니다.',
    notes: [
      '조정대상지역 공고 전에 계약하고 계약금을 낸 무주택 세대는 거주 2년을 면제받습니다(보유 2년은 필요).',
      '파는 값이 12억을 넘으면 넘는 비율만큼 세금을 냅니다: 과세 양도차익 = 양도차익 × (양도가액 − 12억) ÷ 양도가액.',
      '장기보유특별공제: 3년 넘게 갖고 2년 넘게 살았으면 보유 연 4%와 거주 연 4%를 더해 최대 80%까지 뺍니다. 거주가 2년이 안 되면 연 2%, 최대 30%입니다.',
      '갈아탈 때(일시적 2주택): 종전 집을 산 지 1년 넘어 새 집을 사고, 두 집이 다 조정대상지역이면 새 집을 산 날부터 2년 안에 종전 집을 팔아야 비과세입니다(2026.10.1부터, 그 밖에는 3년). 2026.8.3 이전에 새 집을 샀거나 계약금을 냈으면 3년이라는 보도입니다.',
      '다가구주택은 통째로 한 사람에게 팔 때만 단독주택 하나로 보고, 12억 기준도 전체 값으로 봅니다.',
    ],
    status: 'ok',
    sources: [
      { title: '소득세법 시행령 제154조 제1항(보유와 거주 2년, 제5호 계약금 예외)', url: `${LAW_LINK}소득세법시행령&joNo=015400`, date: '2026-10-01' },
      { title: '소득세법 제89조 제1항 제3호(1세대 1주택 비과세, 12억 고가주택)', url: `${LAW_LINK}소득세법&joNo=008900`, date: '' },
      { title: '국세상담센터: 취득 뒤 조정대상지역이 풀려도 거주요건 적용', url: 'https://call.nts.go.kr/call/qna/selectQnaInfo.do?mi=2013', date: '' },
      { title: '소득세법 제98조(대금을 청산한 날이 취득일)', url: `${LAW_LINK}소득세법&joNo=009800`, date: '' },
      { title: '민사집행법 제135조(매각대금을 다 낸 때 권리 취득)', url: `${LAW_LINK}민사집행법&joNo=013500`, date: '' },
      { title: '국세청: 고가주택 양도차익 계산', url: 'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?mi=12271&cntntsId=8799', date: '' },
      { title: '소득세법 제95조 제2항(장기보유특별공제)', url: `${LAW_LINK}소득세법&joNo=009500`, date: '' },
      { title: '소득세법 시행령 제159조의4(거주 2년이면 1세대 1주택 공제율)', url: `${LAW_LINK}소득세법시행령&joNo=015904`, date: '' },
      { title: '소득세법 시행령 제155조 제1항(일시적 2주택), 제15항(다가구)', url: `${LAW_LINK}소득세법시행령&joNo=015500`, date: '2026-10-01' },
      { title: '정책브리핑: 조정대상지역 일시적 2주택 처분기한 2년', url: 'https://www.korea.kr/news/policyNewsView.do?newsId=148972735', date: '2026-09-29' },
      { title: '뉴스핌: 2026.8.4 이후 새 집을 산 경우부터 적용', url: 'https://www.newspim.com/news/view/20260929000419', date: '2026-09-29' },
    ],
  },
  {
    id: 'checklist',
    name: '매매할 때 확인할 것',
    live: '계약 전, 잔금 직전, 잔금 날 이전등기',
    text: '등기부(말소사항 포함 전부증명서)를 계약 전과 잔금 직전에 다시 떼고, 잔금 날 소유권이전등기를 바로 접수합니다. 세금 압류는 등기부 갑구에 등기돼야 효력이 생기고 등기부는 누구나 볼 수 있어서, 내 이전등기가 접수되기 전에 압류가 없었으면 그 뒤에 판 사람 체납으로 내 집을 압류할 수 없습니다(체납자가 아닌 사람 재산의 압류는 무효). 예외로 판 사람이 빚을 피하려고 판 것이면 사해행위로 매매가 취소될 수 있고, 몰랐다는 것은 산 사람이 증명해야 합니다(적정한 값에 팔아 빚을 갚는 데 쓴 경우는 사해행위가 아니라고 본 판례가 있음).',
    notes: [
      '근저당을 지운 기록이 있으면: 판 사람에게 은행의 대출완제확인서나 부채증명원을 받고, 판 사람의 서면 동의를 받거나 함께 은행에 확인합니다(은행은 판 사람 동의 없이 대출 정보를 알려 줄 수 없음). 서류에 적힌 번호가 아니라 은행 누리집의 원본 확인 화면이나 은행 공식 번호로 확인합니다. 판 사람이 확인을 거부하면 사지 않습니다.',
      '세금: 판 사람에게 국세 납세증명서와 지방세 납세증명서를 받습니다. 발급일 현재 체납만 증명하고 발급일부터 30일만 유효해서, 잔금 날이 그 안에 들어야 합니다. 매수인이 판 사람 체납을 직접 볼 길은 없습니다(미납세금 열람은 세입자용). 등기부에 압류가 있으면 체납을 다 내고 압류 말소가 끝난 뒤 잔금을 냅니다. 압류된 채로 사면 그 체납액 전부를 내야 풀린다는 국세청 해석이 있습니다.',
      '판 사람 본인 확인: 주민등록증은 ☎1382나 정부24 진위확인, 운전면허증은 경찰청 이파인으로 봅니다. 대리인이면 위임장과 인감증명서를 보고 정부24 인감증명발급 사실확인으로 확인합니다. 대금은 등기부 소유자 명의 계좌로만 보냅니다.',
      '숨은 세입자: 계약서를 쓴 뒤 산 사람이 직접 전입세대확인서를 뗄 수 있습니다(그 전에는 소유자 위임). 대항력 있는 세입자가 있으면 보증금 반환 의무가 산 사람에게 넘어옵니다.',
      '건축물대장의 위반건축물 표시: 산 사람도 시정명령과 이행강제금(1년 2회 이내 반복)을 받습니다. 토지이용계획(용도지역, 도시계획시설, 허가구역)도 봅니다.',
      '아파트는 전 주인이 밀린 관리비 중 공용부분을 산 사람이 물려받습니다(판례).',
      '신탁: 등기부 갑구에 신탁 등기가 있으면 소유자는 신탁회사이고 판 사람은 소유자가 아닙니다(신탁원부 번호가 같이 적히고, 2024년 12월 21일부터는 신탁원부를 확인하라는 주의 문구도 붙음). 신탁원부로 처분 권한과 동의 조건을 보고, 신탁회사 동의 없이는 사지 않습니다. 남의 권리를 판 것이라 소유권을 못 받으면 해제는 할 수 있지만, 신탁을 알고 샀으면 손해배상은 못 받습니다.',
    ],
    status: 'ok',
    sources: [
      { title: '생활법령: 대금 지급 직전 등기부 다시 확인', url: 'https://www.easylaw.go.kr/CSP/CnpClsMain.laf?popMenu=ov&csmSeq=1894&ccfNo=2&cciNo=2&cnpClsNo=2', date: '' },
      { title: '국세징수법 제46조(압류 효력은 압류등기 완료 때)', url: `${LAW_LINK}국세징수법&joNo=004600`, date: '' },
      { title: '지방세징수법 제57조(같음)', url: `${LAW_LINK}지방세징수법&joNo=005700`, date: '' },
      { title: '부동산등기법 제19조(등기부는 누구나 열람)', url: `${LAW_LINK}부동산등기법&joNo=001900`, date: '' },
      { title: '대법원 92누12117(체납자 아닌 사람 재산의 압류는 무효)', url: 'https://law.go.kr/LSW/precInfoP.do?evtNo=92%EB%88%8412117', date: '1993-04-27' },
      { title: '국세징수법 제25조(사해행위 취소)', url: `${LAW_LINK}국세징수법&joNo=002500`, date: '' },
      { title: '대법원 95다51908(수익자가 선의를 증명)', url: 'https://law.go.kr/LSW/precInfoP.do?evtNo=95%EB%8B%A451908', date: '1997-05-23' },
      { title: '대법원 2024다275773(적정한 값에 팔아 빚을 갚으면 사해행위 아님) 판례속보', url: 'https://www.scourt.go.kr/portal/news/NewsViewAction.work?pageIndex=1&searchWord=&searchOption=&seqnum=10212&gubun=4&type=5', date: '2024-12-12' },
      { title: '신용정보법 제32조(정보 제공에는 본인 동의)', url: `${LAW_LINK}신용정보의이용및보호에관한법률&joNo=003200`, date: '' },
      { title: 'IBK기업은행 여신증명서 원본조회(대출완제확인서, 부채증명원)', url: 'https://mybank.ibk.co.kr/uib/jsp/guest/ufs/EUFS305000u.jsp', date: '' },
      { title: '국세징수법 시행령 제96조(납세증명서 30일)', url: `${LAW_LINK}국세징수법시행령&joNo=009600`, date: '' },
      { title: '정부24 납세증명서(국세)', url: 'https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=12100000011', date: '' },
      { title: '정부24 지방세 납세증명서', url: 'https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=13100000056', date: '' },
      { title: '국세징수법 제109조(미납국세 열람은 임차하려는 사람)', url: `${LAW_LINK}국세징수법&joNo=010900`, date: '' },
      { title: '국세청 해석 국징-징세과-8633(압류된 집을 산 사람은 체납액 전액 납부)', url: 'https://olta.re.kr/explainInfo/authoInterpretationDetail.do?num=60082949', date: '2017-11-16' },
      { title: '행정안전부 주민등록증 진위확인', url: 'https://www.mois.go.kr/frt/sub/a06/b06/IDCard_7/screen.do', date: '' },
      { title: '정부24 인감증명발급 사실확인', url: 'https://m.gov.kr/ingam/ingam.jsp?img=031', date: '' },
      { title: '서울부동산정보광장: 대금은 등기부 명의 통장으로', url: 'https://land.seoul.go.kr/land/broker/estateBrokerageGuide.do', date: '' },
      { title: '주민등록법 제29조의2(전입세대확인서는 매매계약자도)', url: `${LAW_LINK}주민등록법&joNo=002902`, date: '' },
      { title: '주택임대차보호법 제3조 제4항(산 사람이 임대인 지위 승계)', url: `${LAW_LINK}주택임대차보호법&joNo=000300`, date: '' },
      { title: '생활법령: 불법건축물을 산 사람도 제재', url: 'https://easylaw.go.kr/CSP/EasyLawInfoR.laf?csmSeq=1406&easySeq=1473', date: '' },
      { title: '대법원 2001다8677 전원합의체(공용부분 체납관리비 승계)', url: 'https://law.go.kr/LSW/precInfoP.do?evtNo=2001%EB%8B%A48677', date: '2001-09-20' },
      { title: '대법원 2000다70460(신탁하면 소유권이 수탁자에게 완전히 넘어감)', url: 'https://www.law.go.kr/LSW/precInfoP.do?mode=0&evtNo=2000다70460', date: '2002-04-12' },
      { title: '국토교통부: 신탁회사 동의 없는 계약(정책브리핑)', url: 'https://www.korea.kr/news/policyNewsView.do?newsId=148939915', date: '2025-02-25' },
      { title: '대법원 보도자료: 신탁 부동산 거래 주의사항 등기 시행', url: 'https://www.scourt.go.kr/portal/news/NewsViewAction.work?pageIndex=1&searchWord=&searchOption=&seqnum=2745&gubun=6', date: '2024-12-19' },
      { title: '민법 제570조(남의 권리를 판 경우 해제와 손해배상)', url: `${LAW_LINK}민법&joNo=057000`, date: '' },
    ],
  },
  {
    id: 'title',
    name: '등기 위조 사기와 권원보험(매매)',
    live: '잔금 전 가입, 이 사기 보상은 회사에 확인',
    text: '매도인이 대출을 갚지 않고 은행 서류를 위조해 근저당을 등기부에서 지운 뒤 집을 파는 사기가 있습니다. 등기에는 공신력이 없어 이렇게 지워진 근저당은 그대로 살아 있고, 은행이 회복등기를 구하면 매수인은 몰랐어도 승낙해야 하며, 은행은 그 집을 경매에 넘길 수 있습니다. 매수인은 채권최고액 안에서 남은 빚을 대신 갚아 근저당을 없애거나 매도인에게 계약 해제와 손해배상을 청구할 수 있지만, 보도된 사례들에서는 매도인이 수감이나 도주 중이라 받기 어려웠습니다.',
    notes: [
      '권원보험(부동산 권리보험)은 위조, 사기처럼 등기부만 봐서는 모르는 권리 하자로 생긴 손해를 보상합니다. 그런데 지워진 근저당이 되살아나는 경우를 보상하는지는 두 회사 약관 어디에도 따로 적혀 있지 않습니다. 퍼스트어메리칸 상품을 파는 내집스캔은 이 경우를 보장 사례로 들지만, 2022년 기사에는 이런 경우 보상이 어렵다는 내용이 나옵니다. 가입 전에 이 경우가 보상되는지 서면으로 받아 두세요.',
      '하나손해보험 내집마련 부동산 권리보험(소유권용): 매수인이 들고, 연계 법무법인을 통해 소유권 이전을 같이 해야 합니다(보험만 따로는 안 됨). 계약서를 쓴 뒤 잔금 5영업일 전까지(최대 25일 전부터) 가입하고, 보험료는 5억 기준 173,400원을 한 번 냅니다. 소유권을 남에게 넘길 때까지 보장합니다.',
      '퍼스트어메리칸 퍼스트 주거용 권리보험(내집스캔에서는 매매지킴보증): 매수인이 계약 뒤 잔금 3일 전까지 들고, 가입금액은 산 값(한도는 매매가)이며 보험료는 한 번 냅니다(내집스캔 안내로 3억 기준 199,000원). 권리조사비 11,000원은 보험료에 들어가고 철회하면 돌려받지 못합니다. 가등기, 가처분, 경매개시결정 등기처럼 넘겨받을 수 없는 권리가 있으면 거절합니다. 내집스캔은 법무사 없이도, 주택담보대출을 받아도 가입된다고 안내합니다.',
      '두 회사 모두 알고 있던 하자, 등기부에 이미 나온 권리, 보장이 시작된 뒤 생긴 권리, 현장을 봐야 아는 것(유치권 등)은 보상하지 않고, 소송이 걸리면 판결이 확정될 때까지 보상하지 않습니다. 빌라, 오피스텔, 단독, 경매 낙찰 물건도 되는지는 공식 문구를 찾지 못했습니다(퍼스트어메리칸은 토지와 상가를 따로 상담).',
      '막는 법: 말소사항 포함 등기부를 떼서 최근에 지워진 근저당이 있는지 봅니다(확인한 사례 둘은 말소 뒤 1달, 5달 만에 팔았음). 매수 예정자는 말소에 쓰인 서류를 열람할 수 없고, 은행은 판 사람 동의 없이 대출 정보를 알려 주지 않으므로 판 사람 동의를 받아 확인합니다(위 매매할 때 확인할 것 줄). 잔금 때 근저당이 남아 있으면 매도인이 말소 서류까지 준비할 때까지 잔금을 미룰 수 있습니다.',
      '경매로 사면 매각으로 그 집의 저당권이 모두 지워지므로 이 사기와는 다릅니다.',
    ],
    status: 'news',
    sources: [
      { title: '부동산등기법 제59조(말소등기의 회복과 제3자 승낙)', url: `${LAW_LINK}부동산등기법&joNo=005900`, date: '' },
      { title: '대법원 95다39526(가등기 사안: 원인 없이 말소돼도 효력 유지, 제3자는 선의든 악의든 승낙 의무)', url: 'https://www.law.go.kr/LSW/precInfoP.do?precSeq=196829', date: '1997-09-30' },
      { title: '민법 제364조(산 사람이 빚을 갚고 저당권 소멸 청구)', url: `${LAW_LINK}민법&joNo=036400`, date: '' },
      { title: '민법 제576조(저당권 때문에 잃으면 해제와 손해배상)', url: `${LAW_LINK}민법&joNo=057600`, date: '' },
      { title: '민법 제588조(권리를 잃을 염려가 있으면 대금 지급 거절)', url: `${LAW_LINK}민법&joNo=058800`, date: '' },
      { title: '대법원 79다1562(말소 서류까지 준비해야 매도인 이행)', url: 'https://www.law.go.kr/LSW/precInfoP.do?evtNo=79%EB%8B%A41562', date: '1979-11-13' },
      { title: '민사집행법 제91조 제2항(매각으로 저당권 소멸)', url: `${LAW_LINK}민사집행법&joNo=009100`, date: '' },
      { title: 'MBC: 위조 서류로 근저당 말소, 고양 다세대 4가구', url: 'https://imnews.imbc.com/replay/2025/nwtoday/article/6692498_36807.html', date: '2025-03-05' },
      { title: '중앙SUNDAY: 화곡동 빌라 위조 말소와 권원보험 보상 어려움(다음 전재)', url: 'https://v.daum.net/v/20221224000154386', date: '2022-12-24' },
      { title: '하나손해보험 내집마련 부동산 권리보험 안내', url: 'https://m.hanainsure.co.kr/honeQ/product/realestateright/honeQRealEstateRightIntro?origin=m', date: '' },
      { title: '하나손해보험 소유권용 약관', url: 'https://www.hanainsure.co.kr/download/prd?instype=18001&type=agree&spctype=0', date: '' },
      { title: '퍼스트어메리칸 묻고 답하기', url: 'https://www.firstam.co.kr/FAQ', date: '' },
      { title: '퍼스트 주거용 권리보험 보통약관', url: 'https://www.firstam.co.kr/Docs/owner_terms.pdf', date: '' },
      { title: '내집스캔 매매지킴보증(퍼스트어메리칸) 안내', url: 'https://www.naezipscan.com/insurance/firstamerican/title-001/landing', date: '' },
      { title: '등기선례 제8-107호(매수 예정자는 열람할 이해관계인 아님, korea.legal 전재)', url: 'https://korea.legal/wiki/%eb%93%b1%ea%b8%b0%ec%84%a0%eb%a1%80-%ec%a0%9c8-107%ed%98%b8/', date: '2004-10-12' },
    ],
  },
];

/** 집터 탭(단독주택, 토지) 맨 위 한 줄 요약 */
export const PLOT_SUMMARY =
  '서울 전역 토지거래허가는 아파트가 대상이라 단독과 땅은 보통 허가 없이 사지만, 따로 지정된 구역(신속통합기획 후보지 등)은 허가가 필요합니다. 팔 때 1세대 1주택 비과세는 집에만 있고 땅만은 없습니다.';

/** 집터 탭의 살 때 붙는 조건(토지거래허가, 경매, 대출, 양도세, 매매할 때 확인할 것, 등기 위조 사기와 권원보험) */
export const PLOT_RULES: AptRule[] = [
  {
    id: 'permit',
    name: '토지거래허가',
    live: '따로 지정된 구역만',
    text: '서울 전역 토지거래허가(2025.10.20부터)는 아파트와, 같은 단지에 아파트가 1개동 이상 있는 연립과 다세대가 대상입니다. 단독주택과 땅은 그 대상이 아니지만, 신속통합기획 후보지처럼 따로 허가구역으로 지정된 곳은 땅과 단독도 허가를 받고 실거주나 직접 이용을 해야 합니다. 지번으로 토지이음에서 확인하세요.',
    notes: ['법원경매는 허가를 받지 않습니다(아래 법원경매 줄).'],
    status: 'news',
    sources: [
      { title: 'SBS Biz: 서울과 경기 37곳 토허구역(아파트와 단지 안 연립, 다세대)', url: 'https://biz.sbs.co.kr/amp/article/20000265269', date: '2025-10-15' },
      { title: 'MTN: 구의, 신길, 갈현 신통기획 후보지 토지거래허가구역과 건축허가 제한', url: 'https://news.mtn.co.kr/news-detail/2026073017530598598', date: '2026-07-30' },
      { title: '토지이음(지번으로 토지거래허가구역 확인)', url: 'https://www.eum.go.kr/', date: '' },
    ],
  },
  ...APT_RULES.filter((r) => r.id === 'court' || r.id === 'loan'),
  {
    id: 'plot-tax',
    name: '팔 때 양도세(단독주택과 땅)',
    live: '단독은 아파트와 같음, 땅만은 비과세 없음',
    text: '단독주택(과 딸린 땅)은 아파트와 같은 1세대 1주택 비과세 조건을 따릅니다: 2년 보유, 산 날 조정대상지역이면 2년 거주(서울은 2025.10.16부터 전역), 12억 넘는 부분은 과세. 집 없는 땅을 그대로 팔면 주택이 아니라 1세대 1주택 비과세 대상이 아닙니다.',
    notes: ['다가구주택은 통째로 한 사람에게 팔 때만 단독주택 하나로 보고, 12억 기준도 전체 값으로 봅니다.', '경매는 매각대금을 다 낸 날이 산 날입니다.'],
    status: 'ok',
    sources: [
      { title: '소득세법 제89조 제1항 제3호(1세대 1주택과 딸린 땅)', url: `${LAW_LINK}소득세법&joNo=008900`, date: '' },
      { title: '소득세법 시행령 제154조 제1항(보유와 거주 2년)', url: `${LAW_LINK}소득세법시행령&joNo=015400`, date: '2026-10-01' },
      { title: '소득세법 시행령 제155조 제15항(다가구)', url: `${LAW_LINK}소득세법시행령&joNo=015500`, date: '2026-10-01' },
    ],
  },
  ...APT_RULES.filter((r) => r.id === 'checklist' || r.id === 'title'),
];

/** 세대수 칸 아래 설명과 근거(short는 링크 글자). 참고로 법에 있는 선(의무관리대상)과 대단지 기준을 같이 적는다. */
export const HOUSEHOLD_NOTE =
  "세대수는 경매, 공매, 네이버 목록에 없어서, 경매와 공매는 건축물대장에서 채우고(공공데이터포털 키가 있을 때) 나머지는 카드의 '세대수 넣기'로 단지마다 한 번 넣습니다. 참고로 법에 있는 선은 의무관리대상(300세대 이상, 또는 150세대 이상이면서 승강기나 중앙, 지역난방)이고, 대단지는 보통 1,000세대 이상을 말합니다.";
export const HOUSEHOLD_SOURCES: (SupportSource & { short: string })[] = [
  { short: '의무관리대상(국토부)', title: '국토교통부: 의무관리대상 공동주택 범위', url: 'https://www.molit.go.kr/USR/policyTarget/dtl.jsp?idx=405', date: '' },
  { short: '150세대 기준 기사', title: '기사: 소규모 공동주택, 체계적인 관리 받을 수 있는 길 열려(150세대 이상 승강기와 중앙난방)', url: 'https://www.sateconomy.co.kr/news/view/179590143590779', date: '' },
  { short: '대단지 1,000세대 기사', title: '데일리안: 올해 주목할만한 단지는 1천세대 이상 대단지', url: 'https://www.dailian.co.kr/news/view/967533/', date: '' },
];

/** 오늘(이 컴퓨터 날짜) YYYY-MM-DD */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 카드에 붙이는 토지거래허가, 실거주 표시. tone: ok 허가 필요 없음, warn 허가 받고 살아야 함, muted 모름.
 * 온비드는 재산 종류(apt.property)와 유찰 횟수로 정한다.
 */
export function liveChip(l: ListingView): { text: string; title: string; tone: 'ok' | 'warn' | 'muted' } | null {
  const kind = aptKindOf(l);
  if (kind === 'court') {
    return {
      text: '토허 예외',
      tone: 'ok',
      title: '법원경매는 토지거래허가를 받지 않아 허가에 따른 실거주 의무가 없습니다.\n잔금을 대출받으면 6개월 안에 전입해야 한다는 보도가 있고, 팔 때 비과세를 받으려면 2년 살아야 합니다.',
    };
  }
  if (kind === 'onbid') {
    const property = l.apt?.property ?? '';
    const failed = l.auction?.failed ?? 0;
    const note = '\n(변호사 칼럼 기준, 법령 원문은 확인하지 못함. 입찰 전에 구청에 확인)';
    if (/압류|국유|공유|유입/.test(property)) return { text: `토허 예외(${property})`, tone: 'ok', title: `${property}은 토지거래허가가 필요 없다는 해설입니다.${note}` };
    if (/수탁/.test(property)) {
      return failed >= 3
        ? { text: '토허 예외(수탁, 유찰 3회 이상)', tone: 'ok', title: `수탁재산이지만 ${failed}번 유찰돼 허가가 필요 없다는 해설입니다.${note}` }
        : { text: '토허 허가 필요(수탁재산)', tone: 'warn', title: `수탁재산은 3번 이상 유찰되기 전에는 허가가 필요하다는 해설입니다(지금 유찰 ${failed}회).${note}` };
    }
    return { text: '토허 확인 필요', tone: 'muted', title: `재산 종류${property ? `(${property})` : ''}로는 허가가 필요한지 정하지 못했습니다.${note}` };
  }
  if (kind === 'sale') {
    return today() > PERMIT_UNTIL
      ? { text: '토허 기간 확인', tone: 'muted', title: `서울 토지거래허가구역 지정 기간(${PERMIT_UNTIL}까지)이 지났습니다. 연장됐는지 확인하세요.` }
      : { text: '토허 허가, 2년 거주', tone: 'warn', title: `서울 전역 토지거래허가구역(${PERMIT_UNTIL}까지): 계약 전 허가, 허가받은 날부터 4개월 안 입주, 2년 거주.\n세입자가 사는 집은 입주 유예가 있을 수 있습니다(구청 확인).` };
  }
  return null;
}

/** 세대수를 찾아볼 주소: 네이버 매물은 그 단지 화면, 경매와 공매는 단지 이름이나 주소로 네이버 검색 */
export function householdLookupUrl(l: ListingView): string {
  if (l.source === 'naver' && l.apt?.complexKey.startsWith('nv:')) return l.url;
  return `https://search.naver.com/search.naver?query=${encodeURIComponent(`${l.apt?.complexName ?? l.address ?? ''} 세대수`)}`;
}
