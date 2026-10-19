import * as store from './db.js';
import type { RecordRequest } from './rt-csv.js';

// 시세 통계 탭 고점 신호의 공공 자료를 받아 market_series에 둔다.
// - 한국은행 기준금리 변경 표(HTML 표: 연도, 'MM월 DD일', 금리). base-rate, 날짜는 바뀐 날(YYYY-MM-DD).
// - 공공데이터포털 파일 '지역별 청약 신청자 정보'(15110975)와 '당첨자 정보'(15110976): 연월, 시도, 나이대별 수(EUC-KR CSV).
//   서울 줄의 나이대 합을 subs-apply, subs-win(YYYY-MM)에 둔다. 파일은 두 단계로 받는다(파일 번호 JSON → 파일).
// - 공공데이터포털 파일 '입주예정물량정보'(15111714): 입주예정월, 지역, 사업유형, 주소, 아파트명, 세대수(UTF-8 CSV).
//   서울 세대수를 달마다 더해 move-in-plan(YYYY-MM)에 둔다. 지금 공고된 앞으로의 물량만 오므로 받을 때마다 통째로 바꾼다.
// - 국토교통 통계누리 표 데이터(data.do, JSON, 한 번에 60개월까지): 주택건설 준공(사용검사실적, formId 5373)의 서울 아파트를
//   completions, 미분양주택현황(formId 2082)의 서울 계를 unsold(YYYY-MM)에 둔다. 잠정치 달(' p)')는 detail에 표시한다.

export const PEAK_SOURCE = '고점 신호 공공 자료';
const FETCHED_KEY = 'peak_sources_fetched_at';
const STATUS_KEY = 'peak_sources_status';
/** 받은 지 이만큼 지나면 조회할 때 다시 받는다(모두 달마다 나오는 자료) */
const MAX_AGE_MS = 7 * 86400000;
const TIMEOUT_MS = 60000;
const PAUSE_MS = 1000;
const SEOUL = { regionCode: '1100000000', regionName: '서울' };

const BOK_URL = 'https://www.bok.or.kr/portal/singl/baseRate/list.do?dataSeCd=01&menuNo=200643';
const DATA_GO_META = 'https://www.data.go.kr/tcs/dss/selectFileDataDownload.do';
const DATA_GO_FILE = 'https://www.data.go.kr/cmm/cmm/fileDownload.do';
const MOLIT_DATA = 'https://stat.molit.go.kr/portal/stat/data.do';

/** 통계누리 표: 처음 받는 달, 한 번에 받는 달 수, 서울 줄 고르기 */
const MOLIT_TABLES = [
  { id: 'completions', label: '서울 아파트 준공', formId: '5373', styleNum: '1', first: '201007', pick: (d: Record<string, string>) => d['1'] === '서울' && d['2'] === '아파트' && d['3'] === '아파트', value: '5' },
  { id: 'unsold', label: '서울 미분양', formId: '2082', styleNum: '128', first: '200012', pick: (d: Record<string, string>) => d['1'] === '서울' && d['2'] === '계', value: '3' },
] as const;
/** 통계누리는 60개월까지 받지만 예시처럼 48개월씩 나눈다 */
const MOLIT_CHUNK = 48;
/** 이미 받아 둔 표는 최근 이만큼만 다시 받는다(잠정치가 확정되거나 고쳐지는 달) */
const MOLIT_REFRESH_MONTHS = 24;

/** 받을 때가 됐는지: 받은 적이 없거나 받은 지 7일이 지났으면 true */
export function peakSourcesDue(): boolean {
  const at = store.getSetting(FETCHED_KEY);
  return !at || Date.now() - Date.parse(at) >= MAX_AGE_MS;
}

/** 시세 통계 탭에 보일 받은 상태 */
export function peakSourcesState(): { fetchedAt: string | null; error: string | null } {
  const status = JSON.parse(store.getSetting(STATUS_KEY) ?? 'null') as { ok: boolean; error?: string } | null;
  return { fetchedAt: store.getSetting(FETCHED_KEY), error: status && !status.ok ? (status.error ?? '받지 못했습니다.') : null };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, record: RecordRequest, note: string): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  record(url, res.status, note);
  if (!res.ok) throw new Error(`${note}: HTTP ${res.status}`);
  return res;
}

/** 'YYYYMM'에서 n달 뒤 */
function addMonths(ym: string, n: number): string {
  const total = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1 + n;
  return `${Math.floor(total / 12)}${String((total % 12) + 1).padStart(2, '0')}`;
}

/** 한국은행 기준금리 변경 표를 바뀐 날마다 한 점으로 */
export function parseBaseRate(html: string): store.MarketPoint[] {
  const out: store.MarketPoint[] = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    const day = /^(\d{1,2})월\s*(\d{1,2})일$/.exec(c[1] ?? '');
    const rate = Number(c[2]);
    if (!/^\d{4}$/.test(c[0] ?? '') || !day || !Number.isFinite(rate)) continue;
    out.push({ ...SEOUL, regionCode: '0000000000', regionName: '전국', date: `${c[0]}-${day[1].padStart(2, '0')}-${day[2].padStart(2, '0')}`, value: rate, detail: null });
  }
  if (!out.length) throw new Error('한국은행 기준금리 표를 못 읽었습니다.');
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** CSV 한 줄의 칸들(따옴표 없는 칸과 큰따옴표로 감싼 칸 모두, ""는 ") */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** 받은 파일 글자: UTF-8(BOM 포함)로 읽히면 그대로, 아니면 EUC-KR */
function decodeText(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

/** JSON 안에서 이름이 key이고 값이 비어 있지 않은 첫 글자(맨 위부터, 깊이 우선) */
function findKey(v: unknown, key: string): string | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const own = (v as Record<string, unknown>)[key];
  if (typeof own === 'string' && own) return own;
  for (const x of Object.values(v as Record<string, unknown>)) {
    const found = findKey(x, key);
    if (found) return found;
  }
  return undefined;
}

/** 공공데이터포털 파일 데이터 publicDataPk의 지금 파일을 받아 글자로 */
async function dataGoFile(publicDataPk: string, record: RecordRequest, label: string): Promise<string> {
  const meta = await get(`${DATA_GO_META}?publicDataPk=${publicDataPk}&fileDetailSn=1`, record, `${label} 파일 번호`);
  const json: unknown = await meta.json();
  const atchFileId = findKey(json, 'atchFileId') ?? '';
  const dataNm = findKey(json, 'dataNm') ?? '';
  if (!atchFileId) throw new Error(`${label}: 파일 번호(atchFileId)가 없습니다.`);
  await pause(PAUSE_MS);
  const file = await get(`${DATA_GO_FILE}?atchFileId=${encodeURIComponent(atchFileId)}&fileDetailSn=1&dataNm=${encodeURIComponent(dataNm)}`, record, `${label} 파일`);
  return decodeText(new Uint8Array(await file.arrayBuffer()));
}

/** 지역별 청약 신청자나 당첨자 CSV에서 서울 달마다 나이대 합 */
export function parseSubsCsv(text: string): store.MarketPoint[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = cells(lines[0] ?? '');
  const ymAt = head.indexOf('연월');
  const regionAt = head.indexOf('시도');
  if (ymAt < 0 || regionAt < 0) throw new Error(`청약 CSV에 연월이나 시도 칸이 없습니다(${head.join(', ')}).`);
  const out: store.MarketPoint[] = [];
  for (const line of lines.slice(1)) {
    const c = cells(line);
    if (!(c[regionAt] ?? '').startsWith('서울') || !/^\d{4}-\d{2}$/.test(c[ymAt] ?? '')) continue;
    const sum = c.reduce((a, v, i) => (i === ymAt || i === regionAt ? a : a + (Number(v.replace(/,/g, '')) || 0)), 0);
    out.push({ ...SEOUL, date: c[ymAt], value: sum, detail: null });
  }
  if (!out.length) throw new Error('청약 CSV에 서울 줄이 없습니다.');
  return out;
}

/** 입주예정물량 CSV에서 서울 세대수를 입주예정월마다 더한다 */
export function parseMoveInCsv(text: string): store.MarketPoint[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = cells(lines[0] ?? '');
  const ymAt = head.findIndex((h) => h.includes('입주예정월'));
  const regionAt = head.indexOf('지역');
  const countAt = head.indexOf('세대수');
  if (ymAt < 0 || regionAt < 0 || countAt < 0) throw new Error(`입주예정 CSV 칸이 다릅니다(${head.join(', ')}).`);
  const byMonth = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const c = cells(line);
    const ym = (c[ymAt] ?? '').replace(/\D/g, '').slice(0, 6);
    if (!(c[regionAt] ?? '').startsWith('서울') || ym.length !== 6) continue;
    const key = `${ym.slice(0, 4)}-${ym.slice(4)}`;
    byMonth.set(key, (byMonth.get(key) ?? 0) + (Number((c[countAt] ?? '').replace(/,/g, '')) || 0));
  }
  return [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ ...SEOUL, date, value, detail: null }));
}

/** 통계누리 표 하나를 from ~ to(YYYYMM) 범위로 48개월씩 받아 서울 달마다 값으로 */
async function molitTable(t: (typeof MOLIT_TABLES)[number], from: string, to: string, record: RecordRequest): Promise<store.MarketPoint[]> {
  const out: store.MarketPoint[] = [];
  for (let start = from, n = 0; start <= to; start = addMonths(start, MOLIT_CHUNK), n++) {
    if (n) await pause(PAUSE_MS);
    const end = addMonths(start, MOLIT_CHUNK - 1) < to ? addMonths(start, MOLIT_CHUNK - 1) : to;
    const url = `${MOLIT_DATA}?formId=${t.formId}&styleNum=${t.styleNum}&apprYn=Y&startDate=${start}&endDate=${end}`;
    const res = await get(url, record, `${t.label} ${start} ~ ${end}`);
    const body = (await res.json()) as { result?: boolean; msg?: string; data?: Record<string, string>[] };
    if (!body.result || !Array.isArray(body.data)) throw new Error(`${t.label}: ${body.msg ?? '응답 모양이 다릅니다'}`);
    for (const d of body.data) {
      if (!t.pick(d)) continue;
      const m = /^(\d{4})-(\d{2})/.exec(d['0'] ?? '');
      const value = Number(String(d[t.value] ?? '').replace(/,/g, ''));
      if (m && Number.isFinite(value)) out.push({ ...SEOUL, date: `${m[1]}-${m[2]}`, value, detail: /p\)/.test(d['0']) ? JSON.stringify({ provisional: true }) : null });
    }
  }
  return out;
}

let running: Promise<string> | null = null;

/** 공공 자료를 모두 받아 저장하고 결과 한 줄을 돌려준다. 하나가 실패해도 나머지는 받고, 모두 실패하면 오류를 던진다. */
export function collectPeakSources(record: RecordRequest = () => {}): Promise<string> {
  running ??= fetchAndSave(record).finally(() => {
    running = null;
  });
  return running;
}

async function fetchAndSave(record: RecordRequest): Promise<string> {
  const done: string[] = [];
  const errors: string[] = [];
  const step = async (label: string, work: () => Promise<string>) => {
    try {
      done.push(`${label} ${await work()}`);
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await pause(PAUSE_MS);
  };
  const range = (p: store.MarketPoint[]) => (p.length ? `${p[0].date} ~ ${p[p.length - 1].date}` : '없음');
  await step('기준금리', async () => {
    const html = await (await get(BOK_URL, record, '한국은행 기준금리')).text();
    const points = parseBaseRate(html);
    store.replaceMarketSeries('base-rate', points);
    return range(points);
  });
  await step('청약 신청자와 당첨자', async () => {
    const apply = parseSubsCsv(await dataGoFile('15110975', record, '지역별 청약 신청자'));
    await pause(PAUSE_MS);
    const win = parseSubsCsv(await dataGoFile('15110976', record, '지역별 청약 당첨자'));
    store.replaceMarketSeries('subs-apply', apply);
    store.replaceMarketSeries('subs-win', win);
    return range(apply);
  });
  await step('입주예정', async () => {
    const points = parseMoveInCsv(await dataGoFile('15111714', record, '입주예정물량'));
    store.replaceMarketSeries('move-in-plan', points);
    return range(points);
  });
  const now = new Date();
  const thisMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  for (const t of MOLIT_TABLES) {
    await step(t.label, async () => {
      const stored = store.marketSeries(t.id);
      const from = stored.length ? addMonths(thisMonth, -MOLIT_REFRESH_MONTHS) : t.first;
      const fresh = await molitTable(t, from, thisMonth, record);
      if (!fresh.length) throw new Error('받은 값이 없습니다.');
      const cut = `${from.slice(0, 4)}-${from.slice(4)}`;
      const merged = [...stored.filter((p) => p.date < cut), ...fresh].sort((a, b) => a.date.localeCompare(b.date));
      store.replaceMarketSeries(t.id, merged);
      return range(merged);
    });
  }
  const at = new Date().toISOString();
  store.setSetting(STATUS_KEY, JSON.stringify({ at, ok: !errors.length, ...(errors.length ? { error: errors.join(' / ') } : {}) }));
  if (!done.length) throw new Error(errors.join(' / '));
  store.setSetting(FETCHED_KEY, at);
  return errors.length ? `${done.join(', ')}, 실패: ${errors.join(' / ')}` : done.join(', ');
}
