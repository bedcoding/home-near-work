import { priceText } from '../shared/format.js';
import type { ExplainRow, NormalizedListing, PriceOption } from '../shared/types.js';

/**
 * 당근부동산 역 근처 목록 화면(`/map/subway/<역 이름>`)이 GraphQL로 받는 `subwayStationArticleConnection` 한 페이지(10건씩).
 * 금액은 만원. 상가, 사무실, 건물 같은 비주거 매물은 매물로 저장하지 않고 개수만 센다.
 */
const HOMES: Record<string, { buildingType: string | null; roomLabel: string }> = {
  ONE_ROOM: { buildingType: null, roomLabel: '원룸' },
  TWO_ROOM: { buildingType: null, roomLabel: '투룸 이상' },
  OFFICETEL: { buildingType: '오피스텔', roomLabel: '오피스텔' },
  APART: { buildingType: '아파트', roomLabel: '아파트' },
  HOUSE: { buildingType: '주택', roomLabel: '주택' },
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const articleId = (a: Record<string, unknown> | null) => {
  const id = text(a?.originalId);
  return id && /^[1-9]\d{0,19}$/.test(id) ? id : null;
};

/** 요청 본문에서 역 번호, 이어 받을 위치, 매물 종류 조건을 읽는다. 못 읽으면 null. */
export function daangnRequest(requestBody: string | null | undefined): { stationPoiId: string; after: string | null; filter: string } | null {
  try {
    const v = JSON.parse(requestBody ?? '')?.variables;
    const station = typeof v?.subwayStationPoiId === 'string' ? v.subwayStationPoiId : null;
    if (!station || !/^\d{1,20}$/.test(station)) return null;
    return { stationPoiId: station, after: typeof v.after === 'string' && v.after ? v.after : null, filter: JSON.stringify(v.propertyFilter ?? null) };
  } catch {
    return null;
  }
}

function prices(trades: unknown): PriceOption[] {
  if (!Array.isArray(trades)) return [];
  return trades.flatMap((t): PriceOption[] => {
    const type = typeof t?.type === 'string' ? t.type : '';
    if (type === 'MONTH') return [{ deal: 'monthly', deposit: num(t.deposit), monthly: num(t.monthlyPay), price: null }];
    if (type === 'SHORT') return [{ deal: 'short', deposit: num(t.deposit), monthly: num(t.monthlyPay), price: null }];
    if (type === 'BORROW') return [{ deal: 'jeonse', deposit: num(t.deposit), monthly: null, price: null }];
    if (type === 'BUY') return [{ deal: 'sale', deposit: null, monthly: null, price: num(t.price) }];
    return [];
  });
}

function toListing(a: Record<string, unknown>, id: string, home: (typeof HOMES)[string]): NormalizedListing | null {
  const coordinate = a.publicCoordinate as { lat?: unknown; lon?: unknown } | undefined;
  const lat = num(coordinate?.lat);
  const lng = num(coordinate?.lon);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const region = a.region as { name?: unknown; name2?: unknown; name3?: unknown } | undefined;
  const floorText = text(a.floor) ?? '';
  const floorNumber = num(floorText);
  const floor = floorNumber != null && Number.isInteger(floorNumber) ? floorNumber : null;
  const priceList = prices(a.trades);
  const images = Array.isArray(a.images) ? a.images as { thumbnail?: unknown }[] : [];
  const dong = text(region?.name3) ?? text(region?.name);
  const explain: ExplainRow[] = [
    { label: '가격', raw: `trades: ${Array.isArray(a.trades) ? a.trades.map((t) => `${t?.type ?? '?'} ${t?.deposit ?? t?.price ?? '?'}/${t?.monthlyPay ?? '-'}`).join(', ') : '?'}`, value: priceList.map(priceText).join(', ') || '못 읽음' },
    { label: '종류', raw: `salesTypeV3.type: ${(a.salesTypeV3 as { type?: unknown } | undefined)?.type ?? '?'}`, value: home.roomLabel },
    { label: '층', raw: `floor, topFloor: ${floorText || '?'} / ${a.topFloor ?? '?'}`, value: floor != null ? `${floor}층` : floorText || '모름' },
  ];
  return {
    source: 'daangn',
    sourceId: id,
    url: `https://realty.daangn.com/articles/${id}`,
    title: text(a.buildingName) ?? `${home.roomLabel}${dong ? ` ${dong}` : ''}`,
    thumbnail: text(images[0]?.thumbnail),
    lat,
    lng,
    address: a.isHideAddress === true ? null : text(a.addressInfo),
    dong,
    buildingKey: null,
    buildingType: home.buildingType,
    roomLabel: home.roomLabel,
    rooms: null,
    areaM2: num(a.area),
    floor,
    totalFloors: num(a.topFloor),
    basement: floor != null ? floor < 0 : null,
    rooftop: null,
    builtYear: null,
    maintenance: null,
    elevator: null,
    parking: null,
    availableFrom: null,
    updatedAt: null,
    prices: priceList,
    explain,
  };
}

export interface DaangnPage {
  /** 모양이 맞는 목록 응답인지 */
  valid: boolean;
  /** 이 페이지의 모든 매물 번호(비주거 포함) */
  ids: string[];
  /** 주거용이라 저장할 매물 */
  items: { listing: NormalizedListing; raw: unknown }[];
  /** 비주거라 저장하지 않은 매물 번호 */
  excludedIds: string[];
  /** 주거용인데 좌표가 없는 등 읽지 못한 매물 번호 */
  unreadableIds: string[];
  hasNextPage: boolean | null;
  endCursor: string | null;
}

export function parseDaangnArticles(body: string): DaangnPage {
  const empty: DaangnPage = { valid: false, ids: [], items: [], excludedIds: [], unreadableIds: [], hasNextPage: null, endCursor: null };
  try {
    const conn = JSON.parse(body)?.data?.subwayStationArticleConnection;
    if (!conn || !Array.isArray(conn.edges) || typeof conn.pageInfo?.hasNextPage !== 'boolean') return empty;
    const page: DaangnPage = { ...empty, valid: true, hasNextPage: conn.pageInfo.hasNextPage, endCursor: text(conn.pageInfo.endCursor) };
    for (const edge of conn.edges) {
      const a = edge?.node?.article && typeof edge.node.article === 'object' ? edge.node.article as Record<string, unknown> : null;
      const id = articleId(a);
      if (!a || !id) { page.valid = false; continue; }
      page.ids.push(id);
      const home = HOMES[String((a.salesTypeV3 as { type?: unknown } | undefined)?.type ?? '')];
      if (!home) { page.excludedIds.push(id); continue; }
      const listing = toListing(a, id, home);
      if (listing) page.items.push({ listing, raw: a });
      else page.unreadableIds.push(id);
    }
    return page;
  } catch {
    return empty;
  }
}

/** 한 역의 목록을 처음부터 끝까지 받았는지와 매물별 서버 저장을 대조하는 기록. */
export interface DaangnLedger {
  stationName: string | null;
  stationPoiId: string | null;
  filter: string | null;
  pages: number;
  cursor: string | null;
  ended: boolean;
  articles: Record<string, 'pending' | 'stored' | 'excluded' | 'unreadable'>;
  invalid?: string;
}
export interface DaangnCoverage {
  stationPoiId: string | null;
  pages: number;
  received: number;
  stored: number;
  excluded: number;
  unreadable: number;
  complete: boolean;
  reason: string;
}

/** `/map/subway/<역 이름>` 화면의 역 이름. 다른 화면이면 null. */
export function daangnStationName(pageUrl: string | null | undefined): string | null {
  try {
    const u = new URL(pageUrl ?? '');
    if (u.protocol !== 'https:' || u.hostname !== 'realty.daangn.com' || u.port || u.username || u.password) return null;
    const m = /^\/map\/subway\/([^/]+)\/?$/.exec(u.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

export function createDaangnLedger(stationName: string | null): DaangnLedger {
  return { stationName, stationPoiId: null, filter: null, pages: 0, cursor: null, ended: false, articles: {} };
}

/** 목록 응답 하나를 기록한다. 역이나 조건이 바뀌거나 페이지 순서가 이어지지 않으면 완료로 인정하지 않는다. */
export function acceptDaangnPage(ledger: DaangnLedger, capture: { pageUrl?: string | null; requestBody?: string | null; status?: number | null; body: string }): DaangnPage | null {
  const page = parseDaangnArticles(capture.body);
  if (!page.valid && !page.ids.length && page.hasNextPage === null) return null;
  if (daangnStationName(capture.pageUrl) !== ledger.stationName) { ledger.invalid ||= 'response-scope'; return page; }
  if (!(typeof capture.status === 'number' && capture.status >= 200 && capture.status < 300)) { ledger.invalid ||= 'response-status'; return page; }
  if (!page.valid) ledger.invalid ||= 'unreadable-list';
  const request = daangnRequest(capture.requestBody);
  if (!request) ledger.invalid ||= 'missing-request';
  else {
    if (ledger.stationPoiId && ledger.stationPoiId !== request.stationPoiId) ledger.invalid ||= 'station-changed';
    if (ledger.filter !== null && ledger.filter !== request.filter) ledger.invalid ||= 'query-changed';
    ledger.stationPoiId ||= request.stationPoiId;
    ledger.filter ??= request.filter;
    // 첫 페이지를 다시 받으면 처음부터 다시 잇는다. 그 밖에는 직전 페이지 끝에서 이어져야 한다.
    if (request.after !== null && request.after !== ledger.cursor) ledger.invalid ||= 'list-changed';
  }
  ledger.pages += 1;
  ledger.cursor = page.endCursor;
  ledger.ended = page.hasNextPage === false;
  for (const id of page.excludedIds) ledger.articles[id] = 'excluded';
  for (const id of page.unreadableIds) ledger.articles[id] = 'unreadable';
  for (const { listing } of page.items) if (ledger.articles[listing.sourceId] !== 'stored') ledger.articles[listing.sourceId] = 'pending';
  return page;
}

export function daangnCoverage(ledger: DaangnLedger): DaangnCoverage {
  const states = Object.values(ledger.articles);
  const stored = states.filter((s) => s === 'stored').length;
  const excluded = states.filter((s) => s === 'excluded').length;
  const unreadable = states.filter((s) => s === 'unreadable').length;
  const pending = states.filter((s) => s === 'pending').length;
  const reason = ledger.invalid ?? (!ledger.pages ? 'missing-list' : !ledger.ended ? 'more-pages' : unreadable ? 'unreadable-articles' : pending ? 'unverified-storage' : 'complete');
  return { stationPoiId: ledger.stationPoiId, pages: ledger.pages, received: states.length, stored, excluded, unreadable, complete: reason === 'complete', reason };
}
