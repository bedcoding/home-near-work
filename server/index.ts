import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import open from 'open';
import { alertSettings, setAlertSettings } from './alerts.js';
import { captureNews } from './capture-news.js';
import { autoCheckState, runMissedCheck, setAutoCheck, startAutoCheck } from './auto-check.js';
import { gusFor, nearNamesFor } from './collectors/gus.js';
import { DASHBOARD_URL, HOST, PORT, RUNS_DIR, WEB_DIST } from './config.js';
import * as store from './db.js';
import { openCourtItem } from './court-viewer.js';
import { buildHouseTradeSummary, collectHouseTrades } from './house-trades.js';
import { collectAptTrades } from './apt-trades.js';
import { collectKbStats } from './kb-stats.js';
import { buildMarketView } from './market.js';
import { fillHouseholds, householdsFillState } from './building-register.js';
import { checkZones, zoneCheckState } from './land-zones.js';
import {
  acceptBrowseCaptures, acceptCaptures, browseReceipt, extensionVersion, finishCaptureSession, naverCaptureState, naverMarks, processPendingNaverCaptures, saveSnapshot, type CaptureInput,
} from './naver-capture.js';
import { learnFromStoredCaptures, withLinkHints } from './link-hints.js';
import { acceptNoticeFiles, noticeFileViews } from './notice-files.js';
import { importRedevZones, redevZones } from './redev-zones.js';
import { areaRestoreState, LINE_RADII, lineView, restoreAreas, setLineView } from './line-areas.js';
import { restSeconds } from './browser.js';
import { updateZonesNow, zoneFileCheckState } from './redev-zones-update.js';
import { getProgress, startLineRun, startRun, stopRun } from './runner.js';
import { knownStations, stationCatalog } from './station-catalog.js';
import { normalizeBrowseProgress, type BrowseProgress } from './browse-progress.js';
import { refreshTradeSignals } from './trade-signals.js';
import { collectPeakSources } from './peak-sources.js';
import { collectRegionVolume } from './region-volume.js';
import { buildAuctionResultSummary, buildAuctionResultViews, buildListingViews, withTrustFacts } from './views.js';
import { siteReport } from './site-report.js';
import { CAPTURE_SOURCES, REST_CHOICES, RUN_SCOPES, SEOUL, SOURCE_LABEL, type AppState, type Area, type RunInfo, type SourceId, type Verdict } from '../shared/types.js';

// 처리하지 못한 비동기 오류가 나도 대시보드 서버가 꺼지지 않게 기록만 남긴다.
process.on('unhandledRejection', (e) => console.error('처리하지 못한 오류:', e instanceof Error ? e.message : e));

store.closeInterruptedRuns();
const tidy = store.tidyListings();
if (tidy.stale) console.log(`네이버, 다방, 직방에서 14일 넘게 다시 못 본 매물 ${tidy.stale}건을 사라짐으로 두었습니다.`);
if (tidy.purged) console.log(`사라진 지 오래된 매물 ${tidy.purged}건을 지웠습니다.`);
// 지난번에 받아 두고 아직 매물로 읽지 않은 네이버 응답이 있으면 읽는다.
processPendingNaverCaptures();

const app = Fastify({ logger: false });

/** 크롬 확장(네이버, 다방) 하루치 기록은 '마지막 조회' 줄에서 뺀다. 그 줄은 '조회하기'로 돈 기록을 보여 준다. */
const isNaverOnly = (r: { summary: { sources: { source: string }[] } | null }) =>
  !!r.summary && r.summary.sources.length > 0 && r.summary.sources.every((s) => CAPTURE_SOURCES.includes(s.source as SourceId));

/** 소스마다 그 소스가 들어간 마지막 조회 결과(조회 중인 것은 뺀다). runs는 새것부터. */
function lastBySource(runs: RunInfo[]): AppState['lastBySource'] {
  const out: AppState['lastBySource'] = {};
  for (const r of runs) {
    // 노선 탭 조회는 회사 근처 지역이 아니라 사이트 탭의 마지막 결과로 치지 않는다.
    if (r.status === 'running' || !r.summary || r.line) continue;
    for (const s of r.summary.sources) {
      if (!out[s.source]) out[s.source] = { at: r.finishedAt ?? r.startedAt, status: s.status, kept: s.kept, error: s.error ?? null };
    }
  }
  return out;
}

app.get('/api/state', async (): Promise<AppState> => {
  const runs = store.listRuns(30);
  return {
    newNotices: store.newNoticeCount(),
    areas: store.listAreas(),
    stations: withLinkHints(knownStations()),
    running: getProgress(),
    lastRun: runs.find((r) => r.status !== 'running' && !isNaverOnly(r) && !r.noticesOnly && !r.line) ?? null,
    lastBySource: lastBySource(runs),
  unackedCount: store.unackedCount(),
    naverCapture: naverCaptureState(),
    captureSites: store.captureCountsBySite(),
    areasUpdatedAt: store.areasUpdatedAt(),
    autoCheck: autoCheckState(),
    alerts: alertSettings(),
    captureNews: captureNews(),
    gus: gusFor(store.enabledAreas()),
    nearNames: nearNamesFor(store.enabledAreas()),
    aptGus: store.aptGus(),
    householdsFill: householdsFillState(),
    zoneCheck: zoneCheckState(),
    areaRestore: areaRestoreState(),
    lineView: lineView(),
    restSeconds: restSeconds(),
    baseRate: latestBaseRate(),
  };
});

/** 받아 둔 한국은행 기준금리 표의 가장 최근 값 */
function latestBaseRate(): AppState['baseRate'] {
  const last = store.marketSeries('base-rate').at(-1);
  return last ? { value: last.value, date: last.date } : null;
}

/** 노선 탭에서 고른 노선과 역 반경을 바꾼다(line이 null이면 고르지 않음). 고른 노선 역 반경은 크롬 확장 화면 데이터를 저장할 때도 지역으로 친다. */
app.put<{ Body: { line?: unknown; radiusM?: unknown } | null }>('/api/line-view', async (req, reply) => {
  const line = req.body?.line;
  const radiusM = Number(req.body?.radiusM ?? 500);
  if ((line !== null && typeof line !== 'string') || !LINE_RADII.includes(radiusM)) {
    reply.code(400);
    return { error: `노선 이름과 반경(${LINE_RADII.join(', ')}m)이 필요합니다.` };
  }
  try {
    return { lineView: setLineView(line, radiusM) };
  } catch (e) {
    reply.code(400);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

/** 조회할 때 역, 지역, 구 사이에 쉬는 시간(초)을 바꾼다. */
app.put<{ Body: { seconds?: unknown } | null }>('/api/rest-seconds', async (req, reply) => {
  const seconds = Number(req.body?.seconds);
  if (!REST_CHOICES.includes(seconds)) {
    reply.code(400);
    return { error: `쉬는 시간은 ${REST_CHOICES.join(', ')}초 중 하나여야 합니다.` };
  }
  store.setSetting('rest_seconds', String(seconds));
  return { restSeconds: restSeconds() };
});

/** 서울 아파트 탭에서 고른 구를 통째로 바꾼다(gus: 서울 구 이름 배열). 바뀐 목록을 돌려준다. */
app.put<{ Body: { gus?: unknown } | null }>('/api/apt-gus', async (req, reply) => {
  const gus = req.body?.gus;
  if (!Array.isArray(gus) || !gus.every((g) => typeof g === 'string')) {
    reply.code(400);
    return { error: '구 이름 목록이 필요합니다.' };
  }
  return { aptGus: store.setAptGus(gus) };
});

/** 경매와 공매 아파트 단지 세대수를 건축물대장에서 지금 채운다(공공데이터포털 키가 있을 때). 결과 한 줄을 돌려준다. */
app.post('/api/apt-households/fill', async (_req, reply) => {
  try {
    return { text: await fillHouseholds() };
  } catch (e) {
    reply.code(502);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

/** 집터 경매와 공매(단독, 토지)가 재개발 쪽 구역 안인지 토지이용계획으로 지금 확인한다(브이월드 키가 있을 때). 결과 한 줄을 돌려준다. */
app.post('/api/plot-zones/check', async (_req, reply) => {
  try {
    return { text: await checkZones() };
  } catch (e) {
    reply.code(502);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

/** 단지 세대수를 넣거나 고친다(households: 1~20000 정수, null이면 지움). key는 매물의 apt.complexKey, name은 단지 이름이나 주소. */
app.put<{ Body: { key?: unknown; name?: unknown; households?: unknown } | null }>('/api/apt-complexes', async (req, reply) => {
  const { key, name, households } = req.body ?? {};
  const valid = households === null || (typeof households === 'number' && Number.isInteger(households) && households >= 1 && households <= 20000);
  if (typeof key !== 'string' || !/^(lot|nv|id):/.test(key) || key.length > 200 || !valid) {
    reply.code(400);
    return { error: '세대수는 1에서 20,000 사이 정수로 넣어 주세요.' };
  }
  store.setComplexHouseholds(key, typeof name === 'string' ? name.slice(0, 120) : '', households as number | null);
  return { ok: true };
});

/**
 * 자동 확인 시각(time: 'HH:MM', null이면 끄기), 요일(day: 0 일요일 ~ 6 토요일, null이면 매일), 창 표시(visible),
 * 공고 확인 시각(noticeTime: 'HH:MM' 매일, null이면 끄기)을 바꾼다.
 */
app.put<{ Body: { time?: unknown; day?: unknown; visible?: unknown; noticeTime?: unknown } | null }>('/api/auto-check', async (req, reply) => {
  try {
    await setAutoCheck(req.body ?? {});
    return autoCheckState();
  } catch (e) {
    reply.code(400);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

/** 가장 최근 자동 확인 시각의 확인을 아직 하지 않았으면 지금 돌린다(작업 스케줄러가 켠 start.mjs --check가 부름). */
app.post('/api/auto-check/missed', async () => ({ result: runMissedCheck() }));

/** 조회가 끝나면 띄울 알림 설정(AlertSettings, 준 값만 바꿈). 바뀐 전체 설정을 돌려준다. */
app.put<{ Body: unknown }>('/api/alerts', async (req, reply) => {
  try {
    return setAlertSettings(req.body);
  } catch (e) {
    reply.code(400);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

/** 고를 수 있는 역 전체(수도권 전철역). */
app.get('/api/stations/catalog', async () => stationCatalog());

app.get('/api/listings', async () => buildListingViews());
/** 사이트별 탭: 소스마다 최근 조회 기록, 크롬 확장 사이트마다 사이트 화면이 센 수와 받은 수 */
app.get('/api/site-report', async () => siteReport());

/** 공고(가격 없는 공매, 임대 공고)와 곳별 마지막 수집 결과. */
app.get('/api/notices', async () => ({ notices: withTrustFacts(store.listNotices()), sources: store.noticeStatuses() }));

/**
 * 켜진 지역 근처 구의 법원경매 매각 결과(매각기일 최근 순), 그 구들과 서울 전체의 지역별 매각통계(읽은 시각 최근 순, 기간마다 하나),
 * 그 구들과 서울 전체의 최근 1년 매각 결과 요약(종류별).
 */
app.get('/api/auction-results', async () => {
  const gus = gusFor(store.enabledAreas());
  return { results: buildAuctionResultViews(gus), stats: store.courtRegionStatRows([...gus, SEOUL]), compare: buildAuctionResultSummary(gus) };
});

/** 지은 지 몇 년 넘은 집을 볼지(쿼리 age, 10~100년, 없거나 잘못되면 50) */
const houseAge = (age: unknown) => {
  const n = Number(age);
  return Number.isInteger(n) && n >= 10 && n <= 100 ? n : 50;
};

/** 국토부 실거래가 단독주택 매매 중 지은 지 age년 넘은 것의 요약(서울, 계약일 최근 1년, 켜진 지역 근처 구 먼저). */
app.get<{ Querystring: { age?: string } }>('/api/house-trades', async (req) =>
  buildHouseTradeSummary(gusFor(store.enabledAreas()), houseAge(req.query.age)),
);

/** 국토부 실거래가 단독/다가구 매매를 지금 받고 요약을 돌려준다. */
app.post<{ Body: { age?: unknown } | null }>('/api/house-trades/fetch', async (req, reply) => {
  try {
    await collectHouseTrades();
    return buildHouseTradeSummary(gusFor(store.enabledAreas()), houseAge(req.body?.age));
  } catch (e) {
    reply.code(502);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

/** 시세 통계 탭: KB 지수 그래프, 지금 흐름 요약, 서울 아파트 월별 거래량, 구별 급지표(켜진 지역 근처 구 표시). */
app.get('/api/market', async () => buildMarketView(gusFor(store.enabledAreas())));

// 지도에 칠하는 정비사업 구역: 서울 열린데이터광장 '서울시 도시계획사업 현황(서울플랜+) 공간정보' ZIP을 본문 그대로 받아 바꿔 둔다.
app.addContentTypeParser(['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
app.get('/api/redev-zones', async () => ({ ...redevZones(), check: zoneFileCheckState() }));
/** 지도 아래 '새 파일 확인': 열린데이터광장 최신판을 보고 새것이면 받아 바꾼다. message는 결과 글. */
app.post('/api/redev-zones/update', async (_req, reply) => {
  try {
    const { text, view } = await updateZonesNow();
    return { ...view, check: zoneFileCheckState(), message: text };
  } catch (e) {
    reply.code(502);
    return { error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
});
app.post<{ Querystring: { name?: string } }>('/api/redev-zones', { bodyLimit: 60 * 1024 * 1024 }, async (req, reply) => {
  if (!Buffer.isBuffer(req.body)) {
    reply.code(400);
    return { error: 'ZIP 파일을 보내 주세요.' };
  }
  try {
    return { ...importRedevZones(new Uint8Array(req.body), typeof req.query.name === 'string' ? req.query.name.slice(0, 200) : null), check: zoneFileCheckState() };
  } catch (e) {
    reply.code(400);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

/**
 * 시세 통계 자료를 지금 받고 탭 자료를 돌려준다: KB 지수 모두, 고점 신호 공공 자료, 지역별 거래 건수, 서울 아파트 실거래 최근 1년과 안 받은 지난 해 모두(몇 분 걸릴 수 있다).
 * 일부만 실패하면 그 오류는 탭 자료의 kb.error, peak.sources.error, regionVolume.error, trades.error에 남고, 넷 다 실패하면 502.
 */
app.post('/api/market/fetch', async (_req, reply) => {
  const errors: string[] = [];
  const fail = (e: unknown) => errors.push(e instanceof Error ? e.message : String(e));
  await collectKbStats().catch(fail);
  await collectPeakSources().catch(fail);
  await collectRegionVolume().catch(fail);
  await collectAptTrades(undefined, { recent: true }).catch(fail);
  if (errors.length === 4) {
    reply.code(502);
    return { error: errors.join(' / ') };
  }
  return buildMarketView(gusFor(store.enabledAreas()));
});

/** 새 공고 표시를 지운다(ids가 없으면 전부). */
app.post<{ Body: { ids?: unknown } | null }>('/api/notices/ack', async (req) => {
  const ids = Array.isArray(req.body?.ids) ? req.body!.ids.map(Number).filter(Number.isInteger) : undefined;
  store.ackNotices(ids);
  return { ok: true };
});

app.get<{ Params: { id: string } }>('/api/listings/:id/raw', async (req, reply) => {
  const found = store.listingRaw(req.params.id);
  if (!found) {
    reply.code(404);
    return { error: '매물을 찾지 못했습니다.' };
  }
  return { explain: found.data.explain ?? [], raw: found.raw };
});

/** 법원경매 물건의 상세 화면을 보이는 크롬 창에 연다(사이트가 물건을 주소로 열 수 없어서 검색해서 누름). */
app.post<{ Params: { id: string } }>('/api/listings/:id/open-court', async (req, reply) => {
  const found = req.params.id.startsWith('courtauction:') ? store.listingRaw(req.params.id) : null;
  const row = Array.isArray(found?.raw) ? found.raw[0] : found?.raw;
  if (!row || typeof row !== 'object') {
    reply.code(404);
    return { error: '경매 물건을 찾지 못했습니다.' };
  }
  try {
    // HNW_VIEWER_HEADLESS=1이면 창 없이 연다.
    await openCourtItem(row as { jiwonNm?: string; srnSaNo?: string; maemulSer?: string; maeGiil?: string }, { headless: process.env.HNW_VIEWER_HEADLESS === '1' });
    return { ok: true };
  } catch (e) {
    reply.code(502);
    return { error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
});

app.post<{ Params: { id: string }; Body: { verdict: Verdict | null } }>('/api/listings/:id/verdict', async (req) => {
  store.setVerdict(req.params.id, req.body?.verdict ?? null);
  store.ackEvents(req.params.id);
  return { ok: true };
});

app.post<{ Params: { id: string } }>('/api/listings/:id/ack', async (req) => {
  store.ackEvents(req.params.id);
  return { ok: true };
});

app.post<{ Body: Omit<Area, 'id'> }>('/api/areas', async (req, reply) => {
  const { name, lat, lng, radiusM, enabled } = req.body ?? ({} as Omit<Area, 'id'>);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusM)) {
    reply.code(400);
    return { error: '지역 이름, 좌표, 반경이 필요합니다.' };
  }
  return store.createArea({ name, lat, lng, radiusM, enabled: enabled ?? true });
});

/** 노선으로 바꾸기 전에 켜 둔 지역으로 되돌린다. */
app.post('/api/areas/restore', async (_req, reply) => {
  try {
    return restoreAreas();
  } catch (e) {
    reply.code(400);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

app.put<{ Params: { id: string }; Body: Partial<Omit<Area, 'id'>> }>('/api/areas/:id', async (req, reply) => {
  const area = store.updateArea(Number(req.params.id), req.body ?? {});
  if (!area) {
    reply.code(404);
    return { error: '지역을 찾지 못했습니다.' };
  }
  return area;
});

// 확장 백그라운드(chrome-extension://)에서 온 요청만 받는다.
const fromExtension = (origin: string | undefined) => !!origin && origin.startsWith('chrome-extension://');

/**
 * 서버를 켠 뒤 처음 닿은 크롬 확장을 창에 남긴다(확장이 서버와 통신하는지 확인용).
 * 확장의 GET 요청에는 Origin이 없어서, 버전 확인 요청은 크롬에서 온 것(User-Agent)과 버전(v)으로 본다.
 */
const seenExtensions = new Set<string>();
/** 크롬 확장이 버전 확인 때 알린 자기 버전과 그 시각(ms). 서버를 다시 켜도 남게 버전이 바뀔 때 설정 extension_reported에도 쓴다. */
let extensionReport: { version: string; at: number } | null = (() => {
  try {
    return JSON.parse(store.getSetting('extension_reported') ?? 'null');
  } catch {
    return null;
  }
})();
app.addHook('onRequest', async (req) => {
  const origin = req.headers.origin;
  const versionCheck = req.url.startsWith('/api/extension/version') && String(req.headers['user-agent'] ?? '').includes('Chrome/');
  const reported = versionCheck ? new URL(req.url, 'http://local').searchParams.get('v') : null;
  if (reported) {
    if (extensionReport?.version !== reported) store.setSetting('extension_reported', JSON.stringify({ version: reported, at: Date.now() }));
    extensionReport = { version: reported, at: Date.now() };
  }
  const key = fromExtension(origin) ? origin! : versionCheck ? `버전 확인 ${reported ?? '(버전 표시 없음)'}` : null;
  if (!key || seenExtensions.has(key)) return;
  seenExtensions.add(key);
  console.log(`크롬 확장 연결: ${key} (${new Date().toLocaleTimeString('ko-KR')})`);
});

/** 크롬 확장 팝업, 지도에서 바꾼 지역 목록을 통째로 받는다. 확장에서 온 요청만 받는다. */
app.put<{ Body: { areas?: unknown } }>('/api/areas', async (req, reply) => {
  if (!fromExtension(req.headers.origin)) {
    reply.code(403);
    return { error: '크롬 확장에서 보낸 요청만 받습니다.' };
  }
  const input = Array.isArray(req.body?.areas) ? (req.body.areas as Record<string, unknown>[]) : null;
  const list = input?.map((a) => ({
    id: typeof a.id === 'number' && Number.isInteger(a.id) ? a.id : null,
    name: typeof a.name === 'string' ? a.name.trim().slice(0, 40) : '',
    lat: Number(a.lat),
    lng: Number(a.lng),
    radiusM: Math.round(Number(a.radiusM)),
    enabled: a.enabled !== false,
  }));
  const valid = (a: NonNullable<typeof list>[number]) =>
    !!a.name && Math.abs(a.lat) <= 90 && Math.abs(a.lng) <= 180 && a.radiusM >= 100 && a.radiusM <= 5000;
  // 노선 하나를 켜면 역이 75곳(1호선)까지 되므로 넉넉히 받는다.
  if (!list || list.length > 150 || !list.every(valid)) {
    reply.code(400);
    return { error: '지역 목록이 올바르지 않습니다(이름, 좌표, 반경 100~5000m, 150곳까지).' };
  }
  return { areas: store.replaceAreas(list), areasUpdatedAt: store.areasUpdatedAt() };
});

app.delete<{ Params: { id: string } }>('/api/areas/:id', async (req) => {
  store.deleteArea(Number(req.params.id));
  return { ok: true };
});

/**
 * 조회를 시작한다. scope(RUN_SCOPES의 id, 예: 'auction')를 주면 그 탭에 보이는 사이트와 공고만 돈다.
 * 예전 화면이 보내는 sources(['courtauction', 'onbid'])는 경매 범위로 본다.
 */
app.post<{ Body: { visible?: boolean; scope?: unknown; sources?: unknown } }>('/api/runs', async (req, reply) => {
  const scope = RUN_SCOPES.find((s) => s.id === req.body?.scope)?.id
    ?? (Array.isArray(req.body?.sources) && req.body!.sources.some((s) => s === 'courtauction' || s === 'onbid') ? 'auction' : undefined);
  try {
    return { runId: startRun(req.body?.visible !== false, scope) };
  } catch (e) {
    reply.code(409);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

/** 노선 탭 '이 노선 조회하기': 노선(line) 역(반경 radiusM)만 매물 사이트로 조회한다. */
app.post<{ Body: { visible?: boolean; line?: unknown; radiusM?: unknown } | null }>('/api/runs/line', async (req, reply) => {
  const line = typeof req.body?.line === 'string' ? req.body.line : '';
  const radiusM = Number(req.body?.radiusM ?? 500);
  try {
    return { runId: startLineRun(req.body?.visible !== false, line, radiusM) };
  } catch (e) {
    reply.code(409);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

/** 조회를 멈춘다. 다 모은 사이트 결과는 남는다. */
app.post('/api/runs/stop', async (_req, reply) => {
  try {
    stopRun();
    return { ok: true };
  } catch (e) {
    reply.code(409);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

// ---------- 네이버: 크롬 확장이 보내는 화면 데이터 ----------
const EXTENSION_BODY_LIMIT = 64 * 1024 * 1024;

app.post<{ Body: { captures?: CaptureInput[] } }>('/api/naver/capture', { bodyLimit: EXTENSION_BODY_LIMIT }, async (req, reply) => {
  if (!fromExtension(req.headers.origin)) {
    reply.code(403);
    return { error: '확장 프로그램에서 온 요청만 받습니다.' };
  }
  const captures = Array.isArray(req.body?.captures) ? req.body.captures.slice(0, 200) : [];
  const stored = acceptCaptures(captures);
  return { stored, total: naverCaptureState().total };
});

app.post<{ Body: { jobId?: unknown; batchId?: unknown; captures?: unknown } }>('/api/browse/capture', { bodyLimit: EXTENSION_BODY_LIMIT }, async (req, reply) => {
  if (!fromExtension(req.headers.origin)) {
    reply.code(403);
    return { error: '확장 프로그램에서 온 요청만 받습니다.' };
  }
  try {
    return { receipt: acceptBrowseCaptures(req.body ?? {}), total: naverCaptureState().total };
  } catch (error) {
    const invalid = error instanceof Error && 'statusCode' in error && error.statusCode === 400;
    reply.code(invalid ? 400 : 503);
    return { error: invalid ? error.message : '조회 응답을 저장하지 못했습니다. 같은 묶음으로 다시 시도해 주세요.' };
  }
});

app.post('/api/browse/hints', async (req, reply) => {
  if (!fromExtension(req.headers.origin)) {
    reply.code(403);
    return { error: '확장 프로그램에서 온 요청만 받습니다.' };
  }
  return { stations: withLinkHints(knownStations()) };
});

// 최신 순회의 단계, 집계, 이벤트만 로컬에 보관한다. 지역명, 좌표, URL, 매물 본문은 포함하지 않는다.
const BROWSE_PROGRESS_KEY = 'browse_progress';
function latestBrowseProgress(): BrowseProgress | null {
  try {
    const stored = JSON.parse(store.getSetting(BROWSE_PROGRESS_KEY) ?? 'null');
    return stored ? normalizeBrowseProgress(stored, stored.receivedAt) : null;
  } catch { return null; }
}
app.get('/api/browse/progress', async () => ({ progress: latestBrowseProgress() }));
app.post('/api/browse/progress', async (req, reply) => {
  if (!fromExtension(req.headers.origin)) {
    reply.code(403);
    return { error: '확장 프로그램에서 온 요청만 받습니다.' };
  }
  let progress: BrowseProgress;
  try { progress = normalizeBrowseProgress(req.body); }
  catch { reply.code(400); return { error: '조회 진행 정보가 올바르지 않습니다.' }; }
  const previous = latestBrowseProgress();
  if (previous && previous.updatedAt > progress.updatedAt) return { ok: true, ignored: true };
  store.setSetting(BROWSE_PROGRESS_KEY, JSON.stringify(progress));
  return { ok: true };
});

app.post<{ Body: { jobId?: unknown } }>('/api/browse/receipt', async (req, reply) => {
  if (!fromExtension(req.headers.origin)) {
    reply.code(403);
    return { error: '확장 프로그램에서 온 요청만 받습니다.' };
  }
  try {
    return { receipt: browseReceipt(req.body?.jobId) };
  } catch (error) {
    reply.code(400);
    return { error: error instanceof Error ? error.message : String(error) };
  }
});

app.post<{ Body: Record<string, unknown> }>('/api/naver/snapshot', { bodyLimit: EXTENSION_BODY_LIMIT }, async (req, reply) => {
  if (!fromExtension(req.headers.origin)) {
    reply.code(403);
    return { error: '확장 프로그램에서 온 요청만 받습니다.' };
  }
  try {
    return { saved: saveSnapshot(req.body ?? {}) };
  } catch (e) {
    reply.code(400);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

/** 사용자가 공고 사이트에서 직접 받은 첨부 파일(위치 path, 받은 주소 url, 받을 때 열려 있던 화면 pageUrl, 받은 시각 at). 크롬 확장에서 온 요청만 받는다. */
app.post<{ Body: { files?: unknown } }>('/api/notice-files', async (req, reply) => {
  if (!fromExtension(req.headers.origin)) {
    reply.code(403);
    return { error: '크롬 확장에서 보낸 요청만 받습니다.' };
  }
  return { accepted: acceptNoticeFiles(Array.isArray(req.body?.files) ? req.body.files : []) };
});

/** 직접 받은 공고 첨부 파일을 읽은 결과(받은 시각 최근 순, 근처는 지금 켜 둔 지역 기준). */
app.get('/api/notice-files', async () => ({ files: noticeFileViews() }));

app.get('/api/extension/version', async () => ({ version: extensionVersion() }));

/**
 * 확장 폴더의 버전(current), 크롬 확장이 마지막으로 알린 버전(reported, 몇 초 전인지 ago), 서버가 켜진 지 몇 초(uptime).
 * launcher/open-sites.mjs가 확장이 새 버전으로 바뀌는 중인지 볼 때 쓴다.
 */
app.get('/api/extension/status', async () => ({
  current: extensionVersion(),
  reported: extensionReport ? { version: extensionReport.version, ago: Math.round((Date.now() - extensionReport.at) / 1000) } : null,
  uptime: Math.round(process.uptime()),
}));

app.get('/api/naver/marks', async () => naverMarks());

app.get('/api/runs', async () => store.listRuns());

app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
  const run = store.getRun(Number(req.params.id));
  if (!run) {
    reply.code(404);
    return { error: '조회 기록을 찾지 못했습니다.' };
  }
  return run;
});

await app.register(fastifyStatic, { root: RUNS_DIR, prefix: '/runs/', decorateReply: false });

if (fs.existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '없는 주소입니다.' });
    return reply.sendFile('index.html');
  });
}

learnFromStoredCaptures();
await app.listen({ host: HOST, port: PORT });
console.log(`회사근처 내집마련: ${DASHBOARD_URL}`);
startAutoCheck();
setTimeout(() => {
  try {
    refreshTradeSignals();
  } catch (e) {
    console.error('신고가 집계 오류:', e);
  }
}, 3000);
processPendingNaverCaptures();
finishCaptureSession();
if (!fs.existsSync(WEB_DIST)) console.log('화면이 아직 빌드되지 않았습니다. 개발 중이면 npm run dev로 http://localhost:5173 을 여세요.');
if (process.argv.includes('--open')) void open(DASHBOARD_URL);
