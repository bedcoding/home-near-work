// 크롬 확장이 받는 부동산 사이트를 크롬 새 창 하나에 한꺼번에 연다(대시보드 탭 없이, site-window.mjs).
// 지역: 인자로 준 이름의 켜진 지역, 없으면 대시보드에서 켜 둔 첫 지역.
// 대시보드가 꺼져 있으면 바탕 화면 아이콘과 같은 방법으로 먼저 켠다(그때 아이콘이 여는 창은 열지 않음). 확장이 받은 응답은 대시보드로 가야 남는다.
// 사용: node launcher/open-sites.mjs [지역 이름] [--dry-run]  (--dry-run: 열 주소만 적고 크롬은 열지 않음)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSiteWindow } from './site-window.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://127.0.0.1:8787';
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function dashboardUp() {
  try {
    const res = await fetch(`${API}/api/extension/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 바탕 화면의 대시보드 바로 가기(.lnk, 최소화로 실행). 없으면 null. */
function desktopShortcut() {
  const name = '회사근처 내집마련 대시보드.lnk';
  const dirs = [path.join(os.homedir(), 'Desktop')];
  if (process.env.OneDrive) dirs.push(path.join(process.env.OneDrive, 'Desktop'), path.join(process.env.OneDrive, '바탕 화면'));
  return dirs.map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) ?? null;
}

/**
 * 대시보드를 바탕 화면 아이콘을 두 번 누른 것과 같이 켜고(탐색기·Finder가 띄워서 이 명령을 실행한 창이나 프로그램을 닫아도 꺼지지 않음)
 * 답할 때까지 기다린다. 최대 3분. 이번 한 번은 아이콘이 여는 창(사이트와 대시보드)을 열지 않는다(start.mjs가 읽고 지우는 표시 파일).
 */
async function startDashboard() {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', '.hnw-no-open'), String(Date.now()));
  if (isWin) {
    spawn('explorer.exe', [desktopShortcut() ?? path.join(ROOT, '대시보드 켜기 - 윈도우.cmd')], { detached: true, stdio: 'ignore' }).unref();
  } else if (isMac) {
    spawn('open', [path.join(ROOT, '대시보드 켜기 - 맥.command')], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(process.execPath, [path.join(ROOT, 'launcher', 'start.mjs')], { detached: true, stdio: 'ignore' }).unref();
  }
  for (let i = 0; i < 360; i++) {
    if (await dashboardUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail('대시보드가 3분 안에 켜지지 않았습니다. 바탕 화면 아이콘으로 켠 뒤 다시 실행해 주세요.');
}

if (!(await dashboardUp())) {
  console.log('대시보드를 켜는 중…');
  await startDashboard();
}
const dryRun = process.argv.includes('--dry-run');
const wanted = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? null;
try {
  const { area, sites } = await openSiteWindow({ wanted, dryRun });
  if (!dryRun) console.log(`${area} 기준으로 ${sites.length}곳을 열었습니다: ${sites.join(', ')}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
