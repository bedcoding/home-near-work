import fs from 'node:fs';
import path from 'node:path';

/** 조회 기록 폴더(data/runs/<조회 번호>)를 남기는 날 수 */
export const RUN_FILES_KEEP_DAYS = 30;
/** 이 번호까지의 조회 폴더는 지웠다(설정). 그 조회의 스크린샷을 가리키는 '출처 보기'를 숨기는 데 쓴다. */
export const RUN_FILES_PURGED_KEY = 'run_files_purged_through';

export interface RunAge { id: number; status: string; startedAt: string; finishedAt: string | null }

/**
 * 지울 조회 폴더. 끝난 지(끝 시각이 없으면 시작한 지) keepDays일이 지난 조회만 고른다. 조회 중인 것과
 * 기록에 없는 폴더는 지우지 않는다(이름이 숫자가 아닌 폴더나 파일도 그대로 둔다).
 */
export function runFoldersToPurge(folders: string[], runs: RunAge[], now: number, keepDays = RUN_FILES_KEEP_DAYS): number[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const limit = now - keepDays * 86400000;
  return folders
    .filter((name) => /^[1-9]\d{0,9}$/.test(name))
    .map(Number)
    .filter((id) => {
      const run = byId.get(id);
      if (!run || run.status === 'running') return false;
      const at = Date.parse(run.finishedAt ?? run.startedAt);
      return Number.isFinite(at) && at < limit;
    })
    .sort((a, b) => a - b);
}

/** 지운 조회의 스크린샷인지(그 조회 번호가 지운 범위 안) */
export const screenshotPurged = (seenRef: { runId?: unknown } | null | undefined, purgedThrough: number) =>
  typeof seenRef?.runId === 'number' && seenRef.runId <= purgedThrough;

/**
 * 오래된 조회 폴더(스크린샷, 다방과 직방 응답 원본)를 지운다. 조회 기록(로그, 요약)은 DB에 그대로 남는다.
 * 지운 조회의 스크린샷 목록도 지우고, 지운 마지막 조회 번호를 기억한다. 지운 폴더 수와 크기(바이트)를 돌려준다.
 */
export function purgeOldRunFiles(deps: {
  runsDir: string;
  runs: () => RunAge[];
  forgetScreenshots: (runIds: number[]) => void;
  purgedThrough: () => number;
  setPurgedThrough: (id: number) => void;
  now?: number;
}): { removed: number; bytes: number } {
  let folders: string[];
  try { folders = fs.readdirSync(deps.runsDir); } catch { return { removed: 0, bytes: 0 }; }
  const ids = runFoldersToPurge(folders, deps.runs(), deps.now ?? Date.now());
  let removed = 0, bytes = 0;
  const done: number[] = [];
  for (const id of ids) {
    const dir = path.join(deps.runsDir, String(id));
    const size = folderSize(dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { continue; }
    removed++;
    bytes += size;
    done.push(id);
  }
  if (done.length) {
    deps.forgetScreenshots(done);
    const through = Math.max(deps.purgedThrough(), ...done);
    deps.setPurgedThrough(through);
  }
  return { removed, bytes };
}

function folderSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      total += entry.isDirectory() ? folderSize(full) : fs.statSync(full).size;
    }
  } catch { /* 못 읽는 파일은 세지 않는다 */ }
  return total;
}
