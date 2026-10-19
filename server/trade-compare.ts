import * as store from './db.js';
import { yearRange, ymd } from './rt-csv.js';
import type { TradeRef } from '../shared/types.js';

// 경매·공매 아파트의 최저가를 같은 지번·같은 전용면적의 국토부 실거래(apt-trades)와 비교한다(카드의 '최저가 실거래보다 N% 낮음').
// 추측으로 맞추지 않는다: 주소의 구·법정동·지번이 실거래의 구·법정동·번지와 글자 그대로 같고, 전용면적이 소수 둘째 자리까지 같은
// 거래만 쓴다. 단지 이름이 비슷하다거나 좌표가 가깝다는 것으로는 맞추지 않으므로, 지번이 다르게 적혔거나(대표 지번과 물건 지번이
// 다른 단지) 실거래 번지가 가려져 있으면 비교하지 않는다. 네이버 매매는 받은 자료에 지번이 없어 비교하지 않는다.
// 기간은 최근 6개월에 3건 이상이면 6개월, 아니면 1년이고 기준은 그 거래들의 중간값이다. 층, 향, 수리 상태는 따지지 않는다.

/** 이 건수가 최근 6개월에 있으면 6개월만 본다(오르거나 내리는 때 1년 전 값이 섞이지 않게) */
const RECENT_MIN = 3;

type Trade = store.CompareTradeRow;
let cache: { key: string; byLot: Map<string, Trade[]> } | null = null;

/** 전용면적을 소수 둘째 자리까지(같은 면적인지 볼 때) */
const area2 = (m2: number) => Math.round(m2 * 100);

/** 최근 1년 거래를 '구|법정동|번지'로 묶는다. 실거래를 새로 받았거나 날이 바뀌면 다시 만든다. */
function byLot(): Map<string, Trade[]> {
  const { from, to } = yearRange();
  const key = `${store.getSetting('apt_trades_fetched_at') ?? ''}|${ymd(to)}`;
  if (cache?.key === key) return cache.byLot;
  const map = new Map<string, Trade[]>();
  for (const t of store.aptTradesSince(ymd(from))) {
    if (!t.jibun) continue;
    const k = `${t.gu}|${t.dong}|${t.jibun}`;
    map.set(k, [...(map.get(k) ?? []), t]);
  }
  cache = { key, byLot: map };
  return map;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 물건 하나(구, 법정동, 지번, 전용면적, 최저가 만원)를 같은 지번·같은 전용면적 실거래와 비교한다. 그런 거래가 없으면 null. */
export function compareLot(o: { gu: string; dong: string; jibun: string; areaM2: number | null; price: number | null }): TradeRef | null {
  if (!o.areaM2 || !o.price) return null;
  const same = (byLot().get(`${o.gu}|${o.dong}|${o.jibun}`) ?? []).filter((t) => area2(t.area_m2) === area2(o.areaM2!));
  if (!same.length) return null;
  const sixAgo = new Date();
  sixAgo.setMonth(sixAgo.getMonth() - 6);
  const recent = same.filter((t) => t.contract_date >= ymd(sixAgo));
  const use = recent.length >= RECENT_MIN ? recent : same;
  const prices = use.map((t) => t.price);
  const mid = Math.round(median(prices));
  const latest = same[0]; // 계약일 최근 순으로 읽었다
  return {
    complex: latest.complex,
    jibun: `${o.gu} ${o.dong} ${o.jibun}`,
    months: use === recent ? 6 : 12,
    count: use.length,
    median: mid,
    min: Math.min(...prices),
    max: Math.max(...prices),
    latest: { date: latest.contract_date, price: latest.price, floor: latest.floor, areaM2: latest.area_m2 },
    diffPct: Math.round((o.price / mid - 1) * 1000) / 10,
  };
}
