import * as store from './db.js';
import type { HouseTradeGroup, HouseTradeSummary, HouseTradeView } from '../shared/types.js';

// 국토부 실거래가 공개시스템 자료제공(rt.molit.go.kr)의 단독/다가구 매매(서울, 계약일 최근 1년)를 CSV로 받아 저장한다.
// 받은 1년 범위는 받을 때마다 통째로 바꾸고(해제, 늦게 들어온 신고 반영), 그보다 오래된 거래는 남겨 둔다.
// 자료제공 화면을 열어 세션 쿠키를 받고, 화면의 'CSV 다운'과 같은 조건(단독/다가구, 매매, 지번주소, 시도 서울특별시, 나머지 전체)으로
// 건수 확인(ptXlsDownDataCheck.do)과 CSV(ptXlsCSVDown.do)를 요청한다. CSV는 EUC-KR이고, 안내 줄 다음에 "NO"로 시작하는 머리글 줄이 온다.

const BASE = 'https://rt.molit.go.kr';
const PAGE_URL = `${BASE}/pt/xls/xls.do?mobileAt=`;
const CHECK_URL = `${BASE}/pt/xls/ptXlsDownDataCheck.do`;
const CSV_URL = `${BASE}/pt/xls/ptXlsCSVDown.do`;
/** 마지막으로 받은 시각(ISO)과 마지막 시도 결과(JSON)를 두는 설정 키 */
const FETCHED_KEY = 'house_trades_fetched_at';
const STATUS_KEY = 'house_trades_status';
/** 받은 지 이만큼 지나면 조회할 때 다시 받는다 */
const MAX_AGE_MS = 7 * 86400000;
const TIMEOUT_MS = 60000;
const PYEONG_M2 = 3.305785;

/** 요청 기록에 남길 곳 이름(조회 기록의 요청 표에 그대로 보인다) */
export const HOUSE_TRADES_SOURCE = '국토부 실거래가';

/** 실거래를 받을 때가 됐는지: 받은 적이 없거나 받은 지 MAX_AGE_MS가 지났으면 true. */
export function houseTradesDue(): boolean {
  const at = store.getSetting(FETCHED_KEY);
  return !at || Date.now() - Date.parse(at) >= MAX_AGE_MS;
}

/** 이 컴퓨터 날짜 d를 YYYY-MM-DD로 */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 오늘과 1년 전 다음 날(자료제공 화면 기본 계약일 범위와 같음) */
function yearRange(): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - 1);
  from.setDate(from.getDate() + 1);
  return { from, to };
}

/** CSV 한 줄의 칸들(큰따옴표 사이 글자, ""는 ") */
function cells(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"]|"")*)"/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1].replace(/""/g, '"'));
  return out;
}

/** '180,000'이나 '150.48'을 숫자로. 비었거나 숫자가 아니면 null. */
function num(text: string): number | null {
  if (!text.trim()) return null;
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** '-'나 빈 칸은 null */
const orNull = (text: string) => (text && text !== '-' ? text : null);

const COLUMNS = ['시군구', '번지', '주택유형', '도로조건', '연면적(㎡)', '대지면적(㎡)', '계약년월', '계약일', '거래금액(만원)', '매수', '매도', '건축년도', '도로명', '해제사유발생일', '거래유형'] as const;

/** 받은 CSV 글자를 저장할 거래로 바꾼다. 머리글 줄이나 칸이 없으면 오류. 건축년도 1900은 모르는 해로 본다. */
export function parseHouseCsv(text: string): store.HouseTradeInput[] {
  const lines = text.split(/\r?\n/);
  const headAt = lines.findIndex((l) => l.startsWith('"NO"'));
  if (headAt < 0) throw new Error('실거래 CSV에 머리글 줄이 없습니다.');
  const head = cells(lines[headAt]);
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
      canceledAt: /^\d{8}$/.test(cancel) ? `${cancel.slice(0, 4)}-${cancel.slice(4, 6)}-${cancel.slice(6)}` : null,
      dealType: orNull(get('거래유형')),
    };
    const key = [trade.gu, trade.dong, trade.jibun, trade.contractDate, trade.price, trade.landM2, trade.floorM2, trade.builtYear, trade.houseType].join('|');
    out.push({ key, ...trade });
  }
  return out;
}

/** 요청 하나를 기록하는 함수(url, HTTP 상태, 설명) */
type RecordRequest = (url: string, status: number | null, note: string) => void;

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
    const page = await fetch(PAGE_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    record(PAGE_URL, page.status, '자료제공 화면');
    if (!page.ok) throw new Error(`자료제공 화면을 열지 못했습니다(${page.status}).`);
    const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const form = new URLSearchParams({
      srhThingNo: 'C', srhDelngSecd: '1', srhAddrGbn: '1', srhLfstsSecd: '1',
      sidoNm: '서울특별시', sggNm: '전체', emdNm: '전체', loadNm: '전체', areaNm: '전체', hsmpNm: '전체', mobileAt: '',
      srhFromDt: ymd(from), srhToDt: ymd(to), srhNewRonSecd: '', srhSidoCd: '11000', srhSggCd: '', srhEmdCd: '',
      srhRoadNm: '', srhLoadCd: '', srhHsmpCd: '', srhArea: '', srhFromAmount: '', srhToAmount: '',
    });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Cookie: cookie };
    const check = await fetch(CHECK_URL, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const counted = (await check.json().catch(() => ({}))) as { cnt?: number; error?: string };
    record(CHECK_URL, check.status, `건수 ${counted.cnt ?? '?'}`);
    if (counted.error) throw new Error(counted.error);
    const csv = await fetch(CSV_URL, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = new TextDecoder('euc-kr').decode(await csv.arrayBuffer());
    const trades = parseHouseCsv(text);
    record(CSV_URL, csv.status, `CSV ${trades.length}건`);
    if (counted.cnt != null && trades.length < counted.cnt) throw new Error(`CSV ${trades.length}건이 건수 ${counted.cnt}건보다 적습니다.`);
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
