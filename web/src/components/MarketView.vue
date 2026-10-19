<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { MarketLine, MarketTier, MarketView } from '../../../shared/types';
import { manwon } from '../../../shared/format';
import { changeOf, LINE_COLORS, MARKET_CHECKED, MARKET_LINKS, MARKET_NOTES, pct, TIER_NAMES } from '../market';
import TimeChart, { type ChartSeries } from './TimeChart.vue';

// 시세 통계 탭: 지금 서울 아파트가 오르는지 내리는지(KB 주간 지수, 매수우위지수, 실거래 거래량, 서울과 전국 1년 변동),
// KB 월간 매매가격지수 그래프(고른 기간 첫 달을 100으로 맞춤, 전국, 서울, 권역, 구), 매수우위지수 그래프(100 점선),
// 서울 아파트 월별 거래량(구 고르기, 신고 기한 안 달은 흐리게, 12달 평균 선), 구별 급지표(누르면 동별)와 읽는 법.
// 고른 기간, 켠 선, 거래량 구는 이 브라우저에 기억한다.

const props = defineProps<{
  /** 탭 자료(아직 못 읽었으면 null) */
  view: MarketView | null;
  /** 지금 받는 중 */
  fetching: boolean;
  /** '지금 받기'에서 난 오류 */
  error: string | null;
  /** 조회가 도는 중 */
  running: boolean;
}>();
const emit = defineEmits<{ fetch: [] }>();

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 저장이 막힌 브라우저는 기억하지 않는다 */
  }
}

const dot = (date: string) => date.replace(/-/g, '.');
const monthText = (ym: string | null) => (ym ? `${Number(ym.slice(5, 7))}월` : '?');
const count = (x: number | null) => (x == null ? '?' : x.toLocaleString('ko-KR'));
const fetchedText = (iso: string | null) => {
  if (!iso) return '아직 안 받음';
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 받음`;
};

const now = computed(() => props.view?.now ?? null);
const empty = computed(() => !!props.view && !props.view.kb.fetchedAt && !props.view.trades.fetchedAt);
const errors = computed(() =>
  [props.error, props.view?.kb.error && `KB: ${props.view.kb.error}`, props.view?.trades.error && `실거래: ${props.view.trades.error}`].filter((x): x is string => !!x),
);

// ---------- 지금 흐름 ----------
const TREND = { up: '오르는 중', down: '내리는 중', flat: '보합' } as const;
const buyerMeaning = (v: number | null) => (v == null ? '' : v > 100 ? '사려는 쪽이 많음' : v < 100 ? '팔려는 쪽이 많음' : '비슷함');
/** 세 신호(가격, 매수우위, 거래량)가 가리키는 쪽 */
const signals = computed(() => {
  const n = now.value;
  if (!n) return [];
  const volume = changeOf(n.volume3, n.volume3LastYear);
  return [
    n.trend && { name: '가격', up: n.trend === 'up', down: n.trend === 'down', text: TREND[n.trend] },
    n.buyerSeoul != null && { name: '매수우위', up: n.buyerSeoul > 100, down: n.buyerSeoul < 100, text: n.buyerSeoul > 100 ? '100 위' : n.buyerSeoul < 100 ? '100 밑' : '100' },
    volume != null && { name: '거래량', up: volume > 0, down: volume < 0, text: `1년 전보다 ${volume > 0 ? '많음' : volume < 0 ? '적음' : '같음'}` },
  ].filter((x): x is { name: string; up: boolean; down: boolean; text: string } => !!x);
});

// ---------- 그래프 기간(세 그래프가 같이 쓴다) ----------
const RANGES = [
  { id: '3y', label: '3년', years: 3 },
  { id: '5y', label: '5년', years: 5 },
  { id: '10y', label: '10년', years: 10 },
  { id: '20y', label: '20년', years: 20 },
  { id: 'all', label: '전체', years: Infinity },
] as const;
type RangeId = (typeof RANGES)[number]['id'];
const savedRange = load<string>('hnw-market-range', '10y');
const range = ref<RangeId>(RANGES.some((r) => r.id === savedRange) ? (savedRange as RangeId) : '10y');
watch(range, (r) => save('hnw-market-range', r));
const rangeYears = computed(() => RANGES.find((r) => r.id === range.value)!.years);
/** 고른 기간의 첫 자리: 마지막 날에서 그 햇수만큼 앞선 날(월간 YYYY-MM, 주간 YYYY-MM-DD) 이후 */
function rangeStart(dates: string[]): number {
  if (!dates.length || rangeYears.value === Infinity) return 0;
  const last = dates[dates.length - 1];
  const cutoff = `${Number(last.slice(0, 4)) - rangeYears.value}${last.slice(4)}`;
  const i = dates.findIndex((d) => d >= cutoff);
  return i < 0 ? 0 : i;
}

// ---------- 가격지수 그래프 ----------
const priceLines = computed(() => props.view?.price.lines ?? []);
const topLines = computed(() => priceLines.value.filter((l) => l.kind !== 'gu'));
const guLines = computed(() => priceLines.value.filter((l) => l.kind === 'gu'));
/** 켠 선(지역코드). 고른 적이 없으면 전국, 서울, 근처 구. */
const picked = ref<string[] | null>(load<string[] | null>('hnw-market-lines', null));
const shownCodes = computed(() => picked.value ?? priceLines.value.filter((l) => l.kind === 'nation' || l.kind === 'seoul' || l.near).map((l) => l.code));
function toggleLine(code: string) {
  const list = shownCodes.value.includes(code) ? shownCodes.value.filter((c) => c !== code) : [...shownCodes.value, code];
  picked.value = list;
  save('hnw-market-lines', list);
}
/** 선 색: 전국 회색, 서울 파랑, 나머지는 켠 차례대로 */
function colorsOf(lines: MarketLine[]): Map<string, string> {
  const out = new Map<string, string>();
  let k = 0;
  for (const l of lines) out.set(l.code, l.kind === 'nation' ? LINE_COLORS.nation : l.kind === 'seoul' ? LINE_COLORS.seoul : LINE_COLORS.others[k++ % LINE_COLORS.others.length]);
  return out;
}
const priceChart = computed(() => {
  const v = props.view;
  if (!v) return { dates: [] as string[], series: [] as ChartSeries[], changes: [] as { name: string; color: string; change: number | null }[] };
  const from = rangeStart(v.price.dates);
  const dates = v.price.dates.slice(from);
  const lines = v.price.lines.filter((l) => shownCodes.value.includes(l.code));
  const colors = colorsOf(lines);
  const series = lines.map((l) => {
    const values = l.values.slice(from);
    const base = values.find((x) => x != null) ?? null;
    return { id: l.code, name: l.name, color: colors.get(l.code)!, values: values.map((x) => (x == null || !base ? null : Math.round((x / base) * 1000) / 10)) };
  });
  const changes = series.map((s) => {
    const last = [...s.values].reverse().find((x) => x != null) ?? null;
    return { name: s.name, color: s.color, change: last == null ? null : Math.round((last - 100) * 10) / 10 };
  });
  return { dates, series, changes };
});

// ---------- 매수우위지수 그래프 ----------
const buyerPicked = ref<string[] | null>(load<string[] | null>('hnw-market-buyer-lines', null));
const buyerShown = computed(() => buyerPicked.value ?? (props.view?.buyer.lines ?? []).filter((l) => l.kind === 'nation' || l.kind === 'seoul').map((l) => l.code));
function toggleBuyer(code: string) {
  const list = buyerShown.value.includes(code) ? buyerShown.value.filter((c) => c !== code) : [...buyerShown.value, code];
  buyerPicked.value = list;
  save('hnw-market-buyer-lines', list);
}
const buyerChart = computed(() => {
  const v = props.view;
  if (!v) return { dates: [] as string[], series: [] as ChartSeries[] };
  const from = rangeStart(v.buyer.dates);
  const lines = v.buyer.lines.filter((l) => buyerShown.value.includes(l.code));
  const colors = colorsOf(lines);
  return {
    dates: v.buyer.dates.slice(from),
    series: lines.map((l) => ({ id: l.code, name: l.name, color: colors.get(l.code)!, values: l.values.slice(from).map((x) => (x == null ? null : Math.round(x * 10) / 10)) })),
  };
});

// ---------- 거래량 그래프 ----------
const volumeGu = ref<string>(load<string>('hnw-market-volume-gu', '서울'));
watch(volumeGu, (g) => save('hnw-market-volume-gu', g));
const volumeGuChoices = computed(() => {
  const gus = props.view?.volume.gus ?? [];
  return [...gus.filter((g) => g.near), ...gus.filter((g) => !g.near)];
});
const volumeChart = computed(() => {
  const v = props.view?.volume;
  if (!v || !v.months.length) return { dates: [] as string[], series: [] as ChartSeries[] };
  const counts = volumeGu.value === '서울' ? v.seoul : (v.gus.find((g) => g.gu === volumeGu.value)?.counts ?? v.seoul);
  const complete = counts.length - v.incomplete;
  const avg = counts.map((_, i) => (i >= 11 && i < complete ? Math.round(counts.slice(i - 11, i + 1).reduce((a, b) => a + b, 0) / 12) : null));
  const from = rangeStart(v.months);
  return {
    dates: v.months.slice(from),
    series: [
      { id: 'count', name: '거래', color: LINE_COLORS.seoul, values: counts.slice(from), bar: true },
      { id: 'avg', name: '12달 평균', color: '#b74757', values: avg.slice(from) },
    ],
  };
});

// ---------- 급지표 ----------
const CHANGE_SPANS = [
  { id: 'y1', label: '1년' },
  { id: 'y5', label: '5년' },
  { id: 'y10', label: '10년' },
] as const;
type ChangeSpan = (typeof CHANGE_SPANS)[number]['id'];
const savedSpan = load<string>('hnw-market-tier-change', 'y5');
const changeSpan = ref<ChangeSpan>(CHANGE_SPANS.some((c) => c.id === savedSpan) ? (savedSpan as ChangeSpan) : 'y5');
watch(changeSpan, (c) => save('hnw-market-tier-change', c));
const changeLabel = computed(() => CHANGE_SPANS.find((c) => c.id === changeSpan.value)!.label);
const openGu = ref<string | null>(null);
const toggleGu = (gu: string) => (openGu.value = openGu.value === gu ? null : gu);
/** 급지 묶음마다 구들(순위 순) */
const tierGroups = computed(() => {
  const out: { tier: number; rows: MarketTier[] }[] = [];
  for (const t of props.view?.tiers?.gus ?? []) {
    const last = out[out.length - 1];
    if (last?.tier === t.tier) last.rows.push(t);
    else out.push({ tier: t.tier, rows: [t] });
  }
  return out;
});
/** 큰 금액을 짧게('23.9억', 1억이 안 되면 '9,000만') */
const eok = (x: number) => (x >= 10000 ? `${(x / 10000).toFixed(1)}억` : manwon(x));
const indexFormat = (v: number) => v.toFixed(1).replace(/\.0$/, '');
const countFormat = (v: number) => Math.round(v).toLocaleString('ko-KR');
</script>

<template>
  <section class="market">
    <div class="market-heading">
      <h2 class="market-title">시세 통계</h2>
      <span class="muted when" :title="`KB 통계는 3일, 실거래 최근 1년은 7일에 한 번 조회할 때 새로 받습니다`">
        KB {{ fetchedText(view?.kb.fetchedAt ?? null) }} · 실거래 {{ fetchedText(view?.trades.fetchedAt ?? null) }}
      </span>
      <button
        class="btn run" :disabled="fetching || running"
        title="KB 통계와 국토부 실거래(서울 아파트 최근 1년, 아직 안 받은 지난 해)를 지금 받습니다. 처음에는 해마다 받아 몇 분 걸릴 수 있습니다."
        @click="emit('fetch')"
      >{{ fetching ? '받는 중…' : '지금 받기' }}</button>
    </div>
    <p v-for="e in errors" :key="e" class="err" role="alert">{{ e }}</p>

    <p v-if="!view" class="muted">불러오는 중…</p>
    <p v-else-if="empty" class="intro">
      아직 받은 자료가 없습니다. '지금 받기'를 누르면 KB 아파트 매매가격지수와 매수우위지수, 국토부 실거래가(서울 아파트 매매, 2018년부터)를 받습니다.
      실거래는 해마다 따로 받아 처음에는 몇 분 걸릴 수 있습니다. 그 뒤로는 조회할 때 알아서 새로 받습니다.
    </p>

    <template v-if="view && !empty">
      <section class="now" aria-label="지금 서울 아파트">
        <div class="now-card">
          <span class="now-name">가격 <span class="muted">KB 주간, 서울</span></span>
          <b class="now-big" :class="now?.trend">{{ now?.trend ? TREND[now.trend] : '자료 없음' }}</b>
          <span class="num">4주 {{ pct(now?.w4 ?? null) }} · 13주 {{ pct(now?.w13 ?? null) }} · 1년 {{ pct(now?.w52 ?? null) }}</span>
          <span class="muted now-foot">{{ now?.week ? `${dot(now.week)} 기준` : '' }} 4주 변동이 ±0.1%를 넘으면 오르는 중·내리는 중</span>
        </div>
        <div class="now-card">
          <span class="now-name">매수우위지수 <span class="muted">KB 주간, 서울</span></span>
          <b class="now-big num">{{ now?.buyerSeoul != null ? indexFormat(now.buyerSeoul) : '자료 없음' }}</b>
          <span>{{ buyerMeaning(now?.buyerSeoul ?? null) }}<template v-if="now?.buyerSeoul != null">(100이 비슷함)</template></span>
          <span class="muted now-foot num">최근 4주 평균 {{ now?.buyerSeoul4 != null ? indexFormat(now.buyerSeoul4) : '?' }}, 전국 {{ now?.buyerNation != null ? indexFormat(now.buyerNation) : '?' }}</span>
        </div>
        <div class="now-card">
          <span class="now-name">거래량 <span class="muted">실거래, 서울 아파트</span></span>
          <b class="now-big num">{{ now?.volumeMonth ? `${monthText(now.volumeMonth)} ${count(now.volume)}건` : '자료 없음' }}</b>
          <span class="num">1년 전 같은 달 {{ count(now?.volumeLastYear ?? null) }}건({{ pct(changeOf(now?.volume ?? null, now?.volumeLastYear ?? null)) }})</span>
          <span class="num">3개월 {{ count(now?.volume3 ?? null) }}건, 1년 전 {{ count(now?.volume3LastYear ?? null) }}건({{ pct(changeOf(now?.volume3 ?? null, now?.volume3LastYear ?? null)) }})</span>
          <span class="muted now-foot">신고 기한(계약 뒤 30일)이 지난 마지막 달 기준</span>
        </div>
        <div class="now-card now-long">
          <span class="now-name">서울과 전국 <span class="muted">KB 월간, 길게 본 변동</span></span>
          <table v-if="now" class="long num">
            <thead><tr><th scope="col"><span class="sr-only">지역</span></th><th scope="col">1년</th><th scope="col">5년</th><th scope="col">10년</th></tr></thead>
            <tbody>
              <tr><th scope="row">서울</th><td>{{ pct(now.seoulChange.y1) }}</td><td>{{ pct(now.seoulChange.y5) }}</td><td>{{ pct(now.seoulChange.y10) }}</td></tr>
              <tr><th scope="row">전국</th><td>{{ pct(now.nationChange.y1) }}</td><td>{{ pct(now.nationChange.y5) }}</td><td>{{ pct(now.nationChange.y10) }}</td></tr>
            </tbody>
          </table>
          <span class="muted now-foot">{{ now?.month ? `${dot(now.month)}까지` : '' }}</span>
        </div>
      </section>
      <p v-if="signals.length" class="signals">
        <span class="signals-label">지금 가리키는 쪽</span>
        <span v-for="s in signals" :key="s.name" class="signal" :class="{ up: s.up, down: s.down }">{{ s.name }} {{ s.up ? '↑' : s.down ? '↓' : '→' }} {{ s.text }}</span>
        <span class="muted">셋이 같은 쪽이면 흐름이 뚜렷하고, 엇갈리면 바뀌는 중일 수 있습니다.</span>
      </p>

      <section class="block" aria-labelledby="market-price">
        <div class="block-head">
          <h3 id="market-price" class="block-title">아파트 매매가격지수 <span class="muted">KB 월간, 고른 기간 첫 달 = 100</span></h3>
          <div class="seg" role="group" aria-label="그래프 기간(세 그래프 같이)">
            <button v-for="r in RANGES" :key="r.id" type="button" :class="{ on: range === r.id }" :aria-pressed="range === r.id" @click="range = r.id">{{ r.label }}</button>
          </div>
        </div>
        <div class="chips" role="group" aria-label="보일 지역">
          <button
            v-for="l in topLines" :key="l.code" type="button" class="line-chip" :class="{ on: shownCodes.includes(l.code) }" :aria-pressed="shownCodes.includes(l.code)"
            @click="toggleLine(l.code)"
          >{{ l.name }}</button>
        </div>
        <details class="gu-pick">
          <summary>구 고르기 <span class="muted">{{ guLines.filter((l) => shownCodes.includes(l.code)).map((l) => l.name).join(', ') || '없음' }}</span></summary>
          <div class="gu-grid" role="group" aria-label="보일 구">
            <button
              v-for="l in guLines" :key="l.code" type="button" class="line-chip" :class="{ on: shownCodes.includes(l.code), near: l.near }" :aria-pressed="shownCodes.includes(l.code)"
              :title="l.near ? '켜 둔 지역 근처 구' : undefined" @click="toggleLine(l.code)"
            >{{ l.name }}</button>
          </div>
        </details>
        <TimeChart :dates="priceChart.dates" :series="priceChart.series" label="아파트 매매가격지수, 고른 기간 첫 달을 100으로 맞춤" :format="indexFormat" :baseline="100" />
        <p v-if="priceChart.changes.length" class="changes">
          <span class="muted">{{ priceChart.dates[0] ? `${dot(priceChart.dates[0])}부터` : '' }}</span>
          <span v-for="c in priceChart.changes" :key="c.name" class="change"><i :style="{ background: c.color }" />{{ c.name }} <b class="num">{{ pct(c.change) }}</b></span>
        </p>
      </section>

      <section class="block" aria-labelledby="market-buyer">
        <div class="block-head">
          <h3 id="market-buyer" class="block-title">매수우위지수 <span class="muted">KB 주간, 100보다 크면 사려는 쪽이 많음</span></h3>
          <div class="seg" role="group" aria-label="그래프 기간(세 그래프 같이)">
            <button v-for="r in RANGES" :key="r.id" type="button" :class="{ on: range === r.id }" :aria-pressed="range === r.id" @click="range = r.id">{{ r.label }}</button>
          </div>
        </div>
        <div class="chips" role="group" aria-label="보일 지역">
          <button
            v-for="l in view.buyer.lines" :key="l.code" type="button" class="line-chip" :class="{ on: buyerShown.includes(l.code) }" :aria-pressed="buyerShown.includes(l.code)"
            @click="toggleBuyer(l.code)"
          >{{ l.name }}</button>
        </div>
        <TimeChart :dates="buyerChart.dates" :series="buyerChart.series" label="KB 주간 매수우위지수" :format="indexFormat" :baseline="100" />
      </section>

      <section class="block" aria-labelledby="market-volume">
        <div class="block-head">
          <h3 id="market-volume" class="block-title">아파트 거래량 <span class="muted">국토부 실거래, 계약한 달 기준</span></h3>
          <div class="head-tools">
            <label class="pick">
              <span class="sr-only">지역</span>
              <select v-model="volumeGu">
                <option value="서울">서울 전체</option>
                <option v-for="g in volumeGuChoices" :key="g.gu" :value="g.gu">{{ g.gu }}{{ g.near ? ' (근처)' : '' }}</option>
              </select>
            </label>
            <div class="seg" role="group" aria-label="그래프 기간(세 그래프 같이)">
              <button v-for="r in RANGES" :key="r.id" type="button" :class="{ on: range === r.id }" :aria-pressed="range === r.id" @click="range = r.id">{{ r.label }}</button>
            </div>
          </div>
        </div>
        <TimeChart :dates="volumeChart.dates" :series="volumeChart.series" label="서울 아파트 월별 거래량" :format="countFormat" :faded="view.volume.incomplete" zero />
        <p class="muted note">
          끝의 {{ view.volume.incomplete }}달은 신고 기한 안이라 덜 들어와 흐리게 그렸습니다.
          <template v-if="view.trades.coverageFrom">{{ dot(view.trades.coverageFrom) }}부터 받아 두었습니다.</template>
          <template v-if="view.trades.missingYears.length"> 아직 안 받은 해: {{ view.trades.missingYears.join(', ') }}년(조회할 때 두 해씩 받습니다).</template>
        </p>
      </section>

      <section class="block" aria-labelledby="market-tiers">
        <div class="block-head">
          <h3 id="market-tiers" class="block-title">구별 급지와 평당가 <span class="muted">아파트 실거래, 공식 분류 아님</span></h3>
          <div class="seg" role="group" aria-label="변동 기간">
            <button v-for="c in CHANGE_SPANS" :key="c.id" type="button" :class="{ on: changeSpan === c.id }" :aria-pressed="changeSpan === c.id" @click="changeSpan = c.id">{{ c.label }} 변동</button>
          </div>
        </div>
        <p v-if="view.tiers" class="muted note">
          계약일 {{ dot(view.tiers.from) }} ~ {{ dot(view.tiers.to) }}, 해제된 거래 뺌. 전용면적 평당 중간값 순위로 {{ view.tiers.gus.length }}개 구를 다섯 묶음으로 고르게 나눴습니다.
          '84㎡대 중간값'은 전용 84㎡ 이상 85㎡ 미만 거래만의 거래가 중간값이고, 그런 거래가 없으면 '-'입니다. 누르면 동별로 봅니다.
        </p>
        <div v-if="view.tiers" class="tier-wrap">
          <table class="grid tiers">
            <thead>
              <tr>
                <th scope="col" class="r wide">순위</th>
                <th scope="col">구</th>
                <th scope="col" class="r">평당 중간값</th>
                <th scope="col" class="r" title="전용 84㎡ 이상 85㎡ 미만 거래만의 거래가 중간값">84㎡대<span class="wide-text"> 중간값</span></th>
                <th scope="col" class="r wide">거래가 중간값</th>
                <th scope="col" class="r" :title="`KB 월간 매매가격지수로 본 최근 ${changeLabel} 변동`">{{ changeLabel }} 변동</th>
                <th scope="col" class="r wide">거래</th>
              </tr>
            </thead>
            <tbody v-for="g in tierGroups" :key="g.tier">
              <tr class="tier-head">
                <th colspan="7" scope="rowgroup">
                  <span class="tier-chip" :class="`tier-${g.tier}`">{{ TIER_NAMES[g.tier - 1] }}</span>
                  <span class="muted num">{{ g.rows[0].rank }}~{{ g.rows[g.rows.length - 1].rank }}위, 평당 {{ manwon(g.rows[g.rows.length - 1].pyeong) }} ~ {{ manwon(g.rows[0].pyeong) }}</span>
                </th>
              </tr>
              <template v-for="t in g.rows" :key="t.gu">
                <tr class="gu" :class="{ near: t.near }" :title="`누르면 ${t.gu} 동별로 봅니다`" @click="toggleGu(t.gu)">
                  <td class="num r wide">{{ t.rank }}</td>
                  <th scope="row"><span class="mark">{{ openGu === t.gu ? '▾' : '▸' }}</span>{{ t.gu }}<span v-if="t.near" class="chip chip-near near-chip">근처</span></th>
                  <td class="num r strong">{{ manwon(t.pyeong) }}</td>
                  <td v-if="t.median84 != null" class="num r" :title="`전용 84㎡대 ${count(t.count84)}건 중간값 ${manwon(t.median84)}`">{{ eok(t.median84) }}</td>
                  <td v-else class="num r muted" title="최근 1년 전용 84㎡대 거래 없음">-</td>
                  <td class="num r wide" :title="manwon(t.median)">{{ eok(t.median) }}</td>
                  <td class="num r" :class="{ up: (t.change[changeSpan] ?? 0) > 0, down: (t.change[changeSpan] ?? 0) < 0 }">{{ pct(t.change[changeSpan]) }}</td>
                  <td class="num r wide">{{ count(t.count) }}</td>
                </tr>
                <template v-if="openGu === t.gu">
                  <tr v-for="d in t.dongs" :key="`${t.gu}-${d.dong}`" class="dong">
                    <td class="wide" />
                    <th scope="row">{{ d.dong }} <span class="muted dong-count num">{{ count(d.count) }}건</span></th>
                    <td class="num r">{{ manwon(d.pyeong) }}</td>
                    <td />
                    <td class="wide" />
                    <td />
                    <td class="wide" />
                  </tr>
                </template>
              </template>
            </tbody>
          </table>
        </div>
        <p v-else class="muted note">실거래를 아직 안 받았습니다.</p>
      </section>
    </template>

    <details class="fold notes">
      <summary><span class="fold-name">읽는 법과 근거</span><span class="muted fold-count">{{ dot(MARKET_CHECKED) }} 확인</span></summary>
      <div class="fold-body">
        <ul class="note-list">
          <li v-for="n in MARKET_NOTES" :key="n.id">
            {{ n.text }}
            <span v-if="n.sources.length" class="sources">
              <a v-for="s in n.sources" :key="s.url" :href="s.url" target="_blank" rel="noopener">{{ s.title }}<template v-if="s.date"> ({{ dot(s.date) }})</template> ↗</a>
            </span>
          </li>
        </ul>
        <p class="links">
          <span class="links-label">원본</span>
          <a v-for="x in MARKET_LINKS" :key="x.url" :href="x.url" target="_blank" rel="noopener" :title="x.title">{{ x.label }} ↗</a>
        </p>
        <p class="muted note">KB 통계는 공식 오픈 API가 아니라 KB 데이터허브 화면이 쓰는 주소로 받아, KB가 주소를 바꾸면 못 받을 수 있습니다.</p>
      </div>
    </details>
  </section>
</template>

<style scoped>
.market { display: grid; gap: 14px; min-width: 0; }
.market-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.market-title { margin: 0; font-size: 20px; }
.when { font-size: 13px; }
.market-heading .btn { margin-left: auto; }
.err { margin: 0; font-size: 13px; font-weight: 600; color: var(--new); overflow-wrap: anywhere; }
.intro { margin: 0; line-height: 1.6; }

.now { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.now-card { display: grid; align-content: start; gap: 3px; min-width: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); font-size: 13px; }
.now-name { font-size: 13px; font-weight: 700; color: var(--ink-2); }
/* 지표 이름 아래 줄에 출처(좁은 카드에서 이름 가운데가 끊기지 않게) */
.now-name .muted { display: block; font-size: 12px; font-weight: 500; }
.now-big { font-size: 20px; font-weight: 800; color: var(--ink); }
.now-big.up { color: var(--up); }
.now-big.down { color: var(--down); }
.now-foot { font-size: 12px; }
/* 휴대폰처럼 카드가 두 줄로 놓이면 길게 본 변동 표는 한 줄을 다 쓴다 */
@media (max-width: 560px) {
  .now-long { grid-column: 1 / -1; }
}
.long { border-collapse: collapse; font-size: 13px; }
.long th, .long td { padding: 2px 8px 2px 0; text-align: right; white-space: nowrap; }
.long thead th { font-size: 11px; font-weight: 600; color: var(--muted); }
.long tbody th { text-align: left; font-weight: 700; }
.long td { font-weight: 700; }
.head-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.signals { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: -4px 0 0; font-size: 13px; }
.signals-label { font-weight: 700; }
.signal { padding: 1px 8px; border-radius: 999px; background: var(--surface-2); font-weight: 700; color: var(--ink-2); }
.signal.up { background: var(--up-soft); color: var(--up); }
.signal.down { background: var(--down-soft); color: var(--down); }

.block { display: grid; gap: 8px; min-width: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.block-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; }
.block-title { margin: 0; font-size: 15px; }
.block-title .muted { font-size: 12px; font-weight: 500; }
.seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: 8px; overflow: hidden; }
.seg button { min-height: 30px; padding: 0 12px; border: 0; border-left: 1px solid var(--line-strong); background: var(--surface); font-size: 13px; font-weight: 700; color: var(--ink-2); }
.seg button:first-child { border-left: 0; }
.seg button.on { background: var(--ink); color: #fff; }
.chips, .gu-grid { display: flex; flex-wrap: wrap; gap: 4px; }
.line-chip { min-height: 28px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); font-size: 12px; font-weight: 700; color: var(--muted); }
.line-chip.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.line-chip.near { border-style: dashed; }
.gu-pick > summary { cursor: pointer; font-size: 13px; font-weight: 700; color: var(--ink-2); }
.gu-pick .gu-grid { margin-top: 6px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.pick select { min-height: 32px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); font-size: 13px; }
.changes { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 12px; margin: 0; font-size: 13px; }
.change { display: inline-flex; align-items: center; gap: 5px; }
.change i { width: 12px; height: 3px; border-radius: 2px; }
.note { margin: 0; font-size: 12px; line-height: 1.55; }

.tier-wrap { overflow-x: auto; container-type: inline-size; }
.dong-count { margin-left: 4px; font-size: 11px; font-weight: 500; }
.grid { border-collapse: separate; border-spacing: 0; font-size: 13px; }
.grid th, .grid td { padding: 6px 10px; white-space: nowrap; border-top: 1px solid var(--line); text-align: left; }
.grid thead th { border-top: 0; font-size: 12px; font-weight: 700; color: var(--ink-2); }
.grid tbody th { font-weight: 700; }
.grid .r { text-align: right; }
.grid td.strong { font-weight: 800; }
.tiers tr.tier-head th { padding-top: 10px; border-top: 2px solid var(--line-strong); font-weight: 500; font-size: 12px; }
.tiers tbody:first-of-type tr.tier-head th { border-top: 0; }
.tiers tr.tier-head .tier-chip { margin-right: 6px; }
.tiers tr.gu { cursor: pointer; }
.tiers tr.gu:hover { background: var(--accent-soft); }
.tiers tr.near th { color: var(--accent); }
.tiers tr.dong th { padding-left: 24px; font-weight: 500; color: var(--ink-2); }
.tiers td.up { color: var(--up); }
.tiers td.down { color: var(--down); }
.mark { display: inline-block; width: 14px; color: var(--muted); }
.near-chip { margin-left: 6px; font-size: 11px; }
.tier-chip { display: inline-block; padding: 1px 8px; border-radius: 6px; font-size: 12px; font-weight: 800; }
.tier-chip.tier-1 { background: #e7eefb; color: #23498a; }
.tier-chip.tier-2 { background: #eaf3f6; color: #1f6377; }
.tier-chip.tier-3 { background: #eef3ea; color: #3f6328; }
.tier-chip.tier-4 { background: #fbf2e4; color: #85561c; }
.tier-chip.tier-5 { background: #f7eaea; color: #8c3a3a; }

/* 좁으면 순위, 거래가 중간값, 거래 수 칸을 빼고(동 줄의 건수는 이름 옆에 남는다) 머리 글자와 칸 여백을 줄인다 */
@media (max-width: 560px) {
  .grid .wide, .grid .wide-text { display: none; }
  .grid th, .grid td { padding: 6px 7px; }
  .tier-chip { padding: 1px 5px; font-size: 11px; }
}
.notes .note-list { display: grid; gap: 8px; margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; }
.sources { display: inline-flex; flex-wrap: wrap; gap: 0 10px; margin-left: 6px; font-size: 12px; }
.sources a, .links a { color: var(--accent); text-decoration: none; }
.sources a:hover, .links a:hover { text-decoration: underline; text-underline-offset: 3px; }
.links { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin: 8px 0 0; font-size: 13px; }
.links-label { font-weight: 700; }
</style>
