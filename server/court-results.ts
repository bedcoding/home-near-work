import type { Response } from 'playwright';
import type { BrowserSession } from './browser.js';
import { PAGE_DELAY_MS } from './config.js';
import * as store from './db.js';
import { choose, closeNotices, ID, lotsOf, normalizeLot, ymd } from './collectors/courtauction.js';
import { gusFor } from './collectors/gus.js';
import { BlockedError, toNumber, type CollectContext } from './collectors/types.js';
import { LAND_PREFIX, SEOUL, SHOP_PREFIX, type AuctionResultKind, type CourtRegionStat, type NormalizedListing } from '../shared/types.js';

// 법원경매 매각 결과.
// 매각결과검색: 소재지 서울특별시(구 전체)로 검색하면 매각기일 다음 날부터 7일 동안 그 기일의 물건별 결과(매각대금, 유찰)가 나온다.
// 경매사건검색: 대시보드가 모은 물건 중 매각기일이 지났는데 결과가 없는 것을 사건번호로 찾는다(그 물건의 지금 매각기일과 매각대금이 나옴).
// 지역별 매각통계: 켜진 지역 근처 구마다(동별)와 서울 전체(구별) 경매 건수, 매각 건수, 매각가율(매각가 합 ÷ 감정가 합). 기간은 화면 기본값. 읽을 때마다 지역과 기간별로 쌓는다.

const RESULT_URL = 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ158M00.xml';
const RESULT_API = 'selectDspslSchdRsltSrch.on';
export const CASE_URL = 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ159M00.xml';
export const CASE_API = 'selectAuctnCsSrchRslt.on';
const STATS_URL = 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ163M01.xml';
const STATS_API = 'selectRletYrDspslStats.on';

const RESULT = {
  locationRadio: 'label[for="mf_wfm_mainFrame_rad_dspslRsltSrchSt_input_1"]',
  sido: '#mf_wfm_mainFrame_sbx_dspslRsltSrchAdongSdS',
  search: '#mf_wfm_mainFrame_btn_dspslRsltSrch',
  /** 쪽 번호 다음 묶음(11쪽, 21쪽, …)의 첫 쪽으로 가는 버튼 */
  nextGroup: '#mf_wfm_mainFrame_pgl_gdsDtlSrchPage_next_btn',
};
export const CASE = {
  court: '#mf_wfm_mainFrame_sbx_auctnCsSrchCortOfc',
  year: '#mf_wfm_mainFrame_sbx_auctnCsSrchCsYear',
  no: '#mf_wfm_mainFrame_ibx_auctnCsSrchCsNo',
  search: '#mf_wfm_mainFrame_btn_auctnCsSrchBtn',
};
const STATS = {
  sido: '#mf_sbx_adongSdCd',
  sigungu: '#mf_sbx_adongSggCd',
  period: ['#mf_sbx_startYear', '#mf_sbx_startMonth', '#mf_sbx_endYear', '#mf_sbx_endMonth'],
  search: '#mf_btn_search',
};

/** 마지막으로 매각결과검색(서울 전체)을 마친 시각을 두는 설정 키(ISO) */
const SEARCHED_KEY = 'court_results_searched_at';
/** 매각결과검색을 마친 지 이만큼 지나면 공고만 확인에서도 매각 결과를 모은다(결과가 매각기일 다음 날부터 7일 동안만 나와서). */
const RESULTS_MAX_AGE_MS = 5 * 86400000;
/** 매각결과검색에서 넘겨 보는 쪽 수 한도(40건씩) */
const RESULT_MAX_PAGES = 60;
/** 지역별 매각통계를 다시 읽는 간격(지역마다) */
const STATS_MAX_AGE_MS = 6 * 86400000;
/** 경매사건검색으로 한 번 조회에 찾아보는 사건 수, 찾아보는 매각기일 범위(오늘부터 며칠 전까지) */
const CASE_LIMIT = 12;
const CASE_MAX_DAYS = 180;

/** 법원 물건 상태 코드 중 결과가 아직 안 들어온 것(매각준비, 매각공고) */
const PENDING_STATUS = new Set(['00', '01']);

/** 매각 결과를 모을 때가 됐는지: 매각결과검색을 마친 적이 없거나 마친 지 RESULTS_MAX_AGE_MS가 지났으면 true. */
export function courtResultsDue(): boolean {
  const at = store.getSetting(SEARCHED_KEY);
  return !at || Date.now() - Date.parse(at) >= RESULTS_MAX_AGE_MS;
}

/** 법원경매정보 화면이 열리지 않음(서비스 점검 시간 등). 매각 결과와 배당 순위 확인 모으기를 거기서 멈춘다. */
export class ScreenDownError extends Error {}

/** 이 컴퓨터 날짜로 오늘에서 days일 더한 날, YYYY-MM-DD */
function localDay(days = 0): string {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0] : String(e));

/** 목록 행들의 용도 코드로 경매 탭 칸을 정한다: 주거용건물(20100) 목록이 있으면 주거, 상업용및업무용(21100)이면 상가, 모두 토지(10000)면 토지. */
function kindOfRows(rows: any[]): AuctionResultKind {
  if (rows.some((r) => String(r.mclsUtilCd) === '20100')) return 'home';
  if (rows.some((r) => String(r.mclsUtilCd) === '21100')) return 'shop';
  if (rows.every((r) => String(r.lclsUtilCd) === '10000')) return 'land';
  return 'other';
}

/** 매각결과검색 물건 하나(lotsOf의 묶음)를 저장할 결과로. 매각기일을 못 읽으면 null. */
function resultOfLot(lot: any[]): store.AuctionResultInput | null {
  const row = lot[0];
  const saleDate = ymd(row.maeGiil);
  if (!saleDate || !row.boCd || !row.saNo) return null;
  const listing = normalizeLot(lot);
  const notified = toNumber(row.notifyMinmaePrice1);
  const amount = toNumber(row.maeAmt);
  return {
    key: `${row.boCd}-${row.saNo}-${row.maemulSer ?? '1'}`,
    saleDate,
    court: String(row.jiwonNm ?? '').trim(),
    caseNo: String(row.srnSaNo ?? '').trim(),
    itemNo: String(row.maemulSer ?? '1'),
    gu: row.hjguSigu ? String(row.hjguSigu) : null,
    dong: row.hjguDong ? String(row.hjguDong) : null,
    address: listing.address,
    usage: row.dspslUsgNm ? String(row.dspslUsgNm) : null,
    kind: kindOfRows(lot),
    areaM2: listing.areaM2,
    lots: lot.length,
    failed: toNumber(row.yuchalCnt),
    appraisal: toNumber(row.gamevalAmt),
    minPrice: notified && notified > 0 ? notified : toNumber(row.minmaePrice),
    amount: amount && amount > 0 ? amount : null,
    status: String(row.mulStatcd ?? ''),
    lat: listing.lat,
    lng: listing.lng,
    via: 'result',
    raw: lot.length === 1 ? row : lot,
  };
}

/** 화면을 열고 검색 버튼이 보일 때까지 기다린 뒤 안내 창을 닫는다. 막히면 BlockedError, 화면이 안 열리면 ScreenDownError. */
export async function openScreen(session: BrowserSession, url: string, ready: string) {
  const response = await session.goto('courtauction', url).catch((e) => {
    throw new ScreenDownError(`법원경매정보에 접속하지 못했습니다(${errorText(e)}).`);
  });
  const status = response?.status() ?? 0;
  if (status === 403 || status === 429) throw new BlockedError(`법원경매정보가 요청을 막았습니다(HTTP ${status}). 우회하지 않고 멈춥니다.`);
  await session.page.waitForSelector(ready, { timeout: 25000 }).catch(() => {
    throw new ScreenDownError('화면이 열리지 않았습니다. 서비스 점검 시간(매일 01~06시, 연휴 공사 등)일 수 있습니다.');
  });
  await session.pause(1000);
  await closeNotices(session);
}

/** 매각결과검색 응답에서 목록 행과 전체 건수를 읽는다. */
async function readResultRows(session: BrowserSession, response: Response | null): Promise<{ rows: any[]; total: number } | null> {
  if (!response) return null;
  const data: any = await response.json().catch(() => null);
  session.record('courtauction', 'data', response.url(), response.status(), data ? `매각 결과 ${data.data?.dlt_srchResult?.length ?? 0}건 (전체 ${data.data?.dma_pageInfo?.totalCnt ?? '?'}건)` : '응답을 읽지 못함');
  if (!data) return null;
  return { rows: (data.data?.dlt_srchResult ?? []) as any[], total: Number(data.data?.dma_pageInfo?.totalCnt ?? 0) };
}

/**
 * 매각결과검색에서 소재지 서울특별시(구 전체)로 검색해 결과 행을 읽는다(40건씩, RESULT_MAX_PAGES쪽까지).
 * rows는 읽은 목록 행, total은 검색 결과 전체 행 수. 첫 응답이 없으면 null.
 */
async function searchResults(ctx: CollectContext): Promise<{ rows: any[]; total: number } | null> {
  const { session } = ctx;
  const page = session.page;
  ctx.progress('법원경매 매각 결과, 매각결과검색 여는 중');
  await openScreen(session, RESULT_URL, RESULT.search);
  await session.click(page.locator(RESULT.locationRadio));
  await session.pause(700);
  await choose(session, RESULT.sido, '서울특별시');
  session.record('courtauction', 'action', page.url(), null, '매각결과검색, 소재지 서울특별시 전체, 매각결과 전체');

  ctx.progress('법원경매 매각 결과, 서울 전체 검색');
  const first = page.waitForResponse((r) => r.url().includes(RESULT_API), { timeout: 25000 }).catch(() => null);
  await session.click(page.locator(RESULT.search));
  let result = await readResultRows(session, await first);
  if (!result) return null;
  const found = new Map<string, any>();
  for (const r of result.rows) found.set(String(r.docid), r);
  const total = result.total;
  await session.pause(1200);
  if (total > found.size && (await page.locator(ID.pageSize).inputValue().catch(() => '')) !== '40') {
    const bigger = page.waitForResponse((r) => r.url().includes(RESULT_API), { timeout: 15000 }).catch(() => null);
    await choose(session, ID.pageSize, '40');
    result = await readResultRows(session, await bigger);
    for (const r of result?.rows ?? []) found.set(String(r.docid), r);
    await session.pause(1200);
  }
  for (let pageNo = 2; found.size < total && pageNo <= RESULT_MAX_PAGES; pageNo++) {
    // 쪽 번호는 10개씩 보여서, 다음 묶음의 첫 쪽(11, 21, …)은 다음 묶음 버튼으로 연다.
    const link = page.locator(ID.pageLink(pageNo));
    const target = (await link.count()) ? link : pageNo % 10 === 1 ? page.locator(RESULT.nextGroup) : null;
    if (!target || !(await target.count())) break;
    ctx.progress(`법원경매 매각 결과, 서울 전체 ${pageNo}쪽 (${found.size}/${total}줄)`);
    const next = page.waitForResponse((r) => r.url().includes(RESULT_API), { timeout: 15000 }).catch(() => null);
    await session.click(target);
    const more = await readResultRows(session, await next);
    if (!more?.rows.length) break;
    for (const r of more.rows) found.set(String(r.docid), r);
    await session.pause(1200);
  }
  await session.screenshot('courtauction', '매각결과검색 서울 전체');
  return { rows: [...found.values()], total };
}

/** 매각기일이 지났는데 결과가 없는, 대시보드가 모은 법원경매 물건 하나 */
interface CaseTarget {
  key: string;
  saleDate: string;
  court: string;
  caseNo: string;
  itemNo: string;
  listing: NormalizedListing;
  rows: any[];
}

/** 매각기일이 어제부터 CASE_MAX_DAYS일 전 사이인데 결과가 없는 물건(매각기일 최근 순, CASE_LIMIT개까지). */
function caseTargets(): CaseTarget[] {
  const known = store.auctionResultKeys();
  const raws = store.rawBySource('courtauction');
  const today = localDay();
  const oldest = localDay(-CASE_MAX_DAYS);
  const targets: CaseTarget[] = [];
  for (const row of store.allListings()) {
    if (row.source !== 'courtauction') continue;
    const listing = JSON.parse(row.data) as NormalizedListing;
    const saleDate = listing.updatedAt;
    if (!saleDate || saleDate >= today || saleDate < oldest) continue;
    const rows = (Array.isArray(raws.get(row.id)) ? raws.get(row.id) : [raws.get(row.id)]) as any[];
    const first = rows[0];
    if (!first?.boCd || !first?.saNo || !first?.jiwonNm || !/^\d{4}타경\d+$/.test(String(first.srnSaNo ?? ''))) continue;
    const key = `${first.boCd}-${first.saNo}-${first.maemulSer ?? '1'}`;
    if (known.has(`${key}|${saleDate}`) || targets.some((t) => t.key === key && t.saleDate === saleDate)) continue;
    targets.push({ key, saleDate, court: String(first.jiwonNm).trim(), caseNo: String(first.srnSaNo), itemNo: String(first.maemulSer ?? '1'), listing, rows });
  }
  return targets.sort((a, b) => b.saleDate.localeCompare(a.saleDate)).slice(0, CASE_LIMIT);
}

/** 매물 용도 글자의 칸 표시('상업용: ', '토지: ')로 경매 탭 칸을 정한다. */
function kindOfListing(l: NormalizedListing): AuctionResultKind {
  const type = l.buildingType ?? '';
  return type.startsWith(LAND_PREFIX) ? 'land' : type.startsWith(SHOP_PREFIX) ? 'shop' : 'home';
}

/**
 * 경매사건검색에서 법원과 사건번호로 찾아 그 물건의 결과를 만든다.
 * 사건의 지금 매각기일이 그 날이면 그 날 결과(법원 물건 상태, 매각대금), 더 뒤면 'moved'(그 날 매각되지 않고 다음 기일로 넘어감),
 * 매각기일이 없거나 더 앞이면 'unsold'(그 날 매각되지 않았고 다음 기일도 없음).
 * 아직 결과가 들어오지 않았거나(매각준비, 매각공고) 물건을 못 찾으면 null.
 */
async function caseResult(ctx: CollectContext, t: CaseTarget): Promise<store.AuctionResultInput | null> {
  const { session } = ctx;
  const page = session.page;
  const [, year, no] = /^(\d{4})타경(\d+)$/.exec(t.caseNo)!;
  ctx.progress(`법원경매 매각 결과, ${t.caseNo} 경매사건검색`);
  await openScreen(session, CASE_URL, CASE.search);
  await choose(session, CASE.court, t.court);
  await choose(session, CASE.year, year);
  await session.click(page.locator(CASE.no));
  await page.locator(CASE.no).fill(no);
  session.record('courtauction', 'action', page.url(), null, `경매사건검색, ${t.court} ${t.caseNo}`);
  const searched = page
    .waitForResponse((r) => r.url().includes(CASE_API) && (r.request().postData() ?? '').includes('dma_srchCsDtlInf'), { timeout: 25000 })
    .catch(() => null);
  await session.click(page.locator(CASE.search));
  const response = await searched;
  const data: any = await response?.json().catch(() => null);
  const items = ((data?.data?.dlt_dspslGdsDspslObjctLst ?? []) as any[]).filter((r) => String(r.dspslGdsSeq) === t.itemNo);
  if (response) session.record('courtauction', 'data', response.url(), response.status(), `사건 ${t.caseNo} 물건 ${items.length ? t.itemNo : '없음'}`);
  const item = items[0];
  if (!item) return null;
  const date = ymd(item.dspslDxdyYmd);
  const status = String(item.auctnGdsStatCd ?? '');
  if (date === t.saleDate && PENDING_STATUS.has(status)) return null;
  const first = t.rows[0] ?? {};
  // 면적, 주소, 위치는 저장된 원본 행으로 다시 계산한다(예전에 저장한 매물은 면적 계산이 지금과 다름).
  const lot = normalizeLot(t.rows);
  // 사건의 목록 수가 원본 행보다 많으면(목록 한 줄씩 저장된 예전 매물) 그 면적은 물건 전체 면적이 아니다.
  const partial = items.length > t.rows.length;
  const moved = date !== t.saleDate;
  const outcome = !moved ? status : date && date > t.saleDate ? 'moved' : 'unsold';
  const amount = toNumber(item.dspslAmt);
  return {
    key: t.key,
    saleDate: t.saleDate,
    court: t.court,
    caseNo: t.caseNo,
    itemNo: t.itemNo,
    gu: first.hjguSigu ? String(first.hjguSigu) : null,
    dong: lot.dong ?? null,
    address: lot.address,
    usage: first.dspslUsgNm ? String(first.dspslUsgNm) : null,
    kind: kindOfListing(t.listing),
    areaM2: partial ? null : lot.areaM2,
    lots: Math.max(items.length, t.rows.length),
    failed: toNumber(first.yuchalCnt),
    appraisal: toNumber(item.aeeEvlAmt) ?? toNumber(first.gamevalAmt),
    minPrice: moved ? null : toNumber(item.fstPbancLwsDspslPrc),
    amount: !moved && amount && amount > 0 ? amount : null,
    status: outcome,
    lat: lot.lat,
    lng: lot.lng,
    via: 'case',
    raw: { item, nextSaleDate: moved ? date : null },
  };
}

/**
 * 지역별 매각통계에서 서울특별시 gu(SEOUL이면 구 '전체')를 검색해 통계와 검색 기간('2025.09 ~ 2026.10')을 읽는다.
 * 구는 동별, 서울 전체는 구별 숫자가 함께 온다. 응답이 없으면 null.
 */
async function regionStat(ctx: CollectContext, gu: string): Promise<CourtRegionStat | null> {
  const { session } = ctx;
  const page = session.page;
  const name = gu === SEOUL ? '서울 전체' : gu;
  ctx.progress(`법원경매 매각 결과, ${name} 지역별 매각통계`);
  await openScreen(session, STATS_URL, STATS.search);
  if ((await page.locator(STATS.sido).inputValue().catch(() => '')) !== '서울특별시') await choose(session, STATS.sido, '서울특별시');
  await choose(session, STATS.sigungu, gu === SEOUL ? '전체' : gu);
  const [y1, m1, y2, m2] = await Promise.all(STATS.period.map((s) => page.locator(s).inputValue().catch(() => '')));
  const period = `${y1}.${m1} ~ ${y2}.${m2}`;
  session.record('courtauction', 'action', page.url(), null, `지역별 매각통계, 서울특별시 ${gu === SEOUL ? '전체' : gu}, ${period}`);
  const searched = page.waitForResponse((r) => r.url().includes(STATS_API), { timeout: 25000 }).catch(() => null);
  await session.click(page.locator(STATS.search));
  const response = await searched;
  const data: any = await response?.json().catch(() => null);
  const rows = (data?.data?.rletYrDspslStats ?? []) as any[];
  if (response) session.record('courtauction', 'data', response.url(), response.status(), `지역별 매각통계 ${name} ${rows.length}줄`);
  const total = rows.find((r) => r.regnNm === '전체');
  if (!total) return null;
  const num = (v: unknown) => toNumber(v) ?? 0;
  return {
    gu,
    period,
    at: new Date().toISOString(),
    auctions: num(total.auctnNum),
    sold: num(total.dspslNum),
    soldRate: num(total.dspslRate),
    amountRate: num(total.dspslAmtRate),
    dongs: rows
      .filter((r) => r !== total && r.regnNm)
      .map((r) => ({ name: String(r.regnNm), auctions: num(r.auctnNum), sold: num(r.dspslNum), soldRate: num(r.dspslRate), amountRate: num(r.dspslAmtRate) })),
  };
}

/**
 * 법원경매 매각 결과를 모아 저장하고, 조회 기록에 남길 한 줄 요약을 돌려준다.
 * 매각결과검색(서울 전체) → 결과가 없는 지난 물건은 경매사건검색 → 켜진 지역 근처 구와 서울 전체의 지역별 매각통계(지역마다 STATS_MAX_AGE_MS에 한 번).
 * 곳마다 실패해도 나머지는 계속하고, 법원 화면이 열리지 않으면 거기서 멈춘다(막히면 BlockedError를 던진다).
 * stopped()가 참이 되면 거기서 멈춘다.
 */
export async function collectCourtResults(ctx: CollectContext, stopped: () => boolean): Promise<string> {
  const gus = gusFor(ctx.areas);
  const parts: string[] = [];
  /** 실패를 요약에 남긴다. 법원 화면이 열리지 않은 것이면 true(그 뒤는 건너뜀). */
  const failed = (what: string, e: unknown) => {
    if (e instanceof BlockedError) throw e;
    parts.push(`${what} 실패(${errorText(e)})`);
    return e instanceof ScreenDownError;
  };

  try {
    const found = await searchResults(ctx);
    if (!found) parts.push('매각결과검색 응답 없음');
    else {
      const results = lotsOf(found.rows).map(resultOfLot).filter((r): r is store.AuctionResultInput => r != null);
      store.saveAuctionResults(results);
      store.setSetting(SEARCHED_KEY, new Date().toISOString());
      const sold = results.filter((r) => r.amount != null).length;
      const near = results.filter((r) => r.gu != null && gus.includes(r.gu)).length;
      const short = found.rows.length < found.total ? `, ${found.total}줄 중 ${found.rows.length}줄만 읽음` : '';
      parts.push(`서울 최근 7일 ${results.length}건(낙찰 ${sold}, 켜진 지역 근처 구 ${near}건${short})`);
    }
  } catch (e) {
    if (failed('매각결과검색', e)) return parts.join(', ');
  }
  await ctx.session.pause(PAGE_DELAY_MS);

  const targets = caseTargets();
  if (targets.length) {
    let found = 0;
    for (const t of targets) {
      if (stopped()) return parts.join(', ');
      try {
        const result = await caseResult(ctx, t);
        if (result) {
          store.saveAuctionResults([result]);
          found++;
        }
      } catch (e) {
        if (failed(`${t.caseNo} 경매사건검색`, e)) return parts.join(', ');
      }
      await ctx.session.pause(PAGE_DELAY_MS);
    }
    parts.push(`매각기일 지난 물건 ${targets.length}건 중 ${found}건 결과 확인`);
  }

  const statAreas = [...gus, SEOUL];
  const latest = new Map<string, CourtRegionStat>();
  for (const s of store.courtRegionStatRows(statAreas)) if (!latest.has(s.gu)) latest.set(s.gu, s);
  const stale = statAreas.filter((gu) => {
    const s = latest.get(gu);
    return !s || Date.now() - Date.parse(s.at) >= STATS_MAX_AGE_MS;
  });
  const read: CourtRegionStat[] = [];
  for (const gu of stale) {
    if (stopped()) return parts.join(', ');
    try {
      const stat = await regionStat(ctx, gu);
      if (stat) {
        store.saveCourtRegionStat(stat);
        read.push(stat);
      }
    } catch (e) {
      if (failed(`${gu === SEOUL ? '서울 전체' : gu} 지역별 매각통계`, e)) return parts.join(', ');
    }
    await ctx.session.pause(PAGE_DELAY_MS);
  }
  if (read.length) parts.push(`지역별 매각통계(${read[read.length - 1].period}) ${read.map((s) => `${s.gu} ${s.amountRate}%`).join(', ')}`);
  return parts.join(', ');
}
