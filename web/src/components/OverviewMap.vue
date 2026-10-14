<script setup lang="ts">
import L from 'leaflet';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { SOURCE_LABEL, type Area, type ListingView } from '../../../shared/types';
import { loadCatalog, type CatalogStation } from '../areaActions';
import { auctionSiteLinks, isAuction } from '../auction';
import { KIND_LABEL, kindOf } from '../kinds';
import { isRoomStay, roomRange, roomTypesText } from '../rooms';
import { naverCenter } from '../siteLinks';
import { manwon, perPyeong, priceText, pyeong } from '../format';

// 한눈에 탭 오른쪽 지도와 지도 탭이 같이 쓴다.
// - 매물(같은 자리는 숫자 동그라미로 묶음)을 누르면 정보 창이 뜨고, 거기서 '목록에서 보기'나 '원본 열기'를 누른다.
//   옆에 목록이 있으면 누를 때 그 자리 매물들을 reveal 이벤트로 알려 목록도 그 매물로 옮기게 한다.
// - 역(흰 동그라미, 켜진 지역은 검은 동그라미)을 누르면 그 역 지역을 켜고 끈다(station 이벤트, 확대 12 이상에서 보임).
// - 휠 한 칸에 약 1.2배씩 확대하거나 축소한다.

type Point = { lat: number; lng: number };

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
const emit = defineEmits<{ select: [ListingView]; reveal: [ListingView[]]; open: [ListingView]; pick: [Point]; area: [Area]; station: [CatalogStation] }>();

const el = ref<HTMLDivElement | null>(null);
const picking = ref(false);
/** 크게 보기: 화면 거의 전체를 덮는다. Esc로 돌아온다. */
const big = ref(false);
let map: L.Map | null = null;
let base: L.LayerGroup | null = null; // 지역 원, 찍은 지역 표시
let dots: L.LayerGroup | null = null; // 매물
let stationLayer: L.LayerGroup | null = null; // 역
let stationRenderer: L.Renderer | null = null;
const stations = ref<CatalogStation[]>([]);
/** 이 확대보다 멀리서 보면 역을 그리지 않는다(수도권 658곳이 한꺼번에 보이면 매물이 가려서). */
const STATION_MIN_ZOOM = 12;
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
const color = (l: ListingView) => (l.verdict === 'star' ? '#c48a0a' : l.isNew ? '#e5484d' : l.priceChange ? '#12825e' : '#1f5fbf');
/** 묶음 색은 가장 눈여겨볼 매물을 따른다(신규 → 가격 변동 → 관심 → 나머지). */
const groupColor = (items: ListingView[]) =>
  items.some((l) => l.isNew) ? '#e5484d' : items.some((l) => l.priceChange) ? '#12825e' : items.some((l) => l.verdict === 'star') ? '#c48a0a' : '#1f5fbf';
const MUTED = '#8f99a6';

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
    const per = perPyeong(l);
    const facts = document.createElement('div');
    facts.className = 'mp-facts';
    if (l.areaM2 != null) facts.appendChild(line('mp-key', `${pyeong(l.areaM2)}평`));
    if (per != null) facts.appendChild(line('mp-key', `평당 ${manwon(per)}`));
    const room = isRoomStay(l);
    const kindText = room ? null : KIND_LABEL[kindOf(l)];
    const roomText = room ? roomTypesText(l) : isAuction(l) ? null : l.roomLabel;
    for (const f of [l.floor != null ? `${l.floor}층` : null, kindText, roomText, SOURCE_LABEL[l.source]]) {
      if (f) facts.appendChild(line('', f));
    }
    text.append(top, facts);
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
      .bindTooltip(`${esc(s.label)}<br><span class="st-tip">${enabled ? '누르면 이 지역 끄기' : '누르면 이 지역 켜기(1km)'}</span>`, { direction: 'top', offset: [0, -6] })
      .on('click', () => emit('station', s))
      .addTo(stationLayer);
  }
}

/** 지역 원. 역 이름이 아닌 지역(지도에서 찍은 곳)은 가운데에 마름모를 두고, 누르면 area 이벤트로 끈다. */
function drawBase() {
  if (!base) return;
  base.clearLayers();
  const stationNames = new Set(stations.value.map((s) => s.name));
  for (const a of props.areas) {
    L.circle([a.lat, a.lng], { radius: a.radiusM, color: '#16202e', weight: 1.5, fillOpacity: 0.03, dashArray: '6 6', interactive: false })
      .bindTooltip(a.name, { permanent: true, direction: 'top', className: 'area-label' })
      .addTo(base);
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
  for (const g of groups()) {
    const c = g.strong || !dim ? groupColor(g.items) : MUTED;
    let marker: L.Layer;
    if (g.items.length === 1) {
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
          html: `<span style="background:${c}">${g.items.length}</span>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        }),
        keyboard: false,
        zIndexOffset: g.strong ? 500 : 0,
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
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (picking.value) picking.value = false;
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
  stationLayer = L.layerGroup().addTo(map);
  base = L.layerGroup().addTo(map);
  dots = L.layerGroup().addTo(map);
  map.on('moveend', drawStations);
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
    if (!picking.value) return;
    picking.value = false;
    emit('pick', { lat: round6(e.latlng.lat), lng: round6(e.latlng.lng) });
  });
  drawBase();
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
  base = dots = stationLayer = null;
});
</script>

<template>
  <div class="ovmap" :class="{ picking, big }">
    <div class="map-wrap">
      <div ref="el" class="map" role="region" aria-label="매물 위치 지도"></div>
      <button
        class="btn btn-sm big-btn" :aria-pressed="big"
        :title="`${background.length}건, 위치 ${positions}곳${listings.length ? `, 펼친 목록 ${listings.length}건 진하게` : ''}`"
        @click="big = !big"
      >{{ big ? '작게 보기 (Esc)' : '크게 보기' }}</button>
      <p v-if="picking" class="pick-note">새 지역의 가운데를 누르세요 (Esc 취소)</p>
    </div>
    <div class="legend">
      <span><i style="background:#e5484d"></i>신규</span>
      <span><i style="background:#12825e"></i>가격 변동</span>
      <span><i style="background:#c48a0a"></i>관심</span>
      <span><i style="background:#1f5fbf"></i>나머지</span>
      <span><b class="stack-sample">3</b>같은 건물 매물 수</span>
      <span><i class="st-sample"></i>역: 누르면 지역 켜고 끄기</span>
      <span><i class="pick-sample"></i>찍은 지역: 누르면 끄기</span>
    </div>
    <div class="bar">
      <button class="btn btn-sm" :class="{ on: picking }" title="누른 뒤 지도에서 한 곳을 누르면 그 자리를 가운데로 1km 지역이 생깁니다" @click="picking = !picking">
        {{ picking ? '취소' : '위치 찍어 추가' }}
      </button>
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
.map-wrap { position: relative; display: grid; min-height: 280px; }
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
:deep(.area-label) { font-weight: 700; }
:deep(.pick-pin span), .legend .pick-sample {
  display: block; width: 11px; height: 11px; margin: 2px; background: #16202e; border: 2px solid #fff;
  box-shadow: 0 0 0 1px #16202e; border-radius: 1px; transform: rotate(45deg);
}
.legend .pick-sample { display: inline-block; width: 9px; height: 9px; margin: 0 6px 0 2px; vertical-align: 0; }
:deep(.stack span) {
  display: grid; place-items: center; width: 100%; height: 100%; border-radius: 50%;
  color: #fff; font: 700 11px/1 var(--font); border: 1.5px solid #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .35);
}
:deep(.stack.strong span) { font-size: 13px; border-width: 2px; }
:deep(.stack.dim span) { font-size: 9px; opacity: .75; }
:deep(.stack.sel span) { outline: 3px solid #16202e; outline-offset: 1px; }
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
:deep(.mp-actions) { display: flex; flex-wrap: wrap; gap: 6px; }
:deep(.mp-actions button), :deep(.mp-actions a) {
  min-height: 32px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: #fff; font: 600 13px var(--font); cursor: pointer;
}
:deep(.mp-more) { color: var(--muted); }
</style>
