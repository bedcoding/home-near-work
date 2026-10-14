<script setup lang="ts">
import { computed, ref } from 'vue';
import { isDetachedHouseType, SEOUL, type AuctionResultSummary, type AuctionResultView, type CourtRegionStat, type RatioStats } from '../../../shared/types';
import { manwon } from '../../../shared/format';
import { madangUrl, saleDay, type AuctionKind } from '../auction';

// 경매 탭 맨 위 '매각 결과' 칸: 켜 둔 지역 근처 구의 지난 매각기일 결과(낙찰가와 감정가 대비, 유찰)와 법원 지역별 매각통계(구별 매각가율).
// 결과와 통계는 지금 켜 둔 지역 근처 구의 것만, 결과는 고른 종류(주거, 단독, 상가, 토지)만 보인다. 통계는 구마다 가장 최근에 읽은 것, title에 지난 기간.
// 제목 줄에 최근 1년 낙찰 건수, 펼치면 낙찰가율과 법원 통계, 근처 구와 서울 전체 비교 표, 매각기일별 목록(최근 기일 SHOWN_DAYS개, 나머지는 '이전 기일 더 보기').
// 펼침은 기억한다.

const props = defineProps<{
  /** 매각 결과(매각기일 최근 순, 모든 종류) */
  results: AuctionResultView[];
  /** 근처 구와 서울 전체의 지역별 매각통계(지역마다 읽은 시각 최근 순, 기간마다 하나) */
  stats: CourtRegionStat[];
  /** 근처 구와 서울 전체의 최근 1년 매각 결과 요약(종류별) */
  compare: AuctionResultSummary[];
  kind: AuctionKind;
  /** 켜 둔 지역 근처 구(비었으면 거르지 않음) */
  gus: string[];
}>();

/** 펼쳤을 때 처음 보이는 매각기일 수 */
const SHOWN_DAYS = 6;
const showAll = ref(false);
/** 이 컴퓨터 날짜로 1년 전, YYYY-MM-DD */
function yearAgo(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const OPEN_KEY = 'hnw-auction-results-open';
const open = ref(localStorage.getItem(OPEN_KEY) === 'true');
function onToggle(e: Event) {
  open.value = (e.target as HTMLDetailsElement).open;
  localStorage.setItem(OPEN_KEY, String(open.value));
}

const inGus = (gu: string | null) => !props.gus.length || (gu != null && props.gus.includes(gu));
/** 고른 칸의 결과인지: 단독 칸은 주거 중 용도가 단독주택 갈래인 것 */
const inKind = (r: AuctionResultView) => (props.kind === 'house' ? r.kind === 'home' && isDetachedHouseType(r.usage) : r.kind === props.kind);
const list = computed(() => props.results.filter((r) => inKind(r) && inGus(r.gu)));
/** 최근 1년 결과(제목 줄 숫자에 씀) */
const lastYear = computed(() => {
  const from = yearAgo();
  return list.value.filter((r) => r.saleDate >= from);
});
/** 그 날 매각이 열린 결과(낙찰, 유찰, 불허가). 기일이 넘어간 것은 유찰인지 변경인지 몰라 세지 않는다. */
const held = computed(() => lastYear.value.filter((r) => r.sold || r.status === '유찰' || r.status === '매각불허가결정'));
const ratioOf = (r: AuctionResultView) => (r.amount != null && r.appraisal ? (r.amount / r.appraisal) * 100 : null);
/** 낙찰된 결과의 낙찰가 ÷ 감정가(%), 작은 순 */
const ratios = computed(() =>
  lastYear.value
    .filter((r) => r.sold)
    .map(ratioOf)
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b),
);
const median = computed(() => {
  const xs = ratios.value;
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
});
const pct = (x: number) => `${Math.round(x)}%`;
const pct1 = (x: number) => `${Math.round(x * 10) / 10}%`;
const count = (x: number) => x.toLocaleString('ko-KR');

/** 지금 켜 둔 지역 근처 구 */
const gus = computed(() => (props.gus.length ? props.gus : [...new Set(props.stats.map((g) => g.gu))].filter((g) => g !== SEOUL)));
/** 비교하는 지역: 근처 구와 서울 전체 */
const areas = computed(() => [...gus.value, SEOUL]);
const areaLabel = (area: string) => (area === SEOUL ? '서울 전체' : area);
/** 지역(구나 SEOUL)의 지역별 매각통계(읽은 시각 최근 순) */
const statsOf = (area: string) => props.stats.filter((g) => g.gu === area);
/** 지역마다 가장 최근에 읽은 지역별 매각통계 */
const regionStats = computed(() => areas.value.map((a) => statsOf(a)[0]).filter((g): g is CourtRegionStat => g != null));
/** 비교 표 줄: 지역마다 고른 종류의 최근 1년 결과 요약과 가장 최근 법원 통계 */
const compareRows = computed(() =>
  areas.value.map((area) => ({
    area,
    label: areaLabel(area),
    summary: props.compare.find((c) => c.area === area && c.kind === props.kind) ?? null,
    stat: statsOf(area)[0] ?? null,
  })),
);
const showCompare = computed(() => compareRows.value.some((r) => r.summary || r.stat));
const KIND_NAME: Record<AuctionKind, string> = { home: '주거', house: '단독', shop: '상가', land: '토지' };
/** 'YYYY-MM-DD'를 'YYYY.MM.DD'로 */
const dotDate = (date: string | null) => (date ? date.replace(/-/g, '.') : '');
/** 비율 요약을 '중간값 x%, 평균 y%, 가장 낮은 a%, 가장 높은 b%'로 */
const statsText = (r: RatioStats) => `중간값 ${pct1(r.median)}, 평균 ${pct1(r.mean)}, 가장 낮은 ${pct1(r.min)}, 가장 높은 ${pct1(r.max)}`;
const FAILED_NAME: Record<string, string> = { '0': '0회(신건)', '1': '1회', '2': '2회', '3+': '3회 이상' };
type CompareRow = { label: string; summary: AuctionResultSummary | null };
function appraisalTitle(row: CompareRow): string {
  const s = row.summary;
  if (!s) return `${row.label} ${KIND_NAME[props.kind]} 매각 결과가 아직 없습니다.`;
  return [
    `${row.label} ${KIND_NAME[props.kind]}, 매각기일 ${dotDate(s.from)} ~ ${dotDate(s.to)}`,
    `매각이 열린 ${count(s.held)}건(낙찰, 유찰, 불허가) 중 낙찰 ${count(s.sold)}건`,
    ...(s.appraisal
      ? [`낙찰가 ÷ 감정가 ${statsText(s.appraisal)}`, `낙찰가 합 ÷ 감정가 합 ${pct1(s.weighted!)}(법원 매각가율과 같은 계산)`]
      : []),
  ].join('\n');
}
function minPriceTitle(row: CompareRow): string {
  const s = row.summary;
  if (!s?.minPrice) return `${row.label} ${KIND_NAME[props.kind]} 낙찰 결과가 아직 없습니다.`;
  return [
    `${row.label} ${KIND_NAME[props.kind]}, 낙찰 ${count(s.minPrice.count)}건의 낙찰가 ÷ 그 회차 최저가`,
    statsText(s.minPrice),
    `그때까지 유찰 횟수별 중간값: ${s.minPriceByFailed.map((b) => `${FAILED_NAME[b.failed]} ${pct1(b.stats.median)}(${count(b.stats.count)}건)`).join(', ')}`,
  ].join('\n');
}
/** 비교 표 줄마다 지역별 칸: value 큰 숫자(없으면 null), count 옆 건수 */
const compareLines = computed(() => [
  {
    name: '감정가 대비',
    title: appraisalRowTitle,
    cells: compareRows.value.map((r) => ({
      area: r.area,
      title: appraisalTitle(r),
      value: r.summary?.appraisal ? pct(r.summary.appraisal.median) : null,
      count: r.summary ? `${count(r.summary.sold)}/${count(r.summary.held)}건` : '',
    })),
  },
  {
    name: '최저가 대비',
    title: minPriceRowTitle,
    cells: compareRows.value.map((r) => ({
      area: r.area,
      title: minPriceTitle(r),
      value: r.summary?.minPrice ? pct(r.summary.minPrice.median) : null,
      count: r.summary?.minPrice ? `${count(r.summary.minPrice.count)}건` : '',
    })),
  },
  {
    name: '법원 통계',
    title: courtTitle,
    cells: compareRows.value.map((r) => ({
      area: r.area,
      title: r.stat ? statTitle(r.stat) : '',
      value: r.stat ? pct(r.stat.amountRate) : null,
      count: r.stat ? `${count(r.stat.sold)}/${count(r.stat.auctions)}건` : '',
    })),
  },
]);
const appraisalRowTitle ='대시보드가 모은 최근 1년 매각 결과(고른 종류)의 낙찰가 ÷ 감정가 중간값, 낙찰 수/매각이 열린 수(낙찰, 유찰, 불허가)입니다.';
const minPriceRowTitle =
  '대시보드가 모은 최근 1년 낙찰(고른 종류)의 낙찰가 ÷ 그 회차 최저가 중간값입니다. 최저가보다 얼마나 더 써서 낙찰됐는지 보여 줍니다. 마우스를 올리면 유찰 횟수별로 나눈 값이 보입니다.';
const courtTitle = '법원 지역별 매각통계의 매각가율(매각가 합 ÷ 감정가 합, 모든 용도), 매각 수/경매 수입니다.';
const headTitle = computed(() =>
  [
    `켜 둔 지역 근처 구(${gus.value.join(', ') || '없음'})의 법원경매 매각 결과입니다. 고른 종류만 보입니다.`,
    '법원 매각결과검색은 매각기일 다음 날부터 7일 동안만 결과를 보여 줘서, 법원경매를 조회할 때마다 서울 전체 결과를 모아 둡니다. 5일 넘게 못 모았으면 매일 공고 확인 때도 모읍니다.',
    '대시보드가 모은 물건은 매각기일이 지나면 경매사건검색으로도 찾아봅니다. 응찰자 수는 법원 사이트에 나오지 않습니다.',
  ].join('\n'),
);
const medianTitle = computed(() => {
  const xs = ratios.value;
  if (!xs.length) return '';
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return `최근 1년 낙찰된 ${xs.length}건의 낙찰가 ÷ 감정가 중간값입니다. 평균 ${pct1(mean)}, 가장 낮은 ${pct1(xs[0])}, 가장 높은 ${pct1(xs[xs.length - 1])}.`;
});

/** ISO 시각을 '10월 11일'로 */
function monthDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function statTitle(g: CourtRegionStat): string {
  const dongs = [...g.dongs]
    .sort((a, b) => b.auctions - a.auctions)
    .map((d) => `${d.name} ${count(d.auctions)}건 중 ${count(d.sold)}건 ${pct1(d.amountRate)}`)
    .join(', ');
  const earlier = statsOf(g.gu)
    .slice(1, 13)
    .map((s) => `${s.period} ${pct1(s.amountRate)}(${count(s.auctions)}건 중 ${count(s.sold)}건)`);
  return [
    `법원 지역별 매각통계, ${areaLabel(g.gu)}, ${g.period}, 모든 용도, ${monthDay(g.at)}에 읽음`,
    `경매 ${count(g.auctions)}건 중 매각 ${count(g.sold)}건(매각률 ${pct1(g.soldRate)})`,
    `매각가율 ${pct1(g.amountRate)}(매각가 합 ÷ 감정가 합이라 비싼 물건 쪽으로 쏠림)`,
    `${g.gu === SEOUL ? '구별' : '동별'}: ${dongs}`,
    ...(earlier.length ? [`지난 기간: ${earlier.join(', ')}`] : []),
  ].join('\n');
}

/** 매각기일별 묶음(최근 날부터). 같은 날 안에서는 낙찰 먼저, 낙찰가율 높은 순. */
const days = computed(() => {
  const out: { date: string; day: string; items: AuctionResultView[] }[] = [];
  for (const r of list.value) {
    const last = out[out.length - 1];
    if (last?.date === r.saleDate) last.items.push(r);
    else out.push({ date: r.saleDate, day: saleDay(r.saleDate).day, items: [r] });
  }
  for (const g of out) g.items.sort((a, b) => Number(b.sold) - Number(a.sold) || (ratioOf(b) ?? 0) - (ratioOf(a) ?? 0));
  return out;
});
const shownDays = computed(() => (showAll.value ? days.value : days.value.slice(0, SHOWN_DAYS)));
const hiddenCount = computed(() => days.value.slice(shownDays.value.length).reduce((n, g) => n + g.items.length, 0));

function resultText(r: AuctionResultView): string {
  if (r.sold) {
    const x = ratioOf(r);
    return x == null ? '낙찰' : `낙찰 ${pct(x)}`;
  }
  return r.status === '매각불허가결정' ? '불허가' : r.status;
}
function resultClass(r: AuctionResultView): string {
  if (!r.sold) return 'chip-muted';
  const x = ratioOf(r);
  return x != null && x >= 100 ? 'chip-up' : 'chip-down';
}
const resultTitle = (r: AuctionResultView) => `${r.status}, ${r.via === 'case' ? '경매사건검색' : '매각결과검색'}에서 확인`;
/** 낙찰가 ÷ 그 회차 최저가(%). 낙찰이 아니거나 최저가를 모르면 null. */
const overMinOf = (r: AuctionResultView) => (r.sold && r.amount != null && r.minPrice ? (r.amount / r.minPrice) * 100 : null);
/** 물건 줄 가격 아래 줄: '최저가 353만의 105%'. 최저가가 감정가와 같으면(유찰 없음) 낙찰 칩과 같은 값이라 비운다. */
function overMinText(r: AuctionResultView): string {
  const x = overMinOf(r);
  return x == null || r.minPrice === r.appraisal ? '' : `최저가 ${manwon(r.minPrice!)}의 ${pct(x)}`;
}
function priceText(r: AuctionResultView): string {
  if (r.amount != null && r.appraisal != null) return `${manwon(r.appraisal)} → ${manwon(r.amount)}`;
  if (r.minPrice != null) return `최저가 ${manwon(r.minPrice)}${r.appraisal ? ` (${pct((r.minPrice / r.appraisal) * 100)})` : ''}`;
  return r.appraisal != null ? `감정가 ${manwon(r.appraisal)}` : '';
}
function priceTitle(r: AuctionResultView): string {
  const ofAppraisal = (v: number) => (r.appraisal ? `감정가의 ${pct1((v / r.appraisal) * 100)}` : null);
  const overMin = overMinOf(r);
  const paren = (parts: (string | null)[]) => {
    const shown = parts.filter(Boolean);
    return shown.length ? `(${shown.join(', ')})` : '';
  };
  return [
    r.appraisal != null ? `감정가 ${manwon(r.appraisal)}` : null,
    r.minPrice != null ? `최저가 ${manwon(r.minPrice)}${paren([ofAppraisal(r.minPrice), r.failed ? `유찰 ${r.failed}회 뒤` : null])}` : null,
    r.amount != null ? `낙찰가 ${manwon(r.amount)}${paren([ofAppraisal(r.amount), overMin != null ? `최저가의 ${pct1(overMin)}` : null])}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}
const areaText = (r: AuctionResultView) =>
  [r.areaM2 != null ? `${Math.round(r.areaM2 * 10) / 10}㎡` : null, r.lots > 1 ? `${r.lots}개 일괄` : null].filter(Boolean).join(', ');
const caseText = (r: AuctionResultView) => `${r.caseNo}${r.itemNo !== '1' ? `(${r.itemNo})` : ''}`;
</script>

<template>
  <details class="results fold" :open="open" @toggle="onToggle">
    <summary :title="headTitle">
      <span class="fold-name">매각 결과</span>
      <template v-if="held.length">
        <span class="muted num fold-count">낙찰 {{ ratios.length }}/{{ held.length }}건</span>
      </template>
      <span v-else class="muted fold-count">아직 없음</span>
    </summary>
    <div class="body fold-body">
      <div v-if="median != null || regionStats.length" class="result-summary">
        <span v-if="median != null" class="num rate" :title="medianTitle">감정가의 {{ pct(median) }}</span>
        <span v-if="regionStats.length" class="stats">
          <span class="muted">법원 통계</span>
          <span v-for="g in regionStats" :key="g.gu" class="num stat" :title="statTitle(g)">{{ g.gu }} {{ pct(g.amountRate) }}</span>
        </span>
      </div>
      <div v-if="showCompare" class="compare-wrap">
        <table class="compare">
          <thead>
            <tr>
              <th></th>
              <th v-for="r in compareRows" :key="r.area" colspan="2" scope="colgroup">{{ r.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="line in compareLines" :key="line.name">
              <th scope="row" :title="line.title">{{ line.name }}</th>
              <template v-for="c in line.cells" :key="c.area">
                <td class="val num" :class="{ none: c.value == null }" :title="c.title">{{ c.value ?? '없음' }}</td>
                <td class="cnt num" :title="c.title">{{ c.count }}</td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
      <template v-if="days.length">
        <section v-for="g in shownDays" :key="g.date" class="day">
          <h4 class="day-name">{{ g.day }} <span class="muted num">{{ g.items.length }}건</span></h4>
          <ul class="rows">
            <li v-for="r in g.items" :key="r.key" class="row">
              <span class="chip res" :class="resultClass(r)" :title="resultTitle(r)">{{ resultText(r) }}</span>
              <span class="what" :title="r.address ?? ''">
                <b>{{ r.dong ?? r.gu ?? '' }}</b> {{ r.usage ?? '' }}
                <span v-if="areaText(r)" class="muted">{{ areaText(r) }}</span>
              </span>
              <span class="num price" :title="priceTitle(r)">
                {{ priceText(r) }}
                <span v-if="overMinText(r)" class="sub muted">{{ overMinText(r) }}</span>
              </span>
              <a
                v-if="madangUrl(r.court, r.caseNo, r.itemNo)" class="case" :href="madangUrl(r.court, r.caseNo, r.itemNo)!" target="_blank" rel="noopener"
                :title="`${r.court} ${r.caseNo} 물건 ${r.itemNo}, 경매마당에서 열기`"
              >{{ caseText(r) }} ↗</a>
              <span v-else class="case muted" :title="r.court">{{ caseText(r) }}</span>
            </li>
          </ul>
        </section>
        <button v-if="hiddenCount" class="btn btn-sm more" @click="showAll = true">이전 기일 더 보기 {{ hiddenCount }}건</button>
      </template>
      <p v-else class="empty muted">아직 모은 결과가 없습니다.</p>
    </div>
  </details>
</template>

<style scoped>
.result-summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; }
.rate { font-size: 15px; font-weight: 800; color: var(--accent); }
.stats { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 13px; font-weight: 600; }
.stat { font-weight: 700; color: var(--ink-2); }
.body { display: grid; gap: 12px; container-type: inline-size; }
/* 비교 표: 지역마다 숫자 칸(오른쪽 맞춤)과 건수 칸(왼쪽 맞춤)을 따로 두어 줄끼리 숫자 끝이 맞는다. 좁으면 옆으로 넘긴다. */
.compare-wrap { overflow-x: auto; }
.compare {
  border-collapse: separate; border-spacing: 0;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); font-size: 14px;
}
.compare th, .compare td { padding: 7px 0; white-space: nowrap; border-top: 1px solid var(--line); }
.compare thead th { border-top: 0; padding-left: 18px; text-align: left; font-size: 13px; font-weight: 700; color: var(--ink-2); }
.compare tbody th { padding: 7px 4px 7px 14px; text-align: left; font-size: 13px; font-weight: 700; color: var(--ink-2); }
.compare .val { padding-left: 18px; text-align: right; font-size: 15px; font-weight: 800; }
.compare .val.none { font-size: 13px; font-weight: 600; color: var(--muted); }
.compare .cnt { padding: 7px 14px 7px 6px; text-align: left; font-size: 12px; color: var(--muted); }
.day { display: grid; gap: 6px; }
.day-name { margin: 0; font-size: 15px; font-weight: 800; color: var(--ink-2); }
.day-name .muted { font-size: 13px; font-weight: 600; }
.rows { list-style: none; margin: 0; padding: 0; container-type: inline-size; }
.row {
  display: grid; grid-template-columns: 92px minmax(0, 1fr) 190px 128px; gap: 4px 12px; align-items: baseline;
  padding: 8px 0; border-top: 1px solid var(--line); font-size: 14px;
}
.row:first-child { border-top: 0; }
.res { justify-self: start; font-weight: 800; white-space: nowrap; }
.what { min-width: 0; overflow-wrap: anywhere; }
.what .muted { margin-left: 6px; font-size: 13px; }
.price { text-align: right; white-space: nowrap; font-weight: 700; }
.price .sub { display: block; font-size: 12px; font-weight: 600; }
.case { text-align: right; font-size: 13px; white-space: nowrap; text-decoration: none; }
a.case:hover { text-decoration: underline; }
.empty { margin: 0; padding: 8px 0; font-size: 14px; }
.more { justify-self: start; }
/* 좁으면(지도 옆 목록) 가격과 사건번호를 아래 줄로. */
@container (max-width: 560px) {
  .row { grid-template-columns: 92px minmax(0, 1fr); }
  .price { grid-column: 2; text-align: left; }
  .case { grid-column: 2; text-align: left; }
}
</style>
