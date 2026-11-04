import { DASHBOARD_URL } from './config.js';
import * as store from './db.js';
import { matchingAlertAreas } from '../shared/alert-scope.js';
import { optionsRef } from './views.js';
import { dealOptions, filterSummary, normalizeFilters } from '../shared/filters.js';
import { manwon } from '../shared/format.js';
import {
  hasHomeListings, listingSection, noticeSourcesOf, NOTICE_SHORT, SOURCE_LABEL,
  type AlertSettings, type Area, type DealType, type NormalizedListing, type NoticeSection, type NoticeSourceId, type PriceOption,
  type RunSourceSummary, type SourceId,
} from '../shared/types.js';

/** 처음 알림 설정 */
export const DEFAULT_ALERTS: AlertSettings = {
  scopeVersion: 2,
  stationAreasOnly: true,
  homeFilter: null,
  monthly: { on: true, monthlyMax: 50, depositMax: null },
  jeonse: { on: false, depositMax: null },
  short: { on: false, monthlyMax: null },
  sale: { on: false, priceMax: null },
  rooms: { on: true, monthlyMax: null },
  auction: { on: true, priceMax: null },
  shopAuction: { on: true, priceMax: null, areaMax: null },
  landAuction: { on: true, priceMax: null, areaMax: null },
  aptAuction: { on: true, priceMax: null },
  rentNotices: true,
  trustNotices: true,
  subscriptions: true,
  shopNotices: true,
  landNotices: true,
  priceChanges: true,
  failures: true,
  insideAreas: true,
  captureSites: true,
};

/**
 * 알림 설정을 base 위에 덮어 정리한다. 빠진 값은 base 것을 쓴다.
 * 금액은 1 이상 정수(만원) 또는 null, ''(제한 없음)이고, 아니면 오류를 던진다.
 */
export function normalizeAlerts(input: unknown, base: AlertSettings = DEFAULT_ALERTS): AlertSettings {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const sub = (key: string) => (o[key] && typeof o[key] === 'object' ? o[key] : {}) as Record<string, unknown>;
  const flag = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const amount = (v: unknown, d: number | null) => {
    if (v === undefined) return d;
    if (v === null || v === '') return null;
    if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000_000) return v;
    throw new Error('금액은 만원 단위 정수로 적어 주세요(빈칸은 제한 없음).');
  };
  const size = (v: unknown, d: number | null) => {
    if (v === undefined) return d;
    if (v === null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100_000) return v;
    throw new Error('면적은 숫자로 적어 주세요(빈칸은 제한 없음).');
  };
  const [m, j, s, sa, r, a, sh, la, ap] = ['monthly', 'jeonse', 'short', 'sale', 'rooms', 'auction', 'shopAuction', 'landAuction', 'aptAuction'].map(sub);
  const savedFilter = o.homeFilter === undefined ? base.homeFilter : o.homeFilter === null ? null : normalizeFilters(o.homeFilter);
  const legacy = o.scopeVersion !== 2 && o.homeFilter != null ? savedFilter : null;
  // Keep previous monetary choices once, then edit alert budgets independently.
  const f = savedFilter ? { ...savedFilter, deals: [], areaIds: [], insideAreas: false, distanceMax: null, depositMax: null, monthlyMax: null, priceMax: null } : null;
  return {
    scopeVersion: 2,
    stationAreasOnly: flag(o.stationAreasOnly, base.stationAreasOnly ?? true),
    homeFilter: f,
    monthly: { on: flag(m.on, base.monthly.on), monthlyMax: amount(legacy?.monthlyMax ?? m.monthlyMax, base.monthly.monthlyMax), depositMax: amount(legacy?.depositMax ?? m.depositMax, base.monthly.depositMax) },
    jeonse: { on: flag(j.on, base.jeonse.on), depositMax: amount(legacy?.depositMax ?? j.depositMax, base.jeonse.depositMax) },
    short: { on: flag(s.on, base.short.on), monthlyMax: amount(legacy?.monthlyMax ?? s.monthlyMax, base.short.monthlyMax) },
    sale: { on: flag(sa.on, base.sale.on), priceMax: amount(legacy?.priceMax ?? sa.priceMax, base.sale.priceMax) },
    rooms: { on: flag(r.on, base.rooms.on), monthlyMax: amount(r.monthlyMax, base.rooms.monthlyMax) },
    auction: { on: flag(a.on, base.auction.on), priceMax: amount(a.priceMax, base.auction.priceMax) },
    shopAuction: { on: flag(sh.on, base.shopAuction.on), priceMax: amount(sh.priceMax, base.shopAuction.priceMax), areaMax: size(sh.areaMax, base.shopAuction.areaMax) },
    landAuction: { on: flag(la.on, base.landAuction.on), priceMax: amount(la.priceMax, base.landAuction.priceMax), areaMax: size(la.areaMax, base.landAuction.areaMax) },
    aptAuction: { on: flag(ap.on, base.aptAuction.on), priceMax: amount(ap.priceMax, base.aptAuction.priceMax) },
    rentNotices: flag(o.rentNotices, base.rentNotices),
    trustNotices: flag(o.trustNotices, base.trustNotices),
    subscriptions: flag(o.subscriptions, base.subscriptions),
    shopNotices: flag(o.shopNotices, base.shopNotices),
    landNotices: flag(o.landNotices, base.landNotices),
    priceChanges: flag(o.priceChanges, base.priceChanges),
    failures: flag(o.failures, base.failures),
    insideAreas: flag(o.insideAreas, base.insideAreas),
    captureSites: flag(o.captureSites, base.captureSites),
  };
}

/** 저장된 알림 설정(설정 alert_settings, 없거나 못 읽으면 처음 설정). */
export function alertSettings(): AlertSettings {
  try {
    return normalizeAlerts(JSON.parse(store.getSetting('alert_settings') ?? 'null'));
  } catch {
    return DEFAULT_ALERTS;
  }
}

/** 알림 설정을 바꾼다(준 값만, 나머지는 그대로). 바뀐 전체 설정을 돌려준다. */
export function setAlertSettings(input: unknown): AlertSettings {
  const next = normalizeAlerts(input, alertSettings());
  store.setSetting('alert_settings', JSON.stringify(next));
  return next;
}

/** 새 소식이 보이는 대시보드 탭(App.vue의 탭 이름) */
type NewsTab = 'news' | 'auction' | 'rooms' | 'subs' | 'notices' | 'apt';
const LISTING_TAB: Record<ReturnType<typeof listingSection>, NewsTab> = { home: 'news', auction: 'auction', shop: 'auction', land: 'auction', room: 'rooms' };
const NOTICE_TAB: Record<NoticeSection, NewsTab> = { rent: 'notices', trust: 'auction', subscription: 'subs', shop: 'auction', land: 'auction' };

/** 이번 조회의 새 소식 하나: 신규, 가격 변동 매물(changed: 가격 변동, aptGu: 서울 아파트 탭에서 고른 구의 아파트면 그 구)이나 센 새 공고. */
export type NewsItem =
  | { type: 'listing'; listing: NormalizedListing; changed: boolean; changeType?: 'price_down' | 'price_up' | 'price_changed'; aptGu?: string }
  | { type: 'notice'; source: NoticeSourceId; section: NoticeSection; url: string | null; title: string; near: string | null };

/** 띄울 알림 하나. url: 알림을 누르면 열 주소. */
export interface Alert {
  title: string;
  message: string;
  url: string;
}

/** 알림 줄: 매물 조건(거래 유형, 고시원과 쉐어, 경매)과 공고 */
export type AlertRow =
  | 'monthly' | 'jeonse' | 'short' | 'rooms' | 'rentNotices'
  | 'sale' | 'auction' | 'aptAuction' | 'shopAuction' | 'shopNotices' | 'landAuction' | 'landNotices' | 'trustNotices' | 'subscriptions';
/** 알림 묶음: rent 전월세(알림 하나), buy 매매 목적(따로 알림 하나) */
type Purpose = 'rent' | 'buy';

/** 제목에 적는 순서 */
const ROWS: AlertRow[] = [
  'monthly', 'jeonse', 'short', 'rooms', 'rentNotices', 'sale', 'auction', 'aptAuction', 'shopAuction', 'shopNotices', 'landAuction', 'landNotices', 'trustNotices', 'subscriptions',
];
const PURPOSE: Record<AlertRow, Purpose> = {
  monthly: 'rent', jeonse: 'rent', short: 'rent', rooms: 'rent', rentNotices: 'rent',
  sale: 'buy', auction: 'buy', aptAuction: 'buy', shopAuction: 'buy', shopNotices: 'buy', landAuction: 'buy', landNotices: 'buy', trustNotices: 'buy', subscriptions: 'buy',
};
/** 매매와 전월세 거래 유형 줄(제목이 이것 하나면 '새 매물 N건'으로 적는다) */
const DEAL_ROWS: AlertRow[] = ['monthly', 'jeonse', 'short', 'sale'];
const NOTICE_ROW: Record<NoticeSection, AlertRow> = { rent: 'rentNotices', trust: 'trustNotices', subscription: 'subscriptions', shop: 'shopNotices', land: 'landNotices' };

const rowOn = (row: AlertRow, s: AlertSettings): boolean => {
  const v = s[row];
  return typeof v === 'boolean' ? v : v.on;
};

const upTo = (max: number | null) => (max == null ? '' : ` ${manwon(max)} 이하`);
/** 설정의 면적(㎡)을 평으로('10평', 소수 한 자리) */
const pyeongText = (m2: number) => `${Math.round((m2 / 3.3058) * 10) / 10}평`;

/** 역별 상한이 있으면 공통 금액을 제목에 단정하지 않는다. */
export function rowLabel(row: AlertRow, s: AlertSettings, stationOverrides = false): string {
  const budgets: Partial<Record<AlertRow, string>> = { monthly: '월세', jeonse: '전세', short: '단기', sale: '매매', rooms: '고시원과 쉐어', auction: '경매', aptAuction: '서울 아파트 경매', shopAuction: '상가 경매', landAuction: '토지 경매' };
  if (stationOverrides && budgets[row]) return budgets[row]!;
  switch (row) {
    case 'monthly': return `월세${upTo(s.monthly.monthlyMax)}`;
    case 'jeonse': return `전세${upTo(s.jeonse.depositMax)}`;
    case 'short': return `단기${upTo(s.short.monthlyMax)}`;
    case 'sale': return `매매${upTo(s.sale.priceMax)}`;
    case 'rooms': return `고시원과 쉐어${upTo(s.rooms.monthlyMax)}`;
    case 'auction': return `경매${upTo(s.auction.priceMax)}`;
    case 'aptAuction': return `서울 아파트 경매${upTo(s.aptAuction.priceMax)}`;
    case 'shopAuction': return `상가 경매${upTo(s.shopAuction.priceMax)}${s.shopAuction.areaMax == null ? '' : ` ${pyeongText(s.shopAuction.areaMax)} 이하`}`;
    case 'landAuction': return `토지 경매${upTo(s.landAuction.priceMax)}${s.landAuction.areaMax == null ? '' : ` ${pyeongText(s.landAuction.areaMax)} 이하`}`;
    case 'rentNotices': return '임대 공고';
    case 'trustNotices': return '공매 공고';
    case 'subscriptions': return '청약';
    case 'shopNotices': return '상가 공고';
    case 'landNotices': return '토지 공고';
  }
}

/** 이번 조회가 확인한 알림 줄(새 소식이 없을 때 '조회하기' 알림에 적는다). */
export function coveredRows(sources: SourceId[], notices: NoticeSourceId[]): Set<AlertRow> {
  const rows = new Set<AlertRow>();
  for (const source of sources) {
    const section = listingSection({ source, buildingType: null });
    if (section === 'auction') rows.add('auction').add('aptAuction').add('shopAuction').add('landAuction');
    if (section === 'room') rows.add('rooms');
    if (hasHomeListings(source)) for (const row of DEAL_ROWS) rows.add(row);
  }
  for (const [section, row] of Object.entries(NOTICE_ROW) as [NoticeSection, AlertRow][]) {
    if (notices.some((n) => noticeSourcesOf(section).includes(n))) rows.add(row);
  }
  return rows;
}

/** 매물 사이트의 실패를 알릴 묶음: 경매 사이트는 매매 목적, 나머지는 전월세. */
const sourcePurpose = (source: SourceId): Purpose => (listingSection({ source, buildingType: null }) === 'auction' ? 'buy' : 'rent');


/** 값이 상한 이하인지. 상한이 없거나 값을 모르면 통과(대시보드 필터와 같음). */
const under = (value: number | null, max: number | null) => max == null || value != null && Number.isFinite(value) && value <= max;

/** 켜 둔 매물 알림 줄 중 하나라도 맞는지 */
export const matchesAlert = (l: NormalizedListing, s: AlertSettings, areas: Area[]) => matchingRows(l, s, areas).length > 0;

/**
 * 이 매물이 맞는 켜진 매물 알림 줄. aptGu: 서울 아파트 탭에서 고른 구의 아파트(그 구).
 * 아파트 경매 줄도 공통 알림 구역을 통과해야 한다.
 */
function matchingRows(l: NormalizedListing, s: AlertSettings, areas: Area[], aptGu?: string): AlertRow[] {
  const zones = s.stationAreasOnly !== false ? matchingAlertAreas(l, areas) : [null];
  const rows = new Set<AlertRow>();
  for (const zone of zones) {
    const limits = zone?.alertLimits;
    const own: AlertSettings = limits ? { ...s,
      monthly: { ...s.monthly, monthlyMax: limits.monthlyMax ?? s.monthly.monthlyMax, depositMax: limits.depositMax ?? s.monthly.depositMax },
      jeonse: { ...s.jeonse, depositMax: limits.depositMax ?? s.jeonse.depositMax },
      short: { ...s.short, monthlyMax: limits.monthlyMax ?? s.short.monthlyMax },
      sale: { ...s.sale, priceMax: limits.priceMax ?? s.sale.priceMax },
      rooms: { ...s.rooms, monthlyMax: limits.monthlyMax ?? s.rooms.monthlyMax },
      auction: { ...s.auction, priceMax: limits.priceMax ?? s.auction.priceMax },
      aptAuction: { ...s.aptAuction, priceMax: limits.priceMax ?? s.aptAuction.priceMax },
      shopAuction: { ...s.shopAuction, priceMax: limits.priceMax ?? s.shopAuction.priceMax },
      landAuction: { ...s.landAuction, priceMax: limits.priceMax ?? s.landAuction.priceMax },
    } : s;
    for (const row of nearRows(l, own, [])) rows.add(row);
    const priceOk = l.prices.some((p) => under(p.price, own.aptAuction.priceMax));
    if (aptGu && listingSection(l) === 'auction' && own.aptAuction.on && priceOk && !rows.has('auction')) rows.add('aptAuction');
  }
  return [...rows];
}

/** 매물 탭 필터로 고르는 거래 유형 줄(줄 이름과 거래 유형 이름이 같다) */
const HOME_DEALS = ['monthly', 'jeonse', 'short', 'sale'] as const;

/** 매물 탭 필터의 무옵션만에 쓰는 옵션 정보(저장된 원본에서 읽음) */
function optionsOf(l: NormalizedListing) {
  return optionsRef(l.source, store.listingRaw(`${l.source}:${l.sourceId}`)?.raw ?? null, l.title ?? '');
}

/**
 * 알림 금액과 독립 상세 조건을 판정한다. 지역은 matchingRows에서 역 반경으로 이미 판정했다.
 */
function nearRows(l: NormalizedListing, s: AlertSettings, areas: Area[]): AlertRow[] {
  const section = listingSection(l);
  const f = s.homeFilter;
  const target = { ...l, options: f?.noOptionsOnly ? optionsOf(l) : null };
  const independent = f ? { ...f, areaIds: [], insideAreas: false, distanceMax: null, depositMax: null, monthlyMax: null, priceMax: null } : null;
  const has = (deal: DealType, ok: (p: PriceOption) => boolean) => {
    const prices = section === 'home' && independent ? dealOptions(target, deal, independent, []) : l.prices.filter((p) => p.deal === deal);
    return prices.some(ok);
  };
  if (section === 'auction') {
    return s.auction.on && (s.auction.priceMax == null || l.prices.some((p) => under(p.price, s.auction.priceMax))) ? ['auction'] : [];
  }
  if (section === 'shop' || section === 'land') {
    const row = section === 'shop' ? 'shopAuction' : 'landAuction';
    const { on, priceMax, areaMax } = s[row];
    return on && (priceMax == null || l.prices.some((p) => under(p.price, priceMax))) && under(l.areaM2, areaMax) ? [row] : [];
  }
  if (section === 'room') {
    return s.rooms.on && (s.rooms.monthlyMax == null || has('monthly', (p) => under(p.monthly, s.rooms.monthlyMax))) ? ['rooms'] : [];
  }
  const rows: AlertRow[] = [];
  if (s.monthly.on && has('monthly', (p) => under(p.monthly, s.monthly.monthlyMax) && under(p.deposit, s.monthly.depositMax))) rows.push('monthly');
  if (s.jeonse.on && has('jeonse', (p) => under(p.deposit, s.jeonse.depositMax))) rows.push('jeonse');
  if (s.short.on && has('short', (p) => under(p.monthly, s.short.monthlyMax))) rows.push('short');
  if (s.sale.on && has('sale', (p) => under(p.price, s.sale.priceMax))) rows.push('sale');
  return rows;
}

interface ClickItem {
  url: string | null;
  tab: NewsTab;
}

/** 알림을 누르면 열 곳: 하나면 그 원문, 한 탭에만 있으면 대시보드의 그 탭, 아니면 대시보드. */
function clickTarget(items: ClickItem[]): string {
  if (items.length === 1 && items[0].url) return items[0].url;
  const tabs = [...new Set(items.map((n) => n.tab))];
  return tabs.length === 1 ? `${DASHBOARD_URL}/?tab=${tabs[0]}` : DASHBOARD_URL;
}

/** 이름별 수 '피터팬 2, 집토스 1'(처음 나온 순서) */
function countText(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => `${n} ${c}`).join(', ');
}

/**
 * 조회가 끝났을 때 띄울 알림. 켜 둔 알림 줄에 맞는 것만 센다.
 * 전월세(월세, 전세, 단기, 고시원과 쉐어, 임대 공고)와 매매 목적(매매, 경매, 공매 공고, 청약)을 따로 띄운다.
 * 제목은 줄마다 'N건'(줄이 매매와 전월세 하나뿐이면 '월세 50만 이하 새 매물 3건'), 아래는 사이트별 수, 공고 곳별 수, 가격 변동, 실패.
 * 새 임대 공고 중 켜 둔 지역 바로 근처일 가능성이 높은 것(near)은 제목에 '(근처 N)', 아래 첫 줄에 '근처 공고: 공고 제목'.
 * 가격 변동은 바뀐 뒤 가격이 켜 둔 줄에 맞는 매물만 센다. quiet면 새 소식이 없을 때 띄우지 않고,
 * 아니면 아무것도 없을 때 '조회 끝: 새 소식 없음'과 이번에 확인한 켜 둔 줄을 띄운다.
 */
export function buildAlerts(input: {
  news: NewsItem[];
  sources: RunSourceSummary[];
  areas: Area[];
  settings: AlertSettings;
  quiet: boolean;
  covered: Set<AlertRow>;
}): Alert[] {
  const s = input.settings;
  const stationOverrides = input.areas.some((a) => a.enabled && a.purpose === 'alert' && a.alertLimits && Object.values(a.alertLimits).some((v) => v != null));
  const group = () => ({
    rows: new Map<AlertRow, ClickItem[]>(), newSites: [] as string[], changed: [] as ClickItem[], changedSites: [] as string[], noticeSources: [] as string[], failed: [] as string[],
    /** 켜 둔 지역 바로 근처일 가능성이 높은 새 임대 공고 제목 */
    near: [] as string[],
  });
  const groups = { rent: group(), buy: group() };
  const count = (row: AlertRow, item: ClickItem) => {
    const rows = groups[PURPOSE[row]].rows;
    rows.set(row, [...(rows.get(row) ?? []), item]);
  };

  const counted = new Set<string>();
  for (const n of input.news) {
    if (n.type === 'notice') {
      const row = NOTICE_ROW[n.section];
      if (!rowOn(row, s)) continue;
      count(row, { url: n.url, tab: NOTICE_TAB[n.section] });
      groups[PURPOSE[row]].noticeSources.push(NOTICE_SHORT[n.source]);
      if (row === 'rentNotices' && n.near) groups[PURPOSE[row]].near.push(n.title);
      continue;
    }
    const l = n.listing;
    const rows = matchingRows(l, s, input.areas, n.aptGu);
    if (rows.length === 0 || (n.changed && (!s.priceChanges || n.changeType !== 'price_down'))) continue;
    const key = `${l.source}:${l.sourceId}`;
    if (counted.has(key)) continue;
    counted.add(key);
    // 법원경매 주소는 검색 화면이라 물건은 대시보드 경매 탭(서울 아파트 경매 줄만 맞으면 서울 아파트 탭)에서 연다.
    const tab: NewsTab = rows.every((r) => r === 'aptAuction') ? 'apt' : LISTING_TAB[listingSection(l)];
    const item = { url: l.source === 'courtauction' ? null : l.url, tab };
    for (const purpose of new Set(rows.map((r) => PURPOSE[r]))) {
      const g = groups[purpose];
      if (n.changed) {
        g.changed.push(item);
        g.changedSites.push(SOURCE_LABEL[l.source]);
      } else g.newSites.push(SOURCE_LABEL[l.source]);
    }
    if (!n.changed) for (const row of rows) count(row, item);
  }
  if (s.failures) {
    for (const src of input.sources) {
      if (src.status === 'ok') continue;
      const part = src.error?.startsWith('일부를 보지 못함') ? '(일부)' : '';
      groups[sourcePurpose(src.source)].failed.push(`${SOURCE_LABEL[src.source]}${part}`);
    }
  }

  const alerts: Alert[] = [];
  for (const purpose of ['rent', 'buy'] as const) {
    const g = groups[purpose];
    const parts = ROWS.filter((row) => g.rows.has(row)).map((row) => ({ row, label: rowLabel(row, s, stationOverrides), items: g.rows.get(row)! }));
    if (parts.length === 0 && g.changed.length === 0 && g.failed.length === 0) continue;
    const head = parts.length
      ? parts.length === 1 && DEAL_ROWS.includes(parts[0].row)
        ? `${parts[0].label} 새 매물 ${parts[0].items.length}건`
        : parts.map((p) => `${p.label} ${p.items.length}건${p.row === 'rentNotices' && g.near.length ? `(근처 ${g.near.length})` : ''}`).join(', ')
      : g.changed.length
        ? `가격 변동 ${g.changed.length}건`
        : `수집 실패 ${g.failed.length}곳`;
    const f = s.homeFilter;
    // 거래 유형 줄이 있으면 매물 탭 필터의 나머지 조건(제목에 없는 보증금 범위와 평, 유형 등)을 한 줄로
    const conditions = f && parts.some((p) => DEAL_ROWS.includes(p.row))
      ? filterSummary({ ...f, insideAreas: true, areaIds: [], distanceMax: null }, [], false)
      : [];
    const lines = [
      s.stationAreasOnly !== false && (g.newSites.length || g.changed.length) ? '알림 구역 안 · 공통 또는 역별 금액 조건 충족' : '',
      g.near.length ? `근처 공고: ${g.near.map((t) => (t.length > 30 ? `${t.slice(0, 30)}…` : t)).join(', ')}` : '',
      countText(g.newSites),
      conditions.length ? `조건: ${conditions.join(', ')}` : '',
      countText(g.noticeSources),
      g.changed.length ? (parts.length ? `가격 변동 ${g.changed.length}` : countText(g.changedSites)) : '',
      g.failed.length ? `실패 ${g.failed.length}곳: ${g.failed.join(', ')}` : '',
    ].filter(Boolean);
    alerts.push({
      title: purpose === 'buy' ? `매매 목적: ${head}` : head,
      message: lines.join('\n') || head,
      url: parts.length ? clickTarget(parts[0].items) : g.changed.length ? clickTarget(g.changed) : `${DASHBOARD_URL}/?tab=runs`,
    });
  }

  if (!input.quiet && alerts.length === 0) {
    const on = ROWS.filter((row) => rowOn(row, s) && input.covered.has(row)).map((row) => rowLabel(row, s, stationOverrides));
    alerts.push({ title: '조회 끝: 새 소식 없음', message: on.length ? `켜 둔 알림: ${on.join(', ')}` : '켜 둔 알림 없음', url: DASHBOARD_URL });
  }
  return alerts;
}
