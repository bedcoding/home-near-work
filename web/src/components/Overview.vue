<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { DEAL_LABEL, SOURCE_LABEL, type Area, type DealType, type ListingView, type PriceOption, type SourceId, type Verdict } from '../../../shared/types';
import { bandIdOf, bandsFor, bandValue, EDGES, isRent, OVERVIEW_DEALS, orderFor, type Band } from '../bands';
import { DEFAULT_FILTERS, dealOptions, passes, type Filters } from '../filters';
import type { CatalogStation } from '../areaActions';
import { money, radiusText } from '../format';
import CountTooltip from './CountTooltip.vue';
import ListingCard from './ListingCard.vue';
import OverviewMap from './OverviewMap.vue';

type Point = { lat: number; lng: number };
const props = defineProps<{ listings: ListingView[]; filters: Filters; areas: Area[]; selectedId: string | null }>();
const overviewEl = ref<HTMLElement | null>(null);
const mapPanel = ref<HTMLElement | null>(null);
const mapPanelHeight = ref<number>();
let layoutObserver: ResizeObserver | undefined;
let sizeFrame = 0;

// 탭 줄바꿈과 스크롤 위치에 맞춰 지도가 화면 아래쪽까지 차도록 한다.
function scheduleMapSize() {
  cancelAnimationFrame(sizeFrame);
  sizeFrame = requestAnimationFrame(() => {
    if (!mapPanel.value || window.innerWidth <= 1280) {
      mapPanelHeight.value = undefined;
      return;
    }
    const stickyTop = Number.parseFloat(getComputedStyle(mapPanel.value).top) || 0;
    const top = Math.max(stickyTop, overviewEl.value?.getBoundingClientRect().top ?? 0);
    mapPanelHeight.value = Math.max(400, Math.floor(window.innerHeight - top - 16));
  });
}

onMounted(() => {
  layoutObserver = new ResizeObserver(scheduleMapSize);
  if (overviewEl.value) layoutObserver.observe(overviewEl.value);
  for (const el of document.querySelectorAll('.app-frame > .top')) layoutObserver.observe(el);
  window.addEventListener('resize', scheduleMapSize);
  window.addEventListener('scroll', scheduleMapSize, { passive: true });
  scheduleMapSize();
});
onBeforeUnmount(() => {
  layoutObserver?.disconnect();
  cancelAnimationFrame(sizeFrame);
  window.removeEventListener('resize', scheduleMapSize);
  window.removeEventListener('scroll', scheduleMapSize);
});
const emit = defineEmits<{
  /** 지금 펼쳐져 보이는 매물(화면 순서). 키보드 이동에 쓴다. */
  visible: [ListingView[]];
  select: [ListingView];
  open: [ListingView];
  verdict: [ListingView, Verdict | null];
  source: [ListingView];
  raw: [ListingView];
  /** 지도에서 위치를 찍음(그 자리를 가운데로 지역 추가) */
  pick: [Point];
  /** 지도에서 찍은 지역의 가운데 표시를 누름(그 지역 끄기) */
  area: [Area];
  /** 지역 칸을 누름: 볼 지역 번호(빈 배열이면 전체). 왼쪽 필터의 지역과 같은 값이다. */
  areas: [number[]];
  /** 거래 유형 카드를 누름: 왼쪽 필터의 거래 유형을 그 하나로 바꾼다. */
  deals: [DealType[]];
  /** 지도에서 역을 누름: 그 역 지역 켜기와 끄기 */
  station: [CatalogStation];
}>();

/** ''는 가격대만 펼친 상태(사이트별 건수만 보임). */
type Pick = SourceId | 'all' | '';
interface Saved {
  deal: DealType;
  /** 거래 유형별 가격대 순서(끌어서 바꾼 것) */
  order: Partial<Record<DealType, string[]>>;
  /** 거래 유형별로 펼친 가격대와 고른 사이트 */
  open: Partial<Record<DealType, Record<string, Pick>>>;
}

// 다음에 열어도 고른 거래 유형, 펼친 가격대, 순서가 그대로 보이게 저장한다. 읽을 때는 이 세 값만 남긴다.
const KEY = 'hnw-overview-v1';
function load(): Saved {
  const empty: Saved = { deal: 'monthly', order: {}, open: {} };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
    return s ? { deal: s.deal ?? empty.deal, order: s.order ?? {}, open: s.open ?? {} } : empty;
  } catch {
    return empty;
  }
}
const saved = reactive<Saved>(load());
watch(
  saved,
  (s) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* 저장이 막혀도 화면은 동작한다 */
    }
  },
  { deep: true },
);

const SOURCES = Object.keys(SOURCE_LABEL) as SourceId[];
const hasNews = (l: ListingView) => l.isNew || !!l.priceChange;

interface Entry {
  listing: ListingView;
  /** 가격대를 정한 가격 선택지 */
  option: PriceOption;
  value: number | null;
}

/** 가격 선택지가 여럿이면 가장 싼 것(같으면 보증금이 낮은 것)으로 가격대를 정한다. */
function cheapest(deal: DealType, options: PriceOption[]): PriceOption {
  const key = (p: PriceOption) => bandValue(deal, p) ?? Infinity;
  const deposit = (p: PriceOption) => p.deposit ?? Infinity;
  return options.reduce((a, b) => (key(b) < key(a) || (key(b) === key(a) && deposit(b) < deposit(a)) ? b : a));
}

// ---------- 지역 ----------
// 켜진 지역이 둘 이상이면 지역마다 따로 볼 수 있다.
// 고른 지역은 왼쪽 필터의 지역(filters.areaIds)과 같은 값이라, 여기서 누르면 필터 칸도 바뀐다.
/** 지역 칸의 건수: 그 지역만 골랐을 때 필터를 통과하는 매물 수. */
const areaChips = computed(() => ({
  all: props.listings.filter((l) => passes(l, { ...props.filters, areaIds: [] }, props.areas)).length,
  list: props.areas.map((a) => ({
    id: a.id,
    label: `${a.name} ${radiusText(a.radiusM)}`,
    count: props.listings.filter((l) => passes(l, { ...props.filters, areaIds: [a.id] }, props.areas)).length,
    on: props.filters.areaIds.includes(a.id),
  })),
}));
const allAreas = computed(() => !props.areas.some((a) => props.filters.areaIds.includes(a.id)));

// ---------- 거래 유형 ----------
// 고른 거래 유형은 왼쪽 필터의 거래 유형과 같은 값이다. 카드를 누르면 필터도 그 하나로 바뀌고(deals 이벤트),
// 필터에서 거래 유형을 고르면 그 카드로 옮긴다. 카드의 건수는 거래 유형 필터를 빼고 센다(카드가 곧 거래 유형 고르기라서).
/** 거래 유형 필터를 뺀 필터 */
const anyDeal = computed<Filters>(() => ({ ...props.filters, deals: [] }));

const byDeal = computed(() => {
  const map = new Map<DealType, Entry[]>();
  for (const deal of OVERVIEW_DEALS) {
    const entries: Entry[] = [];
    for (const listing of props.listings) {
      const options = dealOptions(listing, deal, anyDeal.value, props.areas);
      if (!options.length) continue;
      const option = cheapest(deal, options);
      entries.push({ listing, option, value: bandValue(deal, option) });
    }
    map.set(deal, entries);
  }
  return map;
});

const counts = (entries: Entry[]) => ({
  total: entries.length,
  news: entries.filter((e) => e.listing.isNew).length,
  changed: entries.filter((e) => !!e.listing.priceChange).length,
});

/**
 * '지역 반경 안만' 필터 때문에 가려진 수(거래 유형별). 모은 매물은 반경보다 조금 넓게(+500m) 저장되므로,
 * 반경 밖이라 안 보이는 매물이 있다는 것을 알린다.
 */
const outsideByDeal = computed(() => {
  const out = new Map<DealType, number>();
  if (!props.filters.insideAreas) return out;
  const loose = { ...anyDeal.value, insideAreas: false };
  for (const deal of OVERVIEW_DEALS) {
    let n = 0;
    for (const l of props.listings) if (dealOptions(l, deal, loose, props.areas).length && !dealOptions(l, deal, anyDeal.value, props.areas).length) n++;
    out.set(deal, n);
  }
  return out;
});

/** 월세, 전세, 매매는 늘 보이고, 단기는 매물이 있을 때(반경 밖 포함)나 골라 둔 때만 보인다. */
const dealCards = computed(() =>
  OVERVIEW_DEALS.map((deal) => ({
    deal,
    label: DEAL_LABEL[deal],
    ...counts(byDeal.value.get(deal) ?? []),
    outside: outsideByDeal.value.get(deal) ?? 0,
  })).filter((c) => c.total > 0 || c.outside > 0 || c.deal !== 'short' || c.deal === saved.deal),
);

const deal = computed<DealType>(() => (dealCards.value.some((c) => c.deal === saved.deal) ? saved.deal : 'monthly'));

/** 카드(또는 숫자 키)로 거래 유형을 고른다. 왼쪽 필터도 그 하나로 바뀐다. */
function pickCard(d: DealType) {
  saved.deal = d;
  emit('deals', [d]);
}

function pickDeal(index: number) {
  const card = dealCards.value[index];
  if (card) pickCard(card.deal);
}

// 왼쪽 필터에서 거래 유형을 새로 켜면 그 카드로, 지금 카드가 필터에서 빠지면 남은 것 중 첫 카드로 옮긴다. '전체'면 그대로 둔다.
watch(
  () => props.filters.deals.filter((d) => OVERVIEW_DEALS.includes(d)),
  (now, before) => {
    const added = before ? now.find((d) => !before.includes(d)) : undefined;
    if (added) saved.deal = added;
    else if (now.length && !now.includes(saved.deal)) saved.deal = OVERVIEW_DEALS.find((d) => now.includes(d)) ?? saved.deal;
  },
  { immediate: true },
);
defineExpose({ pickDeal, openNews });

/** 새 소식이 먼저, 그다음 싼 순서(월세는 월세 → 보증금). 가장 싼 칸에서는 반전세가 위로 온다. */
function sortEntries(a: Entry, b: Entry) {
  return (
    Number(hasNews(b.listing)) - Number(hasNews(a.listing)) ||
    (a.value ?? Infinity) - (b.value ?? Infinity) ||
    (a.option.deposit ?? Infinity) - (b.option.deposit ?? Infinity) ||
    b.listing.firstSeenAt.localeCompare(a.listing.firstSeenAt)
  );
}

const edges = computed(() => EDGES[deal.value]);

/** 왼쪽 필터에서 지역 칸만 남긴 것(가격, 매물 유형, 면적, 층, 검색어를 뺌). 가격대마다 필터로 가린 수를 셀 때 쓴다. */
const looseFilters = computed<Filters>(() => ({
  ...DEFAULT_FILTERS,
  areaIds: props.filters.areaIds,
  insideAreas: props.filters.insideAreas,
  distanceMax: props.filters.distanceMax,
}));

/** 고른 거래 유형의 가격대별 매물 수(지역 칸만 적용). 필터를 통과한 수와의 차이가 '필터로 가림'이다. */
const looseByBand = computed(() => {
  const d = deal.value;
  const counts = new Map<string, number>();
  for (const listing of props.listings) {
    const options = dealOptions(listing, d, looseFilters.value, props.areas);
    if (!options.length) continue;
    const id = bandIdOf(bandValue(d, cheapest(d, options)), edges.value);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
});

const rows = computed(() => {
  const d = deal.value;
  const groups = new Map<string, Entry[]>();
  for (const e of byDeal.value.get(d) ?? []) {
    const id = bandIdOf(e.value, edges.value);
    const list = groups.get(id);
    if (list) list.push(e);
    else groups.set(id, [e]);
  }
  const defs = new Map(bandsFor(d, edges.value).map((b) => [b.id, b]));
  const open = saved.open[d] ?? {};
  return orderFor(d, saved.order[d], edges.value)
    .map((id) => {
      const entries = (groups.get(id) ?? []).sort(sortEntries);
      return rowOf(defs.get(id)!, entries, open, Math.max(0, (looseByBand.value.get(id) ?? 0) - entries.length));
    })
    .filter((r) => r.band.id !== 'unknown' || r.total > 0);
});
type Row = ReturnType<typeof rowOf>;

/** 가격대 줄 하나(또는 맨 위 새 소식 줄): 건수, 사이트별 건수, 월세 보증금 범위, 펼침과 고른 사이트, 펼쳐 보이는 매물. hidden은 필터로 가린 수. */
function rowOf(band: Band, entries: Entry[], open: Record<string, Pick>, hidden: number) {
  const platforms = SOURCES.map((s) => ({ id: s, label: SOURCE_LABEL[s], ...counts(entries.filter((e) => e.listing.source === s)) })).filter((p) => p.total > 0);
  const deposits = isRent(deal.value) && band.id !== NEWS_BAND.id ? entries.map((e) => e.option.deposit).filter((v): v is number => v != null) : [];
  const pick = open[band.id];
  const shown = !pick ? [] : pick === 'all' ? entries : entries.filter((e) => e.listing.source === pick);
  return {
    band,
    ...counts(entries),
    hidden,
    platforms,
    deposit: deposits.length ? { min: Math.min(...deposits), max: Math.max(...deposits) } : null,
    isOpen: pick !== undefined,
    pick: pick ?? '',
    shown,
  };
}

/** 가격대 줄 위에 고정해 두는 새 소식 줄(끌어서 옮기지 않음) */
const NEWS_BAND: Band = { id: 'news', label: '새 소식', range: '가격대와 상관없이 신규나 가격 변동이 있는 매물(신규 먼저, 그다음 최근에 처음 본 순서)' };
/** 고른 거래 유형에서 신규나 가격 변동이 있는 매물을 모은 줄. 없으면 null. */
const newsRow = computed(() => {
  const entries = (byDeal.value.get(deal.value) ?? [])
    .filter((e) => hasNews(e.listing))
    .sort((a, b) => Number(b.listing.isNew) - Number(a.listing.isNew) || b.listing.firstSeenAt.localeCompare(a.listing.firstSeenAt));
  return entries.length ? rowOf(NEWS_BAND, entries, saved.open[deal.value] ?? {}, 0) : null;
});
/** 화면에 그리는 줄: 새 소식 줄(있으면) 다음 가격대 줄 */
const shownRows = computed(() => (newsRow.value ? [newsRow.value, ...rows.value] : rows.value));

/** 펼쳐 보이는 매물(화면 순서, 새 소식 줄과 가격대 줄에 같이 보이는 매물은 한 번만) */
const visible = computed(() => {
  const ids = new Set<string>();
  const out: ListingView[] = [];
  for (const r of shownRows.value) {
    for (const e of r.shown) {
      if (ids.has(e.listing.id)) continue;
      ids.add(e.listing.id);
      out.push(e.listing);
    }
  }
  return out;
});
/** 목록 쪽에서 가격대를 펼치거나 접고 사이트를 고른 횟수. 지도에서 누른 매물을 보이게 펼칠 때는 늘리지 않는다. */
const listMoves = ref(0);
/** 지도를 매물에 다시 맞추는 기준: 거래 유형, 목록 쪽에서 바꾼 펼침, 고른 지역. 매물만 바뀌거나 지도에서 누른 매물을 펼치면 지도는 보던 그대로 둔다. */
const mapFitKey = computed(() => `${deal.value}|${listMoves.value}|${props.filters.areaIds.join(',')}`);
/** 지도: 펼친 목록이 없으면 고른 거래 유형의 매물을 작게 보여 준다. */
const mapBackground = computed(() => (byDeal.value.get(deal.value) ?? []).map((e) => e.listing));
watch(visible, (v) => emit('visible', v), { immediate: true });

function openMap(): Record<string, Pick> {
  const d = deal.value;
  if (!saved.open[d]) saved.open[d] = {};
  return saved.open[d]!;
}

function toggleBand(r: Row) {
  if (!r.total) return;
  const open = openMap();
  if (r.isOpen) delete open[r.band.id];
  // 사이트가 하나뿐이면 목록까지 바로 연다.
  else open[r.band.id] = r.platforms.length === 1 ? r.platforms[0].id : '';
  listMoves.value++;
}

function pickPlatform(r: Row, p: SourceId | 'all') {
  openMap()[r.band.id] = r.pick === p ? '' : p;
  listMoves.value++;
}

/** 새 소식 줄을 펼쳐 모든 사이트의 새 소식을 보인다(새 매물 알림을 눌러 열었을 때). */
function openNews() {
  if (!newsRow.value) return;
  openMap()[NEWS_BAND.id] = 'all';
  listMoves.value++;
}

/**
 * 지도에서 누른 매물(같은 자리 매물들)이 목록에 보이게 그 가격대를 펼치고 사이트를 고른 뒤, focus(없으면 첫 매물)를 고른다.
 * 한 가격대에 사이트가 여럿 걸리거나 이미 '모든 사이트'면 모든 사이트로 둔다. 다른 가격대의 펼침은 그대로 둔다.
 */
async function reveal(items: ListingView[], focus: ListingView = items[0]) {
  const entries = byDeal.value.get(deal.value) ?? [];
  const need = new Map<string, Set<SourceId>>();
  for (const l of items) {
    const e = entries.find((x) => x.listing.id === l.id);
    if (!e) continue;
    const id = bandIdOf(e.value, edges.value);
    need.set(id, (need.get(id) ?? new Set()).add(l.source));
  }
  const open = openMap();
  for (const [id, sources] of need) {
    if (open[id] === 'all' || (sources.size === 1 && sources.has(open[id] as SourceId))) continue;
    open[id] = sources.size === 1 ? [...sources][0] : 'all';
  }
  await nextTick();
  if (focus) emit('select', focus);
}

const depositText = (d: { min: number; max: number }) => (d.min === d.max ? money(d.min) : `${money(d.min)}~${money(d.max)}`);

// 가격대 순서 바꾸기: ⠿ 부분을 끌어 놓거나, 가격대에 초점을 두고 Alt+↑↓.
const dragging = ref<string | null>(null);
const dropAt = ref<{ id: string; after: boolean } | null>(null);

/** 보이는 가격대의 새 순서를 저장한다. 숨은 가격대(매물 없는 '금액 모름')는 뒤에 둔다. */
function reorder(ids: string[]) {
  const d = deal.value;
  saved.order[d] = [...ids, ...orderFor(d, saved.order[d], edges.value).filter((id) => !ids.includes(id))];
}

function onDragStart(e: DragEvent, id: string) {
  dragging.value = id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }
}

function onDragOver(e: DragEvent, id: string) {
  if (!dragging.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  // 펼친 가격대는 머리 줄을 기준으로 위인지 아래인지 정한다.
  const head = (e.currentTarget as HTMLElement).querySelector('.band-head')?.getBoundingClientRect();
  if (head) dropAt.value = { id, after: e.clientY > head.top + head.height / 2 };
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  const from = dragging.value;
  const to = dropAt.value;
  onDragEnd();
  if (!from || !to || from === to.id) return;
  const ids = rows.value.map((r) => r.band.id).filter((id) => id !== from);
  ids.splice(ids.indexOf(to.id) + (to.after ? 1 : 0), 0, from);
  reorder(ids);
}

function onDragEnd() {
  dragging.value = null;
  dropAt.value = null;
}

async function nudge(id: string, delta: number, e: KeyboardEvent) {
  const el = e.currentTarget as HTMLElement;
  const ids = rows.value.map((r) => r.band.id);
  const i = ids.indexOf(id);
  const j = i + delta;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  reorder(ids);
  await nextTick();
  el.focus();
}
</script>

<template>
  <section ref="overviewEl" class="overview">
    <div class="ov-controls">
    <div v-if="areas.length > 1" class="area-chips" role="tablist" aria-label="지역">
      <button class="area-chip" :class="{ on: allAreas }" role="tab" :aria-selected="allAreas" @click="emit('areas', [])">
        모든 지역 <span class="num">{{ areaChips.all }}</span>
      </button>
      <button
        v-for="a in areaChips.list" :key="a.id" class="area-chip" :class="{ on: a.on }" role="tab"
        :aria-selected="a.on" @click="emit('areas', [a.id])"
      >
        {{ a.label }} <span class="num">{{ a.count }}</span>
      </button>
    </div>

    <div class="deals" role="tablist" aria-label="거래 유형">
      <button
        v-for="(c, i) in dealCards" :key="c.deal" class="deal" :class="{ on: c.deal === deal }" role="tab"
        :aria-selected="c.deal === deal" :aria-keyshortcuts="String(i + 1)" @click="pickCard(c.deal)"
      >
        <span class="deal-label">{{ c.label }}</span>
        <CountTooltip class="deal-total num" :focusable="false" :text="`신규 ${c.news}건\n가격 변동 ${c.changed}건\n반경 밖 ${c.outside}건\n숫자 ${i + 1}번 키로 선택`">{{ c.total }}건</CountTooltip>
      </button>
    </div>

    </div>

    <div class="ov-split">
      <div class="ov-bands">
        <div class="bands" @dragend="onDragEnd">
          <div
            v-for="r in shownRows" :key="r.band.id" class="band"
            :class="{
              news: r.band.id === NEWS_BAND.id,
              open: r.isOpen,
              zero: !r.total,
              dragging: dragging === r.band.id,
              'drop-before': dropAt?.id === r.band.id && !dropAt.after,
              'drop-after': dropAt?.id === r.band.id && dropAt.after,
            }"
            @dragover="r.band.id !== NEWS_BAND.id && onDragOver($event, r.band.id)" @drop="r.band.id !== NEWS_BAND.id && onDrop($event)"
          >
            <div
              class="band-head" role="button" tabindex="0" :draggable="r.band.id !== NEWS_BAND.id" :aria-expanded="r.isOpen" :title="r.band.range"
              @dragstart="onDragStart($event, r.band.id)" @click="toggleBand(r)"
              @keydown.space.stop.prevent="toggleBand(r)"
              @keydown.alt.up.stop.prevent="nudge(r.band.id, -1, $event)" @keydown.alt.down.stop.prevent="nudge(r.band.id, 1, $event)"
            >
              <span class="grip" :class="{ off: r.band.id === NEWS_BAND.id }" title="끌어서 순서 바꾸기" aria-hidden="true">⠿</span>
              <span class="band-label">{{ r.band.label }}</span>
              <span class="band-total num" :class="{ off: !r.total && r.hidden }">{{ !r.total && r.hidden ? `필터로 가림 ${r.hidden}건` : `${r.total}건` }}</span>
              <span v-if="r.total && r.hidden" class="band-sub hid" title="왼쪽 필터(가격, 매물 유형, 면적, 층, 검색어)에 안 맞아 가린 매물">필터로 가림 {{ r.hidden }}</span>
              <span v-if="r.news" class="chip chip-new">신규 {{ r.news }}</span>
              <span v-if="r.changed" class="chip chip-down">가격 변동 {{ r.changed }}</span>
              <span v-if="r.deposit" class="band-sub num">보증금 {{ depositText(r.deposit) }}</span>
              <span v-if="!r.isOpen && r.platforms.length" class="band-sub">{{ r.platforms.map((p) => `${p.label} ${p.total}`).join(', ') }}</span>
              <span v-if="r.total" class="chev" aria-hidden="true">{{ r.isOpen ? '접기 ▴' : '펼치기 ▾' }}</span>
            </div>

            <div v-if="r.isOpen" class="band-body">
              <div class="platforms">
                <button v-if="r.platforms.length > 1" class="platform" :class="{ on: r.pick === 'all' }" @click="pickPlatform(r, 'all')">
                  모든 사이트 <span class="num">{{ r.total }}</span>
                </button>
                <button v-for="p in r.platforms" :key="p.id" class="platform" :class="{ on: r.pick === p.id }" @click="pickPlatform(r, p.id)">
                  {{ p.label }} <span class="num">{{ p.total }}</span>
                  <span v-if="p.news" class="chip chip-new">신규 {{ p.news }}</span>
                  <span v-if="p.changed" class="chip chip-down">변동 {{ p.changed }}</span>
                </button>
              </div>
              <div v-if="r.shown.length" class="list">
                <ListingCard
                  v-for="e in r.shown" :key="e.listing.id" :listing="e.listing" :areas="areas" :selected="e.listing.id === selectedId"
                  @select="emit('select', e.listing)" @open="emit('open', e.listing)" @verdict="(v) => emit('verdict', e.listing, v)"
                  @source="emit('source', e.listing)" @raw="emit('raw', e.listing)"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      <aside ref="mapPanel" class="ov-map" :style="mapPanelHeight ? { '--map-panel-height': `${mapPanelHeight}px` } : undefined">
        <OverviewMap
          :listings="visible" :background="mapBackground" :areas="areas" :selected-id="selectedId" :fit-key="mapFitKey"
          @select="(l) => reveal([l])" @reveal="reveal" @open="(l) => emit('open', l)" @pick="(p) => emit('pick', p)" @area="(a) => emit('area', a)"
          @station="(s) => emit('station', s)"
        />
      </aside>
    </div>
  </section>
</template>

<style scoped>
.overview { display: grid; gap: 14px; }
.ov-controls { display: contents; }
.small { font-size: 13px; }

.deals { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
.deal {
  display: grid; gap: 2px; justify-items: start; align-content: start;
  min-height: 104px; padding: 14px 16px; text-align: left;
  border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface);
}
.deal:hover { border-color: var(--ink-2); }
.deal.on { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent) inset; background: var(--accent-soft); }
.deal-label { font-size: 15px; font-weight: 700; color: var(--ink-2); }
.deal-total { font-size: 28px; font-weight: 800; line-height: 1.2; letter-spacing: -0.02em; }

/* 가격대 목록(왼쪽)과 지도(오른쪽, 따라 내려옴). 좁으면 지도가 위로 간다. */
.ov-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 45%); gap: 16px; align-items: start; }
.ov-bands { display: grid; gap: 14px; min-width: 0; }
.ov-map { position: sticky; top: 92px; height: calc(100vh - 108px); min-height: 420px; }
/* 크게 보기일 때는 위쪽 머리 줄(z-index 20)보다 위에 오게 한다. */
.ov-map:has(.ovmap.big) { z-index: 70; }
@media (max-width: 1280px) {
  .ov-split { grid-template-columns: 1fr; }
  .ov-map { position: static; order: -1; height: auto; min-height: 0; }
}

.area-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.area-chip {
  display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px;
  border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); font-size: 14px; font-weight: 700; color: var(--ink-2);
}
.area-chip:hover { border-color: var(--ink-2); }
.area-chip.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.area-chip .num { font-weight: 600; opacity: .8; }
.bands { display: grid; gap: 8px; }
.band { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); transition: box-shadow .12s; }
.band.open { border-color: var(--line-strong); }
.band.zero { background: transparent; }
.band.zero .band-head { cursor: default; color: var(--muted); }
.band.dragging { opacity: .4; }
.band.drop-before { box-shadow: 0 -4px 0 0 var(--accent); }
.band.drop-after { box-shadow: 0 4px 0 0 var(--accent); }
.band-head {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px;
  min-height: 60px; padding: 8px 16px 8px 6px; cursor: pointer; user-select: none; border-radius: 12px;
}
.band.zero .band-head { min-height: 44px; }
.grip { padding: 6px 4px 6px 8px; font-size: 18px; line-height: 1; color: var(--muted); cursor: grab; }
/* 새 소식 줄은 옮기지 않아서 손잡이 자리만 남긴다(이름이 가격대 이름과 같은 자리에 오게). */
.grip.off { visibility: hidden; }
.band-label { min-width: 116px; font-size: 18px; font-weight: 800; letter-spacing: -0.01em; }
.band.zero .band-label { font-size: 15px; font-weight: 700; }
.band-total { min-width: 52px; font-size: 17px; font-weight: 700; }
.band.zero .band-total { font-size: 14px; font-weight: 600; }
.band-total.off { min-width: 0; font-size: 14px; font-weight: 600; color: var(--muted); }
.band-sub { font-size: 13px; color: var(--muted); }
.chev { margin-left: auto; font-size: 13px; font-weight: 600; color: var(--muted); }
.band-body { display: grid; gap: 12px; padding: 0 16px 16px; }
.platforms { display: flex; flex-wrap: wrap; gap: 8px; padding-left: 26px; }
.platform {
  display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 16px;
  border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface); font-weight: 700;
}
.platform:hover { border-color: var(--ink-2); }
.platform.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.platform .num { font-weight: 600; opacity: .8; }
.list { display: grid; gap: 8px; container-type: inline-size; }
.empty { padding: 32px 0; text-align: center; }
</style>
