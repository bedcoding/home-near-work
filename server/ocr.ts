import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.js';

// 그림으로 된 PDF(스캔, 글자를 선으로 바꾼 것)의 글자를 윈도우 기본 기능으로 읽는다.
// ocr.ps1이 Windows.Data.Pdf로 쪽을 그림으로 그리고 Windows.Media.Ocr(한국어)로 낱말과 위치를 준다.
// 낱말을 줄로 묶고 칸 사이가 넓으면 ' | '로 잇는다(PDF 글자 줄과 같은 모양). 날짜와 금액의 흔한 인식 오류를 고친다.

const SCRIPT = path.join(ROOT, 'server', 'ocr.ps1');
const MAX_PAGES = 12;
const TIMEOUT_MS = 3 * 60 * 1000;

interface Word {
  s: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 날짜와 금액의 흔한 인식 오류를 고친다.
 * 날짜 숫자 사이에 끼어든 띄어쓰기('2026-03-1 2' → '2026-03-12'), 빠진 구분점('202603.09.' → '2026.03.09.', '2026.0320.' → '2026.03.20.'),
 * 금액 자리 구분이 점이나 띄어쓰기로 읽힌 것('123.400.000', '123, 400,000' → '123,400,000').
 */
export function fixOcrNumbers(text: string): string {
  return text
    .replace(/(20\d{2}\s*[-.]\s*)(\d)\s(\d)(?=\s*[-.])/g, '$1$2$3')
    .replace(/(20\d{2}\s*[-.]\s*\d{1,2}\s*[-.]\s*)(\d)\s(\d)(?!\d)/g, '$1$2$3')
    .replace(/\b(20\d{2})(\d{2})([.-])(\d{1,2})(?!\d)/g, '$1$3$2$3$4')
    .replace(/\b(20\d{2})([.-])(\d{2})(\d{2})(?!\d)/g, '$1$2$3$2$4')
    .replace(/(\d)\s*[.,]\s*(?=\d{3}(?!\d))/g, '$1,');
}

/** ocr.ps1 출력(쪽마다 낱말과 위치)을 줄로 묶는다. 세로 가운데가 낱말 높이의 절반 안이면 한 줄, 낱말 사이가 높이의 1.6배를 넘으면 ' | '. */
export function ocrLines(output: string): string[] {
  const pages: Word[][] = [];
  for (const raw of output.replace(/^﻿/, '').split(/\r?\n/)) {
    const f = raw.split('\t');
    if (f[0] === 'P') pages.push([]);
    else if (f[0] === 'W' && pages.length && f.length >= 6) pages[pages.length - 1].push({ s: f[1], x: +f[2], y: +f[3], w: +f[4], h: +f[5] });
  }
  const out: string[] = [];
  for (const words of pages) {
    words.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
    const lines: { cy: number; h: number; items: Word[] }[] = [];
    for (const w of words) {
      const cy = w.y + w.h / 2;
      const line = lines.find((l) => Math.abs(l.cy - cy) <= Math.max(6, Math.min(l.h, w.h) * 0.5));
      if (line) {
        line.items.push(w);
        line.cy += (cy - line.cy) / line.items.length;
        line.h = Math.max(line.h, w.h);
      } else lines.push({ cy, h: w.h, items: [w] });
    }
    lines.sort((a, b) => a.cy - b.cy);
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      let text = '';
      let end = -Infinity;
      for (const w of l.items) {
        const gap = w.x - end;
        if (text) text += gap > l.h * 1.6 ? ' | ' : gap > l.h * 0.25 ? ' ' : '';
        text += w.s;
        end = w.x + w.w;
      }
      out.push(fixOcrNumbers(text));
    }
  }
  return out;
}

/** PDF(data)의 글자를 인식해 줄로 준다(앞 MAX_PAGES쪽). 윈도우가 아니거나 한국어 인식기가 없으면 null. 실패하면 오류를 던진다. */
export async function ocrPdf(data: Uint8Array): Promise<string[] | null> {
  if (process.platform !== 'win32') return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-ocr-'));
  const file = path.join(dir, 'doc.pdf');
  fs.writeFileSync(file, data);
  try {
    const script = Buffer.from(fs.readFileSync(SCRIPT, 'utf8'), 'utf16le').toString('base64');
    const output = await new Promise<string>((resolve, reject) =>
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script],
        { env: { ...process.env, HNW_OCR_PDF: file, HNW_OCR_PAGES: String(MAX_PAGES) }, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => (err ? reject(new Error(`글자 인식 실패: ${(stderr || err.message).split('\n')[0].trim()}`)) : resolve(stdout)),
      ),
    );
    if (/^E\tno-ko/m.test(output)) return null;
    return ocrLines(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
