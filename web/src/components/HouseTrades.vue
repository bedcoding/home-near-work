<script setup lang="ts">
import { computed, ref } from 'vue';
import type { HouseTradeSummary, HouseTradeView } from '../../../shared/types';
import { manwon } from '../../../shared/format';

// 경매 탭 단독 칸 맨 위 '오래된 단독주택 실거래' 칸: 국토부 실거래가 서울 단독주택 매매 중 지은 지 age년 넘은 것.
// 제목 줄에 서울 건수와 중간값, 켜 둔 지역 근처 구의 건수와 중간값. 펼치면 지은 지 몇 년(30, 40, 50년) 고르기와 '지금 받기',
// 매매가 칸별 건수(서울, 근처 구), 구별 표(근처 구 먼저, 그다음 중간값 낮은 순, 누르면 동별), 서울에서 싼 거래 목록.
// 펼침은 기억하고, 처음에는 펼쳐 둔다.

const props = defineProps<{
  /** 요약(아직 못 읽었으면 null) */
  summary: HouseTradeSummary | null;
  /** 지은 지 몇 년 넘은 집을 볼지 */
  age: number;
  /** 지금 받는 중 */
  fetching: boolean;
  /** '지금 받기'에서 난 오류 */
  error: string | null;
}>();
const emit = defineEmits<{
  age: [number];
  fetch: [];
}>();

const AGES = [30, 40, 50];
const PYEONG_M2 = 3.305785;

const OPEN_KEY = 'hnw-house-trades-open';
const open = ref(localStorage.getItem(OPEN_KEY) !== 'false');
function onToggle(e: Event) {
  open.value = (e.target as HTMLDetailsElement).open;
  localStorage.setItem(OPEN_KEY, String(open.value));
}

/** 동별로 펼친 구 */
const openGu = ref<string | null>(null);
const toggleGu = (gu: string) => (openGu.value = openGu.value === gu ? null : gu);

const count = (x: number) => x.toLocaleString('ko-KR');
const dot = (date: string) => date.replace(/-/g, '.');
const m2 = (x: number | null) => (x == null ? '' : `${Math.round(x * 10) / 10}㎡`);
const py = (x: number | null) => (x == null ? '' : `${Math.round((x / PYEONG_M2) * 10) / 10}평`);
const perPy = (t: HouseTradeView) => (t.landM2 ? manwon(Math.round(t.price / (t.landM2 / PYEONG_M2))) : '');

const nearGus = computed(() => props.summary?.gus.filter((g) => g.near) ?? []);
const errorText = computed(() => props.error ?? props.summary?.error ?? null);
const fetchedText = computed(() => {
  const at = props.summary?.fetchedAt;
  if (!at) return '아직 안 받음';
  const d = new Date(at);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 받음`;
});
const headTitle = computed(() => {
  const s = props.summary;
  return [
    '국토부 실거래가 공개시스템의 서울 단독주택 매매(다가구 제외)입니다.',
    s ? `지은 지 ${props.age}년 넘은 것(건축년도 ${s.maxBuiltYear}년 이전), 계약일 ${dot(s.from)} ~ ${dot(s.to)}.` : '',
    '해제된 거래와 건축년도가 비었거나 1900년인 거래는 뺐습니다. 계약일 기준이라 최근 한 달은 신고가 덜 들어왔을 수 있습니다.',
    '조회할 때 7일에 한 번 새로 받습니다.',
  ]
    .filter(Boolean)
    .join('\n');
});

/** 거래 하나의 자세한 설명(title) */
function tradeTitle(t: HouseTradeView): string {
  return [
    `${t.gu} ${t.dong}, 계약 ${dot(t.date)}, ${manwon(t.price)}`,
    `대지 ${m2(t.landM2)}${t.landM2 ? `(${py(t.landM2)})` : ''}, 집 ${m2(t.floorM2)}, ${t.builtYear ?? '?'}년 지음`,
    [t.road ? `도로 ${t.road}` : '', t.dealType ?? ''].filter(Boolean).join(', '),
  ]
    .filter(Boolean)
    .join('\n');
}
/** 구 표의 '가장 싼 거래' 칸 */
const cheapText = (t: HouseTradeView) => `${t.dong} ${m2(t.landM2)} ${manwon(t.price)}`;
</script>

<template>
  <details class="trades fold" :open="open" @toggle="onToggle">
    <summary :title="headTitle">
      <span class="fold-name">오래된 단독주택 실거래</span>
      <template v-if="summary?.total">
        <span class="muted num fold-count">서울 {{ count(summary.total) }}건</span>
        <span class="num rate">중간 {{ manwon(summary.medianPrice!) }}</span>
        <span v-if="nearGus.length" class="stats">
          <span v-for="g in nearGus" :key="g.name" class="num stat" :title="`${g.name} ${count(g.count)}건, 중간 ${manwon(g.medianPrice)}, 대지 평당 중간 ${g.landPy != null ? manwon(g.landPy) : '?'}`">
            {{ g.name }} {{ count(g.count) }}건 {{ manwon(g.medianPrice) }}
          </span>
        </span>
      </template>
      <span v-else class="muted fold-count">{{ summary?.fetchedAt ? '없음' : '아직 안 받음' }}</span>
      <span v-if="errorText" class="failed" :title="errorText">받기 실패</span>
    </summary>
    <div class="body fold-body">
      <div class="bar">
        <div class="ages" role="group" aria-label="지은 지">
          <button
            v-for="a in AGES" :key="a" class="age-btn" :class="{ on: age === a }" :aria-pressed="age === a" :title="`지은 지 ${a}년 넘은 단독주택만 봅니다`"
            @click="emit('age', a)"
          >{{ a }}년</button>
        </div>
        <span class="muted when">{{ fetchedText }}</span>
        <button class="btn btn-sm" :disabled="fetching" title="국토부 실거래가 공개시스템에서 서울 단독, 다가구 매매(최근 1년)를 지금 받습니다" @click="emit('fetch')">
          {{ fetching ? '받는 중…' : '지금 받기' }}
        </button>
      </div>
      <template v-if="summary?.total">
        <table class="grid buckets">
          <thead>
            <tr>
              <th scope="col">매매가</th>
              <th scope="col" class="r">서울</th>
              <th v-if="nearGus.length" scope="col" class="r" :title="nearGus.map((g) => g.name).join(', ')">근처 구</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in summary.buckets" :key="b.label">
              <th scope="row">{{ b.label }}</th>
              <td class="num r">{{ count(b.seoul) }}</td>
              <td v-if="nearGus.length" class="num r">{{ count(b.near) }}</td>
            </tr>
          </tbody>
        </table>
        <div class="gus-wrap">
          <table class="grid gus">
            <thead>
              <tr>
                <th scope="col">구</th>
                <th scope="col" class="r">거래</th>
                <th scope="col" class="r">중간값</th>
                <th scope="col" class="r" title="매매가 ÷ 대지 평 중간값">대지 평당</th>
                <th scope="col">가장 싼 거래</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="g in summary.gus" :key="g.name">
                <tr class="gu" :class="{ near: g.near }" :title="`누르면 ${g.name} 동별로 봅니다`" @click="toggleGu(g.name)">
                  <th scope="row"><span class="mark">{{ openGu === g.name ? '▾' : '▸' }}</span>{{ g.name }}</th>
                  <td class="num r">{{ count(g.count) }}</td>
                  <td class="num r">{{ manwon(g.medianPrice) }}</td>
                  <td class="num r">{{ g.landPy != null ? manwon(g.landPy) : '' }}</td>
                  <td class="cheap" :title="tradeTitle(g.cheapest)">{{ cheapText(g.cheapest) }}</td>
                </tr>
                <template v-if="openGu === g.name">
                  <tr v-for="d in g.dongs" :key="`${g.name}-${d.name}`" class="dong">
                    <th scope="row">{{ d.name }}</th>
                    <td class="num r">{{ count(d.count) }}</td>
                    <td class="num r">{{ manwon(d.medianPrice) }}</td>
                    <td class="num r">{{ d.landPy != null ? manwon(d.landPy) : '' }}</td>
                    <td class="cheap" :title="tradeTitle(d.cheapest)">{{ m2(d.cheapest.landM2) }} {{ manwon(d.cheapest.price) }}</td>
                  </tr>
                </template>
              </template>
            </tbody>
          </table>
        </div>
        <section class="cheapest">
          <h4 class="sub-head">싼 거래 <span class="muted num">{{ summary.cheapest.length }}건</span></h4>
          <ul class="rows">
            <li v-for="(t, i) in summary.cheapest" :key="i" class="row" :title="tradeTitle(t)">
              <span class="num price">{{ manwon(t.price) }}</span>
              <span class="what"><b>{{ t.gu }} {{ t.dong }}</b> <span class="muted">대지 {{ m2(t.landM2) }}, 집 {{ m2(t.floorM2) }}, {{ t.builtYear }}년</span></span>
              <span class="num per">{{ perPy(t) }}</span>
              <span class="muted when-col">{{ dot(t.date).slice(0, 7) }} {{ t.dealType === '직거래' ? '직거래' : '' }}</span>
            </li>
          </ul>
        </section>
      </template>
      <p v-else class="empty muted">{{ summary?.fetchedAt ? '해당 거래 없음' : '아직 안 받음' }}</p>
    </div>
  </details>
</template>

<style scoped>
.rate { font-size: 15px; font-weight: 800; color: var(--accent); }
.stats { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; font-size: 13px; }
.stat { font-weight: 700; color: var(--ink-2); }
.failed { font-size: 13px; font-weight: 700; color: var(--new); }
.body { display: grid; gap: 12px; container-type: inline-size; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ages { display: flex; gap: 4px; }
.age-btn { min-height: 32px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); font-size: 13px; font-weight: 700; color: var(--ink-2); }
.age-btn.on { border-color: var(--ink); background: var(--ink); color: #fff; }
.when { font-size: 13px; }
/* 표: 숫자 칸은 오른쪽 맞춤이라 줄끼리 숫자 끝이 맞는다. 구 표는 좁으면 옆으로 넘긴다. */
.grid {
  border-collapse: separate; border-spacing: 0; justify-self: start;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); font-size: 14px;
}
.grid th, .grid td { padding: 6px 14px; white-space: nowrap; border-top: 1px solid var(--line); text-align: left; }
.grid thead th { border-top: 0; font-size: 13px; font-weight: 700; color: var(--ink-2); }
.grid tbody th { font-weight: 700; }
.grid .r { text-align: right; }
.grid td.num { font-weight: 700; }
.gus-wrap { overflow-x: auto; }
.gus tr.gu { cursor: pointer; }
.gus tr.gu:hover { background: var(--accent-soft); }
.gus tr.near th { color: var(--accent); }
.gus .mark { display: inline-block; width: 16px; font-size: 12px; color: var(--muted); }
.gus tr.dong th { padding-left: 34px; font-weight: 600; color: var(--ink-2); }
.gus tr.dong td { font-size: 13px; }
.cheap { font-size: 13px; color: var(--ink-2); }
.sub-head { margin: 0 0 6px; font-size: 15px; font-weight: 800; color: var(--ink-2); }
.sub-head .muted { font-size: 13px; font-weight: 600; }
.rows { list-style: none; margin: 0; padding: 0; }
.row {
  display: grid; grid-template-columns: 110px minmax(0, 1fr) 90px 104px; gap: 4px 12px; align-items: baseline;
  padding: 7px 0; border-top: 1px solid var(--line); font-size: 14px;
}
.row:first-child { border-top: 0; }
.price { text-align: right; font-weight: 800; }
.what { min-width: 0; overflow-wrap: anywhere; }
.what .muted { margin-left: 4px; font-size: 13px; }
.per { text-align: right; font-size: 13px; font-weight: 700; color: var(--ink-2); }
.when-col { font-size: 12px; white-space: nowrap; }
.empty { margin: 0; padding: 8px 0; font-size: 14px; }
/* 좁으면(지도 옆 목록) 평당과 계약 달을 아래 줄로. */
@container (max-width: 560px) {
  .row { grid-template-columns: 110px minmax(0, 1fr); }
  .per, .when-col { grid-column: 2; text-align: left; }
}
</style>
