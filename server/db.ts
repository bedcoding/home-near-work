import fs from 'node:fs';
import Database from 'better-sqlite3';
import { DATA_DIR, DB_PATH, RUNS_DIR } from './config.js';
import { DEFAULT_AREAS, findStation } from './stations.js';
import type {
  Area,
  AuctionResultKind,
  CourtRegionStat,
  ExcludedRow,
  NormalizedListing,
  NoticeFacts,
  NoticeSourceId,
  NoticeSourceStatus,
  NoticeView,
  RequestRow,
  RunDetail,
  RunInfo,
  RunSummary,
  SeenRef,
  SubscriptionDetail,
  Verdict,
} from '../shared/types.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RUNS_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS areas (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_m INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  visible INTEGER NOT NULL,
  summary TEXT,
  error TEXT,
  log TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  data TEXT NOT NULL,
  price_sig TEXT NOT NULL,
  lat REAL,
  lng REAL,
  first_seen_run INTEGER NOT NULL,
  last_seen_run INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  seen_ref TEXT
);
CREATE INDEX IF NOT EXISTS listings_identity ON listings(identity_key);
CREATE INDEX IF NOT EXISTS listings_source ON listings(source, status);
CREATE TABLE IF NOT EXISTS price_history (
  listing_id TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  seen_at TEXT NOT NULL,
  prices TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS price_history_listing ON price_history(listing_id);
CREATE TABLE IF NOT EXISTS verdicts (
  listing_id TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verdicts_identity ON verdicts(identity_key);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  listing_id TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL,
  acked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_listing ON events(listing_id, acked);
CREATE TABLE IF NOT EXISTS baselines (
  source TEXT NOT NULL,
  area_id INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  PRIMARY KEY (source, area_id)
);
CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  file TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_requests (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS run_requests_run ON run_requests(run_id);
CREATE TABLE IF NOT EXISTS run_excluded (
  run_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  price_text TEXT NOT NULL,
  address TEXT,
  distance_m INTEGER,
  area_name TEXT,
  url TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_excluded_run ON run_excluded(run_id);
`);

// 크롬 확장이 보낸 화면 응답. 원본 그대로 쌓는다.
db.exec(`
CREATE TABLE IF NOT EXISTS naver_captures (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  page_url TEXT,
  url TEXT NOT NULL,
  method TEXT,
  status INTEGER,
  request_body TEXT,
  body TEXT NOT NULL,
  parsed INTEGER NOT NULL DEFAULT 0
);
-- 네이버 지도에서 눌러 본 동그라미(매물 묶음). 그때 안에 있던 매물 수와 번호를 남긴다.
CREATE TABLE IF NOT EXISTS naver_clusters (
  cluster_id TEXT PRIMARY KEY,
  article_count INTEGER NOT NULL,
  article_numbers TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
-- 네이버 매물은 보는 만큼씩 들어오므로 하루에 조회 기록 하나로 묶는다.
CREATE TABLE IF NOT EXISTS naver_runs (
  day TEXT PRIMARY KEY,
  run_id INTEGER NOT NULL
);
`);
{
  // 예전 DB에 없는 칸을 붙인다. site: 어느 사이트 화면에서 받았는지(기존 행은 naver).
  const columns = (db.prepare('PRAGMA table_info(naver_captures)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('parsed')) db.exec('ALTER TABLE naver_captures ADD COLUMN parsed INTEGER NOT NULL DEFAULT 0');
  if (!columns.includes('site')) db.exec("ALTER TABLE naver_captures ADD COLUMN site TEXT NOT NULL DEFAULT 'naver'");
}

// 예전 DB에 없는 원본 데이터(raw) 칸을 붙인다.
if (!(db.prepare('PRAGMA table_info(listings)').all() as { name: string }[]).some((c) => c.name === 'raw')) {
  db.exec('ALTER TABLE listings ADD COLUMN raw TEXT');
}

// 예전 DB에 없는 자동 확인(auto) 칸과 조회 종류(kind: 'notices'면 공고만 확인) 칸을 붙인다.
if (!(db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).some((c) => c.name === 'auto')) {
  db.exec('ALTER TABLE runs ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');
}
if (!(db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).some((c) => c.name === 'kind')) {
  db.exec('ALTER TABLE runs ADD COLUMN kind TEXT');
}

export const nowIso = () => new Date().toISOString();

// ---------- 설정 값 ----------

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

// 공고(가격 없는 공매·임대 공고). 곳마다 처음 모은 것은 기준으로만 저장하고(is_new 0), 그 뒤 새로 보인 것만 새 공고로 친다.
db.exec(`
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  status TEXT,
  kind TEXT,
  place TEXT,
  posted_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  is_new INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source, source_id)
);
`);
// regions: 구 이름 JSON 배열, starts_at·ends_at: 접수 기간, detail: 청약 상세 JSON, facts: 줄에 보이는 숫자 JSON
{
  const columns = (db.prepare('PRAGMA table_info(notices)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['regions', 'starts_at', 'ends_at', 'detail', 'facts']) if (!columns.includes(c)) db.exec(`ALTER TABLE notices ADD COLUMN ${c} TEXT`);
}

// 법원경매 매각 결과(물건 하나, 매각기일 하나). key: 법원 코드-사건 번호-물건번호. 금액은 원.
// status: 법원 물건 상태 코드('02' 매각, '03' 유찰, '04' 매각허가결정 등), 경매사건검색에서 그 날 뒤 기일로 넘어가 있었으면 'moved',
// 그 날 매각되지 않았는데 다음 기일도 없으면 'unsold'.
db.exec(`
CREATE TABLE IF NOT EXISTS auction_results (
  key TEXT NOT NULL,
  sale_date TEXT NOT NULL,
  court TEXT NOT NULL,
  case_no TEXT NOT NULL,
  item_no TEXT NOT NULL,
  gu TEXT,
  dong TEXT,
  address TEXT,
  usage TEXT,
  kind TEXT NOT NULL,
  area_m2 REAL,
  lots INTEGER NOT NULL DEFAULT 1,
  failed INTEGER,
  appraisal INTEGER,
  min_price INTEGER,
  amount INTEGER,
  status TEXT NOT NULL,
  lat REAL,
  lng REAL,
  via TEXT NOT NULL,
  raw TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (key, sale_date)
);
CREATE INDEX IF NOT EXISTS auction_results_gu ON auction_results (gu, sale_date);
`);

// 법원 지역별 매각통계(구 하나, 검색 기간 하나). 같은 구와 기간을 다시 읽으면 새 값으로 바꾸고, 다른 기간은 그대로 남는다.
// period는 '2025.09 ~ 2026.10', read_at은 읽은 시각(ISO), 비율은 %, dongs는 동별 통계 JSON.
db.exec(`
CREATE TABLE IF NOT EXISTS court_region_stats (
  gu TEXT NOT NULL,
  period TEXT NOT NULL,
  read_at TEXT NOT NULL,
  auctions INTEGER NOT NULL,
  sold INTEGER NOT NULL,
  sold_rate REAL NOT NULL,
  amount_rate REAL NOT NULL,
  dongs TEXT NOT NULL,
  PRIMARY KEY (gu, period)
);
`);

export function getSetting(key: string): string | null {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---------- 공고 ----------

export interface NoticeInput {
  sourceId: string;
  title: string;
  url: string | null;
  status: string | null;
  kind: string | null;
  place: string | null;
  postedAt: string | null;
  /** 모집 지역의 서울 구 이름(모르면 비우거나 생략) */
  regions?: string[];
  /** 접수 기간 YYYY-MM-DD */
  period?: { start: string; end: string } | null;
  /** 청약 상세. 생략하면 저장된 상세를 그대로 둔다. */
  detail?: SubscriptionDetail | null;
  /** 줄에 보이는 숫자. 생략하면 저장된 값을 그대로 둔다. */
  facts?: NoticeFacts | null;
}

/** ISO 시각의 하루 전 날짜(이 컴퓨터 시각 기준 YYYY-MM-DD) */
function dayBefore(iso: string): string {
  const d = new Date(iso);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 모은 공고를 저장한다. 처음 모으는 곳이면 전부 기준으로만 저장한다. 새로 저장한 공고를 돌려준다.
 * 처음 보는 공고라도 게시일이 그 곳을 마지막으로 모은 날의 하루 전보다 이르면 새 공고로 치지 않는다
 * (목록을 더 깊이 읽거나 읽는 화면을 바꿔서 처음 보이는 예전 공고).
 * 주소·지역·접수 기간·상세·숫자는 값이 있을 때만 바꾼다(이번에 상세를 다시 읽지 않은 공고도 전에 읽은 것이 남게).
 */
export function saveNotices(source: NoticeSourceId, items: NoticeInput[], at: string): { added: NoticeInput[]; baseline: boolean } {
  const baselineKey = `notices_baseline_${source}`;
  const baselineAt = getSetting(baselineKey);
  const baseline = baselineAt == null;
  const lastAt = (db.prepare('SELECT MAX(last_seen_at) AS at FROM notices WHERE source = ?').get(source) as { at: string | null }).at ?? baselineAt;
  const oldBefore = lastAt ? dayBefore(lastAt) : null;
  const find = db.prepare('SELECT id FROM notices WHERE source = ? AND source_id = ?');
  const insert = db.prepare(
    `INSERT INTO notices (source, source_id, title, url, status, kind, place, posted_at, first_seen_at, last_seen_at, is_new, regions, starts_at, ends_at, detail, facts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE notices SET title = ?, url = COALESCE(?, url), status = ?, kind = ?, place = COALESCE(?, place), posted_at = ?, last_seen_at = ?,
       regions = COALESCE(?, regions), starts_at = COALESCE(?, starts_at), ends_at = COALESCE(?, ends_at), detail = COALESCE(?, detail), facts = COALESCE(?, facts)
     WHERE id = ?`,
  );
  const added: NoticeInput[] = [];
  db.transaction(() => {
    for (const n of items) {
      const extra = [
        n.regions?.length ? JSON.stringify(n.regions) : null,
        n.period?.start ?? null,
        n.period?.end ?? null,
        n.detail ? JSON.stringify(n.detail) : null,
        n.facts ? JSON.stringify(n.facts) : null,
      ];
      const row = find.get(source, n.sourceId) as { id: number } | undefined;
      if (row) update.run(n.title, n.url, n.status, n.kind, n.place, n.postedAt, at, ...extra, row.id);
      else {
        const isNew = !baseline && !(oldBefore && n.postedAt && n.postedAt.slice(0, 10) < oldBefore);
        insert.run(source, n.sourceId, n.title, n.url, n.status, n.kind, n.place, n.postedAt, at, at, isNew ? 1 : 0, ...extra);
        if (isNew) added.push(n);
      }
    }
    if (baseline) setSetting(baselineKey, at);
  })();
  return { added, baseline };
}

/** 상세 화면에서 구나 숫자를 이미 읽어 둔 공고 번호(그 곳의 sourceId). */
export function noticeIdsRead(source: NoticeSourceId): Set<string> {
  const rows = db
    .prepare('SELECT source_id FROM notices WHERE source = ? AND (regions IS NOT NULL OR facts IS NOT NULL OR detail IS NOT NULL)')
    .all(source) as { source_id: string }[];
  return new Set(rows.map((r) => r.source_id));
}

/** 상세를 이미 읽어 둔 공고 번호(그 곳의 sourceId). */
export function noticeIdsWithDetail(source: NoticeSourceId): Set<string> {
  const rows = db.prepare('SELECT source_id FROM notices WHERE source = ? AND detail IS NOT NULL').all(source) as { source_id: string }[];
  return new Set(rows.map((r) => r.source_id));
}

export function setNoticeStatus(source: NoticeSourceId, status: NoticeSourceStatus) {
  setSetting(`notices_status_${source}`, JSON.stringify(status));
}

export function noticeStatuses(): Partial<Record<NoticeSourceId, NoticeSourceStatus>> {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'notices_status_%'").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key.slice('notices_status_'.length), JSON.parse(r.value) as NoticeSourceStatus]));
}

/**
 * 새 공고 먼저, 그다음 게시일 최신 순.
 * current는 그 곳의 마지막 성공한 수집 시각(마지막 수집이 실패했으면 가장 늦은 last_seen_at)에 본 공고다.
 */
export function listNotices(limit = 300): NoticeView[] {
  const rows = db
    .prepare('SELECT * FROM notices ORDER BY is_new DESC, COALESCE(posted_at, first_seen_at) DESC, id DESC LIMIT ?')
    .all(limit) as {
    id: number;
    source: NoticeSourceId;
    title: string;
    url: string | null;
    status: string | null;
    kind: string | null;
    place: string | null;
    posted_at: string | null;
    first_seen_at: string;
    last_seen_at: string;
    is_new: number;
    regions: string | null;
    starts_at: string | null;
    ends_at: string | null;
    detail: string | null;
    facts: string | null;
  }[];
  const statuses = noticeStatuses();
  const latest = new Map(
    (db.prepare('SELECT source, MAX(last_seen_at) AS at FROM notices GROUP BY source').all() as { source: NoticeSourceId; at: string }[]).map((r) => [r.source, r.at]),
  );
  const lastOk = (source: NoticeSourceId) => (statuses[source]?.ok ? statuses[source]!.at : latest.get(source));
  const views: NoticeView[] = rows.map((r) => ({
    id: r.id,
    source: r.source,
    title: r.title,
    url: r.url,
    status: r.status,
    kind: r.kind,
    place: r.place,
    postedAt: r.posted_at,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    current: r.last_seen_at === lastOk(r.source),
    isNew: r.is_new === 1,
    regions: r.regions ? (JSON.parse(r.regions) as string[]) : [],
    regionsFrom: null,
    period: r.starts_at && r.ends_at ? { start: r.starts_at, end: r.ends_at } : null,
    detail: r.detail ? (JSON.parse(r.detail) as SubscriptionDetail) : null,
    facts: r.facts ? (JSON.parse(r.facts) as NoticeFacts) : null,
  }));
  // 구를 모르는 공고(SH, LH 목록 등)는 같은 제목의 고방 공고(모집 지역을 구로 줌)에서 구를 가져온다. 제목은 띄어쓰기와 괄호, 문장부호를 빼고 비교한다.
  // 그래도 모르면 제목에 든 서울 구 이름(앞 글자가 한글이 아닌 것, 예: '강동구 청년창업가…')을 쓴다.
  const key = (t: string) => t.replace(/[\s[\]()（）·.,~-]/g, '');
  const gobang = new Map(views.filter((v) => v.source === 'gobang' && v.regions.length).map((v) => [key(v.title), v.regions]));
  for (const v of views) {
    if (v.regions.length || v.source === 'gobang') continue;
    const regions = gobang.get(key(v.title));
    if (regions) Object.assign(v, { regions, regionsFrom: 'gobang' });
    else v.regions = SEOUL_GUS.filter((gu) => new RegExp(`(^|[^가-힣])${gu}`).test(v.title));
  }
  return views;
}

/** 서울 25개 구 */
const SEOUL_GUS = [
  '종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구', '강북구', '도봉구', '노원구', '은평구', '서대문구',
  '마포구', '양천구', '강서구', '구로구', '금천구', '영등포구', '동작구', '관악구', '서초구', '강남구', '송파구', '강동구',
];

export function newNoticeCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM notices WHERE is_new = 1').get() as { n: number }).n;
}

/** 새 공고 표시를 지운다(번호를 안 주면 전부). */
export function ackNotices(ids?: number[]) {
  if (!ids) db.prepare('UPDATE notices SET is_new = 0 WHERE is_new = 1').run();
  else {
    const stmt = db.prepare('UPDATE notices SET is_new = 0 WHERE id = ?');
    db.transaction(() => ids.forEach((id) => stmt.run(id)))();
  }
}

// ---------- 지역 ----------

/**
 * 지역을 마지막으로 바꾼 시각. 크롬 확장도 지역을 바꿀 수 있어서, 확장과 대시보드 중 나중에 바꾼 쪽을 따르는 데 쓴다.
 * 지역을 바꾸는 함수는 모두 이것을 갱신한다.
 */
export const areasUpdatedAt = () => getSetting('areas_updated_at');
const touchAreas = () => setSetting('areas_updated_at', nowIso());

interface AreaRow { id: number; name: string; lat: number; lng: number; radius_m: number; enabled: number }
const toArea = (r: AreaRow): Area => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, radiusM: r.radius_m, enabled: !!r.enabled });

export function listAreas(): Area[] {
  return (db.prepare('SELECT * FROM areas ORDER BY id').all() as AreaRow[]).map(toArea);
}

export function enabledAreas(): Area[] {
  return listAreas().filter((a) => a.enabled);
}

export function createArea(input: Omit<Area, 'id'>): Area {
  const info = db
    .prepare('INSERT INTO areas (name, lat, lng, radius_m, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.name, input.lat, input.lng, Math.round(input.radiusM), input.enabled ? 1 : 0, nowIso());
  touchAreas();
  return toArea(db.prepare('SELECT * FROM areas WHERE id = ?').get(info.lastInsertRowid) as AreaRow);
}

export function updateArea(id: number, patch: Partial<Omit<Area, 'id'>>): Area | null {
  const current = db.prepare('SELECT * FROM areas WHERE id = ?').get(id) as AreaRow | undefined;
  if (!current) return null;
  const next = { ...toArea(current), ...patch };
  db.prepare('UPDATE areas SET name = ?, lat = ?, lng = ?, radius_m = ?, enabled = ? WHERE id = ?')
    .run(next.name, next.lat, next.lng, Math.round(next.radiusM), next.enabled ? 1 : 0, id);
  touchAreas();
  return next;
}

export function deleteArea(id: number) {
  db.prepare('DELETE FROM areas WHERE id = ?').run(id);
  db.prepare('DELETE FROM baselines WHERE area_id = ?').run(id);
  touchAreas();
}

/**
 * 크롬 확장이 보낸 지역 목록으로 통째로 맞춘다. 번호(id)가 같은 지역은 고쳐서 기준점(첫 조회 기록)을 살리고,
 * 번호 없는 지역은 새로 만들고, 목록에 없는 지역은 지운다.
 */
export function replaceAreas(list: (Omit<Area, 'id'> & { id?: number | null })[]): Area[] {
  db.transaction(() => {
    const keep = new Set<number>();
    for (const a of list) {
      const id = a.id != null && updateArea(a.id, a) ? a.id : createArea(a).id;
      keep.add(id);
    }
    for (const a of listAreas()) if (!keep.has(a.id)) deleteArea(a.id);
    touchAreas();
  })();
  return listAreas();
}

// 처음 실행할 때만 기본 지역(config/local.json의 defaultAreas)을 만든다(지역을 다 지운 뒤 다시 켜도 되살리지 않는다).
if (!getSetting('areas_seeded')) {
  if ((db.prepare('SELECT COUNT(*) AS n FROM areas').get() as { n: number }).n === 0) {
    for (const preset of DEFAULT_AREAS) {
      const station = findStation(preset.station);
      if (station) createArea({ name: station.name, lat: station.lat, lng: station.lng, radiusM: preset.radiusM, enabled: preset.enabled });
    }
  }
  setSetting('areas_seeded', '1');
}

// ---------- 조회 기록 ----------

interface RunRow { id: number; started_at: string; finished_at: string | null; status: string; visible: number; auto: number; kind: string | null; summary: string | null; error: string | null; log: string }
const toRun = (r: RunRow): RunInfo => ({
  id: r.id,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  status: r.status as RunInfo['status'],
  visible: !!r.visible,
  auto: !!r.auto,
  noticesOnly: r.kind === 'notices',
  summary: r.summary ? (JSON.parse(r.summary) as RunSummary) : null,
  error: r.error,
});

/** auto: 자동 확인으로 시작한 조회, noticesOnly: 공고만 확인하는 조회 */
export function createRun(visible: boolean, auto = false, noticesOnly = false): number {
  return Number(
    db
      .prepare("INSERT INTO runs (started_at, status, visible, auto, kind) VALUES (?, 'running', ?, ?, ?)")
      .run(nowIso(), visible ? 1 : 0, auto ? 1 : 0, noticesOnly ? 'notices' : null).lastInsertRowid,
  );
}

export function finishRun(id: number, status: 'done' | 'error' | 'stopped', summary: RunSummary | null, error: string | null, log: string[]) {
  db.prepare('UPDATE runs SET finished_at = ?, status = ?, summary = ?, error = ?, log = ? WHERE id = ?')
    .run(nowIso(), status, summary ? JSON.stringify(summary) : null, error, JSON.stringify(log), id);
}

export function listRuns(limit = 30): RunInfo[] {
  return (db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit) as RunRow[]).map(toRun);
}

export function getRun(id: number): RunDetail | null {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  if (!row) return null;
  const screenshots = db.prepare('SELECT source, label, file FROM screenshots WHERE run_id = ? ORDER BY id').all(id) as { source: string; label: string; file: string }[];
  const requests = db
    .prepare('SELECT at, source, kind, url, status, note FROM run_requests WHERE run_id = ? ORDER BY id')
    .all(id) as RequestRow[];
  const excluded = (
    db.prepare('SELECT * FROM run_excluded WHERE run_id = ? ORDER BY distance_m').all(id) as {
      source: string; source_id: string; title: string; price_text: string; address: string | null; distance_m: number | null; area_name: string | null; url: string;
    }[]
  ).map((r) => ({ source: r.source, sourceId: r.source_id, title: r.title, priceText: r.price_text, address: r.address, distanceM: r.distance_m, areaName: r.area_name, url: r.url }));
  return { ...toRun(row), log: JSON.parse(row.log) as string[], screenshots, requests, excluded };
}

export function addRequest(runId: number, source: string, kind: RequestRow['kind'], url: string, status: number | null, note: string | null = null) {
  db.prepare('INSERT INTO run_requests (run_id, at, source, kind, url, status, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(runId, nowIso(), source, kind, url, status, note);
}

export function addExcluded(runId: number, row: ExcludedRow) {
  db.prepare('INSERT INTO run_excluded (run_id, source, source_id, title, price_text, address, distance_m, area_name, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(runId, row.source, row.sourceId, row.title, row.priceText, row.address, row.distanceM, row.areaName, row.url);
}

/**
 * 서버가 조회 도중 꺼졌던 기록은 오류로 정리한다. 서버를 켤 때만 부른다
 * (터미널 명령이 이 파일을 불러올 때 돌고 있는 조회를 오류로 바꾸지 않게).
 */
export function closeInterruptedRuns() {
  db.prepare("UPDATE runs SET status = 'error', error = '조회 도중 프로그램이 종료됐습니다.', finished_at = ? WHERE status = 'running'").run(nowIso());
}

export function addScreenshot(runId: number, source: string, label: string, file: string) {
  db.prepare('INSERT INTO screenshots (run_id, source, label, file, created_at) VALUES (?, ?, ?, ?, ?)').run(runId, source, label, file, nowIso());
}

// ---------- 매물 ----------

export interface ListingRow {
  id: string;
  source: string;
  source_id: string;
  identity_key: string;
  data: string;
  price_sig: string;
  lat: number | null;
  lng: number | null;
  first_seen_run: number;
  last_seen_run: number;
  first_seen_at: string;
  last_seen_at: string;
  status: 'active' | 'gone';
  seen_ref: string | null;
}

// 원본 데이터(raw)는 크니 목록 조회에서는 빼고, 필요할 때 따로 읽는다.
const LISTING_COLUMNS =
  'id, source, source_id, identity_key, data, price_sig, lat, lng, first_seen_run, last_seen_run, first_seen_at, last_seen_at, status, seen_ref';

export function getListing(id: string): ListingRow | undefined {
  return db.prepare(`SELECT ${LISTING_COLUMNS} FROM listings WHERE id = ?`).get(id) as ListingRow | undefined;
}

export function allListings(): ListingRow[] {
  return db.prepare(`SELECT ${LISTING_COLUMNS} FROM listings`).all() as ListingRow[];
}

/** 한 소스의 원본 데이터(raw)를 매물 번호별로 읽는다. */
export function rawBySource(source: string): Map<string, unknown> {
  const rows = db.prepare('SELECT id, raw FROM listings WHERE source = ? AND raw IS NOT NULL').all(source) as { id: string; raw: string }[];
  return new Map(rows.map((r) => [r.id, JSON.parse(r.raw)]));
}

export function listingRaw(id: string): { data: NormalizedListing; raw: unknown } | null {
  const row = db.prepare('SELECT data, raw FROM listings WHERE id = ?').get(id) as { data: string; raw: string | null } | undefined;
  if (!row) return null;
  return { data: JSON.parse(row.data) as NormalizedListing, raw: row.raw ? JSON.parse(row.raw) : null };
}

/** at: 매물을 본 시각. 네이버는 확장이 응답을 받은 시각을 준다(대시보드가 늦게 받아도 본 시각이 맞게). */
export function insertListing(id: string, l: NormalizedListing, identityKey: string, priceSig: string, runId: number, ref: SeenRef, raw: unknown, at = nowIso()) {
  const now = at;
  db.prepare(
    `INSERT INTO listings (id, source, source_id, identity_key, data, price_sig, lat, lng, first_seen_run, last_seen_run, first_seen_at, last_seen_at, status, seen_ref, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, l.source, l.sourceId, identityKey, JSON.stringify(l), priceSig, l.lat, l.lng, runId, runId, now, now, JSON.stringify(ref), raw == null ? null : JSON.stringify(raw));
  db.prepare('INSERT INTO price_history (listing_id, run_id, seen_at, prices) VALUES (?, ?, ?, ?)').run(id, runId, now, JSON.stringify(l.prices));
}

export function updateListingSeen(id: string, l: NormalizedListing, identityKey: string, priceSig: string, runId: number, ref: SeenRef, priceChanged: boolean, raw: unknown, at = nowIso()) {
  const now = at;
  // 늦게 도착한 옛 응답이 마지막 본 시각을 되돌리지 않게 더 늦은 쪽을 남긴다.
  db.prepare(
    `UPDATE listings SET identity_key = ?, data = ?, price_sig = ?, lat = ?, lng = ?, last_seen_run = ?, last_seen_at = MAX(last_seen_at, ?), status = 'active', seen_ref = ?, raw = ? WHERE id = ?`,
  ).run(identityKey, JSON.stringify(l), priceSig, l.lat, l.lng, runId, now, JSON.stringify(ref), raw == null ? null : JSON.stringify(raw), id);
  if (priceChanged) {
    db.prepare('INSERT INTO price_history (listing_id, run_id, seen_at, prices) VALUES (?, ?, ?, ?)').run(id, runId, now, JSON.stringify(l.prices));
  }
}

export function markGone(ids: string[]) {
  const stmt = db.prepare("UPDATE listings SET status = 'gone' WHERE id = ?");
  for (const id of ids) stmt.run(id);
}

// ---------- 법원경매 매각 결과 ----------

/** 저장할 매각 결과 한 건. 금액은 원, saleDate는 YYYY-MM-DD, status는 법원 물건 상태 코드나 'moved', 'unsold'. */
export interface AuctionResultInput {
  key: string;
  saleDate: string;
  court: string;
  caseNo: string;
  itemNo: string;
  gu: string | null;
  dong: string | null;
  address: string | null;
  usage: string | null;
  kind: AuctionResultKind;
  areaM2: number | null;
  lots: number;
  failed: number | null;
  appraisal: number | null;
  minPrice: number | null;
  amount: number | null;
  status: string;
  lat: number | null;
  lng: number | null;
  via: 'result' | 'case';
  raw: unknown;
}

export interface AuctionResultRow {
  key: string;
  sale_date: string;
  court: string;
  case_no: string;
  item_no: string;
  gu: string | null;
  dong: string | null;
  address: string | null;
  usage: string | null;
  kind: AuctionResultKind;
  area_m2: number | null;
  lots: number;
  failed: number | null;
  appraisal: number | null;
  min_price: number | null;
  amount: number | null;
  status: string;
  lat: number | null;
  lng: number | null;
  via: 'result' | 'case';
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * 매각 결과를 저장한다. 같은 물건과 매각기일이 이미 있으면 상태와 매각가는 새 값으로 바꾸고(매각 → 매각허가결정 → 대금납부),
 * 나머지는 새 값이 있을 때만 바꾼다.
 */
export function saveAuctionResults(rows: AuctionResultInput[], at = nowIso()) {
  const stmt = db.prepare(
    `INSERT INTO auction_results (key, sale_date, court, case_no, item_no, gu, dong, address, usage, kind, area_m2, lots, failed, appraisal, min_price, amount, status, lat, lng, via, raw, first_seen_at, last_seen_at)
     VALUES (@key, @saleDate, @court, @caseNo, @itemNo, @gu, @dong, @address, @usage, @kind, @areaM2, @lots, @failed, @appraisal, @minPrice, @amount, @status, @lat, @lng, @via, @raw, @at, @at)
     ON CONFLICT(key, sale_date) DO UPDATE SET
       status = excluded.status, amount = excluded.amount,
       gu = COALESCE(excluded.gu, gu), dong = COALESCE(excluded.dong, dong), address = COALESCE(excluded.address, address),
       usage = COALESCE(excluded.usage, usage), area_m2 = COALESCE(excluded.area_m2, area_m2), failed = COALESCE(excluded.failed, failed),
       appraisal = COALESCE(excluded.appraisal, appraisal), min_price = COALESCE(excluded.min_price, min_price),
       lat = COALESCE(excluded.lat, lat), lng = COALESCE(excluded.lng, lng), raw = excluded.raw, last_seen_at = excluded.last_seen_at`,
  );
  const save = db.transaction((list: AuctionResultInput[]) => {
    for (const r of list) stmt.run({ ...r, raw: r.raw == null ? null : JSON.stringify(r.raw), at });
  });
  save(rows);
}

/** 저장된 매각 결과(gus를 주면 그 구만, 매각기일 최근 순). */
export function auctionResultRows(gus?: string[]): AuctionResultRow[] {
  const where = gus ? `WHERE gu IN (${gus.map(() => '?').join(', ') || 'NULL'})` : '';
  return db
    .prepare(
      `SELECT key, sale_date, court, case_no, item_no, gu, dong, address, usage, kind, area_m2, lots, failed, appraisal, min_price, amount, status, lat, lng, via, first_seen_at, last_seen_at
       FROM auction_results ${where} ORDER BY sale_date DESC, gu, dong, case_no, item_no`,
    )
    .all(...(gus ?? [])) as AuctionResultRow[];
}

/** 매각기일이 from(YYYY-MM-DD) 이후인 매각 결과의 구, 종류, 상태, 매각기일, 유찰 횟수, 금액(원). 요약 계산용. */
export function auctionResultRatioRows(from: string) {
  return db
    .prepare('SELECT gu, kind, status, sale_date, failed, amount, appraisal, min_price FROM auction_results WHERE sale_date >= ?')
    .all(from) as {
    gu: string | null;
    kind: AuctionResultKind;
    status: string;
    sale_date: string;
    failed: number | null;
    amount: number | null;
    appraisal: number | null;
    min_price: number | null;
  }[];
}

/** 저장된 매각 결과의 '물건 key|매각기일' 모음 */
export function auctionResultKeys(): Set<string> {
  const rows = db.prepare('SELECT key, sale_date FROM auction_results').all() as { key: string; sale_date: string }[];
  return new Set(rows.map((r) => `${r.key}|${r.sale_date}`));
}

// ---------- 법원 지역별 매각통계 ----------

/** 지역별 매각통계 한 번을 저장한다. 같은 구와 기간이 이미 있으면 새 값으로 바꾼다. */
export function saveCourtRegionStat(s: CourtRegionStat) {
  db.prepare(
    `INSERT INTO court_region_stats (gu, period, read_at, auctions, sold, sold_rate, amount_rate, dongs)
     VALUES (@gu, @period, @at, @auctions, @sold, @soldRate, @amountRate, @dongs)
     ON CONFLICT(gu, period) DO UPDATE SET
       read_at = excluded.read_at, auctions = excluded.auctions, sold = excluded.sold,
       sold_rate = excluded.sold_rate, amount_rate = excluded.amount_rate, dongs = excluded.dongs`,
  ).run({
    gu: s.gu,
    period: s.period,
    at: s.at,
    auctions: s.auctions,
    sold: s.sold,
    soldRate: s.soldRate,
    amountRate: s.amountRate,
    dongs: JSON.stringify(s.dongs),
  });
}

/** 저장된 지역별 매각통계(gus를 주면 그 구만). 구마다 읽은 시각 최근 순. */
export function courtRegionStatRows(gus?: string[]): CourtRegionStat[] {
  const rows = db
    .prepare('SELECT gu, period, read_at, auctions, sold, sold_rate, amount_rate, dongs FROM court_region_stats ORDER BY gu, read_at DESC')
    .all() as { gu: string; period: string; read_at: string; auctions: number; sold: number; sold_rate: number; amount_rate: number; dongs: string }[];
  return rows
    .filter((r) => !gus || gus.includes(r.gu))
    .map((r) => ({
      gu: r.gu,
      period: r.period,
      at: r.read_at,
      auctions: r.auctions,
      sold: r.sold,
      soldRate: r.sold_rate,
      amountRate: r.amount_rate,
      dongs: JSON.parse(r.dongs),
    }));
}

// 설정 court_region_stats(구마다 가장 최근 통계 한 벌)에 있던 값을 표로 옮긴다.
db.transaction(() => {
  const old = getSetting('court_region_stats');
  if (!old) return;
  const { at, period, gus } = JSON.parse(old) as { at: string; period: string; gus: Omit<CourtRegionStat, 'period' | 'at'>[] };
  for (const g of gus) saveCourtRegionStat({ ...g, period, at });
  db.prepare("DELETE FROM settings WHERE key = 'court_region_stats'").run();
})();

// ---------- 판정(버림·관심) ----------

export interface VerdictRow { listing_id: string; identity_key: string; verdict: Verdict; reason: string | null; created_at: string }

export function allVerdicts(): VerdictRow[] {
  return db.prepare('SELECT * FROM verdicts').all() as VerdictRow[];
}

export function setVerdict(listingId: string, verdict: Verdict | null, reason: string | null = null) {
  if (verdict === null) {
    db.prepare('DELETE FROM verdicts WHERE listing_id = ?').run(listingId);
    return;
  }
  const listing = getListing(listingId);
  if (!listing) return;
  db.prepare(
    `INSERT INTO verdicts (listing_id, identity_key, verdict, reason, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(listing_id) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, identity_key = excluded.identity_key, created_at = excluded.created_at`,
  ).run(listingId, listing.identity_key, verdict, reason, nowIso());
}

// ---------- 변화 기록(신규·가격 변동) ----------

export interface EventRow { id: number; run_id: number; listing_id: string; type: string; detail: string | null; created_at: string; acked: number }

export function addEvent(runId: number, listingId: string, type: string, detail: unknown = null) {
  db.prepare('INSERT INTO events (run_id, listing_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(runId, listingId, type, detail == null ? null : JSON.stringify(detail), nowIso());
}

export function unackedEvents(): EventRow[] {
  return db.prepare('SELECT * FROM events WHERE acked = 0 ORDER BY id').all() as EventRow[];
}

export function ackEvents(listingId?: string) {
  if (listingId) db.prepare('UPDATE events SET acked = 1 WHERE listing_id = ?').run(listingId);
  else db.prepare('UPDATE events SET acked = 1 WHERE acked = 0').run();
}

/** 고른 매물들의 변화 기록을 확인 처리한다. */
export function ackEventsFor(listingIds: string[]) {
  const stmt = db.prepare('UPDATE events SET acked = 1 WHERE listing_id = ? AND acked = 0');
  db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id);
  })(listingIds);
}

export function unackedCount(): number {
  const row = db.prepare(
    `SELECT COUNT(DISTINCT e.listing_id) AS n FROM events e
     LEFT JOIN verdicts v ON v.listing_id = e.listing_id AND v.verdict = 'discard'
     WHERE e.acked = 0 AND e.type IN ('new', 'price_down', 'price_up', 'price_changed') AND v.listing_id IS NULL`,
  ).get() as { n: number };
  return row.n;
}

// ---------- 기준점 ----------

export function hasBaseline(source: string, areaId: number): boolean {
  return !!db.prepare('SELECT 1 FROM baselines WHERE source = ? AND area_id = ?').get(source, areaId);
}

export function setBaseline(source: string, areaId: number, runId: number) {
  db.prepare('INSERT OR IGNORE INTO baselines (source, area_id, run_id) VALUES (?, ?, ?)').run(source, areaId, runId);
}

// ---------- 네이버(크롬 확장) ----------

export interface NaverCaptureRow {
  at: string;
  /** 어느 사이트 화면에서 받았는지(naver, peterpanz …). */
  site: string;
  pageUrl: string | null;
  url: string;
  method: string | null;
  status: number | null;
  requestBody: string | null;
  body: string;
}

const NAVER_CAPTURE_KEEP = 3000;

export function addNaverCaptures(rows: NaverCaptureRow[]) {
  const insert = db.prepare('INSERT INTO naver_captures (at, site, page_url, url, method, status, request_body, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (const r of rows) insert.run(r.at, r.site, r.pageUrl, r.url, r.method, r.status, r.requestBody, r.body);
    // 오래된 것부터 지워서 최근 것만 남긴다.
    db.prepare('DELETE FROM naver_captures WHERE id <= (SELECT MAX(id) FROM naver_captures) - ?').run(NAVER_CAPTURE_KEEP);
  })();
}

/** 남아 있는 화면 데이터 중 그 사이트의 주소가 like(SQL LIKE)에 맞는 것(오래된 것부터). */
export function capturesMatching(site: string, like: string): { url: string; body: string }[] {
  return db.prepare('SELECT url, body FROM naver_captures WHERE site = ? AND url LIKE ? ORDER BY id').all(site, like) as { url: string; body: string }[];
}

/** 크롬 확장이 보낸 화면 데이터 수(사이트별). */
export function captureCountsBySite(): { site: string; total: number; lastAt: string | null }[] {
  return db.prepare('SELECT site, COUNT(*) AS total, MAX(at) AS lastAt FROM naver_captures GROUP BY site ORDER BY total DESC').all() as {
    site: string;
    total: number;
    lastAt: string | null;
  }[];
}

export function naverCaptureStats(site = 'naver'): { total: number; lastAt: string | null } {
  return db.prepare('SELECT COUNT(*) AS total, MAX(at) AS lastAt FROM naver_captures WHERE site = ?').get(site) as { total: number; lastAt: string | null };
}

export interface PendingNaverCapture {
  id: number;
  /** 확장이 응답을 받은 시각 */
  at: string;
  pageUrl: string | null;
  url: string;
  requestBody: string | null;
  body: string;
}

/** 아직 매물로 읽지 않은 그 사이트의 응답(오래된 것부터). */
export function pendingNaverCaptures(site = 'naver'): PendingNaverCapture[] {
  return db
    .prepare('SELECT id, at, page_url AS pageUrl, url, request_body AS requestBody, body FROM naver_captures WHERE parsed = 0 AND site = ? ORDER BY id')
    .all(site) as PendingNaverCapture[];
}

/** 저장된 매물 중 그 사이트 고정 번호(숫자)의 가장 큰 값. 없으면 null. */
export function maxNumericSourceId(source: string): number | null {
  const row = db.prepare('SELECT MAX(CAST(source_id AS INTEGER)) AS max FROM listings WHERE source = ?').get(source) as { max: number | null };
  return row.max;
}

export function markNaverCapturesParsed(ids: number[]) {
  const update = db.prepare('UPDATE naver_captures SET parsed = 1 WHERE id = ?');
  db.transaction(() => ids.forEach((id) => update.run(id)))();
}

export interface NaverClusterRow {
  clusterId: string;
  articleCount: number;
  articleNumbers: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export function naverCluster(clusterId: string): NaverClusterRow | null {
  const row = db.prepare('SELECT * FROM naver_clusters WHERE cluster_id = ?').get(clusterId) as
    | { cluster_id: string; article_count: number; article_numbers: string; first_seen_at: string; last_seen_at: string }
    | undefined;
  return row
    ? { clusterId: row.cluster_id, articleCount: row.article_count, articleNumbers: JSON.parse(row.article_numbers), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at }
    : null;
}

export function saveNaverCluster(clusterId: string, articleCount: number, articleNumbers: string[]) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO naver_clusters (cluster_id, article_count, article_numbers, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cluster_id) DO UPDATE SET article_count = excluded.article_count, article_numbers = excluded.article_numbers, last_seen_at = excluded.last_seen_at`,
  ).run(clusterId, articleCount, JSON.stringify(articleNumbers), now, now);
}

export function allNaverClusters(): { clusterId: string; articleCount: number; lastSeenAt: string }[] {
  return db.prepare('SELECT cluster_id AS clusterId, article_count AS articleCount, last_seen_at AS lastSeenAt FROM naver_clusters').all() as {
    clusterId: string;
    articleCount: number;
    lastSeenAt: string;
  }[];
}

export function naverRunFor(day: string): number | null {
  const row = db.prepare('SELECT run_id FROM naver_runs WHERE day = ?').get(day) as { run_id: number } | undefined;
  return row?.run_id ?? null;
}

export function setNaverRun(day: string, runId: number) {
  db.prepare('INSERT OR REPLACE INTO naver_runs (day, run_id) VALUES (?, ?)').run(day, runId);
}
