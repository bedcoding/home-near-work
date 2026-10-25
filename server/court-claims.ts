import { PAGE_DELAY_MS } from './config.js';
import * as store from './db.js';
import { CASE, CASE_API, CASE_URL, openScreen, ScreenDownError } from './court-results.js';
import { CASE_SCREENS } from './court-viewer.js';
import { choose, closeNotices, SEARCH_API } from './collectors/courtauction.js';
import { BlockedError, type CollectContext } from './collectors/types.js';
import { seniorInRemarks, type CourtClaims, type NormalizedListing, type SurveyTenant } from '../shared/types.js';

// 법원경매 물건마다 배당 때 대항력 임차인보다 먼저 받을 수 있는 청구와 대항력 임차인을 읽는다.
// 경매사건검색: 이해관계인 역할과 문건 처리 내역(교부청구, 배당요구, 대항력 포기 확약서). 이름은 가려져 오고, 근로복지공단은 가려진 모양('근OOOOO')으로 알아본다.
// 물건 상세: 최선순위 설정(말소기준권리). 현황조사서(매각기일 2주 전부터 열림): 임차인 전입일, 확정일자, 보증금.
// 이름과 주소는 저장하지 않는다.

const DOCS_API = 'selectDlvrOfdocDtsDtl.on';
const SURVEY_API = 'selectCurstExmndc.on';
/** 한 번 조회할 때 확인하는 물건 수(물건마다 법원 화면을 두 번 연다) */
const CLAIMS_LIMIT = 10;
/** 사건 기록을 다시 보는 간격(일). 매각기일까지 문건이 더 들어올 수 있다. */
const RECHECK_DAYS = 10;
/** 현황조사서가 열리는 때(매각기일 며칠 전부터) */
const SURVEY_OPEN_DAYS = 14;

/** 근로복지공단(6자)의 가려진 이름 모양 */
const WAGE_ORG = /(^|[\s(])근O{5}(?=$|[\s(),])/;
const WAGE_WORDS = /임금|퇴직금|퇴직급여|대지급금|체당금/;

type CourtRow = { boCd?: string; saNo?: string; jiwonNm?: string; srnSaNo?: string; maemulSer?: string | number; maeGiil?: string; mulBigo?: string };

/** 'YYYYMMDD', 'YYYY.MM.DD.', 'YYYY-MM-DD'가 든 글자에서 첫 날짜를 YYYY-MM-DD로. 없으면 null. */
export function dateOf(text: unknown): string | null {
  const m = /(\d{4})[.-]?\s*(\d{1,2})[.-]?\s*(\d{1,2})/.exec(String(text ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1950 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 문건 한 줄에서 가려진 이름(O가 이어진 낱말)과 끝의 '제출'을 빼고 역할과 문건 종류만 남긴다. */
export function docKind(text: string): string {
  return text
    .split(/\s+/)
    .filter((w) => !/[가-힣A-Za-z]?O{2,}/.test(w))
    .join(' ')
    .replace(/\s*제출$/, '')
    .trim();
}

/** 조사서 칸 글자를 다듬는다(줄바꿈 태그와 앞뒤 빈칸을 빼고, 비면 null). */
function cell(value: unknown): string | null {
  const text = String(value ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

type CaseRecord = Pick<CourtClaims, 'demandEnd' | 'wage' | 'taxDocs' | 'taxParties' | 'tenantParties' | 'tenantDocs' | 'waiver'>;

/** 경매사건검색 응답과 문건/송달내역 응답(data)에서 배당 앞 순위 청구, 임차인 쪽 신고, 대항력 포기 확약서를 센다. */
export function readCaseRecord(caseData: any, docsData: any): CaseRecord {
  const parties = (caseData?.dlt_rletCsIntrpsLst ?? []) as { auctnIntrpsDvsNm?: unknown; intrpsNm?: unknown }[];
  const docs = (docsData?.dlt_ofdocDtsLst ?? []) as { ofdocRcptYmd?: unknown; rcptDts?: unknown }[];
  const wage: CourtClaims['wage'] = [];
  for (const p of parties) {
    const role = String(p.auctnIntrpsDvsNm ?? '');
    if (WAGE_ORG.test(String(p.intrpsNm ?? '')) || WAGE_WORDS.test(role)) wage.push({ date: null, what: `${role}(근로복지공단으로 보임)` });
  }
  let waiver: string | null = null;
  for (const d of docs) {
    const text = String(d.rcptDts ?? '');
    if (WAGE_WORDS.test(text) || (WAGE_ORG.test(text) && /배당요구|권리신고|채권계산|교부/.test(text))) wage.push({ date: dateOf(d.ofdocRcptYmd), what: docKind(text) });
    if (/대항력\s*포기/.test(text)) {
      const day = dateOf(d.ofdocRcptYmd);
      if (day && (!waiver || day > waiver)) waiver = day;
    }
  }
  const roles = parties.map((p) => String(p.auctnIntrpsDvsNm ?? ''));
  const texts = docs.map((d) => String(d.rcptDts ?? ''));
  return {
    demandEnd: dateOf(caseData?.dlt_dstrtDemnLstprdDts?.[0]?.dstrtDemnLstprdYmd),
    wage,
    taxDocs: texts.filter((t) => /교부청구/.test(t)).length,
    taxParties: roles.filter((r) => r === '교부권자' || r === '압류권자').length,
    tenantParties: roles.filter((r) => /임차인|임차권자|전세권자/.test(r)).length,
    tenantDocs: texts.filter((t) => /권리신고|배당요구/.test(t) && /임대차|임차/.test(t)).length,
    waiver,
  };
}

/**
 * 물건 상세 응답(data)의 최선순위 설정, 명세서와 물건 비고, 소멸되지 않는 권리 글자.
 * 최선순위는 '2024.02.06. 근저당권' 꼴이고, 일괄매각은 목록마다 날짜가 따로 온다('1,3토지 : 2015.10.29. 근저당권 2건물 : 2016.06.21. 추가 근저당권').
 * 날짜가 여럿이면 가장 늦은 날로 대항력을 가리고(낙찰자에게 조심스러운 쪽) right에 글 전체를 둔다.
 */
export function readSenior(detailData: any): { senior: CourtClaims['senior']; remarks: string } {
  const info = detailData?.dma_result?.dspslGdsDxdyInfo ?? {};
  const text = String(info.tprtyRnkHypthcStngDts ?? '').replace(/\s+/g, ' ').trim();
  const dates = [...text.matchAll(/\d{4}\.\s*\d{1,2}\.\s*\d{1,2}/g)].map((m) => dateOf(m[0])).filter((d): d is string => !!d).sort();
  const date = dates.length ? dates[dates.length - 1] : dateOf(text);
  const right = dates.length > 1 ? text : text.replace(/^[\d.\s-]+/, '').trim();
  const kept = String(info.ndstrcRghCtt ?? '');
  return {
    senior: date ? { date, right: right || '설정' } : null,
    remarks: `${info.gdsSpcfcRmk ?? ''} ${info.dspslGdsRmk ?? ''} ${/임차/.test(kept) ? `소멸되지 않는 권리: ${kept}` : ''}`,
  };
}

/** 현황조사서 응답(data)의 임차인 목록(이름과 주소는 뺌). 조사서가 아니면 null. */
export function readSurvey(surveyData: any): SurveyTenant[] | null {
  if (!surveyData?.dma_curstExmnMngInf) return null;
  return ((surveyData.dlt_ordTsLserLtn ?? []) as any[]).map((t) => ({
    moveIn: dateOf(t.mvinDtlCtt),
    fixed: dateOf(t.rgstryCrtcpCfmtnCtt),
    deposit: cell(t.lesDposDts),
    rent: cell(t.mmrntAmtDts),
    part: cell(t.lesPartCtt),
  }));
}

/** 비고 글자에 대항력 포기(확약서)가 적혀 있는지 */
const waived = (text: string) => /대항력\s*(을|은)?\s*포기|포기\s*확약/.test(text);

/** 이 컴퓨터 날짜로 오늘에서 days일 더한 날, YYYY-MM-DD */
function localDay(days = 0): string {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 경매사건검색에서 사건을 찾아 사건 응답과 문건/송달내역 응답의 data를 돌려준다. 사건을 못 찾으면 null. */
async function fetchCaseRecord(ctx: CollectContext, court: string, caseNo: string): Promise<{ caseData: any; docsData: any } | null> {
  const { session } = ctx;
  const page = session.page;
  const [, year, no] = /^(\d{4})타경(\d+)$/.exec(caseNo)!;
  ctx.progress(`법원경매 배당 확인, ${caseNo} 사건 기록`);
  await openScreen(session, CASE_URL, CASE.search);
  await choose(session, CASE.court, court);
  await choose(session, CASE.year, year);
  await session.click(page.locator(CASE.no));
  await page.locator(CASE.no).fill(no);
  session.record('courtauction', 'action', page.url(), null, `경매사건검색, ${court} ${caseNo}`);
  const searched = page
    .waitForResponse((r) => r.url().includes(CASE_API) && (r.request().postData() ?? '').includes('dma_srchCsDtlInf'), { timeout: 25000 })
    .catch(() => null);
  await session.click(page.locator(CASE.search));
  const response = await searched;
  const caseData = (await response?.json().catch(() => null))?.data ?? null;
  if (response) session.record('courtauction', 'data', response.url(), response.status(), `사건 ${caseNo} 이해관계인 ${caseData?.dlt_rletCsIntrpsLst?.length ?? '?'}`);
  if (!caseData?.dma_csBasInf) return null;
  await session.pause(1200);
  const docs = page.waitForResponse((r) => r.url().includes(DOCS_API), { timeout: 20000 }).catch(() => null);
  await session.click(page.locator('text=문건/송달내역').first());
  const docsResponse = await docs;
  const docsData = (await docsResponse?.json().catch(() => null))?.data ?? null;
  if (docsResponse) session.record('courtauction', 'data', docsResponse.url(), docsResponse.status(), `사건 ${caseNo} 문건 ${docsData?.dlt_ofdocDtsLst?.length ?? '?'}`);
  return { caseData, docsData };
}

/**
 * 물건상세검색(매각기일이 2주 넘게 남았으면 매각예정물건부터)에서 물건을 찾아 상세 응답과 현황조사서 응답의 data를 돌려준다.
 * 물건을 못 찾으면 null, 현황조사서가 안 열리면 survey가 null.
 */
async function fetchItem(ctx: CollectContext, row: CourtRow): Promise<{ detail: any; survey: any } | null> {
  const { session } = ctx;
  const page = session.page;
  const court = String(row.jiwonNm ?? '').trim();
  const caseNo = String(row.srnSaNo ?? '');
  const itemNo = String(row.maemulSer ?? '1');
  const [, year, no] = /^(\d{4})타경(\d+)$/.exec(caseNo)!;
  const later = typeof row.maeGiil === 'string' && row.maeGiil > localDay(SURVEY_OPEN_DAYS).replace(/-/g, '');
  for (const screen of later ? [CASE_SCREENS.schedule, CASE_SCREENS.detail] : [CASE_SCREENS.detail, CASE_SCREENS.schedule]) {
    ctx.progress(`법원경매 배당 확인, ${caseNo} 물건 상세`);
    await openScreen(session, screen.url, screen.search);
    await session.click(page.locator(screen.courtRadio));
    await page.locator(screen.court).selectOption({ label: court });
    await session.pause(700);
    await page.locator(screen.caseYear).selectOption(year);
    await page.fill(screen.caseNo, no);
    const searched = page.waitForResponse((r) => r.url().includes(SEARCH_API), { timeout: 25000 }).catch(() => null);
    await session.click(page.locator(screen.search));
    const found = await searched;
    const rows: any[] = (await found?.json().catch(() => null))?.data?.dlt_srchResult ?? [];
    if (found) session.record('courtauction', 'data', found.url(), found.status(), `${caseNo} 물건 찾기 ${rows.length}줄`);
    const index = rows.findIndex((r) => String(r.srnSaNo) === caseNo && String(r.maemulSer) === itemNo);
    if (index < 0) continue;
    const link = page.locator(`a[onclick="moveDtlPage(${index})"]`).first();
    await link.waitFor({ state: 'visible', timeout: 15000 });
    const opened = page
      .waitForResponse((r) => r.url().includes(CASE_API) && (r.request().postData() ?? '').includes('dma_srchGdsDtlSrch'), { timeout: 20000 })
      .catch(() => null);
    // 칸 가운데 좌표를 누르면 상세가 안 열리는 물건이 있어 링크 자체를 누른다.
    await link.click();
    const detailResponse = await opened;
    const detail = (await detailResponse?.json().catch(() => null))?.data ?? null;
    if (detailResponse) session.record('courtauction', 'data', detailResponse.url(), detailResponse.status(), `${caseNo} 물건 상세`);
    if (!detail?.dma_result) return null;
    await session.pause(1200);
    let survey: any = null;
    const button = page.locator('text=현황조사서').first();
    // 목록이 많은 물건은 상세 화면이 늦게 그려져 버튼이 뒤늦게 나온다.
    await button.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    if (await button.isVisible().catch(() => false)) {
      const read = page.waitForResponse((r) => r.url().includes(SURVEY_API), { timeout: 15000 }).catch(() => null);
      await session.click(button);
      const surveyResponse = await read;
      survey = (await surveyResponse?.json().catch(() => null))?.data ?? null;
      if (surveyResponse) session.record('courtauction', 'data', surveyResponse.url(), surveyResponse.status(), `${caseNo} 현황조사서 임차인 ${survey?.dlt_ordTsLserLtn?.length ?? '?'}`);
      await closeNotices(session);
    }
    return { detail, survey };
  }
  return null;
}

/**
 * 확인할 물건: 지금 있는 법원경매 물건 중 아직 안 봤거나, 현황조사서가 열렸는데 아직 못 읽었거나 최선순위를 못 읽었거나(하루 한 번),
 * 배당요구종기가 지났거나, 본 지 오래된 것(급한 것과 매각기일 가까운 것부터).
 */
function targets(saved: Map<string, CourtClaims>) {
  const today = localDay();
  const surveyOpen = localDay(SURVEY_OPEN_DAYS);
  const stale = localDay(-RECHECK_DAYS);
  const raws = store.rawBySource('courtauction');
  const list: { key: string; row: CourtRow; saleDate: string | null; rank: number; needItem: boolean }[] = [];
  for (const listing of store.allListings()) {
    if (listing.source !== 'courtauction' || listing.status !== 'active') continue;
    const raw = raws.get(listing.id);
    const row = (Array.isArray(raw) ? raw[0] : raw) as CourtRow | undefined;
    if (!row?.boCd || !row.saNo || !row.jiwonNm || !/^\d{4}타경\d+$/.test(String(row.srnSaNo ?? ''))) continue;
    const saleDate = (JSON.parse(listing.data) as NormalizedListing).updatedAt ?? null;
    if (saleDate && saleDate < today) continue;
    const key = `${row.boCd}-${row.saNo}-${row.maemulSer ?? '1'}`;
    const prev = saved.get(key);
    const surveyDue = !prev?.survey && !!saleDate && saleDate <= surveyOpen;
    const needItem = !prev?.senior || surveyDue;
    const rank = !prev
      ? 0
      : needItem && prev.checkedAt < today
        ? 1
        : prev.demandEnd && prev.checkedAt <= prev.demandEnd && today > prev.demandEnd
          ? 2
          : prev.checkedAt <= stale
            ? 3
            : -1;
    if (rank >= 0) list.push({ key, row, saleDate, rank, needItem });
  }
  return list.sort((a, b) => a.rank - b.rank || (a.saleDate ?? '9').localeCompare(b.saleDate ?? '9'));
}

/** 지금 있는 법원경매 물건의 배당 순위 확인을 모아 저장하고 결과 한 줄을 돌려준다. 화면이 안 열리면 거기서 멈춘다. */
export async function collectCourtClaims(ctx: CollectContext, stopped: () => boolean): Promise<string> {
  const saved = store.courtClaimsAll();
  const due = targets(saved);
  let checked = 0;
  let failed = 0;
  for (const t of due.slice(0, CLAIMS_LIMIT)) {
    if (stopped()) break;
    const caseNo = String(t.row.srnSaNo);
    try {
      const record = await fetchCaseRecord(ctx, String(t.row.jiwonNm).trim(), caseNo);
      if (!record) {
        failed++;
        continue;
      }
      const prev = saved.get(t.key);
      const claims: CourtClaims = {
        checkedAt: localDay(),
        ...readCaseRecord(record.caseData, record.docsData),
        senior: prev?.senior ?? null,
        survey: prev?.survey ?? null,
      };
      let remarks = String(t.row.mulBigo ?? '');
      /** 이번에 물건 상세(명세서 비고)를 다시 읽었는지 */
      let readItem = false;
      if (t.needItem && !stopped()) {
        await ctx.session.pause(PAGE_DELAY_MS);
        const item = await fetchItem(ctx, t.row);
        if (item) {
          readItem = true;
          const read = readSenior(item.detail);
          claims.senior = read.senior ?? claims.senior;
          remarks += ` ${read.remarks}`;
          const tenants = readSurvey(item.survey);
          if (tenants) claims.survey = { at: localDay(), tenants };
        }
      }
      if (!claims.waiver && waived(remarks)) claims.waiver = claims.checkedAt;
      // 상세를 다시 읽었으면 새 비고로만 정하고, 아니면 전에 상세에서 본 것을 이어 간다.
      claims.remarkSenior = seniorInRemarks(remarks) || (!readItem && (prev?.remarkSenior ?? false));
      store.saveCourtClaims(t.key, claims);
      checked++;
    } catch (e) {
      if (e instanceof ScreenDownError || e instanceof BlockedError) throw e;
      failed++;
      ctx.log(`법원경매 배당 확인 ${caseNo} 실패: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
    await ctx.session.pause(PAGE_DELAY_MS);
  }
  const left = Math.max(0, due.length - CLAIMS_LIMIT);
  return `${checked}건 확인${failed ? `, 못 읽음 ${failed}` : ''}${left ? `, 남은 ${left}건은 다음 조회 때` : ''}`;
}
