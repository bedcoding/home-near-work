// 크롬 확장(extension/)이 보내는 부동산 사이트 화면 데이터를 받아 저장한다.
// 네이버와 다방 것은 매물로 읽어 대시보드에 합치고, 네이버 동그라미와 KB 동별 매물 수는 전에 본 수와 비교한다. 다른 것은 원본만 쌓아 둔다.

import fs from 'node:fs';
import naverLedger from './naver-ledger.js';
import path from 'node:path';
import { DASHBOARD_URL, DATA_DIR, ROOT } from './config.js';
import { alertSettings, matchesAlert, type NewsItem } from './alerts.js';
import { compareCount, compareNaverClusters, kbAreaCount, naverClusterCounts, readMarks, readViews, saveCaptureNews, writeMarks, writeViews } from './capture-news.js';
import { parseDabangRoomList } from './dabang-parse.js';
import { isDabangMapResponse, matchesDabangRegionPage, matchesDabangRegionResponse, normalizeDabangRegionScope, sameDabangRegionScope, type DabangRegionScope } from './browse-scope.js';
import * as store from './db.js';
import { learnLinkHints, zigbangStationName } from './link-hints.js';
import { parseZigbangItemRows, parseZigbangStationIds } from './zigbang-parse.js';
import { acceptDaangnPage, createDaangnLedger, daangnCoverage, daangnStationName, parseDaangnArticles, type DaangnCoverage, type DaangnLedger } from './daangn-parse.js';
import { recordZigbangDetails, recordZigbangPage, recordZigbangStationList, zigbangCoverage, zigbangPageStation, type ZigbangCoverage, type ZigbangLedger } from './zigbang-coverage.js';
import { normalizeNaverItem, parseNaverList } from './naver-parse.js';
import { notify } from './notify.js';
import { applyResults, coveringArea } from './runner.js';
import { activeLineAreas } from './line-areas.js';
import type { CollectedItem } from './collectors/types.js';
import { isApartmentType, seoulGuOf, type NormalizedListing, type RunSourceSummary } from '../shared/types.js';

export const NAVER_SNAPSHOT_DIR = path.join(DATA_DIR, 'naver-snapshots');
const EXTENSION_MANIFEST = path.join(ROOT, 'extension', 'manifest.json');
const MAX_BODY = 2_000_000;
const MAX_HTML = 5_000_000;
// 확장(hook.js)과 같은 기준으로 한 번 더 거른다. 로그인, 개인 정보, 로그 요청은 저장하지 않는다.
const SKIP = /(member|login|logout|auth|token|user|\/my\b|mypage|favorite|interest|alarm|notif|nelo|\/log\b|analytics|\/si$)/i;

/** 전화번호, 이메일, 실명과 본인 확인값으로 보이는 값을 가린다. */
export function redact(text: string): string {
  return text
    .replace(/("[\w-]*(?:phone|tel|mobile|cell|fax|mail|representative)[\w-]*"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/("(?:realName|di|ci)"\s*:\s*)"[^"]*"/g, '$1"***"')
    .replace(/(?<![\d.])0\d{1,2}[-.) ]?\d{3,4}[-. ]?\d{4}(?!\d)/g, '***')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***');
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** 확장이 켤 수 있는 사이트와, 그 사이트 화면이 데이터를 받아 오는 주소(extension/sites.js와 맞춘다). */
const SITE_HOSTS: Record<string, RegExp> = {
  naver: /(^|\.)land\.naver\.com$/,
  peterpanz: /(^|\.)peterpanz\.com$/,
  dabang: /(^|\.)dabangapp\.com$/,
  zigbang: /(^|\.)zigbang\.com$/,
  kbland: /(^|\.)kbland\.kr$/,
  hogangnono: /(^|\.)hogangnono\.com$/,
  daangn: /(^|\.)(daangn|karrotmarket)\.com$/,
  ziptoss: /(^|\.)ziptoss\.com$/,
};

export interface CaptureInput {
  at?: unknown;
  site?: unknown;
  pageUrl?: unknown;
  url?: unknown;
  method?: unknown;
  status?: unknown;
  requestBody?: unknown;
  body?: unknown;
}

/** 확장이 응답을 받은 시각. 이상한 값이면 지금 시각을 쓴다. */
function capturedAt(value: unknown): string {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) && t <= Date.now() + 60_000 ? new Date(t).toISOString() : new Date().toISOString();
}

/** 받은 응답 중 켤 수 있는 사이트의 데이터 주소에서 온 것만 가려 저장하고, 저장한 개수를 돌려준다. */
export function acceptCaptures(list: CaptureInput[], scheduleSession = true): number {
  const rows: store.NaverCaptureRow[] = [];
  for (const c of list) {
    if (typeof c?.url !== 'string' || typeof c.body !== 'string' || c.body.length > MAX_BODY) continue;
    let url: URL;
    try {
      url = new URL(c.url);
    } catch {
      continue;
    }
    // 예전 확장(0.3.0 이하)이 보낸 사이트 표시 없는 응답은 네이버로 본다.
    const site = typeof c.site === 'string' ? c.site : 'naver';
    const host = SITE_HOSTS[site];
    if (!host || !host.test(url.hostname) || SKIP.test(url.pathname)) continue;
    // 당근은 모든 요청이 같은 /graphql 주소라 주소로 거를 수 없다. 로그인 사용자 정보 응답은 저장하지 않는다.
    if (site === 'daangn' && /^\s*\{\s*"data"\s*:\s*\{\s*"viewer"\s*:/.test(c.body)) continue;
    const requestBody = str(c.requestBody, 4000);
    rows.push({
      at: capturedAt(c.at),
      site,
      pageUrl: str(c.pageUrl, 2000),
      url: c.url.slice(0, 4000),
      method: str(c.method, 10),
      status: typeof c.status === 'number' && Number.isFinite(c.status) ? c.status : null,
      requestBody: requestBody === null ? null : redact(requestBody),
      body: redact(c.body),
    });
  }
  if (rows.length) {
    store.addNaverCaptures(rows);
    for (const r of rows) learnLinkHints(r.site, r.url, r.body);
    processPendingNaverCaptures();
    if (scheduleSession && rows.some((r) => SESSION_SITES.includes(r.site))) scheduleCaptureSession();
  }
  return rows.length;
}

/** 오늘(서울 기준) 크롬 확장 조회 기록(네이버, 다방 함께). 없으면 만든다. */
function captureRunId(): number {
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const existing = store.naverRunFor(day);
  if (existing && store.getRun(existing)) return existing;
  const runId = store.createRun(false);
  store.setNaverRun(day, runId);
  store.finishRun(runId, 'done', { sources: [], newCount: 0, changedCount: 0 }, null, [`크롬 확장 ${day}: 직접 본 화면에서 받은 매물을 모읍니다.`]);
  return runId;
}

/** 오늘 크롬 확장 조회 기록의 그 사이트 요약에 이번 결과를 더한다. */
function addToCaptureRun(runId: number, s: RunSourceSummary, note: string) {
  const run = store.getRun(runId);
  const sources = run?.summary?.sources ?? [];
  const prev = sources.find((x) => x.source === s.source);
  const merged: RunSourceSummary = prev
    ? {
        ...prev,
        fetched: prev.fetched + s.fetched,
        kept: prev.kept + s.kept,
        newCount: prev.newCount + s.newCount,
        priceChanged: prev.priceChanged + s.priceChanged,
        relisted: prev.relisted + s.relisted,
      }
    : s;
  const next = [...sources.filter((x) => x.source !== s.source), merged];
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' });
  store.finishRun(
    runId,
    'done',
    { sources: next, newCount: next.reduce((n, x) => n + x.newCount, 0), changedCount: next.reduce((n, x) => n + x.priceChanged, 0) },
    null,
    [...(run?.log ?? []), `${time} ${note}`],
  );
  if (browseReceiptInProgress) {
    browseReceiptInProgress.listings += s.kept;
    browseReceiptInProgress.newCount += s.newCount;
    browseReceiptInProgress.changedCount += s.priceChanged;
  }
}

/** 서버 처리 결과. listings는 같은 매물을 다른 응답으로 갱신한 건수도 포함한다. */
export interface BrowseReceipt {
  responses: number;
  listings: number;
  newCount: number;
  changedCount: number;
  uniqueListings?: number;
  excludedOutside?: number;
  excludedUnknown?: number;
  retainedOutside?: number;
  retainedUnknown?: number;
  coverage?: DabangCoverage;
  zigbangCoverage?: ZigbangCoverage;
  naverCoverage?: ReturnType<typeof naverLedger.coverage>;
  daangnCoverage?: DaangnCoverage;
}
export interface DabangCoverage {
  pages: number;
  totalPages: number | null;
  total: number | null;
  regularUnique: number;
  complete: boolean;
  reason: string;
}
interface DabangPageLedger {
  verified?: boolean;
  query?: string;
  total?: number;
  limit?: number;
  invalid?: string;
  pages: Record<string, { ids: string[]; hasMore: boolean }>;
}
interface DabangScopeLedger {
  stored: string[];
  outside: string[];
  unknown: string[];
  retainedOutside?: string[];
  retainedUnknown?: string[];
  coverage: DabangPageLedger;
}
interface BrowseReceiptEntry {
  jobId: string;
  at: number;
  receipt: BrowseReceipt;
  batches: string[];
  zigbangFresh?: number[];
  dabangMax?: number | null;
  scope?: DabangRegionScope | null;
  dabangScope?: DabangScopeLedger;
  zigbangScope?: ZigbangLedger;
  naverLedger?: ReturnType<typeof naverLedger.create>;
  daangnScope?: DaangnLedger;
}
const BROWSE_RECEIPTS_KEY = 'browse_receipts';
const BROWSE_RECEIPT_DAYS = 7 * 24 * 60 * 60 * 1000;
const BROWSE_RECEIPT_LIMIT = 2048;
const BROWSE_BATCH_LIMIT = 512;
let browseReceiptInProgress: BrowseReceipt | null = null;
// 역 ID 응답과 상세 응답이 서로 다른 전송 묶음이어도 이번 지역의 신규 판정을 유지한다.
let browseZigbangFresh: Set<number> | null = null;
// 페이지마다 현재 최댓값을 다시 읽으면 뒤쪽 페이지의 새 방을 기준 매물로 오판한다.
let browseDabangMax: number | null | undefined;
let browseDabangScope: { scope: DabangRegionScope; ledger: DabangScopeLedger } | null = null;
let browseZigbangScope: ZigbangLedger | null = null;
let browseDaangnScope: DaangnLedger | null = null;
const browseInputError = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

function browseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(value)) throw browseInputError('조회 또는 응답 묶음 번호가 올바르지 않습니다.');
  return value;
}

function browseReceiptEntries(): BrowseReceiptEntry[] {
  try {
    const entries = JSON.parse(store.getSetting(BROWSE_RECEIPTS_KEY) ?? '[]');
    return Array.isArray(entries) ? entries.filter((e) =>
      e && typeof e.jobId === 'string' && Number.isFinite(e.at) && e.at > Date.now() - BROWSE_RECEIPT_DAYS &&
      Array.isArray(e.batches) && e.batches.every((b: unknown) => typeof b === 'string') && e.receipt &&
      ['responses', 'listings', 'newCount', 'changedCount'].every((k) => Number.isFinite(e.receipt[k]) && e.receipt[k] >= 0),
    ).slice(-BROWSE_RECEIPT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function browseReceipt(jobId: unknown): BrowseReceipt | null {
  const id = browseId(jobId);
  return browseReceiptEntries().find((e) => e.jobId === id)?.receipt ?? null;
}

/**
 * 지역 순회 응답을 즉시 처리하고 서버가 실제 저장한 결과를 확인한다.
 * 수동 탐색의 미처리 응답을 먼저 끝내므로 다른 탭의 저장 건수가 섞이지 않는다.
 * 배치 번호와 DB 변경을 같은 transaction에 기록하여 응답을 잃어 재전송해도 중복 처리하지 않는다.
 */
export function acceptBrowseCaptures(input: { jobId?: unknown; batchId?: unknown; captures?: unknown; scope?: unknown; naverScope?: unknown }): BrowseReceipt {
  const jobId = browseId(input.jobId);
  const batchId = browseId(input.batchId);
  if (!Array.isArray(input.captures) || input.captures.length > 200) throw browseInputError('응답 묶음은 200개 이하의 목록이어야 합니다.');
  const scope = normalizeDabangRegionScope(input.scope);
  let naverScope: ReturnType<typeof naverLedger.scope> | null = null;
  try { if (input.naverScope != null) naverScope = naverLedger.scope(input.naverScope); }
  catch { throw browseInputError('네이버 구·동 범위를 확인해 주세요.'); }
  if (scope && naverScope) throw browseInputError('조회 범위는 사이트별로 하나만 지정해 주세요.');
  const entries = browseReceiptEntries();
  const previous = entries.find((e) => e.jobId === jobId);
  if (JSON.stringify(previous?.naverLedger?.scope ?? null) !== JSON.stringify(naverScope) && previous) throw browseInputError('같은 조회의 구·동 범위를 바꿀 수 없습니다. 새 조회를 시작해 주세요.');
  if (previous && !sameDabangRegionScope(previous.scope, scope)) throw browseInputError('같은 조회의 동 범위를 바꿀 수 없습니다. 새 조회를 시작해 주세요.');
  if (previous?.batches.includes(batchId)) return { ...previous.receipt };
  if (previous && previous.batches.length >= (naverScope ? 4096 : BROWSE_BATCH_LIMIT)) throw browseInputError('이 조회의 응답 묶음이 너무 많습니다. 새 조회를 시작해 주세요.');
  const captures = input.captures as CaptureInput[];
  if (naverScope && captures.some(c => c?.site !== 'naver')) throw browseInputError('네이버 조회에는 해당 사이트의 응답만 저장할 수 있습니다.');
  if (scope && captures.some((c) => c?.site !== 'dabang' || !matchesDabangRegionPage(scope, c.pageUrl))) {
    throw browseInputError('선택한 다방 동 검색 화면과 응답의 범위가 다릅니다.');
  }

  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = null;
  processPendingNaverCaptures();
  finishCaptureSession();
  const receipt: BrowseReceipt = previous ? { ...previous.receipt } : { responses: 0, listings: 0, newCount: 0, changedCount: 0 };
  const beforeSession = { ...naverSession, compared: new Set(naverSession.compared) };
  const beforeNaverNews = [...pendingNaverNews];
  try {
    return store.db.transaction(() => {
      const regionLedger = naverScope ? previous?.naverLedger ? structuredClone(previous.naverLedger) : naverLedger.create(naverScope) : null;
      if (regionLedger) for (const capture of captures) naverLedger.accept(regionLedger, {
        url: typeof capture.url === 'string' ? capture.url : '', status: typeof capture.status === 'number' ? capture.status : null,
        requestBody: typeof capture.requestBody === 'string' ? capture.requestBody : null, body: typeof capture.body === 'string' ? capture.body : '',
      });
      browseReceiptInProgress = receipt;
      browseZigbangFresh = new Set(previous?.zigbangFresh ?? []);
      browseDabangMax = previous?.dabangMax === undefined ? store.maxNumericSourceId('dabang') : previous.dabangMax;
      browseDabangScope = scope ? { scope, ledger: previous?.dabangScope
        ? JSON.parse(JSON.stringify(previous.dabangScope)) as DabangScopeLedger
        : { stored: [], outside: [], unknown: [], coverage: { pages: {} } } } : null;
      const stationId = captures.filter((c) => c?.site === 'zigbang').map((c) => zigbangPageStation(c.pageUrl)).find(Boolean);
      browseZigbangScope = !scope && previous?.zigbangScope ? JSON.parse(JSON.stringify(previous.zigbangScope)) as ZigbangLedger
        : !scope && stationId ? { stationId, details: {} } : null;
      if (browseZigbangScope) {
        for (const c of captures) {
          if (c?.site !== 'zigbang') browseZigbangScope.invalid ||= 'response-scope';
          else recordZigbangPage(browseZigbangScope, c.pageUrl);
        }
      }
      // 당근 역 근처 목록: 같은 역 화면의 응답만 이어 받아 끝 페이지와 매물별 저장을 대조한다.
      const daangnPage = captures.find((c) => c?.site === 'daangn');
      browseDaangnScope = scope || naverScope ? null : previous?.daangnScope ? structuredClone(previous.daangnScope)
        : daangnPage ? createDaangnLedger(daangnStationName(typeof daangnPage.pageUrl === 'string' ? daangnPage.pageUrl : null)) : null;
      if (browseDaangnScope) for (const c of captures) if (c?.site !== 'daangn') browseDaangnScope.invalid ||= 'response-scope';
      const accepted = naverScope?.filter ? captures.filter(c => {
        if (!naverLedger.endpoint(typeof c.url === 'string' ? c.url : '')) return false;
        if (!(typeof c.status === 'number' && c.status >= 200 && c.status < 300)) return false;
        try { return naverLedger.matchesFilter(naverScope!,JSON.parse(typeof c.requestBody === 'string' ? c.requestBody : '{}').filter); } catch { return false; }
      }) : scope ? captures.filter((c) => typeof c.status === 'number' && c.status >= 200 && c.status < 300)
        : browseZigbangScope ? captures.filter((c) => {
          let endpoint = '';
          try { endpoint = new URL(typeof c.url === 'string' ? c.url : '').pathname; } catch { return true; }
          if (c.site !== 'zigbang' || !(/\/items\/subways\/[^/]+\/onerooms$/.test(endpoint) || /\/items\/list$/.test(endpoint))) return true;
          if (typeof c.status === 'number' && c.status >= 200 && c.status < 300) return true;
          browseZigbangScope!.invalid ||= 'response-status';
          return false;
        }) : captures;
      if (browseDabangScope && accepted.length !== captures.length) browseDabangScope.ledger.coverage.invalid ||= 'response-status';
      receipt.responses += acceptCaptures(accepted, false);
      // 순회 도중의 작은 응답 묶음마다 데스크톱 알림을 띄우지 않는다. 수동 탐색 알림은 위에서 처리한다.
      finishCaptureSession(false);
      if (regionLedger) receipt.naverCoverage = naverLedger.coverage(regionLedger, regionLedger.ids.filter(id => !!store.getListing(`naver:${id}`)).length);
      if (browseDabangScope) {
        const ledger = browseDabangScope.ledger;
        receipt.uniqueListings = ledger.stored.length;
        receipt.retainedOutside = ledger.retainedOutside?.length ?? 0;
        receipt.retainedUnknown = ledger.retainedUnknown?.length ?? 0;
        receipt.excludedOutside = ledger.outside.length - receipt.retainedOutside;
        receipt.excludedUnknown = ledger.unknown.length - receipt.retainedUnknown;
        receipt.coverage = dabangCoverage(ledger);
      }
      if (browseZigbangScope) {
        receipt.zigbangCoverage = zigbangCoverage(browseZigbangScope);
        receipt.uniqueListings = receipt.zigbangCoverage.stored;
        receipt.excludedOutside = receipt.zigbangCoverage.excluded;
      }
      if (browseDaangnScope) {
        receipt.daangnCoverage = daangnCoverage(browseDaangnScope);
        receipt.uniqueListings = receipt.daangnCoverage.stored;
      }
      const entry = { jobId, at: Date.now(), receipt, batches: [...(previous?.batches ?? []), batchId], zigbangFresh: [...browseZigbangFresh].slice(-20000), dabangMax: browseDabangMax,
        ...(regionLedger ? { naverLedger: regionLedger } : {}),
        ...(browseZigbangScope ? { zigbangScope: browseZigbangScope } : {}),
        ...(browseDaangnScope ? { daangnScope: browseDaangnScope } : {}),
        ...(scope ? { scope, dabangScope: browseDabangScope!.ledger } : {}) };
      store.setSetting(BROWSE_RECEIPTS_KEY, JSON.stringify([...entries.filter((e) => e.jobId !== jobId), entry].slice(-BROWSE_RECEIPT_LIMIT)));
      return { ...receipt };
    })();
  } catch (error) {
    naverSession = beforeSession;
    pendingNaverNews = beforeNaverNews;
    throw error;
  } finally {
    browseReceiptInProgress = null;
    browseZigbangFresh = null;
    browseDabangMax = undefined;
    browseDabangScope = null;
    browseZigbangScope = null;
    browseDaangnScope = null;
  }
}

/** Coverage is only evidence about one unchanged list, never a union of unrelated map requests. */
function recordDabangPage(ledger: DabangScopeLedger, url: string, parsed: NonNullable<ReturnType<typeof parseDabangRoomList>>) {
  const page = ledger.coverage;
  if (parsed.page == null || parsed.limit == null || parsed.total == null || parsed.hasMore == null) {
    page.invalid ||= 'missing-metadata';
    return;
  }
  const query = new URL(url);
  // Region queries are independent of the map viewport. Only these parameters
  // select the list; resizing the window must not create another page stream.
  const fingerprint = JSON.stringify([query.pathname, query.searchParams.get('code'), query.searchParams.get('filters')]);
  if (page.query && page.query !== fingerprint) { page.invalid ||= 'query-changed'; return; }
  page.query = fingerprint;
  if (page.total !== undefined && (page.total !== parsed.total || page.limit !== parsed.limit)) page.invalid ||= 'total-changed';
  page.total ??= parsed.total;
  page.limit ??= parsed.limit;
  const ids = [...new Set(parsed.regularIds)].sort();
  if (parsed.unreadableRegular || ids.length !== parsed.regularCount) page.invalid ||= 'unreadable-row';
  if (parsed.page > 5000 || parsed.total > 100000) { page.invalid ||= 'coverage-limit'; return; }
  const expectedPages = Math.max(1, Math.ceil(parsed.total / parsed.limit));
  const expectedRows = parsed.page < expectedPages ? parsed.limit : parsed.total - (expectedPages - 1) * parsed.limit;
  if (query.searchParams.getAll('page').length !== 1 || !/^[1-9]\d*$/.test(query.searchParams.get('page') ?? '') ||
      Number(query.searchParams.get('page')) !== parsed.page || parsed.page > expectedPages ||
      parsed.hasMore !== (parsed.page < expectedPages) || parsed.regularCount !== expectedRows) page.invalid ||= 'inconsistent-pages';
  const before = page.pages[String(parsed.page)];
  if (before && (before.hasMore !== parsed.hasMore || JSON.stringify(before.ids) !== JSON.stringify(ids))) page.invalid ||= 'page-changed';
  page.pages[String(parsed.page)] = { ids, hasMore: parsed.hasMore };
}

function dabangCoverage(ledger: DabangScopeLedger): DabangCoverage {
  const page = ledger.coverage;
  const values = Object.values(page.pages);
  const totalPages = page.total !== undefined && page.limit ? Math.max(1, Math.ceil(page.total / page.limit)) : null;
  const regular = new Set(values.flatMap((p) => p.ids));
  const contiguous = totalPages != null && values.length === totalPages &&
    Array.from({ length: totalPages }, (_, i) => page.pages[String(i + 1)]).every(Boolean) && page.pages[String(totalPages)]?.hasMore === false;
  const stored = new Set(ledger.stored);
  const reason = page.invalid || (!page.verified ? 'unverified-region' : page.total === undefined ? 'missing-metadata' : !contiguous ? 'missing-pages'
    : regular.size !== page.total ? 'count-mismatch' : [...regular].some((id) => !stored.has(id)) ? 'unverified-dong' : 'complete');
  return { pages: values.length, totalPages, total: page.total ?? null, regularUnique: regular.size, complete: reason === 'complete', reason };
}

/** 한 번의 확인(사이트를 열어 응답이 이어서 들어오는 동안)으로 묶어 읽는 사이트 */
const SESSION_SITES = ['dabang', 'zigbang', 'daangn', 'kbland', 'naver'];
/** 직방 역, 조건마다 마지막에 본 반경 안 방 번호(설정). 자동조회의 직방 수집(zigbang-client.ts의 같은 키)도 갱신한다. */
const ZIGBANG_IDS_KEY = 'zigbang_station_ids';

/**
 * 아직 읽지 않은 직방 응답을 읽는다. 역 반경 안 방 번호 전부(`items/subways/<역>/onerooms`)를 같은 역, 조건으로 전에 본 번호와 비교해
 * 새 방을 세고(처음 보는 역, 조건이면 기준만), 목록에 보인 방 내용(`items/list`)은 매물로 저장한다(새 방 번호면 신규).
 */
function processZigbang(): { stations: { subwayId: string; pageUrl: string | null; total: number; fresh: number; baseline: boolean }[]; news: NewsItem[] } {
  const pending = store.pendingNaverCaptures('zigbang');
  const latest = new Map<string, { subwayId: string; ids: number[]; pageUrl: string | null }>();
  const details = new Map<string, CollectedItem>();
  for (const r of pending) {
    const endpoint = new URL(r.url).pathname;
    const relevant = /\/items\/subways\/[^/]+\/onerooms$/.test(endpoint) || /\/items\/list$/.test(endpoint);
    if (browseZigbangScope && relevant) {
      recordZigbangPage(browseZigbangScope, r.pageUrl);
      const responseUrl = new URL(r.url);
      if (responseUrl.protocol !== 'https:' || responseUrl.username || responseUrl.password || responseUrl.port) {
        browseZigbangScope.invalid ||= 'response-scope';
        continue;
      }
      if (/\/items\/subways\/[^/]+\/onerooms$/.test(endpoint)) recordZigbangStationList(browseZigbangScope, r.url, r.body);
    }
    const s = parseZigbangStationIds(r.url, r.body);
    if (s) latest.set(s.key, { subwayId: s.subwayId, ids: s.ids, pageUrl: r.pageUrl });
    else if (/\/items\/list$/.test(endpoint)) {
      const parsed = parseZigbangItemRows(r.body);
      if (browseZigbangScope) recordZigbangDetails(browseZigbangScope, parsed);
      for (const i of parsed.items) {
        details.set(i.listing.sourceId, { listing: i.listing, raw: i.raw, pageUrl: r.pageUrl, screenshot: null });
      }
    }
  }
  let seen: Record<string, number[]> = {};
  try {
    seen = JSON.parse(store.getSetting(ZIGBANG_IDS_KEY) ?? '{}') ?? {};
  } catch {
    /* 못 읽으면 처음부터 */
  }
  const fresh = browseZigbangFresh ?? new Set<number>();
  const stations = [...latest].map(([key, s]) => {
    const prev = seen[key] ? new Set(seen[key]) : null;
    const added = prev ? s.ids.filter((id) => !prev.has(id)) : [];
    seen[key] = s.ids;
    for (const id of added) fresh.add(id);
    return { subwayId: s.subwayId, pageUrl: s.pageUrl, total: s.ids.length, fresh: added.length, baseline: !prev };
  });
  if (latest.size) {
    store.setSetting(ZIGBANG_IDS_KEY, JSON.stringify(seen));
    // 역 반경 안 번호 목록에 아직 있는 방은 내용을 다시 받지 않았어도 본 것으로 친다(14일 뒤 사라짐으로 바뀌지 않게).
    store.touchListings('zigbang', [...latest.values()].flatMap((s) => s.ids.map(String)), pending[pending.length - 1].at);
  }
  const news: NewsItem[] = [];
  const areas = store.enabledAreas();
  if (details.size && areas.length) {
    const runId = captureRunId();
    const summary = applyResults(runId, 'zigbang', [...details.values()], areas, false, undefined, {
      status: 'ok',
      isBaseline: (listing) => !fresh.has(Number(listing.sourceId)),
      allowRelistHide: (listing) => listing.floor != null,
      seenAt: pending[pending.length - 1].at,
      news,
    });
    addToCaptureRun(runId, summary, `직방: 목록에 보인 방 ${summary.fetched}개(저장 ${summary.kept}개, 주변·지역 미확인 ${summary.incidentalCount ?? 0}개), 신규 ${summary.newCount}, 가격 변동 ${summary.priceChanged}, 역 반경 안 새 방 ${fresh.size}`);
    if (browseZigbangScope) {
      // Only the just-processed detail and its persisted DB row can verify a write.
      // Pre-existing rows or the station's ID-only response do not prove detail storage.
      for (const { listing } of details.values()) {
        const id = listing.sourceId;
        if (!Object.hasOwn(browseZigbangScope.details, id)) continue;
        {
          const stored = store.getListing(`zigbang:${id}`);
          if (stored?.last_seen_run === runId && stored.data === JSON.stringify(listing)) browseZigbangScope.details[id] = 'stored';
        }
      }
    }
  }
  if (pending.length) store.markNaverCapturesParsed(pending.map((r) => r.id));
  return { stations, news };
}
const DAANGN_IDS_KEY = 'daangn_station_ids';

/**
 * 아직 읽지 않은 당근 역 근처 목록 응답에서 주거용 매물을 저장한다. 상가, 사무실, 건물은 저장하지 않는다.
 * 신규: 그 역 목록에서 전에 본 적 없는 매물 번호. 처음 본 역은 기준만 잡는다.
 */
function processDaangn(): { stations: { name: string; total: number; fresh: number; baseline: boolean }[]; news: NewsItem[] } {
  const pending = store.pendingNaverCaptures('daangn');
  const items = new Map<string, CollectedItem>();
  const seenByStation = new Map<string, Set<string>>();
  for (const r of pending) {
    const page = browseDaangnScope ? acceptDaangnPage(browseDaangnScope, r) : parseDaangnArticles(r.body);
    if (!page || !page.ids.length) continue;
    const station = daangnStationName(r.pageUrl) ?? '역 미확인';
    const ids = seenByStation.get(station) ?? new Set<string>();
    for (const id of page.ids) ids.add(id);
    seenByStation.set(station, ids);
    for (const i of page.items) items.set(i.listing.sourceId, { listing: i.listing, raw: i.raw, pageUrl: r.pageUrl, screenshot: null });
  }
  let seen: Record<string, string[]> = {};
  try {
    seen = JSON.parse(store.getSetting(DAANGN_IDS_KEY) ?? '{}') ?? {};
  } catch {
    /* 못 읽으면 처음부터 */
  }
  const fresh = new Set<string>();
  const stations = [...seenByStation].map(([name, ids]) => {
    const prev = seen[name] ? new Set(seen[name]) : null;
    const added = prev ? [...ids].filter((id) => !prev.has(id)) : [];
    for (const id of added) fresh.add(id);
    seen[name] = [...new Set([...(seen[name] ?? []), ...ids])].slice(-5000);
    return { name, total: ids.size, fresh: added.length, baseline: !prev };
  });
  if (seenByStation.size) store.setSetting(DAANGN_IDS_KEY, JSON.stringify(seen));
  const news: NewsItem[] = [];
  const areas = store.enabledAreas();
  if (items.size && areas.length) {
    const runId = captureRunId();
    const summary = applyResults(runId, 'daangn', [...items.values()], areas, false, undefined, {
      status: 'ok',
      isBaseline: (listing) => !fresh.has(listing.sourceId),
      seenAt: pending[pending.length - 1].at,
      news,
    });
    addToCaptureRun(runId, summary, `당근부동산: 역 근처 주거용 매물 ${summary.fetched}개(저장 ${summary.kept}개), 신규 ${summary.newCount}, 가격 변동 ${summary.priceChanged}`);
    if (browseDaangnScope) {
      // 이번에 처리한 매물이 실제로 이번 조회 기록으로 저장됐을 때만 저장 확인으로 친다.
      for (const { listing } of items.values()) {
        if (browseDaangnScope.articles[listing.sourceId] !== 'pending') continue;
        const stored = store.getListing(`daangn:${listing.sourceId}`);
        if (stored?.last_seen_run === runId && stored.data === JSON.stringify(listing)) browseDaangnScope.articles[listing.sourceId] = 'stored';
      }
    }
  }
  if (pending.length) store.markNaverCapturesParsed(pending.map((r) => r.id));
  return { stations, news };
}

let sessionTimer: ReturnType<typeof setTimeout> | null = null;
/** 이번 확인에서 네이버 동그라미 매물 수가 늘어난 합, 전에 본 수와 비교한 동그라미, 받은 동그라미 응답 수 */
let naverSession = { increase: 0, compared: new Set<string>(), seen: 0 };
let pendingNaverNews: NewsItem[] = [];

/** 마지막 응답 8초 뒤에 이번 확인을 마무리한다(여러 사이트를 한꺼번에 열어도 알림이 한 번만 뜨게). */
function scheduleCaptureSession() {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    finishCaptureSession();
  }, 8000);
}

/** 아직 읽지 않은 KB 응답에서 법정동 매물 수를 읽어(같은 조건은 마지막 것) 전에 본 수와 비교한다. delta: 늘어난 수, 처음이면 null. */
function processKbCounts(at: string): { dong: string; count: number; delta: number | null }[] {
  const pending = store.pendingNaverCaptures('kbland');
  const latest = new Map<string, { dong: string; count: number }>();
  for (const r of pending) {
    if (!r.url.includes('/stutCdFilter/count')) continue;
    const c = kbAreaCount(r.requestBody, r.body);
    if (c) latest.set(c.key, { dong: c.dong, count: c.count });
  }
  const marks = readMarks();
  const out = [...latest].map(([key, c]) => ({ ...c, delta: compareCount(marks, key, c.count, at) }));
  if (latest.size) writeMarks(marks);
  if (pending.length) store.markNaverCapturesParsed(pending.map((r) => r.id));
  return out;
}

/**
 * 이번 확인을 마무리한다: 다방 방 목록과 KB 매물 수를 읽고(네이버 동그라미는 받을 때 셈) 사이트마다 결과를 남긴 뒤,
 * 알림 설정 captureSites가 켜져 있고 새 것이 있으면 알림 하나를 띄운다.
 * 다방은 새 방 중 켜 둔 매물 알림 줄에 맞는 수, KB, 네이버는 늘어난 매물 수(가격 조건으로 거르지 못함)를 센다.
 * 돌려주는 값: 새 것이 있으면 알림 내용(설정이 꺼져 있어도), 없으면 null.
 */
export function finishCaptureSession(notifyUser = true): { title: string; message: string; url: string } | null {
  const at = new Date().toISOString();
  const settings = alertSettings();
  const areas = store.enabledAreas();
  const parts: string[] = [];
  const lines: string[] = [];
  let url: string | null = null;
  const eligible = (news: NewsItem[]) => [...new Map(news.filter((n) => n.type === 'listing' &&
    (!n.changed || settings.priceChanges && n.changeType === 'price_down') && matchesAlert(n.listing, settings, areas))
    .flatMap((n) => n.type === 'listing' ? [[`${n.listing.source}:${n.listing.sourceId}`, n.listing] as const] : [])).values()];

  const dabang = processPendingDabangCaptures();
  if (dabang.fetched) {
    // 알림은 켜진 지역(회사 근처) 안의 방만 센다(노선 탭 역 반경에만 든 방은 빼고).
    const matched = eligible(dabang.news);
    const text = dabang.baseline ? '처음이라 기준만' : dabang.newCount ? `새 방 ${dabang.newCount}${matched.length !== dabang.newCount ? `(알림 조건 ${matched.length})` : ''}` : '새 방 없음';
    saveCaptureNews('dabang', { at, text, hot: dabang.newCount > 0 });
    if (matched.length) {
      parts.push(`다방 ${matched.length}건`);
      lines.push(`다방: 새 방 ${dabang.newCount} 중 알림 조건에 맞는 ${matched.length}`);
      url = matched.length === 1 ? matched[0].url : `${DASHBOARD_URL}/?tab=news`;
    }
  }

  const zigbang = processZigbang();
  if (zigbang.stations.length || zigbang.news.length) {
    const named = zigbang.stations.map((s) => ({ ...s, name: zigbangStationName(s.subwayId) ?? `역 ${s.subwayId}` }));
    const matched = eligible(zigbang.news);
    const text = named
      .map((s) => (s.baseline ? `${s.name} 처음이라 기준만(방 ${s.total})` : s.fresh ? `${s.name} 새 방 ${s.fresh}` : `${s.name} 새 방 없음(방 ${s.total})`))
      .join(', ');
    const freshTotal = named.reduce((n, s) => n + s.fresh, 0);
    saveCaptureNews('zigbang', { at, text, hot: freshTotal > 0 });
    if (matched.length > 0) {
      parts.push(`직방 ${matched.length}건`);
      lines.push(
        `직방: ${named.filter((s) => s.fresh).map((s) => `${s.name} 반경 안 새 방 ${s.fresh}(전체 ${s.total})`).join(', ')}` +
          (matched.length ? `, 목록에 보인 것 중 알림 조건에 맞는 ${matched.length}` : ''),
      );
      url ??= named.find((s) => s.fresh)?.pageUrl ?? null;
    }
  }

  const daangn = processDaangn();
  if (daangn.stations.length || daangn.news.length) {
    const matched = eligible(daangn.news);
    const text = daangn.stations
      .map((s) => (s.baseline ? `${s.name} 처음이라 기준만(매물 ${s.total})` : s.fresh ? `${s.name} 새 매물 ${s.fresh}` : `${s.name} 새 매물 없음(매물 ${s.total})`))
      .join(', ');
    saveCaptureNews('daangn', { at, text, hot: daangn.stations.some((s) => s.fresh > 0) });
    if (matched.length) {
      parts.push(`당근 ${matched.length}건`);
      lines.push(`당근부동산: 역 근처 새 매물 중 알림 조건에 맞는 ${matched.length}`);
      url ??= matched.length === 1 ? matched[0].url : `${DASHBOARD_URL}/?tab=news`;
    }
  }

  const kb = processKbCounts(at);
  if (kb.length) {
    const fmt = (k: (typeof kb)[number]) => (k.delta == null || k.delta === 0 ? `${k.dong} ${k.count}` : `${k.dong} ${k.count - k.delta} → ${k.count}`);
    const up = kb.filter((k) => k.delta != null && k.delta > 0);
    saveCaptureNews('kbland', { at, text: kb.map(fmt).join(', '), hot: up.length > 0 });
  }

  if (naverSession.seen) {
    const s = naverSession;
    naverSession = { increase: 0, compared: new Set(), seen: 0 };
    saveCaptureNews('naver', {
      at,
      text: s.compared.size ? (s.increase ? `동그라미 매물 +${s.increase}` : '늘어난 매물 없음') : '처음 본 동그라미라 기준만',
      hot: s.increase > 0,
    });
  }

  const naverMatches = eligible(pendingNaverNews.splice(0));
  if (naverMatches.length) {
    parts.push(`네이버 ${naverMatches.length}건`);
    lines.push(`네이버: 알림 구역·금액 조건에 맞는 신규 또는 가격 인하 매물 ${naverMatches.length}건`);
    url ??= naverMatches.length === 1 ? naverMatches[0].url : `${DASHBOARD_URL}/?tab=news`;
  }
  if (!parts.length) return null;
  const alert = { title: `매물 알림: ${parts.join(', ')}`, message: lines.join('\n'), url: url ?? `${DASHBOARD_URL}/?tab=sites` };
  if (notifyUser && settings.captureSites) notify(alert.title, alert.message, alert.url);
  return alert;
}

/**
 * 아직 읽지 않은 다방 응답 중 방 목록을 매물로 바꿔 저장한다.
 * 다방 화면은 열 때 그 지도 범위 방 목록의 첫 쪽(24개)만 받고, 순서는 등록순이 아니다.
 * 신규: 이번에 읽기 전 저장된 다방 방의 가장 큰 seq보다 seq가 큰 방(seq는 등록 순서대로 커진다). 저장된 다방 방이 없으면 전부 기준(baseline).
 * 돌려주는 값: 읽은 방 수, 신규 수, 신규, 가격 변동 매물(news).
 */
export function processPendingDabangCaptures(): { fetched: number; newCount: number; baseline: boolean; news: NewsItem[] } {
  const pending = store.pendingNaverCaptures('dabang');
  const scoped = browseDabangScope;
  // 켜진 지역에 노선 탭에서 고른 노선 역 반경을 더한다(노선 탭에서 역 사이트를 열어 본 방도 남게).
  const areas = [...store.enabledAreas(), ...activeLineAreas()];
  const lists = pending.filter((r) => r.url.includes('/room-list/')).map((r) => ({ row: r, parsed: parseDabangRoomList(r.body) }));
  const byId = new Map<string, CollectedItem>();
  for (const { row, parsed } of lists) {
    if (scoped) {
      if (!matchesDabangRegionPage(scoped.scope, row.pageUrl)) {
        scoped.ledger.coverage.invalid ||= 'response-scope';
        continue;
      }
      if (isDabangMapResponse(row.url)) continue;
      if (!parsed) {
        scoped.ledger.coverage.invalid ||= 'unreadable-response';
        continue;
      }
      if (!matchesDabangRegionResponse(scoped.scope, row.url, parsed.region)) {
        scoped.ledger.coverage.invalid ||= 'response-scope';
        continue;
      }
      scoped.ledger.coverage.verified = true;
      recordDabangPage(scoped.ledger, row.url, parsed);
    }
    for (const i of parsed?.items ?? []) {
      if (scoped) {
        const dong = i.listing.dong?.trim().normalize('NFC');
        if (!dong || dong !== scoped.scope.dong) {
          const rejected = dong ? scoped.ledger.outside : scoped.ledger.unknown;
          if (!rejected.includes(i.listing.sourceId)) rejected.push(i.listing.sourceId);
          // Retain surrounding/unknown rows, but never count them as verified target coverage.
        }
      }
      byId.set(i.listing.sourceId, { listing: i.listing, raw: i.raw, pageUrl: row.pageUrl, screenshot: null });
    }
  }
  let result: ReturnType<typeof processPendingDabangCaptures> = { fetched: 0, newCount: 0, baseline: false, news: [] };
  if (byId.size && (areas.length || scoped)) {
    const maxSeq = browseDabangMax === undefined ? store.maxNumericSourceId('dabang') : browseDabangMax;
    const news: NewsItem[] = [];
    const runId = captureRunId();
    const summary = applyResults(runId, 'dabang', [...byId.values()], areas, false, undefined, {
      status: 'ok',
      ...(scoped ? { admit: (listing: NormalizedListing) => listing.dong?.trim().normalize('NFC') === scoped.scope.dong } : {}),
      isBaseline: (listing) => maxSeq == null || Number(listing.sourceId) <= maxSeq,
      allowRelistHide: (listing) => listing.floor != null,
      seenAt: pending[pending.length - 1].at,
      news,
    });
    if (scoped) {
      for (const { listing } of byId.values()) {
        const saved = store.getListing(`dabang:${listing.sourceId}`);
        if (saved?.last_seen_run !== runId || saved.data !== JSON.stringify(listing)) continue;
        const key = listing.dong?.trim().normalize('NFC') === scoped.scope.dong ? 'stored' : listing.dong ? 'retainedOutside' : 'retainedUnknown';
        const ids = scoped.ledger[key] ?? (scoped.ledger[key] = []);
        if (!ids.includes(listing.sourceId)) ids.push(listing.sourceId);
      }
    }
    const totals = lists.map((l) => l.parsed?.total).filter((t): t is number => t != null);
    addToCaptureRun(
      runId,
      summary,
      `다방: 방 ${summary.fetched}개(저장 ${summary.kept}개, 주변·지역 미확인 ${summary.incidentalCount ?? 0}개${totals.length ? `, 다방이 센 범위 안 방 ${Math.max(...totals)}개 중` : ''}), 신규 ${summary.newCount}, 가격 변동 ${summary.priceChanged}${maxSeq == null ? ', 처음이라 기준으로만 저장' : ''}`,
    );
    result = { fetched: summary.fetched, newCount: summary.newCount, baseline: maxSeq == null, news };
  }
  if (pending.length) store.markNaverCapturesParsed(pending.map((r) => r.id));
  return result;
}

/** 서울 아파트 탭에서 고른 구(aptGus)의 아파트 매매 매물이면 그 구(반경 밖이어도 저장한다). */
function naverAptGu(listing: NormalizedListing, aptGus: string[]): string | undefined {
  if (!isApartmentType(listing.buildingType) || !listing.prices.some((p) => p.deal === 'sale')) return undefined;
  const gu = /서울/.test(listing.address ?? '') ? seoulGuOf(listing.address) : null;
  return gu && aptGus.includes(gu) ? gu : undefined;
}

/** 네이버 매물 목록을 받은 한국 날짜: last 가장 최근 날, prev 그 앞에 받은 날(없으면 null) */
const LIST_DAYS_KEY = 'naver_list_days';
const kstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);

/**
 * 그 날(한국 날짜)에 목록을 받았다고 적고, 그날보다 앞서 목록을 받은 마지막 날을 돌려준다(처음이면 null).
 * 적어 둔 것이 없으면 남아 있는 화면 데이터에서 그날 전에 목록을 받은 마지막 날을 찾는다. 그보다 앞선 날의 응답이면 null.
 */
function previousListDay(day: string): string | null {
  let days: { last: string | null; prev: string | null } | null = null;
  try {
    days = JSON.parse(store.getSetting(LIST_DAYS_KEY) ?? 'null');
  } catch {
    days = null;
  }
  if (!days) {
    const before = store.lastNaverListAt(new Date(`${day}T00:00:00+09:00`).toISOString());
    days = { last: before ? kstDay(before) : null, prev: null };
  }
  if (days.last && day < days.last) return null;
  if (day !== days.last) days = { last: day, prev: days.last };
  store.setSetting(LIST_DAYS_KEY, JSON.stringify(days));
  return days.prev;
}

/** 네이버 매물 한 줄이 네이버에 올라온 날(verificationInfo.exposureStartDate, 'YYYY-MM-DD'). 모르면 null. */
const exposedOn = (raw: unknown): string | null => {
  const day = (raw as { representativeArticleInfo?: { verificationInfo?: { exposureStartDate?: unknown } } })?.representativeArticleInfo?.verificationInfo?.exposureStartDate;
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};

/**
 * 아직 읽지 않은 네이버 응답 중 매물 목록을 매물로 바꿔 저장한다.
 * 동그라미(묶음)를 누르면 그 묶음 번호(clusterId)와 안의 매물 목록이, 지도 아래 '매물 N'을 누르면 화면 안 매물 목록(boundedArticles, 묶음 번호 없음)이 30개씩 온다.
 * 처음 받은 매물 중 '신규'는 전에 눌러 본 동그라미에 새로 생긴 매물과, 네이버에 올라온 날이 지난번에 목록을 받은 날 이후인 매물이다.
 * 나머지는 기준으로만 저장한다(보는 만큼씩 들어오니, 처음 본 매물을 모두 신규로 치면 신규가 쏟아진다).
 */
export function processPendingNaverCaptures() {
  const pending = store.pendingNaverCaptures();
  if (!pending.length) return;
  // 켜진 지역에 노선 탭에서 고른 노선 역 반경을 더한다(노선 탭에서 역 사이트를 열어 본 매물도 남게).
  const areas = [...store.enabledAreas(), ...activeLineAreas()];
  const aptGus = store.aptGus();
  const marks = readMarks();
  const views = readViews();
  let marked = false;
  for (const row of pending) {
    let pathname = '';
    try {
      pathname = new URL(row.url).pathname;
    } catch {
      continue;
    }
    // 지도 동그라미별 매물 수: 같은 조건으로 전에 본 동그라미(전에 본 범위의 빈 칸에 새로 생긴 것 포함)면 늘어난 만큼 이번 확인에 더한다.
    const clusters = pathname.endsWith('/articleClusters') ? naverClusterCounts(row.requestBody, row.body) : null;
    if (clusters) {
      naverSession.seen += 1;
      const r = compareNaverClusters(marks, views, clusters, row.at);
      for (const key of r.compared) naverSession.compared.add(key);
      naverSession.increase += r.increase;
      marked = true;
      continue;
    }
    const parsed = /\/(?:boundedArticles|clusteredArticles|legalDivisionArticleList)\/?$/.test(pathname) ? parseNaverList(row.body) : null;
    if (!parsed || !parsed.items.length || !areas.length) continue;
    let clusterId: string | null = null;
    try {
      clusterId = JSON.parse(row.requestBody ?? '{}').clusterId ?? null;
    } catch {
      /* 요청 본문이 JSON이 아니면 묶음 번호 없이 저장한다 */
    }
    const seenBefore = clusterId ? store.naverCluster(clusterId) : null;
    const since = previousListDay(kstDay(row.at));
    const exposed = new Map(parsed.items.map((i) => [i.listing.sourceId, exposedOn(i.raw)]));
    const fresh = (listing: NormalizedListing) => {
      const day = exposed.get(listing.sourceId);
      return !!since && !!day && day >= since;
    };
    const items: CollectedItem[] = parsed.items.map((i) => ({ listing: i.listing, raw: i.raw, pageUrl: row.pageUrl, screenshot: null, aptGu: naverAptGu(i.listing, aptGus) }));
    const runId = captureRunId();
    const summary = applyResults(runId, 'naver', items, areas, false, undefined, {
      status: 'ok',
      // 전에 눌러 본 동그라미에서 새로 보인 매물과, 지난번에 목록을 받은 날 이후 네이버에 올라온 매물만 신규로 친다.
      isBaseline: (listing) => !seenBefore && !fresh(listing),
      // 층 숫자를 모르면(고, 중, 저) 다른 집일 수 있어 재등록으로 숨기지 않는다.
      allowRelistHide: (listing) => listing.floor != null,
      seenAt: row.at,
      news: pendingNaverNews,
    });
    if (clusterId) store.saveNaverCluster(clusterId, parsed.totalCount ?? parsed.items.length, parsed.items.flatMap((i) => i.numbers));
    const where = clusterId ? `동그라미 ${clusterId}` : /\/boundedArticles\/?$/.test(pathname) ? '화면 안 매물 목록'
      : /\/legalDivisionArticleList\/?$/.test(pathname) ? '구·동 매물 목록' : pathname;
    const rule = seenBefore ? '' : since ? `, ${since} 이후 네이버에 올라온 것만 신규` : ', 처음 받은 목록이라 기준으로만 저장';
    addToCaptureRun(runId, summary, `${where}: 매물 ${summary.fetched}건(저장 ${summary.kept}건, 주변·지역 미확인 ${summary.incidentalCount ?? 0}건), 신규 ${summary.newCount}, 가격 변동 ${summary.priceChanged}${rule}`);
  }
  if (marked) {
    writeMarks(marks);
    writeViews(views);
  }
  store.markNaverCapturesParsed(pending.map((r) => r.id));
}

/**
 * 저장된 네이버 매물의 층(floor, totalFloors, basement, rooftop)을 지금 읽는 방식으로 원본에서 다시 읽는다.
 * 층 읽기가 바뀌어도 이미 받은 매물이 다시 볼 때까지 옛 값으로 남지 않게 서버를 켤 때 부른다. 바뀐 매물 수를 돌려준다.
 */
export function refreshNaverFloors(): number {
  const rows = store.db.prepare("SELECT id, data, raw FROM listings WHERE source = 'naver' AND raw IS NOT NULL").all() as { id: string; data: string; raw: string }[];
  const update = store.db.prepare('UPDATE listings SET data = ? WHERE id = ?');
  let changed = 0;
  store.db.transaction(() => {
    for (const row of rows) {
      const item = normalizeNaverItem(JSON.parse(row.raw));
      if (!item) continue;
      const data = JSON.parse(row.data) as NormalizedListing;
      const { floor, totalFloors, basement, rooftop } = item.listing;
      if (data.floor === floor && data.totalFloors === totalFloors && data.basement === basement && data.rooftop === rooftop) continue;
      update.run(JSON.stringify({ ...data, floor, totalFloors, basement, rooftop }), row.id);
      changed++;
    }
  })();
  return changed;
}

/** 확장이 네이버 지도 위에 표시를 붙일 때 쓰는 값: 눌러 본 동그라미와 관심, 버림 매물. */
export function naverMarks() {
  const verdicts = store.allVerdicts().filter((v) => v.listing_id.startsWith('naver:'));
  return {
    clusters: store.allNaverClusters(),
    starred: verdicts.filter((v) => v.verdict === 'star').map((v) => v.listing_id.slice('naver:'.length)),
    discarded: verdicts.filter((v) => v.verdict === 'discard').map((v) => v.listing_id.slice('naver:'.length)),
  };
}

/** 아이콘을 눌렀을 때 보낸 화면 구조(HTML)와 스크린샷을 data/naver-snapshots/에 남긴다. */
export function saveSnapshot(input: { site?: unknown; pageUrl?: unknown; title?: unknown; kind?: unknown; html?: unknown; screenshot?: unknown; viewport?: unknown }) {
  if (typeof input?.html !== 'string' || input.html.length > MAX_HTML) throw new Error('화면 구조가 비었거나 너무 큽니다.');
  fs.mkdirSync(NAVER_SNAPSHOT_DIR, { recursive: true });
  const name = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(NAVER_SNAPSHOT_DIR, `${name}.html`), redact(input.html));
  fs.writeFileSync(
    path.join(NAVER_SNAPSHOT_DIR, `${name}.json`),
    JSON.stringify(
      { site: str(input.site, 20) ?? 'naver', pageUrl: str(input.pageUrl, 2000), title: str(input.title, 300), kind: str(input.kind, 20) ?? 'icon', viewport: input.viewport ?? null },
      null,
      2,
    ),
  );
  const shot = typeof input.screenshot === 'string' ? /^data:image\/jpeg;base64,(.+)$/.exec(input.screenshot) : null;
  if (shot) fs.writeFileSync(path.join(NAVER_SNAPSHOT_DIR, `${name}.jpg`), Buffer.from(shot[1], 'base64'));
  return name;
}

export function naverCaptureState() {
  const snapshots = fs.existsSync(NAVER_SNAPSHOT_DIR) ? fs.readdirSync(NAVER_SNAPSHOT_DIR).filter((f) => f.endsWith('.html')).length : 0;
  return { ...store.naverCaptureStats(), snapshots };
}

/** 대시보드 쪽 확장 파일의 버전. 확장이 이 값과 자기 버전을 비교해 다르면 스스로 다시 불러온다. */
export function extensionVersion(): string | null {
  try {
    return (JSON.parse(fs.readFileSync(EXTENSION_MANIFEST, 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}
