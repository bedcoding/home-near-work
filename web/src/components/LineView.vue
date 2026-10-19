<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { Area, DealType, LineViewSetting, ListingView, Verdict } from '../../../shared/types';
import { loadCatalog, type CatalogStation } from '../areaActions';
import { dealOptions, type Filters } from '../filters';
import { distanceM, manwon, radiusText } from '../format';
import ListingCard from './ListingCard.vue';
import OverviewMap from './OverviewMap.vue';

// 노선 탭: 노선을 고르면 그 노선 역마다 반경 안 매물(매매와 전월세)을 세어 역끼리 견준다. 켜진 지역(회사 근처)은 건드리지 않는다.
// - 역 칸: 월세, 전세, 매매 건수와 중간값(월세는 월세, 전세는 전세금, 매매는 매매가). 왼쪽 필터의 거래 유형, 가격, 면적, 유형 조건을 따르고 지역 조건은 뺀다.
// - 역을 누르면 그 역 매물 카드가 아래에, 지도에는 노선 역 반경과 그 역 매물이 진하게 보인다. 지도에서 역을 눌러도 고른다.
// - '이 노선 조회하기'는 그 노선 역만 집토스, 피터팬으로 조회하고, '이 역 사이트 열기'는 크롬 확장으로 네이버 등을 그 역 가운데로 연다.
const props = defineProps<{
  /** 매매와 전월세 매물 전체(켜진 지역 밖 포함, 버린 것 빼고) */
  listings: ListingView[];
  filters: Filters;
  lineView: LineViewSetting | null;
  running: boolean;
  restSeconds: number;
}>();
const emit = defineEmits<{
  lineView: [string | null, number];
  run: [string, number];
  openSites: [Area];
  open: [ListingView];
  verdict: [ListingView, Verdict | null];
  source: [ListingView];
  raw: [ListingView];
}>();

const RADII = [300, 500, 700, 1000];
const SUBWAY = ['1호선', '2호선', '3호선', '4호선', '5호선', '6호선', '7호선', '8호선', '9호선'];
const DEALS: { id: Extract<DealType, 'monthly' | 'jeonse' | 'sale'>; name: string }[] = [
  { id: 'monthly', name: '월세' },
  { id: 'jeonse', name: '전세' },
  { id: 'sale', name: '매매' },
];

const catalog = ref<CatalogStation[]>([]);
const catalogError = ref<string | null>(null);
onMounted(async () => {
  try {
    catalog.value = await loadCatalog();
  } catch (e) {
    catalogError.value = e instanceof Error ? e.message : String(e);
  }
});

const lineChips = computed(() => {
  const m = new Map<string, number>();
  for (const s of catalog.value) for (const l of s.lines) m.set(l, (m.get(l) ?? 0) + 1);
  const rank = (l: string) => (SUBWAY.includes(l) ? SUBWAY.indexOf(l) : 99);
  return [...m].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1]);
});
const line = computed(() => props.lineView?.line ?? null);
const radius = computed(() => props.lineView?.radiusM ?? 500);
const pickLine = (name: string) => emit('lineView', line.value === name ? null : name, radius.value);

/** 노선 역(이름 순)과 지도에 그릴 반경. id는 지도 그리기에만 쓴다. */
const stations = computed(() => (line.value ? catalog.value.filter((s) => s.lines.includes(line.value!)).sort((a, b) => a.name.localeCompare(b.name, 'ko')) : []));
const stationAreas = computed<Area[]>(() => stations.value.map((s, i) => ({ id: -(i + 1), name: s.name, lat: s.lat, lng: s.lng, radiusM: radius.value, enabled: true })));

/** 왼쪽 필터에서 지역 조건만 뺀 것(노선 역 반경으로 대신 고른다) */
const loose = computed<Filters>(() => ({ ...props.filters, deals: [], areaIds: [], insideAreas: false, distanceMax: null }));
const priceOf = (deal: DealType, p: { deposit: number | null; monthly: number | null; price: number | null }) =>
  deal === 'monthly' ? p.monthly : deal === 'jeonse' ? p.deposit : p.price;
function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** 역마다 반경 안 매물과 거래 유형별 건수, 중간값(필터의 거래 유형을 고르면 그 유형만 센다) */
const rows = computed(() => {
  const located = props.listings.filter((l) => l.lat != null && l.lng != null);
  const deals = DEALS.filter((d) => !props.filters.deals.length || props.filters.deals.includes(d.id));
  return stations.value.map((s) => {
    const near = located.filter((l) => distanceM(s.lat, s.lng, l.lat!, l.lng!) <= radius.value);
    const by = Object.fromEntries(
      DEALS.map((d) => {
        if (!deals.includes(d)) return [d.id, null];
        const prices = near.flatMap((l) => {
          const opts = dealOptions(l, d.id, loose.value, []);
          const values = opts.map((p) => priceOf(d.id, p)).filter((v): v is number => v != null);
          return values.length ? [Math.min(...values)] : [];
        });
        return [d.id, { count: prices.length, median: median(prices) }];
      }),
    ) as Record<(typeof DEALS)[number]['id'], { count: number; median: number | null } | null>;
    const listings = near.filter((l) => deals.some((d) => dealOptions(l, d.id, loose.value, []).length));
    return { station: s, by, listings, total: listings.length };
  });
});

type Sort = 'count' | 'monthly' | 'jeonse' | 'sale' | 'name';
const SORTS: { id: Sort; name: string }[] = [
  { id: 'count', name: '매물 많은 순' },
  { id: 'monthly', name: '월세 중간값 낮은 순' },
  { id: 'jeonse', name: '전세 중간값 낮은 순' },
  { id: 'sale', name: '매매 중간값 낮은 순' },
  { id: 'name', name: '이름순' },
];
const sort = ref<Sort>((localStorage.getItem('hnw-line-sort') as Sort | null) ?? 'count');
watch(sort, (v) => localStorage.setItem('hnw-line-sort', v));
const sortedRows = computed(() => {
  const list = [...rows.value];
  if (sort.value === 'name') return list;
  if (sort.value === 'count') return list.sort((a, b) => b.total - a.total);
  const key = sort.value;
  const v = (r: (typeof list)[number]) => r.by[key]?.median ?? Infinity;
  return list.sort((a, b) => v(a) - v(b) || b.total - a.total);
});

const stationName = ref<string | null>(null);
watch(line, () => (stationName.value = null));
const picked = computed(() => rows.value.find((r) => r.station.name === stationName.value) ?? null);
const pickStation = (name: string) => (stationName.value = stationName.value === name ? null : name);
const allLine = computed(() => [...new Map(rows.value.flatMap((r) => r.listings.map((l) => [l.id, l]))).values()]);
const selectedId = ref<string | null>(null);

const cell = (v: { count: number; median: number | null } | null) => (v === null ? '-' : v.count ? `${v.count}건, ${manwon(v.median!)}` : '0');
/** 이 노선 조회가 보는 양(시간은 사이트 응답에 따라 달라 쓰지 않는다) */
const runNote = computed(
  () => `집토스 역 페이지 약 ${stations.value.length}곳, 피터팬 지도 ${stations.value.length}곳 × 3종류를 봅니다. 역, 지역 사이 ${props.restSeconds}초씩 쉽니다.`,
);
</script>

<template>
  <section class="lineview">
    <div class="title-row">
      <h2 title="켜진 지역(회사 근처)은 그대로 두고, 노선을 따라 역마다 매물을 견줍니다">노선</h2>
    </div>
    <p v-if="catalogError" class="error">{{ catalogError }}</p>
    <div class="chips" role="group" aria-label="노선">
      <button v-for="[name, n] in lineChips" :key="name" class="chip-btn" :class="{ on: line === name }" :aria-pressed="line === name" @click="pickLine(name)">
        {{ name }} <span class="n">{{ n }}</span>
      </button>
    </div>
    <p v-if="!line" class="muted small" title="노선을 고르면 역마다 반경 안 매매와 전월세 매물 수와 중간값이 나옵니다. 처음에는 그 노선 매물이 없으니 '이 노선 조회하기'를 누르세요.">노선을 고르세요</p>

    <template v-else>
      <div class="controls">
        <label class="small">
          역 반경
          <select :value="radius" @change="emit('lineView', line, Number(($event.target as HTMLSelectElement).value))">
            <option v-for="r in RADII" :key="r" :value="r">{{ radiusText(r) }}</option>
          </select>
        </label>
        <label class="small">
          정렬
          <select v-model="sort">
            <option v-for="s in SORTS" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <button class="btn btn-primary btn-sm" :disabled="running" :title="runNote" @click="emit('run', line, radius)">
          {{ running ? '조회 중…' : '이 노선 조회하기' }}
        </button>
      </div>

      <div class="body">
        <div class="left">
          <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr title="중간값은 월세는 월세, 전세는 전세금, 매매는 매매가이고, 왼쪽 필터의 거래 유형, 가격, 면적, 매물 유형을 따릅니다. 역 반경이 겹치면 두 역에 같이 셉니다.">
                <th scope="col">역 <span class="muted num">{{ stations.length }}곳</span></th>
                <th v-for="d in DEALS" :key="d.id" scope="col" class="r">{{ d.name }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in sortedRows" :key="r.station.name" :class="{ on: stationName === r.station.name, empty: !r.total }"
                :title="`${r.station.label}: 반경 ${radiusText(radius)} 안 ${r.total}건(누르면 매물 보기)`" @click="pickStation(r.station.name)"
              >
                <th scope="row">{{ r.station.name }} <span class="muted where">{{ r.station.gu ?? r.station.sido }}</span></th>
                <td v-for="d in DEALS" :key="d.id" class="num r">{{ cell(r.by[d.id]) }}</td>
              </tr>
            </tbody>
          </table>
          </div>

          <div v-if="picked" class="station">
            <div class="station-head">
              <strong>{{ picked.station.name }}</strong>
              <span class="muted small num">반경 {{ radiusText(radius) }} 안 {{ picked.total }}건</span>
              <button
                class="btn btn-sm" title="크롬 확장으로 네이버 부동산 등을 이 역 가운데로 엽니다. 거기서 본 매물은 이 노선 탭에 들어옵니다."
                @click="emit('openSites', { id: 0, name: picked.station.name, lat: picked.station.lat, lng: picked.station.lng, radiusM: radius, enabled: true })"
              >이 역 사이트 열기</button>
            </div>
            <div class="list">
              <ListingCard
                v-for="l in picked.listings" :key="l.id" :listing="l" :areas="stationAreas" :selected="selectedId === l.id"
                @select="selectedId = l.id" @open="emit('open', l)" @verdict="(v) => emit('verdict', l, v)" @source="emit('source', l)" @raw="emit('raw', l)"
              />
            </div>
            <p v-if="!picked.total" class="muted small">이 역 반경 안 매물이 아직 없습니다</p>
          </div>
        </div>
        <aside class="map-side">
          <OverviewMap
            :listings="picked?.listings ?? []" :background="allLine" :areas="stationAreas" :selected-id="selectedId" :list-mode="false"
            :pickable="false" :fit-key="`${line}|${radius}|${stationName ?? ''}`"
            @select="(l) => (selectedId = l.id)" @open="(l) => emit('open', l)" @station="(s) => stations.some((x) => x.name === s.name) && pickStation(s.name)"
          />
        </aside>
      </div>
    </template>
  </section>
</template>

<style scoped>
.lineview { display: grid; gap: 12px; }
.title-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
h2 { margin: 0; font-size: 18px; }
p { margin: 0; }
.small { font-size: 13px; }
.error { color: var(--new); font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-btn { min-height: 34px; padding: 0 11px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); font-size: 13px; font-weight: 700; }
.chip-btn .n { font-weight: 500; opacity: .7; }
.chip-btn.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.controls select { min-height: 32px; margin-left: 4px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); font: inherit; }
.body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 40%); gap: 16px; align-items: start; }
.left { display: grid; gap: 10px; min-width: 0; }
.map-side { position: sticky; top: calc(var(--app-header-height, 76px) + 16px); height: calc(100dvh - var(--app-header-height, 76px) - 32px); min-height: 420px; }
.table-wrap { overflow-x: auto; }
.grid { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); font-size: 14px; }
.grid th, .grid td { padding: 7px 10px; border-top: 1px solid var(--line); text-align: left; white-space: nowrap; }
.grid thead th { border-top: 0; font-size: 12.5px; color: var(--ink-2); }
.grid .r { text-align: right; }
.grid tbody tr { cursor: pointer; }
.grid tbody tr:hover { background: var(--surface-2); }
.grid tbody tr.on { background: var(--accent-soft); }
.grid tbody tr.on th { color: var(--accent); }
.grid tbody tr.empty td { color: var(--muted); }
.where { margin-left: 4px; font-size: 12px; font-weight: 500; }
.station { display: grid; gap: 8px; }
.station-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.list { display: grid; gap: 10px; }
@media (max-width: 900px) {
  .body { grid-template-columns: minmax(0, 1fr); }
  .map-side { position: static; height: 420px; order: -1; }
}
@media (max-width: 520px) {
  .grid th, .grid td { padding: 6px 6px; font-size: 13px; }
  .where { display: none; }
}
</style>
