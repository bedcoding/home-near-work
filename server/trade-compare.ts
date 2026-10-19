import * as store from './db.js';
import { yearRange, ymd } from './rt-csv.js';
import type { TradeRef } from '../shared/types.js';

// 아파트 매물(네이버 매매가, 경매·공매 최저가)을 같은 단지·같은 전용면적의 국토부 실거래(apt-trades)와 비교한다(카드의 '실거래보다 N% 낮음').
// 단지는 번지(경매·공매는 주소 지번, 네이버는 단지 좌표로 찾은 필지 point_parcels의 번지)가 실거래 번지와 같으면 그 단지로 보고,
// 아니면 같은 구·법정동에서 단지명(공백, 괄호, '아파트' 같은 글자를 뺀 것)이 같거나, 이름 속 숫자가 같고 한쪽이 다른 쪽을 품는 단지가
// 하나뿐일 때만 그 단지로 본다.
// 애매하면 비교하지 않는다. 면적은 ±2㎡, 기간은 최근 6개월에 3건 이상이면 6개월, 아니면 1년이고 기준은 그 거래들의 중간값이다.
// 층, 향, 수리 상태는 따지지 않는다.

/** 같은 면적으로 보는 차이(㎡) */
const AREA_TOL = 2;
/** 이 건수가 최근 6개월에 있으면 6개월만 본다(오르거나 내리는 때 1년 전 값이 섞이지 않게) */
const RECENT_MIN = 3;

/** 단지명을 비교용으로 다듬는다: 괄호 안, '아파트', 공백과 문장 부호를 빼고 'e편한세상'과 '제1단지'를 한 모양으로. */
export function normComplex(name: string): string {
  return name
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/아파트|apt/gi, '')
    .replace(/e-?편한세상/gi, '이편한세상')
    .replace(/제(\d+)단지/g, '$1단지')
    .replace(/[\s·.,\-_'"]/g, '')
    .toLowerCase();
}

type Trade = store.CompareTradeRow;
interface Index {
  key: string;
  /** '구|법정동' → 다듬은 단지명 → 거래 */
  byDong: Map<string, Map<string, Trade[]>>;
  /** '구|법정동|번지' → 거래 */
  byLot: Map<string, Trade[]>;
}
let cache: Index | null = null;

/** 최근 1년 거래 묶음. 실거래를 새로 받았거나 날이 바뀌면 다시 만든다. */
function index(): Index {
  const { from, to } = yearRange();
  const key = `${store.getSetting('apt_trades_fetched_at') ?? ''}|${ymd(to)}`;
  if (cache?.key === key) return cache;
  const byDong = new Map<string, Map<string, Trade[]>>();
  const byLot = new Map<string, Trade[]>();
  for (const t of store.aptTradesSince(ymd(from))) {
    const dongKey = `${t.gu}|${t.dong}`;
    const names = byDong.get(dongKey) ?? new Map<string, Trade[]>();
    byDong.set(dongKey, names);
    const n = normComplex(t.complex);
    names.set(n, [...(names.get(n) ?? []), t]);
    if (t.jibun) {
      const lotKey = `${dongKey}|${t.jibun}`;
      byLot.set(lotKey, [...(byLot.get(lotKey) ?? []), t]);
    }
  }
  cache = { key, byDong, byLot };
  return cache;
}

/** 이름 속 숫자들('상계주공6단지' → '6', '청구3차2단지' → '3,2'). 차수와 단지 번호가 다른 단지를 가른다. */
const digitsOf = (s: string) => (s.match(/\d+/g) ?? []).join(',');

/**
 * 같은 법정동에서 이름으로 단지를 찾는다. 같은 이름이 없으면 이름 속 숫자가 같고 한쪽이 다른 쪽을 품는 단지가
 * 하나뿐일 때만(짧은 쪽 3글자 이상) 그 단지로 본다('상계주공6' → '상계주공6단지', '상계주공'은 숫자가 달라 뺀다).
 */
function byName(idx: Index, gu: string, dong: string, name: string): Trade[] | undefined {
  const names = idx.byDong.get(`${gu}|${dong}`);
  const n = normComplex(name);
  if (!names || !n) return undefined;
  if (names.has(n)) return names.get(n);
  const hits = [...names.keys()].filter(
    (k) => digitsOf(k) === digitsOf(n) && Math.min(k.length, n.length) >= 3 && (k.includes(n) || n.includes(k)),
  );
  return hits.length === 1 ? names.get(hits[0]) : undefined;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 매물 하나(구, 법정동, 단지명, 단지 필지의 번지, 전용면적, 매매가 만원)를 실거래와 비교한다. 같은 단지·면적 거래가 없으면 null.
 */
export function compareSale(o: { gu: string; dong: string; complexName: string | null; jibun: string | null; areaM2: number | null; price: number | null }): TradeRef | null {
  if (!o.areaM2 || !o.price) return null;
  const idx = index();
  let trades: Trade[] | undefined;
  let basis: TradeRef['basis'] = 'jibun';
  if (o.jibun) trades = idx.byLot.get(`${o.gu}|${o.dong}|${o.jibun}`);
  if (!trades?.length && o.complexName) {
    trades = byName(idx, o.gu, o.dong, o.complexName);
    basis = 'name';
  }
  const same = (trades ?? []).filter((t) => Math.abs(t.area_m2 - o.areaM2!) <= AREA_TOL);
  if (!same.length) return null;
  const sixAgo = new Date();
  sixAgo.setMonth(sixAgo.getMonth() - 6);
  const recent = same.filter((t) => t.contract_date >= ymd(sixAgo));
  const use = recent.length >= RECENT_MIN ? recent : same;
  const prices = use.map((t) => t.price);
  const mid = Math.round(median(prices));
  const latest = same[0]; // 계약일 최근 순으로 읽었다
  return {
    complex: same[0].complex,
    basis,
    months: use === recent ? 6 : 12,
    count: use.length,
    median: mid,
    min: Math.min(...prices),
    max: Math.max(...prices),
    latest: latest ? { date: latest.contract_date, price: latest.price, floor: latest.floor, areaM2: latest.area_m2 } : null,
    diffPct: Math.round((o.price / mid - 1) * 1000) / 10,
  };
}

/** 필지 주소('서울특별시 노원구 상계동 700')의 번지('700'). 모양이 다르면 null. */
export function jibunOfAddr(addr: string | null): string | null {
  const m = /\s(산?\d+(?:-\d+)?)$/.exec(addr ?? '');
  return m ? m[1] : null;
}
