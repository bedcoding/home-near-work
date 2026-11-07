import type { Response } from 'playwright';
import { PAGE_DELAY_MS } from '../config.js';
import { parseDaangnFeed } from '../daangn-parse.js';
import { distanceM } from '../geo.js';
import { knownStations } from '../station-catalog.js';
import { BlockedError, type CollectContext, type Collector, type CollectedItem } from './types.js';
import { primaryAreas } from '../../shared/regions.js';
import type { Area, Station } from '../../shared/types.js';

// 당근부동산: 지도 화면을 지역 범위(region_bounds)로 열면 왼쪽에 그 범위의 '매물' 목록(articleFeed, 최근 순 20건씩)이 뜬다.
// 화면이 스스로 불러오는 목록 응답을 옆에서 읽고, 목록 칸을 내려 다음 페이지를 불러오게 한다(목록 응답 주소에는 직접 요청하지 않는다).
// 상가, 사무실, 건물 같은 비주거 매물은 저장하지 않는다(daangn-parse.ts).
// 범위가 넓으면 지역마다 최근 MAX_PAGES 페이지까지만 받는다. 그래서 안 보인 매물을 바로 '사라짐'으로 두지 않고 오래 못 보면 정리한다
// (retainMissing, STALE_SOURCES).

/** 지역 하나에서 받을 최대 페이지(20건씩, 최근 순). 당근은 짧은 시간에 많이 열면 막으므로(HTTP 403) 넉넉히 줄여 둔다. */
const MAX_PAGES = 30;
/** 첫 목록과 다음 페이지 응답을 기다리는 시간 */
const FIRST_WAIT_MS = 15000;
const NEXT_WAIT_MS = 8000;

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

/** 지역 범위의 지도 화면 주소. 화면 길은 가까운 역 화면을 쓰고, 보이는 범위는 region_bounds로 정한다. */
export function daangnFeedUrl(stationName: string, box: DaangnBox): string {
  const bounds = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(5)).concat(String(box.zoom)).join(',');
  return `https://realty.daangn.com/map/subway/${encodeURIComponent(daangnStationPath(stationName))}?region_bounds=${encodeURIComponent(bounds)}`;
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
  // 주거 매물이 없는 범위도 있고, 지역마다 최근 페이지까지만 받으므로 안 보인 매물은 시간이 지나 정리될 때까지 둔다.
  emptyOk: true,
  retainMissing: true,
  collect: (ctx) => collectDaangn(ctx, daangnTargets(ctx.areas)),
};

/** 한 지역 범위의 목록을 받은 기록. 화면이 같은 페이지를 두 번 받기도 해서 커서로 겹침을 없앤다. */
interface FeedLog {
  pages: number;
  cursors: Set<string>;
  ids: Set<string>;
  stored: number;
  excluded: Set<string>;
  unreadable: Set<string>;
  ended: boolean;
}

/** 지역 범위마다 지도 화면을 열고 매물 목록을 최근 순으로 받는다. */
export async function collectDaangn(ctx: CollectContext, targets: ReturnType<typeof daangnTargets>): Promise<CollectedItem[]> {
  const { session } = ctx;
  const page = session.page;
  const items = new Map<string, CollectedItem>();
  ctx.log(
    targets.length
      ? `당근부동산: 지역 ${targets.length}곳의 지도 범위 매물 목록을 봅니다(지역마다 최근 ${MAX_PAGES * 20}건까지)`
      : '당근부동산: 켜진 지역이 없어 건너뜁니다',
  );

  // 지금 보는 지역의 기록. 화면을 옮기는 동안에는 비워 두어 앞 화면의 늦은 응답이 섞이지 않게 한다.
  let current: { log: FeedLog; shot: string | null } | null = null;
  let blocked: number | null = null;
  const pending: Promise<void>[] = [];
  const onResponse = (r: Response) => {
    const state = current;
    if (!state) return;
    let url: URL;
    try {
      url = new URL(r.url());
    } catch {
      return;
    }
    if (!/(^|\.)karrotmarket\.com$/.test(url.hostname) || !url.pathname.endsWith('/graphql')) return;
    pending.push(
      (async () => {
        const status = r.status();
        if (status === 403 || status === 429) {
          blocked = status;
          session.record('daangn', 'data', r.url(), status, '차단 응답');
          return;
        }
        if (status < 200 || status >= 300) return;
        const body = await r.text().catch(() => '');
        // 당근은 모든 요청이 같은 /graphql 주소라 지도 매물 목록 응답만 고른다.
        if (!body.includes('"articleFeed"')) return;
        const read = parseDaangnFeed(body);
        if (read.hasNextPage === null) return;
        const log = state.log;
        // 같은 페이지를 다시 받으면 한 번만 센다. 빈 마지막 칸은 다른 목록 요청일 수 있어 끝으로 치지 않는다.
        const key = read.endCursor ?? `none:${read.ids.join(',')}`;
        if (log.cursors.has(key) || (!read.ids.length && !read.hasNextPage)) return;
        log.cursors.add(key);
        log.pages += 1;
        log.ended = read.hasNextPage === false;
        for (const id of read.ids) log.ids.add(id);
        for (const id of read.excludedIds) log.excluded.add(id);
        for (const id of read.unreadableIds) log.unreadable.add(id);
        for (const i of read.items) {
          if (!items.has(i.listing.sourceId)) log.stored += 1;
          items.set(i.listing.sourceId, { listing: i.listing, raw: i.raw, pageUrl: page.url(), screenshot: state.shot });
        }
        session.record('daangn', 'data', r.url(), status, `지도 범위 매물 목록 ${log.pages}쪽 ${read.ids.length}건`);
      })(),
    );
  };
  const settle = async () => {
    await Promise.allSettled(pending.splice(0));
    if (blocked) throw new BlockedError(`당근부동산이 목록 요청을 막았습니다(HTTP ${blocked}). 우회하지 않고 멈춥니다.`);
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
      if (!box) return null;
      box.scrollTop = box.scrollHeight;
      const r = box.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    // 목록 칸을 못 찾으면 보통 목록이 있는 자리(왼쪽 메뉴 옆)에서 휠을 굴린다.
    const at = point ?? { x: 380, y: 500 };
    await session.wheel(at.x, at.y, 2500);
  };

  page.on('response', onResponse);
  try {
    for (const [i, target] of targets.entries()) {
      if (ctx.stopped?.()) break;
      const { area, box, station } = target;
      if (!station) {
        ctx.log(`당근부동산: ${area.name} 가까이에 아는 역이 없어 건너뜁니다`);
        ctx.partial(`당근부동산 ${area.name}: 지도 화면을 열 역을 찾지 못함`);
        continue;
      }
      if (i > 0) await session.rest();
      const log: FeedLog = { pages: 0, cursors: new Set(), ids: new Set(), stored: 0, excluded: new Set(), unreadable: new Set(), ended: false };
      const state = { log, shot: null as string | null };
      const where = `${area.name} (${i + 1}/${targets.length})`;
      ctx.progress(`당근부동산, ${where} 지도 범위 매물 목록 여는 중`);
      current = null;
      const response = await session.goto('daangn', daangnFeedUrl(station.name, box));
      current = state;
      const status = response?.status() ?? 0;
      if (status === 403 || status === 429) throw new BlockedError(`당근부동산이 요청을 막았습니다(HTTP ${status}). 우회하지 않고 멈춥니다.`);
      if (status >= 400) {
        ctx.log(`당근부동산: ${area.name} 지도 화면 응답 ${status}, 건너뜁니다`);
        ctx.partial(`당근부동산 ${area.name}: HTTP ${status}`);
        continue;
      }
      if (!(await waitFor(() => log.pages > 0, FIRST_WAIT_MS))) {
        // 목록이 바로 안 뜨면 아래쪽 '매물 N개' 버튼을 눌러 연다.
        await session.click(page.getByText(/^매물\s*[\d,]+\+?\s*개/).first()).catch(() => {});
        if (!(await waitFor(() => log.pages > 0, FIRST_WAIT_MS))) {
          ctx.log(`당근부동산: ${area.name} 매물 목록 응답을 받지 못했습니다(화면 구조가 바뀌었을 수 있음)`);
          ctx.partial(`당근부동산 ${area.name}: 매물 목록 응답 없음`);
          continue;
        }
      }
      state.shot = await session.screenshot('daangn', area.name);
      for (const item of items.values()) if (!item.screenshot) item.screenshot = state.shot;

      // 목록 끝까지(또는 한도까지) 받기: 끝으로 내리고, 다음 페이지가 오면 조금 쉬었다가 다시 내린다. 안 오면 한 번 더 내려 본다.
      while (!log.ended && log.pages < MAX_PAGES && !ctx.stopped?.()) {
        const before = log.pages;
        ctx.progress(`당근부동산, ${where}, ${log.ids.size}건 읽음(주거 ${log.stored}건), 다음 목록 불러오는 중`);
        await scrollList();
        if (!(await waitFor(() => log.pages > before, NEXT_WAIT_MS))) {
          await scrollList();
          if (!(await waitFor(() => log.pages > before, NEXT_WAIT_MS))) break;
        }
        await session.pause(PAGE_DELAY_MS);
      }

      const capped = !log.ended && log.pages >= MAX_PAGES;
      if (!log.ended && !capped) ctx.partial(`당근부동산 ${area.name}: 목록 끝까지 불러오지 못함`);
      ctx.log(
        `당근부동산: ${area.name} 매물 목록 ${log.pages}쪽, 매물 ${log.ids.size}건 중 주거 ${log.stored}건` +
          `${log.excluded.size ? `, 비주거 ${log.excluded.size}건 뺌` : ''}${log.unreadable.size ? `, 읽지 못함 ${log.unreadable.size}건` : ''}` +
          `${capped ? `, 최근 ${MAX_PAGES}쪽까지만 받음` : log.ended ? ', 목록 끝까지 받음' : ''}`,
      );
    }
  } finally {
    current = null;
    page.off('response', onResponse);
    await Promise.allSettled(pending.splice(0));
  }
  return [...items.values()];
}
