import { aptCoverageFrom, aptTradesState } from './apt-trades.js';
import * as store from './db.js';
import { kbStatsState, type SeriesId } from './kb-stats.js';
import { guCode } from './lots.js';
import { yearRange, ymd } from './rt-csv.js';
import { SEOUL_GUS, type MarketChanges, type MarketChart, type MarketLine, type MarketNow, type MarketTier, type MarketView } from '../shared/types.js';

// 시세 통계 탭: KB 통계 시계열(kb-stats)과 국토부 아파트 실거래(apt-trades)로 그래프 자료, 지금 흐름 요약, 구별 급지표를 만든다.
// 급지는 공식 분류가 아니다. 최근 1년 실거래의 전용면적 평당 중간값 순위로 구를 다섯 묶음으로 고르게 나눈 것이다.

const PYEONG_M2 = 3.305785;
/** KB 지역코드의 서울 */
const SEOUL_CODE = '1100000000';
/** 계약 뒤 이 날수 안에 신고한다(부동산 거래신고 등에 관한 법률 제3조 ①). 그 안의 달은 거래가 덜 들어와 있다. */
const REPORT_DAYS = 30;
/** 서울 주간 지수 4주 변동률이 이만큼(%) 넘게 오르거나 내리면 방향으로 본다 */
const FLAT_BAND = 0.1;

/** KB 지역코드('1174000000') → 서울 구 이름 */
const GU_OF_CODE = new Map<string, string>(SEOUL_GUS.flatMap((gu) => (guCode(gu) ? [[`${guCode(gu)}00000`, gu] as [string, string]] : [])));

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round1 = (x: number) => Math.round(x * 100) / 100;

/**
 * 시계열 여러 개를 지역마다 선 하나로 모은다(같은 지역코드는 먼저 나온 값). seoulOnly는 서울과 그 구만 받은 시계열이라 구를 이름으로도 알아본다.
 * 시도가 아닌 다른 지역 시군구는 뺀다(KB 지역코드가 10자리 숫자이고 끝 8자리가 0이 아니면 시군구).
 * 선 순서: 전국, 서울, 그 밖의 지역(받은 순서), 서울 구(SEOUL_GUS 순서).
 */
function chartOf(series: { id: SeriesId; seoulOnly: boolean }[], gus: string[]): MarketChart {
  const points = series.flatMap((s) => store.marketSeries(s.id).map((p) => ({ ...p, seoulOnly: s.seoulOnly })));
  const dates = [...new Set(points.map((p) => p.date))].sort();
  const at = new Map(dates.map((d, i) => [d, i]));
  const lines = new Map<string, MarketLine>();
  for (const p of points) {
    let line = lines.get(p.regionCode);
    if (!line) {
      const gu = GU_OF_CODE.get(p.regionCode) ?? (p.seoulOnly && (SEOUL_GUS as readonly string[]).includes(p.regionName) ? p.regionName : null);
      const kind: MarketLine['kind'] = p.regionName === '전국' ? 'nation' : p.regionCode === SEOUL_CODE || /^서울(특별시)?$/.test(p.regionName) ? 'seoul' : gu ? 'gu' : 'region';
      if (kind === 'region' && /^\d{10}$/.test(p.regionCode) && !p.regionCode.endsWith('00000000')) continue;
      line = { code: p.regionCode, name: gu ?? (kind === 'seoul' ? '서울' : p.regionName), kind, near: !!gu && gus.includes(gu), values: dates.map(() => null) };
      lines.set(p.regionCode, line);
    }
    const i = at.get(p.date)!;
    line.values[i] ??= p.value;
  }
  const order = { nation: 0, seoul: 1, region: 2, gu: 3 };
  const guOrder = (l: MarketLine) => (l.kind === 'gu' ? (SEOUL_GUS as readonly string[]).indexOf(l.name) : 0);
  return { dates, lines: [...lines.values()].sort((a, b) => order[a.kind] - order[b.kind] || guOrder(a) - guOrder(b)) };
}

/** 선의 마지막 값 자리(없으면 -1) */
function lastAt(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
  return -1;
}

/** 값 자리 i와 그보다 back칸 앞의 변동률(%) */
function changeAt(values: (number | null)[], i: number, back: number): number | null {
  const now = values[i];
  const before = i - back >= 0 ? values[i - back] : null;
  return now != null && before != null && before !== 0 ? round1((now / before - 1) * 100) : null;
}

/** 월간 선의 마지막 달과 그 달까지 1년, 5년, 10년 변동률 */
function longChanges(chart: MarketChart, line: MarketLine | undefined): { month: string | null; change: MarketChanges } {
  const none = { month: null, change: { y1: null, y5: null, y10: null } };
  if (!line) return none;
  const i = lastAt(line.values);
  if (i < 0) return none;
  const month = chart.dates[i];
  const over = (years: number) => {
    const back = chart.dates.indexOf(`${Number(month.slice(0, 4)) - years}${month.slice(4)}`);
    return back < 0 ? null : changeAt(line.values, i, i - back);
  };
  return { month, change: { y1: over(1), y5: over(5), y10: over(10) } };
}

/** 'YYYY-MM' 다음 달 */
function nextMonth(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** 실거래 월별 건수: 끊김 없이 받아 둔 첫 온전한 달부터 이번 달까지 */
function volumeOf(gus: string[], fetchedAt: string | null): MarketView['volume'] {
  const coverage = aptCoverageFrom();
  if (!coverage || !fetchedAt) return { months: [], incomplete: 0, seoul: [], gus: [] };
  const months: string[] = [];
  const end = ymd(new Date()).slice(0, 7);
  for (let m = coverage.endsWith('-01') ? coverage.slice(0, 7) : nextMonth(coverage.slice(0, 7)); m <= end; m = nextMonth(m)) months.push(m);
  const at = new Map(months.map((m, i) => [m, i]));
  const byGu = new Map(SEOUL_GUS.map((gu) => [gu as string, months.map(() => 0)]));
  for (const r of store.aptTradeMonthCounts()) {
    const i = at.get(r.ym);
    const list = byGu.get(r.gu);
    if (i != null && list) list[i] += r.count;
  }
  // 마지막 날에 신고 기한을 더해도 받은 날보다 뒤인 달은 덜 들어와 있다
  const fetched = new Date(fetchedAt);
  let incomplete = 0;
  for (let i = months.length - 1; i >= 0; i--) {
    const [y, m] = months[i].split('-').map(Number);
    const due = new Date(y, m, 0 + REPORT_DAYS);
    if (due <= fetched) break;
    incomplete++;
  }
  return {
    months,
    incomplete,
    seoul: months.map((_, i) => [...byGu.values()].reduce((sum, list) => sum + list[i], 0)),
    gus: SEOUL_GUS.map((gu) => ({ gu, near: gus.includes(gu), counts: byGu.get(gu)! })),
  };
}

/** 구별 급지표: 최근 1년 해제되지 않은 매매의 전용면적 평당 중간값 순위 */
function tiersOf(gus: string[], price: MarketChart): MarketView['tiers'] {
  const { from, to } = yearRange();
  const rows = store.aptTradeRows(ymd(from), ymd(to));
  if (!rows.length) return null;
  const changeOf = new Map(price.lines.filter((l) => l.kind === 'gu').map((l) => [l.name, longChanges(price, l).change]));
  const perPy = (list: store.AptTradeRow[]) => Math.round(median(list.map((r) => r.price / r.area_m2))! * PYEONG_M2);
  const groups = SEOUL_GUS.map((gu) => ({ gu, list: rows.filter((r) => r.gu === gu) })).filter((g) => g.list.length);
  const list = groups
    .map(({ gu, list }) => {
      const dongs = new Map<string, store.AptTradeRow[]>();
      for (const r of list) dongs.set(r.dong, [...(dongs.get(r.dong) ?? []), r]);
      const p84 = list.filter((r) => r.area_m2 >= 84 && r.area_m2 < 85).map((r) => r.price);
      return {
        gu,
        count: list.length,
        pyeong: perPy(list),
        median84: p84.length ? Math.round(median(p84)!) : null,
        count84: p84.length,
        median: Math.round(median(list.map((r) => r.price))!),
        change: changeOf.get(gu) ?? { y1: null, y5: null, y10: null },
        near: gus.includes(gu),
        dongs: [...dongs].map(([dong, l]) => ({ dong, count: l.length, pyeong: perPy(l) })).sort((a, b) => b.pyeong - a.pyeong),
      };
    })
    .sort((a, b) => b.pyeong - a.pyeong);
  const tiers: MarketTier[] = list.map((g, i) => ({ ...g, rank: i + 1, tier: Math.ceil(((i + 1) * 5) / list.length) }));
  return { from: ymd(from), to: ymd(to), gus: tiers };
}

/** 지금 흐름 요약 */
function nowOf(price: MarketChart, weekly: MarketChart, buyer: MarketChart, volume: MarketView['volume']): MarketNow {
  const seoulWeek = weekly.lines.find((l) => l.kind === 'seoul');
  const wi = seoulWeek ? lastAt(seoulWeek.values) : -1;
  const w = (back: number) => (seoulWeek && wi >= 0 ? changeAt(seoulWeek.values, wi, back) : null);
  const w4 = w(4);
  const seoulLong = longChanges(price, price.lines.find((l) => l.kind === 'seoul'));
  const nationLong = longChanges(price, price.lines.find((l) => l.kind === 'nation'));
  const buyerSeoul = buyer.lines.find((l) => l.kind === 'seoul');
  const buyerNation = buyer.lines.find((l) => l.kind === 'nation');
  const bi = buyerSeoul ? lastAt(buyerSeoul.values) : -1;
  const recent = buyerSeoul && bi >= 0 ? buyerSeoul.values.slice(Math.max(0, bi - 3), bi + 1).filter((v): v is number => v != null) : [];
  const vi = volume.months.length - 1 - volume.incomplete;
  const sum3 = (end: number) => (end >= 2 ? volume.seoul.slice(end - 2, end + 1).reduce((a, b) => a + b, 0) : null);
  return {
    week: wi >= 0 ? weekly.dates[wi] : null,
    w1: w(1),
    w4,
    w13: w(13),
    w52: w(52),
    trend: w4 == null ? null : w4 > FLAT_BAND ? 'up' : w4 < -FLAT_BAND ? 'down' : 'flat',
    month: seoulLong.month,
    seoulChange: seoulLong.change,
    nationChange: nationLong.change,
    buyerWeek: bi >= 0 ? buyer.dates[bi] : null,
    buyerSeoul: bi >= 0 ? buyerSeoul!.values[bi] : null,
    buyerNation: bi >= 0 && buyerNation ? buyerNation.values[bi] : null,
    buyerSeoul4: recent.length ? round1(recent.reduce((a, b) => a + b, 0) / recent.length) : null,
    volumeMonth: vi >= 0 ? volume.months[vi] : null,
    volume: vi >= 0 ? volume.seoul[vi] : null,
    volumeLastYear: vi - 12 >= 0 ? volume.seoul[vi - 12] : null,
    volume3: vi >= 0 ? sum3(vi) : null,
    volume3LastYear: vi - 12 >= 0 ? sum3(vi - 12) : null,
  };
}

/** 시세 통계 탭 자료. gus는 켜 둔 지역 근처 구(그래프에서 먼저 켜지고 표에서 눈에 띈다). */
export function buildMarketView(gus: string[]): MarketView {
  const trades = aptTradesState();
  const price = chartOf([{ id: 'price-month', seoulOnly: false }, { id: 'price-month-seoul', seoulOnly: true }], gus);
  const weekly = chartOf([{ id: 'price-week-seoul', seoulOnly: true }], gus);
  const buyer = chartOf([{ id: 'buyer-week', seoulOnly: false }], gus);
  const volume = volumeOf(gus, trades.fetchedAt);
  return {
    kb: kbStatsState(),
    trades: { ...trades, coverageFrom: aptCoverageFrom() },
    now: nowOf(price, weekly, buyer, volume),
    price,
    buyer,
    volume,
    tiers: tiersOf(gus, price),
  };
}
