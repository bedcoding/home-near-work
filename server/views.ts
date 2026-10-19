import * as store from './db.js';
import { toNumber } from './collectors/types.js';
import { looksSimilar } from './identity.js';
import { parseLot, pnuOf } from './lots.js';
import { compareLot } from './trade-compare.js';
import { manwon } from '../shared/format.js';
import {
  isApartmentType, isDetachedHouseType, listingSection, NOTICE_SHORT, noticeSourcesOf, SEOUL, SEOUL_GUS, seoulGuOf, type AptInfo, type AptRegistry, type AuctionResultSummary,
  type AuctionResultView, type AuctionSummaryKind, type LandZoneCheck, type ListingView, type NormalizedListing, type NoticeFacts, type NoticeView, type PlotZone,
  type PriceChangeType, type PriceOption, type RatioStats, type SourceId, type TradeRef, type TrustDocRound, type TrustDocView,
} from '../shared/types.js';

type CourtRow = {
  jiwonNm?: unknown;
  srnSaNo?: unknown;
  maemulSer?: unknown;
  gamevalAmt?: unknown;
  yuchalCnt?: unknown;
  mulBigo?: unknown;
  convAddr?: unknown;
  hjguSigu?: unknown;
  hjguDong?: unknown;
} | null | undefined;

const MGMT = /관리단|관리비|관리사무소|관리소장/;

/**
 * 물건 비고에 관리단이나 관리비 이야기가 있으면 이름표와 비고 전문(400자까지)을 준다. 없으면 null.
 * 이름표는 처음 나온 곳 근처 글자로 만든다: 관리비 또는 관리단, 처음 나온 신고 종류 낱말(유치권, 가압류, 배당요구, 체납, 미납, 연체), 뒤에 나온 금액(원 → '1,500만').
 */
export function mgmtNote(remark: unknown): { label: string; text: string } | null {
  const text = typeof remark === 'string' ? remark.replace(/\s+/g, ' ').trim() : '';
  const at = text.search(MGMT);
  if (at < 0) return null;
  const near = text.slice(Math.max(0, at - 40), at + 120);
  const what = /관리비/.test(near) ? '관리비' : '관리단';
  const kind = /유치권|가압류|배당요구|체납|미납|연체/.exec(near)?.[0] ?? '';
  const won = /(\d{1,3}(?:,\d{3})+|\d{5,})\s*원/.exec(text.slice(at, at + 120));
  const amount = won ? Math.round(Number(won[1].replace(/,/g, '')) / 10000) : 0;
  return {
    label: [what, kind, amount > 0 ? manwon(amount) : ''].filter(Boolean).join(' '),
    text: text.length > 400 ? `${text.slice(0, 400)}…` : text,
  };
}

/** 법원경매 원본(물건 묶음이면 목록 행 배열, 첫 행 기준)에서 법원, 사건번호, 물건번호, 감정가, 유찰 횟수, 목록 수, 비고의 관리단 이야기, 소재지 구와 법정동을 읽는다. */
function auctionRef(raw: unknown): ListingView['auction'] {
  const rows = (Array.isArray(raw) ? raw : [raw]) as CourtRow[];
  const row = rows[0];
  if (!row || typeof row.jiwonNm !== 'string' || typeof row.srnSaNo !== 'string') return null;
  const appraisal = toNumber(row.gamevalAmt);
  return {
    court: row.jiwonNm.trim(),
    caseNo: row.srnSaNo.trim(),
    itemNo: String(row.maemulSer ?? '1'),
    appraisal: appraisal && appraisal > 0 ? Math.round(appraisal / 10000) : null,
    failed: toNumber(row.yuchalCnt) ?? 0,
    lots: rows.length,
    mgmt: mgmtNote(row.mulBigo),
    // 땅만 파는 물건(목록이 모두 토지) 중 목록 글자에 지분('N분의 M')이 있는 것
    share: rows.every((r) => String(r?.convAddr ?? '').startsWith('[토지')) && rows.some((r) => String(r?.convAddr ?? '').includes('분의')),
    gu: typeof row.hjguSigu === 'string' && row.hjguSigu ? row.hjguSigu : null,
    dong: typeof row.hjguDong === 'string' && row.hjguDong ? row.hjguDong : null,
  };
}

type OnbidRow = { scrnIndctCltrMngNo?: unknown; cltrApslEvlAvgAmt?: unknown; uscbdCnt?: unknown } | null | undefined;

/** 온비드 원본(검색 응답 한 건)에서 물건관리번호·감정가·유찰 횟수를 읽는다. court는 '온비드'. */
function onbidRef(raw: unknown): ListingView['auction'] {
  const row = raw as OnbidRow;
  if (!row || typeof row.scrnIndctCltrMngNo !== 'string') return null;
  const appraisal = toNumber(row.cltrApslEvlAvgAmt);
  return {
    court: '온비드',
    caseNo: row.scrnIndctCltrMngNo.trim(),
    itemNo: '1',
    appraisal: appraisal && appraisal > 0 ? Math.round(appraisal / 10000) : null,
    failed: toNumber(row.uscbdCnt) ?? 0,
    lots: 1,
    mgmt: null,
    share: false,
    gu: null,
    dong: null,
  };
}

/** 주소 글자에서 법정동 바로 뒤의 지번('316', '123-4', 산이면 '산12'). 못 찾으면 null. */
function jibunAfter(address: string, dong: string): string | null {
  const name = dong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${name}\\s*(산\\s*)?(\\d+(?:-\\d+)?)`).exec(address);
  return m ? `${m[1] ? '산' : ''}${m[2]}` : null;
}

/** 단지 이름 자리: 주소에서 '서울특별시'를 빼고 건물 동·층·호 앞까지('강남구 대치동 316 은마아파트 제12동 제3층' → '강남구 대치동 316 은마아파트') */
function complexNameOf(address: string): string {
  const plain = address.replace(/^서울(특별)?시\s*/, '').replace(/\s+/g, ' ').trim();
  const cut = plain.search(/\s(제\s*)?[0-9A-Za-z가-힣]*\d+\s*동(?=[\s,]|$)|\s(제\s*)?(지하\s*)?\d+\s*층|\s(제\s*)?\d+\s*호/);
  return (cut > 0 ? plain.slice(0, cut) : plain).replace(/[,\s]+$/, '');
}

/**
 * 경매·공매 물건의 서울 구와 지번 키('lot:강남구 대치동 316'). 구는 법원경매면 소재지 구(hjguSigu), 온비드면 시도·시군구·읍면동 글자,
 * 없으면 주소 글자에서 찾는다. 구를 모르면(서울 밖) gu가 null, 주소에서 법정동 뒤 지번을 못 찾으면 lot이 null.
 */
function auctionLot(source: 'courtauction' | 'onbid', l: NormalizedListing, raw: unknown): { gu: string | null; lot: string | null } {
  const address = l.address ?? '';
  let gu: string | null;
  if (source === 'courtauction') {
    const row = (Array.isArray(raw) ? raw[0] : raw) as CourtRow;
    gu = typeof row?.hjguSigu === 'string' && SEOUL_GUS.includes(row.hjguSigu) ? row.hjguSigu : seoulGuOf(address);
  } else {
    const words = String((raw as { sidoSgkEmd?: unknown } | null)?.sidoSgkEmd ?? '').split(/\s+/);
    gu = SEOUL_GUS.includes(words[1]) ? words[1] : seoulGuOf(address);
  }
  const jibun = gu && l.dong ? jibunAfter(address, l.dong) : null;
  return { gu, lot: jibun ? `lot:${gu} ${l.dong} ${jibun}` : null };
}

/**
 * 서울 아파트면 구, 단지 키와 이름, 세대수(직접 넣은 값, 없으면 건축물대장 값), 대장 조회 결과, 온비드 재산 종류(AptInfo).
 * 아파트가 아니거나 서울 구를 모르면 null.
 * 단지 키: 법원경매·온비드는 구, 법정동, 주소의 지번('lot:강남구 대치동 316'), 네이버는 단지 번호('nv:1234'), 못 정하면 매물 하나('id:…').
 */
function aptRef(
  id: string, source: string, l: NormalizedListing, raw: unknown, households: Map<string, number>, registry: Map<string, AptRegistry>,
): AptInfo | null {
  if (!isApartmentType(l.buildingType)) return null;
  const address = l.address ?? '';
  let gu: string | null = null;
  let complexKey: string | null = null;
  let complexName = address ? complexNameOf(address) : l.title;
  let property: string | null = null;
  if (source === 'courtauction' || source === 'onbid') {
    ({ gu, lot: complexKey } = auctionLot(source, l, raw));
    const kind = source === 'onbid' ? (raw as { scrnPrptDvsnNm?: unknown } | null)?.scrnPrptDvsnNm : null;
    property = typeof kind === 'string' && kind.trim() ? kind.trim() : null;
  } else {
    gu = /서울/.test(address) ? seoulGuOf(address) : null;
    if (source === 'naver') {
      const rep = (raw as { representativeArticleInfo?: { complexNumber?: unknown; complexName?: unknown } } | null)?.representativeArticleInfo;
      if (rep?.complexNumber != null && String(rep.complexNumber)) complexKey = `nv:${rep.complexNumber}`;
      if (typeof rep?.complexName === 'string' && rep.complexName.trim()) complexName = rep.complexName.trim();
    }
  }
  if (!gu) return null;
  complexKey ??= `id:${id}`;
  const manual = households.get(complexKey) ?? null;
  const reg = registry.get(complexKey) ?? null;
  const fromRegistry = reg?.status === 'ok' ? reg.households : null;
  return {
    gu,
    complexKey,
    complexName: complexName.slice(0, 80),
    households: manual ?? fromRegistry,
    householdsFrom: manual != null ? 'manual' : fromRegistry != null ? 'registry' : null,
    registry: reg,
    property,
  };
}

/** 다세대·연립 같은 빌라(아파트, 오피스텔, 단독주택 갈래는 뺀다) */
const isVillaType = (t: string | null | undefined) => /다세대|연립|빌라|도시형생활주택/.test(t ?? '') && !isApartmentType(t) && !isDetachedHouseType(t) && !/오피스텔/.test(t ?? '');

/**
 * 재개발 구역 정보(PlotZone). 경매·공매는 단독주택 갈래 주거, 땅만 파는 토지, 아파트, 빌라를 주소의 지번으로 보고,
 * 네이버 서울 아파트 매매는 단지 키('nv:1234')로 묶어 단지 좌표로 찾은 필지(points)로 본다. 다른 물건은 null.
 * 지번 키와 필지 번호를 못 정하면 why에 까닭(서울 밖, 지번 없음, 법정동 코드 모름, 좌표에 필지 없음)을 둔다.
 */
function zoneRef(
  source: string, l: NormalizedListing, raw: unknown, zones: Map<string, LandZoneCheck>, points: Map<string, store.PointParcel>,
): PlotZone | null {
  if (source === 'naver') return naverZoneRef(l, raw, zones, points);
  if (source !== 'courtauction' && source !== 'onbid') return null;
  const section = listingSection({ source: source as SourceId, buildingType: l.buildingType });
  const t = l.buildingType;
  const form = section === 'land' ? 'land' : section !== 'auction' ? null : isDetachedHouseType(t) ? 'house' : isApartmentType(t) ? 'apt' : isVillaType(t) ? 'villa' : null;
  if (!form) return null;
  const base = { form, basis: 'lot', parcel: null, point: null } as const;
  const { gu, lot } = auctionLot(source, l, raw);
  const parsed = lot ? parseLot(lot) : null;
  const pnu = parsed ? pnuOf(parsed) : null;
  if (!lot || !pnu) {
    const why = !gu ? '서울 주소가 아니라 확인하지 않음' : !lot || !parsed ? '주소에서 지번을 못 찾음' : `법정동 코드를 모름(${parsed.gu} ${parsed.dong})`;
    return { ...base, lot: null, pnu: null, why, check: null };
  }
  return { ...base, lot, pnu, why: null, check: zones.get(lot) ?? null };
}

/**
 * 서울 아파트 경매·공매의 최저가를 같은 지번·같은 전용면적의 국토부 실거래와 비교한다(trade-compare). 지번은 주소에서 읽은 지번 키
 * ('lot:노원구 상계동 1234')를 그대로 쓴다. 네이버 매매는 지번이 없어 비교하지 않는다(null).
 */
function tradeRef(source: string, l: NormalizedListing, raw: unknown): TradeRef | null {
  if ((source !== 'courtauction' && source !== 'onbid') || !isApartmentType(l.buildingType)) return null;
  const price = l.prices.find((p) => p.deal === 'auction')?.price ?? null;
  const lot = parseLot(auctionLot(source, l, raw).lot ?? '');
  if (!price || !lot) return null;
  const jibun = `${lot.san ? '산' : ''}${lot.bun}${lot.ji !== '0' ? `-${lot.ji}` : ''}`;
  return compareLot({ gu: lot.gu, dong: lot.dong, jibun, areaM2: l.areaM2, price });
}

/** 네이버 서울 아파트 매매의 구역 정보: 단지 번호와 좌표가 있어야 본다(매물 주소에는 지번이 없다). */
function naverZoneRef(l: NormalizedListing, raw: unknown, zones: Map<string, LandZoneCheck>, points: Map<string, store.PointParcel>): PlotZone | null {
  if (!isApartmentType(l.buildingType) || !l.prices.some((p) => p.deal === 'sale') || !seoulGuOf(l.address ?? '')) return null;
  const complex = (raw as { representativeArticleInfo?: { complexNumber?: unknown } } | null)?.representativeArticleInfo?.complexNumber;
  const point = l.lat != null && l.lng != null ? { lat: l.lat, lng: l.lng } : null;
  const base = { form: 'apt', basis: 'point', parcel: null, point } as const;
  if (complex == null || !String(complex) || !point) return { ...base, lot: null, pnu: null, why: '단지 번호나 좌표가 없어 확인하지 않음', check: null };
  const lot = `nv:${complex}`;
  const p = points.get(lot);
  if (!p || p.status === 'error') return { ...base, lot, pnu: null, why: p?.error ? `단지 좌표로 필지를 못 찾음(${p.error})` : null, check: null };
  if (p.status === 'none' || !p.pnu) return { ...base, lot, pnu: null, why: '단지 좌표에 필지가 없음', check: null };
  return { ...base, lot, pnu: p.pnu, parcel: p.addr, why: null, check: zones.get(lot) ?? null };
}

const FULL_OPTION = /풀\s*옵션|풀옵/;
const NO_OPTION = /무\s*옵션|노\s*옵션|옵션\s*없음/;

/**
 * 옵션(가전, 가구) 정보. 모르면 null.
 * 집토스는 옵션 목록(options, 비었으면 옵션 없음)과 가격의 isFullOption, 피터팬은 풀옵션 표시(additional_options.is_full_option),
 * 그 밖에는 제목이나 네이버 소개 글(articleFeatureDescription)의 '풀옵션', '무옵션' 글자로 정한다.
 */
export function optionsRef(source: string, raw: unknown, title: string): ListingView['options'] {
  const r = (raw ?? {}) as {
    options?: unknown;
    prices?: { isFullOption?: unknown }[];
    additional_options?: { is_full_option?: unknown };
    representativeArticleInfo?: { articleDetail?: { articleFeatureDescription?: unknown } };
  };
  const intro = r.representativeArticleInfo?.articleDetail?.articleFeatureDescription;
  const text = [title, typeof intro === 'string' ? intro : ''].join(' ');
  const saysFull = FULL_OPTION.test(text);
  const saysNone = NO_OPTION.test(text) && !saysFull;
  if (source === 'ziptoss' && Array.isArray(r.options)) {
    const list = r.options.filter((x): x is string => typeof x === 'string');
    return { list, full: saysFull || (Array.isArray(r.prices) && r.prices.some((p) => p?.isFullOption === true)) };
  }
  if (source === 'peterpanz' && r.additional_options) {
    return { list: saysNone ? [] : null, full: saysFull || Number(r.additional_options.is_full_option) === 1 };
  }
  return saysFull || saysNone ? { list: saysNone ? [] : null, full: saysFull } : null;
}

/** 매물 + 판정 + 확인하지 않은 변화를 화면용으로 합친다. */
export function buildListingViews(): ListingView[] {
  const rows = store.allListings();
  const courtRaw = store.rawBySource('courtauction');
  const onbidRaw = store.rawBySource('onbid');
  /** 옵션을 읽는 원본(집토스 옵션 목록, 피터팬 풀옵션 표시, 네이버 소개 글과 단지 번호) */
  const optionRaw = new Map([...store.rawBySource('ziptoss'), ...store.rawBySource('peterpanz'), ...store.rawBySource('naver')]);
  const households = store.complexHouseholds();
  const registry = store.registryRows();
  const zones = store.zoneChecks();
  const points = store.pointParcels();
  const verdicts = new Map(store.allVerdicts().map((v) => [v.listing_id, v]));
  const events = store.unackedEvents();
  const newIds = new Set(events.filter((e) => e.type === 'new').map((e) => e.listing_id));
  const changes = new Map<string, ListingView['priceChange']>();
  for (const e of events) {
    if (!e.type.startsWith('price_') || !e.detail) continue;
    const detail = JSON.parse(e.detail) as { before: PriceOption[]; after: PriceOption[] };
    changes.set(e.listing_id, { type: e.type as PriceChangeType, before: detail.before, after: detail.after, at: e.created_at });
  }

  const parsed = rows.map((r) => ({ row: r, data: JSON.parse(r.data) as NormalizedListing }));
  const discarded = parsed.filter(({ row }) => verdicts.get(row.id)?.verdict === 'discard');

  return parsed.map(({ row, data }) => {
    const verdict = verdicts.get(row.id);
    const raw = row.source === 'courtauction' ? courtRaw.get(row.id) : row.source === 'onbid' ? onbidRaw.get(row.id) : optionRaw.get(row.id);
    const reason = verdict?.reason ?? null;
    // 원본 데이터 설명표는 '원본 데이터' 버튼을 누를 때 따로 불러온다.
    const { explain: _explain, ...rest } = data;
    return {
      ...rest,
      id: row.id,
      identityKey: row.identity_key,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      status: row.status,
      verdict: verdict?.verdict ?? null,
      verdictReason: reason,
      isNew: newIds.has(row.id),
      priceChange: changes.get(row.id) ?? null,
      relistedOf: reason?.startsWith('relisted:') ? reason.slice('relisted:'.length) : null,
      similarToDiscarded: !verdict && discarded.some((d) => d.row.id !== row.id && looksSimilar(data, d.data)),
      seenRef: row.seen_ref ? JSON.parse(row.seen_ref) : null,
      auction: row.source === 'courtauction' ? auctionRef(courtRaw.get(row.id)) : row.source === 'onbid' ? onbidRef(onbidRaw.get(row.id)) : null,
      options: optionsRef(row.source, optionRaw.get(row.id), data.title ?? ''),
      apt: aptRef(row.id, row.source, data, raw, households, registry),
      zone: zoneRef(row.source, data, raw, zones, points),
      trade: tradeRef(row.source, data, raw),
    };
  });
}

/** 법원 물건 상태 코드의 이름. moved, unsold는 경매사건검색으로 본 그 날 결과가 없는 경우. */
const COURT_STATUS: Record<string, string> = {
  '02': '매각',
  '03': '유찰',
  '04': '매각허가결정',
  '05': '매각불허가결정',
  '06': '대금납부',
  '07': '대금미납',
  '08': '매각허가취소결정',
  moved: '기일 넘어감',
  unsold: '매각 안 됨',
};
/** 낙찰가가 있는 상태(매각, 매각허가결정, 대금납부, 대금미납, 매각허가취소결정) */
const SOLD_STATUS = new Set(['02', '04', '06', '07', '08']);
const toManwon = (won: number | null) => (won == null ? null : Math.round(won / 10000));

/** 저장된 법원경매 매각 결과 중 gus(구 이름)에 있는 것을 화면용으로(매각기일 최근 순). 대시보드가 모은 물건이면 그 매물 id를 붙인다. */
export function buildAuctionResultViews(gus: string[]): AuctionResultView[] {
  const byBuilding = new Map<string, string>();
  for (const row of store.allListings()) {
    if (row.source !== 'courtauction') continue;
    const key = (JSON.parse(row.data) as NormalizedListing).buildingKey;
    if (key) byBuilding.set(key, row.id);
  }
  return store.auctionResultRows(gus).map((r) => ({
    key: r.key,
    saleDate: r.sale_date,
    court: r.court,
    caseNo: r.case_no,
    itemNo: r.item_no,
    gu: r.gu,
    dong: r.dong,
    address: r.address,
    usage: r.usage,
    kind: r.kind,
    areaM2: r.area_m2,
    lots: r.lots,
    failed: r.failed,
    appraisal: toManwon(r.appraisal),
    minPrice: toManwon(r.min_price),
    amount: toManwon(r.amount),
    status: COURT_STATUS[r.status] ?? r.status,
    sold: SOLD_STATUS.has(r.status) && (r.amount ?? 0) > 0,
    lat: r.lat,
    lng: r.lng,
    via: r.via,
    listingId: byBuilding.get(`ca-${r.key}`) ?? null,
  }));
}

/** 비율(%) 여러 개를 요약한다. 없으면 null. */
function ratioStats(values: number[]): RatioStats | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/** 유찰 횟수 묶음('0', '1', '2', '3+'). 모르면 null. */
const failedBucket = (failed: number | null) => (failed == null ? null : failed >= 3 ? '3+' : String(failed));

/**
 * 최근 1년(이 컴퓨터 날짜 기준) 매각 결과를 종류별로, gus의 구마다 그리고 서울 전체(SEOUL)로 요약한다.
 * 주거 중 단독주택 갈래(isDetachedHouseType)는 house로도 한 번 더 센다.
 * 낙찰, 유찰, 불허가만 센다(기일이 넘어간 것은 유찰인지 변경인지 몰라 뺀다).
 */
export function buildAuctionResultSummary(gus: string[]): AuctionResultSummary[] {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  interface Group {
    area: string;
    kind: AuctionSummaryKind;
    held: number;
    sold: number;
    dates: string[];
    overAppraisal: number[];
    overMin: number[];
    overMinByFailed: Map<string, number[]>;
    amount: number;
    appraisal: number;
  }
  const groups = new Map<string, Group>();
  for (const r of store.auctionResultRatioRows(from)) {
    const sold = SOLD_STATUS.has(r.status) && (r.amount ?? 0) > 0;
    if (!sold && r.status !== '03' && r.status !== '05') continue;
    const kinds: AuctionSummaryKind[] = r.kind === 'home' && isDetachedHouseType(r.usage) ? ['home', 'house'] : [r.kind];
    for (const [kind, area] of kinds.flatMap((k) => (r.gu && gus.includes(r.gu) ? [r.gu, SEOUL] : [SEOUL]).map((a) => [k, a] as const))) {
      const key = `${area}|${kind}`;
      const g: Group = groups.get(key) ?? { area, kind, held: 0, sold: 0, dates: [], overAppraisal: [], overMin: [], overMinByFailed: new Map(), amount: 0, appraisal: 0 };
      groups.set(key, g);
      g.held++;
      g.dates.push(r.sale_date);
      if (!sold) continue;
      g.sold++;
      const amount = r.amount!;
      if (r.appraisal) {
        g.overAppraisal.push((amount / r.appraisal) * 100);
        g.amount += amount;
        g.appraisal += r.appraisal;
      }
      if (r.min_price) {
        const x = (amount / r.min_price) * 100;
        g.overMin.push(x);
        const bucket = failedBucket(r.failed);
        if (bucket) g.overMinByFailed.set(bucket, [...(g.overMinByFailed.get(bucket) ?? []), x]);
      }
    }
  }
  return [...groups.values()].map((g) => {
    const dates = g.dates.sort();
    return {
      area: g.area,
      kind: g.kind,
      held: g.held,
      sold: g.sold,
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
      appraisal: ratioStats(g.overAppraisal),
      weighted: g.appraisal ? (g.amount / g.appraisal) * 100 : null,
      minPrice: ratioStats(g.overMin),
      minPriceByFailed: ['0', '1', '2', '3+'].flatMap((failed) => {
        const stats = ratioStats(g.overMinByFailed.get(failed) ?? []);
        return stats ? [{ failed, stats }] : [];
      }),
    };
  });
}

/** 주소 글자에서 처음 나오는 법정동과 지번('역삼동 123-45', '을지로3가 12-3'). 못 찾으면 null. */
function lotOf(text: string): string | null {
  const m = /([가-힣]+(?:동|\d+가))\s*(?:산\s*)?(\d+(?:-\d+)?)/.exec(text);
  return m ? `${m[1]} ${m[2]}` : null;
}

/** 온비드 등록 기관 이름에서 회사 표시를 뺀다('주식회사 무궁화신탁' → '무궁화신탁', '케이비부동산신탁주식회사' → 'KB부동산신탁'). 공고 곳의 짧은 이름(NOTICE_SHORT)과 같아진다. */
const orgName = (s: string) => s.replace(/주식회사|\(주\)|\s/g, '').replace(/^케이비/, 'KB');

/** 'YYYY-MM-DD HH:MM' 두 개 → '03.12' 또는 '03.10~03.12'. 날짜가 없으면 null. */
function bidDays(begin: string, end: string): string | null {
  const day = (t: string) => (/^\d{4}-(\d{2})-(\d{2})/.exec(t) ?? []).slice(1).join('.');
  const a = day(begin);
  const b = day(end);
  return a ? (b && b !== a ? `${a}~${b}` : a) : null;
}

type TrustItem = { org: string; lot: string | null; pbanc: string; price: number | null; area: number | null; begin: string; end: string; failed: number };

/** 모은 온비드 물건 중 신탁사가 등록한 것(등록 기관 이름에 '신탁'). */
function onbidTrustItems(): TrustItem[] {
  const items: TrustItem[] = [];
  for (const raw of store.rawBySource('onbid').values()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const org = orgName(String(r.regOrgNm ?? ''));
    if (!org.includes('신탁')) continue;
    const price = r.lowstBidPrcHideDivCd === '0001' ? toNumber(r.lowstBidPrc) : null;
    const bld = toNumber(r.bldSqms);
    const land = toNumber(r.landSqms);
    items.push({
      org,
      lot: lotOf(String(r.onbidCltrNm ?? '')),
      pbanc: String(r.onbidPbancNo ?? ''),
      price: price && price > 0 ? Math.round(price / 10000) : null,
      area: bld && bld > 0 ? bld : land && land > 0 ? land : null,
      begin: String(r.pbctBegnDtm ?? ''),
      end: String(r.pbctDdlnDt ?? ''),
      failed: toNumber(r.uscbdCnt) ?? 0,
    });
  }
  return items;
}

const sqm = (m2: number) => (Math.round(m2 * 10) / 10).toLocaleString('ko-KR');
const monthDay = (iso: string) => `${iso.slice(5, 7)}.${iso.slice(8, 10)}`;

/**
 * 같은 신탁사가 온비드에 올린 같은 지번 물건의 숫자. 지번이 맞는 물건이 든 온비드 공고 중 입찰 시작이 가장 늦은 것 하나의 물건 전부를 센다(제목의 '외 N호'도 들어옴).
 * amount는 그 물건들의 최저입찰가 중 가장 낮은 값(만원), areaM2는 물건이 하나일 때 면적, note는 입찰 날짜(끝났으면 '끝'), 유찰 횟수, 여럿이면 면적 범위. 없으면 null.
 * now는 'YYYY-MM-DD HH:MM'.
 */
function onbidFacts(n: NoticeView, items: TrustItem[], now: string): NoticeFacts | null {
  const lot = lotOf(n.title) ?? (n.place ? lotOf(n.place) : null);
  const org = NOTICE_SHORT[n.source];
  const hits = lot ? items.filter((i) => i.org === org && i.lot === lot) : [];
  if (!hits.length) return null;
  const pbanc = hits.reduce((a, b) => (b.begin > a.begin ? b : a)).pbanc;
  const group = pbanc ? items.filter((i) => i.org === org && i.pbanc === pbanc) : hits;
  const prices = group.map((i) => i.price).filter((v): v is number => v != null);
  const areas = group.map((i) => i.area).filter((v): v is number => v != null);
  const days = bidDays(group[0].begin, group[0].end);
  const ended = group.every((i) => i.end && i.end < now);
  const note = [
    `온비드${days ? ` ${days} 입찰${ended ? ' 끝' : ''}` : ''}`,
    `유찰 ${Math.max(...group.map((i) => i.failed))}회`,
    group.length > 1 && areas.length ? `${sqm(Math.min(...areas))}~${sqm(Math.max(...areas))}㎡` : null,
  ].filter(Boolean).join(', ');
  return {
    amount: prices.length ? { label: group.length > 1 ? `${group.length}건 중 최저` : '최저가', value: Math.min(...prices) } : null,
    areaM2: group.length === 1 ? (areas[0] ?? null) : null,
    note,
  };
}

/**
 * 공고문 차수 표의 숫자: 오늘이나 그 뒤 첫 입찰 차수(다 지났으면 마지막 차수)의 최저가와 날짜. 가격을 아는 차수가 없으면 null.
 * 호실이 여럿이면 그 차수에서 가장 낮은 값. 글자 인식으로 읽은 공고문이면 note에 '(글자 인식)'. today는 'YYYY-MM-DD'.
 */
function docFacts(doc: TrustDocView, today: string): NoticeFacts | null {
  const priced = doc.rounds.filter((r) => r.price != null);
  if (!priced.length) return null;
  const next = priced.find((r) => r.bid != null && r.bid >= today);
  const r = next ?? priced[priced.length - 1];
  const last = doc.rounds[doc.rounds.length - 1].no;
  const day = r.bid ? monthDay(r.bid) : null;
  return {
    amount: { label: r.count > 1 ? `${r.no}차 ${r.count}건 중 최저` : `${r.no}차 최저가`, value: r.price! },
    areaM2: null,
    note: `공고문${doc.ocr ? '(글자 인식)' : ''} ${next ? `${day} 입찰, ${last}차까지` : `${last}차 입찰 끝${day ? `(${day})` : ''}`}`,
  };
}

/**
 * 신탁사 공매 공고에 첨부 공고문을 읽은 결과(doc)와 줄에 보일 숫자(facts)를 붙인다.
 * facts는 이미 있으면 그대로, 없으면 같은 신탁사가 온비드에 올린 같은 지번 물건의 숫자(onbidFacts), 그것도 없으면 공고문 차수 표의 숫자(docFacts).
 */
export function withTrustFacts(notices: NoticeView[]): NoticeView[] {
  const trust = new Set(noticeSourcesOf('trust'));
  if (!notices.some((n) => trust.has(n.source))) return notices;
  const docs = store.trustDocsByNotice();
  const items = onbidTrustItems();
  const d = new Date();
  const p2 = (v: number) => String(v).padStart(2, '0');
  const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const now = `${today} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return notices.map((n) => {
    if (!trust.has(n.source)) return n;
    const row = docs.get(n.id);
    const doc: TrustDocView | null = row
      ? {
        name: row.name, url: row.url, readAt: row.read_at, rounds: row.rounds ? (JSON.parse(row.rounds) as TrustDocRound[]) : [],
        lines: row.line_count, ocr: row.ocr === 1, error: row.error,
      }
      : null;
    const facts = n.facts ?? onbidFacts(n, items, now) ?? (doc ? docFacts(doc, today) : null);
    return { ...n, doc, facts };
  });
}
