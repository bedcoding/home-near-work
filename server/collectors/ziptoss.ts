import { PAGE_DELAY_MS } from '../config.js';
import { distanceM } from '../geo.js';
import { knownStations } from '../station-catalog.js';
import { BlockedError, toNumber, type Collector, type CollectedItem } from './types.js';
import { floorText, money, priceText, yesNo } from '../../shared/format.js';
import type { Area, DealType, ExplainRow, NormalizedListing, PriceOption, Station } from '../../shared/types.js';

// 집토스 역 페이지(/map/역이름)는 서버에서 매물 목록을 담아 보내 준다.
// 페이지를 연 뒤 그 목록을 읽고, 화면의 카드와 아래쪽 표에 표시를 달면서 페이지를 끝까지 내려 보여 준다.

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
  if (!p?.id) return null;
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
      raw: rawPrices.map((x: any) => `${x.contract} deposit=${x.deposit} monthly=${x.monthly}`).join(' / ') || '없음',
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

/** 지역마다 반경 안(+600m)의 역 페이지를 고른다. 겹치는 역은 한 번만 연다. */
function stationsFor(areas: Area[]): Station[] {
  const picked = new Map<string, Station>();
  for (const area of areas) {
    const ranked = knownStations().map((s) => ({ s, d: distanceM(area.lat, area.lng, s.lat, s.lng) })).sort((a, b) => a.d - b.d);
    const near = ranked.filter((x) => x.d <= area.radiusM + 600);
    const chosen = near.length ? near : ranked.filter((x) => x.d <= 2000).slice(0, 1);
    for (const { s } of chosen) picked.set(s.name, s);
  }
  return [...picked.values()];
}

export const ziptoss: Collector = {
  id: 'ziptoss',
  label: '집토스',
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    const stations = stationsFor(ctx.areas);
    const items: CollectedItem[] = [];
    ctx.log(
      stations.length
        ? `집토스: 역 페이지 ${stations.length}곳을 봅니다 (${stations.map((s) => s.name).join(', ')})`
        : '집토스: 켜진 지역 2km 안에 아는 역이 없어 건너뜁니다',
    );

    for (const [i, station] of stations.entries()) {
      if (i > 0) await session.rest();
      const url = `https://ziptoss.com/map/${encodeURIComponent(station.name)}`;
      ctx.progress(`집토스, ${station.name} 주변 (${i + 1}/${stations.length})`);
      const response = await session.goto('ziptoss', url);
      const status = response?.status() ?? 0;
      if (status === 403 || status === 429) throw new BlockedError(`집토스가 요청을 막았습니다(HTTP ${status}). 우회하지 않고 멈춥니다.`);
      if (status >= 400) {
        ctx.log(`집토스: ${station.name} 페이지 응답 ${status}, 건너뜁니다`);
        continue;
      }
      ctx.progress(`집토스, ${station.name} 주변 (${i + 1}/${stations.length}), 목록 읽는 중`);

      // window.__NEXT_DATA__는 화면 스크립트가 돈 뒤에야 생기므로, 페이지에 박힌 원본 스크립트 태그를 직접 읽는다.
      const raws: any[] | null = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        const data = el?.textContent ? JSON.parse(el.textContent) : (window as any).__NEXT_DATA__;
        return data?.props?.pageProps?.properties ?? null;
      });
      if (!Array.isArray(raws)) {
        ctx.log(`집토스: ${station.name} 페이지에서 매물 데이터를 찾지 못했습니다(화면 구조가 바뀌었을 수 있음)`);
        continue;
      }
      session.record('ziptoss', 'data', url, status, `페이지에 담긴 매물 목록 ${raws.length}건 읽음`);
      const pairs = raws.map((raw) => ({ raw, listing: normalize(raw) })).filter((x): x is { raw: any; listing: NormalizedListing } => !!x.listing);
      const listings = pairs.map((x) => x.listing);

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
      const tagged = await page.evaluate((list) => {
        const parseMoney = (s: string) => {
          const m = s.replace(/[,\s]/g, '').match(/^(?:(\d+)억)?(\d+)?$/);
          return m ? Number(m[1] ?? 0) * 10000 + Number(m[2] ?? 0) : null;
        };
        let cards = 0;
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
          if (hit) {
            card.setAttribute('data-hnw-id', hit.id);
            cards += 1;
          }
        }
        for (const it of list) {
          const cell = document.querySelector(`a[href*="propertyKey=${it.key}"]`)?.closest('tr')?.querySelector('td');
          if (cell) {
            cell.setAttribute('data-hnw-row', it.id);
            rows += 1;
          }
        }
        return { cards, rows };
      }, summaries);
      ctx.log(`집토스: ${station.name} 위쪽 카드 ${tagged.cards}개, 아래쪽 표 ${tagged.rows}줄에 표시를 붙였습니다(목록 ${listings.length}건)`);

      const tones = ctx.classify(listings);
      await session.badges(listings.map((l) => ({ selector: `[data-hnw-id="${l.sourceId}"]`, tone: tones.get(l.sourceId) ?? 'new' })), 60);
      await session.badges(listings.map((l) => ({ selector: `[data-hnw-row="${l.sourceId}"]`, tone: tones.get(l.sourceId) ?? 'new' })));
      await session.pause(800);
      const shot = await session.screenshot('ziptoss', station.name);

      // 창으로 볼 때는 페이지를 끝까지 천천히 내려서, 아래쪽 표의 매물까지 전부 표시가 붙은 걸 보여 준다.
      if (session.visible) {
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        const steps = Math.min(Math.ceil(height / 700), 25);
        for (let s = 0; s < steps; s++) {
          ctx.progress(`집토스, ${station.name}, 읽은 매물 ${listings.length}건 표시 확인 중 (${s + 1}/${steps})`);
          await session.wheel(900, 500, 700);
          await session.pause(450);
        }
      }

      for (const { raw, listing } of pairs) items.push({ listing, raw, pageUrl: url, screenshot: shot });
      ctx.log(`집토스: ${station.name} 페이지에서 ${listings.length}건`);
      await session.pause(PAGE_DELAY_MS);
    }
    return items;
  },
};
