<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Area, AdministrativeRegion, AlertLimits } from '../../../shared/types';
import { regionColor } from '../../../shared/region-geometry';
import { normalizeAlertLimits } from '../../../shared/alert-scope';
import { lastAreaKindError, missingAreaKinds } from '../../../shared/regions';
import { api } from '../api';
import { loadCatalog, setAreaEnabled, toggleStationArea, type CatalogStation } from '../areaActions';
import { distanceText, distanceM } from '../format';

// 지역 켜고 끄기, 반경, 지우기와 역 추가(수도권 전철역 658곳: 시도 → 구와 시, 노선, 또는 이름 검색).
// 노선을 따라 쭉 보는 것은 노선 탭에서 한다(켜진 지역은 그대로). 지도에서 역을 눌러도 켜고 끈다. 크롬 확장 팝업과 같은 목록으로 맞춰진다.
const props = defineProps<{ areas: Area[]; restore: { line: string; count: number } | null }>();
const emit = defineEmits<{ changed: []; browse: []; alerts: [] }>();

const error = ref<string | null>(null);
const busy = ref(false);
const regions = ref<AdministrativeRegion[]>([]);
const narrowGu = ref('');
const registered = computed(() => props.areas.filter((a) => a.region));
const legacy = computed(() => props.areas.filter((a) => !a.region));
const guRegions = computed(() => regions.value.filter((r) => r.kind === 'gu'));
const dongRegions = computed(() => regions.value.filter((r) => r.kind === 'dong' && r.sigungu === narrowGu.value));
const regionOn = (code: string) => props.areas.some((a) => a.region?.code === code && a.enabled);
// 구나 동과 지하철역은 하나 이상씩 켜 둔다. 둘 다 있어야 구 단위 사이트와 역 기준 사이트가 모두 모은다(서버도 같은 규칙으로 막는다).
const missing = computed(() => missingAreaKinds(props.areas));
/** 끄거나 지우면 한쪽이 비는 마지막 구나 동, 마지막 지하철역 */
const locked = (area: Area) => area.enabled && !!lastAreaKindError(props.areas, area.id, { enabled: false });
const LOCK_TIP = '구나 동과 지하철역을 하나 이상씩 켜 두어야 합니다. 다른 것을 먼저 켜면 끌 수 있습니다.';
function blocked(area: Area | null | undefined, next: { enabled?: boolean; deleted?: boolean }) {
  const message = area ? lastAreaKindError(props.areas, area.id, next) : null;
  if (message) error.value = message;
  return !!message;
}
function toggleRegion(region: AdministrativeRegion) {
  const area = props.areas.find((a) => a.region?.code === region.code);
  if (area?.enabled && blocked(area, { enabled: false })) return;
  void run(() => area ? api.updateArea(area.id, { enabled: !area.enabled }) : api.addRegion(region.code));
}

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
  if (!input.checked && blocked(area, { enabled: false })) { input.checked = true; return; }
  void run(
    () => setAreaEnabled(props.areas, area, input.checked),
    () => (input.checked = area.enabled),
  );
}

const setRadius = (area: Area, event: Event) => run(() => api.updateArea(area.id, { radiusM: Number((event.target as HTMLInputElement).value) }));
const remove = (area: Area) => blocked(area, { deleted: true }) ? undefined : run(() => api.deleteArea(area.id));
function setLimit(area: Area, key: keyof AlertLimits, event: Event) {
  const input = event.target as HTMLInputElement;
  const text = input.value.trim();
  const value = text === '' ? null : Number(text);
  const alertLimits = { monthlyMax: null, depositMax: null, priceMax: null, ...area.alertLimits, [key]: value };
  void run(() => api.updateArea(area.id, { alertLimits: normalizeAlertLimits(alertLimits) }), () => { input.value = area.alertLimits?.[key] == null ? '' : String(area.alertLimits[key]); });
}

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
  try { regions.value = (await api.regions()).regions; }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
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

// ---------- 노선으로 찾기 ----------
/** 서울 지하철 1~9호선을 앞에, 나머지는 역이 많은 순 */
const SUBWAY = ['1호선', '2호선', '3호선', '4호선', '5호선', '6호선', '7호선', '8호선', '9호선'];
const lineChips = computed(() => {
  const m = new Map<string, number>();
  for (const s of catalog.value) for (const l of s.lines) m.set(l, (m.get(l) ?? 0) + 1);
  const rank = (l: string) => (SUBWAY.includes(l) ? SUBWAY.indexOf(l) : 99);
  return [...m].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1]);
});
const line = ref<string | null>(null);
const lineMessage = ref<string | null>(null);
const lineRows = computed(() =>
  line.value
    ? catalog.value
        .filter((s) => s.lines.includes(line.value!))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
        .map((s) => ({ s, where: `${s.sido} ${s.gu ?? ''}`.trim(), on: !!areaOf(s.name)?.enabled }))
    : [],
);
const enabledCount = computed(() => props.areas.filter((a) => a.enabled).length);

function restoreAreas() {
  lineMessage.value = null;
  void run(async () => {
    lineMessage.value = (await api.restoreAreas()).text;
  });
}

/** 역 하나를 켜고 끈다. 없는 역은 radiusM(노선 목록에서는 고른 반경, 역 추가에서는 1km)으로 만든다. */
function toggleStation(s: CatalogStation, event: Event, radiusM = 1000) {
  const input = event.target as HTMLInputElement;
  const current = areaOf(s.name);
  if (!input.checked && current?.enabled && blocked(current, { enabled: false })) { input.checked = true; return; }
  void run(
    () => toggleStationArea(props.areas, s, radiusM),
    () => (input.checked = !!areaOf(s.name)?.enabled),
  );
}
</script>

<template>
  <section id="area-settings" class="areas" aria-labelledby="area-settings-title">
    <div class="title-row">
      <div>
        <h2 id="area-settings-title">지역 추가·관리</h2>
        <p class="muted small">켜 둔 구나 동 {{ registered.filter(a => a.enabled).length }}곳과 지하철역 {{ legacy.filter(a => a.enabled).length }}곳을 함께 모읍니다. 둘 다 하나 이상씩 켜 두어야 합니다.</p>
      </div>
      <button class="btn btn-sm" @click="emit('browse')">순차 조회로 돌아가기</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="missing.length" class="kind-warning" role="alert">
      <strong>{{ missing.length === 2 ? '구나 동과 지하철역을 하나 이상씩 켜 주세요.' : missing[0] === 'region' ? '구나 동을 하나 이상 켜 주세요.' : '지하철역을 하나 이상 켜 주세요.' }}</strong>
      <span v-if="missing.includes('region')">구나 동이 없으면 다방과 네이버가 구나 동 전체를 보지 못하고, 고방, 법원경매, 온비드는 역 근처 구만 봅니다.</span>
      <span v-if="missing.includes('station')">지하철역이 없으면 직방은 구 안 역만, 집토스와 피터팬은 구 가운데 근처만 보고, 역 근처 매물 알림도 오지 않습니다.</span>
    </div>
    <p v-if="restore" class="restore">
      <span :title="`예전 '이 노선만 켜기'로 바꾼 지역입니다(켜진 지역 ${enabledCount}곳). 노선은 이제 노선 탭에서 따로 봅니다.`">{{ restore.line }} 노선으로 바꾼 지역</span>
      <button class="btn btn-sm" :disabled="busy" @click="restoreAreas">전에 켜 둔 지역 {{ restore.count }}곳으로 되돌리기</button>
    </p>
    <p v-if="lineMessage" class="muted small">{{ lineMessage }}</p>

    <div class="add">
      <h3>1. 넓게 수집할 구 <span v-if="missing.includes('region')" class="need">필수</span></h3>
      <p class="muted small">서울 25개 구 중 선택하세요. 수집 대상 구는 지도에 색으로 표시합니다. 매물 알림은 아래 역 반경으로 따로 제한합니다.</p>
      <div class="region-grid">
        <button v-for="r in guRegions" :key="r.code" class="chip-btn" :class="{ on: regionOn(r.code) }" :aria-pressed="regionOn(r.code)" :disabled="busy" @click="toggleRegion(r)">
          <i :style="{ background: regionColor(r.code) }"></i>{{ r.sigungu }}
        </button>
      </div>
      <p class="muted small">주변에서 함께 받은 매물도 저장합니다. 기본 목록은 선택한 구만 보여 주며, 지역 필터를 끄면 주변 매물도 볼 수 있습니다.</p>
      <p class="muted small">구 선택은 수집 대상 설정입니다. 사이트별 실제 조회 범위와 전체 수집 완료 여부는 순차 조회 결과에서 따로 확인합니다.</p>
    </div>
    <details class="add">
      <summary>특정 법정동으로 좁히기</summary>
      <p class="muted small">같은 구 전체가 켜져 있으면 동을 추가해도 범위가 좁아지지 않습니다. 해당 구를 끄고 원하는 동만 켜세요. 지도에는 참고용 구 경계가 표시됩니다.</p>
      <select v-model="narrowGu" aria-label="동을 찾을 구"><option value="">구 선택</option><option v-for="r in guRegions" :key="r.code" :value="r.sigungu">{{ r.sigungu }}</option></select>
      <div class="region-grid"><button v-for="r in dongRegions" :key="r.code" class="chip-btn" :class="{ on: regionOn(r.code) }" :aria-pressed="regionOn(r.code)" :disabled="busy" @click="toggleRegion(r)">{{ r.dong }}</button></div>
    </details>
    <h3>등록한 구·동 <span class="muted small">{{ registered.length }}곳</span></h3>
    <ul class="list">
      <li v-for="area in registered" :key="area.id" class="region-row" :class="{ off: !area.enabled }">
        <label class="check" :title="locked(area) ? LOCK_TIP : undefined"><input type="checkbox" :checked="area.enabled" :disabled="busy || locked(area)" @change="onToggle(area, $event)" /><i class="region-dot" :style="{ background: regionColor(area.region!.code) }"></i><strong>{{ area.name }}</strong></label>
        <span class="muted small">{{ area.region!.kind === 'gu' ? '구 전체' : '법정동' }}, {{ area.region!.name }}<template v-if="locked(area)">, 마지막 구나 동이라 끌 수 없음</template></span>
        <button class="btn btn-ghost btn-sm" :disabled="busy || locked(area)" :title="locked(area) ? LOCK_TIP : undefined" @click="remove(area)">삭제</button>
      </li>
    </ul>
    <section class="add alert-zones" aria-labelledby="alert-zones-title">
      <div class="title-row"><h3 id="alert-zones-title">2. 함께 모으고 알릴 지하철역 <span v-if="missing.includes('station')" class="need">필수</span></h3><button class="btn btn-sm" @click="emit('alerts')">공통 알림 조건</button></div>
      <p class="muted small">켜 둔 역 반경도 수집 범위에 들어갑니다. 직방, 집토스, 피터팬처럼 역 기준으로만 모으는 사이트가 이 반경을 씁니다. 알림은 반경 안에서 금액 조건에 맞는 신규 매물과 가격 인하 매물만 보냅니다. 지도에 초록 점선으로 표시합니다.</p>
    <div class="add search-area">
      <h3>알림 역 추가</h3>
      <p class="muted small">역 이름을 검색하거나 노선에서 골라 체크하세요. 처음 반경은 1km이며 아래에서 조정할 수 있습니다.</p>
      <p v-if="catalogError" class="error">{{ catalogError }}</p>
      <input id="area-search" v-model="query" class="search" type="search" placeholder="추가할 역 이름 검색" aria-label="역 이름 찾기" />
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

    <h3>등록한 알림 구역 <span class="muted small">{{ legacy.length }}곳</span></h3>
    <ul class="list">
      <li v-for="area in legacy" :key="area.id" class="row" :class="{ off: !area.enabled }">
        <label class="check toggle" :title="locked(area) ? LOCK_TIP : undefined">
          <input type="checkbox" :checked="area.enabled" :disabled="busy || locked(area)" @change="onToggle(area, $event)" />
          <strong>{{ area.name }}</strong>
          <small v-if="locked(area)" class="muted">마지막 지하철역이라 끌 수 없음</small>
        </label>
        <label class="radius">
          반경 <span class="num">{{ distanceText(area.radiusM) }}</span>
          <input type="range" min="100" max="5000" step="100" :value="area.radiusM" :disabled="busy" @change="setRadius(area, $event)" />
        </label>
        <span class="muted note">{{ overlapNote(area) }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="busy || locked(area)" :title="locked(area) ? LOCK_TIP : undefined" @click="remove(area)">삭제</button>
        <div class="station-limits">
          <label>월세 한도 (만원)<input type="number" min="1" placeholder="공통 조건 사용" :aria-label="`${area.name} 월세 한도`" :value="area.alertLimits?.monthlyMax ?? ''" :disabled="busy" @change="setLimit(area, 'monthlyMax', $event)" /></label>
          <label>보증금·전세금 한도 (만원)<input type="number" min="1" step="100" placeholder="공통 조건 사용" :aria-label="`${area.name} 보증금 한도`" :value="area.alertLimits?.depositMax ?? ''" :disabled="busy" @change="setLimit(area, 'depositMax', $event)" /></label>
          <label>매매·경매가 한도 (만원)<input type="number" min="1" step="1000" placeholder="공통 조건 사용" :aria-label="`${area.name} 매매가 한도`" :value="area.alertLimits?.priceMax ?? ''" :disabled="busy" @change="setLimit(area, 'priceMax', $event)" /></label>
        </div>
      </li>
    </ul>
    <p class="muted small">금액을 비우면 공통 알림 조건을 사용합니다. 역별 금액을 넣으면 해당 역에서는 그 한도를 우선합니다. 월세 한도는 관리비를 제외한 금액입니다.</p>

    <div class="add">
      <h3>노선에서 알림 역 찾기</h3>
      <div class="chips small-chips" role="group" aria-label="노선">
        <button v-for="[name, n] in lineChips" :key="name" class="chip-btn" :class="{ on: line === name }" @click="line = line === name ? null : name">
          {{ name }} <span class="n">{{ n }}</span>
        </button>
      </div>
      <div v-if="line" class="line-box">
        <div class="stations">
          <label v-for="r in lineRows" :key="r.s.name" class="check station" :class="{ on: r.on }">
            <input type="checkbox" :checked="r.on" :disabled="busy" @change="toggleStation(r.s, $event)" />
            <span>{{ r.s.name }}<span class="muted where">{{ r.where }}</span></span>
          </label>
        </div>
      </div>
    </div>

    </section>
  </section>
</template>

<style scoped>
.areas { display: grid; gap: 16px; min-width: 0; padding: 24px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); scroll-margin-top: calc(var(--app-header-height, 80px) + 16px); }
.kind-warning { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid var(--up); border-radius: 10px; background: var(--surface-2); font-size: 14px; }
.need { margin-left: 6px; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; color: var(--surface); background: var(--up); vertical-align: middle; }
.region-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; margin: 12px 0; }
.region-grid button { display: flex; align-items: center; gap: 8px; justify-content: center; min-height: 40px; }
.region-grid i, .region-dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
.region-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; }
.region-row > span { flex: 1; }
.alert-zones { padding-top: 20px; border-top: 1px solid var(--line); }
.station-limits { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.station-limits label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
.station-limits input { width: 100%; min-width: 0; min-height: 38px; padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: 8px; font: inherit; color: var(--ink); }
@media (max-width: 720px) { .station-limits { grid-template-columns: 1fr; } }
summary { cursor: pointer; font-weight: 600; padding: 8px 0; }
.title-row { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: flex-start; gap: 12px; }
h2 { margin: 0 0 6px; font-size: 22px; }
h3 { margin: 6px 0 0; font-size: 15px; }
p { margin: 0; }
.small { font-size: 13px; }
.error { color: var(--new); font-weight: 600; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.row {
  display: grid; grid-template-columns: minmax(130px, 180px) minmax(180px, 1fr) minmax(0, 1fr) auto; align-items: center; gap: 12px;
  padding: 10px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
}
.row.off { opacity: .6; }
.radius { display: grid; grid-template-columns: auto 64px 1fr; align-items: center; gap: 8px; font-size: 14px; }
.radius input { width: 100%; }
.note { font-size: 13px; overflow-wrap: anywhere; }
.add { display: grid; gap: 8px; }
.search-area { padding-bottom: 20px; border-bottom: 1px solid var(--line); }
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
.restore {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 14px;
  background: var(--accent-soft); border: 1px solid var(--line-strong); border-radius: var(--radius); font-size: 14px;
}
.line-box { display: grid; gap: 8px; }
@media (max-width: 720px) { .row { grid-template-columns: 1fr; } }
@media (max-width: 720px) { .areas { padding: 16px; } }
</style>
