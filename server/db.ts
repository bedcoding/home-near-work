import fs from 'node:fs';
import Database from 'better-sqlite3';
import { DATA_DIR, DB_PATH, RUNS_DIR } from './config.js';
import { DEFAULT_AREAS, findStation } from './stations.js';
import { CAPTURE_SOURCES, SEOUL_GUS } from '../shared/types.js';
import type {
  AptRegistry,
  Area,
  AuctionResultKind,
  CourtClaims,
  CourtRegionStat,
  ExcludedRow,
  LandZone,
  LandZoneCheck,
  NormalizedListing,
  NoticeFacts,
  NoticeSourceId,
  NoticeSourceStatus,
  NoticeView,
  RequestRow,
  RunDetail,
  RunInfo,
  RunScope,
  RunSummary,
  SeenRef,
  SubscriptionDetail,
  TrustDocRound,
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
CREATE TABLE IF NOT EXISTS line_stations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
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
/** days일 전 시각(ISO) */
const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** 신규, 가격 변동, 새 공고 표시를 보이는 기간(일). 생긴 지 이보다 오래된 표시는 확인한 것과 같게 친다. */
const NEWS_DAYS = 7;
/** 이 시각(ISO) 뒤에 생긴 표시만 보인다. */
const newsSince = () => daysAgoIso(NEWS_DAYS);

// ---------- 설정 값 ----------

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

// 공고(가격 없는 공매, 임대 공고). 곳마다 처음 모은 것은 기준으로만 저장하고(is_new 0), 그 뒤 새로 보인 것만 새 공고로 친다.
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
// regions: 구 이름 JSON 배열, starts_at, ends_at: 접수 기간, detail: 청약 상세 JSON, facts: 줄에 보이는 숫자 JSON
{
  const columns = (db.prepare('PRAGMA table_info(notices)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['regions', 'starts_at', 'ends_at', 'detail', 'facts']) if (!columns.includes(c)) db.exec(`ALTER TABLE notices ADD COLUMN ${c} TEXT`);
}

// 사용자가 공고 사이트에서 직접 받은 첨부 파일(크롬 확장이 알림). path: 이 컴퓨터의 파일 위치, page_url: 받을 때 열려 있던 화면,
// notice_id: 맞춘 공고, status: ok, unsupported, error, lines: 파일에서 읽은 줄(JSON 배열).
db.exec(`
CREATE TABLE IF NOT EXISTS notice_files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  page_url TEXT,
  size INTEGER NOT NULL,
  downloaded_at TEXT NOT NULL,
  read_at TEXT NOT NULL,
  notice_id INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  lines TEXT,
  UNIQUE (path, size)
);
`);

// 신탁 공매 공고의 첨부 공고문을 받아 읽은 결과. 공고 곳과 그 곳의 공고 번호마다 하나.
// rounds: 차수별 입찰일, 개찰일, 최저가(JSON 배열, 금액은 만원), lines: 읽은 글자 줄(JSON 배열, 전화번호와 메일은 가림),
// ocr: 그림 PDF라 글자 인식으로 읽음(1), error: 받거나 읽지 못한 까닭.
db.exec(`
CREATE TABLE IF NOT EXISTS trust_docs (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  read_at TEXT NOT NULL,
  size INTEGER,
  rounds TEXT,
  lines TEXT,
  ocr INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (source, source_id)
);
`);
if (!(db.prepare('PRAGMA table_info(trust_docs)').all() as { name: string }[]).some((c) => c.name === 'ocr')) {
  db.exec('ALTER TABLE trust_docs ADD COLUMN ocr INTEGER NOT NULL DEFAULT 0');
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

// 법원경매 물건의 배당 순위 확인(court-claims). key: 법원 코드-사건 번호-물건번호(매각 결과와 같은 모양), data는 CourtClaims JSON.
db.exec(`
CREATE TABLE IF NOT EXISTS court_claims (
  key TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  data TEXT NOT NULL
);
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

// 국토부 실거래가 단독/다가구 매매(거래 하나에 한 줄). key는 구, 동, 가린 번지, 계약일, 금액, 면적, 건축년도, 주택유형을 잇고
// 뒤에 같은 줄의 순번('#1', '#2')을 붙인 것.
// contract_date YYYY-MM-DD, price 만원, 면적 ㎡, canceled_at 해제사유발생일(YYYY-MM-DD, 해제되지 않았으면 null).
db.exec(`
CREATE TABLE IF NOT EXISTS house_trades (
  key TEXT PRIMARY KEY,
  gu TEXT NOT NULL,
  dong TEXT NOT NULL,
  jibun TEXT,
  house_type TEXT NOT NULL,
  road TEXT,
  floor_m2 REAL,
  land_m2 REAL,
  contract_date TEXT NOT NULL,
  price INTEGER NOT NULL,
  built_year INTEGER,
  road_name TEXT,
  buyer TEXT,
  seller TEXT,
  canceled_at TEXT,
  deal_type TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS house_trades_date ON house_trades (contract_date);
`);

// 국토부 실거래가 전월세(거래 하나에 한 줄, 켜 둔 지역 근처 구만). key는 구, 동, 종류, 번지, 이름, 면적, 계약일, 보증금, 월세, 층, 계약 구분을
// 잇고 뒤에 같은 줄의 순번('#1', '#2')을 붙인 것. kind는 아파트, 연립다세대, 단독다가구, 오피스텔.
// area_m2는 전용면적(단독다가구는 계약면적), contract_date YYYY-MM-DD, deposit과 rent는 만원(전세는 rent 0), contract_type은 신규나 갱신(모르면 null).
db.exec(`
CREATE TABLE IF NOT EXISTS rent_trades (
  key TEXT PRIMARY KEY,
  gu TEXT NOT NULL,
  dong TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  area_m2 REAL NOT NULL,
  contract_date TEXT NOT NULL,
  deposit INTEGER NOT NULL,
  rent INTEGER NOT NULL,
  contract_type TEXT,
  built_year INTEGER,
  floor INTEGER
);
CREATE INDEX IF NOT EXISTS rent_trades_gu_date ON rent_trades (gu, contract_date);
`);

// 서울 아파트 탭에서 직접 넣은 단지 세대수. key는 AptInfo.complexKey('lot:강남구 대치동 316', 'nv:1234'), name은 넣을 때 보인 단지 이름이나 주소.
// apt_registry는 건축물대장에서 읽은 단지 정보(경매와 공매 지번 키 'lot:…'마다, 칸은 shared/types AptRegistry와 같음).
db.exec(`
CREATE TABLE IF NOT EXISTS apt_complexes (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  households INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS apt_registry (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  households INTEGER,
  buildings INTEGER,
  floors INTEGER,
  name TEXT,
  purpose TEXT,
  basis TEXT,
  error TEXT,
  checked_at TEXT NOT NULL
);
`);

// 집터 탭 경매와 공매의 재개발 구역 확인 결과(브이월드 토지이용계획). lot은 PlotZone.lot('lot:강남구 대치동 316'), pnu는 필지 번호,
// zones는 걸린 구역 목록(shared/types LandZone 배열 JSON).
db.exec(`
CREATE TABLE IF NOT EXISTS land_zones (
  lot TEXT PRIMARY KEY,
  pnu TEXT NOT NULL,
  status TEXT NOT NULL,
  zones TEXT NOT NULL,
  error TEXT,
  checked_at TEXT NOT NULL
);
`);

// 네이버 아파트 단지 좌표로 찾은 필지(브이월드 연속지적도). key는 PlotZone.lot('nv:1234'), status ok(찾음), none(그 좌표에 필지 없음), error.
// addr은 필지 주소('서울특별시 강남구 대치동 316'). 단지 자리는 바뀌지 않으므로 찾은 것은 다시 보지 않고, 실패한 것만 다음에 다시 본다.
db.exec(`
CREATE TABLE IF NOT EXISTS point_parcels (
  key TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  status TEXT NOT NULL,
  pnu TEXT,
  addr TEXT,
  error TEXT,
  checked_at TEXT NOT NULL
);
`);

// 시세 통계 탭. apt_trades는 국토부 실거래가 서울 아파트 매매(거래 하나에 한 줄, key는 구, 동, 번지, 단지명, 전용면적, 계약일, 금액, 층을 잇고
// 뒤에 같은 줄의 순번 '#1'), contract_date YYYY-MM-DD, price 만원, area_m2 전용면적 ㎡, canceled_at 해제사유발생일.
// market_series는 KB 통계 시계열(series는 kb-stats의 SERIES id, region_code는 KB 지역코드, date는 월간 YYYY-MM, 주간 YYYY-MM-DD,
// detail은 매수우위지수의 응답 비율 JSON). 시계열은 받을 때마다 통째로 바꾼다. 지역별 거래 건수(rt-volume, region-volume.ts)만 달마다 넣고 바꾼다.
db.exec(`
CREATE TABLE IF NOT EXISTS apt_trades (
  key TEXT PRIMARY KEY,
  gu TEXT NOT NULL,
  dong TEXT NOT NULL,
  jibun TEXT,
  complex TEXT NOT NULL,
  area_m2 REAL NOT NULL,
  contract_date TEXT NOT NULL,
  price INTEGER NOT NULL,
  floor INTEGER,
  built_year INTEGER,
  canceled_at TEXT,
  deal_type TEXT
);
CREATE INDEX IF NOT EXISTS apt_trades_date ON apt_trades (contract_date);
CREATE TABLE IF NOT EXISTS market_series (
  series TEXT NOT NULL,
  region_code TEXT NOT NULL,
  region_name TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL,
  detail TEXT,
  PRIMARY KEY (series, region_code, date)
);
`);

export function getSetting(key: string): string | null {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---------- 서울 아파트 탭 ----------

/** 서울 아파트 탭에서 고른 구(설정 apt_gus, SEOUL_GUS 순서). 고른 적이 없으면 빈 배열. */
export function aptGus(): string[] {
  try {
    const list: unknown = JSON.parse(getSetting('apt_gus') ?? '[]');
    return Array.isArray(list) ? SEOUL_GUS.filter((gu) => list.includes(gu)) : [];
  } catch {
    return [];
  }
}

/** 지역 밖에서 모은 고른 구 아파트의 기준점 자리 번호(구마다 음수라 켜진 지역 번호와 겹치지 않는다). 기준점 키는 '<소스>:apt'. */
export const aptSpot = (gu: string) => -(SEOUL_GUS.indexOf(gu) + 1);

/** 노선 탭 역의 자리 번호 시작(켜진 지역 번호, 아파트 구 자리(음수)와 겹치지 않게) */
export const LINE_SPOT_BASE = 1_000_000;
/** 노선 탭 역 이름의 자리 번호(기준점과 조회 범위에 씀). 처음 보는 역이면 만든다. */
export function lineStationSpot(name: string): number {
  db.prepare('INSERT OR IGNORE INTO line_stations (name, created_at) VALUES (?, ?)').run(name, nowIso());
  return LINE_SPOT_BASE + (db.prepare('SELECT id FROM line_stations WHERE name = ?').get(name) as { id: number }).id;
}

/**
 * 서울 아파트 탭에서 고른 구를 통째로 바꾼다(서울 구가 아닌 이름은 버린다). 바뀐 목록을 돌려준다.
 * 뺀 구는 아파트 기준점도 지운다(나중에 다시 고르면 그때 처음 본 것을 기준으로만 잡아 '신규'가 쏟아지지 않게).
 */
export function setAptGus(list: string[]): string[] {
  const before = aptGus();
  const next = SEOUL_GUS.filter((gu) => list.includes(gu));
  db.transaction(() => {
    setSetting('apt_gus', JSON.stringify(next));
    const drop = db.prepare("DELETE FROM baselines WHERE source LIKE '%:apt' AND area_id = ?");
    for (const gu of before) if (!next.includes(gu)) drop.run(aptSpot(gu));
  })();
  return next;
}

/** 직접 넣은 단지 세대수(단지 키 → 세대수) */
export function complexHouseholds(): Map<string, number> {
  const rows = db.prepare('SELECT key, households FROM apt_complexes').all() as { key: string; households: number }[];
  return new Map(rows.map((r) => [r.key, r.households]));
}

/** 건축물대장에서 읽은 단지 정보(단지 키 → AptRegistry) */
export function registryRows(): Map<string, AptRegistry> {
  const rows = db.prepare('SELECT * FROM apt_registry').all() as {
    key: string; status: AptRegistry['status']; households: number | null; buildings: number | null; floors: number | null;
    name: string | null; purpose: string | null; basis: AptRegistry['basis']; error: string | null; checked_at: string;
  }[];
  return new Map(
    rows.map((r) => [
      r.key,
      { status: r.status, households: r.households, buildings: r.buildings, floors: r.floors, name: r.name, purpose: r.purpose, basis: r.basis, checkedAt: r.checked_at, error: r.error },
    ]),
  );
}

/** 건축물대장에서 읽은 단지 정보를 저장한다(같은 키는 바꾼다). */
export function saveRegistry(key: string, r: AptRegistry) {
  db.prepare(
    `INSERT INTO apt_registry (key, status, households, buildings, floors, name, purpose, basis, error, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET status = excluded.status, households = excluded.households, buildings = excluded.buildings, floors = excluded.floors,
       name = excluded.name, purpose = excluded.purpose, basis = excluded.basis, error = excluded.error, checked_at = excluded.checked_at`,
  ).run(key, r.status, r.households, r.buildings, r.floors, r.name, r.purpose, r.basis, r.error, r.checkedAt);
}

/** 재개발 구역 확인 결과(지번 키 → LandZoneCheck) */
export function zoneChecks(): Map<string, LandZoneCheck> {
  const rows = db.prepare('SELECT * FROM land_zones').all() as {
    lot: string; status: LandZoneCheck['status']; zones: string; error: string | null; checked_at: string;
  }[];
  return new Map(rows.map((r) => [r.lot, { status: r.status, zones: JSON.parse(r.zones) as LandZone[], checkedAt: r.checked_at, error: r.error }]));
}

/** 재개발 구역 확인 결과를 저장한다(같은 지번은 바꾼다). */
export function saveZoneCheck(lot: string, pnu: string, c: LandZoneCheck) {
  db.prepare(
    `INSERT INTO land_zones (lot, pnu, status, zones, error, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(lot) DO UPDATE SET pnu = excluded.pnu, status = excluded.status, zones = excluded.zones, error = excluded.error, checked_at = excluded.checked_at`,
  ).run(lot, pnu, c.status, JSON.stringify(c.zones), c.error, c.checkedAt);
}

/** 좌표로 찾은 필지 하나 */
export interface PointParcel {
  status: 'ok' | 'none' | 'error';
  pnu: string | null;
  addr: string | null;
  error: string | null;
  checkedAt: string;
}

/** 네이버 단지 좌표로 찾은 필지(key → 결과) */
export function pointParcels(): Map<string, PointParcel> {
  const rows = db.prepare('SELECT key, status, pnu, addr, error, checked_at FROM point_parcels').all() as {
    key: string; status: PointParcel['status']; pnu: string | null; addr: string | null; error: string | null; checked_at: string;
  }[];
  return new Map(rows.map((r) => [r.key, { status: r.status, pnu: r.pnu, addr: r.addr, error: r.error, checkedAt: r.checked_at }]));
}

/** 좌표로 찾은 필지를 저장한다(같은 key는 바꾼다). */
export function savePointParcel(key: string, point: { lat: number; lng: number }, p: PointParcel) {
  db.prepare(
    `INSERT INTO point_parcels (key, lat, lng, status, pnu, addr, error, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, status = excluded.status, pnu = excluded.pnu,
       addr = excluded.addr, error = excluded.error, checked_at = excluded.checked_at`,
  ).run(key, point.lat, point.lng, p.status, p.pnu, p.addr, p.error, p.checkedAt);
}

/** 단지 세대수를 넣거나 고친다. households가 null이면 지운다. */
export function setComplexHouseholds(key: string, name: string, households: number | null) {
  if (households == null) {
    db.prepare('DELETE FROM apt_complexes WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO apt_complexes (key, name, households, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET name = excluded.name, households = excluded.households, updated_at = excluded.updated_at`,
  ).run(key, name, households, nowIso());
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
 * 주소, 지역, 접수 기간, 상세, 숫자는 값이 있을 때만 바꾼다(이번에 상세를 다시 읽지 않은 공고도 전에 읽은 것이 남게).
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
 * 새 공고(처음 본 지 NEWS_DAYS일 안) 먼저, 그다음 게시일 최신 순.
 * current는 그 곳의 마지막 성공한 수집 시각(마지막 수집이 실패했으면 가장 늦은 last_seen_at)에 본 공고다.
 */
export function listNotices(limit = 300): NoticeView[] {
  const since = newsSince();
  const rows = db
    .prepare('SELECT * FROM notices ORDER BY (is_new = 1 AND first_seen_at >= ?) DESC, COALESCE(posted_at, first_seen_at) DESC, id DESC LIMIT ?')
    .all(since, limit) as {
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
    isNew: r.is_new === 1 && r.first_seen_at >= since,
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

export interface NoticeFileRow {
  id: number;
  path: string;
  name: string;
  url: string | null;
  page_url: string | null;
  size: number;
  downloaded_at: string;
  read_at: string;
  notice_id: number | null;
  status: 'ok' | 'unsupported' | 'error';
  error: string | null;
  /** 읽은 줄(JSON 배열) */
  lines: string | null;
}

/** 읽은 첨부 파일을 저장한다. 같은 위치와 크기의 파일이면 고쳐 쓴다. 그 번호를 돌려준다. */
export function saveNoticeFile(f: Omit<NoticeFileRow, 'id' | 'lines'> & { lines: string[] | null }): number {
  db.prepare(`
    INSERT INTO notice_files (path, name, url, page_url, size, downloaded_at, read_at, notice_id, status, error, lines)
    VALUES (@path, @name, @url, @page_url, @size, @downloaded_at, @read_at, @notice_id, @status, @error, @lines)
    ON CONFLICT (path, size) DO UPDATE SET name = excluded.name, url = excluded.url, page_url = excluded.page_url,
      downloaded_at = excluded.downloaded_at, read_at = excluded.read_at, notice_id = excluded.notice_id,
      status = excluded.status, error = excluded.error, lines = excluded.lines
  `).run({ ...f, lines: f.lines ? JSON.stringify(f.lines) : null });
  return (db.prepare('SELECT id FROM notice_files WHERE path = ? AND size = ?').get(f.path, f.size) as { id: number }).id;
}

/** 읽은 첨부 파일(받은 시각 최근 순). */
export function noticeFileRows(limit = 100): NoticeFileRow[] {
  return db.prepare('SELECT * FROM notice_files ORDER BY downloaded_at DESC, id DESC LIMIT ?').all(limit) as NoticeFileRow[];
}

export interface TrustDocRow {
  source: NoticeSourceId;
  source_id: string;
  name: string;
  url: string | null;
  read_at: string;
  size: number | null;
  /** TrustDocRound[] JSON */
  rounds: string | null;
  /** 읽은 줄 JSON 배열 */
  lines: string | null;
  /** 글자 인식으로 읽었으면 1 */
  ocr: number;
  error: string | null;
}

/** 공고문을 읽은 결과를 저장한다(같은 공고면 바꿈). */
export function saveTrustDoc(d: Omit<TrustDocRow, 'rounds' | 'lines' | 'ocr'> & { rounds: TrustDocRound[]; lines: string[]; ocr?: boolean }) {
  db.prepare(`
    INSERT INTO trust_docs (source, source_id, name, url, read_at, size, rounds, lines, ocr, error)
    VALUES (@source, @source_id, @name, @url, @read_at, @size, @rounds, @lines, @ocr, @error)
    ON CONFLICT (source, source_id) DO UPDATE SET name = excluded.name, url = excluded.url, read_at = excluded.read_at,
      size = excluded.size, rounds = excluded.rounds, lines = excluded.lines, ocr = excluded.ocr, error = excluded.error
  `).run({ ...d, rounds: JSON.stringify(d.rounds), lines: JSON.stringify(d.lines), ocr: d.ocr ? 1 : 0 });
}

/** 한 곳에서 공고문을 읽어 본 공고 번호와 그때 시각, 오류. */
export function trustDocReads(source: NoticeSourceId): Map<string, { at: string; error: string | null }> {
  const rows = db.prepare('SELECT source_id, read_at, error FROM trust_docs WHERE source = ?').all(source) as { source_id: string; read_at: string; error: string | null }[];
  return new Map(rows.map((r) => [r.source_id, { at: r.read_at, error: r.error }]));
}

/** 공고문을 읽은 결과를 그 공고 번호(notices.id)마다(읽은 줄은 빼고 줄 수만). */
export function trustDocsByNotice(): Map<number, Omit<TrustDocRow, 'lines'> & { line_count: number }> {
  const rows = db
    .prepare(
      `SELECT n.id AS notice_id, d.source, d.source_id, d.name, d.url, d.read_at, d.size, d.rounds, d.ocr, d.error, COALESCE(json_array_length(d.lines), 0) AS line_count
       FROM trust_docs d JOIN notices n ON n.source = d.source AND n.source_id = d.source_id`,
    )
    .all() as (Omit<TrustDocRow, 'lines'> & { notice_id: number; line_count: number })[];
  return new Map(rows.map((r) => [r.notice_id, r]));
}

/** 모든 공고의 번호, 제목, 주소(첨부 파일을 공고와 맞출 때). */
export function noticeLinks(): { id: number; source: NoticeSourceId; title: string; url: string | null }[] {
  return db.prepare('SELECT id, source, title, url FROM notices').all() as { id: number; source: NoticeSourceId; title: string; url: string | null }[];
}

/** 위치와 주소를 아는 매물(사라진 것 포함). 켜 둔 지역 안 매물의 동 이름을 모을 때 쓴다. */
export function listingPlaces(): { address: string; lat: number; lng: number }[] {
  return db
    .prepare("SELECT json_extract(data, '$.address') AS address, lat, lng FROM listings WHERE lat IS NOT NULL AND lng IS NOT NULL AND json_extract(data, '$.address') IS NOT NULL")
    .all() as { address: string; lat: number; lng: number }[];
}

/** 서울 25개 구 */
export { SEOUL_GUS };

export function newNoticeCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM notices WHERE is_new = 1 AND first_seen_at >= ?').get(newsSince()) as { n: number }).n;
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
  scope: r.kind?.startsWith('scope:') ? (r.kind.slice(6) as RunScope) : null,
  line: r.kind?.startsWith('line:') ? r.kind.slice(5) : null,
  summary: r.summary ? (JSON.parse(r.summary) as RunSummary) : null,
  error: r.error,
});

/**
 * auto: 자동 확인으로 시작한 조회, noticesOnly: 공고만 확인하는 조회, scope: 탭 하나만 도는 조회(kind에 'scope:auction'처럼 남김),
 * line: 노선 탭에서 노선 역만 도는 조회(kind에 'line:2호선'처럼 남김).
 */
export function createRun(visible: boolean, auto = false, noticesOnly = false, scope: RunScope | null = null, line: string | null = null): number {
  const kind = noticesOnly ? 'notices' : scope ? `scope:${scope}` : line ? `line:${line}` : null;
  return Number(
    db.prepare("INSERT INTO runs (started_at, status, visible, auto, kind) VALUES (?, 'running', ?, ?, ?)").run(nowIso(), visible ? 1 : 0, auto ? 1 : 0, kind).lastInsertRowid,
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

/** 확장으로 받는 곳(네이버, 다방, 직방)의 매물을 사라짐으로 보는 기간(일, 마지막으로 본 때부터). 사이트를 볼 때만 받아서 내려갔는지 알 수 없다. */
const CAPTURE_STALE_DAYS = 14;
/** 사라진 매물을 남겨 두는 기간(일, 마지막으로 본 때부터). 법원경매는 매각기일이 지난 물건의 결과를 경매사건검색으로 찾는 기간만큼 남긴다. */
const GONE_KEEP_DAYS = 30;
const GONE_KEEP_DAYS_COURT = 180;

/** 매물 정리: 확장으로 받는 곳의 오래 못 본 매물을 사라짐으로 두고(stale), 남겨 두는 기간이 지난 사라진 매물을 지운다(purged). */
export function tidyListings(): { stale: number; purged: number } {
  const stale = db
    .prepare(`UPDATE listings SET status = 'gone' WHERE status = 'active' AND source IN (${CAPTURE_SOURCES.map(() => '?').join(', ')}) AND last_seen_at < ?`)
    .run(...CAPTURE_SOURCES, daysAgoIso(CAPTURE_STALE_DAYS)).changes;
  return { stale, purged: purgeGoneListings() };
}

/** 확장이 받은 목록에 아직 있는 매물(사이트 번호)의 마지막 본 시각을 at으로 올리고 사라짐을 푼다. */
export function touchListings(source: string, sourceIds: string[], at: string) {
  const stmt = db.prepare("UPDATE listings SET last_seen_at = MAX(last_seen_at, ?), status = 'active' WHERE source = ? AND source_id = ?");
  db.transaction(() => {
    for (const id of sourceIds) stmt.run(at, source, id);
  })();
}

/**
 * 사라진 매물 중 남겨 두는 기간이 지난 것을 가격 기록, 변화 기록과 함께 지운다. 관심이나 버림을 누른 매물은 남긴다.
 * 지운 매물 수를 준다.
 */
function purgeGoneListings(): number {
  const ids = (
    db
      .prepare(
        `SELECT l.id FROM listings l LEFT JOIN verdicts v ON v.listing_id = l.id
         WHERE l.status = 'gone' AND v.listing_id IS NULL
           AND l.last_seen_at < CASE WHEN l.source = 'courtauction' THEN ? ELSE ? END`,
      )
      .all(daysAgoIso(GONE_KEEP_DAYS_COURT), daysAgoIso(GONE_KEEP_DAYS)) as { id: string }[]
  ).map((r) => r.id);
  if (!ids.length) return 0;
  const stmts = ['DELETE FROM price_history WHERE listing_id = ?', 'DELETE FROM events WHERE listing_id = ?', 'DELETE FROM listings WHERE id = ?'].map((s) => db.prepare(s));
  db.transaction(() => {
    for (const id of ids) for (const stmt of stmts) stmt.run(id);
  })();
  return ids.length;
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

/** 매각기일이 from(YYYY-MM-DD) 이후인 매각 결과의 구, 종류, 용도, 상태, 매각기일, 유찰 횟수, 금액(원). 요약 계산용. */
export function auctionResultRatioRows(from: string) {
  return db
    .prepare('SELECT gu, kind, usage, status, sale_date, failed, amount, appraisal, min_price FROM auction_results WHERE sale_date >= ?')
    .all(from) as {
    gu: string | null;
    kind: AuctionResultKind;
    usage: string | null;
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

// ---------- 법원경매 배당 순위 확인 ----------

/** 저장된 배당 순위 확인 전부(key → CourtClaims) */
export function courtClaimsAll(): Map<string, CourtClaims> {
  const rows = db.prepare('SELECT key, data FROM court_claims').all() as { key: string; data: string }[];
  return new Map(rows.map((r) => [r.key, JSON.parse(r.data) as CourtClaims]));
}

/** 물건 하나의 배당 순위 확인을 저장한다(같은 key는 바꿈). */
export function saveCourtClaims(key: string, claims: CourtClaims) {
  db.prepare('INSERT OR REPLACE INTO court_claims (key, checked_at, data) VALUES (?, ?, ?)').run(key, claims.checkedAt, JSON.stringify(claims));
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

// ---------- 국토부 실거래가 단독/다가구 매매 ----------

/** 실거래 한 건(저장용). 금액은 만원, 면적은 ㎡, 날짜는 YYYY-MM-DD. */
export interface HouseTradeInput {
  key: string;
  gu: string;
  dong: string;
  jibun: string | null;
  houseType: string;
  road: string | null;
  floorM2: number | null;
  landM2: number | null;
  contractDate: string;
  price: number;
  builtYear: number | null;
  roadName: string | null;
  buyer: string | null;
  seller: string | null;
  canceledAt: string | null;
  dealType: string | null;
}

/**
 * 계약일 from ~ to(YYYY-MM-DD) 범위의 실거래를 이번에 받은 rows로 통째로 바꾼다(그 범위 밖은 그대로 남는다).
 * 같은 key가 여러 줄이면 key 뒤에 '#순번'을 붙여 따로 둔다. 전에 받은 같은 줄은 처음 본 시각을 이어받는다.
 */
export function replaceHouseTrades(from: string, to: string, rows: HouseTradeInput[], at = nowIso()) {
  const insert = db.prepare(
    `INSERT INTO house_trades (key, gu, dong, jibun, house_type, road, floor_m2, land_m2, contract_date, price, built_year, road_name, buyer, seller, canceled_at, deal_type, first_seen_at, last_seen_at)
     VALUES (@key, @gu, @dong, @jibun, @houseType, @road, @floorM2, @landM2, @contractDate, @price, @builtYear, @roadName, @buyer, @seller, @canceledAt, @dealType, @firstSeenAt, @at)`,
  );
  db.transaction(() => {
    const before = db.prepare('SELECT key, first_seen_at FROM house_trades WHERE contract_date BETWEEN ? AND ?').all(from, to) as { key: string; first_seen_at: string }[];
    const firstSeen = new Map(before.map((r) => [r.key, r.first_seen_at]));
    db.prepare('DELETE FROM house_trades WHERE contract_date BETWEEN ? AND ?').run(from, to);
    const seen = new Map<string, number>();
    for (const r of rows) {
      const n = (seen.get(r.key) ?? 0) + 1;
      seen.set(r.key, n);
      const key = `${r.key}#${n}`;
      insert.run({ ...r, key, firstSeenAt: firstSeen.get(key) ?? at, at });
    }
  })();
}

export interface HouseTradeRow {
  gu: string;
  dong: string;
  house_type: string;
  road: string | null;
  floor_m2: number | null;
  land_m2: number | null;
  contract_date: string;
  price: number;
  built_year: number | null;
  deal_type: string | null;
}

/** 계약일이 from(YYYY-MM-DD) 이후이고 해제되지 않은 단독주택 매매(다가구 제외). */
export function houseTradeRows(from: string): HouseTradeRow[] {
  return db
    .prepare(
      `SELECT gu, dong, house_type, road, floor_m2, land_m2, contract_date, price, built_year, deal_type
       FROM house_trades WHERE contract_date >= ? AND canceled_at IS NULL AND house_type = '단독'`,
    )
    .all(from) as HouseTradeRow[];
}

// ---------- 국토부 실거래가 전월세 ----------

/** 전월세 실거래 한 건(저장용). 금액은 만원(전세는 rent 0), 면적은 ㎡, 날짜는 YYYY-MM-DD. */
export interface RentTradeInput {
  key: string;
  gu: string;
  dong: string;
  kind: string;
  name: string | null;
  areaM2: number;
  contractDate: string;
  deposit: number;
  rent: number;
  contractType: string | null;
  builtYear: number | null;
  floor: number | null;
}

/** gu의 kind 전월세 중 계약일 from ~ to(YYYY-MM-DD) 범위를 rows로 통째로 바꾼다. 같은 key가 여러 줄이면 key 뒤에 '#순번'을 붙인다. */
export function replaceRentTrades(gu: string, kind: string, from: string, to: string, rows: RentTradeInput[]) {
  const insert = db.prepare(
    `INSERT INTO rent_trades (key, gu, dong, kind, name, area_m2, contract_date, deposit, rent, contract_type, built_year, floor)
     VALUES (@key, @gu, @dong, @kind, @name, @areaM2, @contractDate, @deposit, @rent, @contractType, @builtYear, @floor)`,
  );
  db.transaction(() => {
    db.prepare('DELETE FROM rent_trades WHERE gu = ? AND kind = ? AND contract_date BETWEEN ? AND ?').run(gu, kind, from, to);
    const seen = new Map<string, number>();
    for (const r of rows) {
      const n = (seen.get(r.key) ?? 0) + 1;
      seen.set(r.key, n);
      insert.run({ ...r, key: `${r.key}#${n}` });
    }
  })();
}

export interface RentTradeRow {
  gu: string;
  dong: string;
  kind: string;
  area_m2: number;
  contract_date: string;
  deposit: number;
  rent: number;
  contract_type: string | null;
}

/** 계약일이 from(YYYY-MM-DD) 이후인 gus 구의 전월세 실거래 */
export function rentTradeRows(from: string, gus: string[]): RentTradeRow[] {
  if (!gus.length) return [];
  return db
    .prepare(
      `SELECT gu, dong, kind, area_m2, contract_date, deposit, rent, contract_type
       FROM rent_trades WHERE contract_date >= ? AND gu IN (${gus.map(() => '?').join(', ')})`,
    )
    .all(from, ...gus) as RentTradeRow[];
}

/** 전월세 실거래가 한 건이라도 있는 구들 */
export function rentTradeGus(): string[] {
  return (db.prepare('SELECT DISTINCT gu FROM rent_trades').all() as { gu: string }[]).map((r) => r.gu);
}

// ---------- 시세 통계: 국토부 실거래가 아파트 매매, KB 통계 시계열 ----------

/** 아파트 실거래 한 건(저장용). 금액은 만원, 전용면적은 ㎡, 날짜는 YYYY-MM-DD. */
export interface AptTradeInput {
  key: string;
  gu: string;
  dong: string;
  jibun: string | null;
  complex: string;
  areaM2: number;
  contractDate: string;
  price: number;
  floor: number | null;
  builtYear: number | null;
  canceledAt: string | null;
  dealType: string | null;
}

/** 계약일 from ~ to(YYYY-MM-DD) 범위의 아파트 실거래를 rows로 통째로 바꾼다(범위 밖은 그대로). 같은 key가 여러 줄이면 '#순번'으로 따로 둔다. */
export function replaceAptTrades(from: string, to: string, rows: AptTradeInput[]) {
  const insert = db.prepare(
    `INSERT INTO apt_trades (key, gu, dong, jibun, complex, area_m2, contract_date, price, floor, built_year, canceled_at, deal_type)
     VALUES (@key, @gu, @dong, @jibun, @complex, @areaM2, @contractDate, @price, @floor, @builtYear, @canceledAt, @dealType)`,
  );
  db.transaction(() => {
    db.prepare('DELETE FROM apt_trades WHERE contract_date BETWEEN ? AND ?').run(from, to);
    const seen = new Map<string, number>();
    for (const r of rows) {
      const n = (seen.get(r.key) ?? 0) + 1;
      seen.set(r.key, n);
      insert.run({ ...r, key: `${r.key}#${n}` });
    }
  })();
}

export interface AptTradeRow { gu: string; dong: string; area_m2: number; price: number }

/** 계약일 from ~ to(YYYY-MM-DD)이고 해제되지 않은 아파트 매매(구별 평당가용) */
export function aptTradeRows(from: string, to: string): AptTradeRow[] {
  return db
    .prepare('SELECT gu, dong, area_m2, price FROM apt_trades WHERE contract_date BETWEEN ? AND ? AND canceled_at IS NULL AND area_m2 > 0')
    .all(from, to) as AptTradeRow[];
}

export interface CompareTradeRow { gu: string; dong: string; jibun: string | null; complex: string; area_m2: number; contract_date: string; price: number; floor: number | null }

/** 계약일이 from(YYYY-MM-DD) 이후이고 해제되지 않은 아파트 매매(매물 가격 비교용, 단지, 면적, 층까지) */
export function aptTradesSince(from: string): CompareTradeRow[] {
  return db
    .prepare(
      `SELECT gu, dong, jibun, complex, area_m2, contract_date, price, floor FROM apt_trades
       WHERE contract_date >= ? AND canceled_at IS NULL AND area_m2 > 0 ORDER BY contract_date DESC`,
    )
    .all(from) as CompareTradeRow[];
}

export interface SignalTradeRow { gu: string; dong: string; jibun: string | null; complex: string; area_m2: number; contract_date: string; price: number }

/** 해제되지 않은 아파트 매매 전부(계약일 순, 한 줄씩 읽음). 고점 신호의 신고가 집계용. */
export function iterAptTradesForSignals(): IterableIterator<SignalTradeRow> {
  return db
    .prepare(
      `SELECT gu, dong, jibun, complex, area_m2, contract_date, price FROM apt_trades
       WHERE canceled_at IS NULL AND area_m2 > 0 AND price > 0 ORDER BY contract_date, key`,
    )
    .iterate() as IterableIterator<SignalTradeRow>;
}

/** 해제되지 않은 아파트 매매의 구별, 계약 달(YYYY-MM)별 건수 */
export function aptTradeMonthCounts(): { gu: string; ym: string; count: number }[] {
  return db
    .prepare('SELECT gu, substr(contract_date, 1, 7) AS ym, COUNT(*) AS count FROM apt_trades WHERE canceled_at IS NULL GROUP BY gu, ym ORDER BY ym')
    .all() as { gu: string; ym: string; count: number }[];
}

/** KB 통계 시계열 한 점 */
export interface MarketPoint { regionCode: string; regionName: string; date: string; value: number; detail: string | null }

/** 시계열 series를 points로 통째로 바꾼다. */
export function replaceMarketSeries(series: string, points: MarketPoint[]) {
  const insert = db.prepare(
    'INSERT OR REPLACE INTO market_series (series, region_code, region_name, date, value, detail) VALUES (?, ?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    db.prepare('DELETE FROM market_series WHERE series = ?').run(series);
    for (const p of points) insert.run(series, p.regionCode, p.regionName, p.date, p.value, p.detail);
  })();
}

/** 시계열 series에 points를 넣는다(같은 지역코드와 날짜는 바꿈, 나머지 점은 그대로). */
export function upsertMarketPoints(series: string, points: MarketPoint[]) {
  const insert = db.prepare(
    'INSERT OR REPLACE INTO market_series (series, region_code, region_name, date, value, detail) VALUES (?, ?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (const p of points) insert.run(series, p.regionCode, p.regionName, p.date, p.value, p.detail);
  })();
}

/** 시계열 series의 점들(지역코드, 날짜 순) */
export function marketSeries(series: string): MarketPoint[] {
  return (
    db
      .prepare('SELECT region_code, region_name, date, value, detail FROM market_series WHERE series = ? ORDER BY region_code, date')
      .all(series) as { region_code: string; region_name: string; date: string; value: number; detail: string | null }[]
  ).map((r) => ({ regionCode: r.region_code, regionName: r.region_name, date: r.date, value: r.value, detail: r.detail }));
}

// 설정 court_region_stats(구마다 가장 최근 통계 한 벌)에 있던 값을 표로 옮긴다.
db.transaction(() => {
  const old = getSetting('court_region_stats');
  if (!old) return;
  const { at, period, gus } = JSON.parse(old) as { at: string; period: string; gus: Omit<CourtRegionStat, 'period' | 'at'>[] };
  for (const g of gus) saveCourtRegionStat({ ...g, period, at });
  db.prepare("DELETE FROM settings WHERE key = 'court_region_stats'").run();
})();

// ---------- 판정(버림, 관심) ----------

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

// ---------- 변화 기록(신규, 가격 변동) ----------

export interface EventRow { id: number; run_id: number; listing_id: string; type: string; detail: string | null; created_at: string; acked: number }

export function addEvent(runId: number, listingId: string, type: string, detail: unknown = null) {
  db.prepare('INSERT INTO events (run_id, listing_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(runId, listingId, type, detail == null ? null : JSON.stringify(detail), nowIso());
}

/** 확인하지 않았고 NEWS_DAYS일 안에 생긴 변화 기록 */
export function unackedEvents(): EventRow[] {
  return db.prepare('SELECT * FROM events WHERE acked = 0 AND created_at >= ? ORDER BY id').all(newsSince()) as EventRow[];
}

/** 매물 하나의 변화 기록을 확인 처리한다(원본을 열거나 판정할 때). */
export function ackEvents(listingId: string) {
  db.prepare('UPDATE events SET acked = 1 WHERE listing_id = ?').run(listingId);
}

export function unackedCount(): number {
  const row = db.prepare(
    `SELECT COUNT(DISTINCT e.listing_id) AS n FROM events e
     LEFT JOIN verdicts v ON v.listing_id = e.listing_id AND v.verdict = 'discard'
     WHERE e.acked = 0 AND e.created_at >= ? AND e.type IN ('new', 'price_down', 'price_up', 'price_changed') AND v.listing_id IS NULL`,
  ).get(newsSince()) as { n: number };
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

/** 그 사이트 화면 데이터를 받은 시각들(since 이후, ISO). */
export function captureTimes(site: string, since: string): string[] {
  return (db.prepare('SELECT at FROM naver_captures WHERE site = ? AND at >= ?').all(site, since) as { at: string }[]).map((r) => r.at);
}

export interface CaptureBody {
  at: string;
  url: string;
  requestBody: string | null;
  body: string;
}

/** 그 사이트의 주소가 like에 맞는 화면 데이터 중 가장 최근 것. 없으면 undefined. */
export function latestCapture(site: string, like: string): CaptureBody | undefined {
  return db.prepare('SELECT at, url, request_body AS requestBody, body FROM naver_captures WHERE site = ? AND url LIKE ? ORDER BY id DESC LIMIT 1').get(site, like) as
    | CaptureBody
    | undefined;
}

/** 그 사이트의 주소가 like에 맞는 화면 데이터 중 since 이후 것(오래된 것부터). */
export function capturesSince(site: string, like: string, since: string): CaptureBody[] {
  return db.prepare('SELECT at, url, request_body AS requestBody, body FROM naver_captures WHERE site = ? AND url LIKE ? AND at >= ? ORDER BY id').all(site, like, since) as CaptureBody[];
}

/** before(ISO)보다 앞서 네이버 매물 목록(동그라미 목록, 화면 안 매물 목록)을 받은 마지막 시각. 없으면 null. */
export function lastNaverListAt(before: string): string | null {
  const row = db
    .prepare("SELECT MAX(at) AS at FROM naver_captures WHERE site = 'naver' AND (url LIKE '%/clusteredArticles' OR url LIKE '%/boundedArticles') AND at < ?")
    .get(before) as { at: string | null };
  return row.at;
}

/** 그 소스 매물의 사이트 번호들(사라진 매물 포함). */
export function sourceIdsOf(source: string): Set<string> {
  return new Set((db.prepare('SELECT source_id FROM listings WHERE source = ?').all(source) as { source_id: string }[]).map((r) => r.source_id));
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
