// 국토부 실거래가 공개시스템 자료제공(rt.molit.go.kr)에서 서울 매매 실거래를 CSV로 받는다. 단독/다가구(house-trades)와 아파트(apt-trades)가 같이 쓴다.
// 자료제공 화면을 열어 세션 쿠키를 받고, 화면의 'CSV 다운'과 같은 조건(매매, 지번주소, 시도 서울특별시, 나머지 전체)으로
// 건수 확인(ptXlsDownDataCheck.do)과 CSV(ptXlsCSVDown.do)를 요청한다. CSV는 EUC-KR이고, 안내 줄 다음에 "NO"로 시작하는 머리글 줄이 온다.

const BASE = process.env.HNW_RT_BASE ?? 'https://rt.molit.go.kr';
const PAGE_URL = `${BASE}/pt/xls/xls.do?mobileAt=`;
const CHECK_URL = `${BASE}/pt/xls/ptXlsDownDataCheck.do`;
const CSV_URL = `${BASE}/pt/xls/ptXlsCSVDown.do`;
const TIMEOUT_MS = 60000;

/** 자료제공 화면의 실거래 구분(srhThingNo): A 아파트, C 단독/다가구. 화면의 구분 순서(아파트, 연립/다세대, 단독/다가구)를 따른 글자. */
export type RtThing = 'A' | 'C';

/** 요청 하나를 기록하는 함수(url, HTTP 상태, 설명) */
export type RecordRequest = (url: string, status: number | null, note: string) => void;

/** 이 컴퓨터 날짜 d를 YYYY-MM-DD로 */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 오늘과 1년 전 다음 날(자료제공 화면 기본 계약일 범위와 같음) */
export function yearRange(): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - 1);
  from.setDate(from.getDate() + 1);
  return { from, to };
}

/** CSV 한 줄의 칸들(큰따옴표 사이 글자, ""는 ") */
export function cells(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"]|"")*)"/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1].replace(/""/g, '"'));
  return out;
}

/** '180,000'이나 '150.48'을 숫자로. 비었거나 숫자가 아니면 null. */
export function num(text: string): number | null {
  if (!text.trim()) return null;
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** '-'나 빈 칸은 null */
export const orNull = (text: string) => (text && text !== '-' ? text : null);

/** 해제사유발생일('20250312')을 YYYY-MM-DD로, 아니면 null */
export const cancelDate = (text: string) => (/^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : null);

/** CSV 글자에서 "NO"로 시작하는 머리글 줄의 자리와 칸 이름들. 없으면 오류. */
export function csvHead(lines: string[]): { at: number; head: string[] } {
  const at = lines.findIndex((l) => l.startsWith('"NO"'));
  if (at < 0) throw new Error('실거래 CSV에 머리글 줄이 없습니다.');
  return { at, head: cells(lines[at]) };
}

/**
 * 서울 thing 매매 중 계약일 from ~ to(YYYY-MM-DD)의 CSV 글자와 건수 확인 값(cnt, 모르면 null)을 받는다.
 * 화면과 건수 확인 요청은 기록하고, CSV 요청은 읽은 건수를 아는 부르는 쪽이 기록하도록 url과 상태를 돌려준다(받지 못했으면 기록하고 오류).
 * csvTimeoutMs는 CSV 한 번을 기다리는 시간(아파트 한 해치는 커서 길게 준다).
 */
export async function downloadSeoulCsv(
  thing: RtThing,
  from: string,
  to: string,
  record: RecordRequest,
  csvTimeoutMs = TIMEOUT_MS,
): Promise<{ text: string; count: number | null; url: string; status: number }> {
  const page = await fetch(PAGE_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  record(PAGE_URL, page.status, '자료제공 화면');
  if (!page.ok) throw new Error(`자료제공 화면을 열지 못했습니다(${page.status}).`);
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const form = new URLSearchParams({
    srhThingNo: thing, srhDelngSecd: '1', srhAddrGbn: '1', srhLfstsSecd: '1',
    sidoNm: '서울특별시', sggNm: '전체', emdNm: '전체', loadNm: '전체', areaNm: '전체', hsmpNm: '전체', mobileAt: '',
    srhFromDt: from, srhToDt: to, srhNewRonSecd: '', srhSidoCd: '11000', srhSggCd: '', srhEmdCd: '',
    srhRoadNm: '', srhLoadCd: '', srhHsmpCd: '', srhArea: '', srhFromAmount: '', srhToAmount: '',
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Cookie: cookie };
  const check = await fetch(CHECK_URL, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const counted = (await check.json().catch(() => ({}))) as { cnt?: number; error?: string };
  record(CHECK_URL, check.status, `건수 ${counted.cnt ?? '?'}`);
  if (counted.error) throw new Error(counted.error);
  const csv = await fetch(CSV_URL, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(csvTimeoutMs) });
  if (!csv.ok) {
    record(CSV_URL, csv.status, 'CSV 받기 실패');
    throw new Error(`CSV를 받지 못했습니다(${csv.status}).`);
  }
  const text = new TextDecoder('euc-kr').decode(await csv.arrayBuffer());
  return { text, count: counted.cnt ?? null, url: CSV_URL, status: csv.status };
}
