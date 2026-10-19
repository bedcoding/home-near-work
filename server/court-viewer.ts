import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { FORM_URL, ID, SCHEDULE_URL, SEARCH_API } from './collectors/courtauction.js';

// 법원경매 물건 하나를 보이는 크롬 창에 연다. 사이트는 물건 상세를 주소로 열 수 없어서(상세 화면은 사이트 안에서 넘긴 값으로만 열림),
// 검색 화면에서 법원, 사건번호로 찾은 뒤 그 물건을 눌러 상세 화면까지 간다. 창은 사용자가 닫을 때까지 둔다.
// 조회용 브라우저 프로필과 겹치지 않게 프로필 없이 띄운다.

type CourtRow = { jiwonNm?: string; srnSaNo?: string; maemulSer?: string; maeGiil?: string };

/** 법원, 사건번호로 찾는 검색 화면. 물건상세검색은 오늘부터 14일, 매각예정물건은 15일 뒤부터 60일 뒤까지 매각기일을 찾는다. */
const CASE_SCREENS = {
  detail: { url: FORM_URL, courtRadio: ID.courtRadio, court: ID.court, caseYear: ID.caseYear, caseNo: ID.caseNo, search: ID.search },
  schedule: {
    url: SCHEDULE_URL,
    courtRadio: 'label[for="mf_wfm_mainFrame_rad_dspslSchdGdsSrchSt_input_0"]',
    court: '#mf_wfm_mainFrame_sbx_dspslSchdGdsCortOfc',
    caseYear: '#mf_wfm_mainFrame_sbx_dspslSchdGdsCsYear',
    caseNo: '#mf_wfm_mainFrame_ibx_dspslSchdGdsCsNo',
    search: '#mf_wfm_mainFrame_btn_dspslSchdGdsSrch',
  },
};
type CaseScreen = (typeof CASE_SCREENS)[keyof typeof CASE_SCREENS];

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function newPage(headless: boolean): Promise<Page> {
  if (!browser?.isConnected() || !context) {
    browser = await chromium.launch({ channel: 'chrome', headless, chromiumSandbox: true, args: ['--window-size=1400,1000'] });
    context = await browser.newContext({ viewport: null });
    // page.evaluate 안의 함수에 tsx가 넣는 도우미
    await context.addInitScript('window.__name = (f) => f;');
    const b = browser;
    // 사용자가 창(탭)을 모두 닫으면 브라우저도 끝낸다.
    context.on('page', (p) =>
      p.on('close', () => {
        if (b.isConnected() && context && context.pages().length === 0) void b.close();
      }),
    );
    b.on('disconnected', () => {
      if (browser === b) browser = context = null;
    });
  }
  return context.newPage();
}

/** 사건번호 '2024타경12345' → 연도 '2024', 번호 '12345'. 모양이 다르면 null. */
function splitCaseNo(caseNo: string): { year: string; no: string } | null {
  const m = /^(\d{4})타경(\d+)$/.exec(caseNo.trim());
  return m ? { year: m[1], no: m[2] } : null;
}

/** 오늘(이 컴퓨터 날짜)부터 n일 뒤, YYYYMMDD */
function ymdAfter(days: number): string {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 검색 결과 행(법원경매 수집기가 저장한 원본 한 줄: jiwonNm, srnSaNo, maemulSer, maeGiil)의 물건 상세를 연 탭을 돌려준다.
 * 찾지 못하면 이유를 담은 Error를 던진다. 여러 번 누르면 차례로 연다. headless면 창 없이 연다.
 */
export function openCourtItem(row: CourtRow, options: { headless?: boolean } = {}): Promise<Page> {
  const run = queue.then(() => open(row, options.headless ?? false));
  queue = run.catch(() => {});
  return run;
}

async function open(row: CourtRow, headless: boolean): Promise<Page> {
  const court = row.jiwonNm?.trim();
  const parts = splitCaseNo(row.srnSaNo ?? '');
  if (!court || !parts) throw new Error(`법원과 사건번호를 읽지 못했습니다(${row.jiwonNm ?? '?'} ${row.srnSaNo ?? '?'}).`);
  const page = await newPage(headless);
  await page.bringToFront();
  // 매각기일이 2주 뒤면 매각예정물건에서 먼저 찾는다. 못 찾으면 다른 화면에서 한 번 더 찾는다.
  const later = typeof row.maeGiil === 'string' && row.maeGiil > ymdAfter(14);
  const order = later ? [CASE_SCREENS.schedule, CASE_SCREENS.detail] : [CASE_SCREENS.detail, CASE_SCREENS.schedule];
  for (const screen of order) {
    const index = await findCase(page, screen, court, parts, String(row.maemulSer ?? '1'), row.srnSaNo!);
    if (index < 0) continue;
    const link = page.locator(`a[onclick="moveDtlPage(${index})"]`).first();
    await link.waitFor({ state: 'visible', timeout: 15000 });
    const detail = page.waitForResponse((r) => r.url().includes('selectAuctnCsSrchRslt.on'), { timeout: 20000 }).catch(() => null);
    await link.click();
    if (!(await detail)) throw new Error('물건 상세 화면을 불러오지 못했습니다(검색 결과 화면은 열어 두었습니다).');
    return page;
  }
  throw new Error(
    `법원경매에서 ${row.srnSaNo}${row.maemulSer && row.maemulSer !== '1' ? ` 물건 ${row.maemulSer}` : ''}를 찾지 못했습니다. 매각기일이 지났거나 바뀌었을 수 있습니다(검색 화면은 열어 두었습니다).`,
  );
}

/** 한 검색 화면에서 법원, 사건번호로 검색해, 물건번호가 맞는 결과 줄의 번호(0부터)를 돌려준다. 없으면 -1. */
async function findCase(page: Page, screen: CaseScreen, court: string, parts: { year: string; no: string }, itemNo: string, caseNo: string): Promise<number> {
  const response = await page.goto(screen.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const status = response?.status() ?? 0;
  if (status === 403 || status === 429) throw new Error(`법원경매정보가 요청을 막았습니다(HTTP ${status}).`);
  await page.waitForSelector(screen.search, { timeout: 25000 }).catch(() => {
    throw new Error('법원경매 검색 화면이 열리지 않았습니다. 서비스 점검 시간(매일 01~06시)일 수 있습니다.');
  });
  await page.waitForTimeout(800);
  for (let i = 0; i < 3; i++) {
    const button = page.locator('button:visible', { hasText: /^(닫기|창닫기)$/ }).first();
    if (!(await button.isVisible().catch(() => false))) break;
    await button.click().catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.click(screen.courtRadio);
  await page.locator(screen.court).selectOption({ label: court });
  await page.waitForTimeout(700);
  await page.locator(screen.caseYear).selectOption(parts.year);
  await page.fill(screen.caseNo, parts.no);

  const searched = page.waitForResponse((r) => r.url().includes(SEARCH_API), { timeout: 25000 }).catch(() => null);
  await page.click(screen.search);
  const data: any = await (await searched)?.json().catch(() => null);
  const rows: any[] = data?.data?.dlt_srchResult ?? [];
  return rows.findIndex((r) => String(r.srnSaNo) === caseNo && String(r.maemulSer) === itemNo);
}
