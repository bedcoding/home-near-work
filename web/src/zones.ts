import type { LandZone, PlotZone } from '../../shared/types';
import type { SupportSource } from './support';

// 재개발 구역 경고(ZoneBanner): 서버가 브이월드 토지이용계획으로 본 구역(PlotZone)을 카드 위 띠나 작은 표시로 보인다.
// 집터(단독주택, 토지), 경매, 서울 아파트, 관심과 숨김함 탭과 상세 칸에 쓴다. 구역 안이면 입주권 없이 현금으로 보상받게
// (현금청산, 흔히 '물딱지') 되는 경우와 새로 짓기 제한을 법령 원문 기준으로 적고, 아파트에는 아파트에 맞는 조건만 보인다.
// 고칠 때는 ZONE_CHECKED와 근거(sources)도 같이 고친다(서울 아파트 탭 apt.ts와 같은 방식).

/** 법령 원문을 확인한 날 */
export const ZONE_CHECKED = '2026-10-18';

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
  kinds: LandZone['kind'][];
  forms?: PlotZone['form'][];
  text: string;
  sources: SupportSource[];
}

/** 땅이나 단독·다가구에만 해당하는 조건(땅만 가진 경우, 새로 짓기, 건축허가 제한) */
const HOUSE_OR_LAND: PlotZone['form'][] = ['house', 'land'];
/** 지분 쪼개기는 빌라에도 해당한다(기준일 뒤에 지은 다세대) */
const SPLIT_FORMS: PlotZone['form'][] = ['house', 'land', 'villa'];

export const ZONE_RULES: ZoneRule[] = [
  {
    id: 'transfer',
    kinds: ['redev'],
    text: '서울은 전역이 투기과열지구라, 재개발은 관리처분계획인가 뒤에, 재건축은 조합설립인가 뒤에 사면 조합원이 못 되고 현금으로 보상받습니다. 이 구역이 어느 단계인지 먼저 확인하세요.',
    sources: [
      { title: '도시 및 주거환경정비법 제39조 제2항·제3항', url: `${LAW}/도시및주거환경정비법/제39조`, date: '' },
      { title: 'thecheck.co.kr: 10월 16일 자로 서울 전역 조정대상지역·투기과열지구 지정', url: 'https://thecheck.co.kr/?p=1387', date: '' },
    ],
  },
  {
    id: 'transfer-exception',
    kinds: ['redev'],
    text: '예외도 있습니다. 판 사람이 1세대 1주택으로 10년 갖고 5년 살았거나, 국가·지자체·금융기관 빚을 못 갚아 나온 경매·공매면 그 뒤에 사도 조합원이 될 수 있습니다(그 밖에 근무·질병·상속·해외 이주 같은 사정). 다른 빚 때문에 나온 경매는 경매라는 것만으로는 예외가 아닙니다.',
    sources: [{ title: '도시 및 주거환경정비법 시행령 제37조 제1항, 제3항 제5호', url: `${LAW}/도시및주거환경정비법시행령/제37조`, date: '' }],
  },
  {
    id: 'split',
    forms: SPLIT_FORMS,
    kinds: ['redev'],
    text: '권리산정기준일 뒤에 땅을 나누거나, 단독·다가구를 다세대로 바꾸거나, 헐고 다세대를 지어 주인이 늘었으면 그 여러 명이 1명분만 받습니다. 기준일은 구역 지정 전에 따로 정해지기도 합니다.',
    sources: [
      { title: '도시 및 주거환경정비법 제77조', url: `${LAW}/도시및주거환경정비법/제77조`, date: '' },
      { title: '서울특별시 도시 및 주거환경정비 조례 제36조 제2항', url: SEOUL_ORDINANCE, date: '2026-05-18' },
    ],
  },
  {
    id: 'share',
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
    forms: HOUSE_OR_LAND,
    kinds: ['redev'],
    text: '집 없이 땅만 가지면 재개발 분양 대상이 되려면 땅이 90㎡ 이상이거나 권리가액이 가장 작은 분양 주택 1채 값 이상이어야 합니다. 작은 땅이나 도로 지분은 현금청산될 수 있습니다.',
    sources: [{ title: '서울특별시 도시 및 주거환경정비 조례 제36조 제1항', url: SEOUL_ORDINANCE, date: '2026-05-18' }],
  },
  {
    id: 'build',
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
    kinds: ['small'],
    text: '모아타운(가로주택정비 등 소규모주택정비)은 조합설립인가 뒤에 사면 조합원이 못 됩니다. 예외는 판 사람이 1세대 1주택으로 5년 갖고 3년 산 집, 금융기관 빚을 못 갚아 나온 경매·공매 등입니다.',
    sources: [
      { title: '빈집 및 소규모주택 정비에 관한 특례법 제24조 제2항·제3항', url: `${LAW}/빈집및소규모주택정비에관한특례법/제24조`, date: '' },
      { title: '같은 법 시행령 제22조 제1항, 제3항 제4호', url: `${LAW}/빈집및소규모주택정비에관한특례법시행령/제22조`, date: '2026-09-18' },
    ],
  },
  {
    id: 'limit',
    forms: HOUSE_OR_LAND,
    kinds: ['limit'],
    text: '건축허가·착공 제한: 새로 짓는 것을 막아 둔 곳입니다(2년 이내, 한 번 1년까지 연장). 서울시는 신속통합기획 재개발 후보지를 고를 때 토지거래허가구역과 함께 이 제한을 겁니다. 헐고 새로 짓기(모듈러 포함)는 풀릴 때까지 어렵습니다.',
    sources: [
      { title: '건축법 제18조', url: `${LAW}/건축법/제18조`, date: '' },
      { title: 'MTN: 구의·신길·갈현 신통기획 후보지…2년 내 정비구역 지정(토지거래허가구역 지정과 건축허가 제한)', url: 'https://news.mtn.co.kr/news-detail/2026073017530598598', date: '2026-07-30' },
    ],
  },
  {
    id: 'rebuy',
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
  zone.basis === 'point' ? `필지는 네이버 단지 좌표로 찾은 ${zone.parcel ?? zone.pnu ?? '필지'}입니다. 단지가 여러 필지면 다른 동은 구역이 다를 수 있습니다.` : null;
const zoneText = (z: LandZone) => `${z.name}${z.overlap === '저촉' ? ' 일부 걸침' : z.overlap === '접함' ? ' 경계' : ' 안'}`;
const zoneTitle = (z: LandZone) =>
  [
    `${z.name}: 필지가 구역에 '${z.overlap}'`,
    z.notice ? `관리번호의 고시·공고 번호 ${z.notice}${z.org ? `(${z.org})` : ''}` : '',
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
        `토지이용계획(${day(c.checkedAt)} 조회)에 정비구역, 재개발·재정비촉진, 소규모주택정비(모아타운), 건축허가 제한이 없습니다.`,
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
        ? '재건축·재개발 구역 안 아파트는 사는 때(재건축 조합설립인가 뒤, 재개발 관리처분인가 뒤)에 따라 조합원이 못 되고 현금으로 보상받을 수 있습니다(현금청산). 펼쳐서 조건을 확인하세요.'
        : '사는 때와 물건에 따라 입주권 없이 현금으로 보상받을 수 있습니다(현금청산). 펼쳐서 조건을 확인하세요.',
    rules: ZONE_RULES.filter((r) => r.kinds.some((k) => kinds.has(k)) && (!r.forms || r.forms.includes(zone.form))),
    title: '',
    pnu: zone.pnu,
    checkedAt: c.checkedAt,
    basis: pointBasis(zone),
  };
}
