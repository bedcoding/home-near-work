// 크롬 확장이 받는 부동산 사이트(확장에서 기본으로 켜 둔 곳: 네이버, 다방, 직방, KB부동산, 호갱노노, 당근부동산)를
// 크롬 새 창 하나에 여는 공용 함수. 주소는 확장의 sites.js(hnwSiteLinks)로 만든다.
// 창은 이 확장이 깔린 크롬 프로필로 연다(크롬은 따로 정하지 않으면 마지막으로 쓴 프로필로 연다).
// start.mjs(바탕 화면 아이콘)는 같은 창 맨 끝에 대시보드 탭을 붙여 열고, open-sites.mjs는 사이트만 연다.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://127.0.0.1:8787';
const DASHBOARD = 'http://localhost:8787';
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/** 크롬이 켜져 있는지. 알 수 없으면 false. */
function chromeRunning() {
  if (isWin) return (spawnSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8' }).stdout ?? '').toLowerCase().includes('chrome.exe');
  if (isMac) return spawnSync('pgrep', ['-x', 'Google Chrome']).status === 0;
  return false;
}

/**
 * 크롬 확장이 대시보드에 둔 버전과 다르면(새 버전으로 다시 불러오는 중) 같아질 때까지 기다린다(최대 2분 30초).
 * 다시 불러오기 전에 연 탭은 기록이 끊기기 때문이다. 크롬이 꺼져 있으면(켤 때 새 버전으로 뜸) 기다리지 않고,
 * 확장이 한 번도 버전을 알린 적이 없으면 서버가 켜진 지 70초가 지날 때까지만 기다린다.
 */
async function waitForExtension() {
  if (!chromeRunning()) return;
  const started = Date.now();
  let told = false;
  for (;;) {
    const st = await fetch(`${API}/api/extension/status`).then((r) => r.json()).catch(() => null);
    if (!st || typeof st.current !== 'string') return;
    const r = st.reported;
    if (r && r.version === st.current) return;
    const waited = Date.now() - started;
    if ((!r && (st.uptime > 70 || waited > 70_000)) || waited > 150_000) return;
    if (!told) {
      console.log('크롬 확장이 새 버전으로 바뀌는 중이라 잠깐 기다립니다(길면 1~2분).');
      told = true;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** 크롬 실행 파일. 없으면 null. */
function chromePath() {
  if (isWin) {
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return bases.map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((p) => fs.existsSync(p)) ?? null;
  }
  if (isMac) return fs.existsSync('/Applications/Google Chrome.app') ? 'Google Chrome' : null;
  return null;
}

/** 크롬 사용자 데이터 폴더(프로필 폴더들이 있는 곳). 모르면 null. */
function chromeUserData() {
  if (isWin) return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : null;
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return null;
}

/**
 * 이 프로젝트의 extension 폴더를 '압축해제된 확장'으로 올려 켜 둔 크롬 프로필 폴더 이름(예: 'Default').
 * 프로필마다 Secure Preferences와 Preferences의 extensions.settings[*].path를 본다. 여럿이면 마지막으로 쓴 프로필이 먼저다. 못 찾으면 null.
 */
function extensionProfile() {
  const dataDir = chromeUserData();
  if (!dataDir || !fs.existsSync(dataDir)) return null;
  const want = path.join(ROOT, 'extension').toLowerCase();
  const on = (s) => typeof s?.path === 'string' && path.resolve(s.path).toLowerCase() === want && !(Array.isArray(s.disable_reasons) ? s.disable_reasons.length : s.disable_reasons);
  const found = fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) =>
      ['Secure Preferences', 'Preferences'].some((file) => {
        try {
          return Object.values(JSON.parse(fs.readFileSync(path.join(dataDir, name, file), 'utf8')).extensions?.settings ?? {}).some(on);
        } catch {
          return false;
        }
      }),
    );
  if (found.length <= 1) return found[0] ?? null;
  try {
    const last = JSON.parse(fs.readFileSync(path.join(dataDir, 'Local State'), 'utf8')).profile?.last_used;
    if (found.includes(last)) return last;
  } catch {}
  return found[0];
}

/** 확장의 sites.js, areas.js를 읽어 { links: hnwSiteLinks, sites: HNW_SITES }를 꺼낸다. */
function extensionSites() {
  const ctx = vm.createContext({});
  for (const file of ['areas.js', 'sites.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension', file), 'utf8'), ctx, { filename: file });
  return vm.runInContext('({ links: hnwSiteLinks, sites: HNW_SITES })', ctx);
}

/**
 * 켜 둔 부동산 사이트를 크롬 새 창 하나에 연다(네이버가 첫 탭). 대시보드(8787)가 켜져 있어야 한다.
 * withDashboard: 대시보드 탭을 맨 끝에 붙인다. 켜진 지역이 없으면 대시보드만 연다.
 * wanted: 이 이름의 켜진 지역으로 연다(없으면 켜 둔 첫 지역). dryRun: 열 주소만 적고 열지 않는다.
 * 크롬이 없으면 기본 브라우저로 연다. 열 수 없으면(지역이 없는 등) 오류를 던진다.
 * 돌려주는 값: { area: 연 지역 이름(없으면 null), sites: 연 사이트 이름 목록 }
 */
export async function openSiteWindow({ withDashboard = false, wanted = null, dryRun = false } = {}) {
  if (!dryRun) await waitForExtension();
  const state = await fetch(`${API}/api/state`).then((r) => r.json());
  const areas = state.areas.filter((a) => a.enabled);
  const area = wanted ? areas.find((a) => a.name === wanted || a.name === `${wanted}역`) : areas[0];
  if (!area && (wanted || !withDashboard)) {
    throw new Error(wanted ? `켜진 지역 중에 '${wanted}'이(가) 없습니다: ${areas.map((a) => a.name).join(', ')}` : '켜진 지역이 없습니다. 대시보드 지역 탭에서 하나 이상 켜 주세요.');
  }
  let open = [];
  if (area) {
    const { links, sites } = extensionSites();
    const on = new Set(sites.filter((s) => s.defaultOn).map((s) => s.id));
    open = links(area, state.stations).filter((l) => on.has(l.id) && l.url);
  }
  const urls = [...open.map((l) => l.url), ...(withDashboard ? [DASHBOARD] : [])];

  const chrome = chromePath();
  const profile = chrome ? extensionProfile() : null;
  const chromeArgs = [...(profile ? [`--profile-directory=${profile}`] : []), '--new-window', ...urls];
  if (dryRun) {
    console.log(`크롬: ${chrome ?? '못 찾음'}`);
    console.log(`크롬 프로필: ${profile ?? '확장이 깔린 프로필을 못 찾음(마지막으로 쓴 프로필로 열림)'}`);
    for (const l of open) console.log(`${l.name}: ${l.url}`);
    if (withDashboard) console.log(`대시보드: ${DASHBOARD}`);
  } else if (chrome && isWin) {
    spawn(chrome, chromeArgs, { detached: true, stdio: 'ignore' }).unref();
  } else if (chrome && isMac) {
    spawn('open', ['-na', chrome, '--args', ...chromeArgs], { detached: true, stdio: 'ignore' }).unref();
  } else {
    console.log('크롬을 찾지 못해 기본 브라우저로 엽니다. 크롬 확장은 크롬에서만 데이터를 받습니다.');
    for (const url of urls) {
      const [cmd, args] = isWin ? ['cmd', ['/c', 'start', '', url]] : isMac ? ['open', [url]] : ['xdg-open', [url]];
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    }
  }
  return { area: area ? area.name : null, sites: open.map((l) => l.name) };
}
