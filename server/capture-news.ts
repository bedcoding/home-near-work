import * as store from './db.js';
import type { CaptureNews } from '../shared/types.js';

// 크롬 확장으로 본 사이트 중 매물 수만 오는 곳(KB 동별 매물 수, 네이버 동그라미별 매물 수)을 전에 본 같은 조건의 수와 비교한다.
// 조건마다 마지막에 본 수는 설정 count_marks({ 키: { count, at } }), 네이버가 본 지도 범위는 설정 naver_views, 사이트마다 마지막 확인 결과는 설정 capture_news에 둔다.

type Marks = Record<string, { count: number; at: string }>;
const MARKS_KEY = 'count_marks';
/** 조건(키)은 최근 것부터 이만큼만 둔다. */
const MARKS_MAX = 5000;

export function readMarks(): Marks {
  try {
    const v = JSON.parse(store.getSetting(MARKS_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function writeMarks(marks: Marks) {
  const entries = Object.entries(marks);
  const kept = entries.length > MARKS_MAX ? entries.sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, MARKS_MAX) : entries;
  store.setSetting(MARKS_KEY, JSON.stringify(Object.fromEntries(kept)));
}

/** 수를 기록하고 전에 본 수와의 차이를 돌려준다. 처음 보는 키면 null. */
export function compareCount(marks: Marks, key: string, count: number, at: string): number | null {
  const prev = marks[key];
  marks[key] = { count, at };
  return prev ? count - prev.count : null;
}

/**
 * KB부동산 지도가 받는 `land-property/propList/stutCdFilter/count` 응답 하나: 법정동의 매물 수(지역매물총건수).
 * key: 법정동코드와 검색 조건(지도 범위·확대는 뺌). 모양이 다르면 null.
 */
export function kbAreaCount(requestBody: string | null, body: string): { key: string; dong: string; count: number } | null {
  try {
    const req = JSON.parse(requestBody ?? 'null') as Record<string, unknown> | null;
    const data = JSON.parse(body)?.dataBody?.data;
    const count = data?.['지역매물총건수'];
    if (!req || typeof count !== 'number') return null;
    const { zoomLevel: _z, startLat: _a, startLng: _b, endLat: _c, endLng: _d, ...cond } = req;
    return { key: `kbland|${JSON.stringify(cond)}`, dong: typeof data['법정동명'] === 'string' ? data['법정동명'] : String(req['법정동코드'] ?? '?'), count };
  } catch {
    return null;
  }
}

/** 지도 타일 범위 [확대, x0, y0, x1, y1] */
type TileBox = [number, number, number, number, number];
const tileOf = (id: string) => id.split('/').map(Number);
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const tileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat: number, z: number) => Math.floor(((1 - mercY(lat) / Math.PI) / 2) * 2 ** z);
const inBox = (b: TileBox, [z, x, y]: number[]) => b[0] === z && x >= b[1] && x <= b[3] && y >= b[2] && y <= b[4];
const within = (a: TileBox, b: TileBox) => a[0] === b[0] && a[1] >= b[1] && a[2] >= b[2] && a[3] <= b[3] && a[4] <= b[4];

/** 지도 범위(boundingBox: left, right, top, bottom)가 걸친 확대 z 타일 범위. 모르면 null. */
function tileBox(bb: unknown, z: number | null): TileBox | null {
  const b = bb as { left?: unknown; right?: unknown; top?: unknown; bottom?: unknown } | null;
  if (!b || z == null || !Number.isInteger(z)) return null;
  const { left, right, top, bottom } = b;
  if (![left, right, top, bottom].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const e = 1e-7;
  const box: TileBox = [z, tileX((left as number) + e, z), tileY((top as number) - e, z), tileX((right as number) - e, z), tileY((bottom as number) + e, z)];
  return box[1] <= box[3] && box[2] <= box[4] ? box : null;
}

/**
 * 네이버 지도가 받는 `article/map/articleClusters` 응답 하나: 동그라미(지도 타일 '확대/x/y')마다 매물 수.
 * sig: 검색 조건(filter). box: 요청한 지도 범위가 걸친 타일 범위(그 안의 매물 있는 타일은 모두 응답에 옴).
 * 타일 확대는 동그라미 번호에서, 동그라미가 없으면 요청의 precision(지도 확대)에 2를 더해 정한다. 읽지 못한 동그라미가 섞이면 box는 null.
 * 모양이 다르면 null.
 */
export function naverClusterCounts(
  requestBody: string | null,
  body: string,
): { sig: string; clusters: { id: string; count: number }[]; box: TileBox | null } | null {
  try {
    const req = JSON.parse(requestBody ?? 'null') as { filter?: unknown; precision?: unknown; boundingBox?: unknown } | null;
    const list = JSON.parse(body)?.result?.clusters;
    if (!req || !Array.isArray(list)) return null;
    const clusters = list
      .filter((c) => typeof c?.clusterId === 'string' && typeof c?.articleCount === 'number')
      .map((c) => ({ id: c.clusterId as string, count: c.articleCount as number }));
    const z = clusters.length ? tileOf(clusters[0].id)[0] : typeof req.precision === 'number' ? Math.floor(req.precision) + 2 : null;
    const box = clusters.length === list.length ? tileBox(req.boundingBox, z) : null;
    return { sig: `naver|${JSON.stringify(req.filter ?? null)}`, clusters, box };
  } catch {
    return null;
  }
}

type Views = Record<string, TileBox[]>;
const VIEWS_KEY = 'naver_views';
/** 검색 조건마다 남기는 본 지도 범위 수(오래된 것부터 버림) */
const VIEWS_MAX = 1000;

/** 네이버 검색 조건마다 본 지도 범위(설정 naver_views) */
export function readViews(): Views {
  try {
    const v = JSON.parse(store.getSetting(VIEWS_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function writeViews(views: Views) {
  store.setSetting(VIEWS_KEY, JSON.stringify(views));
}

/**
 * 네이버 지도 묶음 응답 하나(naverClusterCounts)를 전에 본 수와 비교하고 지금 수로 기록한다(키: 'sig|동그라미 번호').
 * 처음 보는 동그라미라도 전에 본 지도 범위 안이었으면(그때는 매물이 없던 칸) 0과 비교한다.
 * 지도 범위 안인데 응답에 없는 동그라미는 0으로 기록하고, 그 범위를 본 범위로 남긴다.
 * 돌려주는 값: 비교한 동그라미 키와 늘어난 수의 합.
 */
export function compareNaverClusters(
  marks: Marks,
  views: Views,
  c: NonNullable<ReturnType<typeof naverClusterCounts>>,
  at: string,
): { compared: string[]; increase: number } {
  const before = views[c.sig] ?? [];
  const compared: string[] = [];
  let increase = 0;
  const ids = new Set<string>();
  for (const x of c.clusters) {
    ids.add(x.id);
    const key = `${c.sig}|${x.id}`;
    const prev = marks[key];
    const base = prev ? prev.count : before.some((b) => inBox(b, tileOf(x.id))) ? 0 : null;
    marks[key] = { count: x.count, at };
    if (base == null) continue;
    compared.push(key);
    if (x.count > base) increase += x.count - base;
  }
  if (c.box) {
    const prefix = `${c.sig}|`;
    for (const [key, m] of Object.entries(marks)) {
      if (!m.count || !key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (!ids.has(id) && inBox(c.box, tileOf(id))) marks[key] = { count: 0, at };
    }
    const box = c.box;
    if (!before.some((b) => within(box, b))) views[c.sig] = [...before.filter((b) => !within(b, box)), box].slice(-VIEWS_MAX);
  }
  return { compared, increase };
}

const NEWS_KEY = 'capture_news';

/** 사이트마다 마지막 확인 결과 */
export function captureNews(): Partial<Record<string, CaptureNews>> {
  try {
    const v = JSON.parse(store.getSetting(NEWS_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function saveCaptureNews(site: string, news: CaptureNews) {
  store.setSetting(NEWS_KEY, JSON.stringify({ ...captureNews(), [site]: news }));
}
