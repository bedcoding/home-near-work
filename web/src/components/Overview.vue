<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { SOURCE_LABEL, type Area, type DealType, type ListingView, type PriceOption, type SourceId, type Verdict } from '../../../shared/types';
import {
  bandDeal, bandIdOf, bandsFor, bandValue, DEALS_OF, isRent, OVERVIEW_DEALS, OVERVIEW_LABEL, orderFor, overviewDealOf, type Band, type OverviewDeal,
} from '../bands';
import { DEFAULT_FILTERS, dealOptions, passes, plainFilters, type Filters } from '../filters';
import type { CatalogStation } from '../areaActions';
import { money, radiusText } from '../format';
import { areaMatches, hasRegions, primaryAreas } from '../../../shared/regions';
import CountTooltip from './CountTooltip.vue';
import ListingCard from './ListingCard.vue';
import OverviewMap from './OverviewMap.vue';
import SplitHandle from './SplitHandle.vue';
import { mapShareStyle } from '../mapWidth';
import { walkPins, walkTimes } from '../walk';

const props = defineProps<{ listings: ListingView[]; filters: Filters; areas: Area[]; selectedId: string | null; panToSelected?: boolean }>();
/** 필터의 평범한 복사본. 매물 수만 건을 도는 계산은 props.filters(반응형) 대신 이것을 반복 밖에서 한 번 읽는다. */
const filtersNow = computed(() => plainFilters(props.filters));
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
  deal: OverviewDeal;
  /** 카드별 가격대 순서(끌어서 바꾼 것) */
  order: Partial<Record<OverviewDeal, string[]>>;
  /** 카드별로 펼친 가격대와 고른 사이트 */
  open: Partial<Record<OverviewDeal, Record<string, Pick>>>;
}

/** 예전에 맨 위에 두던 새 소식 줄의 id. 저장된 펼침을 옮길 때 가격대 id로 바꾸지 않으려고 남겨 둔다. */
const NEWS_ID = 'news';

// 다음에 열어도 고른 카드, 펼친 가격대, 순서가 그대로 보이게 저장한다. 읽을 때는 이 세 값만 남긴다.
// 예전 월세, 전세 카드를 골라 두었으면 전월세로 열고, 그 카드의 순서와 펼침은 전월세 카드의 월세, 전세 가격대로 옮긴다.
const KEY = 'hnw-overview-v1';
function load(): Saved {
  const empty: Saved = { deal: 'rent', order: {}, open: {} };
  const known = <T,>(rec: Partial<Record<string, T>> | undefined) =>
    Object.fromEntries(Object.entries(rec ?? {}).filter(([k]) => (OVERVIEW_DEALS as string[]).includes(k))) as Partial<Record<OverviewDeal, T>>;
  const rentId = (d: 'monthly' | 'jeonse', id: string) => (id === 'unknown' || id === NEWS_ID ? id : `${d}:${id}`);
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { deal?: string; order?: Record<string, string[]>; open?: Record<string, Record<string, Pick>> } | null;
    if (!s) return empty;
    const deal = (OVERVIEW_DEALS as string[]).includes(s.deal ?? '') ? (s.deal as OverviewDeal) : (overviewDealOf(s.deal as DealType) ?? empty.deal);
    const order = known(s.order);
    const open = known(s.open);
    if (!order.rent && (s.order?.monthly || s.order?.jeonse)) {
      order.rent = [...(s.order.monthly ?? []).map((id) => rentId('monthly', id)), ...(s.order.jeonse ?? []).map((id) => rentId('jeonse', id))];
    }
    if (!open.rent && (s.open?.monthly || s.open?.jeonse)) {
      open.rent = Object.fromEntries([
        ...Object.entries(s.open.monthly ?? {}).map(([id, v]) => [rentId('monthly', id), v]),
        ...Object.entries(s.open.jeonse ?? {}).map(([id, v]) => [rentId('jeonse', id), v]),
      ]);
    }
    return { deal, order, open };
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

/** 가격대 줄의 매물 하나. 전월세 카드에서 월세와 전세를 다 내놓은 매물은 월세 가격대와 전세 가격대에 하나씩 든다. */
interface Entry {
  listing: ListingView;
  /** 가격대를 정한 가격 선택지 */
  option: PriceOption;
  value: number | null;
}

/** 같은 거래 유형의 가격 선택지가 여럿이면 가장 싼 것(같으면 보증금이 낮은 것)으로 가격대를 정한다. */
function cheapest(options: PriceOption[]): PriceOption {
  const key = (p: PriceOption) => bandValue(p) ?? Infinity;
  const deposit = (p: PriceOption) => p.deposit ?? Infinity;
  return options.reduce((a, b) => (key(b) < key(a) || (key(b) === key(a) && deposit(b) < deposit(a)) ? b : a));
}

/** 매물마다 하나만 남긴다(카드 건수, 지도, 새 소식 줄). */
const uniq = (entries: Entry[]) => [...new Map(entries.map((e) => [e.listing.id, e])).values()];

// ---------- 지역 ----------
// 켜진 지역이 둘 이상이면 지역마다 따로 볼 수 있다.
// 고른 지역은 왼쪽 필터의 지역(filters.areaIds)과 같은 값이라, 여기서 누르면 필터 칸도 바뀐다.
/**
 * 지역 칸의 건수: 그 지역만 골랐을 때 필터를 통과하는 매물 수.
 * 필터는 반복 밖에서 한 번만 만들어 쓴다(예전처럼 매물마다 반응형 필터를 펼치면 이 계산 하나에 1.6초씩 걸렸다).
 */
const areaChips = computed(() => {
  const f = filtersNow.value;
  const areas = props.areas;
  const listings = props.listings;
  const primary = primaryAreas(areas);
  let all = 0;
  let counts: number[];
  if (hasRegions(areas)) {
    // 구나 동 지역: 그 지역만 고른 건수는 지역을 고르지 않은 필터를 통과하면서 그 지역 안인 매물 수다(passes와 같은 규칙).
    // 필터는 매물마다 한 번만 보고, 지역 안인지는 매물마다 기억해 둔 판정(matchesRegion)을 쓴다.
    const base = { ...f, areaIds: [] };
    counts = primary.map(() => 0);
    for (const l of listings) {
      if (!passes(l, base, areas)) continue;
      all++;
      for (let i = 0; i < primary.length; i++) if (areaMatches(l, primary[i])) counts[i]++;
    }
  } else {
    // 역 반경 지역은 '가장 가까운 지역이 고른 지역인 매물' 규칙이 있어 지역마다 필터를 그대로 돌린다.
    const count = (areaIds: number[]) => {
      const g = { ...f, areaIds };
      let n = 0;
      for (const l of listings) if (passes(l, g, areas)) n++;
      return n;
    };
    all = count([]);
    counts = primary.map((a) => count([a.id]));
  }
  return {
    all,
    list: primary.map((a, i) => ({
      id: a.id,
      label: a.region ? `${a.name} ${a.region.kind === 'gu' ? '전체' : '법정동'}` : `${a.name} ${radiusText(a.radiusM)}`,
      count: counts[i],
      on: f.areaIds.includes(a.id),
    })),
  };
});
const allAreas = computed(() => !primaryAreas(props.areas).some((a) => filtersNow.value.areaIds.includes(a.id)));
/** 지역이 이보다 많으면(노선 하나를 켠 때 등) 칸 대신 고르기 상자로 보인다(매물이 많은 지역 먼저). */
const AREA_CHIP_MAX = 10;
const areaOptions = computed(() => [...areaChips.value.list].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ko')));
const pickedArea = computed(() => (props.filters.areaIds.length === 1 ? String(props.filters.areaIds[0]) : ''));
function pickArea(event: Event) {
  const v = (event.target as HTMLSelectElement).value;
  emit('areas', v ? [Number(v)] : []);
}

// ---------- 거래 유형 ----------
// 고른 거래 유형은 왼쪽 필터의 거래 유형과 같은 값이다. 카드를 누르면 필터도 그 하나로 바뀌고(deals 이벤트),
// 필터에서 거래 유형을 고르면 그 카드로 옮긴다. 카드의 건수는 거래 유형 필터를 빼고 센다(카드가 곧 거래 유형 고르기라서).
/** 거래 유형 필터를 뺀 필터 */
const anyDeal = computed<Filters>(() => ({ ...filtersNow.value, deals: [] }));

/** 카드에 드는 가격 선택지(전월세는 월세와 전세를 함께) */
const cardOptions = (listing: ListingView, deal: OverviewDeal, f: Filters, areas: Area[]) => DEALS_OF[deal].flatMap((d) => dealOptions(listing, d, f, areas));

/** 카드의 가격대 줄에 드는 매물들: 카드의 거래 유형마다(전월세는 월세와 전세 따로) 가장 싼 선택지 하나 */
function entriesOf(deal: OverviewDeal, f: Filters): Entry[] {
  const entries: Entry[] = [];
  const areas = props.areas;
  for (const listing of props.listings) {
    for (const d of DEALS_OF[deal]) {
      const options = dealOptions(listing, d, f, areas);
      if (!options.length) continue;
      const option = cheapest(options);
      entries.push({ listing, option, value: bandValue(option) });
    }
  }
  return entries;
}

const byDeal = computed(() => new Map(OVERVIEW_DEALS.map((deal) => [deal, entriesOf(deal, anyDeal.value)])));

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
  const out = new Map<OverviewDeal, number>();
  if (!filtersNow.value.insideAreas) return out;
  const strict = anyDeal.value;
  const loose = { ...strict, insideAreas: false };
  const areas = props.areas;
  for (const deal of OVERVIEW_DEALS) {
    let n = 0;
    for (const l of props.listings) if (cardOptions(l, deal, loose, areas).length && !cardOptions(l, deal, strict, areas).length) n++;
    out.set(deal, n);
  }
  return out;
});

/** 전월세와 매매는 늘 보이고, 단기는 매물이 있을 때(반경 밖 포함)나 골라 둔 때만 보인다. */
const dealCards = computed(() =>
  OVERVIEW_DEALS.map((deal) => ({
    deal,
    label: OVERVIEW_LABEL[deal],
    ...counts(uniq(byDeal.value.get(deal) ?? [])),
    outside: outsideByDeal.value.get(deal) ?? 0,
  })).filter((c) => c.total > 0 || c.outside > 0 || c.deal !== 'short' || c.deal === saved.deal),
);

const deal = computed<OverviewDeal>(() => (dealCards.value.some((c) => c.deal === saved.deal) ? saved.deal : 'rent'));

/** 카드(또는 숫자 키)로 거래 유형을 고른다. 왼쪽 필터도 그 카드의 거래 유형(전월세면 월세와 전세)으로 바뀐다. */
function pickCard(d: OverviewDeal) {
  saved.deal = d;
  emit('deals', [...DEALS_OF[d]]);
}

function pickDeal(index: number) {
  const card = dealCards.value[index];
  if (card) pickCard(card.deal);
}

// 왼쪽 필터에서 거래 유형을 새로 켜면 그 카드로, 지금 카드가 필터에서 빠지면 남은 것 중 첫 카드로 옮긴다. '전체'면 그대로 둔다.
// 필터 거래 유형은 고른 카드의 거래 유형과 같게 맞춘다(예전에 월세만 골라 두었으면 월세와 전세로).
watch(
  () => [...new Set(props.filters.deals.map(overviewDealOf).filter((d): d is OverviewDeal => d != null))],
  (now, before) => {
    const added = before ? now.find((d) => !before.includes(d)) : undefined;
    if (added) saved.deal = added;
    else if (now.length && !now.includes(saved.deal)) saved.deal = OVERVIEW_DEALS.find((d) => now.includes(d)) ?? saved.deal;
    const want = DEALS_OF[saved.deal];
    const deals = props.filters.deals;
    if (deals.length && (deals.length !== want.length || !want.every((d) => deals.includes(d)))) emit('deals', [...want]);
  },
  { immediate: true },
);
defineExpose({ pickDeal });

/** 목록 순서: 빈 글자면 가격순, 거리 핀 id면 그 핀까지 걷는 거리가 가까운 순(localStorage 'hnw-overview-sort') */
const SORT_KEY = 'hnw-overview-sort';
const sortPin = ref(readSortPin());
function readSortPin() {
  try {
    return localStorage.getItem(SORT_KEY) ?? '';
  } catch {
    return '';
  }
}
watch(sortPin, (id) => {
  try {
    localStorage.setItem(SORT_KEY, id);
  } catch {
    // 저장소를 못 쓰면 이번 화면에서만 쓴다.
  }
});
/** 거리순으로 고를 수 있는 핀(거리 핀만) */
const distancePins = computed(() => walkPins.value.filter((p) => p.kind !== 'mark'));
/** 지금 거리순으로 보는 핀 id(고른 핀을 뺐으면 null, 가격순) */
const sortPinId = computed(() => distancePins.value.find((p) => p.id === sortPin.value)?.id ?? null);

/** 별로로 표시한 매물은 맨 뒤 */
const byMeh = (a: ListingView, b: ListingView) => Number(a.verdict === 'meh') - Number(b.verdict === 'meh');

/**
 * 가격대 안 순서. 별로는 맨 뒤. 가격순이면 새 소식이 먼저, 그다음 싼 순서(전월세는 환산 월세 → 보증금).
 * 거리순(pinId)이면 고른 핀에 가까운 순서(못 잰 매물은 뒤), 같으면 가격순.
 * 핀까지 거리는 정렬 전에 매물마다 한 번만 읽어 둔다(견줄 때마다 읽으면 반응형 값을 수십만 번 읽게 된다).
 */
function entryOrder(pinId: string | null, entries: Entry[]) {
  const meters = pinId
    ? new Map(entries.map((e) => [e.listing.id, walkTimes(e.listing.id).find((w) => w.pin.id === pinId)?.meters ?? Infinity]))
    : null;
  const byPin = (a: ListingView, b: ListingView) => {
    if (!meters) return 0;
    const d = meters.get(a.id)! - meters.get(b.id)!;
    return Number.isNaN(d) ? 0 : d;
  };
  return (a: Entry, b: Entry) =>
    byMeh(a.listing, b.listing) ||
    byPin(a.listing, b.listing) ||
    Number(hasNews(b.listing)) - Number(hasNews(a.listing)) ||
    (a.value ?? Infinity) - (b.value ?? Infinity) ||
    (a.option.deposit ?? Infinity) - (b.option.deposit ?? Infinity) ||
    b.listing.firstSeenAt.localeCompare(a.listing.firstSeenAt);
}

/** 왼쪽 필터에서 지역 칸만 남긴 것(가격, 매물 유형, 면적, 층, 검색어를 뺌). 가격대마다 필터로 가린 수를 셀 때 쓴다. */
const looseFilters = computed<Filters>(() => {
  const f = filtersNow.value;
  return { ...DEFAULT_FILTERS, areaIds: f.areaIds, insideAreas: f.insideAreas, distanceMax: f.distanceMax };
});

/** 고른 카드의 가격대별 매물 수(지역 칸만 적용). 필터를 통과한 수와의 차이가 '필터로 가림'이다. */
const looseByBand = computed(() => {
  const d = deal.value;
  const counts = new Map<string, number>();
  for (const e of entriesOf(d, looseFilters.value)) {
    const id = bandIdOf(d, e.option);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
});

const rows = computed(() => {
  const d = deal.value;
  const groups = new Map<string, Entry[]>();
  for (const e of byDeal.value.get(d) ?? []) {
    const id = bandIdOf(d, e.option);
    const list = groups.get(id);
    if (list) list.push(e);
    else groups.set(id, [e]);
  }
  const defs = new Map(bandsFor(d).map((b) => [b.id, b]));
  const open = saved.open[d] ?? {};
  const pinId = sortPinId.value;
  return orderFor(d, saved.order[d])
    .map((id) => {
      const list = groups.get(id) ?? [];
      const entries = list.sort(entryOrder(pinId, list));
      return rowOf(defs.get(id)!, entries, open, Math.max(0, (looseByBand.value.get(id) ?? 0) - entries.length));
    })
    .filter((r) => r.band.id !== 'unknown' || r.total > 0);
});
type Row = ReturnType<typeof rowOf>;

/** 가격대 줄 하나: 건수, 사이트별 건수, 월세 보증금 범위, 펼침과 고른 사이트, 펼쳐 보이는 매물. hidden은 필터로 가린 수. */
function rowOf(band: Band, entries: Entry[], open: Record<string, Pick>, hidden: number) {
  const platforms = SOURCES.map((s) => ({ id: s, label: SOURCE_LABEL[s], ...counts(entries.filter((e) => e.listing.source === s)) })).filter((p) => p.total > 0);
  const bd = bandDeal(deal.value, band.id);
  const deposits = bd && isRent(bd) ? entries.map((e) => e.option.deposit).filter((v): v is number => v != null) : [];
  const pick = open[band.id];
  const shown = !pick ? [] : pick === 'all' ? entries : entries.filter((e) => e.listing.source === pick);
  return {
    band,
    ...counts(entries),
    /** 이 줄의 매물 전부(지도에 진하게 보일 때 씀) */
    entries,
    hidden,
    platforms,
    deposit: deposits.length ? { min: Math.min(...deposits), max: Math.max(...deposits) } : null,
    isOpen: pick !== undefined,
    pick: pick ?? '',
    shown,
  };
}

// 맨 위 '새 소식' 줄은 뺐다. 보는 가격대만 펼쳐 보므로, 새 매물은 가격대마다 붙은 신규와 가격 변동 표시로 본다.

/** 펼쳐 보이는 매물(화면 순서, 여러 가격대에 같이 보이는 매물은 한 번만) */
const visible = computed(() => {
  const ids = new Set<string>();
  const out: ListingView[] = [];
  for (const r of rows.value) {
    for (const e of r.shown) {
      if (ids.has(e.listing.id)) continue;
      ids.add(e.listing.id);
      out.push(e.listing);
    }
  }
  return out;
});
/**
 * 지도에 진하게 보일 매물: 펼친 가격대마다 고른 사이트의 매물, 사이트를 아직 안 골랐으면 그 가격대 매물 전부.
 * 그래서 '월세 50만원 이하'와 '전세 1억 이하'처럼 가격대 여러 개를 펼치기만 해도 지도에서 같이 본다.
 * 목록 카드는 지금처럼 사이트를 고른 뒤에 그린다(한 가격대에 수천 건이면 카드를 다 그리기 느려서).
 */
const mapStrong = computed(() => {
  const ids = new Set<string>();
  const out: ListingView[] = [];
  for (const r of rows.value) {
    if (!r.isOpen) continue;
    for (const e of r.pick && r.pick !== 'all' ? r.shown : r.entries) {
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
const mapBackground = computed(() => uniq(byDeal.value.get(deal.value) ?? []).map((e) => e.listing));
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
    const id = bandIdOf(deal.value, e.option);
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
  saved.order[d] = [...ids, ...orderFor(d, saved.order[d]).filter((id) => !ids.includes(id))];
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
  <section ref="overviewEl" class="overview" :style="mapShareStyle">
    <div class="ov-controls">
    <div v-if="areas.length > 1" class="area-chips" role="tablist" aria-label="지역">
      <button class="area-chip" :class="{ on: allAreas }" role="tab" :aria-selected="allAreas" @click="emit('areas', [])">
        모든 지역 <span class="num">{{ areaChips.all }}</span>
      </button>
      <template v-if="areaChips.list.length <= AREA_CHIP_MAX">
        <button
          v-for="a in areaChips.list" :key="a.id" class="area-chip" :class="{ on: a.on }" role="tab"
          :aria-selected="a.on" @click="emit('areas', [a.id])"
        >
          {{ a.label }} <span class="num">{{ a.count }}</span>
        </button>
      </template>
      <select v-else class="area-pick" :class="{ on: !allAreas }" :value="pickedArea" aria-label="지역 하나만 보기" @change="pickArea">
        <option value="">지역 하나만 보기 ({{ areaChips.list.length }}곳)</option>
        <option v-for="a in areaOptions" :key="a.id" :value="String(a.id)">{{ a.label }}, {{ a.count }}건</option>
      </select>
    </div>

    <div class="deals" role="tablist" aria-label="거래 유형">
      <button
        v-for="(c, i) in dealCards" :key="c.deal" class="deal" :class="{ on: c.deal === deal }" role="tab"
        :aria-selected="c.deal === deal" :aria-keyshortcuts="String(i + 1)" @click="pickCard(c.deal)"
      >
        <span class="deal-label">{{ c.label }}</span>
        <CountTooltip class="deal-total num" :focusable="false" :text="`신규 ${c.news}건\n가격 변동 ${c.changed}건\n선택 지역 밖 ${c.outside}건\n숫자 ${i + 1}번 키로 선택`">{{ c.total }}건</CountTooltip>
      </button>
    </div>

    </div>

    <div class="ov-split">
      <div class="ov-bands">
        <div class="bands" @dragend="onDragEnd">
          <div
            v-for="r in rows" :key="r.band.id" class="band"
            :class="{
              open: r.isOpen,
              zero: !r.total,
              dragging: dragging === r.band.id,
              'drop-before': dropAt?.id === r.band.id && !dropAt.after,
              'drop-after': dropAt?.id === r.band.id && dropAt.after,
            }"
            @dragover="onDragOver($event, r.band.id)" @drop="onDrop($event)"
          >
            <div
              class="band-head" role="button" tabindex="0" draggable="true" :aria-expanded="r.isOpen" :title="r.band.range"
              @dragstart="onDragStart($event, r.band.id)" @click="toggleBand(r)"
              @keydown.space.stop.prevent="toggleBand(r)"
              @keydown.alt.up.stop.prevent="nudge(r.band.id, -1, $event)" @keydown.alt.down.stop.prevent="nudge(r.band.id, 1, $event)"
            >
              <span class="grip" title="끌어서 순서 바꾸기" aria-hidden="true">⠿</span>
              <span class="band-label">{{ r.band.label }}</span>
              <span class="band-total num" :class="{ off: !r.total && r.hidden }">{{ !r.total && r.hidden ? `필터로 가림 ${r.hidden}건` : `${r.total}건` }}</span>
              <span v-if="r.total && r.hidden" class="band-sub hid" title="왼쪽 필터(가격, 매물 유형, 면적, 층, 검색어)에 안 맞아 가린 매물">필터로 가림 {{ r.hidden }}</span>
              <span v-if="r.deposit" class="band-sub num">보증금 {{ depositText(r.deposit) }}</span>
              <!-- 오른쪽 끝: 신규, 가격 변동, 펼치기. 칸마다 같은 자리에 오게 모은다(사이트별 건수는 펼치면 보인다). -->
              <span class="band-end">
                <span v-if="r.news" class="chip chip-new">신규 {{ r.news }}</span>
                <span v-if="r.changed" class="chip chip-down">가격 변동 {{ r.changed }}</span>
                <span v-if="r.total" class="chev" aria-hidden="true">{{ r.isOpen ? '접기 ▴' : '펼치기 ▾' }}</span>
              </span>
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
                <div v-if="distancePins.length && r.shown.length > 1" class="sort" role="group" aria-label="목록 순서">
                  <button class="sort-btn" :class="{ on: !sortPinId }" :aria-pressed="!sortPinId" title="새 소식 먼저, 그다음 싼 순서" @click="sortPin = ''">가격순</button>
                  <button
                    v-for="p in distancePins" :key="p.id" class="sort-btn" :class="{ on: sortPinId === p.id }" :aria-pressed="sortPinId === p.id"
                    :title="`${p.name}까지 걷는 거리가 가까운 순서(거리를 못 잰 매물은 뒤)`" @click="sortPin = p.id"
                  >{{ p.name }} 가까운 순</button>
                </div>
              </div>
              <div v-if="r.shown.length" class="list">
                <ListingCard
                  v-for="e in r.shown" :key="e.listing.id" :listing="e.listing" :areas="areas" :selected="e.listing.id === selectedId"
                  @select="emit('select', e.listing)" @open="emit('open', e.listing)" @verdict="(v) => emit('verdict', e.listing, v)"
                  @source="emit('source', e.listing)" @raw="emit('raw', e.listing)" zone-banner
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      <SplitHandle />
      <aside ref="mapPanel" class="ov-map" :style="mapPanelHeight ? { '--map-panel-height': `${mapPanelHeight}px` } : undefined">
        <OverviewMap
          :listings="mapStrong" :background="mapBackground" :areas="areas" :selected-id="selectedId" :pan-to-selected="panToSelected" :fit-key="mapFitKey"
          @select="(l) => reveal([l])" @reveal="reveal" @open="(l) => emit('open', l)" @area="(a) => emit('area', a)"
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

.sort { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-left: auto; }
.sort-btn {
  min-height: 30px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px;
  background: var(--surface); font: 600 13px var(--font); color: var(--ink-2); cursor: pointer;
}
.sort-btn:hover { border-color: var(--ink-2); }
.sort-btn.on { background: var(--ink); border-color: var(--ink); color: #fff; }
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
/* 목록 | 끌어서 폭을 바꾸는 경계 | 지도. 지도 폭은 --map-share(기억한 비율), 목록은 440px, 지도는 320px보다 좁아지지 않는다. */
.ov-split {
  display: grid; grid-template-columns: minmax(0, 1fr) 12px clamp(320px, var(--map-share, 50%), calc(100% - 464px)); gap: 16px 6px; align-items: start;
  --split-top: 92px; --split-height: calc(100vh - 108px);
}
.ov-bands { display: grid; gap: 14px; min-width: 0; }
.ov-map { position: sticky; top: 92px; height: calc(100vh - 108px); min-height: 420px; }
/* 크게 보기일 때는 위쪽 머리 줄(z-index 20)보다 위에 오게 한다. */
.ov-map:has(.ovmap.big) { z-index: 70; }
@media (max-width: 1280px) {
  .ov-split { grid-template-columns: 1fr; }
  .ov-split > .split-handle { display: none; }
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
.area-pick {
  min-height: 40px; max-width: 100%; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 999px;
  background: var(--surface); font: inherit; font-size: 14px; font-weight: 700; color: var(--ink-2);
}
.area-pick.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
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
.band-label { min-width: 116px; font-size: 18px; font-weight: 800; letter-spacing: -0.01em; }
.band.zero .band-label { font-size: 15px; font-weight: 700; }
.band-total { min-width: 52px; font-size: 17px; font-weight: 700; }
.band.zero .band-total { font-size: 14px; font-weight: 600; }
.band-total.off { min-width: 0; font-size: 14px; font-weight: 600; color: var(--muted); }
.band-sub { font-size: 13px; color: var(--muted); }
.band-end { margin-left: auto; display: inline-flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
.chev { font-size: 13px; font-weight: 600; color: var(--muted); }
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
