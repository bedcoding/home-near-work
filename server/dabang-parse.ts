import { priceText } from '../shared/format.js';
import type { ExplainRow, NormalizedListing, PriceOption } from '../shared/types.js';

/** 다방 금액 글자(만원)를 숫자로: '1억3000' → 13000, '1억' → 10000, '8500' → 8500. 못 읽으면 null. */
export function dabangMoney(text: string): number | null {
  const m = /^(?:(\d+)억)?\s*(\d*)$/.exec(text.trim());
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 10000 + Number(m[2] || 0);
}

/** 방 종류 글자 → 방 수 */
const ROOMS: Record<string, number> = { 원룸: 1, 투룸: 2, 쓰리룸: 3 };

function prices(type: unknown, title: unknown): PriceOption[] {
  if (typeof title !== 'string') return [];
  if (type === '월세') {
    const [deposit, monthly] = title.split('/');
    return monthly == null ? [] : [{ deal: 'monthly', deposit: dabangMoney(deposit), monthly: dabangMoney(monthly), price: null }];
  }
  if (type === '전세') return [{ deal: 'jeonse', deposit: dabangMoney(title), monthly: null, price: null }];
  if (type === '매매') return [{ deal: 'sale', deposit: null, monthly: null, price: dabangMoney(title) }];
  return [];
}

/**
 * 방 목록 한 줄 → 공통 형식. 고정 번호는 seq(등록 순서대로 커지는 번호)다.
 * roomDesc '2층, 33.05m², 관리비 9만'에서 층(반지층은 지하, 옥탑, 저층, 중층, 고층은 층 모름), 전용면적, 관리비(만원, '없음'은 0)를 읽는다.
 * 위치는 다방이 준 근처 좌표(randomLocation)라 주소는 없고, 원본 주소는 그 좌표 가운데의 다방 지도다.
 */
/**
 * 원본 열기 주소. 다방 지도에서 방을 열면 주소에 detail_type=room과 방의 24자리 id(목록 응답의 id, 저장 번호 seq와 다름)가 붙고,
 * 그 주소로 열면 그 방 상세가 바로 뜬다. id가 없거나 모양이 다르면 그 근처 지도만 연다.
 */
export function dabangRoomUrl(category: string | undefined, lat: number, lng: number, id: unknown): string {
  const path = category === 'apt' ? 'apt' : category === 'officetel' ? 'officetel' : category === 'house-villa' ? 'house' : 'onetwo';
  const room = typeof id === 'string' && /^[0-9a-f]{24}$/.test(id) ? `&detail_type=room&detail_id=${id}` : '';
  return `https://www.dabangapp.com/map/${path}?m_lat=${lat}&m_lng=${lng}&m_zoom=17${room}`;
}

/** 다방 지도 주소에 방 상세를 여는 값을 붙인다. 다방 지도 주소가 아니거나 id 모양이 다르면 null. */
export function withDabangRoom(url: unknown, roomId: unknown): string | null {
  if (typeof url !== 'string' || typeof roomId !== 'string' || !/^[0-9a-f]{24}$/.test(roomId)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)dabangapp\.com$/.test(u.hostname) || !u.pathname.startsWith('/map/')) return null;
    if (u.searchParams.get('detail_id') === roomId) return url;
    u.searchParams.set('detail_type', 'room');
    u.searchParams.set('detail_id', roomId);
    return u.toString();
  } catch { return null; }
}

/** 다방 방 상세의 주변 정보 요청. 방 상세를 열 때 다방 화면도 이 주소로 지번 주소를 받는다. id 모양이 다르면 null. */
export function dabangNearUrl(roomId: unknown): string | null {
  return typeof roomId === 'string' && /^[0-9a-f]{24}$/.test(roomId) ? `https://www.dabangapp.com/api/v5/room/${roomId}/near` : null;
}

/** 주변 정보 응답에서 지번 주소와 좌표. 정상 응답이 아니거나 주소가 없으면 null. */
export function parseDabangNear(body: string): { address: string; lat: number | null; lng: number | null } | null {
  try {
    const j = JSON.parse(body);
    const address = typeof j?.result?.address === 'string' ? j.result.address.replace(/\s+/g, ' ').trim() : '';
    if (j?.code !== 200 || !address || address.length > 200 || /[\u0000-\u001f<>]/.test(address)) return null;
    const lat = Number(j.result.location?.lat), lng = Number(j.result.location?.lng);
    const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    return { address, lat: ok ? lat : null, lng: ok ? lng : null };
  } catch { return null; }
}

function toListing(x: Record<string, unknown>, category?: string): NormalizedListing | null {
  const seq = x.seq;
  const loc = x.randomLocation as { lat?: unknown; lng?: unknown } | undefined;
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0 || loc?.lat == null || loc?.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const desc = typeof x.roomDesc === 'string' ? x.roomDesc : '';
  const type = typeof x.roomTypeName === 'string' ? x.roomTypeName : null;
  const floor = /(?:^|,\s*)(\d+)층/.exec(desc);
  const area = /([\d.]+)\s*m²/.exec(desc);
  const fee = /관리비\s*(없음|[\d.]+만)/.exec(desc);
  const listingPrices = prices(x.priceTypeName, x.priceTitle);
  const explain: ExplainRow[] = [
    { label: '가격', raw: `priceTypeName, priceTitle: ${x.priceTypeName ?? '?'} ${x.priceTitle ?? '?'}`, value: listingPrices.map(priceText).join(', ') || '못 읽음' },
    { label: '층, 면적, 관리비', raw: `roomDesc: ${desc}`, value: `${floor ? `${floor[1]}층` : /반지|지하/.test(desc) ? '지하' : /옥탑/.test(desc) ? '옥탑' : '층 모름'}, ${area ? `${area[1]}㎡` : '면적 모름'}, ${fee ? fee[1] : '관리비 모름'}` },
    { label: '위치', raw: `randomLocation: ${lat}, ${lng}`, value: '다방이 준 근처 좌표', note: '정확한 위치가 아니다' },
  ];
  return {
    source: 'dabang',
    sourceId: String(seq),
    url: dabangRoomUrl(category, lat, lng, x.id),
    title: typeof x.roomTitle === 'string' ? x.roomTitle : '',
    thumbnail: Array.isArray(x.imgUrlList) && typeof x.imgUrlList[0] === 'string' ? x.imgUrlList[0] : null,
    lat,
    lng,
    address: null,
    dong: typeof x.dongName === 'string' ? x.dongName : null,
    buildingKey: null,
    buildingType: category === 'apt' ? '아파트' : category === 'officetel' || type === '오피스텔' ? '오피스텔' : category === 'house-villa' ? '빌라와 주택' : null,
    roomLabel: type,
    rooms: type ? (ROOMS[type] ?? null) : null,
    areaM2: area ? Number(area[1]) : null,
    floor: floor ? Number(floor[1]) : null,
    totalFloors: null,
    basement: /반지|지하/.test(desc) ? true : floor ? false : null,
    rooftop: /옥탑/.test(desc) ? true : floor ? false : null,
    builtYear: null,
    maintenance: fee ? (fee[1] === '없음' ? 0 : Number(fee[1].replace('만', ''))) : null,
    elevator: null,
    parking: null,
    availableFrom: null,
    updatedAt: null,
    prices: listingPrices,
    explain,
  };
}

/**
 * 다방 화면이 받은 방 목록 응답(`/api/v5/room-list/...`)을 읽는다. 일반 목록(roomList)과 위쪽 광고 칸(premiumList[].roomList)을 함께 읽는다.
 * total: 그 지도 범위의 방 수(목록은 한 쪽에 24개씩 온다). 모양이 다르면 null.
 */
export interface DabangRoomList {
  items: { listing: NormalizedListing; raw: unknown }[];
  total: number | null;
  page: number | null;
  limit: number | null;
  hasMore: boolean | null;
  /** Advertising rows do not count toward the regular list's total. */
  regularIds: string[];
  regularCount: number;
  unreadableRegular: number;
  region: unknown;
}

export function parseDabangRoomList(body: string, category?: string): DabangRoomList | null {
  let result: Record<string, unknown> | undefined;
  try {
    result = JSON.parse(body)?.result;
  } catch {
    return null;
  }
  if (!result || !Array.isArray(result.roomList)) return null;
  const premium = Array.isArray(result.premiumList) ? (result.premiumList as { roomList?: unknown }[]).flatMap((p) => (Array.isArray(p?.roomList) ? p.roomList : [])) : [];
  const items = [...(result.roomList as unknown[]), ...premium]
    .map((raw) => ({ raw, listing: raw && typeof raw === 'object' ? toListing(raw as Record<string, unknown>, category) : null }))
    .filter((x): x is { raw: unknown; listing: NormalizedListing } => x.listing != null);
  const integer = (value: unknown, min: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : null;
  const regular = result.roomList as Record<string, unknown>[];
  return {
    items, total: integer(result.total, 0), page: integer(result.page, 1), limit: integer(result.limit, 1),
    hasMore: typeof result.hasMore === 'boolean' ? result.hasMore : null,
    regularIds: regular.flatMap((row) => row && typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq > 0 ? [String(row.seq)] : []),
    regularCount: regular.length,
    unreadableRegular: regular.filter((row) => !row || typeof row !== 'object' || !toListing(row)).length,
    region: result.region ?? null,
  };
}
