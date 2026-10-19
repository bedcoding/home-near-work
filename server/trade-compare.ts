import * as store from './db.js';
import { yearRange, ymd } from './rt-csv.js';
import type { TradeRef } from '../shared/types.js';

// 아파트 매물(경매·공매 최저가, 네이버 매매가)을 같은 단지·같은 전용면적의 국토부 실거래(apt-trades)와 비교한다(카드의 '실거래보다 N% 낮음').
// 금액은 신고된 실거래 금액만 쓰고 기준은 그 거래들의 중간값이다. 다른 값으로 미루어 만든 금액은 넣지 않는다.
// 단지는 이렇게 맞추고, 한 단지로 정해지지 않으면 비교하지 않는다.
// - 경매·공매: 주소의 구·법정동·지번이 실거래의 구·법정동·번지와 같은 거래. 없으면 이름 규칙.
// - 네이버 매매: 이름 규칙. 없으면 네이버 단지 좌표로 찾은 필지(point_parcels)의 번지가 같은 거래.
// - 이름 규칙: 같은 구·법정동에서, 괄호 속 글자(차수는 남김), '아파트', 'N단지'의 '단지', 공백과 문장 부호를 빼고 'e편한세상'을
//   '이편한세상'으로 맞춘 이름이 글자 그대로 같은 거래. 그 이름의 거래가 여러 번지에 있으면 다른 단지일 수 있어 맞추지 않는다.
// 전용면적은 0.5㎡ 안(같은 평형의 A·B타입처럼 소수점 아래만 다른 것), 기간은 최근 6개월에 3건 이상이면 6개월, 아니면 1년이다.
// 층, 향, 수리 상태는 따지지 않는다.

/** 같은 전용면적으로 보는 차이(㎡) */
const AREA_TOL = 0.5;
/** 이 건수가 최근 6개월에 있으면 6개월만 본다(오르거나 내리는 때 1년 전 값이 섞이지 않게) */
const RECENT_MIN = 3;

/** 단지명을 비교용으로 다듬는다('상계주공6(고층)' → '상계주공6', '상계주공6단지' → '상계주공6', '한신(2차)' → '한신2차'). */
export function normComplex(name: string): string {
  return name
    .replace(/\(\s*(\d+)\s*차\s*\)/g, '$1차')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/아파트|apt/gi, '')
    .replace(/e-?편한세상/gi, '이편한세상')
    .replace(/제?(\d+)\s*단지/g, '$1')
    .replace(/[\s·.,\-_'"]/g, '')
    .toLowerCase();
}

type Trade = store.CompareTradeRow;
interface Index {
  key: string;
  /** '구|법정동|번지' → 거래 */
  byLot: Map<string, Trade[]>;
  /** '구|법정동|다듬은 단지명' → 거래 */
  byName: Map<string, Trade[]>;
}
let cache: Index | null = null;

/** 최근 1년 거래 묶음. 실거래를 새로 받았거나 날이 바뀌면 다시 만든다. */
function index(): Index {
  const { from, to } = yearRange();
  const key = `${store.getSetting('apt_trades_fetched_at') ?? ''}|${ymd(to)}`;
  if (cache?.key === key) return cache;
  const byLot = new Map<string, Trade[]>();
  const byName = new Map<string, Trade[]>();
  const add = (map: Map<string, Trade[]>, k: string, t: Trade) => map.set(k, [...(map.get(k) ?? []), t]);
  for (const t of store.aptTradesSince(ymd(from))) {
    if (t.jibun) add(byLot, `${t.gu}|${t.dong}|${t.jibun}`, t);
    const n = normComplex(t.complex);
    if (n) add(byName, `${t.gu}|${t.dong}|${n}`, t);
  }
  cache = { key, byLot, byName };
  return cache;
}

/** 단지를 찾는 방법 하나: jibun 주소 지번, name 단지 이름, parcel 네이버 단지 좌표의 필지 번지. value는 번지나 단지 이름. */
export type TradeMatch = { basis: TradeRef['basis']; gu: string; dong: string; value: string };

/** 한 방법으로 찾은 거래. 이름이 같은 거래가 여러 번지에 있으면(다른 단지일 수 있음) 없는 것으로 본다. */
function tradesOf(idx: Index, m: TradeMatch): Trade[] {
  if (m.basis !== 'name') return idx.byLot.get(`${m.gu}|${m.dong}|${m.value}`) ?? [];
  const n = normComplex(m.value);
  const trades = n.length >= 2 ? (idx.byName.get(`${m.gu}|${m.dong}|${n}`) ?? []) : [];
  return new Set(trades.map((t) => t.jibun ?? '')).size === 1 ? trades : [];
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 매물 하나(전용면적 ㎡, 값 만원)를 실거래와 비교한다. 단지 찾는 방법(ways)을 차례로 써서 같은 전용면적 거래가 처음 나온 방법을 쓴다.
 * 그런 거래가 없으면 null.
 */
export function compareTrades(ways: TradeMatch[], areaM2: number | null, price: number | null): TradeRef | null {
  if (!areaM2 || !price) return null;
  const idx = index();
  for (const m of ways) {
    const same = tradesOf(idx, m).filter((t) => Math.abs(t.area_m2 - areaM2) <= AREA_TOL);
    if (!same.length) continue;
    const sixAgo = new Date();
    sixAgo.setMonth(sixAgo.getMonth() - 6);
    const recent = same.filter((t) => t.contract_date >= ymd(sixAgo));
    const use = recent.length >= RECENT_MIN ? recent : same;
    const prices = use.map((t) => t.price);
    const areas = use.map((t) => t.area_m2);
    const mid = Math.round(median(prices));
    const latest = same[0]; // 계약일 최근 순으로 읽었다
    return {
      complex: latest.complex,
      jibun: `${m.gu} ${m.dong}${latest.jibun ? ` ${latest.jibun}` : ''}`,
      basis: m.basis,
      months: use === recent ? 6 : 12,
      count: use.length,
      median: mid,
      min: Math.min(...prices),
      max: Math.max(...prices),
      areaMin: Math.min(...areas),
      areaMax: Math.max(...areas),
      latest: { date: latest.contract_date, price: latest.price, floor: latest.floor, areaM2: latest.area_m2 },
      diffPct: Math.round((price / mid - 1) * 1000) / 10,
    };
  }
  return null;
}
