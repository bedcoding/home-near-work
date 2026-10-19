import * as store from './db.js';
import type { RecordRequest } from './rt-csv.js';

// KB부동산 데이터허브(data.kbland.kr) 화면이 부르는 통계 주소에서 아파트와 주택종합 매매가격지수, 매수우위지수, KB아파트담보대출 PIR,
// 아파트 매매가 대비 전세가 비율, 주택구매력지수와 주택담보대출 금리를 받아 저장한다(시세 통계 탭).
// 응답: dataBody.resultCode 11000, data.날짜리스트와 data.데이터리스트[{지역코드, 지역명, dataList}].
// 주택구매력지수는 data.주택구매력리스트[{지역코드, 지역명, 지역구분리스트[{매물종별구분, 매물종별구분리스트}]}]와
// data.주담보월소득리스트[{기준날짜, 주택담보대출금리, 중위가구월소득금액}]로 온다.
// 매수우위지수는 중개업소 응답 중 '매수자 많음' 비율 − '매도자 많음' 비율 + 100이다.

const BASE = process.env.HNW_KB_BASE ?? 'https://data-api.kbland.kr/bfmstat/weekMnthlyHuseTrnd';
/** 요청 기록에 남길 곳 이름 */
export const KB_SOURCE = 'KB부동산 통계';
const FETCHED_KEY = 'kb_stats_fetched_at';
const STATUS_KEY = 'kb_stats_status';
/** 받은 지 이만큼 지나면 조회할 때 다시 받는다(주간 통계는 한 주에 한 번 나온다) */
const MAX_AGE_MS = 3 * 86400000;
const TIMEOUT_MS = 30000;
const PAUSE_MS = 300;

const APT_SALE = { 매물종별구분: '01', 매매전세코드: '01' };
/** 기간(최근 몇 년). 월간 지수는 이 값을 안 넘기면 최근 2년만 온다. */
const ALL_YEARS = '50';
/** 주택담보대출 금리를 둘 시계열(주택구매력지수 응답에 같이 온다) */
export const RATE_SERIES = 'mortgage-rate';

/** 받는 시계열. 지역코드 11은 서울과 그 구, 기간은 최근 몇 년(없으면 전체). */
export const SERIES = [
  { id: 'price-month', kind: 'price', path: 'priceIndex', params: { 월간주간구분코드: '01', ...APT_SALE, 기간: ALL_YEARS }, label: '월간 아파트 매매가격지수' },
  { id: 'price-month-seoul', kind: 'price', path: 'priceIndex', params: { 월간주간구분코드: '01', ...APT_SALE, 지역코드: '11', 기간: ALL_YEARS }, label: '월간 아파트 매매가격지수(서울 구)' },
  // 매물종별구분 98은 주택종합(아파트, 연립, 단독)
  { id: 'price-month-all', kind: 'price', path: 'priceIndex', params: { 월간주간구분코드: '01', 매물종별구분: '98', 매매전세코드: '01', 기간: ALL_YEARS }, label: '월간 주택종합 매매가격지수' },
  { id: 'price-week-seoul', kind: 'price', path: 'priceIndex', params: { 월간주간구분코드: '02', ...APT_SALE, 지역코드: '11', 기간: '3' }, label: '주간 아파트 매매가격지수(서울 구)' },
  { id: 'buyer-week', kind: 'buyer', path: 'maktTrnd', params: { 메뉴코드: '01', 월간주간구분코드: '02' }, label: '주간 매수우위지수' },
  { id: 'pir', kind: 'pir', path: 'husScurlnPir', params: {}, label: 'KB아파트담보대출 PIR' },
  { id: 'jeonse-ratio-seoul', kind: 'price', path: 'dealCntstTnantRato', params: { 매물종별구분: '01', 지역코드: '11' }, label: '아파트 매매가 대비 전세가 비율(서울 구)' },
  { id: 'hai', kind: 'hai', path: 'HAI', params: {}, label: '주택구매력지수와 주택담보대출 금리' },
] as const;
export type SeriesId = (typeof SERIES)[number]['id'];

/** 받을 때가 됐는지: 받은 적이 없거나 받은 지 3일이 지났으면 true. */
export function kbStatsDue(): boolean {
  const at = store.getSetting(FETCHED_KEY);
  return !at || Date.now() - Date.parse(at) >= MAX_AGE_MS;
}

/** 시세 통계 탭에 보일 받은 상태 */
export function kbStatsState(): { fetchedAt: string | null; error: string | null } {
  const status = JSON.parse(store.getSetting(STATUS_KEY) ?? 'null') as { ok: boolean; error?: string } | null;
  return { fetchedAt: store.getSetting(FETCHED_KEY), error: status && !status.ok ? (status.error ?? '받지 못했습니다.') : null };
}

/** 'YYYYMM' → 'YYYY-MM', 'YYYYMMDD' → 'YYYY-MM-DD', 다른 모양은 null */
function kbDate(s: unknown): string | null {
  const t = String(s ?? '');
  if (/^\d{6}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4)}`;
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}`;
  return null;
}

/** 숫자나 숫자 글자를 숫자로, 아니면 null */
function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type KbBody = {
  dataBody?: { resultCode?: unknown; data?: { 날짜리스트?: unknown; 데이터리스트?: unknown; 주택구매력리스트?: unknown; 주담보월소득리스트?: unknown; message?: unknown } };
};

/** 결과 코드가 11000이 아니면 오류. 맞으면 data와 날짜(YYYY-MM 또는 YYYY-MM-DD, 모르는 모양은 null) */
function kbData(body: unknown): { data: NonNullable<NonNullable<KbBody['dataBody']>['data']>; dates: (string | null)[] } {
  const b = (body ?? {}) as KbBody;
  const code = b.dataBody?.resultCode;
  const data = b.dataBody?.data;
  if (String(code) !== '11000' || !data) {
    const message = typeof data?.message === 'string' ? `: ${data.message}` : '';
    throw new Error(code == null ? 'KB 통계 응답 모양이 다릅니다(resultCode 없음).' : `KB 통계 응답 오류(${String(code)})${message}`);
  }
  if (!Array.isArray(data.날짜리스트)) throw new Error('KB 통계 응답에 날짜리스트가 없습니다.');
  return { data, dates: data.날짜리스트.map(kbDate) };
}

/**
 * 주택구매력지수 응답을 지역별 아파트 주택구매력지수(hai)와 주택담보대출 금리(rate, 전국 하나)로 바꾼다.
 * 값이 하나도 없으면 오류.
 */
export function parseHai(body: unknown): { hai: store.MarketPoint[]; rate: store.MarketPoint[] } {
  const { data, dates } = kbData(body);
  const regions = Array.isArray(data.주택구매력리스트) ? (data.주택구매력리스트 as Record<string, unknown>[]) : [];
  const hai: store.MarketPoint[] = [];
  for (const r of regions) {
    const regionCode = String(r.지역코드 ?? '');
    const regionName = String(r.지역명 ?? '');
    const kinds = Array.isArray(r.지역구분리스트) ? (r.지역구분리스트 as Record<string, unknown>[]) : [];
    const apt = kinds.find((k) => String(k.매물종별구분 ?? '') === '아파트');
    const list = Array.isArray(apt?.매물종별구분리스트) ? (apt.매물종별구분리스트 as unknown[]) : null;
    if (!regionCode || !regionName || !list) continue;
    dates.forEach((date, i) => {
      const value = toNum(list[i]);
      if (date && value != null) hai.push({ regionCode, regionName, date, value, detail: null });
    });
  }
  const incomes = Array.isArray(data.주담보월소득리스트) ? (data.주담보월소득리스트 as Record<string, unknown>[]) : [];
  const rate: store.MarketPoint[] = [];
  for (const m of incomes) {
    const date = kbDate(m.기준날짜);
    const value = toNum(m.주택담보대출금리);
    if (date && value != null) rate.push({ regionCode: '0000000000', regionName: '전국', date, value, detail: JSON.stringify({ income: toNum(m.중위가구월소득금액) }) });
  }
  if (!hai.length && !rate.length) throw new Error('KB 주택구매력지수 응답에 값이 없습니다.');
  return { hai, rate };
}

/**
 * KB 통계 응답을 저장할 점들로 바꾼다. kind price는 dataList가 숫자, buyer는 {매수자많음, 비슷함, 매도자많음, 매수우위지수},
 * pir은 {KB아파트PIR, 주택가격(만원), 가구소득(만원)}.
 * 결과 코드가 11000이 아니거나 모양이 다르거나 값이 하나도 없으면 오류.
 */
export function parseKb(body: unknown, kind: 'price' | 'buyer' | 'pir'): store.MarketPoint[] {
  const { data, dates } = kbData(body);
  const rows = Array.isArray(data.데이터리스트) ? (data.데이터리스트 as { 지역코드?: unknown; 지역명?: unknown; dataList?: unknown }[]) : null;
  if (!rows) throw new Error('KB 통계 응답에 데이터리스트가 없습니다.');
  const out: store.MarketPoint[] = [];
  for (const r of rows) {
    const regionCode = String(r?.지역코드 ?? '');
    const regionName = String(r?.지역명 ?? '');
    if (!regionCode || !regionName || !Array.isArray(r.dataList)) continue;
    const list = r.dataList as unknown[];
    dates.forEach((date, i) => {
      if (!date) return;
      if (kind === 'price') {
        const value = toNum(list[i]);
        if (value != null) out.push({ regionCode, regionName, date, value, detail: null });
        return;
      }
      const o = (list[i] ?? {}) as Record<string, unknown>;
      if (kind === 'pir') {
        const value = toNum(o.KB아파트PIR);
        if (value != null) out.push({ regionCode, regionName, date, value, detail: JSON.stringify({ price: toNum(o.주택가격), income: toNum(o.가구소득) }) });
        return;
      }
      const value = toNum(o.매수우위지수);
      if (value == null) return;
      out.push({ regionCode, regionName, date, value, detail: JSON.stringify({ buyers: toNum(o.매수자많음), even: toNum(o.비슷함), sellers: toNum(o.매도자많음) }) });
    });
  }
  if (!out.length) throw new Error('KB 통계 응답에 값이 없습니다.');
  return out;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running: Promise<string> | null = null;

/**
 * KB 시계열을 모두 받아 저장하고 결과 한 줄을 돌려준다. 이미 받는 중이면 그 결과를 기다린다.
 * 하나가 실패해도 나머지는 받고, 실패한 것은 마지막 시도 결과에 남긴다. 모두 실패하면 오류를 던진다.
 */
export function collectKbStats(record: RecordRequest = () => {}): Promise<string> {
  running ??= fetchAndSave(record).finally(() => {
    running = null;
  });
  return running;
}

async function fetchAndSave(record: RecordRequest): Promise<string> {
  const errors: string[] = [];
  let saved = 0;
  let latestWeek: string | null = null;
  for (const [i, s] of SERIES.entries()) {
    if (i) await pause(PAUSE_MS);
    const url = `${BASE}/${s.path}?${new URLSearchParams(s.params)}`;
    let status: number | null = null;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      status = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      const saves: [string, store.MarketPoint[]][] = [];
      if (s.kind === 'hai') {
        const { hai, rate } = parseHai(body);
        saves.push([s.id, hai], [RATE_SERIES, rate]);
      } else saves.push([s.id, parseKb(body, s.kind)]);
      const points = saves.flatMap(([, p]) => p);
      const regions = new Set(points.map((p) => p.regionCode)).size;
      const first = points.reduce((a, p) => (!a || p.date < a ? p.date : a), '');
      const last = points.reduce((a, p) => (p.date > a ? p.date : a), '');
      record(url, status, `${s.label}: 지역 ${regions}곳, ${first} ~ ${last}`);
      for (const [id, p] of saves) if (p.length) store.replaceMarketSeries(id, p);
      saved++;
      if (s.id === 'price-week-seoul') latestWeek = last;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      record(url, status, `${s.label}: ${message}`);
      errors.push(`${s.label}: ${message}`);
    }
  }
  const at = new Date().toISOString();
  store.setSetting(STATUS_KEY, JSON.stringify({ at, ok: !errors.length, ...(errors.length ? { error: errors.join(' / ') } : {}) }));
  if (!saved) throw new Error(errors.join(' / '));
  store.setSetting(FETCHED_KEY, at);
  const text = `${SERIES.length}개 중 ${saved}개 받음${latestWeek ? `(주간 기준일 ${latestWeek})` : ''}`;
  return errors.length ? `${text}, 실패: ${errors.join(' / ')}` : text;
}
