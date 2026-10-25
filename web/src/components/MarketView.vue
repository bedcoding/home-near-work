<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { MarketLine, MarketStation, MarketTier, MarketView, PeakSeries } from '../../../shared/types';
import { manwon } from '../../../shared/format';
import { changeOf, LINE_COLORS, MARKET_CHECKED, MARKET_LINKS, MARKET_NOTES, pct, STAT_TIPS, TIER_NAMES } from '../market';
import CountTooltip from './CountTooltip.vue';
import TimeChart, { type ChartSeries } from './TimeChart.vue';

// 시세 통계 탭: 지금 서울 아파트가 오르는지 내리는지(KB 주간 지수, 매수우위지수, 실거래 거래량, 서울과 전국 1년 변동),
// KB 월간 매매가격지수 그래프(고른 기간 첫 달을 100으로 맞춤, 전국, 서울, 권역, 구), 매수우위지수 그래프(100 점선),
// 서울 아파트 월별 거래량(구 고르기, 신고 기한 안 달은 흐리게, 12달 평균 선), 구별 급지표(누르면 동별)와 읽는 법,
// 고점 신호(신호등과 가격 국면, 지표마다 그래프), 해마다 오른 비율. 통계 이름에 올리면 뜻을 바로 띄운다(CountTooltip).
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
  [
    props.error,
    props.view?.kb.error && `KB: ${props.view.kb.error}`,
    props.view?.trades.error && `실거래: ${props.view.trades.error}`,
    props.view?.peak.sources.error && `공공 자료: ${props.view.peak.sources.error}`,
    props.view?.regionVolume.error && `지역별 거래량: ${props.view.regionVolume.error}`,
  ].filter((x): x is string => !!x),
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

// ---------- 고점 신호(기간은 따로 고르고 처음은 전체) ----------
const PEAK_RANGES = RANGES.filter((r) => r.id === '10y' || r.id === '20y' || r.id === 'all');
const savedPeakRange = load<string>('hnw-peak-range', 'all');
const peakRange = ref<RangeId>(PEAK_RANGES.some((r) => r.id === savedPeakRange) ? (savedPeakRange as RangeId) : 'all');
watch(peakRange, (r) => save('hnw-peak-range', r));
/** 고점 신호 기간의 첫 자리 */
function peakStart(dates: string[]): number {
  const years = RANGES.find((r) => r.id === peakRange.value)!.years;
  if (!dates.length || years === Infinity) return 0;
  const last = dates[dates.length - 1];
  const cutoff = `${Number(last.slice(0, 4)) - years}${last.slice(4)}`;
  const i = dates.findIndex((d) => d >= cutoff);
  return i < 0 ? 0 : i;
}
const meanOf = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
function lastOf(xs: (number | null)[]): number | null {
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i] != null) return xs[i];
  return null;
}
const pctText = (x: number | null) => (x == null ? '?' : `${x.toFixed(1)}%`);
const shareFormat = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;

/** 분기 끝 달('2026-06') → '2026년 2분기' */
const quarterText = (ym: string) => `${ym.slice(0, 4)}년 ${Math.ceil(Number(ym.slice(5, 7)) / 3)}분기`;

/** KB 시계열 그래프 하나: 고른 기간의 선, 받아 둔 기간 평균(점선), 지금 값, 가장 높았던 때와 낮았던 때 */
function seriesCard(s: PeakSeries | undefined, name: string, color: string) {
  if (!s?.dates.length) return null;
  const from = peakStart(s.dates);
  const avg = meanOf(s.values);
  const values = s.values.slice(from);
  let hi = 0;
  let lo = 0;
  s.values.forEach((v, i) => {
    if (v > s.values[hi]) hi = i;
    if (v < s.values[lo]) lo = i;
  });
  const last = s.values.length - 1;
  return {
    dates: s.dates.slice(from),
    series: [
      { id: 'value', name, color, values },
      { id: 'avg', name: '받아 둔 기간 평균', color: LINE_COLORS.nation, values: values.map(() => avg), dashed: true },
    ] as ChartSeries[],
    now: s.values[last],
    nowDate: s.dates[last],
    yearAgo: last >= 12 && s.dates[last - 12] === `${Number(s.dates[last].slice(0, 4)) - 1}${s.dates[last].slice(4)}` ? s.values[last - 12] : null,
    avg,
    first: s.dates[0],
    max: { value: s.values[hi], date: s.dates[hi] },
    min: { value: s.values[lo], date: s.dates[lo] },
  };
}
const pirCard = computed(() => seriesCard(props.view?.peak.pir, 'PIR', LINE_COLORS.others[0]));
const haiCard = computed(() => seriesCard(props.view?.peak.hai, '주택구매력지수', LINE_COLORS.others[1]));
const rateCard = computed(() => seriesCard(props.view?.peak.rate, '주택담보대출 금리', LINE_COLORS.others[2]));
const jeonseCard = computed(() => seriesCard(props.view?.peak.jeonse, '전세가율', LINE_COLORS.others[3]));
const fixed = (digits: number) => (v: number) => v.toFixed(digits);

/** 청약 경쟁률 대용(subsSeries) 그래프 */
const subsCard = computed(() => seriesCard(subsSeries.value, '신청자 ÷ 당첨자', LINE_COLORS.others[4]));

/** 'YYYY-MM' 다음 달 */
function nextYm(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
/** 금리: 주택담보대출 금리와 기준금리(바뀐 날의 금리를 다음에 바뀔 때까지 달마다)를 같은 달 축에 */
const rateChart = computed(() => {
  const mort = props.view?.peak.rate;
  const base = props.view?.peak.baseRate;
  if (!mort?.dates.length && !base?.dates.length) return null;
  const firsts = [mort?.dates[0], base?.dates[0]?.slice(0, 7)].filter((x): x is string => !!x).sort();
  const lasts = [mort?.dates.at(-1), base?.dates.at(-1)?.slice(0, 7)].filter((x): x is string => !!x).sort();
  const months: string[] = [];
  for (let m = firsts[0]; m <= lasts[lasts.length - 1]; m = nextYm(m)) months.push(m);
  const mortAt = new Map(mort?.dates.map((d, i) => [d, mort.values[i]]) ?? []);
  let k = -1;
  const baseValues = months.map((m) => {
    while (base && k + 1 < base.dates.length && base.dates[k + 1].slice(0, 7) <= m) k++;
    return k >= 0 && base ? base.values[k] : null;
  });
  const from = peakStart(months);
  return {
    dates: months.slice(from),
    series: [
      { id: 'mortgage', name: '주택담보대출 금리', color: LINE_COLORS.others[2], values: months.slice(from).map((m) => mortAt.get(m) ?? null) },
      { id: 'base', name: '기준금리', color: LINE_COLORS.seoul, values: baseValues.slice(from) },
    ] as ChartSeries[],
    baseNow: base?.values.at(-1) ?? null,
    baseDate: base?.dates.at(-1) ?? null,
    baseBefore: base && base.values.length > 1 ? base.values[base.values.length - 2] : null,
  };
});

/** 공급: 해마다 서울 아파트 준공(올해는 지난달까지)과, 마지막 준공 달 뒤의 입주예정을 막대로 */
const supplyChart = computed(() => {
  const s = props.view?.peak.supply;
  if (!s?.done.dates.length) return null;
  const lastDone = s.done.dates[s.done.dates.length - 1];
  const doneBy = new Map<string, number>();
  const monthsBy = new Map<string, number>();
  s.done.dates.forEach((d, i) => {
    doneBy.set(d.slice(0, 4), (doneBy.get(d.slice(0, 4)) ?? 0) + s.done.values[i]);
    monthsBy.set(d.slice(0, 4), (monthsBy.get(d.slice(0, 4)) ?? 0) + 1);
  });
  const planBy = new Map<string, number>();
  const planMonths = new Map<string, string>();
  s.plan.dates.forEach((d, i) => {
    if (d <= lastDone) return;
    planBy.set(d.slice(0, 4), (planBy.get(d.slice(0, 4)) ?? 0) + s.plan.values[i]);
    planMonths.set(d.slice(0, 4), d.slice(5, 7));
  });
  // 열두 달이 다 없는 첫해(받기 시작한 해)는 뺀다
  const years = [...new Set([...doneBy.keys(), ...planBy.keys()])].sort().filter((y) => (monthsBy.get(y) ?? 0) === 12 || y >= lastDone.slice(0, 4));
  const dates = years.map((y) => `${y}-01`);
  const from = peakStart(dates);
  const done = years.map((y) => doneBy.get(y) ?? null);
  const plan = years.map((y) => (planBy.has(y) ? (doneBy.get(y) ?? 0) + planBy.get(y)! : null));
  const full = years.filter((y) => (monthsBy.get(y) ?? 0) === 12);
  const avg = meanOf(full.map((y) => doneBy.get(y)!));
  return {
    dates: dates.slice(from),
    series: [
      { id: 'plan', name: '입주예정 더한 값', color: '#a9c1e2', values: plan.slice(from), bar: true },
      { id: 'done', name: '준공', color: LINE_COLORS.seoul, values: done.slice(from), bar: true },
    ] as ChartSeries[],
    lastFull: full.length ? { year: full[full.length - 1], value: doneBy.get(full[full.length - 1])! } : null,
    thisYear: { year: lastDone.slice(0, 4), months: monthsBy.get(lastDone.slice(0, 4)) ?? 0, value: doneBy.get(lastDone.slice(0, 4)) ?? 0 },
    nextYear: (() => {
      const y = String(Number(lastDone.slice(0, 4)) + 1);
      return planBy.has(y) ? { year: y, value: planBy.get(y)! } : null;
    })(),
    avg: avg == null ? null : Math.round(avg),
    /** 막대에 올렸을 때 날짜 글자: 올해는 준공이 몇 월까지인지, 입주예정이 열두 달이 안 되는 해는 몇 월까지인지 */
    dateText: (d: string) => {
      const y = d.slice(0, 4);
      if (y === lastDone.slice(0, 4)) return `${y}년(준공 ${Number(lastDone.slice(5, 7))}월까지${planBy.has(y) ? ', 그 뒤 입주예정' : ''})`;
      const until = planMonths.get(y);
      return until && until !== '12' ? `${y}년(입주예정 ${Number(until)}월까지)` : `${y}년`;
    },
  };
});

const unsoldCard = computed(() => seriesCard(props.view?.peak.unsold, '미분양', LINE_COLORS.others[5]));

const tradePeak = computed(() => props.view?.peak.trades ?? null);
/** 거래량: 12달 합과 받아 둔 기간 평균(점선) */
const volumePeak = computed(() => {
  const t = tradePeak.value;
  if (!t?.months.length) return null;
  const from = peakStart(t.months);
  const values = t.year.slice(from);
  const avg = meanOf(t.year);
  return {
    dates: t.months.slice(from),
    series: [
      { id: 'year', name: '12달 합', color: LINE_COLORS.seoul, values },
      { id: 'avg', name: '받아 둔 기간 평균', color: LINE_COLORS.nation, values: values.map(() => (avg == null ? null : Math.round(avg))), dashed: true },
    ] as ChartSeries[],
    now: lastOf(t.year),
    avg: avg == null ? null : Math.round(avg),
  };
});
/** 못난이 신고가: 아래 급 단지와 위 급 단지의 3달 신고가 비율 */
const uglyPeak = computed(() => {
  const t = tradePeak.value;
  if (!t?.from) return null;
  const start = Math.max(peakStart(t.months), t.months.indexOf(t.from));
  return {
    dates: t.months.slice(start),
    series: [
      { id: 'low', name: '아래 급 단지', color: LINE_COLORS.others[0], values: t.low.slice(start) },
      { id: 'high', name: '위 급 단지', color: LINE_COLORS.seoul, values: t.high.slice(start) },
    ] as ChartSeries[],
    low: lastOf(t.low),
    high: lastOf(t.high),
    from: t.from,
  };
});

// ---------- 신호등과 가격 국면 ----------
type LightState = 'on' | 'off' | 'na';
interface Light {
  id: string;
  name: string;
  state: LightState;
  /** 올리면 보일 글: 켜졌는지와 지금 값, 그 아래 통계 설명과 켜지는 기준 */
  tip: string;
}
const STATE_TEXT: Record<LightState, string> = { on: '켜짐', off: '꺼짐', na: '자료 부족' };
const light = (id: string, name: string, state: LightState, base: string, detail = ''): Light => ({
  id,
  name,
  state,
  tip: `${STATE_TEXT[state]}${detail ? `: ${detail}` : ''}\n\n${base}`,
});
/** 값들 중 v보다 큰 값의 수 + 1(높은 순서), 작은 값의 수 + 1(낮은 순서) */
const higherOrder = (values: number[], v: number) => values.filter((x) => x > v).length + 1;
const lowerOrder = (values: number[], v: number) => values.filter((x) => x < v).length + 1;
/** 'YYYY-MM…' 날짜에서 months달 앞선 달('YYYY-MM') */
function monthsBefore(date: string, months: number): string {
  const t = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 - months;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
/** 시계열의 마지막 값과, 그보다 months달 앞선 달이나 그 전의 가장 늦은 값 */
function nowAndBefore(s: PeakSeries | undefined, months: number) {
  if (!s?.dates.length) return null;
  const last = s.dates.length - 1;
  const target = monthsBefore(s.dates[last], months);
  let i = last;
  while (i >= 0 && s.dates[i].slice(0, 7) > target) i--;
  return { now: s.values[last], date: s.dates[last], before: i >= 0 ? s.values[i] : null, beforeDate: i >= 0 ? s.dates[i] : null };
}
const round1 = (x: number) => Math.round(x * 10) / 10;
/** 서울 청약 신청자 ÷ 당첨자(그 달까지 3달, 당첨자가 30명 안 되는 달은 뺌), 받아 둔 기간 전체 */
const subsSeries = computed((): PeakSeries => {
  const s = props.view?.peak.subs;
  const dates: string[] = [];
  const values: number[] = [];
  s?.dates.forEach((d, i) => {
    if (i < 2) return;
    const win = s.win.slice(i - 2, i + 1).reduce((a, b) => a + b, 0);
    if (win < 30) return;
    dates.push(d);
    values.push(Math.round((s.apply.slice(i - 2, i + 1).reduce((a, b) => a + b, 0) / win) * 10) / 10);
  });
  return { dates, values };
});

/** 고점 신호 신호등(켜지는 기준은 STAT_TIPS에 적은 것과 같다) */
const lights = computed((): Record<string, Light> => {
  const p = props.view?.peak;
  const out: Record<string, Light> = {};

  const pir = p?.pir;
  const pirX = nowAndBefore(pir, 12);
  if (!pir || !pirX || pir.values.length < 8) out.pir = light('pir', 'PIR', 'na', STAT_TIPS.pir);
  else {
    const order = higherOrder(pir.values, pirX.now);
    const up = pirX.before ? round1((pirX.now / pirX.before - 1) * 100) : null;
    const on = order <= Math.ceil(pir.values.length * 0.2) || (up != null && up >= 10);
    out.pir = light('pir', 'PIR', on ? 'on' : 'off', STAT_TIPS.pir, `${quarterText(pirX.date)} ${pirX.now.toFixed(1)}배, 받아 둔 ${pir.values.length}분기 중 높은 순서 ${order}번째, 1년 전보다 ${pct(up)}`);
  }

  const t = p?.trades;
  let ti = (t?.year.length ?? 0) - 1;
  while (t && ti >= 0 && t.year[ti] == null) ti--;
  const yearNow = t && ti >= 0 ? t.year[ti] : null;
  const yearBefore = t && ti >= 12 ? t.year[ti - 12] : null;
  if (!t || yearNow == null || yearBefore == null) out.trades = light('trades', '거래량', 'na', STAT_TIPS.trades);
  else {
    const change = round1((yearNow / yearBefore - 1) * 100);
    out.trades = light('trades', '거래량', change <= -10 ? 'on' : 'off', STAT_TIPS.trades, `${dot(t.months[ti])}까지 12달 ${count(yearNow)}건, 1년 전 ${count(yearBefore)}건(${pct(change)})`);
  }

  let ui = (t?.low.length ?? 0) - 1;
  while (t && ui >= 0 && (t.low[ui] == null || t.high[ui] == null)) ui--;
  const lowBefore = t && ui >= 6 ? t.low[ui - 6] : null;
  if (!t || ui < 0 || lowBefore == null) out.ugly = light('ugly', '못난이 신고가', 'na', STAT_TIPS.ugly);
  else {
    const low = t.low[ui]!;
    const high = t.high[ui]!;
    const on = low - high >= 5 && low > lowBefore;
    out.ugly = light('ugly', '못난이 신고가', on ? 'on' : 'off', STAT_TIPS.ugly, `${dot(t.months[ui])} 아래 급 ${low.toFixed(1)}%, 위 급 ${high.toFixed(1)}%, 아래 급 6달 전 ${lowBefore.toFixed(1)}%`);
  }

  const subsX = nowAndBefore(subsSeries.value, 12);
  if (!subsX?.before || !subsX.beforeDate) out.subs = light('subs', '청약 경쟁률', 'na', STAT_TIPS.subs);
  else {
    const change = round1((subsX.now / subsX.before - 1) * 100);
    out.subs = light('subs', '청약 경쟁률', change <= -30 ? 'on' : 'off', STAT_TIPS.subs, `${dot(subsX.date)} ${subsX.now.toFixed(0)} 대 1, ${dot(subsX.beforeDate)} ${subsX.before.toFixed(0)} 대 1(${pct(change)})`);
  }

  const base = p?.baseRate;
  const mort = nowAndBefore(p?.rate, 12);
  const today = new Date();
  const yearAgo = `${today.getFullYear() - 1}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let bi = (base?.dates.length ?? 0) - 1;
  while (base && bi >= 0 && base.dates[bi] > yearAgo) bi--;
  const baseNow = base?.values.at(-1) ?? null;
  const baseBefore = base && bi >= 0 ? base.values[bi] : null;
  if (baseNow == null && !mort?.before) out.rate = light('rate', '금리', 'na', STAT_TIPS.rate);
  else {
    const baseUp = baseNow != null && baseBefore != null && baseNow > baseBefore;
    const mortUp = mort?.before != null && mort.now - mort.before >= 0.5;
    const parts = [
      baseNow != null ? `기준금리 ${baseNow.toFixed(2)}%(1년 전 ${baseBefore == null ? '?' : `${baseBefore.toFixed(2)}%`})` : '',
      mort ? `주택담보대출 ${mort.now.toFixed(2)}%(${dot(mort.date)}, 1년 전 ${mort.before == null ? '?' : `${mort.before.toFixed(2)}%`})` : '',
    ].filter(Boolean);
    out.rate = light('rate', '금리', baseUp || mortUp ? 'on' : 'off', STAT_TIPS.rate, parts.join(', '));
  }

  const sc = supplyChart.value;
  if (!sc?.nextYear || !sc.avg) out.supply = light('supply', '공급', 'na', STAT_TIPS.supply);
  else {
    const ratio = sc.nextYear.value / sc.avg;
    out.supply = light('supply', '공급', ratio >= 1.2 ? 'on' : 'off', STAT_TIPS.supply, `${sc.nextYear.year}년 입주예정 ${count(sc.nextYear.value)}세대, 해마다 평균 준공 ${count(sc.avg)}세대의 ${ratio.toFixed(2)}배`);
  }

  const unsoldX = nowAndBefore(p?.unsold, 12);
  if (!unsoldX?.before) out.unsold = light('unsold', '미분양', 'na', STAT_TIPS.unsold);
  else {
    const ratio = unsoldX.now / unsoldX.before;
    out.unsold = light('unsold', '미분양', ratio >= 1.5 ? 'on' : 'off', STAT_TIPS.unsold, `${dot(unsoldX.date)} ${count(unsoldX.now)}호, 1년 전 ${count(unsoldX.before)}호(${ratio.toFixed(2)}배)`);
  }

  for (const [id, name, s, tip, unit] of [
    ['jeonse', '전세가율', p?.jeonse, STAT_TIPS.jeonse, '%'],
    ['hai', '주택구매력지수', p?.hai, STAT_TIPS.hai, ''],
  ] as const) {
    if (!s || s.values.length < 24) {
      out[id] = light(id, name, 'na', tip);
      continue;
    }
    const v = s.values[s.values.length - 1];
    const order = lowerOrder(s.values, v);
    out[id] = light(id, name, order <= Math.ceil(s.values.length * 0.2) ? 'on' : 'off', tip, `${dot(s.dates[s.dates.length - 1])} ${v.toFixed(1)}${unit}, 받아 둔 ${s.values.length}달 중 낮은 순서 ${order}번째`);
  }
  return out;
});
const MAIN_LIGHTS = ['pir', 'trades', 'ugly', 'subs', 'rate', 'supply'];
const EXTRA_LIGHTS = ['unsold', 'jeonse', 'hai'];
const mainLights = computed(() => MAIN_LIGHTS.map((id) => lights.value[id]));
const extraLights = computed(() => EXTRA_LIGHTS.map((id) => lights.value[id]));
const lightsOn = computed(() => mainLights.value.filter((l) => l.state === 'on').length);
const lightsTip = computed(() => {
  const na = mainLights.value.filter((l) => l.state === 'na');
  return [
    `주요 6개(${MAIN_LIGHTS.map((id) => lights.value[id].name).join(', ')}) 중 켜진 수입니다.`,
    '많이 켜질수록 꼭대기 때 모습이 많다는 뜻이지만, 몇 개가 켜지면 꼭대기라는 기준은 없습니다.',
    `켜진 것: ${mainLights.value.filter((l) => l.state === 'on').map((l) => l.name).join(', ') || '없음'}`,
    na.length ? `자료 부족: ${na.map((l) => l.name).join(', ')}` : '',
  ].filter(Boolean).join('\n');
});

/** 가격 국면: KB 주간 서울 아파트 13주와 1년 변동이 둘 다 플러스면 상승기, 둘 다 마이너스면 하락기, 엇갈리면 전환 중 */
const phase = computed(() => {
  const n = now.value;
  const head = 'KB 주간 서울 아파트 지수의 13주(석 달) 변동과 1년 변동이 둘 다 플러스면 상승기, 둘 다 마이너스면 하락기, 엇갈리면 전환 중으로 봅니다.';
  const tail = '바닥과 꼭대기는 지나고 나서야 알 수 있어서, 이 표시는 지금 방향만 알려 줍니다.';
  if (!n || n.w13 == null || n.w52 == null) return { id: 'na', label: '자료 없음', tip: `${head}\n${tail}` };
  const id = n.w13 > 0 && n.w52 > 0 ? 'up' : n.w13 < 0 && n.w52 < 0 ? 'down' : 'turn';
  return {
    id,
    label: id === 'up' ? '상승기' : id === 'down' ? '하락기' : '전환 중',
    tip: `${head}\n지금: 13주 ${pct(n.w13)}, 1년 ${pct(n.w52)}${n.week ? `(${dot(n.week)} 기준)` : ''}\n${tail}`,
  };
});

// ---------- 해마다 오른 비율 ----------
const yearlyKind = ref<'apt' | 'all'>(load<string>('hnw-yearly-kind', 'apt') === 'all' ? 'all' : 'apt');
watch(yearlyKind, (k) => save('hnw-yearly-kind', k));
const savedYearlyRange = load<string>('hnw-yearly-range', 'all');
const yearlyRange = ref<RangeId>(PEAK_RANGES.some((r) => r.id === savedYearlyRange) ? (savedYearlyRange as RangeId) : 'all');
watch(yearlyRange, (r) => save('hnw-yearly-range', r));
const signedPct = (v: number) => (v === 0 ? '0%' : `${v > 0 ? '+' : ''}${Math.abs(v) < 10 ? v.toFixed(1) : v.toFixed(0)}%`);
const yearlyChart = computed(() => {
  const y = props.view?.yearly;
  if (!y?.years.length) return null;
  const seoul = yearlyKind.value === 'apt' ? y.seoulApt : y.seoulAll;
  const nation = yearlyKind.value === 'apt' ? y.nationApt : y.nationAll;
  if (!seoul.some((v) => v != null) && !nation.some((v) => v != null)) return null;
  const lastYear = y.years[y.years.length - 1];
  const partial = y.lastMonth && y.lastMonth.startsWith(lastYear) && !y.lastMonth.endsWith('-12') ? Number(y.lastMonth.slice(5, 7)) : null;
  const span = RANGES.find((r) => r.id === yearlyRange.value)!.years;
  const from = span === Infinity ? 0 : Math.max(0, y.years.length - span);
  const done = y.years.map((yy, i) => ({ yy, s: seoul[i], n: nation[i] })).filter((r) => r.yy !== lastYear || !partial);
  const sv = done.map((r) => r.s).filter((v): v is number => v != null);
  const nv = done.map((r) => r.n).filter((v): v is number => v != null);
  return {
    dates: y.years.slice(from).map((yy) => `${yy}-01`),
    series: [
      { id: 'seoul', name: '서울', color: LINE_COLORS.seoul, values: seoul.slice(from), bar: true },
      { id: 'nation', name: '전국', color: '#5a6472', values: nation.slice(from) },
    ] as ChartSeries[],
    dateText: (d: string) => (partial && d.startsWith(lastYear) ? `${lastYear}년(${partial}월까지)` : `${d.slice(0, 4)}년`),
    last: { year: lastYear, partial, seoul: seoul[seoul.length - 1], nation: nation[nation.length - 1] },
    span: done.length ? `${done[0].yy} ~ ${done[done.length - 1].yy}년` : '',
    avg: { seoul: meanOf(sv), nation: meanOf(nv) },
    down: { seoul: sv.filter((v) => v < 0).length, nation: nv.filter((v) => v < 0).length },
  };
});
const avgText = (x: number | null) => pct(x == null ? null : round1(x));

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
// 고른 곳: '서울', 구 이름, 또는 지역별 건수의 'r:nation'처럼 'r:' + 지역 id
const volumeGu = ref<string>(load<string>('hnw-market-volume-gu', '서울'));
watch(volumeGu, (g) => save('hnw-market-volume-gu', g));
const volumeGuChoices = computed(() => {
  const gus = props.view?.volume.gus ?? [];
  return [...gus.filter((g) => g.near), ...gus.filter((g) => !g.near)];
});
const volumeRegions = computed(() => props.view?.regionVolume.regions ?? []);
const volumeRegion = computed(() => (volumeGu.value.startsWith('r:') ? (volumeRegions.value.find((r) => `r:${r.id}` === volumeGu.value) ?? null) : null));
const volumeLabel = computed(() => volumeRegion.value?.name ?? (volumeGuChoices.value.some((g) => g.gu === volumeGu.value) ? volumeGu.value : '서울'));
const volumeChart = computed(() => {
  const v = props.view;
  const region = volumeRegion.value;
  const months = region ? v!.regionVolume.months : (v?.volume.months ?? []);
  if (!v || !months.length) return { dates: [] as string[], series: [] as ChartSeries[], faded: 0 };
  const incomplete = region ? v.regionVolume.incomplete : v.volume.incomplete;
  const counts: (number | null)[] = region ? region.counts : volumeLabel.value === '서울' ? v.volume.seoul : v.volume.gus.find((g) => g.gu === volumeLabel.value)!.counts;
  const complete = counts.length - incomplete;
  const avg = counts.map((_, i) => {
    const last12 = counts.slice(i - 11, i + 1);
    return i >= 11 && i < complete && last12.every((x) => x != null) ? Math.round(last12.reduce((a: number, b) => a + b!, 0) / 12) : null;
  });
  const from = rangeStart(months);
  return {
    dates: months.slice(from),
    series: [
      { id: 'count', name: '거래', color: LINE_COLORS.seoul, values: counts.slice(from), bar: true },
      { id: 'avg', name: '12달 평균', color: '#b74757', values: avg.slice(from) },
    ],
    faded: incomplete,
  };
});

/** 거래량 제목에 올리면 보이는 글: 흐리게 그린 달, 받아 둔 첫날, 아직 안 받은 해나 달 */
const volumeTitle = computed(() => {
  const v = props.view;
  if (!v) return '';
  if (volumeRegion.value) {
    const r = v.regionVolume;
    return [
      `끝의 ${r.incomplete}달은 신고 기한(계약 뒤 30일)이 지나기 전에 받았거나 아직 안 받아 흐리게 그림`,
      r.months.length ? `${r.months[0].slice(0, 4)}년 ${monthText(r.months[0])}부터, ${fetchedText(r.fetchedAt)}` : '',
      r.missing ? `아직 안 받은 달 ${r.missing}개(조회할 때 36달씩 받음)` : '',
      r.error ? `받기 오류: ${r.error}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `끝의 ${v.volume.incomplete}달은 신고 기한(계약 뒤 30일) 안이라 덜 들어와 흐리게 그림`,
    v.trades.coverageFrom ? `${dot(v.trades.coverageFrom)}부터 받아 둠` : '',
    v.trades.missingYears.length ? `아직 안 받은 해: ${v.trades.missingYears.join(', ')}년(조회할 때 두 해씩 받음)` : '',
  ]
    .filter(Boolean)
    .join('\n');
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
/** 그 동에 붙인 역 */
const stationsIn = (t: MarketTier, dong: string) => t.stations.filter((s) => s.dongs.includes(dong));
/** 동 줄에 붙지 않은 역(동을 못 맞췄거나 맞춘 동에 최근 1년 아파트 거래가 없음) */
const otherStations = (t: MarketTier) => t.stations.filter((s) => !s.dongs.some((d) => t.dongs.some((x) => x.dong === d)));
const stationTitle = (s: MarketStation) =>
  `${s.lines.join(', ')}. ${s.how === 'listings' ? '역 300m 안 모은 매물이 가장 많이 있는 동' : s.how === 'name' ? '역 이름이 붙은 동' : '어느 동인지 못 맞춤'}${s.dongs.length ? `: ${s.dongs.join(', ')}` : ''}`;
const stationsTip = (t: MarketTier) => `${t.gu} 역 ${t.stations.length}곳: ${t.stations.map((s) => s.name).join(', ')}\n구를 누르면 동별 줄에 역이 붙습니다.`;
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
      <span class="muted when" title="KB 통계는 3일, 실거래 최근 1년과 공공 자료(기준금리, 청약, 입주예정, 준공, 미분양)는 7일에 한 번 조회할 때 새로 받습니다">
        KB {{ fetchedText(view?.kb.fetchedAt ?? null) }}, 실거래 {{ fetchedText(view?.trades.fetchedAt ?? null) }}, 공공 자료 {{ fetchedText(view?.peak.sources.fetchedAt ?? null) }}
      </span>
      <button
        class="btn run" :disabled="fetching || running"
        title="KB 통계, 공공 자료(기준금리, 청약, 입주예정, 준공, 미분양), 국토부 실거래(서울 아파트 최근 1년, 아직 안 받은 지난 해)를 지금 받습니다. 처음에는 해마다 받아 몇 분 걸릴 수 있습니다."
        @click="emit('fetch')"
      >{{ fetching ? '받는 중…' : '지금 받기' }}</button>
    </div>
    <p v-for="e in errors" :key="e" class="err" role="alert">{{ e }}</p>

    <p v-if="!view" class="muted">불러오는 중…</p>
    <p v-else-if="empty" class="muted">아직 받은 자료가 없습니다</p>

    <template v-if="view && !empty">
      <section class="now" aria-label="지금 서울 아파트">
        <div class="now-card">
          <span class="now-name"><CountTooltip :text="STAT_TIPS.price" :max-width="440">가격</CountTooltip> <span class="muted">KB 주간, 서울</span></span>
          <b class="now-big" :class="now?.trend">{{ now?.trend ? TREND[now.trend] : '자료 없음' }}</b>
          <span class="num">4주 {{ pct(now?.w4 ?? null) }}, 13주 {{ pct(now?.w13 ?? null) }}, 1년 {{ pct(now?.w52 ?? null) }}</span>
          <span class="muted now-foot">{{ now?.week ? `${dot(now.week)} 기준` : '' }}</span>
        </div>
        <div class="now-card">
          <span class="now-name"><CountTooltip :text="STAT_TIPS.buyer" :max-width="440">매수우위지수</CountTooltip> <span class="muted">KB 주간, 서울</span></span>
          <b class="now-big num">{{ now?.buyerSeoul != null ? indexFormat(now.buyerSeoul) : '자료 없음' }}</b>
          <span>{{ buyerMeaning(now?.buyerSeoul ?? null) }}</span>
          <span class="muted now-foot num">최근 4주 평균 {{ now?.buyerSeoul4 != null ? indexFormat(now.buyerSeoul4) : '?' }}, 전국 {{ now?.buyerNation != null ? indexFormat(now.buyerNation) : '?' }}</span>
        </div>
        <div class="now-card">
          <span class="now-name"><CountTooltip :text="STAT_TIPS.volume" :max-width="440">거래량</CountTooltip> <span class="muted">실거래, 서울 아파트</span></span>
          <b class="now-big num" title="신고 기한(계약 뒤 30일)이 지난 마지막 달 기준">{{ now?.volumeMonth ? `${monthText(now.volumeMonth)} ${count(now.volume)}건` : '자료 없음' }}</b>
          <span class="num">1년 전 같은 달 {{ count(now?.volumeLastYear ?? null) }}건({{ pct(changeOf(now?.volume ?? null, now?.volumeLastYear ?? null)) }})</span>
          <span class="num">3개월 {{ count(now?.volume3 ?? null) }}건, 1년 전 {{ count(now?.volume3LastYear ?? null) }}건({{ pct(changeOf(now?.volume3 ?? null, now?.volume3LastYear ?? null)) }})</span>
        </div>
        <div class="now-card now-long">
          <span class="now-name"><CountTooltip :text="STAT_TIPS.long" :max-width="440">서울과 전국</CountTooltip> <span class="muted">KB 월간, 길게 본 변동</span></span>
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
        <CountTooltip :text="STAT_TIPS.signals" :max-width="360"><span class="signals-label">지금 가리키는 쪽</span></CountTooltip>
        <span v-for="s in signals" :key="s.name" class="signal" :class="{ up: s.up, down: s.down }">{{ s.name }} {{ s.up ? '↑' : s.down ? '↓' : '→' }} {{ s.text }}</span>
      </p>

      <section class="block" aria-labelledby="market-peak">
        <div class="block-head">
          <h3 id="market-peak" class="block-title"><CountTooltip :text="STAT_TIPS.peak" :max-width="440">고점 신호</CountTooltip> <span class="muted">서울 아파트</span></h3>
          <div class="seg" role="group" aria-label="고점 신호 기간">
            <button v-for="r in PEAK_RANGES" :key="r.id" type="button" :class="{ on: peakRange === r.id }" :aria-pressed="peakRange === r.id" @click="peakRange = r.id">{{ r.label }}</button>
          </div>
        </div>
        <div class="lights" aria-label="고점 신호 신호등">
          <CountTooltip :text="phase.tip" :max-width="420"><span class="phase" :class="phase.id">가격 국면 <b>{{ phase.label }}</b></span></CountTooltip>
          <CountTooltip :text="lightsTip" :max-width="420"><span class="light-count">고점 신호 6개 중 <b class="num">{{ lightsOn }}</b>개 켜짐</span></CountTooltip>
          <CountTooltip v-for="l in mainLights" :key="l.id" :text="l.tip" :max-width="440"><span class="light" :class="l.state"><i class="dot" />{{ l.name }}</span></CountTooltip>
          <span class="lights-sep">참고</span>
          <CountTooltip v-for="l in extraLights" :key="l.id" :text="l.tip" :max-width="440"><span class="light" :class="l.state"><i class="dot" />{{ l.name }}</span></CountTooltip>
        </div>
        <div class="peak-grid">
          <article class="peak-card">
            <h4 class="peak-name"><i class="dot" :class="lights.pir.state" /><CountTooltip :text="lights.pir.tip" :max-width="440">PIR</CountTooltip> <span class="muted">KB아파트담보대출, 서울, 분기</span>
            </h4>
            <p class="peak-now num">
              <b>{{ pirCard ? `${pirCard.now.toFixed(1)}배` : '자료 없음' }}</b>
              <span v-if="pirCard" class="muted">{{ quarterText(pirCard.nowDate) }}, 평균 {{ pirCard.avg?.toFixed(1) }}배, 가장 높을 때 {{ pirCard.max.value.toFixed(1) }}배({{ quarterText(pirCard.max.date) }})</span>
            </p>
            <TimeChart v-if="pirCard" :dates="pirCard.dates" :series="pirCard.series" label="KB아파트담보대출 PIR, 서울" :format="fixed(1)" :height="170" :date-text="quarterText" />
          </article>
          <article class="peak-card">
            <h4 class="peak-name"><i class="dot" :class="lights.trades.state" /><CountTooltip :text="lights.trades.tip" :max-width="440">거래량</CountTooltip> <span class="muted">12달 합</span>
            </h4>
            <p class="peak-now num">
              <b>{{ volumePeak?.now != null ? `${count(volumePeak.now)}건` : '자료 없음' }}</b>
              <span v-if="volumePeak?.avg != null" class="muted">평균 {{ count(volumePeak.avg) }}건</span>
            </p>
            <TimeChart v-if="volumePeak" :dates="volumePeak.dates" :series="volumePeak.series" label="서울 아파트 거래량 12달 합" :format="countFormat" :height="170" />
          </article>
          <article class="peak-card">
            <h4 class="peak-name"><i class="dot" :class="lights.ugly.state" /><CountTooltip :text="lights.ugly.tip" :max-width="440">못난이 신고가</CountTooltip> <span class="muted">3달 신고가 비율</span>
            </h4>
            <p class="peak-now num">
              <b>아래 급 {{ pctText(uglyPeak?.low ?? null) }}</b>
              <span class="muted">위 급 {{ pctText(uglyPeak?.high ?? null) }}</span>
            </p>
            <TimeChart v-if="uglyPeak" :dates="uglyPeak.dates" :series="uglyPeak.series" label="서울 아파트 단지 급별 신고가 비율" :format="shareFormat" :height="170" />
            <p v-if="uglyPeak" class="peak-legend"><span v-for="x in uglyPeak.series" :key="x.id"><i :style="{ background: x.color }" />{{ x.name }}</span></p>
            <p v-else class="muted note">실거래가 2년 넘게 쌓이면 그립니다</p>
          </article>
          <article class="peak-card">
            <h4 class="peak-name"><i class="dot" :class="lights.subs.state" /><CountTooltip :text="lights.subs.tip" :max-width="440">청약 경쟁률</CountTooltip> <span class="muted">신청자 ÷ 당첨자, 서울, 3달</span>
            </h4>
            <p class="peak-now num">
              <b>{{ subsCard ? `${subsCard.now.toFixed(0)} 대 1` : '자료 없음' }}</b>
              <span v-if="subsCard" class="muted">{{ dot(subsCard.nowDate) }}, 평균 {{ subsCard.avg?.toFixed(0) }} 대 1, 가장 높을 때 {{ subsCard.max.value.toFixed(0) }} 대 1({{ dot(subsCard.max.date) }})</span>
            </p>
            <TimeChart v-if="subsCard" :dates="subsCard.dates" :series="subsCard.series" label="서울 청약 신청자 대 당첨자" :format="fixed(0)" :height="170" />
          </article>
          <article class="peak-card">
            <h4 class="peak-name"><i class="dot" :class="lights.rate.state" /><CountTooltip :text="lights.rate.tip" :max-width="440">금리</CountTooltip> <span class="muted">주택담보대출과 기준금리</span>
            </h4>
            <p class="peak-now num">
              <b>{{ rateCard ? `${rateCard.now.toFixed(2)}%` : '자료 없음' }}</b>
              <span v-if="rateCard" class="muted">
                {{ dot(rateCard.nowDate) }}<template v-if="rateCard.yearAgo != null">, 1년 전보다 {{ rateCard.now - rateCard.yearAgo >= 0 ? '+' : '' }}{{ (rateCard.now - rateCard.yearAgo).toFixed(2) }}%p</template>
              </span>
              <span v-if="rateChart?.baseNow != null" class="muted">
                기준금리 {{ rateChart.baseNow.toFixed(2) }}%<template v-if="rateChart.baseDate">({{ dot(rateChart.baseDate) }}<template v-if="rateChart.baseBefore != null">{{ rateChart.baseNow > rateChart.baseBefore ? ' 올림' : rateChart.baseNow < rateChart.baseBefore ? ' 내림' : '' }}</template>)</template>
              </span>
            </p>
            <TimeChart v-if="rateChart" :dates="rateChart.dates" :series="rateChart.series" label="주택담보대출 금리와 기준금리" :format="fixed(1)" :height="170" />
            <p v-if="rateChart" class="peak-legend"><span v-for="x in rateChart.series" :key="x.id"><i :style="{ background: x.color }" />{{ x.name }}</span></p>
          </article>
          <article class="peak-card">
            <h4 class="peak-name"><i class="dot" :class="lights.supply.state" /><CountTooltip :text="lights.supply.tip" :max-width="440">공급</CountTooltip> <span class="muted">서울 아파트 준공과 입주예정, 해마다</span>
            </h4>
            <p class="peak-now num">
              <b>{{ supplyChart?.lastFull ? `${supplyChart.lastFull.year}년 ${count(supplyChart.lastFull.value)}세대` : '자료 없음' }}</b>
              <span v-if="supplyChart" class="muted">
                올해 {{ supplyChart.thisYear.months }}달 {{ count(supplyChart.thisYear.value) }}세대<template v-if="supplyChart.nextYear">, {{ supplyChart.nextYear.year }}년 입주예정 {{ count(supplyChart.nextYear.value) }}세대</template><template v-if="supplyChart.avg != null">, 해마다 평균 {{ count(supplyChart.avg) }}세대</template>
              </span>
            </p>
            <TimeChart v-if="supplyChart" :dates="supplyChart.dates" :series="supplyChart.series" label="서울 아파트 준공과 입주예정" :format="countFormat" :height="170" :date-text="supplyChart.dateText" zero />
            <p v-if="supplyChart" class="peak-legend"><span v-for="x in supplyChart.series" :key="x.id"><i :style="{ background: x.color }" />{{ x.id === 'plan' ? '입주예정' : '준공' }}</span></p>
          </article>
          <article class="peak-card">
            <h4 class="peak-name"><i class="dot" :class="lights.unsold.state" /><CountTooltip :text="lights.unsold.tip" :max-width="440">미분양</CountTooltip> <span class="muted">서울, 매달</span>
            </h4>
            <p class="peak-now num">
              <b>{{ unsoldCard ? `${count(unsoldCard.now)}호` : '자료 없음' }}</b>
              <span v-if="unsoldCard" class="muted">{{ dot(unsoldCard.nowDate) }}, 평균 {{ count(unsoldCard.avg == null ? null : Math.round(unsoldCard.avg)) }}호, 가장 많을 때 {{ count(unsoldCard.max.value) }}호({{ dot(unsoldCard.max.date) }})</span>
            </p>
            <TimeChart v-if="unsoldCard" :dates="unsoldCard.dates" :series="unsoldCard.series" label="서울 미분양" :format="countFormat" :height="170" zero />
          </article>
          <article class="peak-card">
            <h4 class="peak-name"><i class="dot" :class="lights.jeonse.state" /><CountTooltip :text="lights.jeonse.tip" :max-width="440">전세가율</CountTooltip> <span class="muted">KB, 서울 아파트, 매달</span>
            </h4>
            <p class="peak-now num">
              <b>{{ jeonseCard ? `${jeonseCard.now.toFixed(1)}%` : '자료 없음' }}</b>
              <span v-if="jeonseCard" class="muted">{{ dot(jeonseCard.nowDate) }}, 평균 {{ jeonseCard.avg?.toFixed(1) }}%, 가장 낮을 때 {{ jeonseCard.min.value.toFixed(1) }}%({{ dot(jeonseCard.min.date) }})</span>
            </p>
            <TimeChart v-if="jeonseCard" :dates="jeonseCard.dates" :series="jeonseCard.series" label="서울 아파트 전세가율" :format="fixed(0)" :height="170" />
          </article>
          <article class="peak-card">
            <h4 class="peak-name"><i class="dot" :class="lights.hai.state" /><CountTooltip :text="lights.hai.tip" :max-width="440">주택구매력지수</CountTooltip> <span class="muted">KB, 서울 아파트, 매달</span>
            </h4>
            <p class="peak-now num">
              <b>{{ haiCard ? haiCard.now.toFixed(1) : '자료 없음' }}</b>
              <span v-if="haiCard" class="muted">{{ dot(haiCard.nowDate) }}, 평균 {{ haiCard.avg?.toFixed(1) }}, 가장 낮을 때 {{ haiCard.min.value.toFixed(1) }}({{ dot(haiCard.min.date) }})</span>
            </p>
            <TimeChart v-if="haiCard" :dates="haiCard.dates" :series="haiCard.series" label="서울 아파트 주택구매력지수" :format="fixed(0)" :height="170" />
          </article>
        </div>
      </section>

      <section class="block" aria-labelledby="market-yearly">
        <div class="block-head">
          <h3 id="market-yearly" class="block-title"><CountTooltip :text="STAT_TIPS.yearly" :max-width="420">해마다 오른 비율</CountTooltip> <span class="muted">KB 월간, 지난해 12월 대비</span></h3>
          <div class="head-tools">
            <div class="seg" role="group" aria-label="집 종류">
              <button type="button" :class="{ on: yearlyKind === 'apt' }" :aria-pressed="yearlyKind === 'apt'" @click="yearlyKind = 'apt'">아파트</button>
              <button type="button" :class="{ on: yearlyKind === 'all' }" :aria-pressed="yearlyKind === 'all'" @click="yearlyKind = 'all'">주택종합</button>
            </div>
            <div class="seg" role="group" aria-label="해마다 오른 비율 기간">
              <button v-for="r in PEAK_RANGES" :key="r.id" type="button" :class="{ on: yearlyRange === r.id }" :aria-pressed="yearlyRange === r.id" @click="yearlyRange = r.id">{{ r.label }}</button>
            </div>
          </div>
        </div>
        <template v-if="yearlyChart">
          <p class="peak-now num">
            <b>{{ yearlyChart.last.year }}년<template v-if="yearlyChart.last.partial">({{ yearlyChart.last.partial }}월까지)</template> 서울 {{ pct(yearlyChart.last.seoul) }}</b>
            <span class="muted">전국 {{ pct(yearlyChart.last.nation) }}, {{ yearlyChart.span }} 평균 서울 {{ avgText(yearlyChart.avg.seoul) }}, 전국 {{ avgText(yearlyChart.avg.nation) }}, 내린 해 서울 {{ yearlyChart.down.seoul }}번, 전국 {{ yearlyChart.down.nation }}번</span>
          </p>
          <TimeChart :dates="yearlyChart.dates" :series="yearlyChart.series" label="해마다 오른 비율, 서울과 전국" :format="signedPct" :baseline="0" zero :height="200" :date-text="yearlyChart.dateText" />
          <p class="peak-legend"><span v-for="x in yearlyChart.series" :key="x.id"><i :style="{ background: x.color }" />{{ x.name }}{{ x.bar ? ' 막대' : ' 선' }}</span></p>
        </template>
        <p v-else class="muted note">KB 통계를 받으면 그립니다</p>
      </section>

      <section class="block" aria-labelledby="market-price">
        <div class="block-head">
          <h3 id="market-price" class="block-title"><CountTooltip :text="STAT_TIPS.priceIndex" :max-width="420">아파트 매매가격지수</CountTooltip> <span class="muted">KB 월간, 고른 기간 첫 달 = 100</span></h3>
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
          <h3 id="market-buyer" class="block-title"><CountTooltip :text="STAT_TIPS.buyer" :max-width="420">매수우위지수</CountTooltip> <span class="muted">KB 주간</span></h3>
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
          <h3 id="market-volume" class="block-title"><CountTooltip :text="`${STAT_TIPS.volumeChart}\n${volumeTitle}`" :max-width="420">{{ volumeLabel }} 아파트 거래량</CountTooltip> <span class="muted">국토부 실거래, 계약한 달 기준</span></h3>
          <div class="head-tools">
            <label class="pick">
              <span class="sr-only">지역</span>
              <select v-model="volumeGu">
                <option v-for="r in volumeRegions" :key="r.id" :value="`r:${r.id}`">{{ r.name }}</option>
                <option value="서울">서울 전체</option>
                <option v-for="g in volumeGuChoices" :key="g.gu" :value="g.gu">{{ g.gu }}{{ g.near ? ' (근처)' : '' }}</option>
              </select>
            </label>
            <div class="seg" role="group" aria-label="그래프 기간(세 그래프 같이)">
              <button v-for="r in RANGES" :key="r.id" type="button" :class="{ on: range === r.id }" :aria-pressed="range === r.id" @click="range = r.id">{{ r.label }}</button>
            </div>
          </div>
        </div>
        <TimeChart :dates="volumeChart.dates" :series="volumeChart.series" :label="`${volumeLabel} 아파트 월별 거래량`" :format="countFormat" :faded="volumeChart.faded" zero />
      </section>

      <section class="block" aria-labelledby="market-tiers">
        <div class="block-head">
          <h3 id="market-tiers" class="block-title"><CountTooltip :text="STAT_TIPS.tiers" :max-width="420">구별 급지와 평당가</CountTooltip> <span class="muted">아파트 실거래, 공식 분류 아님</span></h3>
          <div class="seg" role="group" aria-label="변동 기간">
            <button v-for="c in CHANGE_SPANS" :key="c.id" type="button" :class="{ on: changeSpan === c.id }" :aria-pressed="changeSpan === c.id" @click="changeSpan = c.id">{{ c.label }} 변동</button>
          </div>
        </div>
        <p v-if="view.tiers" class="muted note" :title="`해제된 거래 뺌. 전용면적 평당 중간값 순위로 ${view.tiers.gus.length}개 구를 다섯 묶음으로 고르게 나눔. 구를 누르면 동별`">
          계약일 {{ dot(view.tiers.from) }} ~ {{ dot(view.tiers.to) }}
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
                  <th scope="row">
                    <span class="mark">{{ openGu === t.gu ? '▾' : '▸' }}</span>{{ t.gu }}<span v-if="t.near" class="chip chip-near near-chip">근처</span>
                    <CountTooltip v-if="t.stations.length" :text="stationsTip(t)" :max-width="420"><span class="stn-count">역 {{ t.stations.length }}</span></CountTooltip>
                  </th>
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
                    <th scope="row">
                      {{ d.dong }} <span class="muted dong-count num">{{ count(d.count) }}건</span>
                      <span v-for="s in stationsIn(t, d.dong)" :key="s.name" class="stn" :title="stationTitle(s)">{{ s.name }}</span>
                    </th>
                    <td class="num r">{{ manwon(d.pyeong) }}</td>
                    <td />
                    <td class="wide" />
                    <td />
                    <td class="wide" />
                  </tr>
                  <tr v-if="otherStations(t).length" class="dong">
                    <td class="wide" />
                    <th scope="row" colspan="6" class="other-stn">
                      <span class="muted" title="어느 동인지 못 맞췄거나, 맞춘 동에 최근 1년 아파트 거래가 없는 역">그 밖의 역</span>
                      <span v-for="s in otherStations(t)" :key="s.name" class="stn" :title="stationTitle(s)">{{ s.name }}</span>
                    </th>
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

.now { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.now-card { display: grid; align-content: start; gap: 3px; min-width: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); font-size: 13px; }
.now-name { font-size: 13px; font-weight: 700; color: var(--ink-2); }
/* 지표 이름 아래 줄에 출처(좁은 카드에서 이름 가운데가 끊기지 않게) */
.now-name .muted { display: block; font-size: 12px; font-weight: 500; }
.now-big { font-size: 20px; font-weight: 800; color: var(--ink); }
.now-big.up { color: var(--up); }
.now-big.down { color: var(--down); }
.now-foot { font-size: 12px; }
/* 카드 네 장이 한 줄에 다 안 들어가는 너비에서는 길게 본 변동 표가 한 줄을 다 쓴다 */
@media (max-width: 960px) {
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
.peak-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 10px; }
.peak-card { display: grid; align-content: start; gap: 4px; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius); }
.peak-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; margin: 0; font-size: 14px; }
.peak-name > .dot { align-self: center; }
/* 신호등: 켜짐(꼭대기 쪽 모습) 빨강, 꺼짐 초록, 자료 부족 회색 */
.dot { display: inline-block; flex: none; width: 9px; height: 9px; border-radius: 50%; background: #adb5bd; }
.dot.on, .light.on .dot { background: #e03131; }
.dot.off, .light.off .dot { background: #2f9e44; }
.lights { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 13px; }
.phase { padding: 2px 10px; border-radius: 999px; background: var(--surface-2); font-weight: 600; color: var(--ink-2); }
.phase b { font-weight: 800; }
.phase.up { background: var(--up-soft); color: var(--up); }
.phase.down { background: var(--down-soft); color: var(--down); }
.light-count { margin-right: 4px; font-weight: 600; color: var(--ink-2); }
.light-count b { font-size: 15px; font-weight: 800; color: var(--ink); }
.light { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border: 1px solid var(--line); border-radius: 999px; font-weight: 700; color: var(--ink-2); }
.light.on { border-color: #f2b8ba; background: #fff1f1; color: #b02525; }
.lights-sep { margin-left: 6px; font-size: 12px; color: var(--muted); }
.peak-name .muted { font-size: 12px; font-weight: 500; }
.peak-now { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; margin: 0; font-size: 13px; }
.peak-now b { font-size: 17px; font-weight: 800; }
.peak-legend { display: flex; flex-wrap: wrap; gap: 2px 12px; margin: 0; font-size: 12px; color: var(--ink-2); }
.peak-legend span { display: inline-flex; align-items: center; gap: 5px; }
.peak-legend i { width: 12px; height: 4px; border-radius: 2px; }

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
.stn-count { margin-left: 6px; font-size: 11px; font-weight: 500; color: var(--muted); }
.stn {
  display: inline-block; margin-left: 6px; padding: 0 6px; border: 1px solid var(--line-strong); border-radius: 999px;
  background: var(--surface); font-size: 11px; font-weight: 600; color: var(--ink-2);
}
.tiers th.other-stn { white-space: normal; font-weight: 500; }
.other-stn .stn { margin-top: 2px; margin-bottom: 2px; }
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
