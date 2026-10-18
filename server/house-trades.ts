import * as store from './db.js';
import { cancelDate, cells, csvHead, downloadSeoulCsv, num, orNull, yearRange, ymd, type RecordRequest } from './rt-csv.js';
import type { HouseTradeGroup, HouseTradeSummary, HouseTradeView } from '../shared/types.js';

// 국토부 실거래가 공개시스템 자료제공(rt.molit.go.kr)의 단독/다가구 매매(서울, 계약일 최근 1년)를 CSV로 받아 저장한다(받는 방법은 rt-csv).
// 받은 1년 범위는 받을 때마다 통째로 바꾸고(해제, 늦게 들어온 신고 반영), 그보다 오래된 거래는 남겨 둔다.

/** 마지막으로 받은 시각(ISO)과 마지막 시도 결과(JSON)를 두는 설정 키 */
const FETCHED_KEY = 'house_trades_fetched_at';
const STATUS_KEY = 'house_trades_status';
/** 받은 지 이만큼 지나면 조회할 때 다시 받는다 */
const MAX_AGE_MS = 7 * 86400000;
const PYEONG_M2 = 3.305785;

/** 요청 기록에 남길 곳 이름(조회 기록의 요청 표에 그대로 보인다) */
export const HOUSE_TRADES_SOURCE = '국토부 실거래가';

/** 실거래를 받을 때가 됐는지: 받은 적이 없거나 받은 지 MAX_AGE_MS가 지났으면 true. */
export function houseTradesDue(): boolean {
  const at = store.getSetting(FETCHED_KEY);
  return !at || Date.now() - Date.parse(at) >= MAX_AGE_MS;
}

const COLUMNS = ['시군구', '번지', '주택유형', '도로조건', '연면적(㎡)', '대지면적(㎡)', '계약년월', '계약일', '거래금액(만원)', '매수', '매도', '건축년도', '도로명', '해제사유발생일', '거래유형'] as const;

/** 받은 CSV 글자를 저장할 거래로 바꾼다. 머리글 줄이나 칸이 없으면 오류. 건축년도 1900은 모르는 해로 본다. */
export function parseHouseCsv(text: string): store.HouseTradeInput[] {
  const lines = text.split(/\r?\n/);
  const { at: headAt, head } = csvHead(lines);
  const index = Object.fromEntries(COLUMNS.map((name) => [name, head.indexOf(name)])) as Record<(typeof COLUMNS)[number], number>;
  const missing = COLUMNS.filter((name) => index[name] < 0);
  if (missing.length) throw new Error(`실거래 CSV에 없는 칸: ${missing.join(', ')}`);
  const out: store.HouseTradeInput[] = [];
  for (const line of lines.slice(headAt + 1)) {
    if (!line.trim()) continue;
    const c = cells(line);
    const get = (name: (typeof COLUMNS)[number]) => c[index[name]] ?? '';
    const [, gu = '', ...dong] = get('시군구').split(' ');
    const ym = get('계약년월');
    const day = get('계약일');
    const price = num(get('거래금액(만원)'));
    if (!gu || !/^\d{6}$/.test(ym) || !/^\d{1,2}$/.test(day) || price == null) continue;
    const year = num(get('건축년도'));
    const cancel = get('해제사유발생일');
    const trade = {
      gu,
      dong: dong.join(' '),
      jibun: orNull(get('번지')),
      houseType: get('주택유형'),
      road: orNull(get('도로조건')),
      floorM2: num(get('연면적(㎡)')),
      landM2: num(get('대지면적(㎡)')),
      contractDate: `${ym.slice(0, 4)}-${ym.slice(4)}-${day.padStart(2, '0')}`,
      price,
      builtYear: year != null && year > 1900 ? year : null,
      roadName: orNull(get('도로명')),
      buyer: orNull(get('매수')),
      seller: orNull(get('매도')),
      canceledAt: cancelDate(cancel),
      dealType: orNull(get('거래유형')),
    };
    const key = [trade.gu, trade.dong, trade.jibun, trade.contractDate, trade.price, trade.landM2, trade.floorM2, trade.builtYear, trade.houseType].join('|');
    out.push({ key, ...trade });
  }
  return out;
}

let running: Promise<string> | null = null;

/**
 * 서울 단독/다가구 매매(계약일 최근 1년)를 받아 저장하고 결과 한 줄을 돌려준다. 이미 받는 중이면 그 결과를 기다린다.
 * 실패하면 마지막 시도 결과에 오류를 남기고 오류를 던진다(마지막으로 받은 시각은 그대로).
 */
export function collectHouseTrades(record: RecordRequest = () => {}): Promise<string> {
  running ??= fetchAndSave(record).finally(() => {
    running = null;
  });
  return running;
}

async function fetchAndSave(record: RecordRequest): Promise<string> {
  const { from, to } = yearRange();
  try {
    const { text, count, url, status } = await downloadSeoulCsv('C', ymd(from), ymd(to), record);
    const trades = parseHouseCsv(text);
    record(url, status, `CSV ${trades.length}건`);
    if (count != null && trades.length < count) throw new Error(`CSV ${trades.length}건이 건수 ${count}건보다 적습니다.`);
    store.replaceHouseTrades(ymd(from), ymd(to), trades);
    const at = new Date().toISOString();
    store.setSetting(FETCHED_KEY, at);
    store.setSetting(STATUS_KEY, JSON.stringify({ at, ok: true, count: trades.length }));
    return `서울 단독/다가구 매매 ${trades.length}건(계약일 ${ymd(from)} ~ ${ymd(to)})`;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    store.setSetting(STATUS_KEY, JSON.stringify({ at: new Date().toISOString(), ok: false, error: message }));
    throw e;
  }
}

/** 중간값(빈 배열이면 null) */
function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 매매가 칸(만원, 아래 경계는 앞 칸의 max 초과) */
const BUCKETS = [
  { label: '1억 이하', max: 10000 },
  { label: '1억~2억', max: 20000 },
  { label: '2억~3억', max: 30000 },
  { label: '3억~5억', max: 50000 },
  { label: '5억~10억', max: 100000 },
  { label: '10억 넘음', max: Infinity },
];

/** 묶음 하나의 요약: 건수, 매매가 중간값, 대지 평당 중간값(만원, 반올림), 가장 싼 거래 */
function groupOf(name: string, list: HouseTradeView[]): HouseTradeGroup {
  const perPy = list.filter((t) => t.landM2).map((t) => t.price / (t.landM2! / PYEONG_M2));
  const landPy = median(perPy);
  return {
    name,
    count: list.length,
    medianPrice: Math.round(median(list.map((t) => t.price))!),
    landPy: landPy == null ? null : Math.round(landPy),
    cheapest: list.reduce((a, b) => (b.price < a.price ? b : a)),
  };
}

function groupBy<T>(list: T[], keyOf: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of list) out.set(keyOf(x), [...(out.get(keyOf(x)) ?? []), x]);
  return out;
}

/**
 * 계약일 최근 1년, 지은 지 age년 넘은(건축년도 ≤ 올해 - age) 단독주택 매매 요약. gus는 켜 둔 지역 근처 구(먼저 보이고 near 표시).
 * 구는 근처 구 먼저, 그다음 매매가 중간값 낮은 순, 동은 중간값 낮은 순. cheapest는 서울에서 싼 순 20건.
 */
export function buildHouseTradeSummary(gus: string[], age: number): HouseTradeSummary {
  const { from, to } = yearRange();
  const maxBuiltYear = to.getFullYear() - age;
  const trades: HouseTradeView[] = store
    .houseTradeRows(ymd(from))
    .filter((r) => r.built_year != null && r.built_year <= maxBuiltYear)
    .map((r) => ({
      gu: r.gu,
      dong: r.dong,
      date: r.contract_date,
      price: r.price,
      landM2: r.land_m2,
      floorM2: r.floor_m2,
      builtYear: r.built_year,
      road: r.road,
      dealType: r.deal_type,
    }));
  const near = trades.filter((t) => gus.includes(t.gu));
  const status = JSON.parse(store.getSetting(STATUS_KEY) ?? 'null') as { ok: boolean; error?: string } | null;
  return {
    fetchedAt: store.getSetting(FETCHED_KEY),
    error: status && !status.ok ? (status.error ?? '받지 못했습니다.') : null,
    from: ymd(from),
    to: ymd(to),
    maxBuiltYear,
    total: trades.length,
    medianPrice: trades.length ? Math.round(median(trades.map((t) => t.price))!) : null,
    buckets: BUCKETS.map((b, i) => {
      const inside = (t: HouseTradeView) => t.price > (i ? BUCKETS[i - 1].max : -Infinity) && t.price <= b.max;
      return { label: b.label, seoul: trades.filter(inside).length, near: near.filter(inside).length };
    }),
    gus: [...groupBy(trades, (t) => t.gu)]
      .map(([gu, list]) => ({
        ...groupOf(gu, list),
        near: gus.includes(gu),
        dongs: [...groupBy(list, (t) => t.dong)].map(([dong, l]) => groupOf(dong, l)).sort((a, b) => a.medianPrice - b.medianPrice),
      }))
      .sort((a, b) => Number(b.near) - Number(a.near) || a.medianPrice - b.medianPrice),
    cheapest: [...trades].sort((a, b) => a.price - b.price).slice(0, 20),
  };
}
