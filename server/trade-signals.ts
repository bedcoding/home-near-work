import * as store from './db.js';

// 실거래로 만드는 고점 신호(시세 통계 탭): 서울 아파트 달마다 거래 수와 신고가 거래 수.
// 신고가는 같은 단지(구, 법정동, 번지, 단지명)와 같은 전용면적(㎡ 반올림)의 앞선 거래 최고가보다 비싸게 계약된 거래다.
// 앞선 거래가 없는 거래는 신고가를 따지지 않는다(eligible에 안 셈). 단지 급은 지난해 그 구 안에서 전용면적 평당가 중간값 순위로
// 아래 3분의 1(low), 위 3분의 1(high)로 나눈다. 지난해 거래가 없는 단지는 급을 모른다.
// 결과는 market_series('trade-signals', 서울)에 달마다 한 점(value 거래 수, detail 신고가 수)으로 두고, 실거래를 새로 받으면 다시 만든다.

export const TRADE_SIGNAL_SERIES = 'trade-signals';
const STAMP_KEY = 'trade_signals_stamp';
const SEOUL_CODE = '1100000000';
const PYEONG_M2 = 3.305785;

/** 한 달 집계. e: 신고가를 따질 수 있는 거래 수, n: 신고가 수, le와 ln: 아래 급 단지, he와 hn: 위 급 단지 */
export interface TradeSignalCounts { e: number; n: number; le: number; ln: number; he: number; hn: number }
export interface TradeSignalMonth extends TradeSignalCounts { ym: string; count: number }

type Tier = 'low' | 'mid' | 'high';

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 해마다 단지 급: 그해 그 구 안에서 평당가 중간값 순위(싼 쪽부터) 아래 3분의 1은 low, 위 3분의 1은 high */
function tiersByYear(): Map<number, Map<string, Tier>> {
  const ppp = new Map<number, Map<string, { gu: string; list: number[] }>>();
  for (const r of store.iterAptTradesForSignals()) {
    const year = Number(r.contract_date.slice(0, 4));
    const key = `${r.gu}|${r.dong}|${r.jibun ?? ''}|${r.complex}`;
    let byKey = ppp.get(year);
    if (!byKey) ppp.set(year, (byKey = new Map()));
    let c = byKey.get(key);
    if (!c) byKey.set(key, (c = { gu: r.gu, list: [] }));
    c.list.push((r.price / r.area_m2) * PYEONG_M2);
  }
  const out = new Map<number, Map<string, Tier>>();
  for (const [year, byKey] of ppp) {
    const byGu = new Map<string, { key: string; value: number }[]>();
    for (const [key, c] of byKey) byGu.set(c.gu, [...(byGu.get(c.gu) ?? []), { key, value: median(c.list) }]);
    const tiers = new Map<string, Tier>();
    for (const list of byGu.values()) {
      list.sort((a, b) => a.value - b.value);
      list.forEach((x, i) => tiers.set(x.key, i < list.length / 3 ? 'low' : i >= (list.length * 2) / 3 ? 'high' : 'mid'));
    }
    out.set(year, tiers);
  }
  return out;
}

/** 저장된 실거래 전부로 달마다 거래 수와 신고가 수를 센다(계약일 순). */
export function computeTradeSignals(): TradeSignalMonth[] {
  const tiers = tiersByYear();
  const maxOf = new Map<string, number>();
  const months = new Map<string, TradeSignalMonth>();
  for (const r of store.iterAptTradesForSignals()) {
    const ym = r.contract_date.slice(0, 7);
    let m = months.get(ym);
    if (!m) months.set(ym, (m = { ym, count: 0, e: 0, n: 0, le: 0, ln: 0, he: 0, hn: 0 }));
    m.count++;
    const complex = `${r.gu}|${r.dong}|${r.jibun ?? ''}|${r.complex}`;
    const key = `${complex}|${Math.round(r.area_m2)}`;
    const before = maxOf.get(key);
    if (before != null) {
      const isNew = r.price > before ? 1 : 0;
      m.e++;
      m.n += isNew;
      const tier = tiers.get(Number(r.contract_date.slice(0, 4)) - 1)?.get(complex);
      if (tier === 'low') {
        m.le++;
        m.ln += isNew;
      } else if (tier === 'high') {
        m.he++;
        m.hn += isNew;
      }
    }
    if (before == null || r.price > before) maxOf.set(key, r.price);
  }
  return [...months.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

/** 실거래를 받은 상태가 바뀌었으면(받은 시각, 받아 둔 해) 신고가 집계를 다시 만들어 저장한다. 다시 만들었으면 true. */
export function refreshTradeSignals(): boolean {
  const stamp = `${store.getSetting('apt_trades_fetched_at') ?? ''}|${store.getSetting('apt_trades_years') ?? ''}`;
  if (store.getSetting(STAMP_KEY) === stamp && store.marketSeries(TRADE_SIGNAL_SERIES).length) return false;
  const months = computeTradeSignals();
  store.replaceMarketSeries(
    TRADE_SIGNAL_SERIES,
    months.map((m) => ({
      regionCode: SEOUL_CODE,
      regionName: '서울',
      date: m.ym,
      value: m.count,
      detail: JSON.stringify({ e: m.e, n: m.n, le: m.le, ln: m.ln, he: m.he, hn: m.hn } satisfies TradeSignalCounts),
    })),
  );
  store.setSetting(STAMP_KEY, stamp);
  return true;
}

/** 저장된 달마다 집계(달 순) */
export function tradeSignalMonths(): TradeSignalMonth[] {
  return store.marketSeries(TRADE_SIGNAL_SERIES).map((p) => ({ ym: p.date, count: p.value, ...(JSON.parse(p.detail ?? '{}') as TradeSignalCounts) }));
}
