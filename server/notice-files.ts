import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import CFB from 'cfb';
import { strFromU8, unzipSync } from 'fflate';
import { gusFor, nearNamesFor } from './collectors/gus.js';
import { DASHBOARD_URL, ROOT } from './config.js';
import * as store from './db.js';
import { distanceM } from './geo.js';
import { notify } from './notify.js';
import type { Area, NoticeFileLine, NoticeFileView } from '../shared/types.js';

// 사용자가 공고 사이트에서 직접 받은 첨부 파일(크롬 확장이 위치를 알림)을 읽는다.
// 글자를 줄로 뽑아(표는 칸을 ' | '로 이음) 저장하고, 켜 둔 지역 근처 동이나 역 이름, 근처 구 이름이 나온 줄을 찾는다.
// 근처 판단은 볼 때마다 지금 켜 둔 지역으로 다시 한다.

/** 읽을 수 있는 형식. 압축 파일(zip)은 안에 든 이 형식 파일을 읽는다. */
const READABLE = new Set(['.pdf', '.xlsx', '.hwp', '.hwpx', '.csv', '.zip']);
/** 받아 두되 아직 읽지 못하는 형식(목록에는 '못 읽음'으로 남긴다). */
const KNOWN = new Set([...READABLE, '.xls', '.hwt', '.doc', '.docx']);
const MAX_BYTES = 60 * 1024 * 1024;
/** 근처 줄은 파일마다 이만큼까지 보인다. */
const MAX_LINES = 100;
/** pdfjs 글꼴과 문자표 폴더(끝이 '/'인 주소 모양이어야 한다) */
const pdfjsDir = (sub: string) => `${path.join(ROOT, 'node_modules', 'pdfjs-dist', sub).replace(/\\/g, '/')}/`;

class Unsupported extends Error {}

const extOf = (name: string) => path.extname(name).toLowerCase();
/** 제어 문자와 여러 칸 띄우기를 한 칸으로 */
const clean = (s: string) => s.replace(/[\u0000-\u001f 　﻿]/g, ' ').replace(/\s+/g, ' ').trim();
const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (named[e.toLowerCase()]) return named[e.toLowerCase()];
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
/** 파일 이름 속 번호('sheet12.xml' → 12, 'Section3' → 3) */
const numberIn = (name: string) => Number(/(\d+)(?:\.\w+)?$/.exec(name)?.[1] ?? 0);

// ---------- 형식별 글자 뽑기 ----------

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** PDF 한 쪽의 글자 조각을 줄로 모은다. 같은 높이(글자 크기의 40% 안)면 한 줄, 칸 사이가 넓으면 ' | '. */
function pdfPageLines(items: unknown[]): string[] {
  const parts = items
    .filter((i): i is PdfTextItem => typeof (i as PdfTextItem).str === 'string' && (i as PdfTextItem).str.trim() !== '')
    .map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) || i.height || 10, s: i.str }));
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: (typeof parts)[] = [];
  for (const p of parts) {
    const line = lines.at(-1);
    if (line && Math.abs(line[0].y - p.y) <= Math.max(2, Math.min(line[0].h, p.h) * 0.4)) line.push(p);
    else lines.push([p]);
  }
  return lines
    .map((line) => {
      line.sort((a, b) => a.x - b.x);
      let text = '';
      let end = -Infinity;
      for (const p of line) {
        const gap = p.x - end;
        if (text) text += gap > Math.max(p.h, 8) * 1.5 ? ' | ' : gap > p.h * 0.15 ? ' ' : '';
        text += p.s;
        end = p.x + p.w;
      }
      return clean(text);
    })
    .filter(Boolean);
}

async function pdfLines(data: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data,
    cMapUrl: pdfjsDir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfjsDir('standard_fonts'),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const out: string[] = [];
  try {
    const doc = await task.promise;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      out.push(...pdfPageLines((await page.getTextContent()).items));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return out;
}

/** 엑셀 열 이름('AB')을 번호로 */
const columnIndex = (ref: string) => [...ref].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
/** XML 조각 안의 글자(<t> 안)를 이어 붙인다. 엑셀 읽는 법 표시(<rPh>)는 뺀다. */
const xmlText = (xml: string) =>
  [...xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '').matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => unescapeXml(m[1])).join('');

/** xlsx: 시트마다 줄 하나에 행 하나(칸은 ' | ', 사이의 빈 칸도 자리를 지켜 머리 줄과 칸이 맞는다). */
function xlsxLines(data: Uint8Array): string[] {
  const files = unzipSync(data, {
    filter: (f) => f.originalSize <= MAX_BYTES && (f.name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name)),
  });
  const sharedXml = files['xl/sharedStrings.xml'];
  const shared = sharedXml ? [...strFromU8(sharedXml).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1])) : [];
  const out: string[] = [];
  for (const name of Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => numberIn(a) - numberIn(b))) {
    for (const row of strFromU8(files[name]).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: [number, string][] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] ?? '';
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        let value: string;
        if (type === 'inlineStr') value = xmlText(body);
        else {
          const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          if (raw == null) continue;
          value = type === 's' ? (shared[Number(raw)] ?? '') : unescapeXml(raw);
        }
        value = clean(value);
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        if (value) cells.push([ref ? columnIndex(ref) : (cells.at(-1)?.[0] ?? 0) + 1, value]);
      }
      if (!cells.length) continue;
      const byColumn = new Map(cells);
      const first = Math.min(...byColumn.keys());
      const last = Math.max(...byColumn.keys());
      const line = Array.from({ length: Math.min(last - first + 1, 200) }, (_, i) => byColumn.get(first + i) ?? '');
      out.push(line.join(' | ').replace(/\s+/g, ' ').trim());
    }
  }
  return out;
}

/** 한글 OWPML(hwpx의 Contents/section*.xml): 문단마다 줄 하나, 표는 행마다 줄 하나(칸은 ' | '). */
function owpmlLines(xml: string): string[] {
  const out: string[] = [];
  const rows: string[][] = [];
  const cells: string[] = [];
  let para = '';
  let inText = false;
  const append = (s: string) => {
    if (cells.length) cells[cells.length - 1] += s;
    else para += s;
  };
  for (const m of xml.matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      if (inText) append(unescapeXml(m[4]));
      continue;
    }
    const close = m[1] === '/';
    const self = m[3] === '/';
    switch (m[2].replace(/^\w+:/, '')) {
      case 't':
        inText = !close && !self;
        break;
      case 'tab':
      case 'lineBreak':
        if (!close) append(' ');
        break;
      case 'tr':
        if (!close && !self) rows.push([]);
        else if (close) {
          const line = (rows.pop() ?? []).map(clean).filter(Boolean).join(' | ');
          if (line) out.push(line);
        }
        break;
      case 'tc':
        if (!close && !self) cells.push('');
        else if (close) rows.at(-1)?.push(cells.pop() ?? '');
        break;
      case 'p':
        if (close) {
          if (cells.length) cells[cells.length - 1] += ' ';
          else {
            const line = clean(para);
            if (line) out.push(line);
            para = '';
          }
        }
        break;
    }
  }
  return out;
}

function hwpxLines(data: Uint8Array): string[] {
  const files = unzipSync(data, { filter: (f) => f.originalSize <= MAX_BYTES && /^Contents\/section\d+\.xml$/i.test(f.name) });
  return Object.keys(files)
    .sort((a, b) => numberIn(a) - numberIn(b))
    .flatMap((n) => owpmlLines(strFromU8(files[n])));
}

// 한글 5.0(hwp) 본문 기록 번호
const HWPTAG_PARA_TEXT = 67;
const HWPTAG_CTRL_HEADER = 71;
const HWPTAG_LIST_HEADER = 72;

/** 문단 글자 기록(UTF-16LE). 0~31은 제어 문자: 0, 10, 13, 24~31은 한 글자, 나머지는 8글자(16바이트)짜리 컨트롤이다. */
function hwpParaText(b: Buffer): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; ) {
    const c = b.readUInt16LE(i);
    if (c >= 32) {
      s += String.fromCharCode(c);
      i += 2;
    } else if (c === 0 || c === 10 || c === 13 || (c >= 24 && c <= 31)) {
      s += c === 24 ? '-' : ' ';
      i += 2;
    } else {
      if (c === 9) s += ' ';
      i += 16;
    }
  }
  return clean(s);
}

/**
 * 한 구역(BodyText/SectionN)의 기록을 줄로. 표(컨트롤 'tbl ')는 칸마다(문단 리스트 머리의 열, 행 번호) 글자를 모았다가
 * 표가 끝나면(그 표보다 얕은 단계의 기록) 행마다 줄 하나로 내보낸다.
 */
function hwpSectionLines(buf: Buffer): string[] {
  interface Table {
    level: number;
    cells: Map<number, Map<number, string[]>>;
    cell: { row: number; col: number } | null;
  }
  const out: string[] = [];
  const tables: Table[] = [];
  const flush = (t: Table) => {
    for (const [, cols] of [...t.cells].sort((a, b) => a[0] - b[0])) {
      const line = [...cols].sort((a, b) => a[0] - b[0]).map(([, parts]) => clean(parts.join(' '))).filter(Boolean).join(' | ');
      if (line) out.push(line);
    }
  };
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const head = buf.readUInt32LE(pos);
    pos += 4;
    const tag = head & 0x3ff;
    const level = (head >>> 10) & 0x3ff;
    let size = head >>> 20;
    if (size === 0xfff) {
      if (pos + 4 > buf.length) break;
      size = buf.readUInt32LE(pos);
      pos += 4;
    }
    const body = buf.subarray(pos, pos + size);
    pos += size;
    while (tables.length && level <= tables.at(-1)!.level) flush(tables.pop()!);
    const table = tables.at(-1);
    if (tag === HWPTAG_CTRL_HEADER && body.length >= 4 && body.toString('latin1', 0, 4) === ' lbt') {
      tables.push({ level, cells: new Map(), cell: null });
    } else if (tag === HWPTAG_LIST_HEADER && table && level === table.level + 1 && body.length >= 12) {
      table.cell = { col: body.readUInt16LE(8), row: body.readUInt16LE(10) };
    } else if (tag === HWPTAG_PARA_TEXT) {
      const text = hwpParaText(body);
      if (!text) continue;
      if (table?.cell && level >= table.level + 2) {
        const row = table.cells.get(table.cell.row) ?? new Map<number, string[]>();
        row.set(table.cell.col, [...(row.get(table.cell.col) ?? []), text]);
        table.cells.set(table.cell.row, row);
      } else out.push(text);
    }
  }
  while (tables.length) flush(tables.pop()!);
  return out;
}

/** 한글 5.0(hwp): 복합 문서 안 BodyText/Section0, 1, … (압축이면 deflate를 푼다). 암호와 배포용 문서는 못 읽는다. */
function hwpLines(data: Uint8Array): string[] {
  const doc = CFB.read(Buffer.from(data), { type: 'buffer' });
  const entries = doc.FullPaths.map((p, i) => [p, doc.FileIndex[i]] as const);
  const header = entries.find(([p]) => /\/FileHeader$/i.test(p))?.[1].content;
  if (!header || header.length < 40) throw new Error('한글 파일 머리(FileHeader)를 찾지 못했습니다.');
  const props = Buffer.from(header as Uint8Array).readUInt32LE(36);
  if (props & 2) throw new Unsupported('암호가 걸린 한글 파일입니다.');
  if (props & 4) throw new Unsupported('배포용 한글 파일이라 글자를 꺼낼 수 없습니다.');
  const out: string[] = [];
  for (const [, entry] of entries.filter(([p]) => /\/BodyText\/Section\d+$/i.test(p)).sort((a, b) => numberIn(a[0]) - numberIn(b[0]))) {
    let buf = Buffer.from(entry.content as Uint8Array);
    if (props & 1) buf = zlib.inflateRawSync(buf);
    out.push(...hwpSectionLines(buf));
  }
  return out;
}

/** csv: UTF-8(BOM 포함)이 아니면 EUC-KR로 읽는다. 쉼표를 ' | '로. */
function csvLines(data: Uint8Array): string[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    text = new TextDecoder('euc-kr').decode(data);
  }
  return text.split(/\r?\n/).map((l) => clean(l.replace(/,/g, ' | '))).filter((l) => l.replace(/[|\s]/g, ''));
}

/** zip 안 파일 이름: UTF-8 표시가 없는 한국어 이름(EUC-KR)은 다시 풀어 읽는다. */
function zipName(name: string): string {
  if (!/[\u0080-ÿ]/.test(name) || /[가-힣]/.test(name)) return name;
  try {
    return new TextDecoder('euc-kr').decode(Buffer.from(name, 'latin1'));
  } catch {
    return name;
  }
}

async function zipLines(data: Uint8Array): Promise<string[]> {
  const files = unzipSync(data, {
    filter: (f) => f.originalSize <= MAX_BYTES && READABLE.has(extOf(f.name)) && extOf(f.name) !== '.zip',
  });
  const out: string[] = [];
  for (const name of Object.keys(files).sort()) {
    out.push(`[${path.basename(zipName(name))}]`);
    try {
      out.push(...(await extractLines(files[name], extOf(name))));
    } catch (e) {
      out.push(`(못 읽음: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return out;
}

/** 형식(확장자)에 맞게 글자를 줄로 뽑는다. */
export async function extractLines(data: Uint8Array, ext: string): Promise<string[]> {
  switch (ext) {
    case '.pdf':
      return pdfLines(data);
    case '.xlsx':
      return xlsxLines(data);
    case '.hwpx':
      return hwpxLines(data);
    case '.hwp':
      return hwpLines(data);
    case '.csv':
      return csvLines(data);
    case '.zip':
      return zipLines(data);
    case '.xls':
      throw new Unsupported('엑셀 97-2003 형식(.xls)은 아직 읽지 못합니다.');
    default:
      throw new Unsupported(`${ext || '확장자 없는'} 파일은 읽지 못합니다.`);
  }
}

// ---------- 켜 둔 지역 근처 줄 찾기 ----------

/** 주소 속 동 이름('역삼동', '문래동1가') */
const DONG = /(?:^|[\s,])([가-힣]{1,5}\d*동(?:\d+가)?)(?=$|[\s,\d(])/g;
/** 표 머리 줄로 보는 칸 이름 */
const HEADER_WORDS = ['주소', '소재지', '보증금', '임대료', '전용면적', '면적', '호수', '동호', '주택형', '단지', '세대', '자치구', '지역'];
const isHeader = (text: string) => HEADER_WORDS.filter((w) => text.includes(w)).length >= 2 && (text.match(/\d/g)?.length ?? 0) <= 6;

let dongCache: { key: string; at: number; dongs: string[] } | null = null;

/** 켜 둔 지역 반경 안 매물 주소에 5번 넘게 나온 동 이름('문래동1가'면 '문래동'도). 10분 동안 기억한다. */
function nearDongs(areas: Area[]): string[] {
  const key = areas.map((a) => `${a.lat},${a.lng},${a.radiusM}`).join(';');
  if (dongCache && dongCache.key === key && Date.now() - dongCache.at < 10 * 60_000) return dongCache.dongs;
  const count = new Map<string, number>();
  for (const p of store.listingPlaces()) {
    if (!areas.some((a) => distanceM(a.lat, a.lng, p.lat, p.lng) <= a.radiusM)) continue;
    for (const d of new Set([...p.address.matchAll(DONG)].map((m) => m[1]))) count.set(d, (count.get(d) ?? 0) + 1);
  }
  const found = [...count].filter(([, n]) => n >= 5).map(([d]) => d);
  const dongs = [...new Set(found.flatMap((d) => [d, d.replace(/(동)\d+가$/, '$1')]))];
  dongCache = { key, at: Date.now(), dongs };
  return dongs;
}

interface NearContext {
  /** 근처 구 */
  gus: string[];
  /** 근처 동 이름과 역, 지역 이름 */
  names: string[];
}

function nearContext(): NearContext {
  const areas = store.enabledAreas();
  return { gus: gusFor(areas), names: [...new Set([...nearDongs(areas), ...nearNamesFor(areas)])].filter((n) => n.length >= 2) };
}

/** 줄마다 근처 이름이나 근처 구가 나오는지 보고, 서울 구마다 나온 줄 수를 센다. */
function analyze(lines: string[], ctx: NearContext): Pick<NoticeFileView, 'nearCount' | 'guCount' | 'byGu' | 'lines'> {
  const byGu = new Map<string, number>();
  const near: NoticeFileLine[] = [];
  const gu: NoticeFileLine[] = [];
  let header: string | null = null;
  let headerJustBefore = false;
  for (const line of lines) {
    // 머리 줄이 두 줄이면(엑셀 칸 합치기) 이어 붙인다.
    const head = isHeader(line);
    if (head) header = (headerJustBefore && header ? `${header} / ${line}` : line).slice(0, 300);
    headerJustBefore = head;
    for (const g of store.SEOUL_GUS) if (line.includes(g)) byGu.set(g, (byGu.get(g) ?? 0) + 1);
    const text = line.slice(0, 400);
    const name = ctx.names.find((n) => line.includes(n));
    if (name) {
      near.push({ text, level: 'near', match: name, header });
      continue;
    }
    const g = ctx.gus.find((x) => line.includes(x));
    if (g) gu.push({ text, level: 'gu', match: g, header });
  }
  return {
    nearCount: near.length,
    guCount: gu.length,
    byGu: [...byGu].sort((a, b) => b[1] - a[1]).map(([g, count]) => ({ gu: g, count })),
    lines: [...near, ...gu].slice(0, MAX_LINES),
  };
}

function viewOf(r: store.NoticeFileRow, ctx: NearContext, titles: Map<number, string>): NoticeFileView {
  const lines = r.lines ? (JSON.parse(r.lines) as string[]) : [];
  return {
    id: r.id,
    name: r.name,
    noticeId: r.notice_id,
    noticeTitle: r.notice_id != null ? (titles.get(r.notice_id) ?? null) : null,
    downloadedAt: r.downloaded_at,
    status: r.status,
    error: r.error,
    lineCount: lines.length,
    ...analyze(lines, ctx),
  };
}

/** 읽은 첨부 파일(받은 시각 최근 순). 근처 줄은 지금 켜 둔 지역 기준이다. */
export function noticeFileViews(): NoticeFileView[] {
  const ctx = nearContext();
  const titles = new Map(store.noticeLinks().map((n) => [n.id, n.title]));
  return store.noticeFileRows().map((r) => viewOf(r, ctx, titles));
}

// ---------- 공고 맞추기 ----------

/** 공고 번호로 보는 주소 값 이름(LH panId, 마이홈 pblancId, SH seq 등) */
const ID_PARAM = /^(panId|pblancId|pbancNo|seq|boardSeq|bbsSeq|nttId|nttSn|articleNo|idx|no|id)$/i;

/** 주소에서 공고를 가리키는 값들('apply.lh.or.kr|panid=2015…', 끝 경로 숫자 'gobang.kr|path=21246'). blob: 주소는 안쪽 주소로 본다. */
function idKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const u = new URL(raw.replace(/^blob:/, ''));
    const host = u.hostname.replace(/^www\./, '');
    const keys = [...u.searchParams].filter(([k, v]) => ID_PARAM.test(k) && /\d{3,}/.test(v)).map(([k, v]) => `${host}|${k.toLowerCase()}=${v}`);
    const tail = /\/(\d{3,})\/?$/.exec(u.pathname);
    if (tail) keys.push(`${host}|path=${tail[1]}`);
    return keys;
  } catch {
    return [];
  }
}

/** 비교용 글자: 확장자, 띄어쓰기, 괄호와 문장부호를 빼고 '공고문'은 '공고'로 */
const squash = (s: string) =>
  s.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\s_\-[\]()（）【】·.,~'"「」『』<>]/g, '').replace(/공고문/g, '공고');

/** 두 글자의 두 글자씩 묶음이 얼마나 겹치는지(0~1, Dice 계수) */
function similarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) grams.set(a.slice(i, i + 2), (grams.get(a.slice(i, i + 2)) ?? 0) + 1);
  let common = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      common++;
      grams.set(g, n - 1);
    }
  }
  return (2 * common) / (a.length - 1 + b.length - 1);
}

/** 받은 화면이나 파일 주소의 공고 번호가 같은 공고, 없으면 파일 이름과 제목이 많이 겹치는(0.6 이상) 공고. 고방에 옮겨 온 공고보다 원래 곳 공고를 먼저. */
function findNotice(file: { pageUrl: string | null; url: string | null; name: string }): number | null {
  const notices = store.noticeLinks();
  const keys = new Set([...idKeys(file.pageUrl), ...idKeys(file.url)]);
  if (keys.size) {
    const hit = notices.find((n) => idKeys(n.url).some((k) => keys.has(k)));
    if (hit) return hit.id;
  }
  const target = squash(file.name);
  let best: { id: number; score: number } | null = null;
  for (const n of notices) {
    const score = similarity(target, squash(n.title)) - (n.source === 'gobang' ? 0.01 : 0);
    if (!best || score > best.score) best = { id: n.id, score };
  }
  return best && best.score >= 0.6 ? best.id : null;
}

// ---------- 받기 ----------

interface FileInput {
  path: string;
  url: string | null;
  pageUrl: string | null;
  at: string;
}

const queue: FileInput[] = [];
let draining = false;

const str = (v: unknown, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** 크롬 확장이 알린 파일을 받아 차례로 읽는다(읽을 형식이 아니거나 경로가 이상하면 버림). 받은 개수를 돌려준다. */
export function acceptNoticeFiles(input: unknown[]): number {
  let accepted = 0;
  for (const raw of input.slice(0, 20)) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const file = str(o.path, 1000);
    if (!file || !path.isAbsolute(file) || !KNOWN.has(extOf(file))) continue;
    const at = str(o.at, 40);
    queue.push({ path: file, url: str(o.url), pageUrl: str(o.pageUrl), at: at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : store.nowIso() });
    accepted++;
  }
  void drain();
  return accepted;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) await readOne(queue.shift()!);
  } catch (e) {
    console.warn('첨부 파일을 읽지 못했습니다:', e instanceof Error ? e.message : e);
  } finally {
    draining = false;
  }
}

async function readOne(f: FileInput) {
  const name = path.basename(f.path);
  let size = 0;
  let lines: string[] | null = null;
  let status: store.NoticeFileRow['status'] = 'ok';
  let error: string | null = null;
  try {
    const st = fs.statSync(f.path);
    if (!st.isFile()) throw new Error('파일이 아닙니다.');
    size = st.size;
    if (size > MAX_BYTES) throw new Unsupported(`파일이 너무 큽니다(${Math.round(size / 1e6)}MB).`);
    lines = await extractLines(new Uint8Array(fs.readFileSync(f.path)), extOf(name));
  } catch (e) {
    status = e instanceof Unsupported ? 'unsupported' : 'error';
    error = e instanceof Error ? e.message : String(e);
  }
  const id = store.saveNoticeFile({
    path: f.path,
    name,
    url: f.url,
    page_url: f.pageUrl,
    size,
    downloaded_at: f.at,
    read_at: store.nowIso(),
    notice_id: findNotice({ pageUrl: f.pageUrl, url: f.url, name }),
    status,
    error,
    lines,
  });
  const view = noticeFileViews().find((v) => v.id === id);
  if (view) announce(view);
}

/** 읽은 결과를 알린다(누르면 임대 공고 탭). 시험 DB(HNW_DATA_DIR)로 띄운 서버는 알리지 않는다. */
function announce(v: NoticeFileView) {
  if (process.env.HNW_DATA_DIR) return;
  const url = `${DASHBOARD_URL}/?tab=notices`;
  if (v.status !== 'ok') {
    notify('첨부를 못 읽음', `${v.name}\n${v.error ?? ''}`, url);
    return;
  }
  const title = v.nearCount ? `첨부 읽음: 근처 ${v.nearCount}건` : v.guCount ? `첨부 읽음: 근처 구 ${v.guCount}건` : '첨부 읽음: 근처 없음';
  const counts = new Map<string, number>();
  for (const l of v.lines) counts.set(l.match, (counts.get(l.match) ?? 0) + 1);
  const where = [...counts].slice(0, 5).map(([m, n]) => `${m} ${n}`).join(', ');
  notify(title, [v.noticeTitle ?? v.name, where].filter(Boolean).join('\n'), url);
}
