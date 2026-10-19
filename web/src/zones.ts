import type { LandZone, ListingView, PlotZone, RedevHit } from '../../shared/types';
import type { SupportSource } from './support';

// 재개발 구역 경고(ZoneBanner): 서버가 브이월드 토지이용계획으로 본 구역(PlotZone)을 카드 위 띠나 작은 표시로 보인다.
// 집터(단독주택, 토지), 경매, 서울 아파트, 관심과 숨김함 탭과 상세 칸에 쓴다. 구역 안이면 입주권 없이 현금으로 보상받게
// (현금청산) 되는 경우와 새로 짓기 제한을 적고, 아파트에는 아파트에 맞는 조건만 보인다.
// 고칠 때는 ZONE_CHECKED와 근거(sources)도 같이 고친다.

/** 법령 원문을 확인한 날 */
export const ZONE_CHECKED = '2026-10-19';

const LAW = 'https://www.law.go.kr/법령';
const SEOUL_ORDINANCE = 'https://www.law.go.kr/자치법규/서울특별시도시및주거환경정비조례';

/** 직접 확인할 곳(구역 이름으로 사업 단계와 권리산정기준일, 지번으로 법적 효력이 있는 토지이용계획) */
export const ZONE_LINKS: { label: string; url: string; title: string }[] = [
  { label: '정비사업 정보몽땅', url: 'https://cleanup.seoul.go.kr/', title: '서울시 정비사업 정보몽땅: 구역의 사업 단계(조합설립인가, 관리처분인가 등)와 고시를 찾아봅니다' },
  { label: '토지이음', url: 'https://www.eum.go.kr/', title: '토지이음: 지번으로 토지이용계획을 봅니다(법적 효력이 있는 확인은 토지이용계획확인서)' },
];

/** 구역 안일 때 펼쳐 보이는 조건 한 줄. kinds: 이 조건이 붙는 구역 갈래, forms: 이 조건이 붙는 물건 갈래(없으면 모두) */
export interface ZoneRule {
  id: string;
  /** 물딱지 정리 칸의 줄 이름 */
  name: string;
  kinds: LandZone['kind'][];
  forms?: PlotZone['form'][];
  text: string;
  sources: SupportSource[];
  /** false면 구역 경고 띠에는 넣지 않고 물딱지 정리 칸에만 보인다 */
  banner?: false;
}

/** 땅이나 단독, 다가구에만 해당하는 조건(땅만 가진 경우, 새로 짓기, 건축허가 제한) */
const HOUSE_OR_LAND: PlotZone['form'][] = ['house', 'land'];
/** 지분 쪼개기는 빌라에도 해당한다(기준일 뒤에 지은 다세대) */
const SPLIT_FORMS: PlotZone['form'][] = ['house', 'land', 'villa'];

export const ZONE_RULES: ZoneRule[] = [
  {
    id: 'transfer',
    name: '언제 사면 조합원이 못 되나',
    kinds: ['redev'],
    text: '서울은 전역이 투기과열지구라, 재건축은 조합설립인가 뒤에, 재개발은 관리처분계획인가 뒤에 산 사람은 조합원이 못 되고 현금으로 보상받습니다(현금청산). 재개발은 2018-01-25 이후 처음 사업시행인가를 신청한 구역만 해당합니다. 이 구역이 어느 단계인지 먼저 확인하세요.',
    sources: [
      { title: '도시 및 주거환경정비법 제39조 제2항, 제3항', url: `${LAW}/도시및주거환경정비법/제39조`, date: '' },
      { title: '법제처 해석 19-0079(법률 제14943호 부칙 제2조 적용례, 네플라 전재)', url: 'https://www.nepla.ai/wiki/국토와-건설-부동산/재개발-재건축/-유권해석-도시-및-주거환경정비법-부칙-법률-제14943호-2017-10-24-제2조-주택재개발사업-도시환경정비사업의-조합원-자격-취득-제한에-관한-적용례/-법제처-유권해석-투기과열지구로-지정된-재개발사업구역에서-토지등을-양수한-자의-조합원-자격-취득-관련-구-도시-및-주거환경정비법-부칙-제2조-등-관련-3wo9q43608lp', date: '2019-06-05' },
      { title: '정책브리핑: 10.15 대책 문답(규제지역 조합원 지위양도)', url: 'https://www.korea.kr/news/policyNewsView.do?newsId=148950973', date: '2025-10-15' },
    ],
  },
  {
    id: 'transfer-exception',
    name: '판 사람 조건 예외',
    kinds: ['redev'],
    text: '판 사람 조건에 따라 그 뒤에 사도 조합원이 될 수 있습니다(확정 아님, 판 사람 서류로 조합과 구청에 확인). 판 사람이 1세대 1주택으로 10년 갖고 5년 산 집, 판 사람 세대가 모두 근무나 1년 이상 치료나 취학이나 결혼으로 서울 밖으로 이사했거나 상속받은 집으로 이사했거나 해외로 이주한 경우, 국가, 지자체, 금융기관 빚을 못 갚아 나온 경매나 공매, 사업이 3년 넘게 늦어진 구역에서 3년 넘게 가진 사람이 판 경우, 투기과열지구 지정 전에 계약하고 60일 안에 신고한 경우입니다. 다른 빚 때문에 나온 경매는 경매라는 것만으로는 예외가 아닙니다.',
    sources: [
      { title: '도시 및 주거환경정비법 제39조 제2항 단서', url: `${LAW}/도시및주거환경정비법/제39조`, date: '' },
      { title: '도시 및 주거환경정비법 시행령 제37조 제1항, 제3항', url: `${LAW}/도시및주거환경정비법시행령/제37조`, date: '' },
    ],
  },
  {
    id: 'share-exception',
    name: '공유 주택의 예외',
    kinds: ['redev', 'small'],
    text: '여럿이 같이 가진 집은 위 예외를 공유자마다 따로 봅니다. 요건을 못 채운 공유자 지분만큼은 조합원 지위가 넘어오지 않습니다.',
    sources: [
      { title: '파이낸셜뉴스: 대법원 2022다228230 판결(2025-08-14)과 국토부 해석 변경', url: 'https://www.fnnews.com/news/202511191820230566', date: '2025-11-19' },
      { title: '파이낸셜뉴스: 양도시점 혼란, 강남 재건축 매수자 수백명 반쪽 조합원', url: 'https://www.fnnews.com/news/202607061055365771', date: '2026-07-09' },
    ],
  },
  {
    id: 'apply',
    name: '분양신청을 안 하면',
    kinds: ['redev', 'small'],
    text: '분양신청 기간(통지일부터 30일 이상 60일 이내, 20일 한 번 연장)에 신청하지 않거나 철회하면 새 집 대신 현금청산됩니다.',
    sources: [
      { title: '도시 및 주거환경정비법 제72조 제2항, 제73조 제1항', url: `${LAW}/도시및주거환경정비법/제73조`, date: '' },
    ],
  },
  {
    id: 'rebuild-owner',
    name: '재건축은 건물과 땅 함께',
    forms: ['land'],
    kinds: ['redev'],
    text: '재건축은 건물과 그 땅을 함께 가진 사람만 조합원입니다. 땅만이나 건물만 가지면 조합원이 못 되고 매도청구 대상입니다(재개발은 땅이나 건물 하나만 가져도 토지등소유자).',
    sources: [
      { title: '도시 및 주거환경정비법 제2조 제9호', url: `${LAW}/도시및주거환경정비법/제2조`, date: '' },
      { title: '같은 법 제64조 제4항', url: `${LAW}/도시및주거환경정비법/제64조`, date: '' },
    ],
  },
  {
    id: 'split',
    name: '권리산정기준일 뒤 쪼개기',
    forms: SPLIT_FORMS,
    kinds: ['redev'],
    text: '권리산정기준일 뒤에 땅을 나누거나, 단독이나 다가구를 다세대로 바꾸거나, 헐고 다세대를 지어 주인이 늘었으면 그 여러 명이 1명분만 받습니다. 기준일은 구역 지정 전에 따로 정해지기도 합니다.',
    sources: [
      { title: '도시 및 주거환경정비법 제77조', url: `${LAW}/도시및주거환경정비법/제77조`, date: '' },
      { title: '서울특별시 도시 및 주거환경정비 조례 제36조 제2항', url: SEOUL_ORDINANCE, date: '2026-05-18' },
    ],
  },
  {
    id: 'share',
    name: '공유와 지분',
    kinds: ['redev', 'small'],
    text: '여러 명이 같이 가진 집이나 땅(지분)은 합쳐서 1명분입니다. 지분 경매로 사면 다른 공유자와 1명분을 나눕니다. 재개발은 권리산정기준일 전부터 같이 가졌고 내 지분 땅이 90㎡ 이상(또는 권리가액이 가장 작은 분양 주택 값 이상)이면 따로 분양 대상이 될 수 있습니다.',
    sources: [
      { title: '도시 및 주거환경정비법 제39조 제1항 제1호', url: `${LAW}/도시및주거환경정비법/제39조`, date: '' },
      { title: '빈집 및 소규모주택 정비에 관한 특례법 제24조 제1항 제1호', url: `${LAW}/빈집및소규모주택정비에관한특례법/제24조`, date: '' },
      { title: '서울특별시 도시 및 주거환경정비 조례 제36조 제2항 제3호', url: SEOUL_ORDINANCE, date: '2026-05-18' },
    ],
  },
  {
    id: 'land',
    name: '재개발에서 땅만 가지면',
    forms: HOUSE_OR_LAND,
    kinds: ['redev'],
    text: '집 없이 땅만 가지면 재개발 분양 대상이 되려면 땅이 90㎡ 이상이거나 권리가액이 가장 작은 분양 주택 1채 값 이상이어야 합니다. 작은 땅이나 도로 지분은 현금청산될 수 있습니다.',
    sources: [{ title: '서울특별시 도시 및 주거환경정비 조례 제36조 제1항', url: SEOUL_ORDINANCE, date: '2026-05-18' }],
  },
  {
    id: 'unlicensed',
    name: '무허가 건물',
    forms: HOUSE_OR_LAND,
    kinds: ['redev'],
    text: '무허가 건물은 1989-01-24 당시 있던 것(특정무허가건축물) 중 주거용만 서울 재개발에서 주택으로 칩니다. 그 뒤에 생긴 무허가 건물은 분양 대상 주택이 아닙니다.',
    sources: [{ title: '서울특별시 도시 및 주거환경정비 조례 제2조 제1호, 제36조 제1항 제1호', url: SEOUL_ORDINANCE, date: '2026-05-18' }],
  },
  {
    id: 'shop',
    name: '상가',
    kinds: ['redev'],
    banner: false,
    text: '상가는 서울 재개발에서 권리가액이 가장 작은 분양 주택 값 이상이어야 아파트를 받습니다. 재건축은 원칙적으로 상가를 받고, 아파트는 새 상가를 짓지 않는 경우 등 조건을 채울 때만 받습니다.',
    sources: [
      { title: '도시 및 주거환경정비법 시행령 제63조 제1항, 제2항', url: `${LAW}/도시및주거환경정비법시행령/제63조`, date: '' },
      { title: '서울특별시 도시 및 주거환경정비 조례 제36조 제1항 제3호', url: SEOUL_ORDINANCE, date: '2026-05-18' },
    ],
  },
  {
    id: 'build',
    name: '새로 짓기 허가',
    forms: HOUSE_OR_LAND,
    kinds: ['redev'],
    text: '정비구역 안에서 집을 새로 지으려면 구청장 허가가 필요합니다. 공장에서 만든 모듈러 주택도 땅에 놓으면 건축물입니다.',
    sources: [
      { title: '도시 및 주거환경정비법 제19조 제1항', url: `${LAW}/도시및주거환경정비법/제19조`, date: '' },
      { title: '건축법 제2조 제1항 제2호(건축물)', url: `${LAW}/건축법/제2조`, date: '' },
    ],
  },
  {
    id: 'small',
    name: '모아타운과 가로주택',
    kinds: ['small'],
    text: '모아타운(가로주택정비, 소규모재건축, 소규모재개발)은 조합설립인가 뒤에 사면 조합원이 못 됩니다. 예외는 판 사람이 1세대 1주택으로 5년 갖고 3년 산 집, 판 사람 세대가 모두 근무나 치료 등으로 서울 밖으로 이사한 경우, 금융기관 빚을 못 갚아 나온 경매와 공매 등입니다.',
    sources: [
      { title: '빈집 및 소규모주택 정비에 관한 특례법 제24조 제2항, 제3항', url: `${LAW}/빈집및소규모주택정비에관한특례법/제24조`, date: '' },
      { title: '같은 법 시행령 제22조 제1항, 제3항 제4호', url: `${LAW}/빈집및소규모주택정비에관한특례법시행령/제22조`, date: '2026-09-18' },
    ],
  },
  {
    id: 'limit',
    name: '건축허가 제한',
    forms: HOUSE_OR_LAND,
    kinds: ['limit'],
    text: '건축허가와 착공 제한: 새로 짓는 것을 막아 둔 곳입니다(2년 이내, 한 번 1년까지 연장). 서울시는 신속통합기획 재개발 후보지를 고를 때 토지거래허가구역과 함께 이 제한을 겁니다. 헐고 새로 짓기(모듈러 포함)는 풀릴 때까지 어렵습니다.',
    sources: [
      { title: '건축법 제18조', url: `${LAW}/건축법/제18조`, date: '' },
      { title: 'MTN: 구의, 신길, 갈현 신통기획 후보지…2년 내 정비구역 지정(토지거래허가구역 지정과 건축허가 제한)', url: 'https://news.mtn.co.kr/news-detail/2026073017530598598', date: '2026-07-30' },
    ],
  },
  {
    id: 'rebuy',
    name: '5년 재당첨 제한',
    kinds: ['redev'],
    text: '투기과열지구에서 5년 안에 다른 정비사업 분양 대상이 된 세대는 분양신청을 못 합니다.',
    sources: [{ title: '도시 및 주거환경정비법 제72조 제6항', url: `${LAW}/도시및주거환경정비법/제72조`, date: '' }],
  },
];

/** 카드에 보일 모양: banner면 경고 띠(danger 물딱지 주의, warn 새로 짓기 제한), 아니면 작은 표시(tone muted) */
export interface ZoneView {
  banner: boolean;
  tone: 'danger' | 'warn' | 'muted';
  label: string;
  /** 띠 안에 보일 걸린 구역(이름표와 마우스 설명) */
  zones: { text: string; title: string }[];
  /** 띠 둘째 줄 */
  summary: string;
  /** 펼치면 보일 조건 */
  rules: ZoneRule[];
  /** 작은 표시의 마우스 설명 */
  title: string;
  /** 필지 번호, 조회한 날(띠 아래 확인할 곳 줄) */
  pnu: string | null;
  checkedAt: string | null;
  /** 네이버 단지 좌표로 찾은 필지면 그 설명(띠 아래 근거 줄) */
  basis: string | null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
const muted = (label: string, title: string, pnu: string | null = null, checkedAt: string | null = null): ZoneView => ({
  banner: false, tone: 'muted', label, zones: [], summary: '', rules: [], title, pnu, checkedAt, basis: null,
});
/** 네이버 단지 좌표로 찾은 필지 설명 */
const pointBasis = (zone: PlotZone) =>
  zone.basis === 'point' ? `네이버 단지 좌표로 찾은 필지 ${zone.parcel ?? zone.pnu ?? ''}`.trim() : null;
const zoneText = (z: LandZone) => `${z.name}${z.overlap === '저촉' ? ' 일부 걸침' : z.overlap === '접함' ? ' 경계' : ' 안'}`;
const zoneTitle = (z: LandZone) =>
  [
    `${z.name}: 필지가 구역에 '${z.overlap}'`,
    z.notice ? `관리번호의 고시나 공고 번호 ${z.notice}${z.org ? `(${z.org})` : ''}` : '',
  ].filter(Boolean).join('\n');

/**
 * 물건의 구역 표시. zone이 없으면 표시하지 않고(null), 집터 탭 매매 매물(sale)은 지번이 없어 확인하지 못했다고 보인다.
 * keySet: 브이월드 키를 넣어 두었는지(아직 안 본 물건의 설명에 씀).
 */
export function zoneView(zone: PlotZone | null | undefined, keySet: boolean, sale = false): ZoneView | null {
  if (!zone) {
    return sale ? muted('구역 확인 못 함', '매매 매물은 주소에 지번이 없어 재개발 구역을 확인하지 못합니다. 토지이음이나 정비사업 정보몽땅에서 위치로 확인하세요.') : null;
  }
  if (!zone.lot || (!zone.pnu && zone.why)) return muted('구역 확인 못 함', `${zone.why ?? '지번을 못 정함'}. 토지이음에서 지번으로 확인하세요.`);
  const c = zone.check;
  if (!c) {
    const later = zone.basis === 'point' ? '네이버 단지 좌표로 필지를 찾아 ' : '';
    return keySet
      ? muted('구역 확인 전', `다음 '경매 조회하기'나 '재개발 구역 확인' 때 ${later}브이월드 토지이용계획으로 봅니다.`, zone.pnu)
      : muted('구역 확인 안 함', '브이월드 인증키가 없어 재개발 구역을 확인하지 않았습니다. config/local.json에 vworldKey를 넣으세요(README의 집터 탭).', zone.pnu);
  }
  if (c.status === 'error') return muted('구역 확인 실패', `${c.error ?? '조회 실패'}\n다음 조회 때 다시 봅니다.`, zone.pnu, c.checkedAt);
  if (c.status === 'empty') {
    return muted(
      '구역 확인 못 함',
      `토지이용계획 응답이 비어 있습니다(${day(c.checkedAt)} 조회). 구역이 없다는 뜻이 아닙니다(필지가 합쳐졌거나 지번이 다를 수 있음). 토지이음에서 지번으로 보세요.`,
      zone.pnu, c.checkedAt,
    );
  }
  const inside = c.zones.filter((z) => z.overlap !== '접함');
  const basisLine = pointBasis(zone);
  if (!inside.length) {
    if (c.zones.length) {
      const names = [...new Set(c.zones.map((z) => z.name))].join(', ');
      return muted('구역 경계에 붙음', [`${names}의 경계에 붙어 있고 구역 안은 아닙니다(${day(c.checkedAt)} 조회).`, ...c.zones.map(zoneTitle), basisLine ?? ''].filter(Boolean).join('\n'), zone.pnu, c.checkedAt);
    }
    return muted(
      '재개발 구역 없음',
      [
        `토지이용계획(${day(c.checkedAt)} 조회)에 정비구역, 재개발, 재정비촉진, 소규모주택정비(모아타운), 건축허가 제한이 없습니다.`,
        '후보지 신청 단계나 아직 고시되지 않은 권리산정기준일은 여기에 나오지 않습니다.',
        basisLine ?? '',
      ].filter(Boolean).join('\n'),
      zone.pnu, c.checkedAt,
    );
  }
  const kinds = new Set(inside.map((z) => z.kind));
  const danger = kinds.has('redev') || kinds.has('small');
  const apt = zone.form === 'apt';
  // 아파트와 빌라는 지어진 집을 사는 것이라 건축허가 제한만 걸렸으면 띠 대신 작은 표시로 둔다(재개발 후보지일 수 있음).
  if ((apt || zone.form === 'villa') && !danger) {
    return muted('건축허가 제한 구역', `${inside.map(zoneText).join(', ')}(${day(c.checkedAt)} 조회). 새로 짓기를 막아 둔 곳으로, 재개발 후보지일 수 있습니다. 지어진 집을 사는 데 붙는 조건은 아닙니다.`, zone.pnu, c.checkedAt);
  }
  return {
    banner: true,
    tone: danger ? 'danger' : 'warn',
    label: danger ? '물딱지 주의' : '새로 짓기 제한',
    zones: c.zones.map((z) => ({ text: zoneText(z), title: zoneTitle(z) })),
    summary: !danger
      ? '헐고 새로 짓기(모듈러 포함)가 막혀 있을 수 있습니다. 재개발 후보지일 수 있습니다.'
      : apt
        ? '재건축과 재개발 구역 안 아파트는 사는 때(재건축 조합설립인가 뒤, 재개발 관리처분인가 뒤)에 따라 조합원이 못 되고 현금으로 보상받을 수 있습니다(현금청산). 펼쳐서 조건을 확인하세요.'
        : '사는 때와 물건에 따라 입주권 없이 현금으로 보상받을 수 있습니다(현금청산). 펼쳐서 조건을 확인하세요.',
    rules: ZONE_RULES.filter((r) => r.banner !== false && r.kinds.some((k) => kinds.has(k)) && (!r.forms || r.forms.includes(zone.form))),
    title: '',
    pnu: zone.pnu,
    checkedAt: c.checkedAt,
    basis: pointBasis(zone),
  };
}

// 물딱지 표시(ListingCard): 사는 매물(매매, 경매, 공매)의 좌표가 든 정비사업 구역(서울플랜+ 파일)의 사업 종류와 단계로
// 지금 사면 조합원이 못 되는지 본다. 브이월드 키 없이 쓴다. 판 사람 조건으로 풀리는 예외는 툴팁 아래에 따로 적는다.

/** 서울플랜+ 추진 단계 이름의 차례: 0 계획, 1 구역 지정, 2 추진위, 3 조합설립인가, 4 건축심의, 5 사업시행인가, 6 관리처분계획인가, 7 착공 */
const STAGE_RANK: Record<string, number> = {
  '대상지선정(추진중)': 0, 대상지선정: 0, '대상지 선정': 0, 후보지선정: 0, 예정지구지정: 0, '수립범위 자문': 0, 사전자문: 0, 사전검토: 0,
  기획완료: 0, 보류: 0, 정비계획수립: 0, '촉진계획수립(변경)': 0, 입안제안: 0, 열람공고: 0, 위원회심의: 0, '주민합의체 구성': 0,
  관리지역고시: 0, '통심위 사전자문': 0,
  구역지정: 1, 구역변경: 1, 지구지정: 1, 지구변경: 1,
  추진위구성: 2, 조합설립추진중: 2, '조합설립인가 추진중(연번부여)': 2,
  조합설립인가: 3,
  건축심의: 4, '건축심의/통합심의': 4,
  사업시행인가: 5, 사업시행계획인가: 5, 사업계획승인: 5, '지구계획승인(변경)': 5,
  관리처분계획인가: 6,
  착공: 7, '준공(일부)': 7,
};
const rankOf = (stage: string | null) => (stage != null && stage in STAGE_RANK ? STAGE_RANK[stage] : -1);

/**
 * 구역의 갈래: rebuild 재건축, redev 재개발, small 가로주택과 소규모 재건축, 재개발, promo 재정비촉진구역(재개발인지 재건축인지 모름),
 * plan 신속통합기획, moa 모아타운, other 그 밖의 사업(주거환경개선, 자율주택, 공공주택), skip 표시 안 함(재정비촉진지구, 존치관리구역)
 */
type HitKind = 'rebuild' | 'redev' | 'small' | 'promo' | 'plan' | 'moa' | 'other' | 'skip';
function kindOfHit(h: RedevHit): HitKind {
  if (/^재건축/.test(h.type)) return 'rebuild';
  if (/^재개발/.test(h.type)) return 'redev';
  if (/가로주택|소규모재건축|소규모재개발/.test(h.type)) return 'small';
  if (/재정비촉진구역|존치정비구역/.test(h.type)) return 'promo';
  if (h.type === '신속통합기획') return /재건축/.test(h.name) ? 'rebuild' : /재개발/.test(h.name) ? 'redev' : 'plan';
  if (h.type === '모아타운') return 'moa';
  if (/재정비촉진지구|존치관리구역/.test(h.type)) return 'skip';
  return 'other';
}

/** 지금 사면: locked 조합원이 못 됨, maybe 사업 종류에 따라 못 될 수 있음, open 아직 됨(또는 조합원 규칙이 다른 사업) */
type HitState = 'locked' | 'maybe' | 'open';
function stateOfHit(h: RedevHit, kind: HitKind): HitState {
  const rank = rankOf(h.stage);
  // 신속통합기획의 기획 단계(대상지선정, 기획완료, 구역지정 등)는 조합설립이나 관리처분 단계를 알려 주지 않는다.
  if (h.type === '신속통합기획' && rank <= 1) return 'open';
  if (kind === 'rebuild' || kind === 'small') return rank >= 3 ? 'locked' : 'open';
  if (kind === 'redev') return rank >= 6 ? 'locked' : 'open';
  if (kind === 'promo') return rank >= 6 ? 'locked' : rank >= 3 ? 'maybe' : 'open';
  return 'open';
}

/** 칩 이름에 쓰는 구역 갈래 이름 */
const KIND_NAME: Record<Exclude<HitKind, 'skip'>, string> = {
  rebuild: '재건축 구역',
  redev: '재개발 구역',
  small: '소규모 정비',
  promo: '재정비촉진구역',
  plan: '신통기획',
  moa: '모아타운',
  other: '정비사업 구역',
};

/** 지금 사면 조합원이 못 되는 까닭(갈래마다) */
const LOCKED_LINE: Record<'rebuild' | 'redev' | 'small' | 'promo', string> = {
  rebuild: '재건축은 조합설립인가 뒤에 산 사람은 조합원이 못 되고 현금청산됩니다(서울 전역 투기과열지구, 도시정비법 제39조 제2항).',
  redev:
    '재개발은 관리처분계획인가 뒤에 산 사람은 조합원이 못 되고 현금청산됩니다(도시정비법 제39조 제2항). 2018-01-25 이후 처음 사업시행인가를 신청한 구역만 해당하고, 그 전에 신청한 구역이면 조합원이 될 수 있습니다(법률 제14943호 부칙, 법제처 해석 19-0079). 신청일은 조합이나 구청에 확인하세요.',
  small: '가로주택, 소규모재건축, 소규모재개발은 조합설립인가 뒤에 산 사람은 조합원이 못 되고 현금청산됩니다(빈집 및 소규모주택 정비에 관한 특례법 제24조 제2항).',
  promo: '재정비촉진구역은 이 파일로 재개발인지 재건축인지 알 수 없습니다. 재건축이면 조합설립인가 뒤, 재개발이면 관리처분계획인가 뒤에 산 사람이 조합원이 못 됩니다.',
};

/** 아직 조합원이 될 수 있는 단계일 때 덧붙이는 말(갈래마다) */
const OPEN_LINE: Partial<Record<HitKind, string>> = {
  rebuild: '지금 단계에서는 조합원이 될 수 있습니다. 조합설립인가가 나면 그 뒤에 산 사람은 조합원이 못 됩니다.',
  redev: '지금 단계에서는 조합원이 될 수 있습니다. 관리처분계획인가가 나면 그 뒤에 산 사람은 조합원이 못 됩니다(2018-01-25 이후 처음 사업시행인가를 신청한 구역).',
  small: '지금 단계에서는 조합원이 될 수 있습니다. 조합설립인가가 나면 그 뒤에 산 사람은 조합원이 못 됩니다.',
  promo: '지금 단계에서는 조합원이 될 수 있습니다. 재건축이면 조합설립인가, 재개발이면 관리처분계획인가가 나면 그 뒤에 산 사람은 조합원이 못 됩니다.',
  plan: '신속통합기획 단계로는 조합설립인가나 관리처분계획인가가 났는지 알 수 없습니다. 재건축이면 조합설립인가 뒤, 재개발이면 관리처분계획인가 뒤에 사면 조합원이 못 되니 정비사업 정보몽땅이나 구청에서 단계를 확인하세요.',
  moa: '모아타운 안의 가로주택이나 소규모재건축 사업이 조합설립인가를 받으면 그 뒤에 산 사람은 조합원이 못 됩니다.',
  other: '조합이 아닌 공공이나 주민합의체가 하는 사업이라 조합원 규칙이 다릅니다. 새 집을 받을 수 있는지는 구청이나 시행자에게 확인하세요.',
};

/** 판 사람 조건으로 산 사람도 조합원이 되는 예외(도시정비법 제39조 제2항 단서, 시행령 제37조) */
const SELLER_LINES = [
  '판 사람이 1세대 1주택으로 10년 갖고 5년 산 집(배우자나 직계존비속이 산 기간도 합산)',
  '판 사람 세대가 모두 근무, 생업, 1년 이상 치료, 취학, 결혼으로 서울 밖 다른 시나 군으로 이사했거나, 상속받은 집으로 모두 이사했거나, 모두 해외로 이주하거나 2년 이상 나가 있는 경우',
  '국가, 지자체, 금융기관 빚을 못 갚아 나온 경매나 공매',
  '사업이 늦어진 경우: 재건축 조합설립 뒤 3년 넘게 사업시행인가 신청이 없거나 사업시행인가 뒤 3년 안에 착공을 못 했을 때 3년 넘게 가진 사람이 판 집, 착공 뒤 3년 넘게 준공이 안 된 구역에서 3년 넘게 가진 땅',
  '투기과열지구 지정 전에 계약하고 지정일부터 60일 안에 신고한 경우',
  '공유 주택은 공유자마다 따로 봅니다(대법원 2022다228230 판결, 2025-08-14).',
];
/** 소규모주택정비의 예외(빈집법 제24조 제2항 단서, 시행령 제22조) */
const SMALL_SELLER_LINES = [
  '판 사람이 1세대 1주택으로 5년 갖고 3년 산 집',
  SELLER_LINES[1],
  '금융기관 빚을 못 갚아 나온 경매나 공매',
];
const CHECK_LINE =
  '확인: 판 사람에게 등기부, 주민등록초본, 세대의 주택 수 서류를 받아 조합 사무실과 구청에 서면으로 묻고, 계약서에 조합원이 못 되면 해제하는 특약을 넣으세요. 경매는 법원 사건의 경매 신청 채권자를 보고 조합이나 구청에 물어보세요.';

export interface RedevChip {
  tone: 'danger' | 'warn' | 'muted';
  label: string;
  tip: string;
}

/**
 * 매물의 물딱지 표시. 구역 밖이면 null. land: 땅만 파는 물건(재건축은 건물과 땅을 함께 가져야 조합원).
 * danger 물딱지 주의(지금 사면 조합원이 못 됨), warn 물딱지 확인(사업 종류에 따라 못 될 수 있음), muted 구역 안(아직 됨).
 */
export function redevChip(listing: Pick<ListingView, 'redev'>, land = false): RedevChip | null {
  const r = listing.redev;
  if (!r) return null;
  const order = (k: HitKind) => ['rebuild', 'redev', 'small', 'promo', 'other', 'plan', 'moa'].indexOf(k);
  // 같은 곳에 사업 구역(재건축, 재개발 등)이 따로 있으면 신속통합기획과 모아타운 같은 넓은 구역은 뒤로 둔다.
  const hits = r.hits
    .map((h) => ({ h, kind: kindOfHit(h) }))
    .filter((x) => x.kind !== 'skip')
    .map((x) => ({ ...x, state: stateOfHit(x.h, x.kind) }))
    .sort((a, b) => order(a.kind) - order(b.kind) || rankOf(b.h.stage) - rankOf(a.h.stage));
  if (!hits.length) return null;
  const locked = hits.filter((x) => x.state === 'locked');
  const maybe = hits.filter((x) => x.state === 'maybe');
  const tone: RedevChip['tone'] = locked.length ? 'danger' : maybe.length ? 'warn' : 'muted';
  const label = locked.length ? '물딱지 주의' : maybe.length ? '물딱지 확인' : KIND_NAME[hits[0].kind as Exclude<HitKind, 'skip'>];

  const lines = hits.map(({ h }) => `${h.name}: ${h.type}, ${h.stage ?? '단계 모름'}${h.edge ? ', 구역 경계 25m 안' : ''}`);
  lines.push('');
  const reasons = [...locked, ...maybe].map((x) => LOCKED_LINE[x.kind as keyof typeof LOCKED_LINE]).filter(Boolean);
  if (reasons.length) lines.push(...new Set(reasons));
  else if (OPEN_LINE[hits[0].kind]) lines.push(OPEN_LINE[hits[0].kind]!);
  if (land && hits.some((x) => x.kind === 'rebuild' || x.kind === 'promo')) {
    lines.push('재건축은 건물과 그 땅을 함께 가진 사람만 조합원입니다. 땅만 사면 조합원이 못 되고 매도청구 대상입니다(도시정비법 제2조 제9호 나목, 제64조 제4항).');
  }
  if (reasons.length) {
    const small = [...locked, ...maybe].every((x) => x.kind === 'small');
    lines.push('', '판 사람 조건에 따라 산 사람도 조합원이 되는 경우(확정 아님, 직접 확인)', ...(small ? SMALL_SELLER_LINES : SELLER_LINES), '', CHECK_LINE);
  }
  lines.push('', `서울플랜+ 정비구역 파일${r.fileDate ? `(작성일 ${r.fileDate})` : ''}의 단계라 지금과 다를 수 있고, 매물 좌표로 본 것이라 경계 근처는 지번으로 확인해야 합니다.`);
  return { tone, label, tip: lines.join('\n') };
}
