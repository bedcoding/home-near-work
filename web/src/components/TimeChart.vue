<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

// 시세 통계 탭 그래프: 날짜가 고르게 놓인 선(지수)과 막대(거래량). 가로는 날짜 자리(월간, 주간은 간격이 고르다), 세로는 값.
// 마우스나 손가락을 올린 자리의 날짜와 값을 위에 띄운다. baseline은 점선 가로줄(매수우위지수 100), faded는 끝에서 흐리게 그릴 막대 수.
// 넓이는 감싼 칸을 따라가고(ResizeObserver), 글자는 늘어나지 않게 픽셀 좌표로 그린다.

export interface ChartSeries {
  id: string;
  name: string;
  color: string;
  /** dates와 같은 순서, 없는 날은 null */
  values: (number | null)[];
  /** 막대로 그린다(아니면 선) */
  bar?: boolean;
  /** 점선 */
  dashed?: boolean;
}

const props = withDefaults(
  defineProps<{
    /** 월간 YYYY-MM, 주간 YYYY-MM-DD */
    dates: string[];
    series: ChartSeries[];
    /** 그래프 설명(화면 읽기 프로그램용) */
    label: string;
    format?: (v: number) => string;
    baseline?: number | null;
    faded?: number;
    /** 세로를 0부터 */
    zero?: boolean;
    height?: number;
    /** 올린 자리 날짜 글자(없으면 '2026.09') */
    dateText?: (date: string) => string;
  }>(),
  { format: (v: number) => v.toLocaleString('ko-KR', { maximumFractionDigits: 1 }), baseline: null, faded: 0, zero: false, height: 220, dateText: undefined },
);

const box = ref<HTMLDivElement | null>(null);
const width = ref(600);
let observer: ResizeObserver | null = null;
onMounted(() => {
  observer = new ResizeObserver(([e]) => (width.value = Math.max(240, Math.round(e.contentRect.width))));
  if (box.value) observer.observe(box.value);
});
onBeforeUnmount(() => observer?.disconnect());

const M = { left: 46, right: 10, top: 10, bottom: 24 };
const plotW = computed(() => width.value - M.left - M.right);
const plotH = computed(() => props.height - M.top - M.bottom);
const n = computed(() => props.dates.length);
const hasBars = computed(() => props.series.some((s) => s.bar));

/** 자리 i의 가로 위치(막대가 있으면 칸 가운데) */
function xOf(i: number): number {
  if (hasBars.value) return M.left + ((i + 0.5) / Math.max(1, n.value)) * plotW.value;
  return M.left + (n.value <= 1 ? plotW.value / 2 : (i / (n.value - 1)) * plotW.value);
}

/** 세로 범위와 눈금: 1, 2, 2.5, 5 × 10^k 간격으로 다섯 칸 안팎 */
const scale = computed(() => {
  const all = props.series.flatMap((s) => s.values.filter((v): v is number => v != null));
  if (props.baseline != null) all.push(props.baseline);
  if (!all.length) return null;
  let lo = props.zero ? Math.min(0, ...all) : Math.min(...all);
  let hi = Math.max(...all);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const raw = (hi - lo) / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { min, max, ticks };
});
const yOf = (v: number) => M.top + (1 - (v - scale.value!.min) / (scale.value!.max - scale.value!.min)) * plotH.value;

/** 가로 눈금: 해가 바뀌는 자리. 글자끼리 52px 넘게 떨어지도록 몇 해씩 건너뛴다(그해가 그 수로 나누어지는 해만). */
const xTicks = computed(() => {
  const starts = props.dates
    .map((d, i) => ({ i, year: Number(d.slice(0, 4)), first: i === 0 ? d.slice(5, 7) === '01' : d.slice(0, 4) !== props.dates[i - 1].slice(0, 4) }))
    .filter((d) => d.first);
  if (!starts.length) return [];
  const gap = starts.length > 1 ? (xOf(starts[starts.length - 1].i) - xOf(starts[0].i)) / (starts.length - 1) : Infinity;
  const every = gap >= 52 ? 1 : [2, 5, 10].find((k) => gap * k >= 52) ?? 20;
  return starts.filter((d) => d.year % every === 0).map((d) => ({ x: xOf(d.i), text: String(d.year) }));
});

/** 선마다 SVG 길(값이 없는 날에서 끊는다) */
const paths = computed(() =>
  scale.value
    ? props.series
        .filter((s) => !s.bar)
        .map((s) => {
          let d = '';
          let pen = false;
          s.values.forEach((v, i) => {
            if (v == null) {
              pen = false;
              return;
            }
            d += `${pen ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`;
            pen = true;
          });
          return { id: s.id, color: s.color, dashed: !!s.dashed, d };
        })
    : [],
);

/** 막대(0에서 값까지). 끝에서 faded개는 흐리게. */
const rects = computed(() => {
  if (!scale.value) return [];
  const band = plotW.value / Math.max(1, n.value);
  const w = Math.max(1, band - (band > 6 ? 2 : band > 3 ? 1 : 0));
  const y0 = yOf(Math.max(scale.value.min, 0));
  return props.series
    .filter((s) => s.bar)
    .flatMap((s) =>
      s.values.flatMap((v, i) =>
        v == null ? [] : [{ key: `${s.id}-${i}`, x: xOf(i) - w / 2, y: Math.min(yOf(v), y0), w, h: Math.abs(y0 - yOf(v)), color: s.color, faded: i >= n.value - props.faded }],
      ),
    );
});

/** 올린 자리 */
const hover = ref<number | null>(null);
function onMove(e: PointerEvent) {
  if (!n.value) return;
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
  const x = e.clientX - rect.left;
  const i = hasBars.value ? Math.floor(((x - M.left) / plotW.value) * n.value) : Math.round(((x - M.left) / plotW.value) * (n.value - 1));
  hover.value = Math.max(0, Math.min(n.value - 1, i));
}
/** 손가락은 떼면 자리를 떠나므로, 그때는 값을 남겨 두고 다른 자리를 누를 때 바꾼다 */
const onLeave = (e: PointerEvent) => {
  if (e.pointerType !== 'touch') hover.value = null;
};
const dot = (date: string) => date.replace(/-/g, '.');
const tip = computed(() => {
  const i = hover.value;
  if (i == null || !scale.value) return null;
  const rows = props.series.map((s) => ({ name: s.name, color: s.color, value: s.values[i] })).filter((r) => r.value != null);
  if (!rows.length) return null;
  const x = xOf(i);
  return { x, left: Math.min(Math.max(x - 90, 0), width.value - 180), date: (props.dateText ?? dot)(props.dates[i]), faded: hasBars.value && i >= n.value - props.faded, rows };
});
</script>

<template>
  <div ref="box" class="time-chart">
    <svg
      v-if="scale" :width="width" :height="height" role="img" :aria-label="label"
      @pointermove="onMove" @pointerdown="onMove" @pointerleave="onLeave"
    >
      <g class="grid">
        <template v-for="t in scale.ticks" :key="t">
          <line :x1="M.left" :x2="width - M.right" :y1="yOf(t)" :y2="yOf(t)" />
          <text :x="M.left - 6" :y="yOf(t) + 4" text-anchor="end">{{ format(t) }}</text>
        </template>
      </g>
      <line v-if="baseline != null" class="baseline" :x1="M.left" :x2="width - M.right" :y1="yOf(baseline)" :y2="yOf(baseline)" />
      <g class="x-axis">
        <template v-for="t in xTicks" :key="t.text">
          <line :x1="t.x" :x2="t.x" :y1="M.top + plotH" :y2="M.top + plotH + 4" />
          <text :x="t.x" :y="height - 6" text-anchor="middle">{{ t.text }}</text>
        </template>
      </g>
      <rect v-for="r in rects" :key="r.key" :x="r.x" :y="r.y" :width="r.w" :height="r.h" :fill="r.color" :opacity="r.faded ? 0.35 : 0.85" />
      <path v-for="p in paths" :key="p.id" :d="p.d" fill="none" :stroke="p.color" stroke-width="2" stroke-linejoin="round" :stroke-dasharray="p.dashed ? '5 4' : undefined" />
      <line v-if="tip" class="cursor" :x1="tip.x" :x2="tip.x" :y1="M.top" :y2="M.top + plotH" />
    </svg>
    <p v-else class="empty muted">자료가 없습니다</p>
    <div v-if="tip" class="tip" :style="{ left: `${tip.left}px` }" aria-live="polite">
      <b class="num">{{ tip.date }}</b><span v-if="tip.faded" class="muted"> 덜 들어옴</span>
      <span v-for="r in tip.rows" :key="r.name" class="tip-row"><i :style="{ background: r.color }" />{{ r.name }} <b class="num">{{ format(r.value!) }}</b></span>
    </div>
  </div>
</template>

<style scoped>
.time-chart { position: relative; min-width: 0; }
svg { display: block; touch-action: pan-y; user-select: none; }
.grid line { stroke: var(--line); stroke-width: 1; }
.grid text, .x-axis text { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.x-axis line { stroke: var(--line-strong); }
.baseline { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 4 4; }
.cursor { stroke: var(--ink-2); stroke-width: 1; opacity: .5; }
.tip {
  position: absolute; top: 0; z-index: 2; display: grid; gap: 1px; width: 180px; padding: 6px 8px; border: 1px solid var(--line-strong); border-radius: 8px;
  background: var(--surface); box-shadow: 0 4px 14px rgba(20, 30, 50, .12); font-size: 12px; pointer-events: none;
}
.tip-row { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tip-row i { flex: none; width: 10px; height: 3px; border-radius: 2px; }
.tip-row b { margin-left: auto; }
.empty { margin: 0; padding: 24px 0; text-align: center; font-size: 13px; }
</style>
