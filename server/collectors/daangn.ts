import { createHash } from 'node:crypto';
import type { Frame, Request, Response } from 'playwright';
import { isEmptyDaangnFeedEnd, parseDaangnFeed } from '../daangn-parse.js';
import { daangnFilter, daangnPriceViews, daangnPricesMatch, type DaangnPriceView } from '../daangn-price.js';
import { distanceM } from '../geo.js';
import { knownStations } from '../station-catalog.js';
import { BlockedError, type CollectContext, type Collector, type CollectedItem } from './types.js';
import { primaryAreas } from '../../shared/regions.js';
import type { Area, Station } from '../../shared/types.js';

// 당근부동산: 지도 화면을 지역 범위(region_bounds)로 열면 왼쪽에 그 범위의 '매물' 목록(articleFeed, 최근 순 20건씩)이 뜬다.
// 화면이 스스로 불러오는 목록 응답을 옆에서 읽고, 목록 칸을 내려 다음 페이지를 불러오게 한다(목록 응답 주소에는 직접 요청하지 않는다).
// 주소의 af 조건으로 주거 종류만 목록에 오게 하고, 그래도 온 비주거 매물은 저장하지 않는다(daangn-parse.ts).
// 지도 목록에 더 받을 페이지가 있으면 계속 읽는다. 안 보인 매물은 오래 못 보면 정리한다(retainMissing, STALE_SOURCES).

/** 첫 목록과 다음 페이지 응답을 기다리는 시간 */
const FIRST_WAIT_MS = 15000;
const NEXT_WAIT_MS = 8000;
const NEXT_SCROLL_DELAY_MS = 10000;
const MAX_CONSECUTIVE_FORBIDDEN = 5;

const graphQlRequestLabels = { feed: '매물 목록 요청', other: '기타 요청', unknown: '요청 종류 미확인' } as const;
type GraphQlRequestKind = keyof typeof graphQlRequestLabels;

function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Match a single GraphQL operation across pages without using its variables or logging its identity. */
function graphQlOperation(request: Request, url: URL, endpoint: string) {
  try {
    const method = request.method();
    const payload = method === 'GET' ? {
      query: url.searchParams.get('query'),
      operationName: url.searchParams.get('operationName'),
      extensions: JSON.parse(url.searchParams.get('extensions') ?? 'null'),
    } : method === 'POST' ? recordObject(request.postDataJSON()) : null;
    if (!payload) return null;
    const name = payload.operationName;
    const query = payload.query;
    if (name != null && (typeof name !== 'string' || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(name))) return null;
    if (query != null && (typeof query !== 'string' || !query.trim())) return null;
    const rawPersisted = recordObject(payload.extensions)?.persistedQuery;
    const persisted = recordObject(rawPersisted);
    const hash = persisted?.sha256Hash;
    const verifiedHash = persisted?.version === 1 && typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash) ? hash.toLowerCase() : null;
    const documentHash = typeof query === 'string' ? createHash('sha256').update(query).digest('hex') : null;
    if (rawPersisted !== undefined && (!verifiedHash || (documentHash && documentHash !== verifiedHash))) return null;
    const signature = documentHash ?? verifiedHash;
    return signature ? {
      key: `${endpoint}:${name ?? ''}:${signature}`,
      excludesFeed: typeof query === 'string' && !/\barticleFeed\b/.test(query),
    } : null;
  } catch {
    return null;
  }
}

function successfulOtherGraphQlResponse(body: string): boolean {
  try {
    const result = recordObject(JSON.parse(body));
    const data = recordObject(result?.data);
    return !!data && !Object.hasOwn(data, 'articleFeed') && Object.keys(data).length > 0
      && (result?.errors === undefined || Array.isArray(result.errors) && result.errors.length === 0);
  } catch {
    return false;
  }
}

/** 제외한 매물을 종류 코드별로 센 글. 모르는 주거 코드가 섞였는지 로그에서 바로 보이게 한다. */
function excludedTypeSummary(excluded: Map<string, string>): string {
  const counts = new Map<string, number>();
  for (const type of excluded.values()) counts.set(type || '종류 없음', (counts.get(type || '종류 없음') ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([type, count]) => `${type} ${count}`).join(', ');
}

/** 당근 역 화면 주소의 역 이름: '예시역'처럼 끝의 '역'을 뺀다(사이트 바로 가기와 같은 규칙). */
export const daangnStationPath = (name: string) => name.replace(/역$/, '');

export interface DaangnBox { south: number; west: number; north: number; east: number; zoom: number }

/** 지역 가운데에서 반경만큼의 네모 범위와 그 범위가 화면에 들어오는 확대 수준 */
export function daangnBox(area: Pick<Area, 'lat' | 'lng' | 'radiusM'>): DaangnBox {
  const dLat = area.radiusM / 111320;
  const dLng = area.radiusM / (111320 * Math.cos((area.lat * Math.PI) / 180));
  const zoom = area.radiusM <= 1000 ? 15 : area.radiusM <= 2500 ? 14 : 13;
  return { south: area.lat - dLat, west: area.lng - dLng, north: area.lat + dLat, east: area.lng + dLng, zoom };
}

/**
 * 지역 범위의 지도 화면 주소. 화면 길은 가까운 역 화면을 쓰고, 보이는 범위는 region_bounds로 정한다.
 * af는 사이트의 종류별 화면이 스스로 붙이는 목록 조건으로, 주거 종류만 걸어 비주거를 읽느라 쓰는 요청을 없앤다.
 * 가격 묶음(view)을 주면 그 거래 종류와 금액 상한도 함께 건다(daangn-price.ts).
 */
export function daangnFeedUrl(stationName: string, box: DaangnBox, view: DaangnPriceView | null = null): string {
  const bounds = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(5)).concat(String(box.zoom)).join(',');
  const filter = JSON.stringify(daangnFilter(view));
  return `https://realty.daangn.com/map/subway/${encodeURIComponent(daangnStationPath(stationName))}` +
    `?region_bounds=${encodeURIComponent(bounds)}&af=${encodeURIComponent(filter)}`;
}

/**
 * 모을 지역: 수집용 구나 동(없으면 켜 둔 역 반경, 알림용 역 반경은 빼고 primaryAreas와 같은 기준).
 * 지역마다 가운데에서 가장 가까운 아는 역(5km 안)을 화면 길로 쓴다. 역을 못 찾으면 station이 null.
 */
export function daangnTargets(areas: Area[], stations: Station[] = knownStations()): { area: Area; box: DaangnBox; station: Station | null }[] {
  return primaryAreas(areas).map((area) => {
    const nearest = stations
      .map((s) => ({ s, d: distanceM(area.lat, area.lng, s.lat, s.lng) }))
      .filter((x) => x.d <= 5000)
      .sort((a, b) => a.d - b.d)[0]?.s ?? null;
    return { area, box: daangnBox(area), station: nearest };
  });
}

export const daangn: Collector = {
  id: 'daangn',
  label: '당근부동산',
  // 지도 범위에서 안 보인 매물은 시간이 지나 정리될 때까지 둔다.
  emptyOk: true,
  retainMissing: true,
  collect: (ctx) => collectDaangn(ctx, daangnTargets(ctx.areas)),
};

/** 한 지역 범위의 목록을 받은 기록. 화면이 같은 페이지를 두 번 받기도 해서 커서로 겹침을 없앤다. */
interface FeedLog {
  pages: number;
  cursors: Set<string>;
  ids: Set<string>;
  housingIds: Set<string>;
  /** 저장하지 않은 매물 번호와 그 종류 코드 */
  excluded: Map<string, string>;
  /** 주거 매물이지만 이번 조회의 가격 조건 밖이라 저장하지 않은 번호 */
  outOfPrice: Set<string>;
  unreadable: Set<string>;
  invalid: boolean;
  ended: boolean;
}

interface FeedState {
  url: URL;
  log: FeedLog;
  shot: string | null;
  next: { afterPage: number; requests: number; failed: number; forbidden: number; http: Set<number>; repeated: boolean } | null;
}

/** 지역 범위마다 지도 화면을 열고 매물 목록을 최근 순으로 받는다. */
export async function collectDaangn(ctx: CollectContext, targets: ReturnType<typeof daangnTargets>): Promise<CollectedItem[]> {
  const { session } = ctx;
  const page = session.page;
  const items = new Map<string, CollectedItem>();
  // 가격 조건이 있으면 지역마다 거래 종류별 목록으로 나눠 연다. 역을 못 찾은 지역은 한 번만 알린다.
  const views = daangnPriceViews(ctx.priceLimits, ctx.rentalOnly);
  const jobs = targets.flatMap((target) => (target.station ? views : [null]).map((view) => ({ ...target, view })));
  const split = views[0] ? `, 가격 조건에 따라 ${views.map((view) => view?.label).join(' / ')} 목록으로 나눠 봅니다` : '';
  ctx.log(
    targets.length
      ? `당근부동산: 지역 ${targets.length}곳의 지도 매물 목록을 최신순으로 봅니다${split}`
      : '당근부동산: 켜진 지역이 없어 건너뜁니다',
  );

  // 문서가 바뀐 시점부터 새 지역에 요청을 연결한다. 응답 시점에 열린 화면만 보면 앞 지역의 응답이 섞일 수 있다.
  const mainFrame = page.mainFrame();
  let opening: FeedState | null = null;
  let current: FeedState | null = null;
  const owners = new WeakMap<Request, {
    state: FeedState; next: FeedState['next']; endpoint: string; operation: ReturnType<typeof graphQlOperation>;
  }>();
  const observedOperations = new Map<string, Exclude<GraphQlRequestKind, 'unknown'>>();
  let blocked: string | null = null;
  let consecutiveForbidden = 0;
  let pending = Promise.resolve();
  const onNavigation = (frame: Frame) => {
    if (frame !== mainFrame || !opening) return;
    let url: URL;
    try { url = new URL(frame.url()); } catch { return; }
    if (url.origin !== opening.url.origin || url.pathname.replace(/\/$/, '') !== opening.url.pathname
      || url.searchParams.get('region_bounds') !== opening.url.searchParams.get('region_bounds')) return;
    current = opening;
    opening = null;
  };
  const onRequest = (request: Request) => {
    try {
      if (request.frame() !== mainFrame) return;
      if (request.isNavigationRequest()) {
        current = null;
        return;
      }
      if (!current) return;
      const url = new URL(request.url());
      if (!/(^|\.)karrotmarket\.com$/.test(url.hostname) || !url.pathname.endsWith('/graphql')) return;
      const next = current.next;
      if (next) next.requests++;
      const endpoint = `${url.origin}${url.pathname}`;
      owners.set(request, { state: current, next, endpoint, operation: graphQlOperation(request, url, endpoint) });
    } catch {
      // 서비스 워커가 시작한 요청에는 페이지 프레임이 없다.
    }
  };
  const onRequestFailed = (request: Request) => {
    const owner = owners.get(request);
    if (owner?.state === current && owner.next) owner.next.failed++;
  };
  const onResponse = (r: Response) => {
    const owner = owners.get(r.request());
    if (!owner || owner.state !== current) return;
    const { state, next, endpoint, operation } = owner;
    const status = r.status();
    if (status === 429) {
      const kind = operation ? observedOperations.get(operation.key) ?? 'unknown' : 'unknown';
      const label = graphQlRequestLabels[kind];
      blocked ??= `접근 제한(HTTP 429, ${label})으로 중단함`;
      session.record('daangn', 'data', endpoint, status, `차단 응답, ${label}`);
      return;
    }
    // 응답 본문을 읽는 순서가 뒤바뀌면 정상 목록과 403의 연속 횟수도 뒤바뀐다.
    pending = pending.then(async () => {
      if (state !== current) return;
      if (status === 403) {
        if (blocked) return;
        const kind = operation ? observedOperations.get(operation.key) ?? 'unknown' : 'unknown';
        const label = graphQlRequestLabels[kind];
        if (kind === 'other') {
          session.record('daangn', 'data', endpoint, status, `차단 응답, ${label}`);
          return;
        }
        if (next) {
          next.forbidden++;
          next.http.add(status);
        }
        consecutiveForbidden++;
        session.record('daangn', 'data', endpoint, status, `차단 응답, ${label}, 연속 ${consecutiveForbidden}/${MAX_CONSECUTIVE_FORBIDDEN}회`);
        if (consecutiveForbidden >= MAX_CONSECUTIVE_FORBIDDEN) {
          blocked ??= `HTTP 403 ${MAX_CONSECUTIVE_FORBIDDEN}회 연속(${label})으로 중단함`;
        }
        return;
      }
      if (status < 200 || status >= 300) {
        next?.http.add(status);
        return;
      }
      const body = await r.text().catch(() => '');
      if (state !== current) return;
      // 당근은 모든 요청이 같은 /graphql 주소라 지도 매물 목록 응답만 고른다.
      if (!body.includes('"articleFeed"')) {
        if (operation?.excludesFeed && !observedOperations.has(operation.key) && successfulOtherGraphQlResponse(body)) {
          observedOperations.set(operation.key, 'other');
        }
        return;
      }
      const read = parseDaangnFeed(body);
      if (read.hasNextPage === null) return;
      if (operation) observedOperations.set(operation.key, 'feed');
      const log = state.log;
      // 빈 종료 응답은 다음 목록을 내린 뒤 떠난 같은 문서의 요청일 때만 인정한다.
      if (!read.ids.length && !read.hasNextPage) {
        if (next && state.next === next && next.afterPage === log.pages && log.pages > 0 && isEmptyDaangnFeedEnd(body)) {
          log.ended = true;
          consecutiveForbidden = 0;
          session.record('daangn', 'data', endpoint, status, '빈 마지막 응답으로 목록 종료 확인');
        }
        return;
      }
      // 같은 페이지를 다시 받으면 한 번만 센다.
      const key = read.endCursor ?? `none:${read.ids.join(',')}`;
      if (log.cursors.has(key)) {
        if (next) next.repeated = true;
        return;
      }
      log.cursors.add(key);
      log.pages += 1;
      log.ended = read.hasNextPage === false;
      if (read.valid) consecutiveForbidden = 0;
      log.invalid ||= !read.valid;
      for (const id of read.ids) log.ids.add(id);
      for (const id of read.excludedIds) log.excluded.set(id, read.excludedTypes[id] ?? '');
      for (const id of read.unreadableIds) log.unreadable.add(id);
      const received = ctx.publishListings ? new Map<string, CollectedItem>() : null;
      for (const i of read.items) {
        const id = i.listing.sourceId;
        // 사이트에는 눈금에 맞춰 올린 상한을 보내므로 정확한 상한은 여기서 다시 거른다.
        if (!daangnPricesMatch(i.listing.prices, ctx.priceLimits, ctx.rentalOnly)) {
          log.outOfPrice.add(id);
          continue;
        }
        log.housingIds.add(id);
        const collected = { listing: i.listing, raw: i.raw, pageUrl: state.url.href, screenshot: state.shot };
        items.set(id, collected);
        received?.set(id, collected);
      }
      if (received?.size) ctx.publishListings?.([...received.values()]);
      session.record('daangn', 'data', endpoint, status, `지도 범위 매물 목록 ${log.pages}쪽 ${read.ids.length}건`);
    }).catch(() => {});
  };
  const settle = async () => {
    await pending;
    if (blocked) throw new BlockedError(blocked);
  };
  /** 조건이 맞거나 차단되거나 시간이 다 될 때까지 기다린다. */
  const waitFor = async (ok: () => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (!ok() && !blocked && Date.now() < until && !ctx.stopped?.()) await page.waitForTimeout(250);
    await settle();
    return ok();
  };
  /** 왼쪽 매물 목록 칸을 끝까지 내려 화면이 다음 페이지를 불러오게 한다. */
  const scrollList = async () => {
    const point = await page.evaluate(() => {
      let box = document.querySelector<HTMLElement>('[data-hnw-list]');
      if (!box) {
        // 화면 왼쪽 절반에서 세로로 내릴 수 있는 가장 큰 칸이 매물 목록이다.
        box = Array.from(document.querySelectorAll<HTMLElement>('body *'))
          .filter((el) => {
            if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY) || el.scrollHeight <= el.clientHeight + 20) return false;
            const r = el.getBoundingClientRect();
            return r.width > 200 && r.height > 300 && r.left < innerWidth / 2;
          })
          .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ?? null;
        box?.setAttribute('data-hnw-list', '');
      }
      if (!box) return { x: 380, y: 500 };
      if (box.scrollTop + box.clientHeight < box.scrollHeight - 1) {
        box.scrollTop = box.scrollHeight;
        return null;
      }
      const r = box.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (point) await session.wheel(point.x, point.y, 2500);
  };

  page.on('framenavigated', onNavigation);
  page.on('request', onRequest);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);
  try {
    for (const [i, job] of jobs.entries()) {
      if (ctx.stopped?.()) break;
      const { area, box, station, view } = job;
      const scopeName = `${area.name}${view ? ` ${view.label}` : ''}`;
      if (!station) {
        ctx.log(`당근부동산: ${area.name} 가까이에 아는 역이 없어 건너뜁니다`);
        ctx.partial(`당근부동산 ${area.name}: 지도 화면을 열 역을 찾지 못함`);
        continue;
      }
      const log: FeedLog = {
        pages: 0, cursors: new Set(), ids: new Set(), housingIds: new Set(),
        excluded: new Map(), outOfPrice: new Set(), unreadable: new Set(), invalid: false, ended: false,
      };
      const state: FeedState = { url: new URL(daangnFeedUrl(station.name, box, view)), log, shot: null, next: null };
      const where = `${scopeName} (${i + 1}/${jobs.length})`;
      let problem: string | null = null;
      let retryable = true;
      try {
        if (i > 0) await session.rest();
        if (ctx.stopped?.()) break;
        ctx.progress(`당근부동산, ${where} 지도 범위 매물 목록 여는 중`);
        opening = state;
        const response = await session.goto('daangn', state.url.href);
        const status = response?.status() ?? 0;
        if (status === 403 || status === 429) throw new BlockedError(`지도 화면 접근 제한(HTTP ${status})으로 중단함`);
        if (status >= 400) {
          problem = `지도 화면 응답 HTTP ${status}`;
          continue;
        }
        if (!(await waitFor(() => log.pages > 0, FIRST_WAIT_MS))) {
          if (ctx.stopped?.()) break;
          // 목록이 바로 안 뜨면 아래쪽 '매물 N개' 버튼을 눌러 연다.
          await session.click(page.getByText(/^매물\s*[\d,]+\+?\s*개/).first()).catch(() => {});
          if (!(await waitFor(() => log.pages > 0, FIRST_WAIT_MS))) {
            problem = '매물 목록 응답 없음';
            continue;
          }
        }
        state.shot = await session.screenshot('daangn', `${area.name}${view?.suffix ?? ''}`);
        for (const id of log.housingIds) {
          const item = items.get(id);
          if (item && !item.screenshot) item.screenshot = state.shot;
        }

        while (!log.ended && !ctx.stopped?.()) {
          const before = log.pages;
          const next = { afterPage: before, requests: 0, failed: 0, forbidden: 0, http: new Set<number>(), repeated: false };
          for (let misses = 0; misses < 2 && !log.ended && log.pages === before;) {
            const retry = consecutiveForbidden ? `, HTTP 403 연속 ${consecutiveForbidden}/${MAX_CONSECUTIVE_FORBIDDEN}회` : '';
            ctx.progress(`당근부동산, ${where}, ${log.pages}쪽에서 주거 ${log.housingIds.size}건 읽음, 다음 목록 대기 중${retry}`);
            // 보이는 조회와 자동 조회 모두 같은 간격으로 요청한다.
            await page.waitForTimeout(NEXT_SCROLL_DELAY_MS);
            await settle();
            if (ctx.stopped?.() || log.ended || log.pages > before) break;
            state.next = next;
            const previousForbidden = next.forbidden;
            await scrollList();
            await waitFor(() => log.ended || log.pages > before, NEXT_WAIT_MS);
            // 이 스크롤에서 목록 403을 실제로 받았을 때만 일반적인 무응답 횟수에서 뺀다.
            if (next.forbidden === previousForbidden) misses++;
          }
          if (!log.ended && log.pages === before) {
            const { requests, failed, http, repeated } = next;
            problem = !requests ? '스크롤 뒤 목록 요청이 발생하지 않음'
              : repeated ? '다음 목록 대신 이미 받은 페이지가 반복됨'
              : http.size || failed ? `다음 목록 미확인 (스크롤 뒤 HTTP 오류 ${[...http].join(', ') || '없음'}, 네트워크 실패 ${failed}건)`
              : '스크롤 뒤 요청은 있었으나 다음 목록이나 종료 응답을 확인하지 못함';
            break;
          }
          state.next = null;
        }
      } catch (error) {
        problem = error instanceof Error ? error.message.split('\n')[0] : String(error);
        retryable = !(error instanceof BlockedError);
        break;
      } finally {
        opening = null;
        current = null;
        if (ctx.stopped?.()) {
          problem = '사용자가 조회를 중단함';
          retryable = false;
        }
        problem ??= !log.ended ? '다음 페이지 응답을 받지 못함'
          : log.invalid || log.unreadable.size > 0 ? '일부 매물 정보를 읽지 못함'
          : null;
        if (problem) ctx.partial(`당근부동산 ${scopeName}: ${problem}`, retryable);
        const reason = problem ?? '목록 끝까지 받음';
        ctx.coverage?.({
          areaId: area.id, areaName: area.name, category: `map${view?.suffix ?? ''}`, label: `지도 매물${view ? ` (${view.label})` : ''}`,
          pages: log.pages, totalPages: log.ended ? log.pages : null, total: null,
          received: log.ids.size, stored: 0, complete: problem === null, reason,
        }, [...log.housingIds]);
        ctx.log(
          `당근부동산: ${scopeName} 매물 목록 ${log.pages}쪽, 매물 ${log.ids.size}건 중 주거 ${log.housingIds.size}건, ${reason}` +
            `${log.outOfPrice.size ? `, 가격 조건 밖 ${log.outOfPrice.size}건 제외` : ''}` +
            `${log.excluded.size ? `, 주거로 알지 못한 종류 ${log.excluded.size}건 제외(${excludedTypeSummary(log.excluded)})` : ''}${log.unreadable.size ? `, 읽지 못한 주거 매물 ${log.unreadable.size}건` : ''}`,
        );
      }
    }
  } finally {
    page.off('framenavigated', onNavigation);
    page.off('request', onRequest);
    page.off('requestfailed', onRequestFailed);
    current = null;
    page.off('response', onResponse);
    await pending;
  }
  return [...items.values()];
}
