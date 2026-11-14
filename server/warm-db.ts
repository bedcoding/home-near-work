import fs from 'node:fs';
import os from 'node:os';

/**
 * DB 파일이 운영체제 캐시에 없으면(컴퓨터를 켠 뒤 대시보드를 처음 켤 때) 파일을 처음부터 끝까지 이어 읽어 캐시에 올린다.
 * 캐시에 없는 DB를 SQLite가 읽으면 매물 행과 원본을 하드디스크 여기저기서 조금씩 읽게 되어, 켜기 준비(매물 정리)와 매물 목록 만들기에
 * 1분 넘게 걸렸다(DB 962MB, 하드디스크). 같은 파일을 이어 읽으면 6초쯤이고, 그 뒤로는 메모리에서 읽어 몇 초 안에 끝난다.
 * 이미 캐시에 있으면 몇 군데만 조금 읽어 보고 바로 끝낸다(1ms 안팎).
 */

/** 이보다 작은 파일은 그냥 둔다(시험용 DB 등). */
const MIN_BYTES = 64 << 20;
/** 몇 군데를 읽어 볼지와 한 번에 읽는 크기 */
const SAMPLES = 16;
const SAMPLE_BYTES = 64 << 10;
/** 캐시에서 읽으면 몇십 마이크로초다. 한 번이라도 이보다 오래 걸리면 디스크에서 읽은 것으로 본다. */
const COLD_MS = 2;
const CHUNK_BYTES = 8 << 20;

export interface WarmResult {
  /** 이어 읽었는지(캐시에 없다고 봤는지) */
  read: boolean;
  /** 읽은 바이트 */
  bytes: number;
  ms: number;
}

/** 파일 몇 군데를 조금씩 읽어 보아 디스크에서 읽는 것 같으면 true */
function looksCold(fd: number, size: number, buf: Buffer, coldMs: number): boolean {
  for (let i = 0; i < SAMPLES; i++) {
    const at = Math.floor((Math.max(0, size - SAMPLE_BYTES) * i) / (SAMPLES - 1));
    const t = performance.now();
    fs.readSync(fd, buf, 0, SAMPLE_BYTES, at);
    if (performance.now() - t > coldMs) return true;
  }
  return false;
}

/**
 * files(DB와 그 WAL 파일)를 캐시에 없을 때만 이어 읽는다. 메모리에 비해 너무 큰 파일은 읽지 않는다(캐시에서 다른 것을 밀어내지 않게).
 * 읽지 못해도 서버는 그대로 켠다(느릴 뿐이다). minBytes와 coldMs는 시험에서 바꾼다.
 */
export function warmDbFiles(files: string[], options: { minBytes?: number; coldMs?: number } = {}): WarmResult {
  const { minBytes = MIN_BYTES, coldMs = COLD_MS } = options;
  const t0 = performance.now();
  let bytes = 0;
  let read = false;
  const sizes = files.map((file) => fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!sizes[0] || total < minBytes || total > os.totalmem() / 4) return { read, bytes, ms: 0 };
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  try {
    const main = fs.openSync(files[0], 'r');
    try {
      read = looksCold(main, sizes[0], buf, coldMs);
    } finally {
      fs.closeSync(main);
    }
    if (!read) return { read, bytes, ms: Math.round(performance.now() - t0) };
    for (const [i, file] of files.entries()) {
      if (!sizes[i]) continue;
      const fd = fs.openSync(file, 'r');
      try {
        for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) bytes += n;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // 못 읽는 파일은 건너뛴다.
  }
  return { read, bytes, ms: Math.round(performance.now() - t0) };
}
