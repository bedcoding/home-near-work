import * as store from './db.js';
import { cancelDate, cells, csvHead, downloadSeoulCsv, num, orNull, yearRange, ymd, type RecordRequest } from './rt-csv.js';

// 국토부 실거래가 공개시스템 자료제공의 서울 아파트 매매를 CSV로 받아 저장한다(시세 통계 탭의 월별 거래량과 구별 평당가, 받는 방법은 rt-csv).
// 최근 1년(자료제공 화면 기본 범위)은 받을 때마다 통째로 바꾸고(늦게 들어온 신고와 해제 반영), 그 앞은 FROM_YEAR부터 해마다 한 번 받아 둔다
// (그해 1월 1일부터, 최근 1년 범위 앞날까지). 지난 해는 최근 해부터 받는다.

/** 요청 기록에 남길 곳 이름 */
export const APT_TRADES_SOURCE = '국토부 실거래가(아파트)';
const FETCHED_KEY = 'apt_trades_fetched_at';
const STATUS_KEY = 'apt_trades_status';
/** 받아 둔 지난 해(JSON 숫자 배열) */
const YEARS_KEY = 'apt_trades_years';
/** 지난 해 받기에 마지막으로 실패한 시각 */
const FAILED_KEY = 'apt_trades_backfill_failed_at';
/** 거래량을 이 해 1월부터 모은다 */
export const APT_FROM_YEAR = 2018;
/** 최근 1년은 받은 지 이만큼 지나면 다시 받는다 */
const MAX_AGE_MS = 7 * 86400000;
/** 지난 해 받기에 실패했으면 이만큼 지나서 다시 해 본다 */
const RETRY_MS = 20 * 3600000;
/** 아파트 CSV 한 번을 기다리는 시간(서울 한 해치는 수만 건) */
const CSV_TIMEOUT_MS = 300000;

const REQUIRED = ['시군구', '단지명', '전용면적(㎡)', '계약년월', '계약일', '거래금액(만원)'] as const;
const OPTIONAL = ['번지', '층', '건축년도', '해제사유발생일', '거래유형'] as const;
type Column = (typeof REQUIRED)[number] | (typeof OPTIONAL)[number];

/**
 * 받은 CSV 글자를 저장할 거래와 머리글 뒤 줄 수(빈 줄 제외, 건수 확인 값과 맞춰 본다)로 바꾼다.
 * 꼭 있어야 할 칸이 없으면 오류(있는 칸 이름을 같이 적는다). 전용면적이나 금액을 못 읽은 줄은 건너뛴다. 건축년도 1900은 모르는 해로 본다.
 */
export function parseAptCsv(text: string): { trades: store.AptTradeInput[]; lines: number } {
  const lines = text.split(/\r?\n/);
  const { at, head } = csvHead(lines);
  const index = Object.fromEntries([...REQUIRED, ...OPTIONAL].map((name) => [name, head.indexOf(name)])) as Record<Column, number>;
  const missing = REQUIRED.filter((name) => index[name] < 0);
  if (missing.length) throw new Error(`아파트 실거래 CSV에 없는 칸: ${missing.join(', ')}(있는 칸: ${head.join(', ')})`);
  const trades: store.AptTradeInput[] = [];
  let count = 0;
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    count++;
    const c = cells(line);
    const get = (name: Column) => (index[name] < 0 ? '' : (c[index[name]] ?? ''));
    const [, gu = '', ...dong] = get('시군구').split(' ');
    const ym = get('계약년월');
    const day = get('계약일');
    const price = num(get('거래금액(만원)'));
    const area = num(get('전용면적(㎡)'));
    if (!gu || !/^\d{6}$/.test(ym) || !/^\d{1,2}$/.test(day) || price == null || area == null || area <= 0) continue;
    const year = num(get('건축년도'));
    const floor = num(get('층'));
    const trade = {
      gu,
      dong: dong.join(' '),
      jibun: orNull(get('번지')),
      complex: get('단지명'),
      areaM2: area,
      contractDate: `${ym.slice(0, 4)}-${ym.slice(4)}-${day.padStart(2, '0')}`,
      price,
      floor: floor != null && Number.isInteger(floor) ? floor : null,
      builtYear: year != null && year > 1900 ? year : null,
      canceledAt: cancelDate(get('해제사유발생일')),
      dealType: orNull(get('거래유형')),
    };
    const key = [trade.gu, trade.dong, trade.jibun, trade.complex, trade.areaM2, trade.contractDate, trade.price, trade.floor].join('|');
    trades.push({ key, ...trade });
  }
  return { trades, lines: count };
}

/** 받아 둔 지난 해들 */
function doneYears(): number[] {
  try {
    const list: unknown = JSON.parse(store.getSetting(YEARS_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((y): y is number => Number.isInteger(y)) : [];
  } catch {
    return [];
  }
}

/** 지난 해 y에서 받을 계약일 범위: 1월 1일부터 12월 31일과 최근 1년 범위 앞날 중 이른 날까지. 받을 날이 없으면 null. */
function pastRange(y: number, recentFrom: Date): { from: string; to: string } | null {
  const before = new Date(recentFrom);
  before.setDate(before.getDate() - 1);
  const to = y < before.getFullYear() ? `${y}-12-31` : ymd(before);
  const from = `${y}-01-01`;
  return y <= before.getFullYear() && from <= to ? { from, to } : null;
}

/** 아직 안 받은 지난 해(최근 해부터) */
export function missingAptYears(): number[] {
  const { from } = yearRange();
  const done = new Set(doneYears());
  const out: number[] = [];
  for (let y = from.getFullYear(); y >= APT_FROM_YEAR; y--) if (!done.has(y) && pastRange(y, from)) out.push(y);
  return out;
}

/**
 * 거래량을 끊김 없이 받아 둔 첫날(YYYY-MM-DD): 최근 1년 범위 첫날에서 받아 둔 지난 해를 거슬러 올라간 곳.
 * 지난 해를 하나도 안 받았으면 최근 1년 범위 첫날이고, 최근 1년도 안 받았으면 null.
 */
export function aptCoverageFrom(): string | null {
  if (!store.getSetting(FETCHED_KEY)) return null;
  const { from } = yearRange();
  const done = new Set(doneYears());
  let start = ymd(from);
  for (let y = from.getFullYear(); y >= APT_FROM_YEAR; y--) {
    const r = pastRange(y, from);
    if (!r) continue;
    if (!done.has(y)) break;
    start = r.from;
  }
  return start;
}

/** 받을 때가 됐는지: 최근 1년을 받은 적이 없거나 7일이 지났거나, 안 받은 지난 해가 있고 마지막 실패에서 20시간이 지났으면 true. */
export function aptTradesDue(): boolean {
  return recentDue() || (missingAptYears().length > 0 && !recentlyFailed());
}

const recentDue = () => {
  const at = store.getSetting(FETCHED_KEY);
  return !at || Date.now() - Date.parse(at) >= MAX_AGE_MS;
};
const recentlyFailed = () => {
  const at = store.getSetting(FAILED_KEY);
  return !!at && Date.now() - Date.parse(at) < RETRY_MS;
};

/** 시세 통계 탭에 보일 받은 상태 */
export function aptTradesState(): { fetchedAt: string | null; error: string | null; missingYears: number[] } {
  const status = JSON.parse(store.getSetting(STATUS_KEY) ?? 'null') as { ok: boolean; error?: string } | null;
  return {
    fetchedAt: store.getSetting(FETCHED_KEY),
    error: status && !status.ok ? (status.error ?? '받지 못했습니다.') : null,
    missingYears: missingAptYears(),
  };
}

/** 계약일 from ~ to 범위를 받아 저장하고 건수를 돌려준다. CSV 줄 수가 건수 확인 값보다 적으면 오류. */
async function fetchRange(from: string, to: string, record: RecordRequest): Promise<number> {
  const { text, count, url, status } = await downloadSeoulCsv('A', from, to, record, CSV_TIMEOUT_MS);
  const { trades, lines } = parseAptCsv(text);
  record(url, status, `CSV ${trades.length}건(${from} ~ ${to})`);
  if (count != null && lines < count) throw new Error(`CSV ${lines}줄이 건수 ${count}건보다 적습니다.`);
  store.replaceAptTrades(from, to, trades);
  return trades.length;
}

let running: Promise<string> | null = null;

/**
 * 서울 아파트 매매를 받아 저장하고 결과 한 줄을 돌려준다. 이미 받는 중이면 그 결과를 기다린다.
 * recent: 최근 1년을 다시 받을지(기본은 받은 지 7일이 지났을 때만), maxYears: 이번에 받을 지난 해 수(기본은 남은 해 모두).
 * 실패하면 마지막 시도 결과에 오류를 남기고 오류를 던진다(그 전에 받은 범위는 저장돼 있다).
 */
export function collectAptTrades(record: RecordRequest = () => {}, opts: { recent?: boolean; maxYears?: number } = {}): Promise<string> {
  running ??= fetchAndSave(record, opts.recent ?? recentDue(), opts.maxYears ?? Infinity).finally(() => {
    running = null;
  });
  return running;
}

async function fetchAndSave(record: RecordRequest, recent: boolean, maxYears: number): Promise<string> {
  const { from, to } = yearRange();
  const parts: string[] = [];
  let step = '최근 1년';
  try {
    if (recent) {
      const n = await fetchRange(ymd(from), ymd(to), record);
      store.setSetting(FETCHED_KEY, new Date().toISOString());
      parts.push(`최근 1년 ${n.toLocaleString('ko-KR')}건(계약일 ${ymd(from)} ~ ${ymd(to)})`);
    }
    for (const y of missingAptYears().slice(0, maxYears)) {
      step = `${y}년`;
      const r = pastRange(y, from)!;
      const n = await fetchRange(r.from, r.to, record);
      store.setSetting(YEARS_KEY, JSON.stringify([...new Set([...doneYears(), y])].sort((a, b) => a - b)));
      parts.push(`${y}년 ${n.toLocaleString('ko-KR')}건`);
    }
    store.setSetting(STATUS_KEY, JSON.stringify({ at: new Date().toISOString(), ok: true }));
    const left = missingAptYears().length;
    if (left) parts.push(`남은 해 ${left}개`);
    return `서울 아파트 매매 ${parts.length ? parts.join(', ') : '새로 받을 범위 없음'}`;
  } catch (e) {
    const message = `${step}: ${e instanceof Error ? e.message : String(e)}`;
    store.setSetting(STATUS_KEY, JSON.stringify({ at: new Date().toISOString(), ok: false, error: message }));
    if (step !== '최근 1년') store.setSetting(FAILED_KEY, new Date().toISOString());
    throw new Error(parts.length ? `${message}(그 전에 받은 것: ${parts.join(', ')})` : message);
  }
}
