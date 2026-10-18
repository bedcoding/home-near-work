import * as store from './db.js';
import type { RecordRequest } from './rt-csv.js';

// KB부동산 데이터허브(data.kbland.kr) 화면이 부르는 통계 주소에서 아파트 매매가격지수와 매수우위지수를 받아 저장한다(시세 통계 탭).
// 공식 오픈 API가 아니라 KB 화면이 쓰는 주소라 바뀌거나 막힐 수 있다. 주소, 인자, 응답 모양(dataBody.resultCode 11000,
// data.날짜리스트와 data.데이터리스트[{지역코드, 지역명, dataList}])은 PublicDataReader(MIT)의 kbland.py와 사용 안내(2025-03 판)를 따랐다.
// 매수우위지수는 중개업소 응답 중 '매수자 많음' 비율 − '매도자 많음' 비율 + 100이다(같은 안내의 예시 4.35, 56.52 → 47.83으로 맞는다).

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

/** 받는 시계열. 지역코드 11은 서울과 그 구, 기간은 최근 몇 년(없으면 전체). */
export const SERIES = [
  { id: 'price-month', kind: 'price', path: 'priceIndex', params: { 월간주간구분코드: '01', ...APT_SALE }, label: '월간 아파트 매매가격지수' },
  { id: 'price-month-seoul', kind: 'price', path: 'priceIndex', params: { 월간주간구분코드: '01', ...APT_SALE, 지역코드: '11' }, label: '월간 아파트 매매가격지수(서울 구)' },
  { id: 'price-week-seoul', kind: 'price', path: 'priceIndex', params: { 월간주간구분코드: '02', ...APT_SALE, 지역코드: '11', 기간: '3' }, label: '주간 아파트 매매가격지수(서울 구)' },
  { id: 'buyer-week', kind: 'buyer', path: 'maktTrnd', params: { 메뉴코드: '01', 월간주간구분코드: '02' }, label: '주간 매수우위지수' },
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

type KbBody = { dataBody?: { resultCode?: unknown; data?: { 날짜리스트?: unknown; 데이터리스트?: unknown; message?: unknown } } };

/**
 * KB 통계 응답을 저장할 점들로 바꾼다. kind price는 dataList가 지수 숫자, buyer는 {매수자많음, 비슷함, 매도자많음, 매수우위지수}.
 * 결과 코드가 11000이 아니거나 모양이 다르거나 값이 하나도 없으면 오류.
 */
export function parseKb(body: unknown, kind: 'price' | 'buyer'): store.MarketPoint[] {
  const b = (body ?? {}) as KbBody;
  const code = b.dataBody?.resultCode;
  const data = b.dataBody?.data;
  if (String(code) !== '11000') {
    const message = typeof data?.message === 'string' ? `: ${data.message}` : '';
    throw new Error(code == null ? 'KB 통계 응답 모양이 다릅니다(resultCode 없음).' : `KB 통계 응답 오류(${String(code)})${message}`);
  }
  const dates = Array.isArray(data?.날짜리스트) ? data.날짜리스트.map(kbDate) : null;
  const rows = Array.isArray(data?.데이터리스트) ? (data.데이터리스트 as { 지역코드?: unknown; 지역명?: unknown; dataList?: unknown }[]) : null;
  if (!dates || !rows) throw new Error('KB 통계 응답에 날짜리스트나 데이터리스트가 없습니다.');
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
      const points = parseKb(await res.json(), s.kind);
      const regions = new Set(points.map((p) => p.regionCode)).size;
      const last = points.reduce((a, p) => (p.date > a ? p.date : a), '');
      record(url, status, `${s.label}: 지역 ${regions}곳, 마지막 ${last}`);
      store.replaceMarketSeries(s.id, points);
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
