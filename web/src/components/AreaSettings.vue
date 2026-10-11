<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Area } from '../../../shared/types';
import { api } from '../api';
import { loadCatalog, setAreaEnabled, toggleStationArea, type CatalogStation } from '../areaActions';
import { distanceText, distanceM } from '../format';

// 지역 켜고 끄기, 반경, 지우기와 역 추가(수도권 전철역 658곳: 시도 → 구와 시, 또는 이름 검색).
// 지도에서 역을 눌러도 켜고 끈다. 크롬 확장 팝업과 같은 목록으로 맞춰진다.
const props = defineProps<{ areas: Area[] }>();
const emit = defineEmits<{ changed: [] }>();

const error = ref<string | null>(null);
const busy = ref(false);

async function run(action: () => Promise<unknown>, revert?: () => void) {
  error.value = null;
  busy.value = true;
  try {
    await action();
    emit('changed');
  } catch (e) {
    revert?.();
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function onToggle(area: Area, event: Event) {
  const input = event.target as HTMLInputElement;
  void run(
    () => setAreaEnabled(props.areas, area, input.checked),
    () => (input.checked = area.enabled),
  );
}

const setRadius = (area: Area, event: Event) => run(() => api.updateArea(area.id, { radiusM: Number((event.target as HTMLInputElement).value) }));
const remove = (area: Area) => run(() => api.deleteArea(area.id));

/** 켜진 다른 지역과 겹치는지 알려 준다(겹쳐도 문제는 없고, 같은 매물은 한 번만 저장된다). */
function overlapNote(area: Area) {
  const hit = props.areas.find((o) => o.id !== area.id && o.enabled && distanceM(o.lat, o.lng, area.lat, area.lng) < o.radiusM + area.radiusM);
  return hit ? `${hit.name} 반경과 겹침` : null;
}

// ---------- 역 추가 ----------
const catalog = ref<CatalogStation[]>([]);
const catalogError = ref<string | null>(null);
const query = ref('');
const sido = ref('서울');
const gu = ref<string | null>(null);

onMounted(async () => {
  try {
    catalog.value = await loadCatalog();
    // 처음에는 켜 둔 첫 역이 있는 구를 펼쳐 둔다(예: 강남역 → 서울 강남구).
    const first = props.areas.filter((a) => a.enabled).map((a) => catalog.value.find((s) => s.name === a.name)).find(Boolean);
    if (first) {
      sido.value = first.sido;
      gu.value = first.gu ?? '모름';
    }
  } catch (e) {
    catalogError.value = e instanceof Error ? e.message : String(e);
  }
});

const count = (list: CatalogStation[], key: (s: CatalogStation) => string) => {
  const m = new Map<string, number>();
  for (const s of list) m.set(key(s), (m.get(key(s)) ?? 0) + 1);
  return [...m];
};
const sidos = computed(() => count(catalog.value, (s) => s.sido));
const gus = computed(() => count(catalog.value.filter((s) => s.sido === sido.value), (s) => s.gu ?? '모름').sort((a, b) => a[0].localeCompare(b[0], 'ko')));
function pickSido(v: string) {
  sido.value = v;
  gu.value = null;
}
const areaOf = (name: string) => props.areas.find((a) => a.name === name) ?? null;
/** 검색어가 있으면 이름에 들어간 역, 없으면 고른 구나 시의 역 */
const rows = computed(() => {
  const q = query.value.trim().replace(/역$/, '');
  const list = q ? catalog.value.filter((s) => s.name.includes(q)) : gu.value ? catalog.value.filter((s) => s.sido === sido.value && (s.gu ?? '모름') === gu.value) : [];
  return list.slice(0, 200).map((s) => ({ s, where: `${s.sido} ${s.gu ?? ''}`.trim(), on: !!areaOf(s.name)?.enabled }));
});

function toggleStation(s: CatalogStation, event: Event) {
  const input = event.target as HTMLInputElement;
  void run(
    () => toggleStationArea(props.areas, s),
    () => (input.checked = !!areaOf(s.name)?.enabled),
  );
}
</script>

<template>
  <section class="areas">
    <div class="title-row">
      <h2>지역</h2>
      <span class="muted small">지도에서 역을 눌러도 켜고 끕니다</span>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <ul class="list">
      <li v-for="area in areas" :key="area.id" class="row" :class="{ off: !area.enabled }">
        <label class="check toggle">
          <input type="checkbox" :checked="area.enabled" :disabled="busy" @change="onToggle(area, $event)" />
          <strong>{{ area.name }}</strong>
        </label>
        <label class="radius">
          반경 <span class="num">{{ distanceText(area.radiusM) }}</span>
          <input type="range" min="300" max="2500" step="100" :value="area.radiusM" :disabled="busy" @change="setRadius(area, $event)" />
        </label>
        <span class="muted note">{{ overlapNote(area) }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="remove(area)">삭제</button>
      </li>
    </ul>

    <div class="add">
      <h3>역 추가</h3>
      <p v-if="catalogError" class="error">{{ catalogError }}</p>
      <input v-model="query" class="search" type="search" placeholder="역 이름 (예: 강남, 잠실)" aria-label="역 이름 찾기" />
      <template v-if="!query.trim()">
        <div class="chips" role="group" aria-label="시도">
          <button v-for="[name, n] in sidos" :key="name" class="chip-btn" :class="{ on: sido === name }" @click="pickSido(name)">
            {{ name }} <span class="n">{{ n }}</span>
          </button>
        </div>
        <div class="chips small-chips" role="group" :aria-label="`${sido} 구와 시`">
          <button v-for="[name, n] in gus" :key="name" class="chip-btn" :class="{ on: gu === name }" @click="gu = gu === name ? null : name">
            {{ name }} <span class="n">{{ n }}</span>
          </button>
        </div>
      </template>
      <div v-if="rows.length" class="stations">
        <label v-for="r in rows" :key="r.s.name" class="check station" :class="{ on: r.on }">
          <input type="checkbox" :checked="r.on" :disabled="busy" @change="toggleStation(r.s, $event)" />
          <span>{{ r.s.label }}<span v-if="query.trim()" class="muted where">{{ r.where }}</span></span>
        </label>
      </div>
      <p v-else-if="query.trim() && catalog.length" class="muted small">'{{ query.trim() }}'이(가) 들어간 역이 없습니다.</p>
    </div>
  </section>
</template>

<style scoped>
.areas { display: grid; gap: 12px; max-width: 760px; }
.title-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
h2 { margin: 0; font-size: 18px; }
h3 { margin: 6px 0 0; font-size: 15px; }
p { margin: 0; }
.small { font-size: 13px; }
.error { color: var(--new); font-weight: 600; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.row {
  display: grid; grid-template-columns: 180px 1fr auto auto; align-items: center; gap: 12px;
  padding: 10px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
}
.row.off { opacity: .6; }
.radius { display: grid; grid-template-columns: auto 64px 1fr; align-items: center; gap: 8px; font-size: 14px; }
.radius input { width: 100%; }
.note { font-size: 13px; }
.add { display: grid; gap: 8px; }
.search { width: min(360px, 100%); min-height: 40px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface); font-size: 15px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-btn { min-height: 36px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); font-size: 14px; font-weight: 700; }
.chip-btn .n { font-weight: 500; opacity: .7; }
.chip-btn.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.small-chips .chip-btn { min-height: 32px; padding: 0 10px; font-size: 13px; }
.stations { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 2px 12px; padding: 8px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.station { min-height: 36px; }
.station.on { font-weight: 700; }
.where { margin-left: 6px; font-size: 12px; }
@media (max-width: 720px) { .row { grid-template-columns: 1fr; } }
</style>
