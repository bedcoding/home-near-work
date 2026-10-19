import { priceText } from '../shared/format.js';
import type { ExplainRow, NormalizedListing, PriceOption } from '../shared/types.js';

/**
 * 직방 원룸 역 화면이 받는 `house/property/v1/items/subways/<역 번호>/onerooms?radius=…` 응답: 그 역 반경(km) 안 방 번호 전부.
 * key: 역 번호와 조회 조건(radius, depositMin, rentMin 등). 모양이 다르면 null.
 */
export function parseZigbangStationIds(url: string, body: string): { key: string; subwayId: string; ids: number[] } | null {
  try {
    const u = new URL(url);
    const m = /\/items\/subways\/(\d+)\/onerooms$/.exec(u.pathname);
    const items = JSON.parse(body)?.items;
    if (!m || !Array.isArray(items)) return null;
    const params = [...u.searchParams].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    const ids = items.map((x: { id?: unknown }) => x?.id).filter((id: unknown): id is number => typeof id === 'number');
    return { key: `zigbang|${m[1]}|${params}`, subwayId: m[1], ids };
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * `house/property/v1/items/list` 응답(목록에 보이는 방들의 내용) 한 줄 → 공통 형식. 금액은 만원(manage_cost만 원).
 * floor: 숫자면 층, '반지하', '지하'는 지하, '옥탑'은 옥탑. pageUrl: 이 방을 본 직방 화면(원본 열기 주소로 씀).
 */
function toListing(x: Record<string, unknown>, pageUrl: string): NormalizedListing | null {
  const id = num(x.item_id);
  const loc = (x.location ?? x.random_location) as { lat?: unknown; lng?: unknown } | undefined;
  const lat = num(loc?.lat);
  const lng = num(loc?.lng);
  if (id == null || lat == null || lng == null) return null;
  const floorText = typeof x.floor_string === 'string' ? x.floor_string : typeof x.floor === 'string' ? x.floor : '';
  const floor = /^\d+$/.test(floorText) ? Number(floorText) : null;
  const deposit = num(x.deposit);
  const rent = num(x.rent);
  const prices: PriceOption[] =
    x.sales_type === '월세' ? [{ deal: 'monthly', deposit, monthly: rent, price: null }]
    : x.sales_type === '전세' ? [{ deal: 'jeonse', deposit, monthly: null, price: null }]
    : x.sales_type === '매매' ? [{ deal: 'sale', deposit: null, monthly: null, price: deposit }]
    : [];
  const exclusive = (x['전용면적'] as { m2?: unknown } | undefined)?.m2;
  const area = num(exclusive) ?? num(x.size_m2);
  const fee = num(x.manage_cost);
  const service = typeof x.service_type === 'string' ? x.service_type : null;
  const addr = x.addressOrigin as { local3?: unknown } | undefined;
  const explain: ExplainRow[] = [
    { label: '가격', raw: `sales_type, deposit, rent: ${x.sales_type ?? '?'} ${x.deposit ?? '?'}/${x.rent ?? '?'}`, value: prices.map(priceText).join(', ') || '못 읽음' },
    { label: '층', raw: `floor_string, building_floor: ${floorText || '?'} / ${x.building_floor ?? '?'}`, value: floor != null ? `${floor}층` : floorText || '모름' },
    { label: '관리비', raw: `manage_cost: ${x.manage_cost ?? '?'}`, value: fee != null ? `${fee / 10000}만원` : '모름', note: '원 단위를 만원으로' },
    { label: '등록일', raw: `reg_date: ${x.reg_date ?? '?'}`, value: typeof x.reg_date === 'string' ? x.reg_date.slice(0, 10) : '모름' },
  ];
  return {
    source: 'zigbang',
    sourceId: String(id),
    url: pageUrl,
    title: typeof x.title === 'string' ? x.title : '',
    thumbnail: typeof x.images_thumbnail === 'string' ? x.images_thumbnail : null,
    lat,
    lng,
    address: typeof x.address1 === 'string' ? x.address1 : typeof x.address === 'string' ? x.address : null,
    dong: typeof addr?.local3 === 'string' ? addr.local3 : null,
    buildingKey: null,
    buildingType: service === '오피스텔' ? '오피스텔' : service === '빌라' ? '빌라' : null,
    roomLabel: typeof x.room_type_title === 'string' && x.room_type_title ? x.room_type_title : service,
    rooms: null,
    areaM2: area,
    floor,
    totalFloors: num(x.building_floor),
    basement: /지하/.test(floorText) ? true : floor != null ? false : null,
    rooftop: /옥탑/.test(floorText) ? true : floor != null ? false : null,
    builtYear: null,
    maintenance: fee != null ? fee / 10000 : null,
    elevator: null,
    parking: null,
    availableFrom: null,
    updatedAt: typeof x.reg_date === 'string' ? x.reg_date.slice(0, 10) : null,
    prices,
    explain,
  };
}

/** `house/property/v1/items/list` 응답의 방들. 모양이 다르면 빈 배열. */
export function parseZigbangItems(body: string, pageUrl: string): { listing: NormalizedListing; raw: unknown }[] {
  try {
    const items = JSON.parse(body)?.items;
    if (!Array.isArray(items)) return [];
    return items
      .map((raw) => ({ raw, listing: raw && typeof raw === 'object' ? toListing(raw as Record<string, unknown>, pageUrl) : null }))
      .filter((x): x is { raw: unknown; listing: NormalizedListing } => x.listing != null);
  } catch {
    return [];
  }
}
