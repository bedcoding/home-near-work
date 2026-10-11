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
import {
  acceptCaptures, extensionVersion, finishCaptureSession, naverCaptureState, naverMarks, processPendingNaverCaptures, saveSnapshot, type CaptureInput,
} from './naver-capture.js';
import { learnFromStoredCaptures, withLinkHints } from './link-hints.js';
import { getProgress, startRun, stopRun } from './runner.js';
import { knownStations, stationCatalog } from './station-catalog.js';
import { buildAuctionResultSummary, buildAuctionResultViews, buildListingViews } from './views.js';
import { CAPTURE_SOURCES, SEOUL, SOURCE_LABEL, type AppState, type Area, type RunInfo, type SourceId, type Verdict } from '../shared/types.js';

// 처리하지 못한 비동기 오류가 나도 대시보드 서버가 꺼지지 않게 기록만 남긴다.
process.on('unhandledRejection', (e) => console.error('처리하지 못한 오류:', e instanceof Error ? e.message : e));

store.closeInterruptedRuns();
// 지난번에 받아 두고 아직 매물로 읽지 않은 네이버 응답이 있으면 읽는다.
processPendingNaverCaptures();

const app = Fastify({ logger: false });

/** 크롬 확장(네이버·다방) 하루치 기록은 '마지막 조회' 줄에서 뺀다. 그 줄은 '조회하기'로 돈 기록을 보여 준다. */
const isNaverOnly = (r: { summary: { sources: { source: string }[] } | null }) =>
  !!r.summary && r.summary.sources.length > 0 && r.summary.sources.every((s) => CAPTURE_SOURCES.includes(s.source as SourceId));

/** 소스마다 그 소스가 들어간 마지막 조회 결과(조회 중인 것은 뺀다). runs는 새것부터. */
function lastBySource(runs: RunInfo[]): AppState['lastBySource'] {
  const out: AppState['lastBySource'] = {};
  for (const r of runs) {
    if (r.status === 'running' || !r.summary) continue;
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
    lastRun: runs.find((r) => r.status !== 'running' && !isNaverOnly(r) && !r.noticesOnly) ?? null,
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
  };
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

/** 공고(가격 없는 공매·임대 공고)와 곳별 마지막 수집 결과. */
app.get('/api/notices', async () => ({ notices: store.listNotices(), sources: store.noticeStatuses() }));

/**
 * 켜진 지역 근처 구의 법원경매 매각 결과(매각기일 최근 순), 그 구들과 서울 전체의 지역별 매각통계(읽은 시각 최근 순, 기간마다 하나),
 * 그 구들과 서울 전체의 최근 1년 매각 결과 요약(종류별).
 */
app.get('/api/auction-results', async () => {
  const gus = gusFor(store.enabledAreas());
  return { results: buildAuctionResultViews(gus), stats: store.courtRegionStatRows([...gus, SEOUL]), compare: buildAuctionResultSummary(gus) };
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

/** 신규·가격 변동 표시를 지운다(ids가 있으면 그 매물만, 없으면 전부). */
app.post<{ Body: { ids?: unknown } | null }>('/api/events/ack', async (req) => {
  const ids = Array.isArray(req.body?.ids) ? req.body!.ids.filter((x): x is string => typeof x === 'string') : null;
  if (ids) store.ackEventsFor(ids);
  else store.ackEvents();
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

/** 크롬 확장 팝업·지도에서 바꾼 지역 목록을 통째로 받는다. 확장에서 온 요청만 받는다. */
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
  if (!list || list.length > 30 || !list.every(valid)) {
    reply.code(400);
    return { error: '지역 목록이 올바르지 않습니다(이름, 좌표, 반경 100~5000m, 30곳까지).' };
  }
  return { areas: store.replaceAreas(list), areasUpdatedAt: store.areasUpdatedAt() };
});

app.delete<{ Params: { id: string } }>('/api/areas/:id', async (req) => {
  store.deleteArea(Number(req.params.id));
  return { ok: true };
});

/** 조회를 시작한다. sources(예: ['courtauction'])를 주면 그 사이트만 돈다. */
app.post<{ Body: { visible?: boolean; sources?: unknown } }>('/api/runs', async (req, reply) => {
  const sources = Array.isArray(req.body?.sources)
    ? req.body!.sources.filter((s): s is SourceId => typeof s === 'string' && s in SOURCE_LABEL)
    : undefined;
  try {
    return { runId: startRun(req.body?.visible !== false, sources) };
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
processPendingNaverCaptures();
finishCaptureSession();
if (!fs.existsSync(WEB_DIST)) console.log('화면이 아직 빌드되지 않았습니다. 개발 중이면 npm run dev로 http://localhost:5173 을 여세요.');
if (process.argv.includes('--open')) void open(DASHBOARD_URL);
