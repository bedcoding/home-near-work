<script setup lang="ts">
import L from 'leaflet';
import { boundaryOf, regionBounds, regionColor, regionBoundaries } from '../../../shared/region-geometry';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { SOURCE_LABEL, type Area, type DealType, type ListingView, type PriceOption } from '../../../shared/types';
import { loadCatalog, type CatalogStation } from '../areaActions';
import { auctionSiteLinks, isAuction } from '../auction';
import { KIND_LABEL, kindOf } from '../kinds';
import { ledgerChips } from '../ledger';
import { isRoomStay, roomRange, roomTypesText } from '../rooms';
import { naverCenter } from '../siteLinks';
import { distanceText, manwon, perPyeong, priceText, pyeong } from '../format';
import { addWalkPin, ensureWalk, markDistances, moveWalkPin, pinCount, pinMax, removeWalkPin, renameWalkPin, setPinKind, walkPins, walkState, walkTimes } from '../walk';
import { WALK_NAME_MAX, type PinKind } from '../../../shared/walk';
import {
  checkZonesNow, loadZones, uploadZones, ZONE_COLOR, ZONE_GROUPS, ZONE_SOURCE_URL, zones, zonesBusy, zonesChecking, zonesError, zonesMessage, zonesOn,
} from '../redevZones';
import type { RedevZoneFeature } from '../../../shared/types';

// 매물 탭 오른쪽 지도와 경매 탭, 고시원과 쉐어 탭의 지도가 같이 쓴다.
// - 매물(같은 자리는 숫자 동그라미로 묶음)을 누르면 정보 창이 뜨고, 거기서 '목록에서 보기'나 '원본 열기'를 누른다.
//   확대해 보면(PRICE_ZOOM) 동그라미 대신 가격('보증금/월세', 전세 '전 1.5억')을 쓴 표시로 그리고, 같은 자리 여러 건은 가장 싼 것과 건수를 쓴다.
//   옆에 목록이 있으면 누를 때 그 자리 매물들을 reveal 이벤트로 알려 목록도 그 매물로 옮기게 한다.
// - 역(흰 동그라미, 켜진 지역은 검은 동그라미)을 누르면 그 역 지역을 켜고 끈다(station 이벤트, 확대 12 이상에서 보임).
// - 휠 한 칸에 약 1.2배씩 확대하거나 축소한다.
// - 정비사업 구역(서울플랜+ 파일을 넣었으면)을 매물과 역 아래 층에 칠한다. 마우스를 올리면 구역 이름, 사업 종류, 추진 단계가 보인다.
// - '거리 핀'으로 자주 가는 곳에 핀(MAX_WALK_PINS개까지, 모든 지도가 같이 씀)을 꽂으면 정보 창과 매물 카드에 핀까지 걸어서 몇 분인지 보인다.
//   '표시 핀'은 지도에 이름만 보이고(MAX_MARK_PINS개까지), 마우스를 올리면 거리 핀까지 걸어서 몇 분인지 보인다. 핀은 끌어서 옮기고, 누르면 이름이나 종류를 바꾸거나 뺀다.


const props = withDefaults(
  defineProps<{
    /** 목록을 펼친 매물. 진하게 보인다. */
    listings: ListingView[];
    /** 보일 매물 전체. 펼친 목록이 있으면 연하게, 없으면 보통으로 보인다. */
    background: ListingView[];
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
  }>(),
  { listMode: true, fitKey: '', visible: true },
);
const emit = defineEmits<{ select: [ListingView]; reveal: [ListingView[]]; open: [ListingView]; area: [Area]; station: [CatalogStation] }>();

const el = ref<HTMLDivElement | null>(null);
/** 핀 꽂는 중이면 그 종류(다음에 누른 자리에 핀을 꽂는다) */
const pinning = ref<PinKind | null>(null);
/** 크게 보기: 화면 거의 전체를 덮는다. Esc로 돌아온다. */
const big = ref(false);
let map: L.Map | null = null;
let base: L.LayerGroup | null = null; // 지역 원, 역 이름이 아닌 지역 표시
let dots: L.LayerGroup | null = null; // 매물
let stationLayer: L.LayerGroup | null = null; // 역
let stationRenderer: L.Renderer | null = null;
let zoneLayer: L.GeoJSON | null = null; // 정비사업 구역
let zoneRenderer: L.Renderer | null = null;
let pinLayer: L.LayerGroup | null = null; // 거리 핀과 표시 핀
const fileEl = ref<HTMLInputElement | null>(null);
const stations = ref<CatalogStation[]>([]);
/** 이 확대보다 멀리서 보면 역을 그리지 않는다(수도권 658곳이 한꺼번에 보이면 매물이 가려서). */
const STATION_MIN_ZOOM = 12;
/** 이 확대부터 매물 표시에 가격을 쓴다(strong은 펼친 목록의 매물, normal은 펼친 목록이 없을 때 매물). 멀리서는 겹쳐서 동그라미로 둔다. */
const PRICE_ZOOM = { strong: 14, normal: 15 };
/** 마지막으로 그린 가격 표시 단계(0 동그라미만, 1 펼친 목록만 가격, 2 모두 가격) */
let drawnPriceLevel = -1;
/** 매물 번호 → 그 매물이 든 표시(같은 자리 매물은 한 표시로 묶는다) */
const markerOf = new Map<string, { marker: L.Layer; group: Group }>();
let selected: { marker: L.Layer; group: Group } | null = null;
let resize: ResizeObserver | null = null;
let fitPending = false;
let panPending = false;

interface Group {
  lat: number;
  lng: number;
  items: ListingView[];
  strong: boolean;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const MEH = '#aab2bd';
const color = (l: ListingView) => (l.verdict === 'star' ? '#c48a0a' : l.verdict === 'meh' ? MEH : l.isNew ? '#e5484d' : l.priceChange ? '#12825e' : '#1f5fbf');
/** 묶음 색은 가장 눈여겨볼 매물을 따른다(신규 → 가격 변동 → 관심 → 나머지, 모두 별로면 회색). 별로인 매물은 색을 정할 때 뺀다. */
const groupColor = (all: ListingView[]) => {
  const items = all.filter((l) => l.verdict !== 'meh');
  if (!items.length) return MEH;
  return items.some((l) => l.isNew) ? '#e5484d' : items.some((l) => l.priceChange) ? '#12825e' : items.some((l) => l.verdict === 'star') ? '#c48a0a' : '#1f5fbf';
};
const MUTED = '#8f99a6';
/** 묶음에 별로가 아닌 신규 매물이 있으면 표시 오른쪽 위에 NEW 딱지를 붙인다. */
const hasNew = (items: ListingView[]) => items.some((l) => l.isNew && l.verdict !== 'meh');
const NEW_BADGE = '<em class="nw">NEW</em>';

const positions = computed(() => new Set(props.background.filter((l) => l.lat != null).map((l) => `${l.lat!.toFixed(5)},${l.lng!.toFixed(5)}`)).size);

/** 같은 자리(소수 5자리, 약 1m)의 매물을 묶는다. 펼친 목록의 매물은 진한 묶음으로 따로 둔다. */
function groups(): Group[] {
  const strongIds = new Set(props.listings.map((l) => l.id));
  const all = new Map<string, Group>();
  const add = (l: ListingView, strong: boolean) => {
    if (l.lat == null || l.lng == null) return;
    const key = `${strong ? 's' : 'b'}${l.lat.toFixed(5)},${l.lng.toFixed(5)}`;
    const g = all.get(key);
    if (g) g.items.push(l);
    else all.set(key, { lat: l.lat, lng: l.lng, items: [l], strong });
  };
  for (const l of props.background) if (!strongIds.has(l.id)) add(l, false);
  for (const l of props.listings) add(l, true);
  // 진한 묶음이 위에 오게 나중에 그린다.
  return [...all.values()].sort((a, b) => Number(a.strong) - Number(b.strong));
}

function tooltip(items: ListingView[]) {
  const lines = items.slice(0, 6).map((l) => `${esc(pricesText(l))}${l.title ? `, ${esc(l.title.slice(0, 24))}` : ''}`);
  if (items.length > 6) lines.push(`외 ${items.length - 6}건`);
  return (items.length > 1 ? `<strong>이 자리 ${items.length}건</strong><br>` : '') + lines.join('<br>');
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

/** 같은 자리 매물마다 첫 가격(카드 가격 줄의 첫 값) 중 표시에 쓸 것: 월세와 단기 먼저 월세가 낮은 것, 그다음 보증금, 매매가가 낮은 것 */
function cheapestPrice(items: ListingView[]): PriceOption | null {
  const ps = items.map((l) => l.prices[0]).filter((p): p is PriceOption => !!p);
  ps.sort(
    (a, b) =>
      DEAL_ORDER[a.deal] - DEAL_ORDER[b.deal] || (a.monthly ?? 0) - (b.monthly ?? 0) || (a.deposit ?? 0) - (b.deposit ?? 0) || (a.price ?? 0) - (b.price ?? 0),
  );
  return ps[0] ?? null;
}

/** 지금 확대에서 가격 표시 단계(PRICE_ZOOM) */
const priceLevel = () => {
  const z = map?.getZoom() ?? 0;
  return z >= PRICE_ZOOM.normal ? 2 : z >= PRICE_ZOOM.strong ? 1 : 0;
};

/** 가격 글자. 고시원과 쉐어의 가장 싼 방과 비싼 방은 '월세 0/22 ~ 0/40'처럼 잇는다. */
function pricesText(l: ListingView) {
  const range = roomRange(l);
  return range ? `월세 ${range}` : l.prices.map(priceText).join(', ');
}

const line = (className: string, text: string) => {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
};

/** 누르면 보이는 창: 그 자리 매물마다 가격, 평, 평당, 층, 유형, 방, 사이트, 제목과 '목록에서 보기', '원본 열기'. */
function popup(g: Group) {
  const box = document.createElement('div');
  box.className = 'mp';
  if (g.items.length > 1) box.appendChild(line('mp-head', `이 자리 매물 ${g.items.length}건`));
  for (const l of g.items.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'mp-row';
    const text = document.createElement('div');
    text.className = 'mp-text';
    const top = document.createElement('div');
    top.className = 'mp-top';
    const price = document.createElement('strong');
    price.textContent = pricesText(l) || '가격 정보 없음';
    top.appendChild(price);
    if (l.isNew) top.appendChild(line('mp-tag new', '신규'));
    if (l.priceChange) top.appendChild(line('mp-tag down', '가격 변동'));
    if (l.verdict === 'star') top.appendChild(line('mp-tag star', '관심'));
    if (l.verdict === 'meh') top.appendChild(line('mp-tag', '별로'));
    for (const c of ledgerChips(l)) {
      const tag = line(`mp-tag ${c.tone}`, c.label);
      tag.title = c.tip;
      top.appendChild(tag);
    }
    const per = perPyeong(l);
    const facts = document.createElement('div');
    facts.className = 'mp-facts';
    if (l.areaM2 != null) facts.appendChild(line('mp-key', `${pyeong(l.areaM2)}평`));
    if (per != null) facts.appendChild(line('mp-key', `평당 ${manwon(per)}`));
    const room = isRoomStay(l);
    const kindText = room ? null : KIND_LABEL[kindOf(l)];
    const roomText = room ? roomTypesText(l) : isAuction(l) ? null : l.roomLabel;
    const floorText = l.basement ? '반지하' : l.rooftop ? '옥탑' : l.floor != null ? `${l.floor}층` : null;
    for (const f of [floorText, kindText, roomText, SOURCE_LABEL[l.source]]) {
      if (f) facts.appendChild(line('', f));
    }
    text.append(top, facts);
    // 꽂은 핀마다 걸어서 몇 분
    for (const w of walkTimes(l.id)) text.appendChild(line('mp-walk', `${w.pin.name}까지 걸어서 ${w.minutes}분(${distanceText(w.meters)})`));
    if (l.title) text.appendChild(line('mp-sub', l.title.slice(0, 40)));
    const actions = document.createElement('div');
    actions.className = 'mp-actions';
    if (props.listMode) {
      const see = document.createElement('button');
      see.textContent = '목록에서 보기';
      see.addEventListener('click', () => {
        map?.closePopup();
        big.value = false;
        emit('select', l);
      });
      actions.appendChild(see);
    }
    const open = document.createElement('button');
    open.textContent = '원본 열기';
    open.addEventListener('click', () => emit('open', l));
    actions.appendChild(open);
    if (l.lat != null && l.lng != null) {
      const naver = document.createElement('a');
      naver.textContent = '네이버 지도 ↗';
      naver.href = `https://fin.land.naver.com/map?center=${naverCenter(l.lat, l.lng)}&zoom=16`;
      naver.target = '_blank';
      naver.rel = 'noopener';
      naver.title = '이 자리를 네이버 부동산 지도로 엽니다(단지와 실거래가 확인)';
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
    row.append(text, actions);
    box.appendChild(row);
  }
  if (g.items.length > 12) {
    const more = document.createElement('div');
    more.className = 'mp-more';
    more.textContent = `외 ${g.items.length - 12}건`;
    box.appendChild(more);
  }
  L.popup({ maxWidth: 340, className: 'mp-popup' }).setLatLng([g.lat, g.lng]).setContent(box).openOn(map!);
}

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
  pinLayer.clearLayers();
  for (const p of walkPins.value) {
    const marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: p.kind === 'mark' ? 'walk-pin mark' : 'walk-pin', html: `<span>${esc(p.name)}</span>`, iconSize: [0, 0], iconAnchor: [0, 0], tooltipAnchor: [0, -34] }),
      pane: 'walkpins',
      draggable: true,
      keyboard: false,
    });
    const help = `<span class="st-tip">${p.kind === 'mark' ? '표시 핀' : '거리 핀'}, 끌어서 옮기기, 누르면 이름 바꾸기와 빼기</span>`;
    // 표시 핀은 마우스를 올릴 때마다 거리 핀까지 거리를 새로 읽어 보인다(옮긴 뒤 다시 잰 값도 바로 반영).
    marker.bindTooltip(p.kind === 'mark' ? () => `${esc(p.name)}${markLines(p.id)}<br>${help}` : `${esc(p.name)}<br>${help}`, { direction: 'top' });
    marker.on('dragend', () => {
      const at = marker.getLatLng();
      moveWalkPin(p.id, round6(at.lat), round6(at.lng));
    });
    marker.on('click', () => pinPopup(p.id));
    marker.addTo(pinLayer);
  }
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

/** 지역 원. 역 이름이 아닌 지역(지도에서 찍은 곳)은 가운데에 마름모를 두고, 누르면 area 이벤트로 끈다. */
function drawBase() {
  if (!base) return;
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
        const layer = L.geoJSON(feature, { style: { color, fillColor: color, weight: 2.5, fillOpacity: 0.12 } });
        layer.bindTooltip(`${esc(a.region.sigungu)} · ${a.region.kind === 'gu' ? '선택한 구 경계' : '참고용 구 경계 (동 경계 아님)'}`, { permanent: labels, direction: 'center', className: 'area-label' }).addTo(base);
      }
      continue;
    }
    const alarm = a.purpose === 'alert';
    const circle = L.circle([a.lat, a.lng], { radius: a.radiusM, color: alarm ? '#087f5b' : '#16202e', weight: alarm ? 2.5 : 1.5, fillOpacity: alarm ? 0.045 : 0.03, dashArray: '6 6', interactive: false });
    circle.bindTooltip(alarm ? `${esc(a.name)} · 알림 반경 ${distanceText(a.radiusM)}` : a.name, { permanent: labels && !alarm, direction: 'top', className: 'area-label' });
    circle.addTo(base);
    if (!stations.value.length || stationNames.has(a.name)) continue;
    L.marker([a.lat, a.lng], { icon: L.divIcon({ className: 'pick-pin', html: '<span></span>', iconSize: [16, 16], iconAnchor: [8, 8] }), keyboard: false, zIndexOffset: 800 })
      .bindTooltip(`${esc(a.name)}<br><span class="st-tip">누르면 이 지역 끄기</span>`, { direction: 'top', offset: [0, -6] })
      .on('click', () => emit('area', a))
      .addTo(base);
  }
}

function fitTo(points: L.LatLng[]) {
  if (!map) return;
  if (!props.visible || !el.value?.clientWidth || !el.value.clientHeight) {
    fitPending = true;
    return;
  }
  fitPending = false;
  const bounds = L.latLngBounds(points);
  for (const a of props.areas) if (a.purpose === 'alert') bounds.extend(L.latLng(a.lat, a.lng).toBounds(a.radiusM * 2));
  for (const a of props.areas) if (a.region) {
    const b = regionBounds(a.region.code);
    if (b) bounds.extend([[b[1], b[0]], [b[3], b[2]]]);
  }
  if (!points.length) for (const a of props.areas) bounds.extend(L.latLng(a.lat, a.lng).toBounds(a.radiusM * 2));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
}

/** fit: 매물에 맞춰 지도를 다시 맞춘다(처음, fitKey가 바뀔 때). */
function drawDots(fit: boolean) {
  if (!dots) return;
  dots.clearLayers();
  markerOf.clear();
  selected = null;
  const dim = props.listings.length > 0;
  drawnPriceLevel = priceLevel();
  for (const g of groups()) {
    const c = g.strong || !dim ? groupColor(g.items) : MUTED;
    const price = (g.strong ? drawnPriceLevel >= 1 : !dim && drawnPriceLevel >= 2) ? cheapestPrice(g.items) : null;
    // 신규가 든 표시는 빨갛게 칠하고 다른 표시 위에 그린다. NEW 딱지는 겹쳐서 지도를 가리지 않게 가격을 쓴 표시와
    // PRICE_ZOOM.normal부터의 동그라미에만 붙이고, 연하게 칠한 매물(펼친 목록 밖)에는 붙이지 않는다.
    const fresh = (g.strong || !dim) && hasNew(g.items);
    const badge = fresh && (price || drawnPriceLevel >= 2) ? NEW_BADGE : '';
    const zIndexOffset = (g.strong ? 500 : 0) + (fresh ? 300 : 0);
    let marker: L.Layer;
    if (price) {
      // 확대해 보면 가격을 쓴 표시(같은 자리 여러 건이면 가장 싼 것과 건수)
      marker = L.marker([g.lat, g.lng], {
        icon: L.divIcon({
          className: `price${g.strong ? ' strong' : ''}`,
          html: `<span style="background:${c}">${esc(mapPrice(price))}${g.items.length > 1 ? `<b>${g.items.length}</b>` : ''}${badge}</span>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
          tooltipAnchor: [0, -10],
        }),
        keyboard: false,
        zIndexOffset,
      });
    } else if (g.items.length === 1 && badge) {
      // 신규 한 건: 딱지를 붙이려고 동그라미를 글자 없는 묶음 표시로 그린다(크기는 아래 동그라미와 같음).
      const size = g.strong ? 14 : 10;
      marker = L.marker([g.lat, g.lng], {
        icon: L.divIcon({
          className: `stack one${g.strong ? ' strong' : ''}`,
          html: `<span style="background:${c}">${badge}</span>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        }),
        keyboard: false,
        zIndexOffset,
      });
    } else if (g.items.length === 1) {
      marker = L.circleMarker([g.lat, g.lng], {
        radius: g.strong ? 7 : dim ? 3.5 : 5,
        color: '#fff',
        weight: g.strong ? 2 : 1,
        fillColor: c,
        fillOpacity: g.strong ? 0.95 : dim ? 0.5 : 0.8,
      });
    } else {
      // 같은 자리 여러 건: 숫자 동그라미
      const size = g.strong ? 26 : dim ? 16 : 20;
      marker = L.marker([g.lat, g.lng], {
        icon: L.divIcon({
          className: `stack${g.strong ? ' strong' : ''}${dim && !g.strong ? ' dim' : ''}`,
          html: `<span style="background:${c}">${g.items.length}${badge}</span>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        }),
        keyboard: false,
        zIndexOffset,
      });
    }
    (marker as L.Marker).bindTooltip(tooltip(g.items), { direction: 'top' });
    // 누르면 바로 넘어가지 않고 정보 창을 먼저 띄운다.
    marker.on('click', () => {
      popup(g);
      if (props.listMode) emit('reveal', g.items);
    });
    marker.addTo(dots);
    for (const l of g.items) markerOf.set(l.id, { marker, group: g });
  }
  highlight(false);
  if (fit) fitTo(focusPoints());
}

/** 지도를 맞출 곳: 펼친 목록이 있으면 그 매물, 없으면 보이는 매물 전체. */
function focusPoints() {
  const list = props.listings.length ? props.listings : props.background;
  return list.filter((l) => l.lat != null && l.lng != null).map((l) => L.latLng(l.lat!, l.lng!));
}

/** 고른 매물이 든 표시를 강조하고, 지도 밖이면 그쪽으로 옮긴다. */
function highlight(pan: boolean) {
  if (selected) setSelected(selected, false);
  selected = props.selectedId ? (markerOf.get(props.selectedId) ?? null) : null;
  if (!selected || !map) return;
  setSelected(selected, true);
  const at = L.latLng(selected.group.lat, selected.group.lng);
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
  if (size.x !== el.value.clientWidth || size.y !== el.value.clientHeight) map.invalidateSize();
  if (fitPending) fitTo(focusPoints());
  if (panPending) {
    panPending = false;
    highlight(true);
  }
}

function setSelected(s: { marker: L.Layer; group: Group }, on: boolean) {
  if (s.marker instanceof L.CircleMarker) {
    s.marker.setStyle(on ? { color: '#16202e', weight: 3 } : { color: '#fff', weight: s.group.strong ? 2 : 1 });
    s.marker.setRadius(on ? 9 : s.group.strong ? 7 : props.listings.length ? 3.5 : 5);
    if (on) s.marker.bringToFront();
  } else {
    (s.marker as L.Marker).getElement()?.classList.toggle('sel', on);
    (s.marker as L.Marker).setZIndexOffset(on ? 1000 : s.group.strong ? 500 : 0);
  }
}

/** 확대를 바꿔 가격 표시 단계가 바뀌면 매물 표시를 다시 그린다(보던 확대와 위치는 그대로). */
function onZoom() {
  if (priceLevel() !== drawnPriceLevel) drawDots(false);
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (pinning.value) pinning.value = null;
  else if (big.value) big.value = false;
}

onMounted(() => {
  if (!el.value) return;
  // 휠 한 칸 = 확대 0.25단계(약 1.2배). 버튼은 0.5단계. 처음 위치(서울시청)는 매물도 지역도 없을 때만 보인다.
  map = L.map(el.value, { zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 180 }).setView([37.5665, 126.978], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  // 역은 매물 아래 층에 그린다(겹쳐도 매물이 눌리게).
  // 그리는 층을 먼저 지도에 붙여 둔다. 그래야 지도를 옮길 때 그 층이 새 화면 범위를 먼저 잡고, 그다음 역을 다시 그린다
  // (순서가 바뀌면 새로 보이는 역을 화면 밖으로 보고 그리지 않는다).
  map.createPane('stations').style.zIndex = '390';
  stationRenderer = L.svg({ pane: 'stations', padding: 0.3 }).addTo(map);
  // 정비사업 구역은 역보다도 아래 층에 그린다(구역 수가 많아 canvas로).
  map.createPane('zones').style.zIndex = '350';
  zoneRenderer = L.canvas({ pane: 'zones', padding: 0.3 }).addTo(map);
  // 핀은 지역 이름표(툴팁 층 650)보다 위, 정보 창(700)보다 아래에 그린다(역 자리에 꽂아도 이름표에 가리지 않게).
  map.createPane('walkpins').style.zIndex = '660';
  stationLayer = L.layerGroup().addTo(map);
  base = L.layerGroup().addTo(map);
  dots = L.layerGroup().addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  map.on('moveend', drawStations);
  map.on('zoomend', onZoom);
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
  drawDots(true);
  // 칸 크기가 바뀌면(창 크기, 크게 보기) 지도를 다시 맞춘다.
  resize = new ResizeObserver(syncVisibleSize);
  resize.observe(el.value);
  window.addEventListener('keydown', onKey);
});

// 매물이 바뀌면 다시 그린다. fitKey가 바뀌었을 때만 매물에 맞추고, 아니면 보던 확대와 위치를 그대로 둔다. 고른 매물이 바뀌면 그 표시를 강조한다.
/** 마지막으로 지도를 맞춘 fitKey */
let fittedKey: string | null = null;
watch(
  () => [props.listings, props.background, props.fitKey] as const,
  () => {
    const fit = props.fitKey !== fittedKey;
    fittedKey = props.fitKey;
    drawDots(fit);
  },
);
watch(
  () => props.areas,
  () => {
    drawBase();
    drawStations();
  },
);
watch(
  () => props.selectedId,
  () => highlight(true),
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
  resize?.disconnect();
  if (map) {
    // 확대 애니메이션 중에 지우면 Leaflet이 250ms 뒤 이미 지운 칸을 읽다가 오류를 내서, 애니메이션 표시를 끄고 지운다.
    (map as unknown as { _animatingZoom: boolean })._animatingZoom = false;
    map.remove();
  }
  // 늦게 끝난 역 목록 받기 등이 지운 지도에 그리지 않게 한다.
  map = null;
  base = dots = stationLayer = zoneLayer = pinLayer = null;
});
</script>

<template>
  <div class="ovmap" :class="{ picking: pinning, big }">
    <div class="map-wrap">
      <div ref="el" class="map" role="region" aria-label="매물 위치 지도"></div>
      <button
        class="btn btn-sm big-btn" :aria-pressed="big"
        :title="`${background.length}건, 위치 ${positions}곳${listings.length ? `, 펼친 목록 ${listings.length}건 진하게` : ''}`"
        @click="big = !big"
      >{{ big ? '작게 보기 (Esc)' : '크게 보기' }}</button>
      <p v-if="pinning" class="pick-note">{{ pinning === 'mark' ? '표시 핀' : '거리 핀' }}을 꽂을 곳을 누르세요 (Esc 취소)</p>
    </div>
    <div class="legend">
      <span :title="`새로 들어온 매물이 있는 자리는 빨간색으로 칠하고, 확대해서 가격이 보이면 오른쪽 위에 NEW 딱지를 붙입니다`"><i style="background:#e5484d"></i>신규<em class="nw-sample">NEW</em></span>
      <span><i style="background:#12825e"></i>가격 변동</span>
      <span><i style="background:#c48a0a"></i>관심</span>
      <span><i style="background:#1f5fbf"></i>나머지</span>
      <span><b class="stack-sample">3</b>같은 건물 매물 수</span>
      <span :title="`확대 ${PRICE_ZOOM.normal}부터(가격대를 펼쳤으면 그 매물은 ${PRICE_ZOOM.strong}부터) 동그라미 대신 가격을 씁니다. 월세는 보증금/월세(만원), 전세는 '전 1.5억'처럼, 같은 자리 여러 건은 가장 싼 것과 건수`"><b class="price-sample">500/40</b>확대하면 가격</span>
      <span v-for="a in areas.filter(a => a.region)" :key="a.id"><i :style="{ background: regionColor(a.region!.code) }"></i>{{ a.region!.sigungu }}{{ a.region!.kind === 'dong' ? ' (참고용 구 경계)' : ' 경계' }}</span>
      <span v-if="areas.some(a => a.region)" :title="regionBoundaries.metadata.attribution">구 경계 {{ regionBoundaries.metadata.date }} · <a href="https://github.com/vuski/admdongkor" target="_blank" rel="noopener">SGIS / admdongkor</a> · CC BY 4.0</span>
      <span v-if="areas.some(a => a.purpose === 'alert')"><i style="background:transparent;border:2px dashed #087f5b"></i>초록 점선: 알림 구역</span>
      <span v-for="a in areas.filter(a => a.purpose === 'alert')" :key="`alert-${a.id}`">{{ a.name }} {{ distanceText(a.radiusM) }}</span>
      <span><i class="st-sample"></i>역: 누르면 이 역 알림 켜고 끄기</span>
      <span v-if="pinCount('walk')"><b class="pin-sample">핀</b>거리 핀</span>
      <span v-if="pinCount('mark')"><b class="pin-sample mark">핀</b>표시 핀</span>
      <span v-if="walkPins.length">핀: 끌어서 옮기기, 누르면 이름과 종류, 빼기</span>
      <template v-if="zonesOn && zones?.count">
        <span v-for="g in ZONE_GROUPS" :key="g.id"><i class="zone-sample" :style="{ background: `${g.color}33`, borderColor: g.color }"></i>{{ g.name }}</span>
        <span
          class="zone-src"
          :title="[
            `서울 열린데이터광장 '서울시 도시계획사업 현황(서울플랜+) 공간정보'(OA-22712)${zones.fileName ? `, 파일 ${zones.fileName}` : ''}${zones.seq ? ` (${zones.seq}번 파일)` : ''}.`,
            `준공, 입주중, 후보지철회 ${zones.skipped.done}곳, 역세권이나 도시개발 같은 다른 사업 ${zones.skipped.other}곳은 뺐습니다. 점선 테두리는 넓은 구역(재정비촉진지구, 모아타운, 존치관리구역)입니다.`,
            `새 파일은 조회할 때 7일마다 확인합니다${zones.check ? `(마지막 ${monthDay(zones.check.at)}: ${zones.check.text})` : ''}.`,
          ].join('\n')"
        >
          정비구역 {{ zones.count.toLocaleString('ko-KR') }}곳, 서울시 {{ zones.fileDate?.replace(/-/g, '.') ?? '' }} 기준
        </span>
      </template>
    </div>
    <div class="bar">
      <button
        class="btn btn-sm" :class="{ on: pinning === 'walk' }" :disabled="pinning !== 'walk' && pinCount('walk') >= pinMax('walk')"
        :title="pinCount('walk') >= pinMax('walk')
          ? `거리 핀은 ${pinMax('walk')}개까지 꽂습니다. 핀을 누르면 빼거나 표시 핀으로 바꿀 수 있습니다`
          : '누른 뒤 지도에서 회사처럼 자주 가는 곳을 누르면 핀이 꽂히고, 매물 카드와 정보 창에 핀까지 걸어서 몇 분인지 보입니다'"
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
        <template v-else-if="zones">
          <button type="button" class="zone-change" title="서울 열린데이터광장에 새 판이 있으면 받아 바꿉니다(조회할 때도 7일마다 알아서 확인)" @click="checkZonesNow">새 파일 확인</button>
          <button type="button" class="zone-change" title="직접 받은 서울플랜+ ZIP으로 바꿉니다" @click="pickZoneFile">파일 바꾸기</button>
        </template>
        <span v-if="zonesMessage && !zonesChecking" class="zone-note">{{ zonesMessage }}</span>
        <span v-if="zonesError" class="zone-note err" role="alert">{{ zonesError }}</span>
      </template>
      <input ref="fileEl" type="file" accept=".zip,application/zip" hidden @change="onZoneFile">
    </div>
  </div>
</template>

<style scoped>
.ovmap { display: grid; grid-template-rows: 1fr auto auto; gap: 8px; height: 100%; background: var(--paper); }
.ovmap.big {
  position: fixed; inset: 12px; z-index: 60; height: auto; padding: 12px;
  background: var(--surface); border: 1px solid var(--line-strong); border-radius: 14px; box-shadow: 0 12px 40px rgba(22, 32, 46, .3);
}
/* 지도 칸: 오른쪽 위 구석에 크게 보기 버튼, 위치 찍는 중이면 위 가운데에 안내(지도 조작은 막지 않음). 지도 컨트롤(z-index 1000) 위에 둔다. */
/* isolation: 지도 안의 z-index(지도 칸 400, 컨트롤 1000)가 위쪽 머리말 메뉴(조회하기 ▾ 등)를 덮지 않게 지도 안에 가둔다. */
.map-wrap { position: relative; display: grid; min-height: 280px; isolation: isolate; }
.map { min-height: 280px; border: 1px solid var(--line-strong); border-radius: 12px; }
.big-btn { position: absolute; top: 10px; right: 10px; z-index: 1001; box-shadow: 0 1px 4px rgba(22, 32, 46, .18); }
.pick-note {
  position: absolute; top: 10px; left: 50%; z-index: 1001; transform: translateX(-50%); margin: 0; padding: 6px 12px; pointer-events: none;
  border-radius: 8px; background: var(--ink); color: #fff; font-size: 13px; font-weight: 600; white-space: nowrap;
}
.picking .map { cursor: crosshair; outline: 3px solid var(--accent); outline-offset: 2px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12.5px; color: var(--ink-2); align-items: center; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
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
.legend .zone-sample { border-radius: 2px; border: 1.5px solid; box-sizing: border-box; }
.zone-src { color: var(--muted); cursor: help; }
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
:deep(.mp-walk) { color: #5235b5; font-weight: 700; }
:deep(.pin-pop) { flex-wrap: nowrap; }
:deep(.pin-pop input) {
  width: 9em; min-height: 32px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 8px; font: 600 13px var(--font);
}
:deep(.stack span) {
  position: relative; box-sizing: border-box;
  display: grid; place-items: center; width: 100%; height: 100%; border-radius: 50%;
  color: #fff; font: 700 11px/1 var(--font); border: 1.5px solid #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .35);
}
:deep(.stack.strong span) { font-size: 13px; border-width: 2px; }
:deep(.stack.dim span) { font-size: 9px; opacity: .75; }
:deep(.stack.sel span) { outline: 3px solid #16202e; outline-offset: 1px; }
/* 가격 표시: 크기 0인 표시 칸의 가운데에 글자 상자를 놓는다(글자 길이만큼 넓어짐) */
:deep(.price span), .price-sample {
  display: inline-flex; align-items: center; gap: 3px; padding: 1px 5px; border-radius: 9px; white-space: nowrap;
  color: #fff; font: 700 11px/1.4 var(--font); border: 1.5px solid #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .35);
}
:deep(.price span) { position: absolute; left: 0; top: 0; transform: translate(-50%, -50%); cursor: pointer; }
:deep(.price span b) {
  display: inline-grid; place-items: center; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px;
  background: #fff; color: #16202e; font-size: 10px; line-height: 1;
}
:deep(.price.strong span) { padding: 2px 6px; font-size: 12px; border-width: 2px; }
:deep(.price.sel span) { outline: 3px solid #16202e; outline-offset: 1px; }
.price-sample { margin-right: 4px; background: #1f5fbf; box-shadow: 0 0 0 1px #1f5fbf; }
/* 신규 딱지: 표시 오른쪽 위 모서리에 걸친다. 누르면 아래 표시가 눌리게 한다. */
:deep(.nw), .nw-sample {
  padding: 0 3px; border-radius: 4px; border: 1px solid #e5484d; background: #fff;
  color: #e5484d; font: italic 800 9px/1.25 var(--font); letter-spacing: .02em; white-space: nowrap;
}
:deep(.nw) { position: absolute; top: -9px; right: -14px; box-shadow: 0 1px 2px rgba(0, 0, 0, .3); pointer-events: none; }
:deep(.stack.one .nw) { top: -11px; right: -20px; }
.nw-sample { display: inline-block; margin-left: 4px; vertical-align: 1px; }
.legend .st-sample { width: 10px; height: 10px; border: 2px solid #16202e; background: #fff; box-sizing: border-box; }
:deep(.st-tip) { color: var(--muted); font-size: 12px; }
:deep(.mp) { display: grid; gap: 8px; max-height: 340px; overflow: auto; font: 13px/1.45 var(--font); }
:deep(.mp-head) { font-weight: 700; }
:deep(.mp-row) { display: grid; gap: 4px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
:deep(.mp-text) { display: grid; }
:deep(.mp-top) { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
:deep(.mp-sub) { color: var(--muted); }
:deep(.mp-facts) { display: flex; flex-wrap: wrap; gap: 0 10px; color: var(--muted); }
:deep(.mp-key) { color: var(--ink); font-weight: 700; }
:deep(.mp-tag) { padding: 0 6px; border-radius: 6px; font-size: 12px; font-weight: 700; }
:deep(.mp-tag.new) { background: var(--new-soft); color: var(--new); }
:deep(.mp-tag.down) { background: var(--down-soft); color: var(--down); }
:deep(.mp-tag.star) { background: var(--star-soft); color: var(--star); }
:deep(.mp-tag.danger) { background: #c92a2a; color: #fff; cursor: help; }
:deep(.mp-tag.warn) { background: #fff4d6; color: #8a5a00; cursor: help; }
:deep(.mp-actions) { display: flex; flex-wrap: wrap; gap: 6px; }
:deep(.mp-actions button), :deep(.mp-actions a) {
  display: inline-flex; align-items: center;
  min-height: 32px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: #fff; font: 600 13px var(--font); cursor: pointer;
}
:deep(.mp-more) { color: var(--muted); }
</style>
