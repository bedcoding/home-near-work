import * as store from './db.js';
import { ymd, type RecordRequest } from './rt-csv.js';
import type { RegionVolumeView } from '../shared/types.js';

// 시세 통계 탭 거래량 그래프의 전국, 서울, 인천, 경기 아파트 매매 건수(계약한 달 기준).
// 국토부 실거래가 공개시스템 자료제공 화면의 건수 확인(ptXlsDownDataCheck.do)을 달마다, 시도마다 불러 market_series 'rt-volume'에 둔다.
// 이 건수는 해제된 거래도 센다. 점의 detail은 받은 날({"at":"YYYY-MM-DD"})이고, 달이 끝나고 신고 기한이 지난 뒤 받은 값은 다시 받지 않는다.

export const REGION_VOLUME_SOURCE = '국토부 실거래가 지역별 건수';
export const REGION_VOLUME_SERIES = 'rt-volume';
const FETCHED_KEY = 'region_volume_fetched_at';
const STATUS_KEY = 'region_volume_status';
/** 받은 지 이만큼 지나면 조회할 때 다시 받는다 */
const MAX_AGE_MS = 7 * 86400000;
const BASE = process.env.HNW_RT_BASE ?? 'https://rt.molit.go.kr';
const PAGE_URL = `${BASE}/pt/xls/xls.do?mobileAt=`;
const CHECK_URL = `${BASE}/pt/xls/ptXlsDownDataCheck.do`;
const TIMEOUT_MS = 60000;
const PAUSE_MS = 1000;
/** 자료제공 화면에서 고를 수 있는 첫 달 */
export const FIRST_MONTH = '2006-01';
/** 계약 뒤 이 날수 안에 신고한다. 달 끝에서 이만큼 지난 뒤 받은 값은 다 들어온 값으로 본다(늦은 신고 여유 5일). */
const REPORT_DAYS = 30;
const SETTLE_DAYS = REPORT_DAYS + 5;
/** 한 번 조회할 때 새로 채우는 빈 달 수(달마다 시도 넷을 부른다) */
const DEFAULT_MAX_MONTHS = 36;

/** 시도: code는 자료제공 화면의 시도 코드(전국은 빈 값), 저장할 때 지역 코드 */
export const VOLUME_REGIONS = [
  { code: '00000', sido: '', sidoNm: '전체', name: '전국' },
  { code: '11000', sido: '11000', sidoNm: '서울특별시', name: '서울' },
  { code: '28000', sido: '28000', sidoNm: '인천광역시', name: '인천' },
  { code: '41000', sido: '41000', sidoNm: '경기도', name: '경기' },
] as const;

/** 받을 때가 됐는지: 받은 적이 없거나 받은 지 7일이 지났거나 아직 안 채운 달이 있으면 true */
export function regionVolumeDue(): boolean {
  const at = store.getSetting(FETCHED_KEY);
  return !at || Date.now() - Date.parse(at) >= MAX_AGE_MS || monthsToFetch(Infinity).missing > 0;
}

/** 시세 통계 탭에 보일 받은 상태와 아직 안 채운 달 수 */
export function regionVolumeState(): { fetchedAt: string | null; error: string | null; missing: number } {
  const status = JSON.parse(store.getSetting(STATUS_KEY) ?? 'null') as { ok: boolean; error?: string } | null;
  return {
    fetchedAt: store.getSetting(FETCHED_KEY),
    error: status && !status.ok ? (status.error ?? '받지 못했습니다.') : null,
    missing: monthsToFetch(Infinity).missing,
  };
}

/** 'YYYY-MM' 다음 달 */
function nextMonth(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM'의 마지막 날(1 ~ 31) */
const lastDay = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0).getDate();

/** 달 ym의 값을 day(YYYY-MM-DD)에 받았으면 다 들어온 값인지 */
export function settled(ym: string, day: string): boolean {
  const end = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0);
  end.setDate(end.getDate() + SETTLE_DAYS);
  return day >= ymd(end);
}

/** FIRST_MONTH부터 이번 달까지 */
export function volumeMonths(today = new Date()): string[] {
  const end = ymd(today).slice(0, 7);
  const out: string[] = [];
  for (let m = FIRST_MONTH; m <= end; m = nextMonth(m)) out.push(m);
  return out;
}

/** 저장된 점의 받은 날 */
const fetchedDay = (p: store.MarketPoint) => (JSON.parse(p.detail ?? '{}') as { at?: string }).at ?? '';

/**
 * 이번에 받을 달: 다 들어오지 않은 값이 있는 달(늘 다시 받음)과, 값이 없는 달 중 최근 것부터 maxMissing개.
 * missing은 값이 없는 달 수(이번에 받을 것 포함).
 */
function monthsToFetch(maxMissing: number): { months: string[]; missing: number } {
  const byMonth = new Map<string, store.MarketPoint[]>();
  for (const p of store.marketSeries(REGION_VOLUME_SERIES)) byMonth.set(p.date, [...(byMonth.get(p.date) ?? []), p]);
  const stale: string[] = [];
  const empty: string[] = [];
  for (const ym of volumeMonths().reverse()) {
    const points = byMonth.get(ym) ?? [];
    if (points.length < VOLUME_REGIONS.length) empty.push(ym);
    else if (points.some((p) => !settled(ym, fetchedDay(p)))) stale.push(ym);
  }
  return { months: [...stale, ...empty.slice(0, maxMissing)], missing: empty.length };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 자료제공 화면을 열어 세션 쿠키를 받는다 */
async function openSession(record: RecordRequest): Promise<string> {
  const page = await fetch(PAGE_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  record(PAGE_URL, page.status, '자료제공 화면');
  if (!page.ok) throw new Error(`자료제공 화면을 열지 못했습니다(${page.status}).`);
  return page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** 시도 region의 달 ym 아파트 매매 건수(해제 포함) */
async function countMonth(cookie: string, region: (typeof VOLUME_REGIONS)[number], ym: string, record: RecordRequest): Promise<number> {
  const form = new URLSearchParams({
    srhThingNo: 'A', srhDelngSecd: '1', srhAddrGbn: '1', srhLfstsSecd: '1',
    sidoNm: region.sidoNm, sggNm: '전체', emdNm: '전체', loadNm: '전체', areaNm: '전체', hsmpNm: '전체', mobileAt: '',
    srhFromDt: `${ym}-01`, srhToDt: `${ym}-${String(lastDay(ym)).padStart(2, '0')}`, srhNewRonSecd: '', srhSidoCd: region.sido, srhSggCd: '', srhEmdCd: '',
    srhRoadNm: '', srhLoadCd: '', srhHsmpCd: '', srhArea: '', srhFromAmount: '', srhToAmount: '',
  });
  const res = await fetch(CHECK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Cookie: cookie },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { cnt?: unknown; error?: string };
  record(CHECK_URL, res.status, `${region.name} ${ym} 건수 ${body.cnt ?? '?'}`);
  if (res.status === 403 || res.status === 429) throw new Error(`건수 확인이 막혔습니다(${res.status}).`);
  if (body.error) throw new Error(body.error);
  if (!res.ok || typeof body.cnt !== 'number' || !Number.isInteger(body.cnt) || body.cnt < 0) throw new Error(`${region.name} ${ym} 건수를 읽지 못했습니다(${res.status}).`);
  return body.cnt;
}

/**
 * 그래프 자료: 전국 값이 처음 있는 달부터 이번 달까지, 지역마다 건수(아직 안 받은 달은 null).
 * 수도권은 서울, 인천, 경기의 합, 지방은 전국에서 수도권을 뺀 수. incomplete는 끝에서 다 들어오기 전에 받았거나 아직 안 받은 달 수.
 */
export function buildRegionVolume(): RegionVolumeView {
  const state = regionVolumeState();
  const all = volumeMonths();
  const at = new Map(all.map((m, i) => [m, i]));
  const counts = new Map<string, (number | null)[]>(VOLUME_REGIONS.map((r) => [r.code, all.map(() => null)]));
  const unsettled = all.map(() => false);
  for (const p of store.marketSeries(REGION_VOLUME_SERIES)) {
    const i = at.get(p.date);
    const list = counts.get(p.regionCode);
    if (i == null || !list) continue;
    list[i] = p.value;
    if (!settled(p.date, fetchedDay(p))) unsettled[i] = true;
  }
  const first = counts.get('00000')!.findIndex((v) => v != null);
  if (first < 0) return { months: [], incomplete: 0, regions: [], ...state };
  const cut = (list: (number | null)[]) => list.slice(first);
  const [nation, seoul, incheon, gyeonggi] = VOLUME_REGIONS.map((r) => cut(counts.get(r.code)!));
  const capital = seoul.map((s, i) => (s != null && incheon[i] != null && gyeonggi[i] != null ? s + incheon[i]! + gyeonggi[i]! : null));
  const local = nation.map((n, i) => (n != null && capital[i] != null ? n - capital[i]! : null));
  const months = all.slice(first);
  let incomplete = 0;
  for (let i = months.length - 1; i >= 0 && (unsettled[first + i] || nation[i] == null); i--) incomplete++;
  return {
    months,
    incomplete,
    regions: [
      { id: 'nation', name: '전국', counts: nation },
      { id: 'capital', name: '수도권', counts: capital },
      { id: 'local', name: '지방', counts: local },
      { id: 'gyeonggi', name: '경기', counts: gyeonggi },
      { id: 'incheon', name: '인천', counts: incheon },
    ],
    ...state,
  };
}

let running: Promise<string> | null = null;

/**
 * 받을 달(다 들어오지 않은 달과 빈 달 maxMonths개)마다 시도 넷의 건수를 받아 저장하고 결과 한 줄을 돌려준다.
 * 한 달을 받을 때마다 저장하므로 중간에 멈춰도 받은 달은 남는다. 처음 실패하면 거기서 멈춘다.
 */
export function collectRegionVolume(record: RecordRequest = () => {}, opts: { maxMonths?: number } = {}): Promise<string> {
  running ??= fetchAndSave(record, opts.maxMonths ?? DEFAULT_MAX_MONTHS).finally(() => {
    running = null;
  });
  return running;
}

async function fetchAndSave(record: RecordRequest, maxMonths: number): Promise<string> {
  const { months } = monthsToFetch(maxMonths);
  let done = 0;
  try {
    if (months.length) {
      const cookie = await openSession(record);
      for (const ym of months) {
        const today = ymd(new Date());
        const points: store.MarketPoint[] = [];
        for (const region of VOLUME_REGIONS) {
          await pause(PAUSE_MS);
          points.push({ regionCode: region.code, regionName: region.name, date: ym, value: await countMonth(cookie, region, ym, record), detail: JSON.stringify({ at: today }) });
        }
        store.upsertMarketPoints(REGION_VOLUME_SERIES, points);
        done++;
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    store.setSetting(STATUS_KEY, JSON.stringify({ at: new Date().toISOString(), ok: false, error }));
    throw new Error(done ? `${done}달 받고 멈춤: ${error}` : error);
  }
  const at = new Date().toISOString();
  store.setSetting(STATUS_KEY, JSON.stringify({ at, ok: true }));
  store.setSetting(FETCHED_KEY, at);
  const left = monthsToFetch(Infinity).missing;
  const span = [...months].sort();
  return `${done}달${span.length ? `(${span[0]} ~ ${span[span.length - 1]})` : ''}${left ? `, 안 받은 달 ${left}` : ''}`;
}
