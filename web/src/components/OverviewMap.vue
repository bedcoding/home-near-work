<script setup lang="ts">
import L from 'leaflet';
import { boundaryOf, pointInGeometry, regionBounds, regionColor, regionBoundaries } from '../../../shared/region-geometry';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { SOURCE_LABEL, type Area, type DealType, type ListingView, type PriceOption } from '../../../shared/types';
import { loadCatalog, type CatalogStation } from '../areaActions';
import { auctionSiteLinks } from '../auction';
import { kindOf } from '../kinds';
import { roomRange } from '../rooms';
import { naverLink } from '../naverPlaces';
import { looksSeen, markSeen } from '../marks';
import { rentRate } from '../rentRate';
import { distanceText, money, priceAmount, priceText, pyeong } from '../format';
import { mapPriceChangeLines } from '../mapPriceChange';
import { addWalkPin, ensureWalk, markDistances, moveWalkPin, pinCount, pinMax, removeWalkPin, renameWalkPin, setPinKind, walkPins, walkState } from '../walk';
import { WALK_NAME_MAX, type PinKind } from '../../../shared/walk';
import {
  checkZonesNow, loadZones, uploadZones, ZONE_COLOR, ZONE_GROUPS, ZONE_SOURCE_URL, zones, zonesBusy, zonesChecking, zonesError, zonesMessage, zonesOn,
} from '../redevZones';
import type { RedevZoneFeature } from '../../../shared/types';
import InfoModal from './InfoModal.vue';

// 매물 탭 오른쪽 지도와 경매 탭, 고시원과 쉐어 탭의 지도가 같이 쓴다.
// - 매물(같은 자리는 숫자 동그라미로 묶음)을 누르면 정보 창이 뜨고, 거기서 '목록에서 보기'나 '원본 열기'를 누른다.
//   확대해 보면(PRICE_ZOOM) 동그라미 대신 가격('보증금/월세', 전세 '전 1.5억')을 쓴 표시로 그린다. 가격 표시끼리 글자가 가려질 만큼
//   겹치면 지금 확대에서 한 표시로 묶고 대표 가격과 건수를 쓴다. 전월세 지도는 월세 최저와 전세금 또는 보증금 최저를 표시한다.
//   옆에 목록이 있으면 누를 때 그 묶음 매물들을 reveal 이벤트로 알려 목록도 그 매물로 옮기게 한다.
// - 매물 표시는 화면 근처에 있는 것만 그리고, 지도를 옮기거나 확대하면 바뀐 묶음만 갈아 끼운다(수천 건을 한꺼번에 다시 만들면 느려서).
// - 역(흰 동그라미, 켜진 지역은 검은 동그라미)을 누르면 그 역 지역을 켜고 끈다(station 이벤트, 확대 12 이상에서 보임).
// - 휠 한 칸에 약 1.2배씩 확대하거나 축소한다.
// - 정비사업 구역(서울플랜+ 파일을 넣었으면)을 매물과 역 아래 층에 칠한다. 마우스를 올리면 구역 이름, 사업 종류, 추진 단계가 보인다.
// - '거리 핀'으로 자주 가는 곳에 핀(MAX_WALK_PINS개까지, 모든 지도가 같이 씀)을 꽂으면 매물 카드에 핀까지 걸어서 몇 분인지 보인다.
//   '표시 핀'은 지도에 이름만 보이고(MAX_MARK_PINS개까지), 마우스를 올리면 거리 핀까지 걸어서 몇 분인지 보인다. 핀은 끌어서 옮기고, 누르면 이름이나 종류를 바꾸거나 뺀다.


const props = withDefaults(
  defineProps<{
    /** 목록을 펼친 매물. 진하게 보인다. */
    listings: ListingView[];
    /** 보일 매물 전체. 펼친 목록이 있으면 연하게, 없으면 보통으로 보인다. */
    background: ListingView[];
    rentalOptions?: ReadonlyMap<string, readonly PriceOption[]>;
    liveListingIds?: ReadonlySet<string>;
    areas: Area[];
    selectedId: string | null;
    /** 옆에 매물 목록이 있으면 정보 창에 '목록에서 보기'를 둔다(지도 탭은 없음). */
    listMode?: boolean;
    /** 접힌 지도는 크기가 0이므로, 보일 때까지 화면 맞추기를 미룬다. */
    visible?: boolean;
    /**
     * 지도를 매물에 다시 맞추는 기준. 이 값이 바뀔 때(가격대를 펼치거나 접을 때, 종류나 지역을 고를 때)만 맞추고,
     * 같은 값에서 매물만 바뀌면(10초마다 상태를 받을 때, 버림, 필터) 사용자가 보던 확대와 위치를 그대로 둔다.
     */
    fitKey?: string;
    /**
     * 고른 매물이 바뀔 때 그 매물이 화면 가장자리나 밖에 있으면 지도를 그쪽으로 옮길지. 사용자가 직접 고른 매물일 때만 true다
     * (버림으로 목록에서 빠져 다음 매물이 골라진 때는 false라서 보던 자리를 그대로 둔다). 강조 표시는 어느 쪽이든 한다.
     */
    panToSelected?: boolean;
    /**
     * 지도 위치와 배율을 기억할 이름(탭마다 따로). 주면 마지막으로 본 자리를 브라우저에 두었다가 다시 열 때 그대로 보여 주고,
     * 기억한 자리가 없을 때만 매물에 맞춘다. 저장은 지도를 다 옮기거나 확대를 마칠 때(moveend) 한 번씩 한다(한 번에 수 마이크로초).
     */
    viewKey?: string;
  }>(),
  { listMode: true, fitKey: '', visible: true, panToSelected: true },
);
const emit = defineEmits<{ select: [ListingView]; reveal: [ListingView[]]; open: [ListingView]; area: [Area]; station: [CatalogStation] }>();

const el = ref<HTMLDivElement | null>(null);
/** 핀 꽂는 중이면 그 종류(다음에 누른 자리에 핀을 꽂는다) */
const pinning = ref<PinKind | null>(null);
/** 크게 보기: 화면 거의 전체를 덮는다. Esc로 돌아온다. */
const big = ref(false);
const visibleLiveCount = ref(0);
let map: L.Map | null = null;
let base: L.LayerGroup | null = null; // 지역 원, 역 이름이 아닌 지역 표시
let dots: L.LayerGroup | null = null; // 매물
let liveLayer: L.LayerGroup | null = null;
/**
 * 가격을 쓰지 않는 매물 표시(점과 같은 자리 숫자 동그라미)를 그리는 캔버스. 예전에는 숫자 동그라미를 HTML 요소로 그려서
 * 보통 확대에서 3천 개 가까이 되면 지도를 끄는 동안 한 프레임에 0.3초씩 걸렸다. 가격 표시는 지금처럼 HTML이다.
 */
let dotRenderer: L.Canvas | null = null;
/** dotRenderer의 캔버스. 평소에는 마우스를 아래(역, 정비구역)로 흘려보내고, 표시 위에 있을 때만 받는다(onMapPointer). */
let dotCanvas: HTMLCanvasElement | null = null;
let stationLayer: L.LayerGroup | null = null; // 역
let stationRenderer: L.Renderer | null = null;
let zoneLayer: L.GeoJSON | null = null; // 정비사업 구역
let zoneRenderer: L.Renderer | null = null;
let pinLayer: L.LayerGroup | null = null; // 거리 핀과 표시 핀
let pinMove: { marker: L.Marker; popup: L.Popup } | null = null;
let listingPopup: L.Popup | null = null;
const fileEl = ref<HTMLInputElement | null>(null);
const stations = ref<CatalogStation[]>([]);
/** 이 확대보다 멀리서 보면 역을 그리지 않는다(수도권 658곳이 한꺼번에 보이면 매물이 가려서). */
const STATION_MIN_ZOOM = 12;
/** 이 확대부터 매물 표시에 가격을 쓴다(strong은 펼친 목록의 매물, normal은 펼친 목록이 없을 때 매물). 멀리서는 겹쳐서 동그라미로 둔다. */
const PRICE_ZOOM = { strong: 14, normal: 15 };
/** 지도 아래 '지도 보는 법' 모달의 탭 */
const MAP_TABS = [
  { id: 'marks', label: '매물 표시' },
  { id: 'areas', label: '구역과 역' },
  { id: 'pins', label: '핀' },
  { id: 'zones', label: '정비구역' },
];
/** 모달의 '색칠한 구역' 견본: 켜 둔 첫 구의 색(없으면 보라) */
const areaSample = computed(() => {
  const r = props.areas.find((a) => a.region)?.region;
  const c = r ? regionColor(r.code) : '#7c3aed';
  return { borderColor: c, background: `${c}1f` };
});
/** 마지막으로 그린 가격 표시 단계(0 동그라미만, 1 펼친 목록만 가격, 2 모두 가격) */
let drawnPriceLevel = -1;
/**
 * 그린 표시와 그 묶음. base는 점 표시의 원래 모양, z는 쌓는 순서(가격 표시는 zIndexOffset, 캔버스 표시는 그리는 순서).
 * 고른 표시를 풀 때 되돌린다.
 */
interface Drawn {
  marker: L.Layer;
  group: Group;
  base?: { radius: number; color: string; weight: number };
  z?: number;
}
/** 지금 확대에서 나눈 묶음 전체(화면 밖이라 안 그린 것 포함)와 그때의 확대, 가격 표시 단계 */
let shown: { zoom: number; level: number; groups: Group[] } | null = null;
/** 매물 번호 → 그 매물이 든 묶음 */
const groupOf = new Map<string, Group>();
/** 그려 둔 표시: 묶음 열쇠 → 표시 */
const drawn = new Map<string, Drawn>();
const liveMarkers = new Map<string, L.Marker>();
let selected: Drawn | null = null;
let resize: ResizeObserver | null = null;
let fitPending = false;
let panPending = false;

/** 같은 자리(소수 5자리, 약 1m)의 매물. 펼친 목록의 매물(strong)은 따로 묶는다. */
interface Spot {
  /** 묶음 열쇠에 쓰는 번호(spotCache 안의 순서) */
  idx: number;
  lat: number;
  lng: number;
  /** showOrder로 늘어선 매물 */
  items: ListingView[];
  strong: boolean;
  /** 확대 0의 화면 좌표. 확대 z에서는 2^z배가 된다. */
  x0: number;
  y0: number;
  sum: Summary;
}

/** 지도에 표시 하나로 그리는 묶음 */
interface Group {
  /** 다시 그릴 때 같은 표시인지 알아보는 열쇠(가격 표시 단계, 진한지, 가격 표시인지, 든 자리 번호) */
  key: string;
  lat: number;
  lng: number;
  strong: boolean;
  priced: boolean;
  /** 든 자리 수: 1이면 같은 자리 매물만, 2 이상이면 화면에서 겹쳐 묶은 근처 매물 */
  spots: number;
  sum: Summary;
  /** 든 자리마다 매물(각각 showOrder 순) */
  parts: ListingView[][];
  /** 별로가 아닌 매물을 싼 순(comparePrice)으로, 별로는 맨 뒤. 정보 창이나 올리면 보이는 글을 처음 열 때 늘어놓는다. */
  readonly items: ListingView[];
}

function makeGroup(key: string, lat: number, lng: number, strong: boolean, priced: boolean, sum: Summary, parts: ListingView[][]): Group {
  let sorted: ListingView[] | null = parts.length === 1 ? parts[0] : null;
  return {
    key, lat, lng, strong, priced, spots: parts.length, sum, parts,
    get items() {
      return (sorted ??= parts.flat().sort(showOrder));
    },
  };
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** 구 경계 출처는 범례 대신 지도 오른쪽 아래 출처 칸에 붙인다(구 경계를 그릴 때만). */
const BOUNDARY_CREDIT =
  `구 경계 <a href="${regionBoundaries.metadata.source}" target="_blank" rel="noopener" title="${esc(regionBoundaries.metadata.attribution)}">SGIS, admdongkor</a> ${regionBoundaries.metadata.license}`;
let boundaryCredit = false;
function setBoundaryCredit(on: boolean) {
  if (!map || on === boundaryCredit) return;
  if (on) map.attributionControl.addAttribution(BOUNDARY_CREDIT);
  else map.attributionControl.removeAttribution(BOUNDARY_CREDIT);
  boundaryCredit = on;
}
const MEH = '#aab2bd';
const color = (l: ListingView) => (l.verdict === 'star' ? '#c48a0a' : l.verdict === 'meh' ? MEH : l.isNew ? '#e5484d' : l.priceChange ? '#12825e' : '#1f5fbf');
/** 묶음 색은 가장 눈여겨볼 매물을 따른다(신규 → 가격 변동 → 관심 → 나머지, 모두 별로면 회색). 별로인 매물은 색을 정할 때 뺀다. */
const groupColor = (s: Summary) => (!s.nonMeh ? MEH : s.fresh ? '#e5484d' : s.changed ? '#12825e' : s.star ? '#c48a0a' : '#1f5fbf');
const MUTED = '#8f99a6';
/** 회색 매물의 가격 글자 바탕(흰 글자가 읽히게 회색 점보다 조금 진하게) */
const MUTED_PRICE = '#6f7a89';
/** 묶음에 별로가 아닌 신규 매물이 있으면 표시 오른쪽 위에 NEW 딱지를 붙인다. */
const hasNew = (s: Summary) => s.fresh;
const NEW_BADGE = '<em class="nw">NEW</em>';
/** 묶음을 '본 매물' 모양으로 그릴지: 별로를 뺀 매물을 모두 대시보드에서 봤고, 그 뒤로 새 소식이 없고 관심으로 고르지도 않았을 때 */
const groupSeen = (s: Summary) => s.nonMeh > 0 && s.nonMehSeen === s.nonMeh;
/** 글자 상자 색: 안 본 매물은 색으로 칠하고, 본 매물은 흰 바탕에 그 색 테두리와 글자 */
const boxStyle = (c: string, seen: boolean) => (seen ? `background:#fff;color:${c};border-color:${c}` : `background:${c}`);
const SEEN_MARK = '<i class="ck">✓</i>';
const MEH_MARK = '<i class="ck">✕</i>';
/** 묶음에 별로가 아닌 '📞 문의함' 매물이 있는지. 가격 앞(멀리서 보면 왼쪽 위)에 📞를 붙인다. */
const hasContacted = (s: Summary) => s.called;
const PHONE_MARK = '<i class="ck">📞</i>';

const positions = computed(() => new Set(props.background.filter((l) => l.lat != null).map((l) => `${l.lat!.toFixed(5)},${l.lng!.toFixed(5)}`)).size);

/** 같은 자리(소수 5자리, 약 1m)의 매물을 묶는다. 펼친 목록의 매물은 진한 묶음으로 따로 둔다. */
function spots(): Spot[] {
  const strongIds = new Set(props.listings.map((l) => l.id));
  const all = new Map<string, { lat: number; lng: number; items: ListingView[]; strong: boolean }>();
  const add = (l: ListingView, strong: boolean) => {
    if (l.lat == null || l.lng == null) return;
    const key = `${strong ? 's' : 'b'}${l.lat.toFixed(5)},${l.lng.toFixed(5)}`;
    const s = all.get(key);
    if (s) s.items.push(l);
    else all.set(key, { lat: l.lat, lng: l.lng, items: [l], strong });
  };
  for (const l of props.background) if (!strongIds.has(l.id)) add(l, false);
  for (const l of props.listings) add(l, true);
  return [...all.values()].map((s, idx) => {
    const items = s.items.sort(showOrder);
    const p = L.CRS.EPSG3857.latLngToPoint(L.latLng(s.lat, s.lng), 0);
    return { idx, lat: s.lat, lng: s.lng, items, strong: s.strong, x0: p.x, y0: p.y, sum: summarize(items) };
  });
}

/** 올리면 보이는 글: 매물마다 가격, 제목 앞부분, 끝에 괄호로 사이트와 내 표시(별로, 문의함, 봤음) */
function tooltip(g: Group) {
  const items = withMapPricesFirst(g);
  const lines = items.slice(0, 6).map((l) => {
    const mark = l.verdict === 'meh' ? ', 별로' : l.contactedAt ? ', 문의함' : looksSeen(l) ? ', 봤음' : '';
    const site = `${SOURCE_LABEL[l.source]}${mark}`;
    const memo = l.note ? ` <span class="tip-note">📝 ${esc(l.note.length > 24 ? `${l.note.slice(0, 24)}…` : l.note)}</span>` : '';
    // 평수는 가격 바로 뒤에 굵게 쓴다(몇 평인지를 가장 먼저 본다).
    const area = l.areaM2 != null ? `, <b>${pyeong(l.areaM2)}평</b>` : '';
    const changes = mapPriceChangeLines(l.priceChange).map(text => `<br><span class="tip-price-change">${esc(text)}</span>`).join('');
    return `${esc(pricesText(l))}${area}${l.title ? `, ${esc(l.title.slice(0, 24))}` : ''} <span class="tip-site">(${esc(site)})</span>${memo}${changes}`;
  });
  if (items.length > 6) lines.push(`외 ${items.length - 6}건`);
  const head = items.length > 1 ? `<strong>${g.spots > 1 ? '이 근처' : '이 자리'} ${items.length}건</strong><br>` : '';
  const { text, secondary } = g.sum;
  const prices = g.priced && secondary
    ? `<strong>최저 월세 ${esc(text)}<br>${secondary.quote.price.deal === 'jeonse' ? '최저 전세금' : '최저 보증금'} ${esc(secondary.text)}</strong><br>` : '';
  return head + prices + lines.join('<br>');
}

/** 창에 보이는 건수를 제한하므로 가격이 바뀐 매물을 먼저 보여 준다. */
function withPriceChangesFirst(items: ListingView[]) {
  const changed = (l: ListingView) => l.verdict !== 'meh' && !!l.priceChange;
  const changes = items.filter(changed);
  return changes.length ? [...changes, ...items.filter(l => !changed(l))] : items;
}

function withMapPricesFirst(g: Group) {
  const items = withPriceChangesFirst(g.items);
  const monthly = eligibleQuote(g.sum, g.sum.monthly)?.listing;
  if (!g.priced || !monthly || g.sum.n < 2) return items;
  const first = [monthly];
  const second = g.sum.secondary?.quote.listing;
  if (second && second.id !== monthly.id) first.push(second);
  const ids = new Set(first.map(l => l.id));
  return [...first, ...items.filter(l => !ids.has(l.id))];
}

/** 지도 표시에 쓸 짧은 금액(만원): 1억이 넘으면 '1.5억', 아니면 '9,000' */
function shortMoney(v: number | null): string {
  if (v == null) return '?';
  return v >= 10000 ? `${(Math.round(v / 1000) / 10).toLocaleString('ko-KR')}억` : v.toLocaleString('ko-KR');
}

/** 지도 표시에 쓰는 가격 글자: 월세와 단기 '보증금/월세', 전세 '전 1.5억', 매매와 경매 '3.2억' */
function mapPrice(p: PriceOption): string {
  if (p.deal === 'monthly' || p.deal === 'short') return `${shortMoney(p.deposit)}/${p.monthly ?? '?'}`;
  if (p.deal === 'jeonse') return `전 ${shortMoney(p.deposit)}`;
  return shortMoney(p.price);
}

const DEAL_ORDER: Record<DealType, number> = { monthly: 0, short: 1, jeonse: 2, sale: 3, auction: 4 };

/** 매물 카드의 환산 월세가 쓰는 전환율(연 %). 모르면 null */
const currentRate = () => rentRate.value.local ?? rentRate.value.legal;
/** 묶음 순서를 낼 때 쓰는 전환율. 같은 자리 묶음을 다시 만들 때 currentRate()를 읽어 둔다(견줄 때마다 읽지 않게). */
let rateNow: number | null = null;

/** 환산 월세(만원/월): 월세 + 보증금 × 전환율 ÷ 12, 전세는 전세금 × 전환율 ÷ 12. 매물 카드(convertedRent)와 같은 식이고, 낼 수 없으면 null */
function converted(p: PriceOption): number | null {
  if (rateNow == null || p.deposit == null) return null;
  if (p.deal === 'monthly' && p.monthly != null) return p.monthly + (p.deposit * rateNow) / 1200;
  if (p.deal === 'jeonse' && p.deposit > 0) return (p.deposit * rateNow) / 1200;
  return null;
}

/**
 * 첫 가격(카드 가격 줄의 첫 값) 비교. 월세와 전세는 환산 월세가 낮은 것(같으면 보증금이 낮은 것)을 먼저 둔다.
 * 환산 월세를 낼 수 없는 가격(단기, 매매, 경매, 전환율을 모를 때)은 그 뒤에 거래 종류, 월세, 보증금, 매매가가 낮은 순으로 둔다. 가격이 없으면 맨 뒤.
 */
function comparePrice(a: PriceOption | undefined, b: PriceOption | undefined) {
  if (!a || !b) return Number(!a) - Number(!b);
  const ca = converted(a);
  const cb = converted(b);
  if (ca != null || cb != null) {
    if (ca == null) return 1;
    if (cb == null) return -1;
    return ca - cb || (a.deposit ?? 0) - (b.deposit ?? 0);
  }
  return DEAL_ORDER[a.deal] - DEAL_ORDER[b.deal] || (a.monthly ?? 0) - (b.monthly ?? 0) || (a.deposit ?? 0) - (b.deposit ?? 0) || (a.price ?? 0) - (b.price ?? 0);
}

/** 묶음 안 순서(정보 창, 올리면 보이는 글, 목록에 알리는 순서): 별로가 아닌 매물을 싼 순(comparePrice)으로, 별로는 맨 뒤 */
const showOrder = (a: ListingView, b: ListingView) => Number(a.verdict === 'meh') - Number(b.verdict === 'meh') || comparePrice(a.prices[0], b.prices[0]);

type RentalQuote = { listing: ListingView; price: PriceOption };

function lowerQuote(a: RentalQuote | null, b: RentalQuote | null, field: 'monthly' | 'deposit') {
  if (!a || !b) return a ?? b;
  const other = field === 'monthly' ? 'deposit' : 'monthly';
  const rank = Number(a.listing.verdict === 'meh') - Number(b.listing.verdict === 'meh') ||
    a.price[field]! - b.price[field]! || (a.price[other] ?? Infinity) - (b.price[other] ?? Infinity);
  return rank > 0 ? b : a;
}

/**
 * 묶음 요약. 확대할 때마다 다시 묶으므로 매물을 다시 훑지 않고 이 값만 더해 가며, 표시 모양도 이것으로 정한다.
 * best는 기존 가격을 쓸 때 고르는 매물이고, 전월세 지도는 월세, 전세금, 보증금 기준을 쓴다.
 * text와 secondary는 가격 표시의 첫째 줄과 둘째 줄, n은 든 매물 수. 표시 앞 글자(📞, ✓, ✕)는
 * called와 '별로가 아닌 매물을 다 봤는지'(nonMehSeen === nonMeh, 모두 별로여도 같음)로 정해진다.
 */
interface Summary {
  best: ListingView | null;
  monthly: RentalQuote | null;
  deposit: RentalQuote | null;
  jeonse: RentalQuote | null;
  text: string;
  secondary: { quote: RentalQuote; text: string } | null;
  n: number;
  nonMeh: number;
  nonMehSeen: number;
  called: boolean;
  fresh: boolean;
  changed: boolean;
  star: boolean;
}

/** items는 showOrder로 늘어선 것이라 가격이 있는 첫 매물이 best다. */
function summarize(items: ListingView[]): Summary {
  const best = items.find((l) => l.prices[0]) ?? null;
  const s: Summary = { best, monthly: null, deposit: null, jeonse: null, text: '', secondary: null, n: items.length, nonMeh: 0, nonMehSeen: 0, called: false, fresh: false, changed: false, star: false };
  for (const l of items) {
    for (const price of props.rentalOptions?.get(l.id) ?? []) {
      const quote = { listing: l, price };
      if (price.deal === 'monthly') {
        if (price.monthly != null) s.monthly = lowerQuote(s.monthly, quote, 'monthly');
        if (price.deposit != null) s.deposit = lowerQuote(s.deposit, quote, 'deposit');
      } else if (price.deposit != null) s.jeonse = lowerQuote(s.jeonse, quote, 'deposit');
    }
    if (l.verdict === 'meh') continue;
    s.nonMeh++;
    if (looksSeen(l)) s.nonMehSeen++;
    if (l.contactedAt) s.called = true;
    if (l.isNew) s.fresh = true;
    if (l.priceChange) s.changed = true;
    if (l.verdict === 'star') s.star = true;
  }
  return priceLabel(s);
}

function eligibleQuote(s: Summary, quote: RentalQuote | null) {
  return s.nonMeh && quote?.listing.verdict === 'meh' ? null : quote;
}

function rentalLabel(price: PriceOption) {
  return price.deal === 'jeonse' ? `전 ${money(price.deposit)}` : priceAmount(price);
}

function priceLabel(s: Summary) {
  const monthly = eligibleQuote(s, s.monthly);
  const deposit = eligibleQuote(s, s.deposit);
  const jeonse = eligibleQuote(s, s.jeonse);
  const rental = monthly ?? deposit;
  const primary = rental ?? jeonse;
  s.text = primary ? rentalLabel(primary.price) : s.best ? mapPrice(s.best.prices[0]) : '';
  const other = rental ? jeonse ?? deposit : null;
  if (other) {
    const text = rentalLabel(other.price);
    if (text !== s.text) s.secondary = { quote: other, text };
  }
  return s;
}

function combine(a: Summary, b: Summary): Summary {
  const p = b.best && (!a.best || showOrder(b.best, a.best) < 0) ? b : a;
  return priceLabel({
    best: p.best,
    monthly: lowerQuote(a.monthly, b.monthly, 'monthly'),
    deposit: lowerQuote(a.deposit, b.deposit, 'deposit'),
    jeonse: lowerQuote(a.jeonse, b.jeonse, 'deposit'),
    text: '',
    secondary: null,
    n: a.n + b.n,
    nonMeh: a.nonMeh + b.nonMeh,
    nonMehSeen: a.nonMehSeen + b.nonMehSeen,
    called: a.called || b.called,
    fresh: a.fresh || b.fresh,
    changed: a.changed || b.changed,
    star: a.star || b.star,
  });
}

/** 글자 폭을 재는 캔버스와 잰 값(글꼴은 화면과 같은 --font) */
let measure: CanvasRenderingContext2D | null = null;
let measureFont = '';
const widths = new Map<string, number>();
/** 지도 글자 글꼴(화면의 --font). 캔버스 표시도 같은 글꼴로 쓴다. */
function mapFont() {
  if (!measureFont) {
    measure = document.createElement('canvas').getContext('2d');
    measureFont = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'sans-serif';
  }
  return measureFont;
}
function textWidth(text: string, px: number) {
  const key = `${px}|${text}`;
  const known = widths.get(key);
  if (known != null) return known;
  mapFont();
  let w = text.length * px * 0.6;
  if (measure) {
    measure.font = `700 ${px}px ${measureFont}`;
    w = measure.measureText(text).width;
  }
  widths.set(key, w);
  return w;
}

/**
 * 가격 표시 상자의 대략 폭(px). 겹치는지 따질 때 두 가격 줄 중 더 긴 쪽을 쓴다.
 */
function labelWidth(s: Summary, strong: boolean) {
  const fs = strong ? 12 : 11;
  let w = (strong ? 16 : 13) + Math.max(textWidth(s.text || '?', fs), s.secondary ? stackedPriceWidth(s.text, s.secondary, fs) : 0);
  const mark = s.called ? '📞' : s.nonMehSeen === s.nonMeh ? (s.nonMeh ? '✓' : '✕') : '';
  if (mark) w += 3 + textWidth(mark, fs);
  if (s.n > 1) w += countWidth(s.n);
  return w;
}
/** 건수 동그라미 폭과 그 앞 틈(px). 모든 상자가 border-box라 동그라미는 '최소 14px'과 '글자 + 좌우 여백 3px씩' 중 넓은 쪽이다. */
const countWidths = new Map<number, number>();
function countWidth(n: number) {
  let w = countWidths.get(n);
  if (w == null) countWidths.set(n, (w = 3 + Math.max(14, textWidth(String(n), 10) + 6)));
  return w;
}
const LABEL_H = { normal: 20.5, strong: 25 };
const PRICE_COLUMN_GAP = 2;
function stackedPriceWidth(first: string, second: NonNullable<Summary['secondary']>, fs: number) {
  const [firstDeposit, firstRent] = first.split('/');
  if (second.quote.price.deal === 'jeonse') {
    const monthlyWidth = textWidth(firstDeposit, fs) + textWidth('/', fs) + textWidth(firstRent, fs) + 2 * PRICE_COLUMN_GAP;
    return Math.max(monthlyWidth, textWidth(second.text, fs));
  }
  const [secondDeposit, secondRent] = second.text.split('/');
  return Math.max(textWidth(firstDeposit, fs), textWidth(secondDeposit, fs)) + textWidth('/', fs) +
    Math.max(textWidth(firstRent, fs), textWidth(secondRent, fs)) + 2 * PRICE_COLUMN_GAP;
}
const labelHeight = (s: Summary, strong: boolean) => (strong ? LABEL_H.strong : LABEL_H.normal) + (s.secondary ? (strong ? 17 : 16) : 0);

/** 가격 표시끼리 이만큼은 겹쳐도 글자가 가려지지 않는다(px, 상자의 안쪽 여백과 테두리 몫). */
const OVERLAP_OK = { x: 6, y: 3 };

/** 화면에서 겹친 자리 묶음. x, y는 지금 확대의 화면 좌표, w는 가격 표시 폭 */
interface Pile {
  x: number;
  y: number;
  w: number;
  h: number;
  lat: number;
  lng: number;
  sum: Summary;
  spots: Spot[];
  gone: boolean;
}

/**
 * 지금 확대(zoom)에서 가격 표시가 글자를 가릴 만큼 겹치는 자리끼리 묶는다. 매물이 많은 자리부터 이웃을 끌어오고,
 * 묶은 표시는 든 매물 수로 가중한 가운데에 놓는다. 묶어서 자리가 옮겨지면 다시 겹칠 수 있어 더 묶을 게 없을 때까지 되풀이한다.
 */
function mergeOverlaps(list: Spot[], strong: boolean, zoom: number): Pile[] {
  const scale = 2 ** zoom;
  let piles: Pile[] = list.map((s) => ({ x: s.x0 * scale, y: s.y0 * scale, w: labelWidth(s.sum, strong), h: labelHeight(s.sum, strong),
    lat: s.lat, lng: s.lng, sum: s.sum, spots: [s], gone: false }));
  piles.sort((a, b) => b.sum.n - a.sum.n);
  for (let pass = 0; pass < 8; pass++) {
    // 칸을 가장 넓은 표시 폭과 표시 높이로 잡으면 겹칠 수 있는 이웃은 둘레 아홉 칸 안에만 있다.
    let cw = 1;
    let ch = 1;
    for (const p of piles) {
      cw = Math.max(cw, p.w);
      ch = Math.max(ch, p.h);
    }
    const cell = (gx: number, gy: number) => gx * 67108864 + gy;
    const grid = new Map<number, Pile[]>();
    for (const p of piles) {
      const k = cell(Math.floor(p.x / cw), Math.floor(p.y / ch));
      const bucket = grid.get(k);
      if (bucket) bucket.push(p);
      else grid.set(k, [p]);
    }
    let merged = false;
    for (const a of piles) {
      if (a.gone) continue;
      const gx = Math.floor(a.x / cw);
      const gy = Math.floor(a.y / ch);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const b of grid.get(cell(gx + dx, gy + dy)) ?? []) {
            if (b === a || b.gone) continue;
            if (Math.abs(a.x - b.x) >= (a.w + b.w) / 2 - OVERLAP_OK.x || Math.abs(a.y - b.y) >= (a.h + b.h) / 2 - OVERLAP_OK.y) continue;
            const wa = a.sum.n / (a.sum.n + b.sum.n);
            const wb = 1 - wa;
            a.x = a.x * wa + b.x * wb;
            a.y = a.y * wa + b.y * wb;
            a.lat = a.lat * wa + b.lat * wb;
            a.lng = a.lng * wa + b.lng * wb;
            a.sum = combine(a.sum, b.sum);
            for (const s of b.spots) a.spots.push(s);
            a.w = labelWidth(a.sum, strong);
            a.h = labelHeight(a.sum, strong);
            b.gone = true;
            merged = true;
          }
        }
      }
    }
    piles = piles.filter((p) => !p.gone);
    if (!merged) break;
  }
  return piles;
}

/** 같은 자리 묶음. 매물이 바뀌면(render의 full) 비우고 다시 만든다. */
let spotCache: Spot[] | null = null;

/**
 * 지금 확대와 가격 표시 단계(level)에서 그릴 묶음 전체. 동그라미는 같은 자리끼리만 묶고, 가격 표시는 화면에서 겹치는 것끼리 더 묶는다.
 * 펼친 목록의 매물(진한 표시)과 나머지는 섞지 않고, 진한 묶음이 위에 오게 뒤에 둔다.
 */
function computeGroups(level: number, zoom: number): Group[] {
  if (!spotCache) {
    rateNow = currentRate();
    spotCache = spots();
  }
  const out: Group[] = [];
  const labels: Record<'b' | 's', Spot[]> = { b: [], s: [] };
  const head = (strong: boolean, priced: boolean) => `${level}${strong ? 's' : 'b'}${priced ? 'p' : 'd'}|`;
  for (const s of spotCache) {
    if ((s.strong ? level >= 1 : level >= 2) && s.sum.text) labels[s.strong ? 's' : 'b'].push(s);
    else out.push(makeGroup(head(s.strong, false) + s.idx, s.lat, s.lng, s.strong, false, s.sum, [s.items]));
  }
  for (const strong of [false, true]) {
    for (const p of mergeOverlaps(labels[strong ? 's' : 'b'], strong, zoom)) {
      const ids = p.spots.length === 1 ? String(p.spots[0].idx) : p.spots.map((s) => s.idx).sort((a, b) => a - b).join(',');
      out.push(makeGroup(head(strong, true) + ids, p.lat, p.lng, strong, true, p.sum, p.spots.map((s) => s.items)));
    }
  }
  return out.sort((a, b) => Number(a.strong) - Number(b.strong));
}

/** 지금 확대에서 가격 표시 단계(PRICE_ZOOM) */
const priceLevel = () => {
  const z = map?.getZoom() ?? 0;
  return z >= PRICE_ZOOM.normal ? 2 : z >= PRICE_ZOOM.strong ? 1 : 0;
};

/**
 * 가격 글자(정보 창, 올리면 보이는 글). 월세는 지도 표시처럼 낱말 없이 '5,000/10'으로 쓴다(보증금이 큰 월세를
 * '월세'라고 못 박지 않고 숫자로 보이게). 전세, 단기, 매매, 경매는 '전세 1억 5,000'처럼 거래 이름을 붙인다.
 * 고시원과 쉐어의 가장 싼 방과 비싼 방은 '0/22 ~ 0/40'처럼 잇는다.
 */
function pricesText(l: ListingView) {
  const range = roomRange(l);
  return range ?? l.prices.map((p) => (p.deal === 'monthly' ? priceAmount(p) : priceText(p))).join(', ');
}

const line = (className: string, text: string) => {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
};

/** 정보 창에 보이는 매물 수. 더 있으면 '외 N건'으로 줄인다. */
const POPUP_MAX = 12;
/** 정보 창 내용 폭의 한계(px). 폭은 Leaflet이 내용에 맞춰 정하는데, 단추 줄은 줄바꿈하지 않아 사실상 단추 줄 폭에 맞는다. */
const POPUP_WIDTH = { min: 200, max: 480 };

/** 정보 창 카드 왼쪽의 사진 칸. 크기가 정해져 있어 사진이 늦게 와도 창 크기는 그대로다. 없거나 못 불러오면 '사진 없음'. */
function popupThumb(src: string | null) {
  const el = document.createElement('div');
  el.className = 'mp-thumb';
  const empty = () => {
    el.replaceChildren();
    el.textContent = '사진 없음';
  };
  if (!src) {
    empty();
    return el;
  }
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', empty, { once: true });
  el.appendChild(img);
  return el;
}

/** 고른 매물이 묶음에 들어 있으면 맨 앞으로 옮긴다(나머지는 묶음 순서 그대로). */
function withSelectedFirst(items: ListingView[]) {
  const i = props.selectedId ? items.findIndex((l) => l.id === props.selectedId) : -1;
  return i > 0 ? [items[i], ...items.slice(0, i), ...items.slice(i + 1)] : items;
}

/**
 * 누르면 보이는 창: 맨 위에 건수 머리글(창 안을 스크롤해도 남음), 그 아래 매물마다 카드 하나.
 * 카드에는 왼쪽 사진(popupThumb), 가격과 변동 내역, 오른쪽 끝 평수 상자, 그 아래 '원본 열기', '네이버 지도' 단추를 둔다. 옆에 목록이 있으면 카드를 누를 때
 * 목록에서 그 매물을 고른다(예전 '목록에서 보기' 단추). 층, 유형, 사이트, 내 표시(봤음, 문의함 등), 메모는 매물 카드와
 * 올리면 보이는 글에 있어서 창에는 쓰지 않는다(가격을 먼저 보게).
 * 고른 매물, 핀에 표시한 매물과 가격이 바뀐 매물이 먼저 나오고, 나머지는 싼 순(월세와 전세는 환산 월세)이다.
 * 폭은 Leaflet이 줄바꿈 없이 잰 내용 폭에 맞추므로, 가격 줄과 단추 줄은 줄바꿈하지 않게 해서 창이 그 둘 중 긴 쪽에 딱 맞게 한다.
 */
function popup(g: Group, items: ListingView[]) {
  if (!map) return;
  const box = document.createElement('div');
  box.className = 'mp';
  if (items.length > 1) box.appendChild(line('mp-head', `${g.spots > 1 ? '이 근처' : '이 자리'} 매물 ${items.length}건`));
  const shown = items.slice(0, POPUP_MAX);
  // 사진은 보이는 매물 중 하나라도 있을 때만 왼쪽 칸에 둔다(같은 매물을 여러 번 올린 것을 사진으로 가려 보게). 경매처럼 사진이 없는 묶음은 칸을 비우지 않는다.
  const withThumb = shown.some((l) => l.thumbnail);
  for (const l of shown) {
    const card = document.createElement('div');
    card.className = 'mp-card';
    card.dataset.listingId = l.id;
    if (withThumb) {
      card.classList.add('has-thumb');
      card.appendChild(popupThumb(l.thumbnail));
    }
    const top = document.createElement('div');
    top.className = 'mp-top';
    const cost = document.createElement('div');
    const price = document.createElement('strong');
    price.textContent = pricesText(l) || '가격 정보 없음';
    cost.appendChild(price);
    const changes = mapPriceChangeLines(l.priceChange ?? l.latestPriceChange ?? null);
    if (changes.length) {
      const details = document.createElement('div');
      details.className = 'mp-price-change';
      for (const text of changes) details.appendChild(line('mp-change-line', text));
      cost.appendChild(details);
    }
    top.appendChild(cost);
    if (l.areaM2 != null) {
      // 평수는 가격 줄 오른쪽 끝에 작은 상자로 둔다(카드마다 같은 자리라 위아래로 훑기 쉽다). 올리면 전용면적(땅은 토지 면적) ㎡.
      const area = line('mp-area', `${pyeong(l.areaM2)}평`);
      area.title = `${kindOf(l) === 'land' ? '토지' : '전용'} ${l.areaM2}㎡`;
      top.appendChild(area);
    }
    card.appendChild(top);
    if (props.listMode) {
      card.classList.add('go');
      card.title = '누르면 목록에서 이 매물을 봅니다';
      card.addEventListener('click', () => {
        if (props.viewKey !== 'overview') map?.closePopup();
        big.value = false;
        emit('select', l);
      });
    }
    const actions = document.createElement('div');
    actions.className = 'mp-actions';
    // 단추와 링크를 누를 때는 카드 누름(목록에서 보기)으로 번지지 않게 한다.
    actions.addEventListener('click', (e) => e.stopPropagation());
    const open = document.createElement('button');
    open.textContent = '원본 열기';
    open.addEventListener('click', () => emit('open', l));
    actions.appendChild(open);
    // '📞 문의함'과 '📝 메모' 단추는 매물 카드에만 둔다.
    // 네이버 단추는 단지 화면(단지 매물이거나 같은 자리 단지를 찾으면)이나 그 자리 지도를 연다(naverLink).
    const link = naverLink(l);
    if (link) {
      const naver = document.createElement('a');
      naver.textContent = link.label;
      naver.href = link.url;
      naver.target = '_blank';
      naver.rel = 'noopener';
      naver.title = link.title;
      actions.appendChild(naver);
    }
    for (const s of auctionSiteLinks(l)) {
      const site = document.createElement('a');
      site.textContent = `${s.name} ↗`;
      site.href = s.url;
      site.target = '_blank';
      site.rel = 'noopener';
      site.title = `${s.name}에서 이 물건 보기`;
      actions.appendChild(site);
    }
    card.appendChild(actions);
    box.appendChild(card);
  }
  if (items.length > POPUP_MAX) {
    const more = document.createElement('div');
    more.className = 'mp-more';
    more.textContent = `외 ${items.length - POPUP_MAX}건`;
    box.appendChild(more);
  }
  const layer = listingPopup ?? L.popup({ minWidth: POPUP_WIDTH.min, maxWidth: POPUP_WIDTH.max, className: 'mp-popup' });
  if (!listingPopup) {
    layer.once('remove', () => {
      if (listingPopup === layer) listingPopup = null;
    });
  }
  listingPopup = layer;
  layer.setLatLng([g.lat, g.lng]).setContent(box).openOn(map);
  highlightPopupCard(props.selectedId);
}

function highlightPopupCard(id: string | null) {
  const box = listingPopup?.getContent();
  if (!(box instanceof HTMLElement)) return;
  for (const card of box.querySelectorAll<HTMLElement>('.mp-card')) {
    const chosen = card.dataset.listingId === id;
    card.classList.toggle('mp-selected', chosen);
    if (chosen) {
      card.setAttribute('aria-current', 'true');
      const top = card.offsetTop;
      if (top < box.scrollTop || top + card.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top;
    } else card.removeAttribute('aria-current');
  }
}

function showListingPopup(id: string) {
  const g = groupOf.get(id);
  if (!g) {
    listingPopup?.remove();
    return;
  }
  popup(g, withSelectedFirst(withMapPricesFirst(g)));
}

defineExpose({ showListingPopup });

/** 역: 켜진 지역이면 검은 동그라미, 아니면 흰 동그라미. 누르면 station 이벤트로 켜고 끈다. */
function drawStations() {
  if (!map || !stationLayer || !stationRenderer) return;
  stationLayer.clearLayers();
  if (map.getZoom() < STATION_MIN_ZOOM) return;
  const on = new Set(props.areas.map((a) => a.name));
  const view = map.getBounds().pad(0.3);
  for (const s of stations.value) {
    if (!view.contains([s.lat, s.lng])) continue;
    const enabled = on.has(s.name);
    L.circleMarker([s.lat, s.lng], {
      renderer: stationRenderer,
      radius: enabled ? 7 : 6,
      color: '#16202e',
      weight: 2,
      fillColor: enabled ? '#16202e' : '#fff',
      fillOpacity: 1,
    })
      .bindTooltip(`${esc(s.label)}<br><span class="st-tip">${enabled ? '누르면 이 역 알림 끄기' : '누르면 이 역 알림 켜기(1km)'}</span>`, { direction: 'top', offset: [0, -6] })
      .on('click', () => emit('station', s))
      .addTo(stationLayer);
  }
}

/** 정비사업 구역: 사업 구역은 옅게 칠하고, 넓은 구역(재정비촉진지구, 모아타운, 존치관리구역)은 점선 테두리만 그린다. */
function drawZones() {
  if (!map || !zoneRenderer) return;
  zoneLayer?.remove();
  zoneLayer = null;
  const list = zonesOn.value ? (zones.value?.features ?? []) : [];
  if (!list.length) return;
  // renderer는 만들 때 넘겨야 해서(style로는 안 바뀜) 옵션에 같이 둔다.
  const options: L.GeoJSONOptions & { renderer: L.Renderer } = {
    renderer: zoneRenderer,
    style: (f) => {
      const p = (f as unknown as RedevZoneFeature).properties;
      const c = ZONE_COLOR[p.group];
      return p.outline
        ? { color: c, weight: 2, opacity: 0.85, dashArray: '6 5', fill: false }
        : { color: c, weight: 1.2, opacity: 0.9, fillColor: c, fillOpacity: 0.2 };
    },
    onEachFeature: (f, layer) => {
      const p = (f as unknown as RedevZoneFeature).properties;
      const sub = [p.type, p.stage].filter(Boolean).join(', ');
      const foot = [p.gu, p.date ? `${p.date.replace(/-/g, '.')} 기준` : null].filter(Boolean).join(', ');
      layer.bindTooltip(`<strong>${esc(p.name)}</strong><br>${esc(sub)}${foot ? `<br><span class="st-tip">${esc(foot)}</span>` : ''}`, { sticky: true });
    },
  };
  zoneLayer = L.geoJSON(list as unknown as GeoJSON.FeatureCollection['features'], options).addTo(map);
}

/** ISO 시각 → 이 컴퓨터 날짜 'M.D' */
function monthDay(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}.${d.getDate()}`;
}

function pickZoneFile() {
  fileEl.value?.click();
}
function onZoneFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) void uploadZones(file);
}

/** 핀: 이름을 쓴 표시(아래 끝이 그 자리, 표시 핀은 색이 다름). 끌어서 옮기고, 누르면 이름, 종류 바꾸기와 빼기 창을 띄운다. */
function drawPins() {
  if (!pinLayer) return;
  pinMove?.popup.remove();
  pinLayer.clearLayers();
  for (const p of walkPins.value) {
    const marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: p.kind === 'mark' ? 'walk-pin mark' : 'walk-pin', html: `<span>${esc(p.name)}</span>`, iconSize: [0, 0], iconAnchor: [0, 0], tooltipAnchor: [0, -34] }),
      pane: 'walkpins',
      draggable: true,
      keyboard: false,
    });
    const help = `<span class="st-tip">${p.kind === 'mark' ? '표시 핀' : '거리 핀'}, 끌어서 옮긴 뒤 O로 저장, 누르면 이름 바꾸기와 빼기</span>`;
    // 표시 핀은 마우스를 올릴 때마다 거리 핀까지 거리를 새로 읽어 보인다(옮긴 뒤 다시 잰 값도 바로 반영).
    marker.bindTooltip(p.kind === 'mark' ? () => `${esc(p.name)}${markLines(p.id)}<br>${help}` : `${esc(p.name)}<br>${help}`, { direction: 'top' });
    marker.on('dragstart', () => {
      if (pinMove?.marker !== marker) pinMove?.popup.remove();
    });
    marker.on('dragend', () => confirmPinMove(p.id, marker, L.latLng(p.lat, p.lng)));
    marker.on('click', () => {
      if (pinMove?.marker !== marker) pinPopup(p.id);
    });
    marker.addTo(pinLayer);
  }
}

function confirmPinMove(id: string, marker: L.Marker, original: L.LatLng) {
  if (!map) return;
  const at = marker.getLatLng();
  pinMove?.popup.remove();
  const lat = round6(at.lat);
  const lng = round6(at.lng);
  if (lat === original.lat && lng === original.lng) {
    marker.setLatLng(original);
    return;
  }

  marker.setLatLng(at);
  marker.closeTooltip();
  const box = document.createElement('div');
  box.className = 'pin-move-actions';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', '핀 위치 변경');

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-sm btn-primary';
  save.textContent = 'O';
  save.title = '새 핀 위치 저장';
  save.setAttribute('aria-label', save.title);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-sm';
  cancel.textContent = 'X';
  cancel.title = '핀을 원래 위치로 되돌리기';
  cancel.setAttribute('aria-label', cancel.title);
  box.append(save, cancel);

  const popup = L.popup({ className: 'pin-move-popup', minWidth: 0, offset: [0, -36], closeButton: false, closeOnClick: false,
    closeOnEscapeKey: false }).setLatLng(at).setContent(box);
  let saved = false;
  popup.once('remove', () => {
    box.hidden = true;
    if (pinMove?.popup === popup) pinMove = null;
    if (!saved) marker.setLatLng(original);
  });
  cancel.addEventListener('click', () => popup.remove());
  save.addEventListener('click', () => {
    saved = true;
    popup.remove();
    moveWalkPin(id, lat, lng);
  });
  pinMove = { marker, popup };
  popup.openOn(map);
  cancel.focus({ preventScroll: true });
}

/** 표시 핀 툴팁에 넣을 거리 핀마다 거리 줄. 길을 따라 잰 값이 있으면 걷는 시간과 거리, 없으면 곧은 거리. */
function markLines(id: string) {
  const list = markDistances(id);
  if (!list.length) return '<br><span class="st-tip">거리 핀을 꽂으면 그 핀까지 거리가 보입니다</span>';
  return list
    .map((d) => {
      const name = `<b>${esc(d.pin.name)}</b>까지`;
      if (d.meters != null) return `<br>${name} 걸어서 ${d.minutes}분(${distanceText(d.meters)})`;
      const why = walkState.value.loading ? '걷는 길 재는 중' : '걷는 길 못 잼';
      return `<br>${name} 곧은 거리 ${distanceText(d.straight)} <span class="st-tip">(${why})</span>`;
    })
    .join('');
}

/** 핀을 누르면 뜨는 창: 이름 칸(Enter나 칸을 벗어나면 저장), 종류 바꾸기, '핀 빼기' */
function pinPopup(id: string) {
  const pin = walkPins.value.find((p) => p.id === id);
  if (!pin || !map) return;
  const box = document.createElement('div');
  box.className = 'mp-actions pin-pop';
  const name = document.createElement('input');
  name.value = pin.name;
  name.maxLength = WALK_NAME_MAX;
  name.setAttribute('aria-label', '핀 이름');
  name.addEventListener('change', () => renameWalkPin(id, name.value));
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') map?.closePopup();
  });
  const other: PinKind = pin.kind === 'mark' ? 'walk' : 'mark';
  const swap = document.createElement('button');
  swap.textContent = other === 'mark' ? '표시 핀으로' : '거리 핀으로';
  if (pinCount(other) >= pinMax(other)) {
    swap.disabled = true;
    swap.title = `${other === 'mark' ? '표시' : '거리'} 핀은 ${pinMax(other)}개까지 꽂습니다`;
  }
  swap.addEventListener('click', () => {
    map?.closePopup();
    setPinKind(id, other);
  });
  const remove = document.createElement('button');
  remove.textContent = '핀 빼기';
  remove.addEventListener('click', () => {
    map?.closePopup();
    removeWalkPin(id);
  });
  box.append(name, swap, remove);
  L.popup({ className: 'mp-popup', offset: [0, -30] }).setLatLng([pin.lat, pin.lng]).setContent(box).openOn(map);
  name.focus();
  name.select();
}

/** 지역이 이보다 많으면(노선 하나를 켠 때 등) 지역 이름을 늘 띄우지 않는다(겹쳐서 지도를 가림). */
const AREA_LABEL_MAX = 12;

/** 이름을 늘 띄우지 않는 구 경계(지역이 AREA_LABEL_MAX보다 많을 때). 마우스가 그 구 안에 들어가면 이름을 띄운다(onDistrictHover). */
interface HoverDistrict {
  layer: L.GeoJSON;
  bounds: L.LatLngBounds;
  geometry: Parameters<typeof pointInGeometry>[0];
}
let hoverDistricts: HoverDistrict[] = [];
/** 지금 마우스를 올려 이름을 띄운 구 경계 */
let hoveredDistrict: L.GeoJSON | null = null;

/**
 * 구 경계는 마우스를 받지 않아서(칠한 면이 그 아래 역과 정비구역을 가리지 않게) 마우스를 올려도 이름이 저절로 뜨지 않는다.
 * 그래서 지도 위 마우스 자리가 어느 구 안인지 여기서 따져 그 구의 이름만 띄운다.
 */
function onDistrictHover(e: MouseEvent) {
  if (!map || !hoverDistricts.length) return;
  const at = map.mouseEventToLatLng(e);
  const hit = hoverDistricts.find((d) => d.bounds.contains(at) && pointInGeometry(d.geometry, at.lat, at.lng))?.layer ?? null;
  if (hit === hoveredDistrict) return;
  hoveredDistrict?.closeTooltip();
  hit?.openTooltip();
  hoveredDistrict = hit;
}
function clearDistrictHover() {
  hoveredDistrict?.closeTooltip();
  hoveredDistrict = null;
}

/** 지역 원. 역 이름이 아닌 지역(지도에서 찍은 곳)은 가운데에 마름모를 두고, 누르면 area 이벤트로 끈다. */
function drawBase() {
  if (!base) return;
  clearDistrictHover();
  hoverDistricts = [];
  base.clearLayers();
  const stationNames = new Set(stations.value.map((s) => s.name));
  const labels = props.areas.length <= AREA_LABEL_MAX;
  const drawn = new Set<string>();
  for (const a of props.areas) {
    if (a.region) {
      const code = a.region.code.slice(0, 5);
      const feature = boundaryOf(code);
      if (feature && !drawn.has(code)) {
        drawn.add(code);
        const color = regionColor(code);
        // 구 경계는 마우스를 받지 않는다. 받으면 칠한 면이 그 아래 역(누르면 알림 켜고 끔)과 정비구역(올리면 이름)을 가린다.
        const layer = L.geoJSON(feature, { style: { color, fillColor: color, weight: 2.5, fillOpacity: 0.12 }, interactive: false });
        // 구 이름은 범례 대신 구역 가운데에 붙인다(지역이 많으면 마우스가 그 구 안에 있을 때만).
        layer.bindTooltip(`${esc(a.region.sigungu)}${a.region.kind === 'gu' ? '' : ' (참고용 구 경계)'}`, { permanent: labels, direction: 'center', className: 'area-label' }).addTo(base);
        if (!labels) hoverDistricts.push({ layer, bounds: layer.getBounds(), geometry: feature.geometry });
      }
      continue;
    }
    const alarm = a.purpose === 'alert';
    const circle = L.circle([a.lat, a.lng], { radius: a.radiusM, color: alarm ? '#087f5b' : '#16202e', weight: alarm ? 2.5 : 1.5, fillOpacity: alarm ? 0.045 : 0.03, dashArray: '6 6', interactive: false });
    circle.bindTooltip(alarm ? `${esc(a.name)} 알림 반경 ${distanceText(a.radiusM)}` : a.name, { permanent: labels && !alarm, direction: 'top', className: 'area-label' });
    circle.addTo(base);
    if (!stations.value.length || stationNames.has(a.name)) continue;
    L.marker([a.lat, a.lng], { icon: L.divIcon({ className: 'pick-pin', html: '<span></span>', iconSize: [16, 16], iconAnchor: [8, 8] }), keyboard: false, zIndexOffset: 800 })
      .bindTooltip(`${esc(a.name)}<br><span class="st-tip">누르면 이 지역 끄기</span>`, { direction: 'top', offset: [0, -6] })
      .on('click', () => emit('area', a))
      .addTo(base);
  }
  setBoundaryCredit(drawn.size > 0);
}

/**
 * 매물이 많으면 위도와 경도 각각 양 끝 1%를 빼고 가운데 98%의 범위만 쓴다. 멀리 떨어진 몇 건(크롬 확장이 다른 동네에서 받은 매물 등)
 * 때문에 지도가 두세 배 넓어지지 않게 한다(실제 매물로 재 보니 전부는 동서 22km, 가운데 98%는 8km).
 */
function coreBounds(points: L.LatLng[]) {
  if (points.length < 50) return L.latLngBounds(points);
  const lats = points.map((p) => p.lat).sort((a, b) => a - b);
  const lngs = points.map((p) => p.lng).sort((a, b) => a - b);
  const lo = Math.floor(points.length * 0.01);
  const hi = Math.ceil(points.length * 0.99) - 1;
  return L.latLngBounds([lats[lo], lngs[lo]], [lats[hi], lngs[hi]]);
}

/**
 * 지도를 매물에 맞춘다. 매물의 가운데 98%(coreBounds)와 켜 둔 구 경계를 넣는다. 알림 반경은 매물이 있으면 넣지 않는다
 * (알림 반경 두 배까지 넣으면 구 경계보다 훨씬 넓어져서, 처음 열 때 지도가 매물에서 비켜나 있었다). 매물이 없으면 지역에 맞춘다.
 */
function fitTo(points: L.LatLng[]) {
  if (!map) return;
  if (!props.visible || !el.value?.clientWidth || !el.value.clientHeight) {
    fitPending = true;
    return;
  }
  fitPending = false;
  const bounds = coreBounds(points);
  for (const a of props.areas) if (a.region) {
    const b = regionBounds(a.region.code);
    if (b) bounds.extend([[b[1], b[0]], [b[3], b[2]]]);
  }
  if (!points.length) for (const a of props.areas) bounds.extend(L.latLng(a.lat, a.lng).toBounds(a.radiusM * 2));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
}

/** '매물에 맞추기' 단추: 펼친 목록(없으면 보이는 매물 전체)과 켜 둔 구에 다시 맞춘다. */
function fitToListings() {
  firstFitPending = false;
  fitTo(focusPoints());
}

// ---------- 지도 위치 기억(viewKey) ----------
const VIEW_KEY_PREFIX = 'hnw-map-view-';
interface SavedView {
  lat: number;
  lng: number;
  zoom: number;
}
/** 이 탭에서 마지막으로 본 지도 자리. 기억이 없거나 값이 이상하면 null(그때는 매물에 맞춘다). */
function readView(): SavedView | null {
  if (!props.viewKey) return null;
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY_PREFIX + props.viewKey) ?? 'null') as Partial<SavedView> | null;
    if (!v || typeof v.lat !== 'number' || typeof v.lng !== 'number' || typeof v.zoom !== 'number') return null;
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng) || !Number.isFinite(v.zoom) || Math.abs(v.lat) > 90 || Math.abs(v.lng) > 180) return null;
    return { lat: v.lat, lng: v.lng, zoom: Math.min(19, Math.max(5, v.zoom)) };
  } catch {
    return null;
  }
}
/**
 * 처음 열 때 매물이 아직 오지 않았으면(대시보드를 막 켠 때) 우선 지역에 맞춰 두고, 매물이 처음 들어올 때 한 번 더 매물에 맞춘다.
 * 그 사이에 사용자가 지도를 끌면 다시 맞추지 않는다. 이 맞추기가 끝나기 전에는 자리를 기억하지 않는다(지역에 맞춘 넓은 자리를 기억하지 않게).
 */
let firstFitPending = false;
/** 칸 크기 변화로 지도가 움직이는 동안(invalidateSize)은 자리를 기억하지 않는다. */
let quietMove = false;
/** 지도를 다 옮기거나 확대를 마칠 때 지금 자리를 기억한다. */
function saveView() {
  if (!map || !props.viewKey || firstFitPending || quietMove || !props.visible) return;
  const c = map.getCenter();
  try {
    localStorage.setItem(VIEW_KEY_PREFIX + props.viewKey, JSON.stringify({ lat: round6(c.lat), lng: round6(c.lng), zoom: map.getZoom() }));
  } catch {
    /* 저장이 막혀도 지도는 동작한다 */
  }
}

/** 캔버스 숫자 동그라미(CountMarker)의 모양: 가운데 글자(건수나 ✕), 신규 딱지, 📞, 그림자, 고른 표시 테두리 */
interface CountLook {
  text: string;
  textColor: string;
  fontPx: number;
  /** NEW 딱지가 동그라미 상자의 [위, 오른쪽]으로 튀어나오는 길이(px, 예전 HTML 표시의 .nw 자리). 딱지가 없으면 null */
  newAt: [number, number] | null;
  phone: boolean;
  /** 그림자 진하기(0이면 없음) */
  shadow: number;
  selected: boolean;
}
/** Leaflet 캔버스 그리기의 안쪽 값(공개 타입에 없어서 여기서만 쓴다) */
interface CanvasPath {
  options: L.CircleMarkerOptions & { look?: CountLook };
  _renderer: { _ctx: CanvasRenderingContext2D; _drawing: boolean };
  _point?: L.Point;
  _radius: number;
  _pxBounds: L.Bounds;
  _empty(): boolean;
  _containsPoint(p: L.Point): boolean;
}
const circleProto = L.CircleMarker.prototype as unknown as { _updateBounds(this: unknown): void; _updatePath(this: unknown): void };
const NEW_COLOR = '#e5484d';
/** NEW 딱지 글자 폭(기울인 굵은 9px, 처음 그릴 때 잰다) */
let newTextWidth = 0;

/**
 * 캔버스에 그리는 숫자 동그라미. Leaflet이 그리는 동그라미(채우기와 테두리) 위에 가운데 글자와 딱지를 더 그린다.
 * 모양은 예전 HTML 표시(.stack)에 맞춘다. 누름과 올리면 보이는 글은 Leaflet 캔버스가 동그라미 안에서만 받는다.
 */
const CountMarker = L.CircleMarker.extend({
  _updateBounds(this: CanvasPath) {
    circleProto._updateBounds.call(this);
    const look = this.options.look!;
    // 딱지와 고른 표시 테두리는 동그라미 밖으로 나가므로, 캔버스에서 다시 그릴 범위를 그만큼 넓힌다.
    const pad = look.newAt || look.phone ? 36 : 6;
    this._pxBounds = L.bounds(this._pxBounds.min!.subtract([pad, pad]), this._pxBounds.max!.add([pad, pad]));
  },
  _updatePath(this: CanvasPath) {
    const r = this._renderer;
    if (!r._drawing || this._empty() || !this._point) return;
    const ctx = r._ctx;
    const { x, y } = this._point;
    const look = this.options.look!;
    const outer = this._radius + (this.options.weight ?? 0) / 2;
    if (look.shadow) {
      ctx.globalAlpha = look.shadow;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(x, y + 1, outer + 0.75, 0, Math.PI * 2);
      ctx.fill();
    }
    circleProto._updatePath.call(this);
    ctx.save();
    if (look.selected) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#16202e';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, outer + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (look.text) {
      ctx.globalAlpha = this.options.opacity ?? 1;
      ctx.fillStyle = look.textColor;
      ctx.font = `700 ${look.fontPx}px ${mapFont()}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(look.text, x, y + 0.5);
    }
    if (look.newAt) {
      ctx.globalAlpha = 1;
      ctx.font = `italic 800 9px ${mapFont()}`;
      newTextWidth ||= ctx.measureText('NEW').width;
      const w = newTextWidth + 8;
      const h = 13.25;
      const left = x + outer + look.newAt[1] - w;
      const top = y - outer - look.newAt[0];
      ctx.beginPath();
      ctx.roundRect(left, top, w, h, 4);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = NEW_COLOR;
      ctx.stroke();
      ctx.fillStyle = NEW_COLOR;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NEW', left + w / 2, top + h / 2 + 0.5);
    }
    if (look.phone) {
      ctx.globalAlpha = 1;
      ctx.font = `12px ${mapFont()}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('📞', x - outer - 13, y - outer - 11);
    }
    ctx.restore();
  },
}) as unknown as new (latlng: L.LatLngExpression, options: L.CircleMarkerOptions & { look: CountLook }) => L.CircleMarker;

/**
 * 숫자 동그라미 하나(size는 테두리까지 지름 px). 색칠한 표시는 흰 테두리와 흰 글자, 본 매물은 흰 바탕에 색 테두리와 색 글자다.
 * 예전 HTML 표시처럼 누름이 지도로 번지지 않게 한다(핀 꽂는 중에 눌러도 핀이 꽂히지 않게).
 */
function countMarker(g: Group, size: number, colors: { fill: string; stroke: string }, look: Omit<CountLook, 'selected'>, opacity = 1): L.CircleMarker {
  const weight = g.strong ? 2 : 1.5;
  const options = {
    renderer: dotRenderer ?? undefined, radius: size / 2 - weight / 2, weight, color: colors.stroke, opacity, fillColor: colors.fill, fillOpacity: opacity,
    bubblingMouseEvents: false, look: { ...look, selected: false },
  };
  return new CountMarker([g.lat, g.lng], options);
}
/** 색칠한 표시와 본 표시(흰 바탕)의 바탕, 테두리, 글자 색 */
const stackColors = (c: string, seen: boolean) => (seen ? { fill: '#fff', stroke: c, text: c } : { fill: c, stroke: '#fff', text: '#fff' });

/** 지금 그리는 지도에 펼친 목록이 있는지(있으면 그 밖의 매물은 회색으로 연하게). render가 그리기 전에 한 번 정한다. */
let dimNow = false;

/** 묶음 하나를 지도에 그리고, 누르면 정보 창을 띄우게 한다. 가격 표시는 HTML, 점과 숫자 동그라미는 캔버스로 그린다. */
function drawGroup(layer: L.LayerGroup, g: Group): Drawn {
  const dim = dimNow;
  const muted = dim && !g.strong;
  const n = g.sum.n;
  const c = muted ? MUTED : groupColor(g.sum);
  // 대시보드에서 다 본 자리는 흰 바탕에 색 테두리로 그려, 아직 안 본 자리(색을 칠한 표시)와 구분한다.
  const seen = groupSeen(g.sum);
  // 모두 별로인 자리는 가격(멀리서 보면 동그라미) 앞에 ✕를 붙이고 다른 표시 밑에 그린다.
  const meh = g.sum.nonMeh === 0;
  // '📞 문의함' 매물이 있는 자리는 가격 앞(멀리서 보면 왼쪽 위)에 📞를 붙이고 다른 표시 위에 그린다.
  const called = hasContacted(g.sum);
  // 펼친 가격대 밖 매물(회색)도 필터를 통과한 매물이라, 확대하면 가격을 같이 쓴다(PRICE_ZOOM.normal부터, 펼친 매물은 strong부터).
  const priced = g.priced;
  // 신규가 든 표시는 빨갛게 칠하고 다른 표시 위에 그린다. NEW 딱지는 겹쳐서 지도를 가리지 않게 가격을 쓴 표시와
  // PRICE_ZOOM.normal부터의 동그라미에만 붙이고, 연하게 칠한 매물(펼친 목록 밖)에는 붙이지 않는다.
  const fresh = (g.strong || !dim) && hasNew(g.sum);
  const badge = fresh && (priced || drawnPriceLevel >= 2) ? NEW_BADGE : '';
  const zIndexOffset = (g.strong ? 500 : 0) + (fresh ? 300 : 0) + (called ? 200 : 0) - (meh ? 200 : 0);
  let marker: L.Layer;
  let base: Drawn['base'];
  let z: number | undefined = zIndexOffset;
  if (priced) {
    const { text, secondary } = g.sum;
    const amounts = secondary ? `<span class="price-lines" style="--price-column-gap:${PRICE_COLUMN_GAP}px">${rentalPriceRow(text)}${
      secondary.quote.price.deal === 'jeonse' ? `<span class="price-line"><span class="price-jeonse">${esc(secondary.text)}</span></span>` : rentalPriceRow(secondary.text)
    }</span>` : esc(text);
    marker = L.marker([g.lat, g.lng], {
      icon: L.divIcon({
        className: `price${g.strong ? ' strong' : ''}${muted ? ' dim' : ''}${seen ? ' seen' : ''}${meh ? ' meh' : ''}${called ? ' called' : ''}`,
        html:
          `<span class="price-body" style="${boxStyle(muted ? MUTED_PRICE : c, seen)}">${called ? PHONE_MARK : seen ? SEEN_MARK : meh ? MEH_MARK : ''}` +
          amounts +
          `${n > 1 ? `<b>${n}</b>` : ''}${badge}</span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
        tooltipAnchor: [0, -labelHeight(g.sum, g.strong) / 2],
      }),
      keyboard: false,
      zIndexOffset,
    });
  } else if (n === 1 && (badge || called)) {
    // 신규나 문의함 한 건: 딱지를 붙이려고 점 대신 글자 없는 작은 동그라미로 그린다.
    const colors = stackColors(c, seen);
    marker = countMarker(g, g.strong ? 14 : 10, colors, {
      text: '', textColor: colors.text, fontPx: 11, newAt: badge ? [11, 20] : null, phone: called, shadow: seen ? 0.15 : 0.25,
    });
    z = zIndexOffset + 50;
  } else if (n === 1 && meh) {
    // 별로 한 건: 점 대신 회색 바탕에 ✕
    marker = countMarker(g, g.strong ? 14 : 12, { fill: c, stroke: '#fff' }, { text: '✕', textColor: '#fff', fontPx: 8, newAt: null, phone: false, shadow: 0.25 });
    z = zIndexOffset + 50;
  } else if (n === 1) {
    // 펼친 가격대 밖 매물(회색)도 그 일대 시세를 볼 때 쓰므로, 색만 회색으로 두고 크기는 보통 점과 같게 그린다.
    // 본 매물은 속이 흰 동그라미(색 테두리)로 그린다.
    base = { radius: g.strong ? 7 : 5, color: seen ? c : '#fff', weight: seen || g.strong ? 2 : dim ? 1.5 : 1 };
    marker = L.circleMarker([g.lat, g.lng], { ...base, fillColor: seen ? '#fff' : c, fillOpacity: seen ? 1 : g.strong ? 0.95 : 0.8, renderer: dotRenderer ?? undefined });
  } else {
    // 같은 자리 여러 건: 숫자 동그라미(모두 별로면 ✕). 펼친 목록 밖이면 작고 연하게 그린다.
    const colors = stackColors(c, seen);
    const faint = dim && !g.strong;
    marker = countMarker(
      g, g.strong ? 26 : faint ? 18 : 20, colors,
      {
        text: meh ? '✕' : String(n), textColor: colors.text, fontPx: meh || faint ? 10 : g.strong ? 13 : 11,
        newAt: badge ? [9, 14] : null, phone: called, shadow: seen ? 0.15 : 0.25,
      },
      faint ? 0.9 : 1,
    );
    z = zIndexOffset + 50;
  }
  // 올리면 보이는 글은 올릴 때 만든다(표시를 수백 개씩 새로 그릴 때 글까지 미리 만들면 느려서).
  (marker as L.Marker).bindTooltip(() => tooltip(g), { direction: 'top' });
  // 누르면 바로 넘어가지 않고 정보 창을 먼저 띄우고, 창에 보인 매물(POPUP_MAX건까지)을 '봤음'으로 남긴다.
  marker.on('click', () => {
    const items = withSelectedFirst(withMapPricesFirst(g));
    popup(g, items);
    markSeen(items.slice(0, POPUP_MAX));
    if (props.listMode) emit('reveal', items);
  });
  marker.addTo(layer);
  return { marker, group: g, base, z };
}

function rentalPriceRow(amount: string) {
  const [deposit, rent] = amount.split('/');
  return `<span class="price-line"><span>${esc(deposit)}</span><span>/</span><span>${esc(rent)}</span></span>`;
}

/** 가격 표시와 캔버스 점 위에 새 매물 강조를 묶음당 하나씩 올린다. */
function drawLiveListings() {
  if (!map || !liveLayer) return;
  if (!props.liveListingIds?.size && !liveMarkers.size) return;
  const bounds = map.getBounds();
  const groups = new Set<Group>();
  const keep = new Set<string>();
  let visible = 0;
  for (const id of props.liveListingIds ?? []) {
    const group = groupOf.get(id);
    if (!group) continue;
    const drawnGroup = drawn.get(group.key);
    if (!drawnGroup) continue;
    if (bounds.contains([group.lat, group.lng])) visible += 1;
    if (groups.has(group)) continue;
    groups.add(group);
    keep.add(id);

    let marker = liveMarkers.get(id);
    if (!marker) {
      marker = L.marker([group.lat, group.lng], {
        pane: 'live-listings', keyboard: false, interactive: false,
        icon: L.divIcon({
          className: 'live-listing', html: '<span class="live-ring"><span class="live-badge">새 수집</span></span>',
          iconSize: [0, 0], iconAnchor: [0, 0],
        }),
      }).addTo(liveLayer);
      liveMarkers.set(id, marker);
      marker.getElement()?.setAttribute('aria-hidden', 'true');
    } else if (!marker.getLatLng().equals([group.lat, group.lng])) {
      marker.setLatLng([group.lat, group.lng]);
    }
    const price = drawnGroup.marker instanceof L.Marker ? drawnGroup.marker.getElement()?.firstElementChild : null;
    const ring = marker.getElement()?.firstElementChild as HTMLElement | null;
    if (ring) {
      ring.style.width = `${price ? price.clientWidth + 12 : 34}px`;
      ring.style.height = `${price ? price.clientHeight + 12 : 34}px`;
    }
  }
  for (const [id, marker] of liveMarkers) {
    if (keep.has(id)) continue;
    liveLayer.removeLayer(marker);
    liveMarkers.delete(id);
  }
  visibleLiveCount.value = visible;
}

/**
 * 매물 표시를 그린다. 화면 근처(사방으로 화면 크기의 30%)에 있는 묶음만 그리고, 이미 그린 같은 묶음은 그대로 둔다.
 * full이면 매물이 바뀐 것이라 처음부터 다시 그린다. 확대가 바뀌면 가격 표시를 다시 묶는다.
 */
function render(full: boolean) {
  if (!map || !dots) return;
  const level = priceLevel();
  const zoom = map.getZoom();
  const fresh = full || level !== drawnPriceLevel;
  if (full) spotCache = null;
  if (fresh) {
    dots.clearLayers();
    drawn.clear();
    selected = null;
  }
  drawnPriceLevel = level;
  dimNow = props.listings.length > 0;
  // 동그라미만 그리는 단계는 같은 자리끼리만 묶어 확대와 상관없으므로 다시 나누지 않는다.
  if (full || !shown || shown.level !== level || (level > 0 && shown.zoom !== zoom)) {
    shown = { zoom, level, groups: computeGroups(level, zoom) };
    groupOf.clear();
    for (const g of shown.groups) for (const part of g.parts) for (const l of part) groupOf.set(l.id, g);
  }
  const view = map.getBounds().pad(0.3);
  const keep = new Set<string>();
  let added = false;
  for (const g of shown.groups) {
    if (!view.contains([g.lat, g.lng])) continue;
    keep.add(g.key);
    if (drawn.has(g.key)) continue;
    const d = drawGroup(dots, g);
    drawn.set(g.key, d);
    if (d.marker instanceof L.CircleMarker) added = true;
  }
  for (const [key, d] of drawn) {
    if (keep.has(key)) continue;
    if (selected === d) selected = null;
    dots.removeLayer(d.marker);
    drawn.delete(key);
  }
  if (added) orderCanvas();
  buildHitGrid();
  highlight(false);
  drawLiveListings();
}

/**
 * 캔버스 표시를 쌓는 순서대로 다시 늘어놓는다(나중에 그린 것이 위). 진한 표시(펼친 목록), 신규, 문의함이 위로, 별로는 아래로 가고,
 * 같은 단계에서는 숫자 동그라미가 점 위에 온다. 지도를 옮기다 새로 그린 표시가 맨 위에 붙으므로 그릴 때마다 맞춘다.
 */
function orderCanvas() {
  const list = [...drawn.values()].filter((d) => d.marker instanceof L.CircleMarker);
  list.sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  for (const d of list) (d.marker as L.CircleMarker).bringToFront();
}

/** 마우스가 캔버스 표시 위인지 빨리 알아보려고, 그린 캔버스 표시를 지도 좌표 32px 칸으로 나눠 둔다(그릴 때마다 다시 만든다). */
const HIT_CELL = 32;
let hitGrid = new Map<string, L.CircleMarker[]>();
function buildHitGrid() {
  hitGrid = new Map();
  for (const d of drawn.values()) {
    if (!(d.marker instanceof L.CircleMarker)) continue;
    const p = (d.marker as unknown as CanvasPath)._point;
    if (!p) continue;
    const key = `${Math.floor(p.x / HIT_CELL)},${Math.floor(p.y / HIT_CELL)}`;
    const cell = hitGrid.get(key);
    if (cell) cell.push(d.marker);
    else hitGrid.set(key, [d.marker]);
  }
}
/** 지도 좌표 p에 캔버스 표시가 있는지(표시 반지름은 칸보다 작아서 둘레 아홉 칸만 본다) */
function canvasMarkerAt(p: L.Point) {
  const gx = Math.floor(p.x / HIT_CELL);
  const gy = Math.floor(p.y / HIT_CELL);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const m of hitGrid.get(`${gx + dx},${gy + dy}`) ?? []) if ((m as unknown as CanvasPath)._containsPoint(p)) return true;
    }
  }
  return false;
}
/**
 * 캔버스는 지도 전체를 덮어서 그냥 두면 아래의 역(누르면 알림 켜고 끔)과 정비구역(올리면 이름)이 마우스를 못 받는다.
 * 그래서 캔버스 칸은 평소 마우스를 흘려보내고, 마우스가 캔버스 표시 위에 올라가면 그때만 받아 Leaflet이 누름과 글을 처리하게 한다.
 */
function onMapPointer(e: MouseEvent) {
  if (!map || !dotCanvas) return;
  const dragging = (map.dragging as unknown as { moving?: () => boolean }).moving?.() ?? false;
  const want = !dragging && canvasMarkerAt(map.mouseEventToLayerPoint(e)) ? 'auto' : '';
  if (dotCanvas.style.pointerEvents !== want) dotCanvas.style.pointerEvents = want;
}
function onMapLeave() {
  if (dotCanvas) dotCanvas.style.pointerEvents = '';
}

/** 매물이 바뀌면 처음부터 다시 그린다. fit: 매물에 맞춰 지도를 다시 맞춘다(처음, fitKey가 바뀔 때). */
function drawDots(fit: boolean) {
  render(true);
  if (fit) fitTo(focusPoints());
}

/** 지도를 맞출 곳: 펼친 목록이 있으면 그 매물, 없으면 보이는 매물 전체. */
function focusPoints() {
  const list = props.listings.length ? props.listings : props.background;
  return list.filter((l) => l.lat != null && l.lng != null).map((l) => L.latLng(l.lat!, l.lng!));
}

/** 고른 매물이 든 표시를 강조하고, 지도 밖이면 그쪽으로 옮긴다(옮기면 그 근처를 그리면서 다시 강조한다). */
function highlight(pan: boolean) {
  if (selected) setSelected(selected, false);
  selected = null;
  const g = props.selectedId ? groupOf.get(props.selectedId) : undefined;
  if (!g || !map) return;
  const d = drawn.get(g.key);
  if (d) {
    selected = d;
    setSelected(d, true);
  }
  const at = L.latLng(g.lat, g.lng);
  if (pan && !props.visible) {
    panPending = true;
    return;
  }
  if (pan && !map.getBounds().pad(-0.15).contains(at)) map.panTo(at);
}

/** 숨김 중 생긴 맞추기 요청만 처리한다. 단순히 다시 열 때는 보던 위치와 확대를 유지한다. */
function syncVisibleSize() {
  if (!map || !props.visible || !el.value?.clientWidth || !el.value.clientHeight) return;
  const size = map.getSize();
  if (size.x !== el.value.clientWidth || size.y !== el.value.clientHeight) {
    // 칸 크기만 바뀐 것이라(처음 열 때 높이가 정해지는 등) 그 때문에 생긴 이동은 기억하지 않는다(열 때마다 1px씩 밀려 쌓이지 않게).
    quietMove = true;
    map.invalidateSize();
    quietMove = false;
  }
  if (fitPending) fitTo(focusPoints());
  if (panPending) {
    panPending = false;
    highlight(true);
  }
}

function setSelected(s: Drawn, on: boolean) {
  if (s.marker instanceof L.CircleMarker) {
    const look = (s.marker as unknown as CanvasPath).options.look;
    if (look) {
      // 숫자 동그라미: 크기는 그대로 두고 바깥에 짙은 테두리(예전 HTML 표시의 outline과 같은 자리)
      look.selected = on;
      s.marker.redraw();
    } else {
      const base = s.base ?? { radius: s.group.strong ? 7 : 5, color: '#fff', weight: s.group.strong ? 2 : 1 };
      s.marker.setStyle(on ? { color: '#16202e', weight: 3 } : { color: base.color, weight: base.weight });
      s.marker.setRadius(on ? 9 : base.radius);
    }
    if (on) s.marker.bringToFront();
  } else {
    (s.marker as L.Marker).getElement()?.classList.toggle('sel', on);
    (s.marker as L.Marker).setZIndexOffset(on ? 1000 : (s.z ?? 0));
  }
}

/** 지도를 옮기거나 확대를 바꾸면 화면 근처 표시만 다시 맞춘다(보던 확대와 위치는 그대로). */
function onView() {
  render(false);
}

function onKey(e: KeyboardEvent) {
  // 설명 모달이 떠 있으면 Esc는 모달만 닫는다.
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (pinMove) pinMove.popup.remove();
  else if (pinning.value) pinning.value = null;
  else if (big.value) big.value = false;
}

onMounted(() => {
  if (!el.value) return;
  // 휠 한 칸 = 확대 0.25단계(약 1.2배). 버튼은 0.5단계. 처음 위치(서울시청)는 매물도 지역도 없을 때만 보인다.
  // 이 탭에서 마지막으로 본 자리를 기억해 두었으면 그 자리로 연다(viewKey).
  const savedView = readView();
  map = L.map(el.value, { zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 180 })
    .setView(savedView ? [savedView.lat, savedView.lng] : [37.5665, 126.978], savedView ? savedView.zoom : 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  // 역은 매물 아래 층에 그린다(겹쳐도 매물이 눌리게).
  // 그리는 층을 먼저 지도에 붙여 둔다. 그래야 지도를 옮길 때 그 층이 새 화면 범위를 먼저 잡고, 그다음 역을 다시 그린다
  // (순서가 바뀌면 새로 보이는 역을 화면 밖으로 보고 그리지 않는다).
  map.createPane('stations').style.zIndex = '390';
  stationRenderer = L.svg({ pane: 'stations', padding: 0.3 }).addTo(map);
  // 정비사업 구역은 역보다도 아래 층에 그린다(구역 수가 많아 canvas로).
  map.createPane('zones').style.zIndex = '350';
  zoneRenderer = L.canvas({ pane: 'zones', padding: 0.3 }).addTo(map);
  // 점과 숫자 동그라미는 구 경계(400)보다 위, 가격 표시(600)보다 아래의 캔버스에 그린다.
  // 이 칸은 마우스를 흘려보내고, 마우스가 표시 위에 있을 때만 캔버스가 받는다(onMapPointer).
  const dotsPane = map.createPane('dots');
  dotsPane.style.zIndex = '450';
  dotsPane.style.pointerEvents = 'none';
  dotRenderer = L.canvas({ pane: 'dots', padding: 0.3 }).addTo(map);
  dotCanvas = (dotRenderer as unknown as { _container: HTMLCanvasElement })._container;
  el.value.addEventListener('mousemove', onMapPointer, { passive: true });
  el.value.addEventListener('mouseleave', onMapLeave);
  el.value.addEventListener('mousemove', onDistrictHover, { passive: true });
  el.value.addEventListener('mouseleave', clearDistrictHover);
  // 핀은 지역 이름표(툴팁 층 650)보다 위, 정보 창(700)보다 아래에 그린다(역 자리에 꽂아도 이름표에 가리지 않게).
  map.createPane('walkpins').style.zIndex = '660';
  stationLayer = L.layerGroup().addTo(map);
  base = L.layerGroup().addTo(map);
  dots = L.layerGroup().addTo(map);
  const livePane = map.createPane('live-listings');
  livePane.style.zIndex = '620';
  livePane.style.pointerEvents = 'none';
  liveLayer = L.layerGroup().addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  map.on('moveend', drawStations);
  map.on('moveend', onView);
  void loadCatalog()
    .then((list) => {
      stations.value = list;
      drawBase();
      drawStations();
    })
    .catch(() => {
      /* 역 목록을 못 받으면 역만 안 보인다 */
    });
  map.on('click', (e: L.LeafletMouseEvent) => {
    if (!pinning.value) return;
    addWalkPin(round6(e.latlng.lat), round6(e.latlng.lng), pinning.value);
    pinning.value = null;
  });
  drawBase();
  drawPins();
  if (zonesOn.value) void loadZones();
  drawZones();
  fittedKey = props.fitKey;
  if (savedView) drawDots(false);
  else {
    // 기억한 자리가 없으면 매물에 맞춘다. 대시보드를 막 켜서 매물이 아직 없으면 우선 지역에 맞추고, 매물이 들어올 때 한 번 더 맞춘다.
    firstFitPending = focusPoints().length === 0;
    drawDots(true);
  }
  // 사용자가 지도를 누르거나 휠을 굴리면 매물이 들어올 때 다시 맞추지 않는다(보던 자리를 그대로 둔다).
  el.value.addEventListener('mousedown', cancelFirstFit, { passive: true });
  el.value.addEventListener('wheel', cancelFirstFit, { passive: true });
  map.on('moveend', saveView);
  // 칸 크기가 바뀌면(창 크기, 크게 보기) 지도를 다시 맞춘다.
  resize = new ResizeObserver(syncVisibleSize);
  resize.observe(el.value);
  window.addEventListener('keydown', onKey);
});

function cancelFirstFit() {
  firstFitPending = false;
}

// 매물이 바뀌면 다시 그린다. fitKey가 바뀌었을 때만 매물에 맞추고, 아니면 보던 확대와 위치를 그대로 둔다. 고른 매물이 바뀌면 그 표시를 강조한다.
/** 마지막으로 지도를 맞춘 fitKey */
let fittedKey: string | null = null;
watch(
  () => [props.listings, props.background, props.fitKey, props.rentalOptions] as const,
  () => {
    let fit = props.fitKey !== fittedKey;
    fittedKey = props.fitKey;
    // 열 때 매물이 없어 지역에 맞춰 둔 지도는 매물이 처음 들어올 때 한 번 매물에 맞춘다.
    if (firstFitPending && focusPoints().length) {
      firstFitPending = false;
      fit = true;
    }
    drawDots(fit);
  },
);
// 환산 월세 전환율이 바뀌면(매물이나 기준금리가 바뀌어 카드 값이 바뀔 때) 대표 가격과 묶음 안 순서를 다시 낸다.
watch(currentRate, () => drawDots(false));
watch(() => props.liveListingIds, drawLiveListings);
watch(
  () => props.areas,
  () => {
    drawBase();
    drawStations();
  },
);
watch(
  () => props.selectedId,
  (id) => {
    highlight(props.panToSelected);
    if (props.viewKey === 'overview' && listingPopup) highlightPopupCard(id);
  },
);
watch([zones, zonesOn], drawZones);
watch(walkPins, drawPins, { deep: true });
// 조회나 확장으로 새 매물이 들어오면 그 매물까지 걷는 거리도 다시 묻는다.
watch(
  () => props.background,
  (list) => ensureWalk(list.map((l) => l.id)),
  { immediate: true },
);
watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      map?.stop();
      return;
    }
    await nextTick();
    syncVisibleSize();
  },
);
// 크게 보기를 켜고 끌 때 지도 크기를 다시 재고, 매물이 크게 보이게 다시 맞춘다.
watch(big, async () => {
  await nextTick();
  if (props.visible) map?.invalidateSize();
  fitTo(focusPoints());
  highlight(false);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  pinMove?.popup.remove();
  el.value?.removeEventListener('mousemove', onMapPointer);
  el.value?.removeEventListener('mouseleave', onMapLeave);
  el.value?.removeEventListener('mousemove', onDistrictHover);
  el.value?.removeEventListener('mouseleave', clearDistrictHover);
  el.value?.removeEventListener('mousedown', cancelFirstFit);
  el.value?.removeEventListener('wheel', cancelFirstFit);
  resize?.disconnect();
  if (map) {
    // 확대 애니메이션 중에 지우면 Leaflet이 250ms 뒤 이미 지운 칸을 읽다가 오류를 내서, 애니메이션 표시를 끄고 지운다.
    (map as unknown as { _animatingZoom: boolean })._animatingZoom = false;
    map.remove();
  }
  // 늦게 끝난 역 목록 받기 등이 지운 지도에 그리지 않게 한다.
  map = null;
  base = dots = stationLayer = zoneLayer = pinLayer = liveLayer = null;
  dotRenderer = null;
  dotCanvas = null;
  hoverDistricts = [];
  hoveredDistrict = null;
  shown = null;
  spotCache = null;
  drawn.clear();
  liveMarkers.clear();
  groupOf.clear();
  hitGrid.clear();
  selected = null;
});
</script>

<template>
  <div class="ovmap" :class="{ picking: pinning, big }">
    <div class="map-wrap">
      <div ref="el" class="map" role="region" aria-label="매물 위치 지도"></div>
      <div class="map-tools">
        <button class="btn btn-sm" title="펼친 목록(없으면 보이는 매물 전체)과 켜 둔 구에 지도를 다시 맞춥니다" @click="fitToListings">매물에 맞추기</button>
        <button
          class="btn btn-sm big-btn" :aria-pressed="big"
          :title="`${background.length}건, 위치 ${positions}곳${listings.length ? `, 펼친 목록 ${listings.length}건 진하게` : ''}`"
          @click="big = !big"
        >{{ big ? '작게 보기 (Esc)' : '크게 보기' }}</button>
      </div>
      <p v-if="pinning" class="pick-note">{{ pinning === 'mark' ? '표시 핀' : '거리 핀' }}을 꽂을 곳을 누르세요 (Esc 취소)</p>
    </div>
    <!-- 기본 점 색과 상태는 범례에, 자세한 설명은 '지도 보는 법'에 둔다. -->
    <div class="under">
      <div class="legend" aria-label="점 색">
        <span><i style="background:#e5484d"></i>신규</span>
        <span><i style="background:#12825e"></i>가격 변동</span>
        <span><i style="background:#c48a0a"></i>관심</span>
        <span><i style="background:#1f5fbf"></i>나머지</span>
        <span title="이 대시보드에서 눌러 본 매물"><i class="seen-dot"></i>봤음</span>
        <span v-if="liveListingIds?.size" title="이번에 받은 매물 중 현재 필터와 지도 범위에 맞는 매물만 강조합니다. 새로고침하면 강조가 지워집니다.">
          <i class="live-dot"></i>{{ visibleLiveCount ? `이번에 들어온 매물 ${visibleLiveCount}건 표시 중` : `이번에 들어온 매물 ${liveListingIds.size}건, 현재 지도에는 0건` }}
        </span>
      </div>
      <InfoModal heading="지도 보는 법" label="지도 보는 법" storage-key="hnw-map-info-tab" :tabs="MAP_TABS" title="점 색, 숫자와 가격, 구역과 역, 핀, 정비구역">
        <template #marks>
          <dl class="keys">
            <dt><i class="key-dot" style="background:#e5484d"></i></dt>
            <dd><b>신규</b>: 새로 들어온 매물이 있는 자리입니다. 확대해서 가격이 보이면 오른쪽 위에 <em class="nw-sample">NEW</em> 딱지가 붙습니다.</dd>
            <dt><i class="key-dot" style="background:#12825e"></i></dt>
            <dd><b>가격 변동</b>: 가격이 바뀐 매물이 있는 자리입니다. 표시를 누르면 바뀐 항목의 이전 금액과 현재 금액을 볼 수 있습니다.</dd>
            <dt><i class="key-dot" style="background:#c48a0a"></i></dt>
            <dd><b>관심</b>: 관심 표시한 매물입니다.</dd>
            <dt><i class="key-dot" style="background:#1f5fbf"></i></dt>
            <dd><b>나머지</b>: 그 밖의 매물입니다.</dd>
            <dt><i class="key-dot meh-dot" style="background:#aab2bd">✕</i></dt>
            <dd>
              <b>별로</b>: 별로로 표시한 매물은 회색으로 그리고 앞에 ✕를 붙이며, 다른 표시 밑에 깔립니다.
              같은 자리에 다른 매물이 있으면 그 매물 색을 따릅니다.
            </dd>
            <dt><i class="key-dot" style="background:#8f99a6"></i></dt>
            <dd><b>회색</b>: 매물 탭에서 가격대를 펼치면 펼친 가격대 매물만 색으로 보이고, 필터를 통과한 나머지 매물은 회색으로 보입니다. 확대하면 회색 매물도 가격이 나와 일대 시세를 같이 볼 수 있습니다.</dd>
            <dt><b class="stack-sample">3</b></dt>
            <dd><b>숫자</b>: 같은 자리(같은 건물)에 있는 매물 수입니다.</dd>
            <dt><b class="price-sample">500/40</b></dt>
            <dd>
              <b>가격</b>: 확대 {{ PRICE_ZOOM.normal }}부터(가격대를 펼쳤으면 그 매물은 {{ PRICE_ZOOM.strong }}부터) 동그라미 대신 가격을 씁니다.
              월세는 보증금/월세(만원), 전세는 '전 1.5억'처럼 씁니다.
            </dd>
            <dt><b class="price-sample">500/40<i class="cnt">4</i></b></dt>
            <dd>
              <b>묶음</b>: 가격 표시끼리 겹치면 한 표시로 묶습니다. 가격 옆 숫자는 묶인 매물 수입니다. 더 확대하면 풀립니다.
              월세와 전세가 함께 있으면 윗줄에 최저 월세, 아랫줄에 최저 전세금을 표시합니다. 월세만 있으면 아랫줄에 최저 보증금을 표시하고, 같은 조건이면 한 줄만 표시합니다. 전세만 있으면 최저 전세금 한 줄이 표시됩니다.
              핀을 누르면 고른 매물, 핀에 표시한 매물과 가격이 바뀐 매물을 먼저 볼 수 있습니다.
            </dd>
            <dt><b class="price-sample seen-sample">✓ 500/40</b></dt>
            <dd>
              <b>봤음</b>: 이 대시보드에서 본 매물은 흰 바탕에 색 테두리로 바뀌고 가격 앞에 ✓가 붙습니다. 동그라미는 속이 하얘집니다.
              지도 표시를 누르면 창에 보인 매물을, 카드를 누르거나 원본을 열면 그 매물을 본 것으로 치고, 신규 표시도 꺼집니다.
              본 뒤에 가격이 바뀌면 다시 색으로 칠해집니다.
            </dd>
            <dt><b class="price-sample">📞 500/40</b></dt>
            <dd>
              <b>문의함</b>: 매물 카드에서 '📞 문의함'을 누른 매물은 가격 앞(멀리서 보면 왼쪽 위)에 📞가 붙고 다른 표시 위에 그려집니다.
              다시 누르면 풉니다. 문의한 매물은 사이트에서 내려가도 지우지 않고 남깁니다.
            </dd>
          </dl>
        </template>
        <template #areas>
          <dl class="keys">
            <dt><i class="area-sample" :style="areaSample"></i></dt>
            <dd>
              <b>색칠한 구역</b>: 매물을 모으는 구입니다(지역 탭에서 고른 구). 구마다 색이 다르고 가운데에 구 이름이 붙습니다.
              동을 골랐으면 그 동이 있는 구 경계를 참고로 그립니다(동 경계가 아님).
            </dd>
            <dt><i class="alert-sample"></i></dt>
            <dd><b>초록 점선 원</b>: 매물 알림을 받는 구역(역과 반경)입니다. 어느 역을 몇 km로 정했는지는 지역 탭에서 보고 바꿉니다.</dd>
            <dt><i class="key-station"></i></dt>
            <dd><b>흰 동그라미</b>: 역입니다. 누르면 그 역 알림을 켜고 끕니다.</dd>
          </dl>
          <p class="info-text">구 경계 출처는 지도 오른쪽 아래에 있습니다.</p>
        </template>
        <template #pins>
          <dl class="keys">
            <dt><b class="pin-sample">핀</b></dt>
            <dd>
              <b>거리 핀</b>: 지도 아래 '거리 핀'을 누른 뒤 회사처럼 자주 가는 곳을 누르면 꽂힙니다.
              매물 카드에 그 핀까지 걸어서 몇 분인지 보입니다({{ pinMax('walk') }}개까지).
            </dd>
            <dt><b class="pin-sample mark">핀</b></dt>
            <dd><b>표시 핀</b>: 이름만 붙여 두는 핀입니다. 걷는 시간은 재지 않습니다({{ pinMax('mark') }}개까지).</dd>
          </dl>
          <p class="info-text">핀을 끌어 옮긴 뒤 O를 누르면 새 위치를 저장하고, X를 누르면 원래 자리로 돌아갑니다. 핀을 누르면 이름과 종류를 바꾸거나 뺄 수 있습니다.</p>
        </template>
        <template #zones>
          <dl class="keys">
            <template v-for="g in ZONE_GROUPS" :key="g.id">
              <dt><i class="zone-sample" :style="{ background: `${g.color}33`, borderColor: g.color }"></i></dt>
              <dd><b>{{ g.name }}</b></dd>
            </template>
          </dl>
          <p class="info-text">점선 테두리는 넓은 구역(재정비촉진지구, 모아타운, 존치관리구역)입니다. 지도 아래 '정비구역 칠하기'로 켜고 끕니다.</p>
          <div class="info-tool">
            <div class="info-tool-row">
              <template v-if="zones?.count">
                <span class="info-msg">정비구역 {{ zones.count.toLocaleString('ko-KR') }}곳, 서울시 {{ zones.fileDate?.replace(/-/g, '.') ?? '' }} 기준</span>
                <button type="button" class="btn btn-sm" :disabled="zonesBusy || zonesChecking" @click="checkZonesNow">새 파일 확인</button>
                <button type="button" class="btn btn-sm" :disabled="zonesBusy || zonesChecking" @click="pickZoneFile">파일 바꾸기</button>
              </template>
              <span v-else class="info-msg">아직 넣은 정비구역 파일이 없습니다. '정비구역 칠하기'를 켜면 받는 버튼이 보입니다.</span>
              <span v-if="zonesBusy" class="info-msg">파일 읽는 중…</span>
              <span v-else-if="zonesChecking" class="info-msg">서울시 새 파일 확인 중…(1~2분)</span>
              <span v-if="zonesMessage && !zonesChecking" class="info-msg">{{ zonesMessage }}</span>
              <span v-if="zonesError" class="info-msg err" role="alert">{{ zonesError }}</span>
            </div>
            <p>
              서울 열린데이터광장 '서울시 도시계획사업 현황(서울플랜+) 공간정보'(OA-22712)<template v-if="zones?.fileName">, 파일 {{ zones.fileName }}</template>.
              <template v-if="zones?.count">준공, 입주중, 후보지철회 {{ zones.skipped.done }}곳과 역세권이나 도시개발 같은 다른 사업 {{ zones.skipped.other }}곳은 뺐습니다.</template>
              새 파일은 조회할 때 7일마다 확인합니다<template v-if="zones?.check">(마지막 {{ monthDay(zones.check.at) }}: {{ zones.check.text }})</template>.
            </p>
          </div>
        </template>
      </InfoModal>
      <div class="bar">
      <button
        class="btn btn-sm" :class="{ on: pinning === 'walk' }" :disabled="pinning !== 'walk' && pinCount('walk') >= pinMax('walk')"
        :title="pinCount('walk') >= pinMax('walk')
          ? `거리 핀은 ${pinMax('walk')}개까지 꽂습니다. 핀을 누르면 빼거나 표시 핀으로 바꿀 수 있습니다`
          : '누른 뒤 지도에서 회사처럼 자주 가는 곳을 누르면 핀이 꽂히고, 매물 카드에 핀까지 걸어서 몇 분인지 보입니다'"
        @click="pinning = pinning === 'walk' ? null : 'walk'"
      >
        {{ pinning === 'walk' ? '취소' : '거리 핀' }}
      </button>
      <button
        class="btn btn-sm" :class="{ on: pinning === 'mark' }" :disabled="pinning !== 'mark' && pinCount('mark') >= pinMax('mark')"
        :title="pinCount('mark') >= pinMax('mark')
          ? `표시 핀은 ${pinMax('mark')}개까지 꽂습니다`
          : '누른 뒤 지도에서 누른 자리에 이름 붙은 핀을 꽂습니다(걷는 시간은 재지 않음)'"
        @click="pinning = pinning === 'mark' ? null : 'mark'"
      >
        {{ pinning === 'mark' ? '취소' : '표시 핀' }}
      </button>
      <span
        v-if="walkState.loading" class="zone-note"
        title="오픈스트리트맵 길 데이터를 처음 받거나 받은 지 30일이 지났으면 30초쯤 걸립니다"
      >걷는 시간 재는 중…</span>
      <span v-else-if="walkState.error" class="zone-note err" role="alert">{{ walkState.error }}</span>
      <span v-else-if="walkState.missing.length" class="zone-note err">
        {{ walkPins.filter((p) => walkState.missing.includes(p.id)).map((p) => p.name).join(', ') }} 근처에 길이 없어 못 잼
      </span>
      <label class="zone-toggle" title="재개발과 재건축, 모아타운, 재정비촉진, 공공주택 복합사업 구역을 칠합니다(서울시 서울플랜+ 파일을 넣어야 보임)">
        <input v-model="zonesOn" type="checkbox"> 정비구역 칠하기
      </label>
      <template v-if="zonesOn">
        <span v-if="zonesBusy" class="zone-note">파일 읽는 중…</span>
        <span v-else-if="zonesChecking" class="zone-note">서울시 새 파일 확인 중…(1~2분)</span>
        <template v-else-if="zones && !zones.count">
          <button class="btn btn-sm" title="서울 열린데이터광장의 최신 서울플랜+ 파일을 받아 넣습니다(조회할 때도 7일마다 알아서 확인)" @click="checkZonesNow">서울시 파일 자동으로 받기</button>
          <span class="zone-note">
            안 되면 <a :href="ZONE_SOURCE_URL" target="_blank" rel="noopener" title="서울 열린데이터광장 '서울시 도시계획사업 현황(서울플랜+) 공간정보'(OA-22712)에서 ZIP을 받습니다">직접 받아 ↗</a>
          </span>
          <button type="button" class="zone-change" @click="pickZoneFile">ZIP 넣기</button>
        </template>
        <span v-if="zonesMessage && !zonesChecking" class="zone-note">{{ zonesMessage }}</span>
        <span v-if="zonesError" class="zone-note err" role="alert">{{ zonesError }}</span>
      </template>
      <input ref="fileEl" type="file" accept=".zip,application/zip" hidden @change="onZoneFile">
      </div>
    </div>
  </div>
</template>

<style scoped>
.ovmap { display: grid; grid-template-rows: 1fr auto; gap: 8px; height: 100%; background: var(--paper); }
.ovmap.big {
  position: fixed; inset: 12px; z-index: 60; height: auto; padding: 12px;
  background: var(--surface); border: 1px solid var(--line-strong); border-radius: 14px; box-shadow: 0 12px 40px rgba(22, 32, 46, .3);
}
/* 지도 칸: 오른쪽 위 구석에 크게 보기 버튼, 위치 찍는 중이면 위 가운데에 안내(지도 조작은 막지 않음). 지도 컨트롤(z-index 1000) 위에 둔다. */
/* isolation: 지도 안의 z-index(지도 칸 400, 컨트롤 1000)가 위쪽 머리말 메뉴(조회하기 ▾ 등)를 덮지 않게 지도 안에 가둔다. */
.map-wrap { position: relative; display: grid; min-height: 280px; isolation: isolate; }
.map { min-height: 280px; border: 1px solid var(--line-strong); border-radius: 12px; }
/* 지도 오른쪽 위 단추 줄: 매물에 맞추기, 크게 보기 */
.map-tools { position: absolute; top: 10px; right: 10px; z-index: 1001; display: flex; gap: 6px; }
.map-tools .btn { box-shadow: 0 1px 4px rgba(22, 32, 46, .18); }
.pick-note {
  position: absolute; top: 10px; left: 50%; z-index: 1001; transform: translateX(-50%); margin: 0; padding: 6px 12px; pointer-events: none;
  border-radius: 8px; background: var(--ink); color: #fff; font-size: 13px; font-weight: 600; white-space: nowrap;
}
.picking .map { cursor: crosshair; outline: 3px solid var(--accent); outline-offset: 2px; }
/* 지도 아래 한 줄: 점 색, '지도 보는 법', 오른쪽에 핀과 정비구역 버튼(좁으면 다음 줄로) */
.under { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.under .bar { margin-left: auto; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 13px; color: var(--ink-2); align-items: center; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
/* '지도 보는 법' 모달: 왼쪽 견본, 오른쪽 설명 */
.keys { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 14px; align-items: start; margin: 0 0 18px; }
.keys dt { display: flex; justify-content: center; padding-top: 3px; }
.keys dd { margin: 0; font-size: 15px; line-height: 1.65; color: var(--ink-2); }
.keys dd b { color: var(--ink); }
.key-dot { display: inline-block; width: 13px; height: 13px; margin-top: 3px; border-radius: 50%; }
.key-station { display: inline-block; width: 13px; height: 13px; margin-top: 3px; border: 2px solid #16202e; border-radius: 50%; background: #fff; box-sizing: border-box; }
.area-sample { display: inline-block; width: 34px; height: 22px; border: 2.5px solid; border-radius: 4px; box-sizing: border-box; }
.alert-sample { display: inline-block; width: 26px; height: 26px; border: 2.5px dashed #087f5b; border-radius: 50%; background: rgba(8, 127, 91, .05); box-sizing: border-box; }
.keys .zone-sample { display: inline-block; width: 26px; height: 18px; margin-top: 3px; border: 1.5px solid; border-radius: 3px; box-sizing: border-box; }
.stack-sample {
  display: inline-grid; place-items: center; width: 18px; height: 18px; margin-right: 4px; border-radius: 50%;
  background: #1f5fbf; color: #fff; font-size: 11px; border: 1.5px solid #fff; box-shadow: 0 0 0 1px #1f5fbf;
}
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.bar .on { border-color: var(--accent); color: var(--accent); }
.zone-toggle { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; margin-left: 4px; font-size: 13px; font-weight: 600; color: var(--ink-2); cursor: pointer; }
.zone-toggle input { width: 15px; height: 15px; margin: 0; accent-color: #2f9e44; }
.zone-note { font-size: 12.5px; color: var(--muted); }
.zone-note a { color: var(--ink-2); font-weight: 600; }
.zone-note.err { color: var(--new); font-weight: 600; }
.zone-change {
  padding: 0; border: 0; background: none; font: inherit; font-size: 12.5px; color: var(--muted); cursor: pointer;
  text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px;
}
.zone-change:hover { color: var(--ink); }
:deep(.area-label) { font-weight: 700; }
:deep(.pick-pin span), .legend .pick-sample {
  display: block; width: 11px; height: 11px; margin: 2px; background: #16202e; border: 2px solid #fff;
  box-shadow: 0 0 0 1px #16202e; border-radius: 1px; transform: rotate(45deg);
}
.legend .pick-sample { display: inline-block; width: 9px; height: 9px; margin: 0 6px 0 2px; vertical-align: 0; }
/* 핀: 크기 0인 표시 칸 위에 이름 상자를 세우고, 아래 꼭지 끝이 핀 자리 */
:deep(.walk-pin span), .pin-sample {
  display: inline-block; padding: 2px 8px; border-radius: 8px; white-space: nowrap;
  background: #6741d9; color: #fff; font: 700 12px/1.4 var(--font); border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .4);
}
:deep(.walk-pin span) { position: absolute; left: 0; bottom: 9px; transform: translateX(-50%); cursor: grab; }
:deep(.walk-pin span)::after {
  content: ''; position: absolute; left: 50%; top: 100%; margin-left: -6px;
  border: 6px solid transparent; border-top-color: #6741d9; border-bottom: 0;
}
/* 표시 핀은 주황 */
:deep(.walk-pin.mark span), .pin-sample.mark { background: #d9480f; }
:deep(.walk-pin.mark span)::after { border-top-color: #d9480f; }
.pin-sample { margin-right: 4px; padding: 0 6px; border-width: 1.5px; font-size: 11px; }
:deep(.pin-pop) { flex-wrap: nowrap; }
:deep(.pin-move-popup .leaflet-popup-content) { margin: 5px 6px; }
:deep(.pin-move-actions) { display: flex; gap: 5px; }
:deep(.pin-move-actions[hidden]) { display: none; }
:deep(.pin-move-actions button) { min-width: 33px; min-height: 30px; }
:deep(.pin-pop input) {
  width: 9em; min-height: 32px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 8px; font: 600 13px var(--font);
}
/* 점과 같은 자리 숫자 동그라미는 캔버스에 그린다(CountMarker). 모양은 그 코드에 있다. */
/* 가격 표시: 크기 0인 표시 칸의 가운데에 글자 상자를 놓는다(글자 길이만큼 넓어짐) */
:deep(.price > .price-body), .price-sample {
  display: inline-flex; align-items: center; gap: 3px; padding: 1px 5px; border-radius: 9px; white-space: nowrap;
  color: #fff; font: 700 11px/1.4 var(--font); border: 1.5px solid #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .35);
}
:deep(.price > .price-body) { position: absolute; left: 0; top: 0; transform: translate(-50%, -50%); cursor: pointer; }
:deep(.price-lines) {
  display: grid; grid-template-columns: max-content max-content max-content; column-gap: var(--price-column-gap);
  justify-items: end; line-height: 1.4; font-variant-numeric: tabular-nums;
}
:deep(.price-line) { display: contents; }
:deep(.price-line + .price-line > span) { justify-self: stretch; text-align: right; box-shadow: inset 0 1px rgba(255, 255, 255, .45); }
:deep(.price-jeonse) { grid-column: 1 / -1; }
:deep(.price.seen .price-line + .price-line > span) { box-shadow: inset 0 1px rgba(22, 32, 46, .22); }
:deep(.live-ring) {
  position: absolute; display: block; left: 0; top: 0; border: 3px solid #ffde59;
  border-radius: 32px; box-shadow: 0 0 0 2px #16202e; pointer-events: none;
  transform: translate(-50%, -50%);
}
:deep(.live-ring::after) {
  content: ''; position: absolute; inset: -5px; border: 3px solid #ffde59; border-radius: inherit;
  animation: live-listing-ring 1.8s ease-out infinite;
}
:deep(.live-badge) {
  position: absolute; top: 100%; right: -4px; z-index: 1; padding: 0 4px; border: 1px solid #16202e;
  border-radius: 5px; background: #ffde59; color: #16202e; white-space: nowrap;
  font: 800 10px/1.35 var(--font);
}
@keyframes live-listing-ring {
  from { opacity: .95; transform: scale(1); }
  to { opacity: 0; transform: scale(1.32); }
}
@media (prefers-reduced-motion: reduce) {
  :deep(.live-ring::after) { display: none; }
}
:deep(.price-body > b) {
  display: inline-grid; place-items: center; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px;
  background: #fff; color: #16202e; font-size: 10px; line-height: 1;
}
:deep(.price.strong > .price-body) { padding: 2px 6px; font-size: 12px; border-width: 2px; }
:deep(.price.sel > .price-body) { outline: 3px solid #16202e; outline-offset: 1px; }
.price-sample { margin-right: 4px; background: #1f5fbf; box-shadow: 0 0 0 1px #1f5fbf; }
/* '지도 보는 법'의 묶음 견본: 가격 옆 건수 동그라미 */
.price-sample .cnt {
  display: inline-grid; place-items: center; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px;
  background: #fff; color: #16202e; font: normal 700 10px/1 var(--font);
}
/* 대시보드에서 본 매물: 흰 바탕에 색 테두리와 글자(색은 표시마다 style로 준다), 가격 앞에 ✓ */
:deep(.price.seen > .price-body) { box-shadow: 0 1px 2px rgba(0, 0, 0, .25); }
:deep(.price.seen .price-body > b) { background: #e9edf2; }
:deep(.price .ck) { font-style: normal; }
.price-sample.seen-sample { background: #fff; color: #1f5fbf; border-color: #1f5fbf; box-shadow: none; }
.legend i.seen-dot { background: #fff; box-shadow: inset 0 0 0 2px #1f5fbf; }
.legend i.live-dot { border: 2px solid #16202e; background: #ffde59; }
.key-dot.meh-dot { display: inline-grid; place-items: center; color: #fff; font: normal 700 9px/1 var(--font); }
:deep(.tip-site) { color: var(--muted); }
/* 신규 딱지: 표시 오른쪽 위 모서리에 걸친다. 누르면 아래 표시가 눌리게 한다. */
:deep(.nw), .nw-sample {
  padding: 0 3px; border-radius: 4px; border: 1px solid #e5484d; background: #fff;
  color: #e5484d; font: italic 800 9px/1.25 var(--font); letter-spacing: .02em; white-space: nowrap;
}
:deep(.nw) { position: absolute; top: -9px; right: -14px; box-shadow: 0 1px 2px rgba(0, 0, 0, .3); pointer-events: none; }
.nw-sample { display: inline-block; margin-left: 4px; vertical-align: 1px; }
:deep(.st-tip) { color: var(--muted); font-size: 12px; }
/* 여러 건이면 창 안을 스크롤한다(높이 400px까지). */
:deep(.mp) { display: grid; gap: 8px; max-height: 400px; overflow: auto; font: 13px/1.45 var(--font); }
/* 건수 머리글: 아래에 구분선을 긋고, 창 안을 스크롤해도 맨 위에 남는다(흰 바탕으로 밑의 내용을 가림). */
:deep(.mp-head) { position: sticky; top: 0; z-index: 1; padding-bottom: 8px; border-bottom: 1px solid var(--line); background: #fff; font-weight: 700; }
/* 매물 하나 = 카드 하나: 위에 가격(가장 크게)과 평수, 아래 단추 줄 */
:deep(.mp-card) { display: grid; gap: 8px; padding: 9px 10px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); }
/* 옆에 목록이 있으면 카드를 누르면 목록에서 그 매물을 고른다. */
/* 사진이 있으면 왼쪽에 사진, 오른쪽에 가격 줄과 단추 줄. */
:deep(.mp-card.has-thumb) { grid-template-columns: 88px auto; grid-template-areas: 'thumb top' 'thumb actions'; column-gap: 10px; }
:deep(.mp-card.has-thumb .mp-thumb) { grid-area: thumb; }
:deep(.mp-card.has-thumb .mp-top) { grid-area: top; }
:deep(.mp-card.has-thumb .mp-actions) { grid-area: actions; }
:deep(.mp-thumb) {
  width: 88px; height: 66px; align-self: center; overflow: hidden; border-radius: 6px;
  background: #dfe5ea; display: grid; place-items: center; color: var(--muted); font-size: 11px;
}
:deep(.mp-thumb img) { width: 100%; height: 100%; object-fit: cover; display: block; }
:deep(.mp-card.go) { cursor: pointer; }
:deep(.mp-card.go:hover) { border-color: var(--line-strong); background: #e7ebee; }
:deep(.mp-card.mp-selected), :deep(.mp-card.mp-selected:hover) {
  border-color: #305b98; background: #e8eff9; box-shadow: inset 3px 0 #305b98;
}
/* 가격 줄: 왼쪽에 가격, 오른쪽 끝에 평수 상자(줄바꿈하지 않아 창 폭이 이 줄보다 좁아지지 않는다). */
:deep(.mp-top) { display: flex; flex-wrap: nowrap; align-items: center; gap: 12px; white-space: nowrap; }
:deep(.mp-top strong) { font-size: 15px; font-weight: 800; color: var(--ink); }
:deep(.mp-price-change) { display: grid; gap: 2px; margin-top: 2px; color: var(--ink-2); font-size: 12px; font-weight: 600; white-space: normal; }
:deep(.mp-area) {
  align-self: flex-start; margin-left: auto; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 6px;
  background: #fff; color: var(--ink-2); font-size: 12px; font-weight: 700; line-height: 20px;
}
/* 단추 줄은 줄바꿈하지 않는다(Leaflet이 이 줄 폭에 맞춰 창 폭을 정한다. 단추는 많아야 넷). */
:deep(.mp-actions) { display: flex; flex-wrap: nowrap; gap: 6px; }
:deep(.mp-actions button), :deep(.mp-actions a) {
  display: inline-flex; align-items: center;
  min-height: 32px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: #fff; font: 600 13px var(--font); cursor: pointer;
}
:deep(.mp-more) { color: var(--muted); }
/* 올리면 보이는 글의 메모 */
:deep(.tip-note) { color: var(--star); }
:deep(.tip-price-change) { color: var(--ink-2); font-size: 12px; }
</style>
