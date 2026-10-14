import { PAGE_DELAY_MS } from '../config.js';
import * as store from '../db.js';
import type { NoticeInput } from '../db.js';
import { extractLines } from '../notice-files.js';
import { ocrPdf } from '../ocr.js';
import { NOTICE_SHORT, type NoticeSourceId, type TrustDocRound } from '../../shared/types.js';
import { BlockedError, type CollectContext } from './types.js';

// 신탁사 공매 공고의 첨부 공고문(PDF, 한글)을 받아 글자를 읽고, 차수별 입찰일과 최저입찰가 표를 뽑아 저장한다(trust_docs).
// 글자가 없는 그림 PDF는 윈도우 글자 인식(ocr.ts)으로 읽는다. 공고 하나에 한 번 읽고, 받거나 읽지 못했으면 하루 뒤 조회 때 다시 본다.

/** 한 곳에서 한 번 조회할 때 새로 읽는 공고문 수, 그중 글자 인식을 돌리는 수(한 개에 10~20초) */
const MAX_PER_RUN = 10;
const MAX_OCR_PER_RUN = 4;
const RETRY_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;
/** 저장하는 줄 수 */
const MAX_LINES = 600;
/** 끝난 공고(공고문을 읽지 않음) */
const FINISHED = /완료|취소|낙찰|종결|종료/;

/** 공고문으로 보이는 첨부 이름 */
const DOC_NAME = /공매\s*\(?\s*입찰\s*\)?\s*공고|공매\s*공고|공고\s*원문|공고문|공고\s*\(안\)|공고안/;
/** 공고문이 아닌 첨부(감정평가서, 계약서, 준수규칙, 서식 등) */
const NOT_DOC = /감정|계약서|준수|준칙|각서|전입|등기|위임장|서식|대장|사진|도면|확인서|동의서|매뉴얼|설명서|설치|약관|개인정보|방침/;
const DOC_EXT = /\.(pdf|hwpx|hwp)(?:$|[?#\s"'])/i;
/** 교보자산신탁 첨부 링크: javascript:fnCommonDownFile('파일 번호','순번') → POST /front/fms/FileDown.do */
const KYOBO_DOWN = /fnCommonDownFile\(\s*'([^']+)'\s*,\s*'(\d+)'/;

const DATE = /(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/g;
/** 100만 이상, 쉼표로 끊은 금액(원) */
const AMOUNT = /(?<![\d,.])\d{1,3}(?:,\d{3}){2,}(?![\d,])/g;
/** 표 칸 머리의 차수('1차', '1회차', '제1차', '1차수') */
const ROUND = /(?:^|\|)\s*(?:제\s*)?(\d{1,2})\s*(?:차수|회차|차)(?![가-힣])/g;
/** '회차' 칸 머리 줄 뒤, 날짜 줄 바로 다음의 '1 | …' 꼴 차수 */
const BARE_ROUND = /^(\d{1,2})\s*\|/;
/** 칸 '물건번호 | 가격' 짝(가격 뒤 부가세 칸 등은 무시) */
const ITEM_PRICE = /(?:^|\|)\s*(\d{1,3})\s*\|\s*(\d{1,3}(?:,\d{3}){2,})(?=\s*(?:\||$))/g;

const p2 = (n: number | string) => String(n).padStart(2, '0');

function datesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DATE)) {
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push(`${m[1]}-${p2(mo)}-${p2(d)}`);
  }
  return out;
}
const amountsIn = (text: string) => [...text.matchAll(AMOUNT)].map((m) => Number(m[0].replace(/,/g, '')));

/**
 * 공고문 줄(표는 칸을 ' | '로 이은 것)에서 차수별 입찰일, 개찰일, 최저입찰가를 뽑는다. 금액은 만원, 물건(호실)이 여럿이면 그 차수에서 가장 낮은 값.
 * 회차마다 물건 줄이 이어지는 표(itemBlocks)를 먼저 보고, 아니면 차수 칸이 있는 표(tableRounds)를 읽는다.
 */
export function parseRounds(lines: string[]): TrustDocRound[] {
  return itemBlocks(lines) ?? tableRounds(lines);
}

/**
 * 회차마다 물건이 '물건번호 | 가격' 줄로 이어지고, 회차 이름 칸(세로로 합친 칸)이 그 물건 줄들 사이에 끼어 나오는 표.
 * 물건번호가 앞 번호보다 작거나 같아지면 다음 회차로 끊고, 그 묶음 안의 회차 이름 줄('1회차 | 2026.05.11 | …')로 차수와 날짜를 정한다.
 * 회차 이름 줄이 물건 줄보다 먼저 나오면 다음 묶음의 것으로 본다. 물건이 3개 이상인 묶음이 둘 이상일 때만 결과를 준다.
 */
function itemBlocks(lines: string[]): TrustDocRound[] | null {
  type Label = { no: number; dates: string[] };
  type Block = { prices: number[]; label: Label | null; last: number };
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let pending: Label | null = null;
  for (const line of lines) {
    const pairs = [...line.matchAll(ITEM_PRICE)].map((m) => ({ no: Number(m[1]), price: Number(m[2].replace(/,/g, '')) }));
    for (const p of pairs) {
      if (!cur || p.no <= cur.last) {
        blocks.push((cur = { prices: [], label: pending, last: 0 }));
        pending = null;
      }
      cur.prices.push(p.price);
      cur.last = p.no;
    }
    const token = [...line.matchAll(ROUND)][0];
    if (!token) continue;
    const label = { no: Number(token[1]), dates: datesIn(line) };
    if (cur && !cur.label && cur.prices.length) cur.label = label;
    else pending = label;
  }
  const done = blocks.filter((b): b is Block & { label: Label } => !!b.label && b.prices.length >= 3);
  if (done.length < 2) return null;
  return done
    .map((b) => ({
      no: b.label.no,
      bid: b.label.dates[0] ?? null,
      open: b.label.dates[1] ?? null,
      price: Math.round(Math.min(...b.prices) / 10000),
      count: b.prices.length,
    }))
    .sort((a, b) => a.no - b.no);
}

/**
 * 차수 칸이 있는 표. 세 가지 모양을 읽는다.
 * 1) 한 줄에 차수와 날짜, 금액('1차 | 2025. 03. 10. | 10:00 ~ 16:00 | 2025. 03. 11. 14:00 | 1,234,000,000')
 * 2) 날짜 줄 바로 다음 줄에 차수와 금액('2026-03-02 | 2026-03-03' 다음 '1차 | 토지 | 건물 | 부가세 | 합계', 금액은 줄의 마지막 값)
 * 3) '1차 | 2차 …' 머리 줄 아래 차수마다 칸을 둔 표: 날짜 줄(처음은 입찰일, 다음은 개찰일)과 물건별 가격 줄. 차수 날짜가 따로 '1차 | 날짜' 줄로 나오기도 한다.
 * '개찰'만 있는 칸 머리 줄 아래 날짜는 개찰일로 본다.
 */
function tableRounds(lines: string[]): TrustDocRound[] {
  const rounds = new Map<number, { no: number; bid: string | null; open: string | null; prices: number[] }>();
  const roundOf = (no: number) => {
    let r = rounds.get(no);
    if (!r) rounds.set(no, (r = { no, bid: null, open: null, prices: [] }));
    return r;
  };
  let schedule = false;
  let openOnly = false;
  let matrix: number[] | null = null;
  let prevDates: string[] | null = null;
  for (const line of lines) {
    const dates = datesIn(line);
    const amounts = amountsIn(line);
    const before = prevDates;
    prevDates = null;
    let tokens = [...line.matchAll(ROUND)].map((m) => ({ no: Number(m[1]), at: m.index ?? 0 }));
    if (!tokens.length && schedule && before && amounts.length && BARE_ROUND.test(line)) tokens = [{ no: Number(BARE_ROUND.exec(line)![1]), at: 0 }];
    tokens = tokens.filter((t) => t.no >= 1 && t.no <= 40);
    if (tokens.length >= 2 && !dates.length && !amounts.length) {
      matrix = tokens.map((t) => t.no);
      schedule = true;
      continue;
    }
    if (tokens.length) {
      matrix = null;
      tokens.forEach((t, k) => {
        const seg = line.slice(t.at, tokens[k + 1]?.at ?? line.length);
        const r = roundOf(t.no);
        const d = datesIn(seg);
        const a = amountsIn(seg);
        if (d.length) {
          if (openOnly) r.open ??= d[0];
          else {
            r.bid ??= d[0];
            if (d[1]) r.open ??= d[1];
          }
        } else if (k === 0 && before) {
          r.bid ??= before[0];
          if (before[1]) r.open ??= before[1];
        }
        if (a.length) r.prices.push(a[a.length - 1]);
      });
      continue;
    }
    if (matrix && amounts.length === matrix.length && !dates.length) {
      matrix.forEach((no, i) => roundOf(no).prices.push(amounts[i]));
      continue;
    }
    if (matrix && dates.length === matrix.length && !amounts.length) {
      matrix.forEach((no, i) => {
        const r = roundOf(no);
        if (!r.bid) r.bid = dates[i];
        else r.open ??= dates[i];
      });
      continue;
    }
    if (dates.length && !amounts.length) {
      prevDates = dates;
      continue;
    }
    if (/회\s*차|차\s*수/.test(line) && !dates.length && !amounts.length) {
      schedule = true;
      openOnly = /개찰/.test(line) && !/입찰|공매\s*일|공매\s*시간|매각/.test(line);
      matrix = null;
    }
  }
  return [...rounds.values()]
    .filter((r) => r.bid || r.prices.length)
    .sort((a, b) => a.no - b.no)
    .map((r) => ({
      no: r.no,
      bid: r.bid,
      open: r.open,
      price: r.prices.length ? Math.round(Math.min(...r.prices) / 10000) : null,
      count: r.prices.length,
    }));
}

/** 글자 층이 본문이다: 20줄 이상, 한글 300자 이상(쪽 번호나 문서번호 도장만 있는 그림 PDF가 아님). */
const hasText = (lines: string[]) => lines.length >= 20 && (lines.join('').match(/[가-힣]/g)?.length ?? 0) >= 300;

/** 전화번호와 메일 주소를 가린다. */
const redact = (line: string) =>
  line
    .replace(/(?<!\d)0\d{1,2}[)\s.-]*\d{3,4}[\s.-]*\d{4}(?!\d)/g, '(전화)')
    .replace(/(?<!\d)1[5-9]\d{2}[\s.-]*\d{4}(?!\d)/g, '(전화)')
    .replace(/[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g, '(메일)');

interface Attachment {
  name: string;
  /** a.href(절대 주소) */
  href: string;
  onclick: string;
}

/**
 * 공고 상세 화면의 첨부 중 공고문 하나: 이름이 공고문 같고 감정평가서 등이 아닌 것(PDF, hwpx, hwp 순), 없으면 남은 첨부가 하나일 때 그것.
 * 첨부는 이름이나 주소에 .pdf, .hwp, .hwpx가 있는 링크, 또는 이름이 공고문 같은 내려받기 링크다.
 */
function pickDoc(list: Attachment[]): Attachment | null {
  const files = list.filter(
    (a) => !NOT_DOC.test(a.name) && (DOC_EXT.test(a.name) || DOC_EXT.test(a.href) || (DOC_NAME.test(a.name) && /download|filedown|file-download/i.test(`${a.href} ${a.onclick}`))),
  );
  const rank = (a: Attachment) => {
    const ext = (DOC_EXT.exec(a.name) ?? DOC_EXT.exec(a.href))?.[1]?.toLowerCase();
    return ext === 'pdf' ? 0 : ext === 'hwpx' ? 1 : ext === 'hwp' ? 2 : 3;
  };
  const named = files.filter((a) => DOC_NAME.test(a.name)).sort((a, b) => rank(a) - rank(b));
  if (named.length) return named[0];
  return files.length === 1 ? files[0] : null;
}

/** 받은 파일의 형식(파일 앞 몇 바이트와 이름으로) */
function extOf(data: Buffer, name: string): string | null {
  if (data.subarray(0, 4).toString('latin1') === '%PDF') return '.pdf';
  if (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0) return '.hwp';
  if (data[0] === 0x50 && data[1] === 0x4b) return /\.hwpx$/i.test(name) ? '.hwpx' : '.zip';
  return null;
}

const blocked = (status: number) => status === 403 || status === 429;

/** 공고 상세 화면을 열어 공고문 첨부를 찾아 받는다. 직접(direct)이면 공고 주소가 곧 공고문이다. */
async function fetchDoc(ctx: CollectContext, source: NoticeSourceId, item: NoticeInput, direct: boolean): Promise<{ name: string; url: string | null; data: Buffer } | null> {
  const { session } = ctx;
  const request = session.context.request;
  if (direct) {
    const url = item.url!;
    const res = await request.get(url, { timeout: 60000 });
    session.record(source, 'data', url, res.status(), '공고문 받기');
    if (blocked(res.status())) throw new BlockedError(`HTTP ${res.status()}`);
    if (!res.ok()) throw new Error(`공고문 HTTP ${res.status()}`);
    return { name: decodeURIComponent(url.split('/').pop() ?? '공고문'), url, data: await res.body() };
  }
  const page = session.page;
  const res = await session.goto(source, item.url!);
  if (blocked(res?.status() ?? 0)) throw new BlockedError(`HTTP ${res?.status()}`);
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  const list = (await page.evaluate(() =>
    Array.prototype.map.call(document.querySelectorAll('a'), (a: HTMLAnchorElement) => ({
      name: (a.textContent ?? '').replace(/\s+/g, ' ').trim(),
      href: a.getAttribute('href') && !/^(#|javascript:void)/i.test(a.getAttribute('href')!) ? a.href : '',
      onclick: a.getAttribute('onclick') ?? '',
    })),
  )) as Attachment[];
  const doc = pickDoc(list.filter((a) => a.name && (a.href || a.onclick)));
  if (!doc) return null;
  const kyobo = KYOBO_DOWN.exec(`${doc.href} ${doc.onclick}`);
  let r;
  let url: string | null = null;
  if (kyobo) {
    const csrf = await page.evaluate(() => ({
      name: (document.querySelector('#hdCsrfNm') as HTMLInputElement | null)?.value ?? '',
      token: (document.querySelector('#hdCsrfTk') as HTMLInputElement | null)?.value ?? '',
    }));
    const action = new URL('/front/fms/FileDown.do', page.url()).href;
    r = await request.post(action, { form: { ...(csrf.name ? { [csrf.name]: csrf.token } : {}), atchFileId: kyobo[1], fileSn: kyobo[2] }, timeout: 60000 });
    session.record(source, 'data', action, r.status(), `공고문 받기: ${doc.name}`);
  } else {
    url = doc.href;
    r = await request.get(url, { timeout: 60000 });
    session.record(source, 'data', url, r.status(), `공고문 받기: ${doc.name}`);
  }
  if (blocked(r.status())) throw new BlockedError(`HTTP ${r.status()}`);
  if (!r.ok()) throw new Error(`공고문 HTTP ${r.status()}`);
  return { name: doc.name, url, data: await r.body() };
}

/**
 * 모은 공고 중 공고문을 아직 안 읽은 것(받거나 읽지 못한 지 하루 지난 것 포함, 끝난 공고는 뺌)을 MAX_PER_RUN개까지 읽어 저장한다.
 * direct: 공고 주소가 곧 공고문(KB부동산신탁). 아니면 공고 상세 화면의 첨부에서 공고문을 찾는다.
 * 사이트가 막으면(403, 429) 그 곳은 거기서 멈춘다. 공고 목록 수집 결과에는 영향이 없다.
 */
export async function readTrustDocs(ctx: CollectContext, source: NoticeSourceId, items: NoticeInput[], direct = false): Promise<void> {
  const reads = store.trustDocReads(source);
  const now = Date.now();
  let ocrLeft = MAX_OCR_PER_RUN;
  const todo = items
    .filter((it) => it.url && !FINISHED.test(it.status ?? '') && (!direct || /\.pdf$/i.test(it.url)))
    .filter((it) => {
      const r = reads.get(it.sourceId);
      return !r || (!!r.error && now - Date.parse(r.at) > RETRY_MS);
    })
    .slice(0, MAX_PER_RUN);
  for (const item of todo) {
    if (ctx.session.page.isClosed()) return;
    ctx.progress(`${NOTICE_SHORT[source]} 공고문 읽는 중 (${item.title.slice(0, 30)})`);
    const at = new Date().toISOString();
    try {
      const got = await fetchDoc(ctx, source, item, direct);
      if (!got) {
        store.saveTrustDoc({ source, source_id: item.sourceId, name: '', url: null, read_at: at, size: null, rounds: [], lines: [], error: '공고문 첨부를 찾지 못함' });
      } else if (got.data.length > MAX_BYTES) {
        store.saveTrustDoc({ source, source_id: item.sourceId, name: got.name, url: got.url, read_at: at, size: got.data.length, rounds: [], lines: [], error: '파일이 너무 큼' });
      } else {
        const ext = extOf(got.data, got.name);
        if (!ext) throw new Error('PDF나 한글 파일이 아님');
        let lines = (await extractLines(new Uint8Array(got.data), ext)).slice(0, MAX_LINES).map(redact);
        let ocr = false;
        // 글자 층이 본문이 아니면(그림 PDF) 글자 인식으로 읽고, 그래도 없으면 줄을 두지 않는다.
        if (!hasText(lines) && ext === '.pdf') {
          if (ocrLeft <= 0) throw new Error('글자 인식은 다음 조회 때 함');
          ocrLeft--;
          ctx.progress(`${NOTICE_SHORT[source]} 공고문 글자 인식 중 (${item.title.slice(0, 30)})`);
          const read = await ocrPdf(new Uint8Array(got.data));
          if (read) {
            lines = read.slice(0, MAX_LINES).map(redact);
            ocr = true;
          }
        }
        if (!hasText(lines)) {
          lines = [];
          ocr = false;
        }
        const rounds = parseRounds(lines);
        store.saveTrustDoc({ source, source_id: item.sourceId, name: got.name, url: got.url, read_at: at, size: got.data.length, rounds, lines, ocr, error: null });
        ctx.log(`${NOTICE_SHORT[source]} 공고문${ocr ? '(글자 인식)' : ''}: ${item.title.slice(0, 40)} ${lines.length}줄, ${rounds.length ? `${rounds.length}차까지` : '차수 표 없음'}`);
      }
    } catch (e) {
      if (ctx.session.page.isClosed()) return;
      if (e instanceof BlockedError) {
        ctx.log(`${NOTICE_SHORT[source]} 공고문: 사이트가 막아 멈춤(${e.message})`);
        return;
      }
      const error = e instanceof Error ? e.message.split('\n')[0] : String(e);
      store.saveTrustDoc({ source, source_id: item.sourceId, name: '', url: null, read_at: at, size: null, rounds: [], lines: [], error });
      ctx.log(`${NOTICE_SHORT[source]} 공고문: ${item.title.slice(0, 40)} 읽지 못함(${error})`);
    }
    await ctx.session.pause(PAGE_DELAY_MS);
  }
}
