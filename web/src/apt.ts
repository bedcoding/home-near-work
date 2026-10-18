import type { ListingView } from '../../shared/types';
import type { SupportSource } from './support';

// 서울 아파트 탭(AptView): 회사와 멀어도 고른 서울 구의 아파트 경매(법원경매), 공매(온비드), 매매(네이버)를 모아 본다.
// 살 때 붙는 실거주·대출·양도세 조건은 모으는 데이터가 아니라 조사한 날 기준으로 손으로 정리했다.
// 고칠 때는 APT_CHECKED와 근거(sources)도 같이 고치고, 근거로 확인하지 못한 것은 그렇다고 적는다(지원 제도 탭과 같은 방식).

/** 조사한 날 */
export const APT_CHECKED = '2026-10-17';
/** 서울 전역 토지거래허가구역 지정 기간 끝(아파트). 이 날이 지나면 매매 표시를 '기간 확인'으로 바꾼다. */
export const PERMIT_UNTIL = '2026-12-31';

/** 탭 안 종류: 법원경매, 온비드 공매, 매매 매물 */
export type AptKind = 'court' | 'onbid' | 'sale';

export const APT_KINDS: { id: AptKind; name: string; title: string }[] = [
  { id: 'court', name: '경매', title: '법원경매 아파트. 토지거래허가를 받지 않습니다' },
  { id: 'onbid', name: '공매', title: '온비드 공매 아파트. 토지거래허가는 재산 종류에 따라 다릅니다' },
  { id: 'sale', name: '매매', title: '네이버 부동산에서 본 아파트 매매 매물(크롬 확장이 모음). 토지거래허가를 받아 2년 살아야 합니다' },
];

/** 매물이 탭의 어느 종류인지(경매·공매가 아니고 매매 가격도 없으면 null) */
export const aptKindOf = (l: Pick<ListingView, 'source' | 'prices'>): AptKind | null =>
  l.source === 'courtauction' ? 'court' : l.source === 'onbid' ? 'onbid' : l.prices.some((p) => p.deal === 'sale') ? 'sale' : null;

/** 가격 상한에 견주는 금액(만원): 경매·공매는 최저가, 매매는 매매가. 모르면 null. */
export function aptPrice(l: Pick<ListingView, 'source' | 'prices'>): number | null {
  const kind = aptKindOf(l);
  const p = kind === 'sale' ? l.prices.find((x) => x.deal === 'sale') : l.prices[0];
  return p?.price ?? null;
}

/** 세대수 최소·최대 고르기 칸의 값('없음'은 따로 둔다) */
export const HOUSEHOLD_STEPS = [100, 150, 200, 250, 300, 500, 700, 1000, 1500, 2000, 3000];

/**
 * 살 때 붙는 조건 한 줄. live: 실거주 조건(짧게), status: ok 법령이나 공식 자료·여러 보도로 확인,
 * news 보도로만 확인한 것이 섞임, check 해설만 보고 법령 원문은 확인하지 못함.
 */
export interface AptRule {
  id: AptKind | 'loan' | 'tax';
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

const TAX_RESIDENCE_URL =
  'https://casenote.kr/%EA%B5%AD%EC%84%B8%EC%B2%AD/%EC%84%9C%EB%A9%B4-2020-%EB%B2%95%EB%A0%B9%ED%95%B4%EC%84%9D%EC%9E%AC%EC%82%B0-4045-3b21fe';

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
      { title: '헤럴드경제: 서울·경기 37곳, 실거주 안 하면 집 못산다(10·15 대책)', url: 'https://www.heraldk.com/article/2025101417000026673', date: '2025-10-14' },
      { title: 'thecheck.co.kr: 10.15 부동산대책, 조정지역·투과지구 확대(허가 후 2년 실거주)', url: 'https://thecheck.co.kr/?p=1387', date: '' },
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
    text: '압류재산(세금 체납으로 압류된 것), 국유·공유재산, 유입자산은 허가가 필요 없고, 수탁재산(캠코에 매각을 맡긴 것)은 3번 이상 유찰된 뒤에 파는 것만 허가가 필요 없다는 해설입니다(시행령 제11조 제3항 제16호). 카드에는 온비드가 준 재산 종류로 표시합니다.',
    notes: ['변호사 칼럼 기준이고 법령 원문은 확인하지 못했습니다. 입찰 전에 구청에 확인하세요.'],
    status: 'check',
    sources: [
      {
        title: '이데일리 김용일의 부동산톡: 토지거래허가구역내 허가를 받지 않아도 되는 경우(경매·공매의 예외)',
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
      '한도는 시세 15억 이하 6억, 15억 넘고 25억 이하 4억, 25억 넘으면 2억입니다. 규제지역 LTV는 무주택자 40%(생애최초 70%)입니다(10·15 대책).',
      '전입한 뒤 얼마나 살아야 하는지는 확인하지 못했습니다(대출 약정서 확인).',
    ],
    status: 'news',
    sources: [
      { title: '파이낸셜뉴스: 6월 28일부터 6억 한도와 6개월 내 전입 규제', url: 'https://www.fnnews.com/news/202507041542469482', date: '2025-07-04' },
      { title: '비즈워치: 6억 한도·6개월 전입, 경락잔금대출에도 적용', url: 'https://news.bizwatch.co.kr/article/real_estate/2025/07/03/0040', date: '2025-07-03' },
      { title: '머니투데이방송: 25억 주택 주담대 최대 2억, 규제지역 LTV 40%(10·15 대책)', url: 'https://news.mtn.co.kr/news-detail/2025101507523614845', date: '2025-10-15' },
    ],
  },
  {
    id: 'tax',
    name: '팔 때 양도세 비과세(1세대 1주택)',
    live: '2년 보유, 2년 거주',
    text: '2년 넘게 갖고 있어야 하고, 산 날 그 집이 조정대상지역이었으면 갖고 있는 동안 2년을 살아야 합니다. 서울은 2025.10.16부터 전역이 조정대상지역이라, 그 뒤에 산 집은 경매로 샀어도 2년 거주가 필요합니다. 나중에 지정이 풀려도 산 날 기준으로 봅니다.',
    notes: ['파는 값이 12억을 넘으면 넘는 부분 비율만큼은 세금을 냅니다(고가주택, 세무 자료 기준).'],
    status: 'ok',
    sources: [
      { title: '국세청 해석(casenote): 주택 취득일에 조정대상지역 해제 시 1세대1주택 비과세 거주요건 적용 여부', url: TAX_RESIDENCE_URL, date: '2020' },
      { title: 'thecheck.co.kr: 10월 16일 자로 서울 전역 조정대상지역·투기과열지구 지정', url: 'https://thecheck.co.kr/?p=1387', date: '' },
      { title: '세무 자료(watax.kr): 고가주택(12억 초과) 양도세 계산', url: 'https://www.watax.kr/transfer-tax/high-priced-house', date: '' },
    ],
  },
];

/** 세대수 칸 아래 설명과 근거(short는 링크 글자). 참고로 법에 있는 선(의무관리대상)과 대단지 기준을 같이 적는다. */
export const HOUSEHOLD_NOTE =
  "세대수는 경매·공매·네이버 목록에 없어서, 경매·공매는 건축물대장에서 채우고(공공데이터포털 키가 있을 때) 나머지는 카드의 '세대수 넣기'로 단지마다 한 번 넣습니다. 참고로 법에 있는 선은 의무관리대상(300세대 이상, 또는 150세대 이상이면서 승강기나 중앙·지역난방)이고, 대단지는 보통 1,000세대 이상을 말합니다.";
export const HOUSEHOLD_SOURCES: (SupportSource & { short: string })[] = [
  { short: '의무관리대상(국토부)', title: '국토교통부: 의무관리대상 공동주택 범위', url: 'https://www.molit.go.kr/USR/policyTarget/dtl.jsp?idx=405', date: '' },
  { short: '150세대 기준 기사', title: '기사: 소규모 공동주택, 체계적인 관리 받을 수 있는 길 열려(150세대 이상 승강기·중앙난방)', url: 'https://www.sateconomy.co.kr/news/view/179590143590779', date: '' },
  { short: '대단지 1,000세대 기사', title: '데일리안: 올해 주목할만한 단지는 1천세대 이상 대단지', url: 'https://www.dailian.co.kr/news/view/967533/', date: '' },
];

/** 오늘(이 컴퓨터 날짜) YYYY-MM-DD */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 카드에 붙이는 토지거래허가·실거주 표시. tone: ok 허가 필요 없음, warn 허가 받고 살아야 함, muted 모름.
 * 온비드는 재산 종류(apt.property)와 유찰 횟수로 정한다(해설 기준, 법령 원문 미확인).
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
      : { text: '토허 허가·2년 거주', tone: 'warn', title: `서울 전역 토지거래허가구역(${PERMIT_UNTIL}까지): 계약 전 허가, 허가받은 날부터 4개월 안 입주, 2년 거주.\n세입자가 사는 집은 입주 유예가 있을 수 있습니다(구청 확인).` };
  }
  return null;
}

/** 세대수를 찾아볼 주소: 네이버 매물은 그 단지 화면, 경매·공매는 단지 이름이나 주소로 네이버 검색 */
export function householdLookupUrl(l: ListingView): string {
  if (l.source === 'naver' && l.apt?.complexKey.startsWith('nv:')) return l.url;
  return `https://search.naver.com/search.naver?query=${encodeURIComponent(`${l.apt?.complexName ?? l.address ?? ''} 세대수`)}`;
}
