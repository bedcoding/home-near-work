import { alertSettings, buildAlerts, coveredRows, type NewsItem } from './alerts.js';
import { BrowserSession, restSeconds, type BadgeTone } from './browser.js';
import { gusFor, nearNamesFor } from './collectors/gus.js';
import { COLLECTORS } from './collectors/index.js';
import { NOTICE_COLLECTORS, type NoticeCollector } from './collectors/notices.js';
import { BlockedError, type CollectContext, type CollectedItem, type Collector } from './collectors/types.js';
import { COLLECT_MARGIN_M } from './config.js';
import { collectCourtClaims } from './court-claims.js';
import { collectCourtResults, courtResultsDue } from './court-results.js';
import * as store from './db.js';
import { collectHouseTrades, HOUSE_TRADES_SOURCE, houseTradesDue } from './house-trades.js';
import { collectRentTrades, RENT_TRADES_SOURCE, rentTradesDue } from './rent-trades.js';
import { APT_TRADES_SOURCE, aptRecentDue, aptTradesDue, collectAptTrades } from './apt-trades.js';
import { collectKbStats, KB_SOURCE, kbStatsDue } from './kb-stats.js';
import { collectPeakSources, PEAK_SOURCE, peakSourcesDue } from './peak-sources.js';
import { collectRegionVolume, REGION_VOLUME_SOURCE, regionVolumeDue } from './region-volume.js';
import { fillHouseholds, REGISTRY_SOURCE, registryKey } from './building-register.js';
import { checkZones, vworldKey, ZONE_SOURCE } from './land-zones.js';
import { updateZonesWith, ZONES_SOURCE, zoneUpdateDue } from './redev-zones-update.js';
import { lineAreas, setLineView } from './line-areas.js';
import { distanceM, nearestArea } from './geo.js';
import { comparePrices, identityKey, priceSignature } from './identity.js';
import { notify } from './notify.js';
import { priceText } from '../shared/format.js';
import { collectionAreas, primaryAreas, selectedArea } from '../shared/regions.js';
import {
  inGus, listingSection, nearReason, noticeSection, noticeSourcesOf, regionalSection, RUN_PARALLEL_SITES, RUN_SCOPES, SEOUL_GUS, SOURCE_LABEL,
  type Area, type CollectionCoverage, type NormalizedListing, type RunProgress, type RunScope, type RunSiteProgress, type RunSourceSummary, type RunSummary, type SourceId,
} from '../shared/types.js';

let current: (RunProgress & { log: string[]; session: BrowserSession | null }) | null = null;

export const getProgress = (): RunProgress | null =>
  current
    ? { runId: current.runId, message: current.message, log: current.log.slice(-300), stopping: current.stopping, coverage: current.coverage, sites: current.sites, noticeCount: current.noticeCount }
    : null;

/** 조회 범위(scope, 없으면 전부)에서 돌 매물 사이트와 공고 곳. 공고만 확인은 매물 사이트 없이 공고 전부. */
export function runPlan(scope: RunScope | undefined, noticesOnly: boolean) {
  const def = noticesOnly ? undefined : RUN_SCOPES.find((s) => s.id === scope);
  const collectors = noticesOnly ? [] : def ? COLLECTORS.filter((c) => def.sources.includes(c.id)) : COLLECTORS;
  const notices = def ? NOTICE_COLLECTORS.filter((nc) => def.sections.some((s) => noticeSourcesOf(s).includes(nc.id))) : NOTICE_COLLECTORS;
  return { def, collectors, notices };
}

/**
 * 조회를 시작한다. scope를 주면 그 탭에 보이는 매물 사이트와 공고만 돈다(RUN_SCOPES, 없으면 전부).
 * auto: 자동 확인으로 시작한 조회(조회 기록의 방식 '자동').
 * quiet: 끝나면 새 소식이나 실패가 있을 때만 알림을 띄운다(아니면 새 소식이 없어도 '조회 끝: 새 소식 없음'을 띄움).
 * noticesOnly: 매물 사이트는 돌지 않고 공고만 모은다(법원경매 매각 결과를 모은 지 오래됐으면 그것도). 켜 둔 지역 바로 근처일
 * 가능성이 높은 새 임대 공고만 바로 알리고, 나머지 새 공고는 미뤄 두었다가 다음 알림(공고만 확인이 아닌 조회)에 넣는다.
 */
export function startRun(visible: boolean, scope?: RunScope, options: { auto?: boolean; quiet?: boolean; noticesOnly?: boolean } = {}): number {
  if (current) throw new Error('이미 조회 중입니다.');
  // 구나 동과 지하철역을 둘 다 넘긴다. 사이트마다 쓸 수 있는 쪽을 쓴다(다방은 구 경계나 반경 범위, 직방, 집토스, 피터팬은 역 기준).
  const areas = collectionAreas(store.enabledAreas());
  if (areas.length === 0) throw new Error('켜진 지역이 없습니다. 지역 탭에서 하나 이상 켜 주세요.');
  const noticesOnly = !!options.noticesOnly;
  const { def, collectors, notices } = runPlan(scope, noticesOnly);
  if (collectors.length === 0 && notices.length === 0) throw new Error('조회할 사이트가 없습니다.');
  const auto = !!options.auto;
  const runId = store.createRun(visible, auto, noticesOnly, def?.id ?? null);
  current = { runId, message: '조회용 브라우저를 여는 중', log: [], stopping: false, session: null, sites: waitingSites(collectors), noticeCount: notices.length };
  void execute(runId, visible, areas, { collectors, notices, scope: def ?? null }, { auto, quiet: !!options.quiet, noticesOnly });
  return runId;
}

/** 도는 매물 사이트를 모두 '대기'로 */
const waitingSites = (collectors: Collector[]): RunSiteProgress[] => collectors.map((c) => ({ source: c.id, status: 'waiting', message: null }));

/** 노선 탭 '이 노선 조회하기'가 도는 매물 사이트(역 위치로 찾는 곳) */
export const LINE_SOURCES: SourceId[] = ['ziptoss', 'peterpanz'];

/**
 * 노선 탭 '이 노선 조회하기': 그 노선 역(반경 radiusM)만 매물 사이트(집토스, 피터팬)로 돈다. 노선 탭에서 고른 노선도 이것으로 바꾼다.
 * 켜진 지역(회사 근처), 공고, 실거래, 시세 자료는 건드리지 않고, 신규로 치지 않으며(역마다 처음 본 것도 기준만) 알림도 띄우지 않는다.
 */
export function startLineRun(visible: boolean, line: string, radiusM: number): number {
  if (current) throw new Error('이미 조회 중입니다.');
  setLineView(line, radiusM);
  const areas = lineAreas(line, radiusM);
  const collectors = COLLECTORS.filter((c) => LINE_SOURCES.includes(c.id));
  if (!collectors.length) throw new Error('조회할 사이트가 없습니다.');
  const runId = store.createRun(visible, false, false, null, line);
  current = { runId, message: '조회용 브라우저를 여는 중', log: [], stopping: false, session: null, sites: waitingSites(collectors), noticeCount: 0 };
  void execute(runId, visible, areas, { collectors, notices: [], scope: null, line }, { auto: false, quiet: true, noticesOnly: false });
  return runId;
}

/** 공고만 확인에서 바로 알리지 않고 미뤄 둔 새 공고(설정 deferred_notice_news, 많아야 300개). */
const DEFERRED_KEY = 'deferred_notice_news';
function deferNotices(items: NewsItem[]) {
  if (!items.length) return;
  const before = JSON.parse(store.getSetting(DEFERRED_KEY) ?? '[]') as NewsItem[];
  store.setSetting(DEFERRED_KEY, JSON.stringify([...before, ...items].slice(-300)));
}
/** 미뤄 둔 새 공고를 꺼내고 비운다. */
function takeDeferredNotices(): NewsItem[] {
  const items = JSON.parse(store.getSetting(DEFERRED_KEY) ?? '[]') as NewsItem[];
  if (items.length) store.setSetting(DEFERRED_KEY, '[]');
  return items;
}

export const isRunning = () => current !== null;

/** 조회를 멈춘다. 조회용 브라우저를 닫아 하던 사이트를 끊고 남은 사이트, 공고는 건너뛴다. 이미 다 모은 사이트 결과는 그대로 둔다. */
export function stopRun() {
  if (!current) throw new Error('조회 중이 아닙니다.');
  current.stopping = true;
  current.message = '조회를 멈추는 중';
  void current.session?.close();
}

/** 지역 반경(+여유) 안에 있는 가장 가까운 지역. 밖이면 null. */
export function coveringArea(areas: Area[], lat: number | null, lng: number | null): Area | null {
  if (lat == null || lng == null) return null;
  let best: { area: Area; ratio: number } | null = null;
  for (const area of areas) {
    const d = distanceM(area.lat, area.lng, lat, lng);
    if (d > area.radiusM + COLLECT_MARGIN_M) continue;
    const ratio = d / area.radiusM;
    if (!best || ratio < best.ratio) best = { area, ratio };
  }
  return best?.area ?? null;
}

function classify(listings: NormalizedListing[]): Map<string, BadgeTone> {
  const verdicts = store.allVerdicts();
  const byListing = new Map(verdicts.map((v) => [v.listing_id, v.verdict]));
  const discardedKeys = new Set(verdicts.filter((v) => v.verdict === 'discard').map((v) => v.identity_key));
  const tones = new Map<string, BadgeTone>();
  for (const l of listings) {
    const id = `${l.source}:${l.sourceId}`;
    const verdict = byListing.get(id);
    if (verdict === 'discard' || (!verdict && discardedKeys.has(identityKey(l)))) tones.set(l.sourceId, 'discard');
    else if (verdict === 'star') tones.set(l.sourceId, 'star');
    else tones.set(l.sourceId, store.getListing(id) ? 'seen' : 'new');
  }
  return tones;
}

export interface ApplyOptions {
  /** Explicit verified target scope. Non-target rows are retained without new-listing alerts. */
  admit?: (listing: NormalizedListing) => boolean;
  /**
   * 새로 본 매물을 '신규'로 칠지 정하는 기준을 바꾼다. 주면 지역 기준점 대신 이 함수가 true를 준 매물만 기준점(신규 아님)으로 둔다.
   * 네이버처럼 보는 만큼씩 조금씩 들어오는 소스에 쓴다.
   */
  isBaseline?: (listing: NormalizedListing) => boolean;
  /**
   * '같은 집 키'가 버린 매물과 같을 때 재등록으로 보고 숨길지. false를 준 매물은 숨기지 않는다(비슷함 배지만 붙는다).
   * 네이버는 층이 '고, 중, 저'로만 나오는 경우가 많아, 층을 모르면 다른 집을 같은 집으로 볼 수 있다.
   */
  allowRelistHide?: (listing: NormalizedListing) => boolean;
  status?: RunSourceSummary['status'];
  /** 다 돌았을 때 안 보인 매물을 반경 밖(모은 범위)까지 사라짐으로 둔다. 기본은 반경 안만. */
  goneOutsideRadius?: boolean;
  /** 매물을 실제로 본 시각. 네이버는 확장이 응답을 받은 시각을 준다(대시보드가 꺼져 있다가 나중에 받아도 본 시각이 맞게). */
  seenAt?: string;
  /** 주면 신규, 가격 변동 매물을 여기에 더한다(버린 매물의 가격 변동은 빼고). */
  news?: NewsItem[];
}

/**
 * 받은 매물을 저장하고 신규, 가격 변동, 재등록을 판정한다. 모든 소스가 이 함수 하나를 거친다.
 * 정상적으로 읽은 매물은 주변 지역도 보관한다. 수집 지역은 기본 목록에, 별도의 역 반경은 알림에 적용한다.
 */
export function applyResults(
  runId: number,
  source: SourceId,
  items: CollectedItem[],
  areas: Area[],
  complete: boolean,
  error?: string,
  options: ApplyOptions = {},
): RunSourceSummary {
  const status = options.status ?? (complete ? 'ok' : 'error');
  const summary: RunSourceSummary = { source, status, fetched: items.length, kept: 0, newCount: 0, priceChanged: 0, relisted: 0, baselineAreas: [], error };
  // 기준점은 소스와 지역마다 둔다. 경매의 상가와 토지는 '<소스>:shop', '<소스>:land'로 따로 둔다(나중에 모으기 시작해도 처음 것은 기준만).
  // 지역 밖에서 모은 고른 구의 아파트는 '<소스>:apt'로 구마다 둔다(자리 번호 store.aptSpot, 구를 새로 고르면 그 구의 처음 것은 기준만).
  const baseKeyOf = (l: NormalizedListing) => {
    const section = listingSection(l);
    return section === 'shop' || section === 'land' ? `${source}:${section}` : source;
  };
  /** '기준점 키|자리 번호' → 이번 조회 전에 그 자리에 기준점이 없었는지(자리는 켜진 지역 번호나 store.aptSpot) */
  const lackCache = new Map<string, boolean>();
  const lacks = (key: string, spot: number) => {
    const k = `${key}|${spot}`;
    let v = lackCache.get(k);
    if (v === undefined) {
      v = !store.hasBaseline(key, spot);
      lackCache.set(k, v);
    }
    return v;
  };
  /** '기준점 키|자리 번호' → 이번에 그 자리에 저장한 매물 수 */
  const keptPerKey = new Map<string, number>();
  /** keptPerKey 키를 기준점 키와 자리 번호로 */
  const splitKey = (k: string): [string, number] => [k.slice(0, k.lastIndexOf('|')), Number(k.slice(k.lastIndexOf('|') + 1))];
  const discarded = store.allVerdicts().filter((v) => v.verdict === 'discard');
  const discardedByKey = new Map(discarded.map((v) => [v.identity_key, v.listing_id]));
  const discardedIds = new Set(discarded.map((v) => v.listing_id));
  const unique = new Map(items.map((item) => [item.listing.sourceId, item]));
  const seen = new Set<string>();
  const keptPerArea = new Map<number, number>();

  store.db.transaction(() => {
    for (const { listing, raw, pageUrl, screenshot, aptGu } of unique.values()) {
      const area = selectedArea(listing, areas, COLLECT_MARGIN_M);
      const admitted = options.admit?.(listing);
      const target = admitted ?? (!!area || !!aptGu);
      if (!target) summary.incidentalCount = (summary.incidentalCount ?? 0) + 1;
      summary.kept += 1;
      const baseKey = area || admitted || !aptGu ? baseKeyOf(listing) : `${source}:apt`;
      const spot = area ? area.id : aptGu ? store.aptSpot(aptGu) : 0;
      keptPerKey.set(`${baseKey}|${spot}`, (keptPerKey.get(`${baseKey}|${spot}`) ?? 0) + 1);
      const id = `${source}:${listing.sourceId}`;
      seen.add(id);
      const key = identityKey(listing);
      const sig = priceSignature(listing.prices);
      const ref = { runId, pageUrl, screenshot };
      const existing = store.getListing(id);

      if (existing) {
        const before = (JSON.parse(existing.data) as NormalizedListing).prices;
        const change = existing.price_sig !== sig ? comparePrices(before, listing.prices) : null;
        store.updateListingSeen(id, listing, key, sig, runId, ref, !!change, raw, options.seenAt);
        if (change) {
          store.addEvent(runId, id, change, { before, after: listing.prices });
          summary.priceChanged += 1;
          if (!discardedIds.has(id)) options.news?.push({ type: 'listing', listing, changed: true, changeType: change, aptGu });
        }
        continue;
      }

      store.insertListing(id, listing, key, sig, runId, ref, raw, options.seenAt);
      const original = options.allowRelistHide && !options.allowRelistHide(listing) ? undefined : discardedByKey.get(key);
      if (original) {
        // 버림한 매물과 같은 집 키 → 재등록으로 보고 숨김함에 넣는다(되돌릴 수 있음).
        store.setVerdict(id, 'discard', `relisted:${original}`);
        store.addEvent(runId, id, 'relisted_hidden', { original });
        summary.relisted += 1;
      } else if (options.isBaseline ? !options.isBaseline(listing) : !lacks(baseKey, spot)) {
        store.addEvent(runId, id, 'new');
        summary.newCount += 1;
        options.news?.push({ type: 'listing', listing, changed: false, aptGu });
      }
    }

    if (complete) {
      // 이번에 다 돌았는데 안 보인 매물은 '사라짐'으로 둔다.
      const gone = store
        .allListings()
        .filter((r) => r.source === source && r.status === 'active' && !seen.has(r.id))
        .filter((r) => {
          const listing = r.data ? JSON.parse(r.data) as NormalizedListing : r;
          return options.goneOutsideRadius || (options.admit ? options.admit(listing as NormalizedListing) : !!selectedArea(listing, areas));
        })
        .map((r) => r.id);
      store.markGone(gone);
    }
    // 기준점은 이번에 실제로 매물을 받은 자리만 저장한다(못 받았는데 저장하면 다음 조회에서 전부 '신규'가 된다).
    if (!options.isBaseline) {
      for (const k of keptPerKey.keys()) {
        const [key, spot] = splitKey(k);
        if (lacks(key, spot)) store.setBaseline(key, spot, runId);
      }
    }
  })();
  if (!options.isBaseline) {
    /** 이번에 새로 기준을 잡은 [기준점 키, 자리 번호] */
    const fresh = [...keptPerKey.keys()].map(splitKey).filter(([key, spot]) => lacks(key, spot));
    summary.baselineAreas = [
      ...areas
        .filter((a) => fresh.some(([, spot]) => spot === a.id))
        .map((a) => {
          const keys = fresh.filter(([, spot]) => spot === a.id).map(([key]) => key);
          // 주거 기준점 없이 상가나 토지만 새로 기준을 잡았으면 이름 뒤에 표시한다.
          const kinds = [...new Set(keys.map((k) => (k.endsWith(':shop') ? '상가' : k.endsWith(':land') ? '토지' : '')))];
          return kinds.includes('') ? a.name : `${a.name}(${kinds.join(', ')})`;
        }),
      ...SEOUL_GUS.filter((gu) => fresh.some(([, spot]) => spot === store.aptSpot(gu))).map((gu) => `${gu} 아파트`),
    ];
  }
  return summary;
}

/**
 * 공고 수집기를 차례로 돌려 저장한다. 곳마다 실패해도 나머지는 계속한다.
 * stopped()가 참이 되면 거기서 멈추고, 멈출 때 하던 곳은 결과를 남기지 않는다.
 * 센 새 공고를 news에 더한다. 임대 공고는 켜진 지역 근처 구(또는 구를 모르는 공고)만 센다(화면도 그것만 보인다).
 */
async function collectNotices(
  ctx: CollectContext,
  areas: Area[],
  collectors: NoticeCollector[],
  log: (message: string) => void,
  stopped: () => boolean,
  news: NewsItem[],
) {
  const gus = gusFor(areas);
  const names = nearNamesFor(areas);
  let complete = true;
  let retryable = false;
  for (const nc of collectors) {
    if (stopped()) return { complete: false, retryable: false };
    const at = new Date().toISOString();
    const missed: string[] = [];
    try {
      const items = await nc.collect({ ...ctx, partial: (reason, retry = true) => { missed.push(reason); retryable ||= retry; } }, gus);
      if (stopped()) return { complete: false, retryable: false };
      const saved = store.saveNotices(nc.id, items, at);
      const error = missed.length ? `일부를 보지 못함: ${[...new Set(missed)].join(', ')}` : null;
      if (error) complete = false;
      store.setNoticeStatus(nc.id, { at, ok: !error, count: items.length, error });
      if (error) log(`${nc.label}: ${error}`);
      for (const n of saved.added) {
        const section = noticeSection({ source: nc.id, kind: n.kind });
        if (regionalSection(section) && !inGus(n.regions ?? [], gus)) continue;
        news.push({ type: 'notice', source: nc.id, section, url: n.url, title: n.title, near: nearReason(n, gus, names) });
      }
      log(`${nc.label}: ${items.length}건${saved.baseline ? ', 처음이라 기준으로만 저장' : `, 새 공고 ${saved.added.length}`}`);
    } catch (e) {
      if (stopped()) return { complete: false, retryable: false };
      complete = false;
      retryable = true;
      const error = e instanceof Error ? e.message.split('\n')[0] : String(e);
      store.setNoticeStatus(nc.id, { at, ok: false, count: 0, error });
      log(`${nc.label} ${e instanceof BlockedError ? '차단' : '오류'}: ${error}`);
    }
  }
  return { complete, retryable };
}

/** plan: 돌 매물 사이트와 공고 곳. scope가 있으면 탭 하나만 도는 조회(RUN_SCOPES의 한 줄), line이 있으면 노선 탭의 노선 역만 도는 조회. */
async function execute(
  runId: number,
  visible: boolean,
  areas: Area[],
  plan: { collectors: Collector[]; notices: NoticeCollector[]; scope: (typeof RUN_SCOPES)[number] | null; line?: string },
  mode: { auto: boolean; quiet: boolean; noticesOnly: boolean },
) {
  const { auto, quiet, noticesOnly } = mode;
  const { collectors } = plan;
  const state = current!;
  const log = (message: string) => {
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    state.log.push(`${time} ${message}`);
    console.log(`[조회 ${runId}] ${message}`);
  };
  const summaries: RunSourceSummary[] = [];
  const news: NewsItem[] = [];
  let session: BrowserSession | null = null;
  let noticesComplete = false;
  let retryable = false;

  const finish = (status: 'done' | 'error' | 'stopped', errorMessage: string | null) => {
    const tidy = store.tidyListings();
    if (tidy.stale) log(`네이버, 다방, 직방에서 14일 넘게 다시 못 본 매물 ${tidy.stale}건을 사라짐으로 둠`);
    if (tidy.purged) log(`사라진 지 오래된 매물 ${tidy.purged}건을 지움`);
    const summary: RunSummary = {
      sources: summaries,
      newCount: summaries.reduce((n, s) => n + s.newCount, 0),
      changedCount: summaries.reduce((n, s) => n + s.priceChanged, 0),
      complete: status === 'done' && noticesComplete && summaries.every((s) => s.status === 'ok' && !s.error),
      retryable,
    };
    store.finishRun(runId, status, summary, errorMessage, state.log);
    return summary;
  };

  try {
    const only = noticesOnly ? '공고만, ' : plan.scope ? `${plan.scope.label} 탭만(${[...collectors, ...plan.notices].map((c) => c.label).join(', ')}), ` : '';
    const sitesText = collectors.length
      ? `매물 사이트 ${collectors.length}곳(${collectors.map((c) => c.label).join(', ')})을 ${Math.min(RUN_PARALLEL_SITES, collectors.length)}곳씩 동시에, 공고 ${plan.notices.length}곳, `
      : '';
    const where = plan.line
      ? `${plan.line} 노선 역 ${areas.length}곳(반경 ${areas[0]?.radiusM ?? 0}m, ${collectors.map((c) => c.label).join(', ')})`
      : `지역: ${areas.map((a) => a.region ? `${a.name} ${a.region.kind === 'gu' ? '구 전체' : '법정동'}` : `${a.name} ${a.radiusM}m`).join(', ')}`;
    log(`조회 시작, ${auto ? '자동 확인, ' : ''}${only}${sitesText}${where}, ${visible ? '보면서 조회' : '조용히 조회'}, 역, 지역, 구 사이 ${restSeconds()}초 쉼`);
    session = await BrowserSession.open(runId, visible);
    state.session = session;
    // 브라우저를 여는 사이에 멈춤을 눌렀으면 바로 닫는다.
    if (state.stopping) await session.close();
    const runCoverage = new Map<string, CollectionCoverage>();
    const rootSession = session;
    /** 브라우저 탭(tab)마다 쓰는 수집 맥락. site를 주면 그 사이트의 진행, 일부 못 봄, 범위 확인을 그 사이트 몫으로 받는다. */
    const makeCtx = (
      tab: BrowserSession,
      site?: { progress: RunSiteProgress; missed: string[]; coverage: Map<string, { row: CollectionCoverage; ids: string[] }> },
    ): CollectContext => ({
      runId,
      areas,
      session: tab,
      log,
      classify,
      stopped: () => state.stopping,
      coverage: (row, ids) => {
        if (!site) return;
        const scoped = { ...row, source: site.progress.source };
        site.coverage.set(`${row.areaId}:${row.category}`, { row: scoped, ids });
        runCoverage.set(`${site.progress.source}:${row.areaId}:${row.category}`, scoped);
        state.coverage = [...runCoverage.values()];
      },
      progress: (message: string) => {
        if (site) {
          site.progress.message = message;
          updateMessage();
        } else state.message = message;
        void tab.banner(message);
      },
      // 노선 조회는 서울 아파트 탭의 고른 구를 모으지 않는다.
      aptGus: plan.line ? [] : store.aptGus(),
      partial: (reason: string, retry = true) => {
        site?.missed.push(reason);
        retryable ||= retry;
      },
    });
    /** 사이트 진행을 한 줄로(몇 곳 끝났고 지금 어디를 도는지) */
    const updateMessage = () => {
      const sites = state.sites ?? [];
      const doing = sites.filter((s) => s.status === 'running').map((s) => SOURCE_LABEL[s.source]);
      const ended = sites.filter((s) => s.status === 'done' || s.status === 'error').length;
      state.message = doing.length
        ? `매물 사이트 ${sites.length}곳 중 ${ended}곳 끝, 지금 ${doing.join(', ')}`
        : `매물 사이트 ${sites.length}곳 중 ${ended}곳 끝`;
    };

    /** 사이트 하나를 돈다. 사이트마다 조회용 브라우저 탭을 따로 열어 쓰고, 끝나면 닫는다. */
    const runOne = async (collector: Collector, progress: RunSiteProgress): Promise<RunSourceSummary> => {
      const missed: string[] = [];
      const coverage = new Map<string, { row: CollectionCoverage; ids: string[] }>();
      let items: CollectedItem[] = [];
      let complete = true;
      let error: string | undefined;
      let tab: BrowserSession | null = null;
      progress.status = 'running';
      progress.message = '조회용 탭을 여는 중';
      updateMessage();
      log(`${collector.label}: 시작`);
      try {
        tab = await rootSession.fork();
        items = await collector.collect(makeCtx(tab, { progress, missed, coverage }));
        if (areas.some((area) => area.region) && ['ziptoss', 'peterpanz'].includes(collector.id)) {
          missed.push('역과 지도 범위에서 받은 매물은 저장했으나 선택한 구나 동 전체를 다 봤는지는 보장하지 않습니다');
        }
        if (state.stopping) {
          // 멈추는 사이에 받은 것은 저장하되 다 돈 것으로 보지 않는다('사라짐' 처리를 하지 않는다).
          complete = false;
          error = '중단함';
          log(`${collector.label}: 중단함`);
        } else if (items.length === 0 && !collector.emptyOk) {
          // 0건은 사이트 구조가 바뀌었을 가능성이 커서 실패로 본다('사라짐' 처리도 하지 않는다).
          complete = false;
          retryable = true;
          error = '받은 매물이 0건입니다. 사이트 화면 구조가 바뀌었을 수 있습니다.';
          log(`${collector.label} 경고: ${error}`);
        } else if (missed.length) {
          // 일부를 못 봤으면 받은 것은 저장하되 '사라짐' 처리는 하지 않고 미완료로 알린다.
          complete = false;
          error = `일부를 보지 못함: ${[...new Set(missed)].join(', ')}`;
          log(`${collector.label}: ${error}`);
        }
      } catch (e) {
        complete = false;
        retryable = true;
        // Playwright 오류는 뒤에 브라우저 기록이 여러 줄 붙어서 첫 줄만 남긴다.
        error = state.stopping ? '중단함' : e instanceof Error ? e.message.split('\n')[0] : String(e);
        log(state.stopping ? `${collector.label}: 중단함` : `${collector.label} ${e instanceof BlockedError ? '차단' : '오류'}: ${error}`);
      } finally {
        await tab?.closePage();
      }
      const summary = applyResults(runId, collector.id, items, areas, complete && !collector.retainMissing, error, {
        goneOutsideRadius: !plan.line && collector.wholeDistrict,
        // 노선 조회는 역마다 처음 본 것만이 아니라 모두 기준으로 둔다(회사 근처 신규 알림과 섞이지 않게).
        isBaseline: plan.line ? () => true : undefined,
        news,
        status: complete ? 'ok' : 'error',
      });
      if (coverage.size) {
        summary.coverage = [...coverage.values()].map(({ row, ids }) => {
          const stored = ids.filter(id => store.getListing(`${collector.id}:${id}`)?.last_seen_run === runId).length;
          const saved = stored === ids.length;
          return { ...row, stored, storageChecked: true, complete: row.complete && saved,
            reason: saved ? row.reason : `${row.reason}, 서버 저장 ${stored}/${ids.length}건 확인` };
        });
        for (const row of summary.coverage) runCoverage.set(`${collector.id}:${row.areaId}:${row.category}`, row);
        state.coverage = [...runCoverage.values()];
        if (summary.coverage.some(row => row.stored !== coverage.get(`${row.areaId}:${row.category}`)!.ids.length)) retryable = true;
        if (summary.coverage.some(row => !row.complete)) {
          summary.status = 'error';
          summary.error ||= '일부 범위의 목록 또는 서버 저장을 확인하지 못했습니다';
        }
        const storedScopes = summary.coverage.filter(row => row.total != null && row.pages > 0 && row.stored === coverage.get(`${row.areaId}:${row.category}`)!.ids.length).length;
        log(`${collector.label}: 서버 저장 검증 ${storedScopes}/${summary.coverage.length}개, 전체 목록 확인 ${summary.coverage.filter(row => row.complete).length}/${summary.coverage.length}개`);
      }
      const baseline = summary.baselineAreas.length ? `, 기준점 저장: ${summary.baselineAreas.join(', ')}` : '';
      log(`${collector.label}: 받은 ${summary.fetched}건, 저장 ${summary.kept}건(주변이나 지역 미확인 ${summary.incidentalCount ?? 0}건), 신규 ${summary.newCount}, 가격 변동 ${summary.priceChanged}, 재등록 숨김 ${summary.relisted}${baseline}`);
      progress.status = summary.status === 'ok' && !summary.error ? 'done' : 'error';
      progress.message = summary.error ?? `${summary.kept}건, 신규 ${summary.newCount}`;
      updateMessage();
      return summary;
    };

    // 매물 사이트는 RUN_PARALLEL_SITES곳씩 동시에 돈다(사이트마다 탭 하나). 한 곳이 끝나면 다음 사이트를 시작한다.
    const results: RunSourceSummary[] = [];
    let nextSite = 0;
    const worker = async () => {
      while (!state.stopping && nextSite < collectors.length) {
        const i = nextSite++;
        results[i] = await runOne(collectors[i], state.sites![i]);
      }
    };
    const lanes = Math.min(RUN_PARALLEL_SITES, collectors.length);
    if (lanes) {
      updateMessage();
      void session.banner(`사이트마다 탭을 열어 ${lanes}곳씩 동시에 조회합니다`);
      await Promise.all(Array.from({ length: lanes }, worker));
    }
    for (const s of state.sites ?? []) {
      if (s.status === 'waiting') {
        s.status = 'skipped';
        s.message = '중단해서 돌지 않음';
      }
    }
    summaries.push(...results.filter(Boolean));
    const ctx = makeCtx(session);
    // 법원경매를 돈 조회는 매각 결과(지난 매각기일의 매각대금, 유찰)와 지역별 매각통계도 모은다.
    // 공고만 확인도 매각 결과를 모은 지 오래됐으면(courtResultsDue) 모은다.
    if (!state.stopping && (collectors.some((c) => c.id === 'courtauction') || (noticesOnly && courtResultsDue()))) {
      try {
        log(`법원경매 매각 결과: ${await collectCourtResults(ctx, () => state.stopping)}`);
      } catch (e) {
        if (!state.stopping) log(`법원경매 매각 결과 ${e instanceof BlockedError ? '차단' : '오류'}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    // 법원경매를 돈 조회는 지금 물건의 배당 순위(대항력 임차인보다 먼저 받을 수 있는 청구와 대항력 임차인)도 확인한다.
    if (!state.stopping && collectors.some((c) => c.id === 'courtauction')) {
      try {
        log(`법원경매 배당 확인: ${await collectCourtClaims(ctx, () => state.stopping)}`);
      } catch (e) {
        if (!state.stopping) log(`법원경매 배당 확인 ${e instanceof BlockedError ? '차단' : '오류'}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    // 아래 실거래와 KB 통계는 때가 됐으면 받는다. 탭 하나만 도는 조회는 그 탭이 쓰는 것만 받는다(경매 범위는 단독 실거래와
    // 아파트 실거래 최근 1년, 다른 범위는 받지 않음). 국토부 단독/다가구 실거래(서울, 최근 1년)는 받은 지 7일이 지났으면 받는다.
    const fullData = !plan.scope && !plan.line;
    const auctionData = fullData || plan.scope?.id === 'auction';
    if (!state.stopping && auctionData && houseTradesDue()) {
      try {
        const record = (url: string, status: number | null, note: string) => store.addRequest(runId, HOUSE_TRADES_SOURCE, 'data', url, status, note);
        log(`${HOUSE_TRADES_SOURCE}: ${await collectHouseTrades(record)}`);
      } catch (e) {
        log(`${HOUSE_TRADES_SOURCE} 오류: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    // 시세 통계 탭 자료: KB 지수는 3일, 서울 아파트 실거래 최근 1년과 지역별 거래 건수는 7일에 한 번, 지난 해는 한 번에 두 해씩,
    // 지역별 건수의 빈 달은 한 번에 36달씩(전부 도는 조회만).
    // 경매 범위 조회는 카드의 실거래 비교에 쓰는 아파트 실거래 최근 1년만 받는다.
    if (!state.stopping && fullData && kbStatsDue()) {
      try {
        const record = (url: string, status: number | null, note: string) => store.addRequest(runId, KB_SOURCE, 'data', url, status, note);
        log(`${KB_SOURCE}: ${await collectKbStats(record)}`);
      } catch (e) {
        log(`${KB_SOURCE} 오류: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    if (!state.stopping && fullData && peakSourcesDue()) {
      try {
        const record = (url: string, status: number | null, note: string) => store.addRequest(runId, PEAK_SOURCE, 'data', url, status, note);
        log(`${PEAK_SOURCE}: ${await collectPeakSources(record)}`);
      } catch (e) {
        log(`${PEAK_SOURCE} 오류: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    if (!state.stopping && fullData && regionVolumeDue()) {
      try {
        const record = (url: string, status: number | null, note: string) => store.addRequest(runId, REGION_VOLUME_SOURCE, 'data', url, status, note);
        log(`${REGION_VOLUME_SOURCE}: ${await collectRegionVolume(record)}`);
      } catch (e) {
        log(`${REGION_VOLUME_SOURCE} 오류: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    if (!state.stopping && (fullData ? aptTradesDue() : auctionData && aptRecentDue())) {
      try {
        const record = (url: string, status: number | null, note: string) => store.addRequest(runId, APT_TRADES_SOURCE, 'data', url, status, note);
        log(`${APT_TRADES_SOURCE}: ${await collectAptTrades(record, fullData ? { maxYears: 2 } : { recent: true, maxYears: 0 })}`);
      } catch (e) {
        log(`${APT_TRADES_SOURCE} 오류: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    // 동별 전월세: 켜 둔 지역 근처 구의 전월세 실거래 최근 1년은 받은 지 7일이 지났거나 아직 안 받은 근처 구가 있으면 받는다(전부 도는 조회만).
    if (!state.stopping && fullData && rentTradesDue(gusFor(areas))) {
      try {
        const record = (url: string, status: number | null, note: string) => store.addRequest(runId, RENT_TRADES_SOURCE, 'data', url, status, note);
        log(`${RENT_TRADES_SOURCE}: ${await collectRentTrades(gusFor(areas), record)}`);
      } catch (e) {
        log(`${RENT_TRADES_SOURCE} 오류: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    // 정비구역 지도 파일(서울플랜+)의 새 판: 마지막 확인에서 7일(실패했으면 하루)이 지났으면 조회용 브라우저로 본다(경매 범위도).
    if (!state.stopping && auctionData && zoneUpdateDue()) {
      try {
        const record = (url: string, status: number | null, note: string) => store.addRequest(runId, ZONES_SOURCE, 'data', url, status, note);
        log(`${ZONES_SOURCE}: ${(await updateZonesWith(session.context, record)).text}`);
      } catch (e) {
        log(`${ZONES_SOURCE} 오류: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    // 법원경매나 온비드를 돈 조회는 공공데이터포털 키가 있으면 아파트 단지 세대수를 건축물대장에서 채운다(아직 안 본 단지만).
    if (!state.stopping && registryKey() && collectors.some((c) => c.id === 'courtauction' || c.id === 'onbid')) {
      try {
        const record = (url: string, status: number | null, note: string) => store.addRequest(runId, REGISTRY_SOURCE, 'data', url, status, note);
        log(`${REGISTRY_SOURCE} 세대수: ${await fillHouseholds(record)}`);
      } catch (e) {
        log(`${REGISTRY_SOURCE} 세대수 오류: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    // 법원경매나 온비드를 돈 조회는 브이월드 키가 있으면 집터 경매와 공매(단독, 토지)가 재개발 쪽 구역 안인지 토지이용계획으로 본다(아직 안 본 필지만).
    if (!state.stopping && vworldKey() && collectors.some((c) => c.id === 'courtauction' || c.id === 'onbid')) {
      try {
        const record = (url: string, status: number | null, note: string) => store.addRequest(runId, ZONE_SOURCE, 'data', url, status, note);
        log(`${ZONE_SOURCE} 재개발 구역: ${await checkZones(record)}`);
      } catch (e) {
        log(`${ZONE_SOURCE} 재개발 구역 오류: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    const noticeResult = await collectNotices(ctx, areas, plan.notices, log, () => state.stopping, news);
    noticesComplete = noticeResult.complete;
    retryable ||= noticeResult.retryable;
    if (state.stopping) {
      finish('stopped', null);
      log('조회 중단');
      return;
    }
    if (plan.line) {
      // 노선 조회는 알림을 띄우지 않는다(미뤄 둔 공고도 꺼내지 않음).
      finish('done', null);
      log('조회 끝');
      return;
    }
    let shown = news;
    if (noticesOnly) {
      shown = news.filter((n) => n.type === 'notice' && n.section === 'rent' && n.near);
      deferNotices(news.filter((n) => !shown.includes(n)));
      log(`알림: 근처 임대 공고 ${shown.length}건, 다음 알림으로 미룬 새 공고 ${news.length - shown.length}건`);
    } else {
      const deferred = takeDeferredNotices();
      if (deferred.length) log(`알림: 공고만 확인에서 미뤄 둔 새 공고 ${deferred.length}건을 함께 알림`);
      shown = [...deferred, ...news];
    }
    const summary = finish('done', null);
    log('조회 끝');
    const covered = coveredRows(collectors.map((c) => c.id), plan.notices.map((nc) => nc.id));
    // 고른 구가 없으면 서울 아파트 경매 줄은 이번에 확인한 것이 아니다.
    if (!ctx.aptGus.length) covered.delete('aptAuction');
    for (const alert of buildAlerts({ news: shown, sources: summary.sources, areas: store.enabledAreas(), settings: alertSettings(), quiet: quiet || noticesOnly, covered })) {
      notify(alert.title, alert.message, alert.url);
    }
  } catch (e) {
    if (state.stopping) {
      finish('stopped', null);
      log('조회 중단');
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    log(`조회 실패: ${message}`);
    finish('error', message);
    notify(`회사근처 내집마련: ${auto ? '자동 확인' : '조회'} 실패`, message);
  } finally {
    await session?.close();
    current = null;
  }
}
