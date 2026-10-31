<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RENT_KINDS, RENT_SIZES, type MarketStation, type RentKindId, type RentPlace, type RentSizeId, type RentView } from '../../../shared/types';
import { manwon } from '../../../shared/format';
import { api } from '../api';
import { STAT_TIPS } from '../market';
import { rentRate } from '../rentRate';
import CountTooltip from './CountTooltip.vue';

// 시세 통계 탭 '동별 전월세' 칸: 켜 둔 지역 근처 구의 최근 1년 신규 전월세 계약을 종류와 면적 칸 하나로 골라 구 전체와 동마다 보인다.
// 월세는 환산 월세 중간값(전환율은 매물 카드와 같은 값), 전세는 전세금 중간값. 동 줄은 고른 값이 낮은 순이고, 5건이 안 되는 줄은
// 흐리게 맨 뒤로 보낸다. 종류, 면적, 순서는 기억한다. 전환율이 바뀌거나 탭 자료를 새로 받으면(refreshKey) 다시 받는다.

const props = defineProps<{
  /** 바뀌면 다시 받는다(시세 통계 탭 자료) */
  refreshKey: unknown;
}>();

/** 이 건수보다 적으면 흐리게 둔다 */
const FEW = 5;

const KIND_KEY = 'hnw-rent-kind';
const SIZE_KEY = 'hnw-rent-size';
const SORT_KEY = 'hnw-rent-sort';
const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 브라우저 저장을 못 쓰면 이번 화면에서만 기억한다
  }
};
const kind = ref<RentKindId>(RENT_KINDS.find((k) => k.id === stored(KIND_KEY))?.id ?? 'small');
const size = ref<RentSizeId>(RENT_SIZES.find((s) => s.id === stored(SIZE_KEY))?.id ?? 'one');
const sortBy = ref<'monthly' | 'jeonse'>(stored(SORT_KEY) === 'jeonse' ? 'jeonse' : 'monthly');
watch(kind, (v) => remember(KIND_KEY, v));
watch(size, (v) => remember(SIZE_KEY, v));
watch(sortBy, (v) => remember(SORT_KEY, v));

/** 환산에 쓸 전환율(연 %): 매물 카드와 같은 값, 아직 없으면 서버가 정한 값 */
const rate = computed(() => rentRate.value.local ?? rentRate.value.legal ?? 6);

const view = ref<RentView | null>(null);
const loadError = ref<string | null>(null);
const fetching = ref(false);
const fetchError = ref<string | null>(null);

async function load() {
  try {
    view.value = await api.rentTrades(rate.value);
    loadError.value = null;
  } catch (e) {
    loadError.value = `동별 전월세를 불러오지 못했습니다. ${e instanceof Error ? e.message : String(e)}`;
  }
}
async function fetchNow() {
  fetching.value = true;
  fetchError.value = null;
  try {
    view.value = await api.fetchRentTrades(rate.value);
  } catch (e) {
    fetchError.value = e instanceof Error ? e.message : String(e);
    await load();
  } finally {
    fetching.value = false;
  }
}
onMounted(load);
watch([rate, () => props.refreshKey], load);

const cellKey = computed(() => `${kind.value}:${size.value}`);
const cellOf = (p: RentPlace) => p.cells[cellKey.value] ?? { monthly: null, jeonse: null };
const valueOf = (p: RentPlace) => (sortBy.value === 'monthly' ? cellOf(p).monthly?.conv : cellOf(p).jeonse?.median) ?? null;
const countOf = (p: RentPlace) => (sortBy.value === 'monthly' ? cellOf(p).monthly?.count : cellOf(p).jeonse?.count) ?? 0;

const guRows = computed(() => view.value?.gus ?? []);
/** 동 줄: 고른 값의 건수가 FEW 이상인 줄을 값 낮은 순으로 먼저, 나머지는 흐리게 그 뒤에 */
const dongRows = computed(() => {
  const rows = (view.value?.gus ?? []).flatMap((g) => g.dongs.map((d) => ({ ...d, gu: g.name })));
  const order = (a: (typeof rows)[number], b: (typeof rows)[number]) => (valueOf(a) ?? Infinity) - (valueOf(b) ?? Infinity) || a.name.localeCompare(b.name, 'ko');
  const enough = rows.filter((r) => countOf(r) >= FEW).sort(order);
  const few = rows.filter((r) => countOf(r) < FEW).sort(order);
  return [...enough.map((r) => ({ ...r, few: false })), ...few.map((r) => ({ ...r, few: true }))];
});
const sizeLabel = computed(() => RENT_SIZES.find((s) => s.id === size.value)!.label);
const kindLabel = computed(() => RENT_KINDS.find((k) => k.id === kind.value)!.label);

const count = (x: number) => x.toLocaleString('ko-KR');
const dot = (date: string) => date.replace(/-/g, '.');
const pctText = (x: number) => `${x.toFixed(1)}%`;
const fetchedText = computed(() => {
  const at = view.value?.fetchedAt;
  if (!at) return '아직 안 받음';
  const d = new Date(at);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 받음`;
});
const errorText = computed(() => fetchError.value ?? loadError.value ?? view.value?.error ?? null);

function monthlyTip(p: RentPlace): string {
  const m = cellOf(p).monthly;
  if (!m) return '';
  const r = view.value?.rate ?? rate.value;
  return [
    `${p.name} ${kindLabel.value} ${sizeLabel.value} 월세 계약 ${count(m.count)}건`,
    `환산 월세 중간값 ${manwon(m.conv)}(월세 + 보증금 × ${pctText(r)} ÷ 12)`,
    `싼 쪽 4분의 1 경계 ${manwon(m.convLow)}, 비싼 쪽 4분의 1 경계 ${manwon(m.convHigh)}`,
    `보증금 중간값 ${manwon(m.deposit)}, 월세 중간값 ${manwon(m.rent)}`,
  ].join('\n');
}
function jeonseTip(p: RentPlace): string {
  const j = cellOf(p).jeonse;
  if (!j) return '';
  return [
    `${p.name} ${kindLabel.value} ${sizeLabel.value} 전세 계약 ${count(j.count)}건`,
    `전세금 중간값 ${manwon(j.median)}`,
    `싼 쪽 4분의 1 경계 ${manwon(j.low)}, 비싼 쪽 4분의 1 경계 ${manwon(j.high)}`,
  ].join('\n');
}
const stationTitle = (s: MarketStation) =>
  `${s.lines.join(', ')}${s.how === 'listings' ? ', 역 300m 안 모은 매물이 가장 많은 동' : ', 역 이름과 같은 동'}`;
</script>

<template>
  <section class="block rent" aria-labelledby="market-rent">
    <div class="block-head">
      <h3 id="market-rent" class="block-title"><CountTooltip :text="STAT_TIPS.rent" :max-width="440">동별 전월세</CountTooltip> <span class="muted">전월세 실거래, 근처 구</span></h3>
      <div class="picks">
        <div class="seg" role="group" aria-label="주택 종류">
          <button v-for="k in RENT_KINDS" :key="k.id" type="button" :class="{ on: kind === k.id }" :aria-pressed="kind === k.id" @click="kind = k.id">{{ k.label }}</button>
        </div>
        <div class="seg" role="group" aria-label="면적">
          <button v-for="s in RENT_SIZES" :key="s.id" type="button" :class="{ on: size === s.id }" :aria-pressed="size === s.id" @click="size = s.id">{{ s.label }}</button>
        </div>
      </div>
    </div>
    <p v-if="errorText" class="err" role="alert">{{ errorText }}</p>
    <template v-if="view && view.gus.length">
      <p class="muted note">계약일 {{ dot(view.from) }} ~ {{ dot(view.to) }}, 전환율 {{ pctText(view.rate) }}, {{ fetchedText }}</p>
      <div class="rent-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th scope="col">동</th>
              <th scope="col" class="r">
                <button type="button" class="sort" :class="{ on: sortBy === 'monthly' }" :aria-pressed="sortBy === 'monthly'" title="누르면 환산 월세 낮은 순" @click="sortBy = 'monthly'">월세</button>
              </th>
              <th scope="col" class="r wide">보증금/월세</th>
              <th scope="col" class="r">건수</th>
              <th scope="col" class="r">
                <button type="button" class="sort" :class="{ on: sortBy === 'jeonse' }" :aria-pressed="sortBy === 'jeonse'" title="누르면 전세금 낮은 순" @click="sortBy = 'jeonse'">전세</button>
              </th>
              <th scope="col" class="r">건수</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in guRows" :key="`gu-${g.name}`" class="gu">
              <th scope="row">{{ g.name }} 전체</th>
              <template v-if="cellOf(g).monthly">
                <td class="num r strong"><CountTooltip :text="monthlyTip(g)" :focusable="false" :max-width="360">{{ manwon(cellOf(g).monthly!.conv) }}</CountTooltip></td>
                <td class="num r wide">{{ count(cellOf(g).monthly!.deposit) }}/{{ cellOf(g).monthly!.rent }}</td>
                <td class="num r">{{ count(cellOf(g).monthly!.count) }}</td>
              </template>
              <template v-else><td class="r muted">-</td><td class="r wide" /><td class="num r muted">0</td></template>
              <template v-if="cellOf(g).jeonse">
                <td class="num r strong"><CountTooltip :text="jeonseTip(g)" :focusable="false" :max-width="360">{{ manwon(cellOf(g).jeonse!.median) }}</CountTooltip></td>
                <td class="num r">{{ count(cellOf(g).jeonse!.count) }}</td>
              </template>
              <template v-else><td class="r muted">-</td><td class="num r muted">0</td></template>
            </tr>
          </tbody>
          <tbody>
            <tr v-for="d in dongRows" :key="`${d.gu}-${d.name}`" class="dong" :class="{ few: d.few }">
              <th scope="row">
                {{ d.name }} <span class="muted gu-name">{{ d.gu }}</span>
                <span v-for="s in d.stations" :key="s.name" class="stn" :title="stationTitle(s)">{{ s.name }}</span>
              </th>
              <template v-if="cellOf(d).monthly">
                <td class="num r"><CountTooltip :text="monthlyTip(d)" :focusable="false" :max-width="360">{{ manwon(cellOf(d).monthly!.conv) }}</CountTooltip></td>
                <td class="num r wide">{{ count(cellOf(d).monthly!.deposit) }}/{{ cellOf(d).monthly!.rent }}</td>
                <td class="num r">{{ count(cellOf(d).monthly!.count) }}</td>
              </template>
              <template v-else><td class="r muted">-</td><td class="r wide" /><td class="num r muted">0</td></template>
              <template v-if="cellOf(d).jeonse">
                <td class="num r"><CountTooltip :text="jeonseTip(d)" :focusable="false" :max-width="360">{{ manwon(cellOf(d).jeonse!.median) }}</CountTooltip></td>
                <td class="num r">{{ count(cellOf(d).jeonse!.count) }}</td>
              </template>
              <template v-else><td class="r muted">-</td><td class="num r muted">0</td></template>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <p v-else-if="view" class="muted note empty">
      {{ fetchedText }}
      <button type="button" class="btn btn-sm" :disabled="fetching" @click="fetchNow">{{ fetching ? '받는 중…' : '지금 받기' }}</button>
    </p>
    <p v-else-if="!errorText" class="muted note">불러오는 중…</p>
  </section>
</template>

<style scoped>
.block { display: grid; gap: 8px; min-width: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.block-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; }
.block-title { margin: 0; font-size: 15px; }
.block-title .muted { font-size: 12px; font-weight: 500; }
.picks { display: flex; flex-wrap: wrap; gap: 6px; max-width: 100%; }
.seg { display: inline-flex; max-width: 100%; overflow-x: auto; border: 1px solid var(--line-strong); border-radius: 8px; }
.seg button { flex: none; min-height: 30px; padding: 0 12px; border: 0; border-left: 1px solid var(--line-strong); background: var(--surface); font-size: 13px; font-weight: 700; color: var(--ink-2); }
.seg button:first-child { border-left: 0; }
.seg button.on { background: var(--ink); color: #fff; }
.note { margin: 0; font-size: 12px; line-height: 1.55; }
.note.empty { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.err { margin: 0; font-size: 13px; font-weight: 600; color: var(--new); overflow-wrap: anywhere; }
.rent-wrap { overflow-x: auto; }
.grid { border-collapse: separate; border-spacing: 0; font-size: 13px; }
.grid th, .grid td { padding: 6px 10px; white-space: nowrap; border-top: 1px solid var(--line); text-align: left; }
.grid thead th { border-top: 0; font-size: 12px; font-weight: 700; color: var(--ink-2); }
.grid tbody th { font-weight: 700; }
.grid .r { text-align: right; }
.grid td.strong { font-weight: 800; }
.grid tbody + tbody tr:first-child th, .grid tbody + tbody tr:first-child td { border-top: 2px solid var(--line-strong); }
.sort { padding: 0; border: 0; background: none; font: inherit; font-weight: 700; color: var(--ink-2); cursor: pointer; }
.sort.on { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
.dong th { font-weight: 500; }
.dong.few th, .dong.few td { color: var(--muted); }
.gu-name { margin-left: 4px; font-size: 11px; font-weight: 500; }
.stn {
  display: inline-block; margin-left: 6px; padding: 0 6px; border: 1px solid var(--line-strong); border-radius: 999px;
  background: var(--surface); font-size: 11px; font-weight: 600; color: var(--ink-2);
}
/* 좁으면 고르기 단추를 여러 줄로 놓고, 보증금/월세 칸을 빼고, 동 칸의 역 이름은 줄을 바꾸고, 칸 여백을 줄인다 */
@media (max-width: 560px) {
  .seg { flex-wrap: wrap; overflow: visible; }
  .seg button { flex: 1 1 auto; }
  .grid .wide { display: none; }
  .grid th, .grid td { padding: 6px 7px; }
  .grid tbody th { min-width: 96px; white-space: normal; }
  .stn { margin-top: 2px; }
}
</style>
