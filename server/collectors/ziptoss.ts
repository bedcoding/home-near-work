import type { Request, Response } from 'playwright';
import { PAGE_DELAY_MS } from '../config.js';
import { distanceM } from '../geo.js';
import {
  nextPeterpanzViewCenter as nextViewCenter, peterpanzBoundsCenter as boundsCenter,
  peterpanzTargetBounds as targetBounds, remainingPeterpanzBounds as remainingBounds,
  type PeterpanzBounds as MapBounds,
} from '../peterpanz-coverage.js';
import { knownStations } from '../station-catalog.js';
import { toNumber, type CollectContext, type Collector, type CollectedItem } from './types.js';
import { floorText, money, priceText, yesNo } from '../../shared/format.js';
import type { Area, DealType, ExplainRow, NormalizedListing, PriceOption, Station } from '../../shared/types.js';

// 집토스 역 페이지(/map/역이름)는 서버에서 매물 목록을 담아 보내 준다.
// 페이지를 연 뒤 그 목록을 읽고, 화면의 카드와 아래쪽 표에 배지(신규, 기존, 버림, 관심)를 달면서 페이지를 끝까지 내려 보여 준다.

/** 화면의 매물 링크에 쓰이는 키. */
export const ziptossKey = (id: number | string) => (BigInt(id) * 16668430n - 9999n).toString(16);

/** type 코드: 1x = 원룸 계열, 2x = 투룸 계열, 3x = 쓰리룸 이상. */
const roomsFromType = (type: unknown) => {
  const code = toNumber(type);
  if (code == null) return { rooms: null, label: null };
  if (code < 20) return { rooms: 1, label: '원룸' };
  if (code < 30) return { rooms: 2, label: '투룸' };
  return { rooms: 3, label: '쓰리룸 이상' };
};

const DEALS: Record<string, DealType> = { 월세: 'monthly', 전세: 'jeonse', 매매: 'sale', 단기: 'short' };

function toPrice(raw: any): PriceOption | null {
  const deal = DEALS[String(raw?.contract ?? '')];
  if (!deal) return null;
  if (deal === 'sale') return { deal, deposit: null, monthly: null, price: toNumber(raw.deposit) ?? toNumber(raw.standardPrice) };
  return { deal, deposit: toNumber(raw.deposit), monthly: deal === 'jeonse' ? null : toNumber(raw.monthly), price: null };
}

function normalize(p: any): NormalizedListing | null {
  if ((typeof p?.id !== 'number' && typeof p?.id !== 'string') || !/^\d+$/.test(String(p.id)) || Number(p.id) === 0) return null;
  const b = p.building ?? {};
  const coords = b.point?.coordinates;
  const lat = coords ? toNumber(coords[1]) : null;
  const lng = coords ? toNumber(coords[0]) : null;
  const floor = toNumber(p.floorNumber);
  const { rooms, label } = roomsFromType(p.type);
  const rawPrices = Array.isArray(p.prices) ? p.prices : [];
  const listing: NormalizedListing = {
    source: 'ziptoss',
    sourceId: String(p.id),
    url: lat != null && lng != null ? `https://ziptoss.com/?zoom=17&lat=${lat}&lng=${lng}&propertyKey=${ziptossKey(p.id)}` : 'https://ziptoss.com/',
    title: [label, b.dong, b.mainPurpose].filter(Boolean).join(', '),
    thumbnail: p.thumbnail ? `https://file.ziptoss.com/property/${p.thumbnail}` : null,
    lat,
    lng,
    address: [b.sigungu, b.dong].filter(Boolean).join(' ') || null,
    dong: b.dong ?? null,
    buildingKey: p.buildingId ? `zt-b${p.buildingId}` : null,
    buildingType: b.mainPurpose ?? b.type ?? null,
    roomLabel: label,
    rooms,
    areaM2: toNumber(p.area),
    floor,
    totalFloors: toNumber(b.stories),
    basement: floor != null ? floor <= 0 : null,
    rooftop: null,
    builtYear: b.buildedAt ? toNumber(String(b.buildedAt).slice(0, 4)) : null,
    maintenance: toNumber(p.manageFee),
    elevator: typeof b.elevatorCount === 'number' ? b.elevatorCount > 0 : null,
    parking: p.parking === 1 ? true : p.parking === 0 ? false : null,
    availableFrom: null,
    updatedAt: p.checkDate ?? p.updatedAt ?? null,
    prices: rawPrices.map(toPrice).filter((x: PriceOption | null): x is PriceOption => !!x),
  };
  const explain: ExplainRow[] = [
    {
      label: '가격',
      raw: rawPrices.map((x: any) => `${x?.contract} deposit=${x?.deposit} monthly=${x?.monthly}`).join(' / ') || '없음',
      value: listing.prices.map(priceText).join(', ') || '없음',
      note: '사이트 값이 이미 만원 단위라 그대로 씀',
    },
    { label: '전용면적', raw: `area=${p.area ?? '없음'}`, value: listing.areaM2 != null ? `${listing.areaM2}㎡` : '모름' },
    { label: '층', raw: `floorNumber=${p.floorNumber ?? '없음'}, building.stories=${b.stories ?? '없음'}`, value: floorText(listing), note: '0층 이하는 반지하로 봄' },
    { label: '방', raw: `type=${p.type ?? '없음'}`, value: `${label ?? '모름'}, 방 ${rooms ?? '?'}개`, note: '코드로 추정: 1x 원룸, 2x 투룸, 3x 쓰리룸 이상' },
    { label: '관리비', raw: `manageFee=${p.manageFee ?? '없음'}`, value: listing.maintenance != null ? `${money(listing.maintenance)}만` : '모름' },
    { label: '준공', raw: `building.buildedAt="${b.buildedAt ?? ''}"`, value: listing.builtYear ? `${listing.builtYear}년` : '모름' },
    { label: '엘리베이터', raw: `building.elevatorCount=${b.elevatorCount ?? '없음'}`, value: yesNo(listing.elevator) },
    { label: '위치', raw: `building.point.coordinates=[${coords?.[0]}, ${coords?.[1]}]`, value: `${lat}, ${lng}`, note: '사이트는 [경도, 위도] 순서라 바꿔 저장' },
    { label: '매물 링크', raw: `id=${p.id}`, value: `propertyKey=${ziptossKey(p.id)}`, note: 'id × 16668430 − 9999를 16진수로(화면 링크 6개로 확인한 규칙)' },
    { label: '건물 식별값', raw: `buildingId=${p.buildingId ?? '없음'}`, value: listing.buildingKey ?? '없음', note: '재등록(같은 집) 판정에 씀' },
  ];
  listing.explain = explain;
  return listing;
}

/** 지역마다 반경 안(+600m)의 역 페이지를 고르고, 없으면 2km 안에서 가장 가까운 역을 고른다. */
function stationsFor(area: Area, catalog: Station[]): Station[] {
  const ranked = catalog.map((s) => ({ s, d: distanceM(area.lat, area.lng, s.lat, s.lng) })).sort((a, b) => a.d - b.d);
  const near = ranked.filter((x) => x.d <= area.radiusM + 600);
  const chosen = near.length ? near : ranked.filter((x) => x.d <= 2000).slice(0, 1);
  return chosen.map(({ s }) => s);
}

const MAP_ORIGIN = 'https://ziptoss.com';
const MAP_ZOOM = 15;
const MAP_PAGE_SIZE = 50;
const MAP_PAGE_LIMIT = 12;
const DISTRICT_VIEW_LIMIT = 12;
const MAP_SIDE_LIMIT_M = 5000;

/** 공개 지도에서 브라우저가 시작한 목록 요청만 읽는다. */
async function collectMapWindow(ctx: CollectContext, area: Area): Promise<{
  items: CollectedItem[];
  blocked: boolean;
  observed: MapBounds | null;
  complete: boolean;
  pages: number;
  reason: string;
}> {
  const { session } = ctx;
  const page = session.page;
  const mainFrame = page.mainFrame();
  const uiUrl = new URL('/', MAP_ORIGIN);
  uiUrl.searchParams.set('zoom', String(MAP_ZOOM));
  uiUrl.searchParams.set('lat', String(area.lat));
  uiUrl.searchParams.set('lng', String(area.lng));
  const items = new Map<string, CollectedItem>();
  const requests = new WeakMap<Request, { number: number; scope: string; bounds: MapBounds; widthM: number; heightM: number }>();
  let scope: string | null = null;
  let observed: MapBounds | null = null;
  let mapSize = '';
  let pages = 0;
  let rejected = 0;
  let blocked: number | null = null;
  let shortPage = false;
  let ended = false;
  let repeated = false;
  let duplicates = 0;
  let failure: string | null = null;
  let firstResponseProblem: string | null = null;
  let sawListRequest = false;
  let sawSortedRequest = false;
  let sawMatchingRequest = false;
  let active = true;
  const stopped = () => blocked !== null || ctx.stopped?.();

  const onRequest = (request: Request) => {
    if (stopped() || !['xhr', 'fetch'].includes(request.resourceType()) || request.method() !== 'GET') return;
    const url = new URL(request.url());
    if (url.origin !== MAP_ORIGIN || url.pathname !== '/api/zp/search') return;
    try { if (request.frame() !== mainFrame) return; } catch { return; }
    sawListRequest = true;
    const q = url.searchParams;
    // The page also sends an unsorted startup request. Only the sorted list owns subsequent pages.
    if (!q.get('sort')) return;
    sawSortedRequest = true;
    const number = Number(q.get('page'));
    if (!Number.isInteger(number) || number < 1 || number > MAP_PAGE_LIMIT || !(Number(q.get('zoom')) > 0)) return;
    const [south, north, west, east, lat, lng] = ['minLat', 'maxLat', 'minLng', 'maxLng', 'lat', 'lng'].map(key => toNumber(q.get(key)));
    if (south == null || north == null || west == null || east == null || lat == null || lng == null) return;
    if (south > area.lat || north < area.lat || west > area.lng || east < area.lng || distanceM(area.lat, area.lng, lat, lng) > 200) return;
    // 요청의 검색 축척은 화면 주소의 줌 값과 다르다. 지도 경계의 실제 길이로 확인한다.
    const widthM = distanceM(lat, west, lat, east);
    const heightM = distanceM(south, lng, north, lng);
    if (widthM <= 0 || widthM > MAP_SIDE_LIMIT_M || heightM <= 0 || heightM > MAP_SIDE_LIMIT_M) return;
    sawMatchingRequest = true;
    q.delete('page');
    q.sort();
    requests.set(request, { number, scope: q.toString(), bounds: { south, north, west, east }, widthM, heightM });
  };
  const onResponse = async (response: Response) => {
    const request = requests.get(response.request());
    if (!request || stopped() || (scope !== null && request.scope !== scope)) return;
    const status = response.status();
    if (status === 403 || status === 429) {
      blocked = status;
      session.record('ziptoss', 'data', response.url(), status, '지도 목록 접근 제한');
      return;
    }
    if (request.number !== pages + 1) return;
    if (status < 200 || status >= 300) {
      const problem = `${request.number}쪽 HTTP ${status}`;
      if (pages === 0) firstResponseProblem = problem;
      else failure = problem;
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    if (!active || stopped() || request.number !== pages + 1 || (scope !== null && request.scope !== scope)) return;
    if (!Array.isArray(body)) {
      const problem = `${request.number}쪽 목록 응답 형식을 읽지 못함`;
      if (pages === 0) firstResponseProblem = problem;
      else failure = problem;
      return;
    }
    let added = 0;
    for (const raw of body) {
      const listing = raw?.building && Array.isArray(raw.prices) ? normalize(raw) : null;
      if (!listing) {
        rejected++;
        continue;
      }
      if (!items.has(listing.sourceId)) added++;
      else duplicates++;
      items.set(listing.sourceId, { raw, listing, pageUrl: uiUrl.href, screenshot: null });
    }
    if (scope === null) {
      scope = request.scope;
      observed = request.bounds;
      mapSize = `지도 동서 ${(request.widthM / 1000).toFixed(1)}km, 남북 ${(request.heightM / 1000).toFixed(1)}km`;
    }
    pages = request.number;
    failure = null;
    repeated = body.length >= MAP_PAGE_SIZE && added === 0;
    shortPage = body.length < MAP_PAGE_SIZE;
    ended = body.length === 0;
    session.record('ziptoss', 'data', response.url(), status, `지도 목록 ${pages}쪽, 받은 ${body.length}건, 이전 쪽과 겹치지 않는 매물 ${added}건`);
  };
  const waitForPage = async (previous: number, timeout: number) => {
    for (let elapsed = 0; elapsed < timeout && !stopped() && !failure && pages === previous; elapsed += 250) {
      await page.waitForTimeout(250);
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  try {
    ctx.progress(`집토스, ${area.name} 중심 지도 목록 추가 확인`);
    const status = (await session.goto('ziptoss', uiUrl.href))?.status() ?? 0;
    if (status === 403 || status === 429) blocked = status;
    else if (status >= 400) failure = `지도 열기 HTTP ${status}`;
    await waitForPage(0, 7000);
    if (!pages && !failure && !stopped()) {
      failure = firstResponseProblem ?? (sawMatchingRequest ? '첫 정렬 목록 요청의 응답을 받지 못함'
        : sawSortedRequest ? '정렬 목록 요청의 중심 또는 경계가 조회 범위와 맞지 않음'
        : sawListRequest ? '초기 지도 요청 뒤 정렬 목록 요청을 확인하지 못함' : '첫 지도 목록 요청을 확인하지 못함');
    }

    while (pages < MAP_PAGE_LIMIT && !ended && !repeated && !failure && !stopped()) {
      const before = pages;
      ctx.progress(`집토스, ${area.name} 중심 지도 ${pages}쪽, 다음 목록 확인 중`);
      const viewport = page.viewportSize();
      const box = await page.locator('aside .scrollbar-container').boundingBox({ timeout: 2000 }).catch(() => null);
      if (!box || !viewport) {
        if (!shortPage) failure = '지도 옆 목록을 찾지 못함';
        break;
      }
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(Math.min(box.y + box.height * 0.63, viewport.height - 90));
      for (let attempt = 0; attempt < (shortPage ? 1 : 2) && !stopped() && !failure && pages === before; attempt++) {
        if (stopped()) break;
        await session.wheel(x, y, -700);
        await page.waitForTimeout(300);
        if (stopped() || pages > before) break;
        await session.wheel(x, y, 22000);
        await waitForPage(before, 3200);
      }
      if (pages === before) {
        if (!shortPage && !failure) failure = `${before + 1}쪽 응답을 확인하지 못함`;
        break;
      }
    }
  } catch {
    if (!stopped()) failure = '지도 목록을 여는 중 오류가 발생함';
  } finally {
    active = false;
    page.off('request', onRequest);
    page.off('response', onResponse);
  }

  const outcome = blocked !== null ? `접근 제한(HTTP ${blocked})으로 중단`
    : ctx.stopped?.() ? '조회 중단'
    : failure ?? (ended ? '정렬 목록의 빈 종료 페이지 확인' : repeated ? '고유 매물이 늘지 않는 목록을 받아 중단'
      : shortPage ? '50건 미만인 페이지를 받았고 목록 끝 표시는 미확인' : `예정한 ${MAP_PAGE_LIMIT}쪽까지 확인`);
  const reason = [outcome, mapSize, rejected ? `형식이 맞지 않는 매물 ${rejected}건` : '',
    duplicates ? `같은 지도 목록 안에서 매물 ${duplicates}건이 반복됨` : ''].filter(Boolean).join(', ');
  ctx.log(`집토스 ${area.name} 중심 지도: ${pages}쪽에서 고유 매물 ${items.size}건, ${reason}`);
  if (blocked !== null) ctx.partial(`집토스 ${area.name} 중심 지도: ${outcome}`, false);
  const complete = ended && observed !== null && !stopped() && !failure && !repeated && !rejected && !duplicates;
  return { items: [...items.values()], blocked: blocked !== null, observed, complete, pages, reason };
}

async function collectDistrictMap(ctx: CollectContext, area: Area) {
  const target = area.region?.code ? targetBounds(area) : null;
  const items = new Map<string, CollectedItem>();
  const visited: MapBounds[] = [];
  const verified: MapBounds[] = [];
  const issues: string[] = [];
  let focus = target ? { ...area, ...boundsCenter(target) } : area;
  let pages = 0;
  let blocked = false;
  for (let visit = 0; visit < DISTRICT_VIEW_LIMIT && !ctx.stopped?.(); visit++) {
    try { await ctx.session.rest(); } catch { break; }
    if (ctx.stopped?.()) break;
    const window = await collectMapWindow(ctx, focus);
    pages += window.pages;
    for (const item of window.items) items.set(item.listing.sourceId, item);
    if (!window.complete) issues.push(`지도 ${visit + 1}곳째에서 ${window.reason}`);
    blocked = window.blocked;
    if (blocked || ctx.stopped?.() || !target || !window.observed) break;
    const observed = window.observed;
    if (window.complete) verified.push(observed);
    const gaps = remainingBounds(target, visited);
    if (!gaps.some(gap => gap.west < observed.east && gap.east > observed.west && gap.south < observed.north && gap.north > observed.south)) break;
    visited.push(observed);
    const next = nextViewCenter(target, remainingBounds(target, visited), observed);
    if (!next) break;
    const center = boundsCenter(observed);
    const lat = focus.lat + next.lat - center.lat, lng = focus.lng + next.lng - center.lng;
    if (distanceM(focus.lat, focus.lng, lat, lng) < 10) break;
    focus = { ...focus, lat, lng };
  }
  const complete = !!target && !ctx.stopped?.() && !issues.length && !remainingBounds(target, verified).length;
  if (!complete) issues.push('구 전체 범위 미확인');
  const reason = issues.join(', ') || `지도 ${verified.length}곳에서 구 경계와 목록 끝을 확인함`;
  ctx.coverage?.({
    areaId: area.id, areaName: area.name, category: 'map-window', label: '구 지도 목록',
    pages, totalPages: complete ? pages : null, total: null, received: items.size, stored: 0, complete, reason,
  }, [...items.keys()]);
  return { items: [...items.values()], blocked, complete };
}

export const ziptoss: Collector = {
  id: 'ziptoss',
  label: '집토스',
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    const catalog = knownStations();
    const stationPlans = ctx.areas.map((area) => ({ area, stations: stationsFor(area, catalog) }));
    const stations = [...new Map(stationPlans.flatMap((plan) => plan.stations.map((station) => [station.name, station] as const))).values()];
    const stationResults = new Map<string, { ids: string[]; rejected: number }>();
    const items: CollectedItem[] = [];
    let blocked = false;
    for (const { area, stations: plannedStations } of stationPlans) {
      if (!plannedStations.length) {
        ctx.partial(`집토스 ${area.name}: 조회할 역을 찾지 못함`);
      }
    }
    ctx.log(
      stations.length
        ? `집토스: 역 페이지 ${stations.length}곳을 봅니다 (${stations.map((s) => s.name).join(', ')})`
        : '집토스: 켜진 지역 2km 안에 아는 역이 없어 건너뜁니다',
    );

    for (const [i, station] of stations.entries()) {
      if (ctx.stopped?.()) break;
      if (i > 0) await session.rest();
      const url = `https://ziptoss.com/map/${encodeURIComponent(station.name)}`;
      ctx.progress(`집토스, ${station.name} 주변 (${i + 1}/${stations.length})`);
      let response;
      try {
        response = await session.goto('ziptoss', url);
      } catch {
        if (ctx.stopped?.()) break;
        ctx.partial(`집토스 ${station.name}: 페이지를 열지 못함`);
        continue;
      }
      const status = response?.status() ?? 0;
      if (status === 403 || status === 429) {
        blocked = true;
        ctx.partial(`집토스 ${station.name}: 접근 제한(HTTP ${status})으로 조회 중단`, false);
        break;
      }
      if (status >= 400) {
        ctx.log(`집토스: ${station.name} 페이지 응답 ${status}, 건너뜁니다`);
        ctx.partial(`집토스 ${station.name}: HTTP ${status}`);
        continue;
      }
      ctx.progress(`집토스, ${station.name} 주변 (${i + 1}/${stations.length}), 목록 읽는 중`);

      // window.__NEXT_DATA__는 화면 스크립트가 돈 뒤에야 생기므로, 페이지에 박힌 원본 스크립트 태그를 직접 읽는다.
      const raws: any[] | null = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        const data = el?.textContent ? JSON.parse(el.textContent) : (window as any).__NEXT_DATA__;
        return data?.props?.pageProps?.properties ?? null;
      }).catch(() => null);
      if (!Array.isArray(raws)) {
        ctx.log(`집토스: ${station.name} 페이지에서 매물 데이터를 찾지 못했습니다(화면 구조가 바뀌었을 수 있음)`);
        ctx.partial(`집토스 ${station.name}: 매물 목록을 읽지 못함`);
        continue;
      }
      session.record('ziptoss', 'data', url, status, `페이지에 담긴 매물 목록 ${raws.length}건 읽음`);
      const pairs = raws.map((raw) => ({ raw, listing: normalize(raw) })).filter((x): x is { raw: any; listing: NormalizedListing } => !!x.listing);
      const listings = pairs.map((x) => x.listing);
      const rejected = raws.length - listings.length;
      stationResults.set(station.name, { ids: listings.map((listing) => listing.sourceId), rejected });
      if (rejected) ctx.partial(`집토스 ${station.name}: 식별값을 읽지 못한 매물 ${rejected}건`);

      // 지도가 뜨면 목록을 한 번 더 불러와 카드가 잠깐 회색 로딩 상태가 되므로, 그게 끝나고 글자가 찬 카드가 보일 때까지 기다린다.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page
        .waitForFunction(() => Array.from(document.querySelectorAll('ul li')).filter((li) => /㎡/.test((li as HTMLElement).innerText)).length > 3, null, { timeout: 10000 })
        .catch(() => {});

      // 위쪽 카드(ul > li)는 링크 없이 클릭으로 열리므로 면적, 가격으로 짝을 짓고, 아래쪽 표는 매물 링크로 짝을 짓는다.
      const summaries = listings.map((l) => ({
        id: l.sourceId,
        key: ziptossKey(l.sourceId),
        area: l.areaM2,
        prices: l.prices.map((p) => ({ amount: p.deposit ?? p.price, monthly: p.monthly })),
      }));
      // 위쪽 카드는 일부 매물만 보여 주므로 세지 않고, 매물이 다 나오는 아래쪽 표에서 몇 건을 찾았는지만 센다.
      const tableRows = await page.evaluate((list) => {
        const parseMoney = (s: string) => {
          const m = s.replace(/[,\s]/g, '').match(/^(?:(\d+)억)?(\d+)?$/);
          return m ? Number(m[1] ?? 0) * 10000 + Number(m[2] ?? 0) : null;
        };
        let rows = 0;
        for (const card of Array.from(document.querySelectorAll<HTMLElement>('li'))) {
          if (card.closest('table') || !card.querySelector('[style*="background-image"]')) continue;
          const text = card.innerText;
          const area = Number(text.match(/(\d+(?:\.\d+)?)\s*㎡/)?.[1] ?? NaN);
          const price = text.match(/(월세|전세|매매|단기)\s*([\d억,]+)(?:\s*\/\s*([\d,]+))?/);
          if (!price || Number.isNaN(area)) continue;
          const amount = parseMoney(price[2]);
          const monthly = price[3] ? Number(price[3].replace(/,/g, '')) : null;
          const hit = list.find((it) => it.area != null && Math.abs(it.area - area) < 0.05 && it.prices.some((p) => p.amount === amount && (p.monthly ?? null) === monthly));
          if (hit) card.setAttribute('data-hnw-id', hit.id);
        }
        for (const it of list) {
          const cell = document.querySelector(`a[href*="propertyKey=${it.key}"]`)?.closest('tr')?.querySelector('td');
          if (cell) {
            cell.setAttribute('data-hnw-row', it.id);
            rows += 1;
          }
        }
        return rows;
      }, summaries);

      const tones = ctx.classify(listings);
      await session.badges(listings.map((l) => ({ selector: `[data-hnw-id="${l.sourceId}"]`, tone: tones.get(l.sourceId) ?? 'new' })), 60);
      await session.badges(listings.map((l) => ({ selector: `[data-hnw-row="${l.sourceId}"]`, tone: tones.get(l.sourceId) ?? 'new' })));
      await session.pause(800);
      const shot = await session.screenshot('ziptoss', station.name);

      // 창으로 볼 때는 페이지를 끝까지 천천히 내려서, 아래쪽 표의 매물까지 전부 배지가 붙은 걸 보여 준다.
      if (session.visible) {
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        const steps = Math.min(Math.ceil(height / 700), 25);
        for (let s = 0; s < steps; s++) {
          ctx.progress(`집토스, ${station.name}, ${listings.length}건 읽음, 배지 붙은 화면을 내려 보는 중 (${s + 1}/${steps})`);
          await session.wheel(900, 500, 700);
          await session.pause(450);
        }
      }

      for (const { raw, listing } of pairs) items.push({ listing, raw, pageUrl: url, screenshot: shot });
      // 표에서 못 찾은 매물도 저장은 되고 화면에 배지만 안 붙는다. 그런 매물이 있을 때만 덧붙인다.
      const missing = listings.length - tableRows;
      const note = missing <= 0 ? '' : tableRows === 0
        ? ', 화면 표에서 하나도 찾지 못해 배지를 못 붙임(화면 구조가 바뀌었을 수 있음)'
        : `, 그중 ${missing}건은 화면 표에서 찾지 못해 배지를 못 붙임`;
      ctx.log(`집토스: ${station.name} ${listings.length}건 읽음${note}`);
      await session.pause(PAGE_DELAY_MS);
    }
    const districtsVerified = new Set<number>();
    const seen = new Set(items.map(({ listing }) => listing.sourceId));
    for (const area of ctx.areas) {
      if (blocked || ctx.stopped?.()) break;
      if (area.region?.kind !== 'gu') continue;
      const supplemental = await collectDistrictMap(ctx, area);
      if (supplemental.complete) districtsVerified.add(area.id);
      for (const item of supplemental.items) {
        if (seen.has(item.listing.sourceId)) continue;
        seen.add(item.listing.sourceId);
        items.push(item);
      }
      blocked = supplemental.blocked;
    }
    for (const { area, stations: plannedStations } of stationPlans) {
      const read = plannedStations.flatMap((station) => stationResults.get(station.name) ?? []);
      const ids = [...new Set(read.flatMap((page) => page.ids))];
      const rejected = read.reduce((total, page) => total + page.rejected, 0);
      const reasons: string[] = [];
      if (!plannedStations.length) reasons.push('조회할 역을 찾지 못함');
      else if (read.length < plannedStations.length) reasons.push(`목록을 못 읽은 역 페이지 ${plannedStations.length - read.length}곳`);
      if (rejected) reasons.push(`식별값을 읽지 못한 매물 ${rejected}건`);
      if (area.region && !districtsVerified.has(area.id)) reasons.push('역 페이지로 구나 동 전체 범위를 확인할 수 없음');
      ctx.coverage?.({
        areaId: area.id, areaName: area.name, category: 'station-pages', label: '역 페이지',
        pages: read.length, totalPages: plannedStations.length, total: null, received: ids.length, stored: 0,
        complete: reasons.length === 0, reason: reasons.join(', ') || '예정된 역 페이지의 목록을 모두 읽음',
      }, ids);
    }
    return items;
  },
};
