// 대시보드 켜기(윈도우와 맥 공용). 프로젝트 맨 위의 '대시보드 켜기 - 윈도우.cmd'와 '대시보드 켜기 - 맥.command'가 부른다.
// 1) 이미 켜져 있으면 창만 연다.
// 2) 처음이거나 다른 컴퓨터(OS)에서 옮겨 온 폴더면 패키지를 새로 깐다(node_modules/.hnw-installed에 어느 컴퓨터용인지 적어 둔다).
// 3) 화면을 빌드하고 서버를 띄운 뒤 창을 연다. 이 창을 닫으면 대시보드가 꺼진다.
// 여는 창: 크롬 새 창 하나에 켜 둔 부동산 사이트(네이버가 첫 탭)와 맨 끝에 대시보드(site-window.mjs). 안 되면 대시보드만 기본 브라우저로.
// 창만 열고 조회는 하지 않는다. HNW_NO_OPEN=1이거나, data/.hnw-no-open 파일(5분 안에 만든 것, 읽으면 지움)이 있으면 아무 창도 열지 않는다.
// --check(윈도우 작업 스케줄러의 자동 확인이 붙임): 창은 열지 않고, 대시보드가 답하면 놓친 자동 확인을 돌리게 한다(POST /api/auto-check/missed).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSiteWindow } from './site-window.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = 'http://localhost:8787';
const isWin = process.platform === 'win32';
process.chdir(ROOT);

/** 다른 프로그램(open-sites.mjs)이 이번 한 번 창을 열지 말라고 남긴 표시. 읽으면 지운다. */
function noOpenOnce() {
  const marker = path.join('data', '.hnw-no-open');
  try {
    const at = Number(fs.readFileSync(marker, 'utf8'));
    fs.rmSync(marker, { force: true });
    return Date.now() - at < 5 * 60 * 1000;
  } catch {
    return false;
  }
}
const check = process.argv.includes('--check');
const openBrowser = !check && !process.env.HNW_NO_OPEN && !noOpenOnce();

const TITLE = '회사근처 내집마련 대시보드 - 이 창을 닫으면 꺼집니다';
if (isWin) process.title = TITLE;
else process.stdout.write(`\x1b]0;${TITLE}\x07`);

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

async function alreadyRunning() {
  try {
    const res = await fetch('http://127.0.0.1:8787/api/extension/version', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function openUrl(url) {
  const [cmd, args] = isWin ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

/** 크롬 새 창 하나에 켜 둔 부동산 사이트와 대시보드를 연다. 열 수 없으면 대시보드만 기본 브라우저로 연다. */
async function openWindow() {
  try {
    const { area, sites } = await openSiteWindow({ withDashboard: true });
    console.log(sites.length ? `${area} 기준으로 ${[...sites, '대시보드'].join(', ')}를 열었습니다.` : '켜진 지역이 없어 대시보드만 열었습니다.');
  } catch (error) {
    console.log(`사이트 창을 열지 못해 대시보드만 엽니다: ${error instanceof Error ? error.message : error}`);
    openUrl(DASHBOARD);
  }
}

const MISSED_TEXT = {
  started: '놓친 자동 확인을 시작했습니다.',
  done: '이번 자동 확인은 이미 했습니다.',
  skipped: '확인 시각 무렵에 이미 조회했거나 다른 조회가 돌고 있어 건너뜁니다.',
  off: '자동 확인이 꺼져 있습니다.',
};

/** 가장 최근 자동 확인 시각의 확인을 아직 안 했으면 대시보드가 지금 돌린다. */
async function runMissedCheck() {
  try {
    const res = await fetch('http://127.0.0.1:8787/api/auto-check/missed', { method: 'POST', signal: AbortSignal.timeout(10000) });
    const { result } = await res.json();
    console.log(MISSED_TEXT[result] ?? `자동 확인: ${result}`);
  } catch (error) {
    console.log(`자동 확인을 부르지 못했습니다: ${error instanceof Error ? error.message : error}`);
  }
}

const STAMP = path.join('node_modules', '.hnw-installed');
const HERE = `${process.platform}-${process.arch}-node${process.versions.modules}`;

/** 이 컴퓨터에 맞게 깔린 패키지인지. 표시가 없으면 DB 모듈(컴퓨터마다 다르게 깔림)이 도는지 보고 정한다. */
function installedHere() {
  if (!fs.existsSync('node_modules')) return false;
  if (fs.existsSync(STAMP)) return fs.readFileSync(STAMP, 'utf8').trim() === HERE;
  return spawnSync(process.execPath, ['-e', "require('better-sqlite3')(':memory:').close()"], { stdio: 'ignore' }).status === 0;
}

function npm(args) {
  // 윈도우의 npm은 .cmd라 셸을 거쳐야 한다.
  return spawnSync(isWin ? 'npm.cmd' : 'npm', args, { stdio: 'inherit', shell: isWin }).status === 0;
}

/** 맥: 처음 한 번 '대시보드 켜기 - 맥.command' 파일에 집 아이콘을 입힌다. 안 되면 그냥 둔다. */
function setMacIcon() {
  if (process.platform !== 'darwin') return;
  const done = path.join('node_modules', '.hnw-mac-icon');
  const file = path.join(ROOT, '대시보드 켜기 - 맥.command');
  if (fs.existsSync(done) || !fs.existsSync(file)) return;
  const png = path.join(ROOT, 'launcher', 'icon.png');
  const script = `ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.setIconForFileOptions($.NSImage.alloc.initWithContentsOfFile(${JSON.stringify(png)}), ${JSON.stringify(file)}, 0);`;
  if (spawnSync('osascript', ['-l', 'JavaScript', '-e', script], { stdio: 'ignore' }).status === 0) fs.writeFileSync(done, '');
}

if (await alreadyRunning()) {
  if (check) await runMissedCheck();
  else {
    console.log('대시보드가 이미 켜져 있어 창을 엽니다.');
    if (openBrowser) await openWindow();
  }
  setTimeout(() => process.exit(0), 1500);
} else {
  if (!installedHere()) {
    console.log('처음이라(또는 다른 컴퓨터에서 옮겨 온 폴더라) 필요한 패키지를 까는 중입니다. 몇 분 걸릴 수 있습니다…');
    if (!npm(['ci']) && !npm(['install'])) fail('패키지를 깔지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.');
  }
  fs.writeFileSync(STAMP, HERE);
  setMacIcon();

  console.log('화면을 준비하는 중…');
  const build = spawnSync(process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { stdio: 'inherit' });
  if (build.status !== 0) fail('화면을 만들지 못했습니다. 위 내용을 확인해 주세요.');

  console.log(`\n대시보드를 켭니다: ${DASHBOARD}`);
  console.log('이 창을 닫으면 대시보드가 꺼집니다. 크롬 확장이 보내는 데이터를 받으려면 켜 두세요.\n');
  const server = spawn(process.execPath, [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), path.join('server', 'index.ts')], { stdio: 'inherit' });
  server.on('exit', (code) => process.exit(code ?? 0));
  // 서버가 답하면 창을 열거나(--check면) 놓친 자동 확인을 부른다.
  if (openBrowser || check) {
    for (let i = 0; i < 120 && !(await alreadyRunning()); i++) await new Promise((r) => setTimeout(r, 500));
    if (check) await runMissedCheck();
    else await openWindow();
  }
}
