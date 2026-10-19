import type { Response } from 'playwright';
import type { BrowserSession } from '../browser.js';
import { PAGE_DELAY_MS } from '../config.js';
import { BlockedError, toNumber, type Collector, type CollectedItem } from './types.js';
import { floorText, money, priceText, yesNo } from '../../shared/format.js';
import type { Area, DealType, ExplainRow, NormalizedListing, PriceOption } from '../../shared/types.js';

// 피터팬은 화면을 조작해 모은다.
// 1) 역 위치로 지도를 열고 2) 왼쪽 목록에 가려진 만큼 지도를 끌어 역을 보이는 지도 가운데로 맞추고
// 3) 목록을 휠로 끝까지 내린다. 데이터는 그때 화면이 스스로 불러오는 목록 응답을 같이 읽는다.
// 휠로 더 내려도 안 불러와지는 쪽이 남으면, 화면이 쓰던 같은 목록 주소로 이어 받고 요청 기록에 그렇게 남긴다.
// (검색창으로 이동하면 목록이 역이 있는 동 하나로 걸러져서 쓰지 않는다.)

const CATEGORIES = [
  { path: 'villa', buildingType: '빌라/주택', label: '빌라와 주택' },
  { path: 'officetel', buildingType: '오피스텔', label: '오피스텔' },
  { path: 'apt', buildingType: '아파트', label: '아파트' },
] as const;

const centerParam = (lat: number, lng: number) => encodeURIComponent(JSON.stringify({ y: lat, _lat: lat, x: lng, _lng: lng }));

function mapUrl(cat: (typeof CATEGORIES)[number], area: Area, zoom: number) {
  return (
    `https://www.peterpanz.com/${cat.path}?zoomLevel=${zoom}&center=${centerParam(area.lat, area.lng)}&dong=&gungu=` +
    `&filter=${encodeURIComponent(`buildingType;["${cat.buildingType}"]`)}&filter_version=5.1`
  );
}

/** 목록 응답의 지도 범위 안에 지역 중심이 들어 있는지. */
function containsCenter(area: Area, b: any) {
  return !!b && Number(b.latitudeFrom) <= area.lat && area.lat <= Number(b.latitudeTo) && Number(b.longitudeFrom) <= area.lng && area.lng <= Number(b.longitudeTo);
}

const PAGE_SIZE = 50;
const MAX_PAGES = 30;
const LIST_API = 'api.peterpanz.com/houses/area';

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
    { label: '반지하·옥탑', raw: `info.is_half_underground=${h.info?.is_half_underground ?? '없음'}, info.is_octop=${h.info?.is_octop ?? '없음'}`, value: `반지하 ${listing.basement ? '예' : '아니오'}, 옥탑 ${listing.rooftop ? '예' : '아니오'}`, note: '층 글자에 반지·지하·옥탑이 있어도 예로 봄' },
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

/** 목록 응답의 지도 범위가 지역 원을 얼마나 덮는지. */
function coverage(area: Area, bounds: any) {
  if (!bounds) return null;
  const latFrom = Number(bounds.latitudeFrom);
  const latTo = Number(bounds.latitudeTo);
  const lngFrom = Number(bounds.longitudeFrom);
  const lngTo = Number(bounds.longitudeTo);
  if (![latFrom, latTo, lngFrom, lngTo].every(Number.isFinite)) return null;
  const mLat = 111320;
  const mLng = 111320 * Math.cos((area.lat * Math.PI) / 180);
  const margins = {
    north: (latTo - area.lat) * mLat,
    south: (area.lat - latFrom) * mLat,
    east: (lngTo - area.lng) * mLng,
    west: (area.lng - lngFrom) * mLng,
  };
  return {
    heightKm: ((latTo - latFrom) * mLat) / 1000,
    widthKm: ((lngTo - lngFrom) * mLng) / 1000,
    minMargin: Math.min(...Object.values(margins)),
  };
}

export const peterpanz: Collector = {
  id: 'peterpanz',
  label: '피터팬',
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    const items: CollectedItem[] = [];

    // 화면이 스스로 불러오는 목록 응답을 옆에서 같이 읽는다.
    let collecting = false;
    let current = new Map<string, any>();
    let total = 0;
    let pagesLoaded = 0;
    let bounds: any = null;
    let firstPageUrl: string | null = null;
    let orderId: string | null = null;
    const pending: Promise<void>[] = [];
    const onResponse = (r: Response) => {
      const url = r.url();
      if (!url.includes(LIST_API)) return;
      pending.push(
        (async () => {
          const data: any = await r.json().catch(() => null);
          if (!data) {
            session.record('peterpanz', 'data', url, r.status(), '응답을 읽지 못함');
            return;
          }
          const pageIndex = Number(new URL(url).searchParams.get('pageIndex') ?? '1');
          const houses = Object.values(data.houses ?? {}).flatMap((g: any) => Object.values(g ?? {}).flat()) as any[];
          if (!collecting) {
            session.record('peterpanz', 'data', url, r.status(), `화면 이동 중에 불러온 목록 ${houses.length}건(전체 ${data.totalCount ?? '?'}건), 저장 안 함`);
            return;
          }
          if (pageIndex === 1) {
            // 지도가 옮겨질 때마다 1쪽부터 다시 불러오므로 새로 시작한다.
            current = new Map();
            total = Number(data.totalCount ?? 0);
            bounds = data.debug?.search ?? null;
            pagesLoaded = 0;
            firstPageUrl = url;
            orderId = data.orderId != null ? String(data.orderId) : null;
          }
          for (const h of houses) if (h?.hidx) current.set(String(h.hidx), h);
          pagesLoaded = Math.max(pagesLoaded, pageIndex);
          session.record('peterpanz', 'data', url, r.status(), `목록 ${pageIndex}쪽 ${houses.length}건 (전체 ${data.totalCount ?? '?'}건)`);
        })(),
      );
    };
    const settle = async () => {
      await Promise.allSettled(pending.splice(0));
    };

    page.on('response', onResponse);
    try {
      for (const [ai, area] of ctx.areas.entries()) {
        if (ai > 0) await session.rest();
        // 반경이 크면 한 단계 넓게 본다(피터팬 줌 15에서 보이는 지도는 남북 약 2.8km).
        const zoom = area.radiusM > 1300 ? 14 : 15;
        for (const cat of CATEGORIES) {
          current = new Map();
          total = 0;
          bounds = null;
          firstPageUrl = null;
          orderId = null;

          // 1) 역 위치로 지도를 연다.
          collecting = true;
          ctx.progress(`피터팬, ${area.name}, ${cat.label} 지도 여는 중`);
          for (let attempt = 1; attempt <= 2; attempt++) {
            const firstList = page.waitForResponse((r) => r.url().includes(LIST_API) && r.url().includes('pageIndex=1'), { timeout: 15000 }).catch(() => null);
            const response = await session.goto('peterpanz', mapUrl(cat, area, zoom));
            const status = response?.status() ?? 0;
            if (status === 403 || status === 429) throw new BlockedError(`피터팬이 요청을 막았습니다(HTTP ${status}). 우회하지 않고 멈춥니다.`);
            await firstList;
            await session.pause(1200);
            await settle();
            // 처음 방문하는 프로필에서는 주소의 위치를 무시하고 기본 화면(서울시청)이 뜨기도 해서, 그러면 한 번 더 연다.
            if (containsCenter(area, bounds)) break;
            ctx.log(`피터팬: 지도가 ${area.name}에 열리지 않아 다시 엽니다(${attempt}번째)`);
          }
          await closePopups(session);

          // 2) 왼쪽 목록이 지도를 가리는 만큼 지도를 오른쪽으로 끌어, 역이 보이는 지도의 가운데에 오게 한다.
          const layout = await page.evaluate(() => ({
            listRight: document.querySelector('div.list__wrapper')?.getBoundingClientRect().right ?? 0,
            width: innerWidth,
          }));
          const dx = Math.round((layout.listRight + layout.width) / 2 - layout.width / 2);
          if (dx > 20) {
            ctx.progress(`피터팬, ${area.name}, ${cat.label}, 지도를 끌어 역을 가운데로`);
            const refreshed = page.waitForResponse((r) => r.url().includes(LIST_API) && r.url().includes('pageIndex=1'), { timeout: 15000 }).catch(() => null);
            const x = Math.round(layout.listRight + 80);
            await session.drag(x, 260, x + dx, 260);
            session.record('peterpanz', 'action', page.url(), null, `지도를 오른쪽으로 ${dx}px 끌기`);
            await refreshed;
            await session.pause(1200);
          }
          await settle();

          const cover = coverage(area, bounds);
          if (cover) {
            ctx.log(`피터팬: ${area.name} ${cat.label} 지도 범위 남북 ${cover.heightKm.toFixed(1)}km × 동서 ${cover.widthKm.toFixed(1)}km, 목록 전체 ${total}건`);
            if (cover.minMargin < area.radiusM) ctx.log(`피터팬: 지도 범위가 반경 ${area.radiusM}m를 다 덮지 못합니다(가장 짧은 쪽 ${Math.round(cover.minMargin)}m). 반경을 줄이면 빠짐이 없습니다`);
          }

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
          await markNew();
          let stalls = 0;
          let lastCount = current.size;
          while (listBox && current.size < total && stalls < 4 && pagesLoaded < MAX_PAGES) {
            const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
            ctx.progress(`피터팬, ${area.name}, ${cat.label}, 목록 ${pagesLoaded}/${pages}쪽, ${current.size}/${total}건 읽음`);
            for (let i = 0; i < 6; i++) {
              await session.wheel(listBox.x + listBox.width / 2, listBox.y + listBox.height * 0.6, 900);
              await session.pause(300);
            }
            await session.pause(1200);
            await settle();
            if (current.size > lastCount) {
              stalls = 0;
              lastCount = current.size;
              await markNew();
            } else stalls += 1;
          }

          // 4) 휠로 더 내려도 안 불러와진 쪽은 화면이 쓰던 같은 목록 주소로 이어 받는다(요청 기록에 표시).
          if (current.size < total && firstPageUrl) {
            const pages = Math.min(Math.ceil(total / PAGE_SIZE), MAX_PAGES);
            ctx.log(`피터팬: ${area.name} ${cat.label} 휠로 ${current.size}/${total}건까지 불러와져서, 나머지 쪽을 같은 목록 주소로 이어 받습니다`);
            for (let pageIndex = pagesLoaded + 1; pageIndex <= pages && current.size < total; pageIndex++) {
              const next = new URL(firstPageUrl);
              next.searchParams.set('pageIndex', String(pageIndex));
              if (orderId) next.searchParams.set('order_id', orderId);
              ctx.progress(`피터팬, ${area.name}, ${cat.label}, 나머지 ${pageIndex}/${pages}쪽 이어 받는 중`);
              const res: { status: number; json: any } = await page.evaluate(async (u) => {
                const r = await fetch(u, { credentials: 'omit' });
                const type = r.headers.get('content-type') ?? '';
                return { status: r.status, json: type.includes('json') ? await r.json() : null };
              }, next.toString());
              if (res.status === 403 || res.status === 429) throw new BlockedError(`피터팬이 요청을 막았습니다(HTTP ${res.status}). 우회하지 않고 멈춥니다.`);
              const houses = Object.values(res.json?.houses ?? {}).flatMap((g: any) => Object.values(g ?? {}).flat()) as any[];
              for (const h of houses) if (h?.hidx) current.set(String(h.hidx), h);
              pagesLoaded = pageIndex;
              session.record('peterpanz', 'data', next.toString(), res.status, `휠로 안 불러와져 이어 받은 목록 ${pageIndex}쪽 ${houses.length}건`);
              await session.pause(1500);
            }
          }
          ctx.log(`피터팬: ${area.name} ${cat.label} 목록 ${total}건 중 ${current.size}건 읽음`);

          const shot = await session.screenshot('peterpanz', `${area.name}-${cat.label}`);
          for (const raw of current.values()) {
            const listing = normalize(raw);
            if (listing) items.push({ listing, raw, pageUrl: page.url(), screenshot: shot });
          }
          collecting = false;
          await session.pause(PAGE_DELAY_MS);
        }
      }
    } finally {
      page.off('response', onResponse);
    }
    return items;
  },
};
