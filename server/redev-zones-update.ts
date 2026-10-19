import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Download, type Page } from 'playwright';
import * as store from './db.js';
import { importRedevZones, redevZones } from './redev-zones.js';
import type { RedevZonesCheck, RedevZonesView } from '../shared/types.js';

// 정비구역 지도 파일(서울 열린데이터광장 OA-22712 '서울시 도시계획사업 현황(서울플랜+) 공간정보')의 새 판을 받아 바꾼다.
// - 데이터셋 화면을 브라우저로 열고, 화면이 따로 불러오는 파일 목록의 downloadFile('N') 중 N이 가장 큰 것(최신판)을 받는다.
//   지금 넣어 둔 파일이 그 번호면 받지 않는다(사용자가 직접 넣은 파일은 번호를 몰라 한 번 받는다).
// - 파일 주소를 직접 요청하면 '잘못된 접근입니다'만 와서, 화면을 열어 downloadFile('N')을 불러 받는다.
// - 조회할 때(전부 도는 조회, 공고 확인, 경매 범위) 마지막 확인에서 7일이 지났으면 조회용 브라우저로 보고(실패했으면 하루 뒤),
//   지도 아래 '새 파일 확인'은 따로 창 없는 크롬을 띄워 바로 본다.

export const ZONES_SOURCE = '서울 도시계획사업(서울플랜+)';
const BASE = process.env.HNW_SEOUL_DATA_BASE ?? 'https://data.seoul.go.kr';
/** 데이터셋 화면(파일 목록이 여기서 뜬다) */
export const ZONES_PAGE = `${BASE}/dataList/OA-22712/F/1/datasetView.do`;
const CHECK_KEY = 'redev_zones_check';
const EVERY_MS = 7 * 86400000;
const RETRY_MS = 86400000;

type RecordRequest = (url: string, status: number | null, note: string) => void;

/** 새 판 확인의 마지막 결과 */
export const zoneFileCheckState = (): RedevZonesCheck | null => JSON.parse(store.getSetting(CHECK_KEY) ?? 'null') as RedevZonesCheck | null;

/** 마지막 확인에서 7일(실패했으면 하루)이 지났는지 */
export function zoneUpdateDue(): boolean {
  const last = zoneFileCheckState();
  return !last || Date.now() - Date.parse(last.at) >= (last.ok ? EVERY_MS : RETRY_MS);
}

function saveCheck(ok: boolean, text: string) {
  store.setSetting(CHECK_KEY, JSON.stringify({ at: new Date().toISOString(), ok, text } satisfies RedevZonesCheck));
}

const dot = (date: string | null) => (date ? `, ${date.replace(/-/g, '.')}` : '');

/** 파일 목록의 내려받기 링크: 화면 순서, 번호, 이름, 같은 줄의 날짜(YYYY-MM-DD) */
async function listFiles(page: Page) {
  return page.$$eval('a[href*="downloadFile"]', (links) =>
    links.map((a, index) => {
      const m = /downloadFile\(\s*['"]?(\d+)/.exec(a.getAttribute('href') ?? '');
      const row = a.closest('tr, li') ?? a.parentElement;
      const d = /(\d{4})[.-](\d{1,2})[.-](\d{1,2})/.exec(row?.textContent ?? '');
      return {
        index,
        seq: m ? Number(m[1]) : 0,
        name: (a.getAttribute('title') || a.textContent || '').trim(),
        date: d ? `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}` : null,
      };
    }),
  );
}

/** 링크 하나를 눌러(화면의 downloadFile을 불러) 받은 파일. 그 화면이나 새로 뜬 창의 내려받기를 기다린다. */
function downloadOf(context: BrowserContext, page: Page, seq: number, index: number): Promise<Download> {
  return new Promise<Download>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('내려받기가 2분 안에 시작되지 않았습니다')), 120000);
    const done = (d: Download) => {
      clearTimeout(timer);
      resolve(d);
    };
    page.once('download', done);
    context.once('page', (p) => p.once('download', done));
    page
      .evaluate((n) => {
        const f = (window as unknown as { downloadFile?: (n: string) => void }).downloadFile;
        if (typeof f !== 'function') throw new Error('downloadFile 없음');
        f(n);
      }, String(seq))
      // 화면에 그 함수가 없을 때만 링크를 누른다(받는 사이 화면이 바뀌어 끊긴 것은 이미 누른 것으로 본다).
      .catch((e: unknown) => (String(e).includes('downloadFile 없음') ? page.locator('a[href*="downloadFile"]').nth(index).click({ timeout: 10000 }) : undefined))
      .catch((e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });
}

/**
 * 브라우저(context)로 최신판을 보고, 넣어 둔 파일보다 새것이면 받아 바꾼다. 결과 글과 새 구역(바꿨을 때만)을 돌려준다.
 * 실패하면 오류를 던지고 마지막 결과에 남긴다.
 */
export async function updateZonesWith(context: BrowserContext, record: RecordRequest = () => {}): Promise<{ text: string; view: RedevZonesView | null }> {
  const page = await context.newPage();
  try {
    const res = await page.goto(ZONES_PAGE, { waitUntil: 'domcontentloaded', timeout: 45000 });
    record(ZONES_PAGE, res?.status() ?? null, '데이터셋 화면');
    // 파일 목록은 화면이 따로 불러온다. 내려받기 링크가 붙을 때까지 기다린다.
    const found = await page.waitForSelector('a[href*="downloadFile"]', { state: 'attached', timeout: 30000 }).catch(() => null);
    if (!found) throw new Error('파일 목록에서 내려받기 링크를 찾지 못했습니다(화면 구조가 바뀌었을 수 있음)');
    const latest = (await listFiles(page)).filter((f) => f.seq > 0).sort((a, b) => b.seq - a.seq)[0];
    if (!latest) throw new Error('파일 목록의 내려받기 링크에서 파일 번호를 읽지 못했습니다');
    const current = redevZones();
    if (current.count && current.seq === latest.seq) {
      const text = `새 파일 없음(${latest.seq}번 파일${dot(latest.date)})`;
      saveCheck(true, text);
      return { text, view: null };
    }
    const download = await downloadOf(context, page, latest.seq, latest.index);
    const failure = await download.failure();
    if (failure) throw new Error(`내려받기 실패: ${failure}`);
    const bytes = new Uint8Array(fs.readFileSync(await download.path()));
    record(download.url(), null, `${latest.seq}번 파일 ${(bytes.length / 1e6).toFixed(1)}MB`);
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`받은 파일이 ZIP이 아닙니다(${bytes.length.toLocaleString('ko-KR')}바이트)`);
    const view = importRedevZones(bytes, download.suggestedFilename() || latest.name || null, { seq: latest.seq, date: latest.date });
    const text = `${current.count ? '새 파일로 바꿈' : '파일 받음'}(${latest.seq}번 파일${dot(latest.date)}, 정비구역 ${view.count.toLocaleString('ko-KR')}곳)`;
    saveCheck(true, text);
    return { text, view };
  } catch (e) {
    saveCheck(false, e instanceof Error ? e.message.split('\n')[0] : String(e));
    throw e;
  } finally {
    await page.close().catch(() => {});
  }
}

let running: Promise<{ text: string; view: RedevZonesView }> | null = null;

/** 지도 아래 '새 파일 확인': 창 없는 크롬을 따로 띄워 바로 본다(조회 중이어도 됨). 이미 보는 중이면 그 결과를 기다린다. */
export function updateZonesNow(): Promise<{ text: string; view: RedevZonesView }> {
  running ??= (async () => {
    let browser: Browser;
    const exe = process.env.HNW_CHROMIUM_PATH; // 개발과 시험용(설치된 크롬 대신 쓸 실행 파일)
    try {
      browser = await chromium.launch(exe ? { executablePath: exe, headless: true } : { channel: 'chrome', headless: true, chromiumSandbox: true });
    } catch {
      browser = await chromium.launch({ headless: true });
    }
    try {
      const context = await browser.newContext({ acceptDownloads: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
      const result = await updateZonesWith(context);
      return { text: result.text, view: result.view ?? redevZones() };
    } finally {
      await browser.close().catch(() => {});
    }
  })().finally(() => {
    running = null;
  });
  return running;
}
