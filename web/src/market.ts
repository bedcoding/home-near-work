import type { SupportSource } from './support';

// 시세 통계 탭(MarketView)의 글과 근거. 숫자는 서버가 KB 통계와 국토부 실거래로 만든다(server/market.ts).
// 고칠 때는 MARKET_CHECKED와 근거(sources)도 같이 고친다(서울 아파트 탭 apt.ts와 같은 방식).

/** 글과 근거를 확인한 날 */
export const MARKET_CHECKED = '2026-10-18';

/** 급지 다섯 묶음 이름(MarketTier.tier 1 ~ 5) */
export const TIER_NAMES = ['상급지', '중상급지', '중급지', '중하급지', '하급지'];

/** 원본을 직접 볼 곳 */
export const MARKET_LINKS: { label: string; url: string; title: string }[] = [
  { label: 'KB부동산 데이터허브', url: 'https://data.kbland.kr/', title: 'KB 주간·월간 아파트 시계열(이 탭 지수와 매수우위지수의 원본)' },
  { label: '한국부동산원 R-ONE', url: 'https://www.reb.or.kr/r-one/', title: '한국부동산원 주간 아파트 가격 동향(같은 주에도 KB와 숫자가 다를 수 있습니다)' },
  { label: '국토부 실거래가 공개시스템', url: 'https://rt.molit.go.kr/', title: '이 탭 거래량과 평당가의 원본' },
];

/** 읽는 법 한 줄 */
export interface MarketNote {
  id: string;
  text: string;
  sources: SupportSource[];
}

export const MARKET_NOTES: MarketNote[] = [
  {
    id: 'region',
    text: '전국 평균은 지역 차이를 덮습니다. 2025년 KB 기준 전국 아파트는 1.37% 올랐지만 서울은 11.19% 올랐고, 인천·5개 광역시·기타 지방은 내렸습니다. 서울에서 살 집이면 서울과 그 구를 보세요.',
    sources: [{ title: 'KB 연말결산: 키워드로 보는 2025 아파트 시장', url: 'https://kbthink.com/realestate/issue/hosing-251231.html', date: '2025-12-31' }],
  },
  {
    id: 'buyer',
    text: "매수우위지수는 KB가 묻는 중개업소 응답 중 '매수자 많음' 비율 − '매도자 많음' 비율 + 100입니다. 100보다 크면 사려는 쪽이, 작으면 팔려는 쪽이 많다는 뜻입니다.",
    sources: [{ title: 'PublicDataReader KB 통계 안내(예시 값 4.35, 56.52 → 47.83으로 계산을 맞춰 봄)', url: 'https://github.com/WooilJeong/PublicDataReader/blob/main/assets/docs/kbland/Kbland.md', date: '' }],
  },
  {
    id: 'volume',
    text: '거래량이 가격보다 먼저 움직인다는 말이 흔하지만 늘 맞지는 않습니다. 가격 방향, 매수우위지수와 같은 쪽을 가리키는지 함께 보세요.',
    sources: [{ title: 'KB 칼럼: 서울 아파트 연착륙, 거래량으로 확인될까?', url: 'https://kbthink.com/main/real-estate/realproperty-column/Mr-Heo/MrHeo-230426.html', date: '2023-04-26' }],
  },
  {
    id: 'report',
    text: '실거래는 계약한 날부터 30일 안에 신고하므로, 받은 날 기준 신고 기한이 안 지난 달은 거래가 덜 들어와 있습니다(그래프에 흐리게 그림).',
    sources: [{ title: '부동산 거래신고 등에 관한 법률 제3조 제1항', url: 'https://www.law.go.kr/법령/부동산거래신고등에관한법률/제3조', date: '' }],
  },
  {
    id: 'kb-reb',
    text: 'KB와 한국부동산원은 묻는 중개업소가 달라 같은 주에도 숫자가 다릅니다. 숫자보다 방향이 같은지를 보세요.',
    sources: [{ title: '한국경제: 기관마다 다른 매수우위지수, 어떻게 해석해야 할까', url: 'https://www.hankyung.com/amp/202104218935b', date: '2021-04-21' }],
  },
  {
    id: 'tier',
    text: '급지는 공식 분류가 아닙니다. 최근 1년 실거래의 전용면적 평당 중간값 순위로 25개 구를 다섯 묶음으로 고르게 나눴습니다. 거래된 집의 중간값이라 그해 어떤 단지가 많이 팔렸는지에 따라 흔들립니다.',
    sources: [],
  },
  {
    id: 'bottom',
    text: '바닥과 꼭대기는 지나고 나서야 알 수 있습니다. 이 탭은 지금 오르는지 내리는지를 보여 줄 뿐 앞으로를 알려 주지 않습니다.',
    sources: [],
  },
];

/** 그래프 선 색(전국, 서울, 그 밖의 선 차례) */
export const LINE_COLORS = { nation: '#8791a0', seoul: '#355f98', others: ['#b74757', '#227356', '#98602a', '#7a4fa3', '#1f8a9e', '#c48a0a', '#5b6b2f', '#a3477f'] };

/** 변동률 글자('+0.45%', '-15.8%', 모르면 '?'). 1%보다 작으면 소수 둘째 자리까지. */
export const pct = (x: number | null) => (x == null ? '?' : `${x > 0 ? '+' : ''}${x.toFixed(Math.abs(x) < 1 ? 2 : 1)}%`);

/** 두 수의 변동률(%, 모르면 null) */
export const changeOf = (now: number | null, before: number | null) => (now == null || !before ? null : Math.round((now / before - 1) * 1000) / 10);
