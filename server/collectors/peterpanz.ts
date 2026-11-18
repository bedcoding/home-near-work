import type { Request, Response } from 'playwright';
import type { BrowserSession } from '../browser.js';
import { PAGE_DELAY_MS } from '../config.js';
import {
  nextPeterpanzViewCenter, parsePeterpanzBounds, peterpanzBoundsCenter, peterpanzBoundsShortages,
  peterpanzTargetBounds, remainingPeterpanzBounds, type PeterpanzBounds,
} from '../peterpanz-coverage.js';
import { BlockedError, toNumber, type Collector, type CollectedItem } from './types.js';
import { floorText, money, priceText, yesNo } from '../../shared/format.js';
import type { Area, DealType, ExplainRow, NormalizedListing, PriceOption } from '../../shared/types.js';

// 피터팬은 화면을 조작해 모은다.
// 1) 역 위치로 지도를 열고 2) 왼쪽 목록에 가려진 만큼 지도를 끌어 역을 보이는 지도 가운데로 맞추고
// 3) 목록을 휠로 끝까지 내린다. 데이터는 그때 화면이 스스로 불러오는 목록 응답을 같이 읽는다.
// 휠로 더 내려도 안 불러와지는 쪽이 남으면, 화면이 쓰던 같은 목록 주소로 이어 받고 요청 기록에 그렇게 남긴다.
// (검색창으로 이동하면 목록이 역이 있는 동 하나로 걸러져서 쓰지 않는다.)

export const PETERPANZ_CATEGORIES = [
  { path: 'villa', buildingType: '빌라/주택', label: '빌라와 주택' },
  { path: 'officetel', buildingType: '오피스텔', label: '오피스텔' },
  { path: 'apt', buildingType: '아파트', label: '아파트' },
] as const;

const centerParam = (lat: number, lng: number) => encodeURIComponent(JSON.stringify({ y: lat, _lat: lat, x: lng, _lng: lng }));

function mapUrl(cat: (typeof PETERPANZ_CATEGORIES)[number], area: Area, zoom: number) {
  return (
    `https://www.peterpanz.com/${cat.path}?zoomLevel=${zoom}&center=${centerParam(area.lat, area.lng)}&dong=&gungu=` +
    `&filter=${encodeURIComponent(`buildingType;["${cat.buildingType}"]`)}&filter_version=5.1`
  );
}

function viewSize(area: Area, bounds: PeterpanzBounds) {
  return {
    heightKm: (bounds.north - bounds.south) * 111.32,
    widthKm: (bounds.east - bounds.west) * 111.32 * Math.cos(area.lat * Math.PI / 180),
  };
}

/**
 * 지도가 역 근처로 열렸는지: 역이 지도 안에 있고, 지도 남북 폭이 고른 줌의 1.5배를 넘지 않는다(줌 15는 약 2.8km, 한 단계마다 2배).
 * 처음 쓰는 브라우저 탭이나 프로필에서는 주소의 위치와 줌을 무시하고 서울 전체(남북 20km 넘게)가 뜨기도 하는데, 그때도 역은 지도 안이라
 * 가운데만 보면 통과해서 서울 전체 목록(1만 건 넘게)을 읽게 된다.
 */
export function openedNear(area: Area, raw: unknown, zoom: number) {
  const bounds = parsePeterpanzBounds(raw);
  if (!bounds || area.lat < bounds.south || area.lat > bounds.north || area.lng < bounds.west || area.lng > bounds.east) return false;
  return viewSize(area, bounds).heightKm <= 2.8 * 2 ** (15 - zoom) * 1.5;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 30;
const MAX_DISTRICT_VIEWS = 3;
// 아파트 화면은 목록을 /houses/area/apt/agency/pc 로 부른다.
const LIST_PATHS = new Set(['/houses/area', '/houses/area/pc', '/houses/area/apt/agency/pc']);
function listUrl(value: string): URL | null {
  const url = new URL(value);
  return url.origin === 'https://api.peterpanz.com' && LIST_PATHS.has(url.pathname) ? url : null;
}
const firstPage = (r: Response) => listUrl(r.url())?.searchParams.get('pageIndex') === '1';

function listScope(url: URL): string {
  const query = new URL(url).searchParams;
  query.delete('pageIndex');
  query.delete('order_id');
  query.sort();
  return `${url.pathname}?${query}`;
}

/** 원 → 만원 */
const manwon = (value: unknown) => {
  const n = toNumber(value);
  return n == null ? null : Math.round(n / 10000);
};

const DEALS: Record<string, DealType> = { 월세: 'monthly', 전세: 'jeonse', 매매: 'sale', 단기: 'short', 단기임대: 'short' };

function normalize(h: any): NormalizedListing | null {
  if (!h?.hidx) return null;
  const contract = String(h.type?.contract_type ?? '');
  const deal = DEALS[contract];
  const price: PriceOption | null = deal
    ? {
        deal,
        deposit: deal === 'sale' ? null : manwon(h.price?.deposit),
        monthly: deal === 'monthly' || deal === 'short' ? manwon(h.price?.monthly_fee) : null,
        price: deal === 'sale' ? manwon(h.price?.price ?? h.price?.deposit) : null,
      }
    : null;
  const floorRaw = String(h.floor?.floor_text ?? '');
  const flag = (v: unknown) => (v === 1 ? true : v === 0 ? false : null);
  const listing: NormalizedListing = {
    source: 'peterpanz',
    sourceId: String(h.hidx),
    url: `https://www.peterpanz.com/house/${h.hidx}`,
    title: String(h.info?.subject ?? '').trim(),
    thumbnail: h.info?.thumbnail ?? null,
    lat: toNumber(h.location?.coordinate?.latitude),
    lng: toNumber(h.location?.coordinate?.longitude),
    address: h.location?.address?.text ?? null,
    dong: h.location?.address?.dong ?? null,
    buildingKey: h.building_id ? `pp-b${h.building_id}` : null,
    buildingType: h.type?.building_type ?? null,
    roomLabel: h.info?.room_type ?? h.type?.building_form ?? null,
    rooms: toNumber(h.info?.room_count),
    areaM2: toNumber(h.info?.real_size) ?? toNumber(h.info?.supplied_size),
    floor: toNumber(h.floor?.target),
    totalFloors: toNumber(h.floor?.total),
    basement: h.info?.is_half_underground === 1 || /반지|지하/.test(floorRaw),
    rooftop: h.info?.is_octop === 1 || /옥탑/.test(floorRaw),
    builtYear: null,
    maintenance: manwon(h.price?.maintenance_cost),
    elevator: flag(h.additional_options?.have_elevator),
    parking: flag(h.additional_options?.have_parking_lot),
    availableFrom: h.info?.live_start_date ? String(h.info.live_start_date).slice(0, 10) : null,
    updatedAt: h.attribute?.naverUpdatedAt ?? h.info?.created_at ?? null,
    prices: price ? [price] : [],
  };
  const explain: ExplainRow[] = [
    {
      label: '가격',
      raw: `type.contract_type="${contract}", price.deposit=${h.price?.deposit ?? '없음'}원, price.monthly_fee=${h.price?.monthly_fee ?? '없음'}원`,
      value: listing.prices.map(priceText).join(', ') || '없음',
      note: '원 → 만원으로 바꿈',
    },
    { label: '전용면적', raw: `info.real_size=${h.info?.real_size ?? '없음'}, info.supplied_size=${h.info?.supplied_size ?? '없음'}`, value: listing.areaM2 != null ? `${listing.areaM2}㎡` : '모름' },
    { label: '층', raw: `floor.floor_text="${floorRaw}", floor.target=${h.floor?.target ?? '없음'}, floor.total=${h.floor?.total ?? '없음'}`, value: floorText(listing) },
    { label: '반지하와 옥탑', raw: `info.is_half_underground=${h.info?.is_half_underground ?? '없음'}, info.is_octop=${h.info?.is_octop ?? '없음'}`, value: `반지하 ${listing.basement ? '예' : '아니오'}, 옥탑 ${listing.rooftop ? '예' : '아니오'}`, note: '층 글자에 반지, 지하, 옥탑이 있어도 예로 봄' },
    { label: '방', raw: `info.room_type="${h.info?.room_type ?? ''}", info.room_count=${h.info?.room_count ?? '없음'}`, value: `${listing.roomLabel ?? '모름'}, 방 ${listing.rooms ?? '?'}개` },
    { label: '관리비', raw: `price.maintenance_cost=${h.price?.maintenance_cost ?? '없음'}원`, value: listing.maintenance != null ? `${money(listing.maintenance)}만` : '모름', note: '원 → 만원으로 바꿈' },
    { label: '입주 가능일', raw: `info.live_start_date="${h.info?.live_start_date ?? ''}"`, value: listing.availableFrom ?? '모름' },
    { label: '엘리베이터', raw: `additional_options.have_elevator=${h.additional_options?.have_elevator ?? '없음'}`, value: yesNo(listing.elevator), note: '1은 있음, 0은 없음으로 봄' },
    { label: '위치', raw: `location.coordinate=${h.location?.coordinate?.latitude}, ${h.location?.coordinate?.longitude}`, value: `${listing.lat}, ${listing.lng}` },
    { label: '건물 식별값', raw: `building_id="${h.building_id ?? ''}"`, value: listing.buildingKey ?? '없음', note: '재등록(같은 집) 판정에 씀' },
  ];
  listing.explain = explain;
  return listing;
}

/** 지도를 가리는 광고 창의 닫기를 누른다. */
async function closePopups(session: BrowserSession) {
  const button = session.page.locator('button:has-text("닫기")').first();
  if (await button.isVisible().catch(() => false)) {
    await session.click(button).catch(() => {});
    await session.pause(600);
  }
}

export const peterpanz: Collector = {
  id: 'peterpanz',
  label: '피터팬',
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    const items = new Map<string, CollectedItem>();
    let finishInterrupted: ((reason?: string) => void) | null = null;

    // 화면이 스스로 불러오는 목록 응답을 옆에서 같이 읽는다.
    let collecting = false;
    let current = new Map<string, any>();
    let total = 0;
    let pagesLoaded = 0;
    const receivedPages = new Set<number>();
    let bounds: unknown = null;
    let firstPageUrl: string | null = null;
    let firstPageScope: string | null = null;
    let orderId: string | null = null;
    let blockedStatus: number | null = null;
    let viewVersion = 0;
    const requestViews = new WeakMap<Request, number>();
    const pending: Promise<void>[] = [];
    const onRequest = (request: Request) => {
      if (listUrl(request.url())) requestViews.set(request, viewVersion);
    };
    const onResponse = (r: Response) => {
      const url = r.url();
      const parsed = listUrl(url);
      if (!parsed) return;
      const version = requestViews.get(r.request());
      if (version !== viewVersion) return;
      pending.push(
        (async () => {
          if (r.status() === 403 || r.status() === 429) {
            blockedStatus = r.status();
            return;
          }
          const data: any = await r.json().catch(() => null);
          if (version !== viewVersion) return;
          const count = toNumber(data?.totalCount);
          if (r.status() >= 400 || count == null || !Number.isSafeInteger(count) || count < 0 || !data.houses || typeof data.houses !== 'object') {
            session.record('peterpanz', 'data', url, r.status(), '응답을 읽지 못함');
            return;
          }
          const pageIndex = Number(parsed.searchParams.get('pageIndex') ?? '1');
          if (!Number.isInteger(pageIndex) || pageIndex < 1) return;
          const scope = listScope(parsed);
          if (pageIndex !== 1 && scope !== firstPageScope) return;
          const houses = Object.values(data.houses).flatMap((g: any) => Object.values(g ?? {}).flat()) as any[];
          if (!collecting) {
            session.record('peterpanz', 'data', url, r.status(), `화면 이동 중에 불러온 목록 ${houses.length}건(전체 ${data.totalCount ?? '?'}건), 저장 안 함`);
            return;
          }
          if (pageIndex === 1) {
            // 지도가 옮겨질 때마다 1쪽부터 다시 불러오므로 새로 시작한다.
            current = new Map();
            total = count;
            bounds = data.debug?.search ?? null;
            pagesLoaded = 0;
            receivedPages.clear();
            firstPageUrl = url;
            firstPageScope = scope;
            orderId = data.orderId != null ? String(data.orderId) : null;
          }
          for (const h of houses) if (h?.hidx) current.set(String(h.hidx), h);
          pagesLoaded = Math.max(pagesLoaded, pageIndex);
          receivedPages.add(pageIndex);
          session.record('peterpanz', 'data', url, r.status(), `목록 ${pageIndex}쪽 ${houses.length}건 (전체 ${data.totalCount ?? '?'}건)`);
        })(),
      );
    };
    const settle = async () => {
      await Promise.allSettled(pending.splice(0));
      if (blockedStatus) throw new BlockedError(`피터팬이 목록 요청을 막았습니다(HTTP ${blockedStatus}). 우회하지 않고 멈춥니다.`);
    };

    page.on('request', onRequest);
    page.on('response', onResponse);
    try {
      for (const [ai, area] of ctx.areas.entries()) {
        if (ctx.stopped?.()) break;
        if (ai > 0) await session.rest();
        // 반경이 크면 한 단계 넓게 본다(피터팬 줌 15에서 보이는 지도는 남북 약 2.8km).
        const zoom = area.radiusM > 1300 ? 14 : 15;
        for (const cat of PETERPANZ_CATEGORIES) {
          if (ctx.stopped?.()) break;
          const scope = { areaId: area.id, areaName: area.name, category: cat.path, label: cat.label, stored: 0 };
          const district = area.region?.kind === 'gu';
          const target = peterpanzTargetBounds(area);
          const confirmedViews: PeterpanzBounds[] = [];
          const viewReceipts: { pages: number; totalPages: number; total: number }[] = [];
          const ids = new Set<string>();
          const issues: string[] = [];
          const reportIssue = (reason: string, retry?: boolean) => {
            issues.push(reason);
            ctx.partial(`피터팬 ${area.name} ${cat.label}: ${reason}`, retry);
          };
          const reportScope = () => {
            if (ctx.stopped?.()) reportIssue('조회가 중단됨', false);
            if (!ctx.stopped?.() && target && viewReceipts.length && remainingPeterpanzBounds(target, confirmedViews).length) {
              const view = confirmedViews[0] ?? parsePeterpanzBounds(bounds);
              const shortages = view && viewReceipts.length === 1 ? peterpanzBoundsShortages(target, view) : [];
              if (shortages.length) {
                reportIssue(`${district ? '구 경계' : `반경 ${area.radiusM}m`} 중 ${shortages.join(', ')}`, false);
              } else if (confirmedViews.length) {
                reportIssue(`지도 ${viewReceipts.length}곳을 조회했지만 ${district ? '구 경계' : '설정 반경'}에 미확인 구간이 남음`, false);
              }
            }
            ctx.coverage?.({ ...scope,
              pages: viewReceipts.reduce((sum, view) => sum + view.pages, 0),
              totalPages: viewReceipts.length ? viewReceipts.reduce((sum, view) => sum + view.totalPages, 0) : null,
              total: viewReceipts.length === 1 ? viewReceipts[0].total : null, received: ids.size,
              complete: !issues.length, reason: issues.join(', ') || (district
                ? `지도 ${viewReceipts.length}곳에서 구 경계를 덮고 목록을 확인함`
                : `설정 반경 ${area.radiusM}m의 지도 목록 확인`),
            }, [...ids]);
          };
          let focus = district && target ? { ...area, ...peterpanzBoundsCenter(target) } : area;
          for (let visit = 0; visit < (district ? MAX_DISTRICT_VIEWS : 1); visit++) {
            if (ctx.stopped?.()) break;
            current = new Map();
            total = 0;
            pagesLoaded = 0;
            receivedPages.clear();
            bounds = null;
            firstPageUrl = null;
            firstPageScope = null;
            orderId = null;
            const initialIssueCount = issues.length;
            const recordResults = (shot: string | null) => {
              const view = parsePeterpanzBounds(bounds);
              if (view) {
                const { heightKm, widthKm } = viewSize(area, view);
                ctx.log(`피터팬: ${area.name} ${cat.label} 지도 범위 남북 ${heightKm.toFixed(1)}km × 동서 ${widthKm.toFixed(1)}km, 목록 전체 ${total}건`);
              }
              if (!view || !target) reportIssue('지도 조회 범위를 확인하지 못함');

              const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
              const confirmedPages = [...receivedPages].filter(pageIndex => pageIndex <= totalPages).length;
              if (confirmedPages < totalPages) reportIssue(`목록 ${totalPages}쪽 중 ${confirmedPages}쪽만 확인`);
              ctx.log(`피터팬: ${area.name} ${cat.label} 목록 ${total}건 중 ${current.size}건 읽음`);
              if (current.size !== total) reportIssue(`목록 전체 ${total}건, 고유 매물 ${current.size}건 수신`);

              const pageUrl = page.url();
              for (const raw of current.values()) {
                const listing = normalize(raw);
                if (listing) {
                  ids.add(listing.sourceId);
                  items.set(listing.sourceId, { listing, raw, pageUrl, screenshot: shot });
                }
              }
              viewReceipts.push({ pages: confirmedPages, totalPages, total });
              if (view && issues.length === initialIssueCount && !ctx.stopped?.()) confirmedViews.push(view);
            };

            // 1) 지역이나 아직 못 읽은 구간의 지도를 연다.
            collecting = true;
            ctx.progress(`피터팬, ${area.name}, ${cat.label}, ${visit === 0 ? '지도 여는 중' : '빠진 지도 구간 여는 중'}`);
            for (let attempt = 1; attempt <= 3 && !ctx.stopped?.(); attempt++) {
              viewVersion++;
              const firstList = page.waitForResponse(firstPage, { timeout: 15000 }).catch(() => null);
              const response = await session.goto('peterpanz', mapUrl(cat, focus, zoom));
              const status = response?.status() ?? 0;
              if (status === 403 || status === 429) throw new BlockedError(`피터팬이 요청을 막았습니다(HTTP ${status}). 우회하지 않고 멈춥니다.`);
              await firstList;
              await session.pause(1200);
              await settle();
              // 처음 방문하는 프로필에서는 주소의 위치를 무시하고 기본 화면(서울시청)이 뜨기도 해서, 그러면 한 번 더 연다.
              if (openedNear(focus, bounds, zoom)) break;
              const view = parsePeterpanzBounds(bounds);
              const span = view && viewSize(area, view);
              ctx.log(`피터팬: 지도가 ${area.name} 근처로 열리지 않아(${span ? `남북 ${span.heightKm.toFixed(1)}km` : '범위 모름'}) ${attempt < 3 ? '다시 엽니다' : '이 종류는 건너뜁니다'}(${attempt}번째)`);
            }
            if (!openedNear(focus, bounds, zoom)) {
              if (ctx.stopped?.()) break;
              // 엉뚱한 범위(서울 전체 등)의 목록은 읽지 않는다. 다 돈 것으로 치지 않아 안 보인 매물을 사라짐으로 두지도 않는다.
              reportIssue(district ? '조회할 구간의 지도를 열지 못함' : '지도가 역 근처로 열리지 않음');
              collecting = false;
              break;
            }
            finishInterrupted = (reason) => {
              if (reason) reportIssue(reason, false);
              recordResults(null);
              reportScope();
            };
            if (ctx.stopped?.()) {
              finishInterrupted = null;
              recordResults(null);
              break;
            }
            await closePopups(session);

            // 2) 왼쪽 목록이 지도를 가리는 만큼 지도를 오른쪽으로 끌어, 역이 보이는 지도의 가운데에 오게 한다.
            const layout = await page.evaluate(() => ({
              listRight: document.querySelector('div.list__wrapper')?.getBoundingClientRect().right ?? 0,
              width: innerWidth,
            }));
            const dx = Math.round((layout.listRight + layout.width) / 2 - layout.width / 2);
            if (!district && dx > 20 && !ctx.stopped?.()) {
              ctx.progress(`피터팬, ${area.name}, ${cat.label}, 지도를 끌어 역을 가운데로`);
              const refreshed = page.waitForResponse(firstPage, { timeout: 15000 }).catch(() => null);
              const x = Math.round(layout.listRight + 80);
              await session.drag(x, 260, x + dx, 260);
              session.record('peterpanz', 'action', page.url(), null, `지도를 오른쪽으로 ${dx}px 끌기`);
              await refreshed;
              await session.pause(1200);
            }
            await settle();

            // 3) 목록을 휠로 내려 끝까지 불러온다. 새로 읽힌 카드는 차례로 칠한다.
            const listBox = await page.locator('div.list__wrapper').boundingBox();
            const marked = new Set<string>();
            const markNew = async () => {
              const listings = [...current.values()].map(normalize).filter((x): x is NormalizedListing => !!x);
              const fresh = listings.filter((l) => !marked.has(l.sourceId));
              fresh.forEach((l) => marked.add(l.sourceId));
              const tones = ctx.classify(fresh);
              await session.badges(fresh.map((l) => ({ selector: `div.a-house[data-hidx="${l.sourceId}"]`, tone: tones.get(l.sourceId) ?? 'new' })), 40);
            };
            if (!ctx.stopped?.()) await markNew();
            let stalls = 0;
            let lastCount = current.size;
            while (listBox && current.size < total && stalls < 4 && pagesLoaded < MAX_PAGES && !ctx.stopped?.()) {
              const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
              ctx.progress(`피터팬, ${area.name}, ${cat.label}, 목록 ${receivedPages.size}/${pages}쪽, ${current.size}/${total}건 읽음`);
              for (let i = 0; i < 6 && !ctx.stopped?.(); i++) {
                await session.wheel(listBox.x + listBox.width / 2, listBox.y + listBox.height * 0.6, 900);
                if (!ctx.stopped?.()) await session.pause(300);
              }
              if (!ctx.stopped?.()) await session.pause(1200);
              await settle();
              if (ctx.stopped?.()) break;
              if (current.size > lastCount) {
                stalls = 0;
                lastCount = current.size;
                await markNew();
              } else stalls += 1;
            }

            // 4) 휠로 더 내려도 안 불러와진 쪽은 화면이 쓰던 같은 목록 주소로 이어 받는다(요청 기록에 표시).
            const pageLimit = Math.min(Math.ceil(total / PAGE_SIZE), MAX_PAGES);
            const missingPages = Array.from({ length: Math.max(0, pageLimit - 1) }, (_, i) => i + 2)
              .filter(pageIndex => !receivedPages.has(pageIndex));
            if (!ctx.stopped?.() && firstPageUrl && missingPages.length) {
              ctx.log(`피터팬: ${area.name} ${cat.label} 휠로 못 읽은 ${missingPages.length}쪽을 같은 목록 주소로 이어 받습니다`);
              for (const pageIndex of missingPages) {
                if (ctx.stopped?.()) break;
                if (receivedPages.has(pageIndex)) continue;
                const next = new URL(firstPageUrl);
                next.searchParams.set('pageIndex', String(pageIndex));
                if (orderId) next.searchParams.set('order_id', orderId);
                ctx.progress(`피터팬, ${area.name}, ${cat.label}, 나머지 ${pageIndex}/${pageLimit}쪽 이어 받는 중`);
                const res: { status: number; json: any } = await page.evaluate(async (u) => {
                  const r = await fetch(u, { credentials: 'omit' });
                  const type = r.headers.get('content-type') ?? '';
                  return { status: r.status, json: type.includes('json') ? await r.json() : null };
                }, next.toString());
                if (res.status === 403 || res.status === 429) throw new BlockedError(`피터팬이 요청을 막았습니다(HTTP ${res.status}). 우회하지 않고 멈춥니다.`);
                if (res.status >= 400 || !res.json?.houses || typeof res.json.houses !== 'object') {
                  reportIssue(`${pageIndex}쪽 응답을 읽지 못함`);
                  break;
                }
                const houses = Object.values(res.json?.houses ?? {}).flatMap((g: any) => Object.values(g ?? {}).flat()) as any[];
                for (const h of houses) if (h?.hidx) current.set(String(h.hidx), h);
                receivedPages.add(pageIndex);
                session.record('peterpanz', 'data', next.toString(), res.status, `휠로 안 불러와져 이어 받은 목록 ${pageIndex}쪽 ${houses.length}건`);
                if (!ctx.stopped?.()) await session.pause(1500);
              }
            }
            await settle();
            collecting = false;

            const shot = ctx.stopped?.() ? null : await session.screenshot('peterpanz', `${area.name}-${cat.label}${visit === 0 ? '' : `-${visit + 1}`}`);
            finishInterrupted = null;
            recordResults(shot);
            if (ctx.stopped?.()) break;
            await session.pause(PAGE_DELAY_MS);
            if (!district || !target || issues.length !== initialIssueCount) break;
            const view = confirmedViews.at(-1);
            const desired = view && nextPeterpanzViewCenter(target, remainingPeterpanzBounds(target, confirmedViews), view);
            if (!view || !desired) break;
            const actual = peterpanzBoundsCenter(view);
            focus = { ...area, lat: focus.lat + desired.lat - actual.lat, lng: focus.lng + desired.lng - actual.lng };
          }
          reportScope();
        }
      }
    } catch (error) {
      if (ctx.stopped?.()) {
        await Promise.allSettled(pending.splice(0));
        collecting = false;
        finishInterrupted?.();
      } else if (error instanceof BlockedError) {
        collecting = false;
        if (finishInterrupted) finishInterrupted(error.message);
        else ctx.partial(error.message, false);
      } else {
        throw error;
      }
    } finally {
      page.off('request', onRequest);
      page.off('response', onResponse);
    }
    return [...items.values()];
  },
};
