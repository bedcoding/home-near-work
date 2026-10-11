import type { Response } from 'playwright';
import { LOCAL } from '../config.js';
import { BlockedError, toNumber, type CollectContext, type Collector, type CollectedItem } from './types.js';
import { priceText } from '../../shared/format.js';
import type { NormalizedListing, PriceOption, SourceId } from '../../shared/types.js';

// 기업형 코리빙(방 하나씩 빌리는 곳). '고시원·쉐어' 탭에 보인다. 회사 사이트 전체(모든 지점)를 매번 보므로 안 보인 방은 사라짐으로 둔다.
// 금액은 사이트가 원 단위로 주는 것을 만원으로 바꾼다.

const blocked = (status: number | null | undefined) => status === 403 || status === 429;
const manwon = (won: unknown) => {
  const n = toNumber(won);
  return n == null ? null : Math.round(n / 10000);
};
/** '19.75㎡'나 '9.7m² (2.93py)'에서 ㎡ 숫자 */
const squareMeters = (text: unknown) => toNumber(/([\d.]+)\s*(㎡|m²|m2)/.exec(String(text ?? ''))?.[1]);

/** 코리빙 방 하나를 공통 형식으로. buildingType은 '코리빙'('고시원·쉐어' 탭 종류 칸). */
function roomListing(fields: Partial<NormalizedListing> & Pick<NormalizedListing, 'source' | 'sourceId' | 'url' | 'title' | 'prices'>): NormalizedListing {
  return {
    thumbnail: null,
    lat: null,
    lng: null,
    address: null,
    dong: null,
    buildingKey: null,
    buildingType: '코리빙',
    roomLabel: null,
    rooms: 1,
    areaM2: null,
    floor: null,
    totalFloors: null,
    basement: null,
    rooftop: null,
    builtYear: null,
    maintenance: null,
    elevator: null,
    parking: null,
    availableFrom: null,
    updatedAt: null,
    ...fields,
  };
}

const monthly = (deposit: number | null, rent: number | null): PriceOption[] => (rent != null ? [{ deal: 'monthly', deposit, monthly: rent, price: null }] : []);

/** 주소를 열면서 화면이 받는 응답 하나를 기다린다. */
async function openAndWait(ctx: CollectContext, source: SourceId, url: string, match: (r: Response) => boolean, what: string) {
  const { session } = ctx;
  const wait = session.page.waitForResponse(match, { timeout: 30000 }).catch(() => null);
  const res = await session.goto(source, url);
  if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
  const r = await wait;
  if (!r) throw new Error(`${what}을 받지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.`);
  session.record(source, 'data', r.url(), r.status(), what);
  if (blocked(r.status())) throw new BlockedError(`HTTP ${r.status()}`);
  return r;
}

// ---------- 에피소드(베러리빙) ----------

interface BetterUnit {
  unitId: string;
  siteNm?: { ko?: string };
  unitNm?: { ko?: string };
  unitConfig?: { ko?: string; en?: string };
  unitLabel?: { ko?: string };
  serviceTitle1?: { ko?: string };
  rentAmtStandard?: number;
  rentAmt12?: number;
  coordinate?: { lat?: number; lon?: number };
  representativeImg?: string;
  soldOut?: boolean;
}

/**
 * 베러리빙 방 찾기 화면(/find)이 받는 방 목록(/api/v1/product/public/unit)을 읽는다(에피소드 지점 전부, 방 호수마다 한 건).
 * 월 이용료는 12개월 계약 값(없으면 기본 값). 보증금은 방 상세에만 있어 비워 둔다. soldOut이면 '대기, 상담 가능'(상세 화면 문구), 아니면 입주 가능.
 */
export const betterliving: Collector = {
  id: 'betterliving',
  label: '에피소드',
  wholeDistrict: true,
  async collect(ctx) {
    ctx.progress('에피소드(베러리빙): 방 찾기 화면을 여는 중');
    const r = await openAndWait(ctx, 'betterliving', 'https://betterliving.kr/find', (x) => x.url().includes('/api/v1/product/public/unit?'), '방 목록');
    const data = (await r.json().catch(() => null)) as { items?: BetterUnit[]; total?: number } | null;
    if (!Array.isArray(data?.items)) throw new Error('방 목록을 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
    if ((data!.total ?? 0) > data!.items.length) ctx.log(`에피소드: ${data!.total}건 중 ${data!.items.length}건만 받았습니다`);
    const screenshot = await ctx.session.screenshot('betterliving', '방 찾기');
    const out: CollectedItem[] = [];
    for (const u of data!.items) {
      if (!u?.unitId) continue;
      const rent = manwon(u.rentAmt12 ?? u.rentAmtStandard);
      const tag = (u.serviceTitle1?.ko ?? '').replace(/[^\p{L}\p{N}\s]/gu, '').trim();
      const listing = roomListing({
        source: 'betterliving',
        sourceId: u.unitId,
        url: `https://betterliving.kr/units/${u.unitId}`,
        title: `${u.siteNm?.ko ?? ''} ${u.unitNm?.ko ?? ''}`.trim(),
        thumbnail: u.representativeImg ?? null,
        lat: toNumber(u.coordinate?.lat),
        lng: toNumber(u.coordinate?.lon),
        address: u.siteNm?.ko ?? null,
        buildingKey: `bl-${u.unitId}`,
        roomLabel: u.unitConfig?.ko ?? null,
        areaM2: squareMeters(u.unitConfig?.en),
        availableFrom: u.soldOut ? (tag || '대기, 상담 가능') : '입주 가능',
        prices: monthly(null, rent),
      });
      listing.explain = [
        { label: '월세', raw: `rentAmt12=${u.rentAmt12 ?? '없음'}, rentAmtStandard=${u.rentAmtStandard ?? '없음'} (원)`, value: listing.prices.map(priceText).join(', ') || '없음', note: '12개월 계약 값을 만원으로. 보증금은 방 상세 화면에만 있음' },
        { label: '입주', raw: `soldOut=${u.soldOut}, serviceTitle1="${u.serviceTitle1?.ko ?? ''}"`, value: listing.availableFrom ?? '', note: 'soldOut이면 상세 화면이 입주 가능 여부를 대기/상담 가능으로 보임' },
        { label: '면적', raw: `unitConfig.en="${u.unitConfig?.en ?? ''}"`, value: listing.areaM2 != null ? `${listing.areaM2}㎡` : '모름' },
      ];
      out.push({ listing, raw: u, pageUrl: 'https://betterliving.kr/find', screenshot });
    }
    return out;
  },
};

// ---------- 맹그로브 ----------

interface MangroveRoom {
  id?: string;
  roomTypeId?: string;
  name?: string;
  spaceType?: string;
  monthly?: number;
  deposit?: number;
  isAvailable?: boolean;
  earliestMoveInDate?: string;
  areaText?: string;
  directionText?: string;
}

/** 보내지 않는 경로(화면이 스스로 부르는 것도 막는다) */
const MANGROVE_BLOCKED = /^https:\/\/mangrove\.city\/(api|login|search|key)\//;

/** 지점 화면의 Next.js 데이터(self.__next_f)에서 방 타입 목록과 지점 좌표를 꺼낸다. */
async function readMangroveBranch(ctx: CollectContext) {
  return ctx.session.page.evaluate(() => {
    const flight = Array.from(document.scripts)
      .map((s) => s.textContent ?? '')
      .filter((t) => t.startsWith('self.__next_f.push('))
      .map((t) => {
        try {
          const a = JSON.parse(t.slice(19, t.lastIndexOf(')')));
          return typeof a[1] === 'string' ? a[1] : '';
        } catch {
          return '';
        }
      })
      .join('');
    const key = '"rooms":[';
    const at = flight.indexOf(key);
    let rooms: unknown[] | null = null;
    if (at >= 0) {
      const start = at + key.length - 1;
      let depth = 0;
      let inStr = false;
      for (let j = start; j < flight.length; j++) {
        const ch = flight[j];
        if (inStr) {
          if (ch === '\\') j++;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') {
          depth--;
          if (depth === 0) {
            try {
              rooms = JSON.parse(flight.slice(start, j + 1));
            } catch {
              rooms = null;
            }
            break;
          }
        }
      }
    }
    const loc = /"branchLocation":\{"lat":([0-9.]+),"lng":([0-9.]+)/.exec(flight);
    let address: string | null = null;
    let name: string | null = null;
    for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        const j = JSON.parse(s.textContent ?? '');
        const o = Array.isArray(j) ? j[0] : j;
        address ??= o?.address?.streetAddress ?? null;
        name ??= o?.name ?? null;
      } catch {
        /* 다음 것 */
      }
    }
    return { rooms, lat: loc ? Number(loc[1]) : null, lng: loc ? Number(loc[2]) : null, address, name: name ?? document.title };
  });
}

/**
 * 맹그로브 지점 화면을 차례로 열어 방 타입(1인실 A-1 등)마다 월 이용료, 보증금, 면적, 입실 가능 여부, 가장 빠른 입실일을 읽는다.
 * 지점 목록은 사이트맵(/main/sitemap.xml)의 /region/<지역>/<지점> 주소. 방 하나하나가 아니라 방 타입 단위다.
 */
export const mangrove: Collector = {
  id: 'mangrove',
  label: '맹그로브',
  wholeDistrict: true,
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    await page.route(MANGROVE_BLOCKED, (route) => route.abort());
    try {
      ctx.progress('맹그로브: 지점 목록(사이트맵)을 읽는 중');
      const res = await session.goto('mangrove', 'https://mangrove.city/main/sitemap.xml');
      if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
      const xml = (await res?.text()) ?? '';
      const branches = [...new Set([...xml.matchAll(/https:\/\/mangrove\.city\/region\/[a-z0-9-]+\/[a-z0-9-]+/g)].map((m) => m[0]))];
      if (!branches.length) throw new Error('지점 목록을 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
      session.record('mangrove', 'data', res!.url(), res!.status(), `지점 ${branches.length}곳`);
      const out: CollectedItem[] = [];
      for (const url of branches) {
        ctx.progress(`맹그로브: ${url.split('/').pop()} 지점`);
        const r = await session.goto('mangrove', url);
        if (blocked(r?.status())) throw new BlockedError(`HTTP ${r?.status()}`);
        await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
        const b = await readMangroveBranch(ctx);
        const rooms = (Array.isArray(b.rooms) ? b.rooms : []) as MangroveRoom[];
        session.record('mangrove', 'data', url, r?.status() ?? null, `방 타입 ${rooms.length}개`);
        if (!rooms.length) {
          ctx.log(`맹그로브: ${url} 방 정보를 찾지 못했습니다`);
          continue;
        }
        const slug = url.split('/').pop()!;
        const branchName = (b.name ?? slug).replace(/\s*[|·-].*$/, '').trim();
        const screenshot = await session.screenshot('mangrove', branchName);
        for (const room of rooms) {
          const typeId = room.roomTypeId ?? room.id;
          if (!typeId) continue;
          const move = room.earliestMoveInDate && /^\d{4}-\d{2}-\d{2}$/.test(room.earliestMoveInDate) ? room.earliestMoveInDate : null;
          const listing = roomListing({
            source: 'mangrove',
            sourceId: `${slug}:${typeId}`,
            url,
            title: `${branchName} ${room.name ?? ''}`.trim(),
            lat: b.lat,
            lng: b.lng,
            address: b.address,
            buildingKey: `mg-${slug}`,
            roomLabel: room.spaceType ?? null,
            areaM2: squareMeters(room.areaText),
            availableFrom: room.isAvailable ? (move ? `${move}부터` : '입실 가능') : '만실(대기 신청)',
            prices: monthly(manwon(room.deposit), manwon(room.monthly)),
          });
          listing.explain = [
            { label: '월세', raw: `deposit=${room.deposit ?? '없음'}, monthly=${room.monthly ?? '없음'} (원)`, value: listing.prices.map(priceText).join(', ') || '없음', note: '월 이용료는 가장 낮은 값(계약 기간에 따라 다름)' },
            { label: '입실', raw: `isAvailable=${room.isAvailable}, earliestMoveInDate=${room.earliestMoveInDate ?? ''}`, value: listing.availableFrom ?? '' },
            { label: '면적', raw: `areaText="${room.areaText ?? ''}"`, value: listing.areaM2 != null ? `${listing.areaM2}㎡` : '모름' },
          ];
          out.push({ listing, raw: room, pageUrl: url, screenshot });
        }
        await session.pause(700);
      }
      return out;
    } finally {
      await page.unroute(MANGROVE_BLOCKED).catch(() => {});
    }
  },
};

// ---------- 셀립 ----------

interface CelibRoom {
  room_id?: string;
  room_number?: string;
  exposure_name?: string;
  available_date?: string;
  area?: string;
  over_deposit_cost?: string;
  over_real_monthly_cost?: string;
}

/** 셀립 지점(config/local.json의 celibBranches): 지점 화면 이름(en_name)과 입주 신청 화면 번호(p). 없으면 셀립은 0건. */
const CELIB_BRANCHES = LOCAL.celibBranches ?? [];

/**
 * 셀립 지점 화면에서 좌표('길 찾기' 카카오맵 링크)를 읽고, 입주 신청 화면이 받는 빈 방 목록(/api/Rooms/get_apply_rooms_v2)을 읽는다(호수마다 한 건).
 * 입주 신청 화면은 보기만 하고 신청 버튼은 누르지 않는다. 빈 방이 없으면 0건이 정상이다.
 */
export const celib: Collector = {
  id: 'celib',
  label: '셀립',
  wholeDistrict: true,
  emptyOk: true,
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    const out: CollectedItem[] = [];
    for (const b of CELIB_BRANCHES) {
      ctx.progress(`셀립: ${b.name} 지점 화면`);
      const home = `https://celib.kr/property/${b.slug}`;
      const res = await session.goto('celib', home);
      if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
      await page.waitForSelector('a[href*="map.kakao.com/link/to/"]', { timeout: 20000 }).catch(() => null);
      const link = await page.locator('a[href*="map.kakao.com/link/to/"]').first().getAttribute('href').catch(() => null);
      const at = /,(3\d\.\d+),(12\d\.\d+)/.exec(decodeURIComponent(link ?? ''));
      ctx.progress(`셀립: ${b.name} 빈 방 목록`);
      const r = await openAndWait(ctx, 'celib', `https://celib.kr/moving_apply?p=${b.p}`, (x) => x.url().includes('/api/Rooms/get_apply_rooms_v2'), '빈 방 목록');
      const data = (await r.json().catch(() => null)) as { data?: CelibRoom[]; totalItems?: number } | null;
      if (!Array.isArray(data?.data)) throw new Error('빈 방 목록을 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
      if ((data!.totalItems ?? 0) > data!.data.length) ctx.log(`셀립: ${b.name} ${data!.totalItems}개 중 ${data!.data.length}개만 받았습니다`);
      const screenshot = await session.screenshot('celib', b.name);
      for (const room of data!.data) {
        if (!room.room_id) continue;
        const listing = roomListing({
          source: 'celib',
          sourceId: room.room_id,
          url: home,
          title: `${b.name} ${room.room_number ? `${room.room_number}호` : ''} ${room.exposure_name ?? ''}`.replace(/\s+/g, ' ').trim(),
          lat: at ? Number(at[1]) : null,
          lng: at ? Number(at[2]) : null,
          address: b.name,
          buildingKey: `celib-${b.slug}`,
          roomLabel: room.exposure_name ?? null,
          areaM2: toNumber(room.area),
          availableFrom: room.available_date && /^\d{4}-\d{2}-\d{2}$/.test(room.available_date) ? `${room.available_date}부터` : null,
          prices: monthly(manwon(room.over_deposit_cost), manwon(room.over_real_monthly_cost)),
        });
        listing.explain = [
          { label: '월세', raw: `over_deposit_cost=${room.over_deposit_cost ?? '없음'}, over_real_monthly_cost=${room.over_real_monthly_cost ?? '없음'} (원)`, value: listing.prices.map(priceText).join(', ') || '없음', note: '관리비 미포함(지점 화면 문구)' },
          { label: '입주', raw: `available_date=${room.available_date ?? ''}`, value: listing.availableFrom ?? '' },
          { label: '위치', raw: `지점 화면 길 찾기 링크 ${link ?? '없음'}`, value: listing.lat != null ? `${listing.lat}, ${listing.lng}` : '모름' },
        ];
        out.push({ listing, raw: room, pageUrl: `https://celib.kr/moving_apply?p=${b.p}`, screenshot });
      }
      await session.pause(600);
    }
    return out;
  },
};
