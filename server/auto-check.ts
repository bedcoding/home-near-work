import { spawn } from 'node:child_process';
import path from 'node:path';
import * as store from './db.js';
import { DATA_DIR, ROOT } from './config.js';
import { isRunning, startRun } from './runner.js';
import { CAPTURE_SOURCES, type AutoCheckState } from '../shared/types.js';

// 정해진 때에 알아서 조회한다. 두 가지가 있다.
// - 자동 확인(full): 정한 요일(또는 매일)과 시각에 '조회하기'와 같은 조회(모든 사이트와 공고).
// - 공고 확인(notices): 매일 정한 시각에 공고만 창 없이 모은다(startRun noticesOnly).
// 그 시각에 서버가 켜져 있으면 서버가 돌린다. 서버가 그 시각 뒤에 켜졌으면 여기서는 돌리지 않는다(바탕 화면 아이콘으로 켜기만 해서는 조회하지 않음).
// 윈도우에서는 작업 스케줄러에 같은 시각들을 걸어 두어(syncWindowsTask), 그 시각에 또는 놓쳤으면 다음에 컴퓨터를 켤 때
// 대시보드를 창 없이 켜고 놓친 확인을 돌리게 한다(runMissedCheck, 자동 확인이 먼저).
// 설정: auto_check_time('HH:MM' 또는 'off', 없으면 22:30), auto_check_day('0'~'6' 요일, 없거나 'daily'면 매일),
// auto_check_visible('0'이면 창 없이), auto_check_last_day(마지막으로 처리한 확인 시각의 날짜),
// notice_check_time('HH:MM', 없거나 'off'면 끔), notice_check_last_day.

const DEFAULT_TIME = '22:30';
/** 확인 시각 전 이 시간 안이나 그 뒤에 이미 조회했으면 그 확인은 건너뛴다. */
const RECENT_RUN_MS = 2 * 60 * 60 * 1000;
const serverStartedAt = Date.now();
/** 작업 스케줄러 작업 이름 */
const TASK_NAME = '회사근처 내집마련 자동 확인';
const TASK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** runMissedCheck 결과: 시작함, 이미 함, 건너뜀(다른 조회 중이거나 그 무렵 조회함), 꺼 둠 */
export type MissedCheckResult = 'started' | 'done' | 'skipped' | 'off';
type Kind = 'full' | 'notices';
const KINDS: Kind[] = ['full', 'notices'];
const LAST_DAY: Record<Kind, string> = { full: 'auto_check_last_day', notices: 'notice_check_last_day' };
const KIND_NAME: Record<Kind, string> = { full: '자동 확인', notices: '공고 확인' };

const isTime = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isDay = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6;

/** 자동 확인 시각 'HH:MM'. 꺼 두었으면 null. */
export function autoCheckTime(): string | null {
  const v = store.getSetting('auto_check_time');
  if (v === 'off') return null;
  return isTime(v) ? v : DEFAULT_TIME;
}

/** 자동 확인 요일(0 일요일 ~ 6 토요일). 매일이면 null. */
export function autoCheckDay(): number | null {
  const v = store.getSetting('auto_check_day');
  return v !== null && /^[0-6]$/.test(v) ? Number(v) : null;
}

/** 공고 확인 시각 'HH:MM'(매일). 꺼 두었으면 null. */
export function noticeCheckTime(): string | null {
  const v = store.getSetting('notice_check_time');
  return isTime(v) ? v : null;
}

const autoVisible = () => store.getSetting('auto_check_visible') !== '0';

/** 이 컴퓨터 시각 기준 날짜 YYYY-MM-DD */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** now와 같거나 그 전인 가장 최근 확인 시각(day가 null이면 매일). time이 null이면 null. */
function latestSlot(now: Date, time: string | null, day: number | null): Date | null {
  if (!time) return null;
  const [h, m] = time.split(':').map(Number);
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  if (slot.getTime() > now.getTime()) slot.setDate(slot.getDate() - 1);
  if (day !== null) slot.setDate(slot.getDate() - ((slot.getDay() - day + 7) % 7));
  return slot;
}

const slotOf = (kind: Kind, now: Date) =>
  kind === 'full' ? latestSlot(now, autoCheckTime(), autoCheckDay()) : latestSlot(now, noticeCheckTime(), null);

/** since(ms) 뒤에 시작한 조회 중 매물 사이트를 모두 돈 것이 있는지(경매만 조회, 탭 하나만 조회, 공고만 확인, 크롬 확장 기록은 뺀다). */
function siteRunSince(since: number): boolean {
  return store
    .listRuns(20)
    .some(
      (r) =>
        Date.parse(r.startedAt) >= since &&
        !r.scope &&
        (r.summary?.sources ?? []).some((s) => s.source !== 'courtauction' && s.source !== 'onbid' && !CAPTURE_SOURCES.includes(s.source)),
    );
}

/** since(ms) 뒤에 시작한 조회 중 공고를 모두 모은 것(공고만 확인, 또는 매물 사이트를 돈 조회)이 있는지. */
function noticeRunSince(since: number): boolean {
  return siteRunSince(since) || store.listRuns(20).some((r) => r.noticesOnly && Date.parse(r.startedAt) >= since);
}

/**
 * 확인 시각 slot의 확인을 한 번만 돌린다. 자동 확인은 매일이면 새 소식이 있을 때만, 요일을 정했으면 새 소식이 없어도 결과 알림을 띄운다.
 * 공고 확인은 창 없이 공고만 모은다(알림은 runner의 noticesOnly 규칙).
 */
function runSlot(kind: Kind, slot: Date): MissedCheckResult {
  const day = localDay(slot);
  if (store.getSetting(LAST_DAY[kind]) === day) return 'done';
  store.setSetting(LAST_DAY[kind], day);
  if (isRunning()) {
    console.log(`${KIND_NAME[kind]}: 다른 조회가 돌고 있어 이번에는 건너뜁니다.`);
    return 'skipped';
  }
  const since = slot.getTime() - RECENT_RUN_MS;
  if (kind === 'full' ? siteRunSince(since) : noticeRunSince(since)) {
    console.log(`${KIND_NAME[kind]}: 확인 시각 무렵에 이미 조회해서 이번에는 건너뜁니다.`);
    return 'skipped';
  }
  try {
    if (kind === 'full') startRun(autoVisible(), undefined, { auto: true, quiet: autoCheckDay() === null });
    else startRun(false, undefined, { auto: true, noticesOnly: true });
    return 'started';
  } catch (e) {
    console.warn(`${KIND_NAME[kind]}을 시작하지 못했습니다:`, e instanceof Error ? e.message : e);
    return 'skipped';
  }
}

/** 자동 확인과 공고 확인 중 할 차례인 것을 하나 돌린다(자동 확인이 먼저). started: 그 시각 전에 서버가 켜져 있었던 것만 본다. */
function runDue(now: Date, startedBeforeOnly: boolean): MissedCheckResult {
  const results: MissedCheckResult[] = [];
  for (const kind of KINDS) {
    const slot = slotOf(kind, now);
    if (!slot || (startedBeforeOnly && serverStartedAt > slot.getTime())) continue;
    const r = runSlot(kind, slot);
    if (r === 'started') return r;
    results.push(r);
  }
  return results.includes('skipped') ? 'skipped' : results.includes('done') ? 'done' : 'off';
}

/** 30초마다 시각을 본다. */
export function startAutoCheck() {
  const tick = () => runDue(new Date(), true);
  setInterval(tick, 30_000);
  tick();
}

/** 가장 최근 확인 시각의 확인을 아직 하지 않았으면 지금 돌린다(자동 확인이 먼저, 그다음 공고 확인). 작업 스케줄러가 대시보드를 켜며 부른다. */
export function runMissedCheck(): MissedCheckResult {
  return runDue(new Date(), false);
}

export function autoCheckState(): AutoCheckState {
  const slot = slotOf('full', new Date());
  const missed = !!slot && store.getSetting(LAST_DAY.full) !== localDay(slot) && !siteRunSince(slot.getTime());
  return { time: autoCheckTime(), day: autoCheckDay(), visible: autoVisible(), noticeTime: noticeCheckTime(), missed };
}

/**
 * 자동 확인 시각(null이면 끄기)과 요일(null이면 매일), 창 표시, 공고 확인 시각(noticeTime, null이면 끄기)을 바꾼다.
 * 시각이나 요일을 바꾸면 이미 지난 확인 시각은 돌리지 않고 다음 시각부터 돌며, 윈도우 작업 스케줄러 작업도 맞춘다.
 */
export async function setAutoCheck(input: { time?: unknown; day?: unknown; visible?: unknown; noticeTime?: unknown }) {
  if (input.time !== undefined && input.time !== null && !isTime(input.time)) throw new Error('시각은 HH:MM 형식이어야 합니다.');
  if (input.day !== undefined && input.day !== null && !isDay(input.day)) throw new Error('요일은 0(일요일)부터 6(토요일)까지입니다.');
  if (input.noticeTime !== undefined && input.noticeTime !== null && !isTime(input.noticeTime)) throw new Error('공고 확인 시각은 HH:MM 형식이어야 합니다.');
  const fullChanged = input.time !== undefined || input.day !== undefined;
  const noticeChanged = input.noticeTime !== undefined;
  if (input.time !== undefined) store.setSetting('auto_check_time', input.time ?? 'off');
  if (input.day !== undefined) store.setSetting('auto_check_day', input.day === null ? 'daily' : String(input.day));
  if (input.noticeTime !== undefined) store.setSetting('notice_check_time', input.noticeTime ?? 'off');
  if (typeof input.visible === 'boolean') store.setSetting('auto_check_visible', input.visible ? '1' : '0');
  if (!fullChanged && !noticeChanged) return;
  const now = new Date();
  for (const kind of KINDS) {
    if (kind === 'full' ? !fullChanged : !noticeChanged) continue;
    const slot = slotOf(kind, now);
    if (slot) store.setSetting(LAST_DAY[kind], localDay(slot));
  }
  await syncWindowsTask();
}

/** PowerShell 스크립트를 창 없이 돌린다. 실패하면 PowerShell 오류 글자로 거부한다. */
function powershell(script: string): Promise<void> {
  const wrapped = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `try {\n${script}\n} catch { [Console]::Out.Write($_.Exception.Message); exit 1 }`,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')],
      { windowsHide: true },
    );
    let out = '';
    ps.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    ps.on('error', reject);
    ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(out.trim() || `PowerShell 종료 코드 ${code}`))));
  });
}

/**
 * 윈도우 작업 스케줄러에 자동 확인(요일과 시각)과 공고 확인(매일 시각)을 한 작업의 트리거로 건다(둘 다 끄면 작업을 지운다).
 * 그 시각에 컴퓨터가 꺼져 있었으면 다음에 켤 때 돈다. 무엇을 돌릴지는 서버가 정한다(runMissedCheck).
 * 작업은 data/auto-check.lnk(최소화로 실행)를 탐색기로 열고, 그 바로 가기가 '대시보드 켜기 - 윈도우.cmd --check'를 부른다.
 * 윈도우가 아니거나 HNW_DATA_DIR로 다른 데이터 폴더를 쓰면 하지 않는다.
 */
export async function syncWindowsTask(): Promise<void> {
  if (process.platform !== 'win32' || process.env.HNW_DATA_DIR) return;
  const time = autoCheckTime();
  const day = autoCheckDay();
  const noticeTime = noticeCheckTime();
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const link = path.join(DATA_DIR, 'auto-check.lnk');
  const triggers = [
    ...(time ? [`New-ScheduledTaskTrigger ${day === null ? '-Daily' : `-Weekly -DaysOfWeek ${TASK_DAYS[day]}`} -At ${q(time)}`] : []),
    ...(noticeTime ? [`New-ScheduledTaskTrigger -Daily -At ${q(noticeTime)}`] : []),
  ];
  const script = !triggers.length
    ? `Unregister-ScheduledTask -TaskName ${q(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`
    : [
        '$shell = New-Object -ComObject WScript.Shell',
        `$link = $shell.CreateShortcut(${q(link)})`,
        '$link.TargetPath = $env:ComSpec',
        `$link.Arguments = ${q(`/c ""${path.join(ROOT, '대시보드 켜기 - 윈도우.cmd')}" --check"`)}`,
        `$link.WorkingDirectory = ${q(ROOT)}`,
        '$link.WindowStyle = 7',
        `$link.IconLocation = ${q(path.join(ROOT, 'launcher', 'icon.ico'))}`,
        '$link.Save()',
        `$action = New-ScheduledTaskAction -Execute 'explorer.exe' -Argument ${q(`"${link}"`)}`,
        `$triggers = @(${triggers.map((t) => `(${t})`).join(', ')})`,
        '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
        `Register-ScheduledTask -TaskName ${q(TASK_NAME)} -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null`,
      ].join('\n');
  try {
    await powershell(script);
  } catch (e) {
    throw new Error(`윈도우 작업 스케줄러에 걸지 못했습니다: ${e instanceof Error ? e.message : e}`);
  }
}
