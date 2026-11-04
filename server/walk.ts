import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import * as store from './db.js';
import { MAX_MARK_PINS, MAX_WALK_PINS, WALK_NAME_MAX, type WalkPin, type WalkView } from '../shared/walk.js';

// 지도 핀에서 매물까지 길을 따라 걷는 거리(m).
// 오픈스트리트맵 길을 Overpass API로 켜 둔 지역과 핀을 덮는 네모만큼 받아 data/walk/에 두고(30일 동안 다시 씀),
// 핀마다 길을 따라 가장 짧은 거리를 한 번에 구해(다익스트라) 좌표가 있는 매물마다 낸다. 핀과 매물은 가장 가까운 길 위의 점에 붙인다.

const WALK_DIR = path.join(DATA_DIR, 'walk');
const OVERPASS_URL = process.env.HNW_OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'home-near-work/1.0 (walking time to map pins)';
/** 받은 길 데이터를 다시 쓰는 기간 */
const MAX_AGE_MS = 30 * 86400000;
/** 받아 두는 길 데이터 파일 수 */
const KEEP_FILES = 3;
/** 지역 반경과 핀 둘레에 더 받는 폭(m) */
const MARGIN_M = 1000;
/** 받을 네모의 한 변이 이보다 길면 받지 않는다(m) */
const MAX_SIDE_M = 20000;
/** 받을 네모를 이 칸(도)에 맞춰 넓힌다(지역이나 핀을 조금 옮겨도 다시 받지 않게) */
const ROUND_DEG = 0.01;
/** 매물과 핀을 길에 붙일 때 이보다 멀면 길 데이터 밖으로 본다(m) */
const MAX_SNAP_M = 400;
/** 길을 따라 이만큼 넘게 걸리는 곳은 찾지 않는다(m) */
const MAX_WALK_M = 20000;
/** 길 조각을 찾는 격자 한 칸(m) */
const CELL_M = 200;
const M_PER_DEG = 111320;
const TIMEOUT_MS = 150000;
/** 서버가 바쁘다고 하면(429, 504) 이만큼 쉬고 한 번 더 부른다 */
const BUSY_WAIT_MS = 30000;

/** 남, 서, 북, 동 경계(도) */
interface Box {
  s: number;
  w: number;
  n: number;
  e: number;
}

/** 걷는 길 그래프. 좌표는 네모 가운데를 0으로 한 m, 이웃은 압축 행 꼴(start[i]부터 start[i+1] 앞까지), seg는 가장 큰 연결 덩어리의 길 조각. */
interface Graph {
  file: string;
  fetchedAt: string;
  lat0: number;
  lng0: number;
  kx: number;
  x: Float64Array;
  y: Float64Array;
  start: Int32Array;
  to: Int32Array;
  len: Float64Array;
  segA: Int32Array;
  segB: Int32Array;
  segLen: Float64Array;
  cells: Map<number, number[]>;
}

/** 길 위에 붙인 점: 길 조각 번호, 조각 위 자리(0이면 segA 끝, 1이면 segB 끝), 원래 점에서 길까지 m */
interface Snap {
  seg: number;
  t: number;
  off: number;
}

type OsmElement =
  | { type: 'node'; id: number; lat: number; lon: number }
  | { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string> };

export class WalkError extends Error {}

/** 걸을 수 있는 길인지(오픈스트리트맵 highway와 foot, access, sidewalk 태그). 도시고속도로(trunk)는 보도 표시가 있을 때만. */
const WALK_HIGHWAYS = new Set([
  'footway', 'path', 'pedestrian', 'steps', 'corridor', 'living_street', 'residential', 'service', 'unclassified', 'road', 'track', 'cycleway',
  'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link',
]);
function walkable(tags: Record<string, string>): boolean {
  const foot = tags.foot ?? '';
  if (/^(yes|designated|permissive)$/.test(foot)) return true;
  if (/^(no|private)$/.test(foot) || /^(no|private)$/.test(tags.access ?? '')) return false;
  if (tags.highway === 'trunk' || tags.highway === 'trunk_link') return /^(both|left|right|yes)$/.test(tags.sidewalk ?? '');
  return WALK_HIGHWAYS.has(tags.highway ?? '');
}

const overpassQuery = (b: Box) => `[out:json][timeout:120];
way["highway"]["highway"!~"^(motorway|motorway_link|construction|proposed|abandoned|platform|raceway|bus_guideway|escape|bridleway|busway|bus_stop|elevator)$"](${b.s},${b.w},${b.n},${b.e});
out body qt;
>;
out skel qt;`;

const lngDeg = (m: number, lat: number) => m / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
const contains = (a: Box, b: Box) => a.s <= b.s && a.w <= b.w && a.n >= b.n && a.e >= b.e;
const fileName = (b: Box) => `osm-${[b.s, b.w, b.n, b.e].map((v) => v.toFixed(2)).join('_')}.json`;

/** 켜 둔 지역(반경 + 폭)과 핀(+ 폭)을 모두 덮는 네모 */
function neededBox(pins: WalkPin[]): Box {
  const points = [
    ...store.enabledAreas().map((a) => ({ lat: a.lat, lng: a.lng, r: a.radiusM + MARGIN_M })),
    ...pins.map((p) => ({ lat: p.lat, lng: p.lng, r: MARGIN_M })),
  ];
  if (points.length === 0) throw new WalkError('켜 둔 지역이나 핀이 없습니다.');
  const box = { s: Infinity, w: Infinity, n: -Infinity, e: -Infinity };
  for (const p of points) {
    box.s = Math.min(box.s, p.lat - p.r / M_PER_DEG);
    box.n = Math.max(box.n, p.lat + p.r / M_PER_DEG);
    box.w = Math.min(box.w, p.lng - lngDeg(p.r, p.lat));
    box.e = Math.max(box.e, p.lng + lngDeg(p.r, p.lat));
  }
  const tall = (box.n - box.s) * M_PER_DEG;
  const wide = (box.e - box.w) * M_PER_DEG * Math.cos((((box.s + box.n) / 2) * Math.PI) / 180);
  if (Math.max(tall, wide) > MAX_SIDE_M) throw new WalkError('핀이 켜 둔 지역에서 너무 멀어 걷는 길을 재지 않습니다.');
  return box;
}

/** 네모를 ROUND_DEG 칸에 맞춰 바깥으로 넓힌다 */
function roundBox(b: Box): Box {
  const down = (v: number) => Math.floor(v / ROUND_DEG) * ROUND_DEG;
  const up = (v: number) => Math.ceil(v / ROUND_DEG) * ROUND_DEG;
  return { s: down(b.s), w: down(b.w), n: up(b.n), e: up(b.e) };
}

/** 받아 둔 파일들(네모, 받은 시각, 경로). 새 것부터. */
function cachedFiles(): { box: Box; at: number; file: string }[] {
  if (!fs.existsSync(WALK_DIR)) return [];
  const out: { box: Box; at: number; file: string }[] = [];
  for (const name of fs.readdirSync(WALK_DIR)) {
    const m = /^osm-(-?[\d.]+)_(-?[\d.]+)_(-?[\d.]+)_(-?[\d.]+)\.json$/.exec(name);
    if (!m) continue;
    const file = path.join(WALK_DIR, name);
    out.push({ box: { s: Number(m[1]), w: Number(m[2]), n: Number(m[3]), e: Number(m[4]) }, at: fs.statSync(file).mtimeMs, file });
  }
  return out.sort((a, b) => b.at - a.at);
}

let fetching: Promise<string> | null = null;

/** 네모 안 걷는 길 후보를 Overpass에서 받아 파일로 둔다(한 번에 하나만 받음). 오래된 파일은 KEEP_FILES개만 남긴다. */
function fetchOsm(box: Box): Promise<string> {
  fetching ??= (async () => {
    try {
      const call = () =>
        fetch(OVERPASS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: `data=${encodeURIComponent(overpassQuery(box))}`,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      let res = await call();
      if (res.status === 429 || res.status === 504) {
        await new Promise((r) => setTimeout(r, BUSY_WAIT_MS));
        res = await call();
      }
      if (!res.ok) throw new Error(`오픈스트리트맵 길 데이터를 받지 못했습니다(상태 ${res.status}).`);
      const text = await res.text();
      if (!text.trimStart().startsWith('{') || !text.includes('"elements"')) throw new Error('오픈스트리트맵 길 데이터가 예상과 다릅니다.');
      fs.mkdirSync(WALK_DIR, { recursive: true });
      const file = path.join(WALK_DIR, fileName(box));
      fs.writeFileSync(file, text);
      for (const old of cachedFiles().slice(KEEP_FILES)) fs.rmSync(old.file, { force: true });
      return file;
    } finally {
      fetching = null;
    }
  })();
  return fetching;
}

const cellKey = (cx: number, cy: number) => (cx + 50000) * 100000 + (cy + 50000);

/** 받은 파일로 그래프를 만든다(가장 큰 연결 덩어리만 붙일 곳으로 씀). */
function buildGraph(file: string, box: Box, fetchedAt: string): Graph {
  const elements = (JSON.parse(fs.readFileSync(file, 'utf8')) as { elements: OsmElement[] }).elements;
  const pos = new Map<number, [number, number]>();
  for (const el of elements) if (el.type === 'node') pos.set(el.id, [el.lat, el.lon]);
  const lat0 = (box.s + box.n) / 2;
  const lng0 = (box.w + box.e) / 2;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const index = new Map<number, number>();
  const xs: number[] = [];
  const ys: number[] = [];
  const ea: number[] = [];
  const eb: number[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !walkable(el.tags ?? {})) continue;
    let prev = -1;
    for (const id of el.nodes) {
      const p = pos.get(id);
      if (!p) {
        prev = -1;
        continue;
      }
      let i = index.get(id);
      if (i === undefined) {
        i = xs.length;
        index.set(id, i);
        xs.push((p[1] - lng0) * kx);
        ys.push((p[0] - lat0) * M_PER_DEG);
      }
      if (prev >= 0 && prev !== i) {
        ea.push(prev);
        eb.push(i);
      }
      prev = i;
    }
  }
  const n = xs.length;
  const x = Float64Array.from(xs);
  const y = Float64Array.from(ys);
  const start = new Int32Array(n + 1);
  for (let k = 0; k < ea.length; k++) {
    start[ea[k] + 1]++;
    start[eb[k] + 1]++;
  }
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const cursor = start.slice(0, n);
  const to = new Int32Array(ea.length * 2);
  const len = new Float64Array(ea.length * 2);
  for (let k = 0; k < ea.length; k++) {
    const a = ea[k];
    const b = eb[k];
    const d = Math.hypot(x[a] - x[b], y[a] - y[b]);
    to[cursor[a]] = b;
    len[cursor[a]++] = d;
    to[cursor[b]] = a;
    len[cursor[b]++] = d;
  }

  // 연결 덩어리: 끊긴 보도 조각에 매물이나 핀이 붙으면 길이 없다고 나오므로 가장 큰 덩어리만 쓴다.
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const c = sizes.length;
    let size = 0;
    comp[s] = c;
    stack.push(s);
    while (stack.length) {
      const u = stack.pop()!;
      size++;
      for (let k = start[u]; k < start[u + 1]; k++) {
        if (comp[to[k]] < 0) {
          comp[to[k]] = c;
          stack.push(to[k]);
        }
      }
    }
    sizes.push(size);
  }
  const big = sizes.indexOf(Math.max(...sizes));
  const segA: number[] = [];
  const segB: number[] = [];
  const cells = new Map<number, number[]>();
  for (let k = 0; k < ea.length; k++) {
    if (comp[ea[k]] !== big) continue;
    const s = segA.length;
    segA.push(ea[k]);
    segB.push(eb[k]);
    const x1 = Math.floor(Math.min(x[ea[k]], x[eb[k]]) / CELL_M);
    const x2 = Math.floor(Math.max(x[ea[k]], x[eb[k]]) / CELL_M);
    const y1 = Math.floor(Math.min(y[ea[k]], y[eb[k]]) / CELL_M);
    const y2 = Math.floor(Math.max(y[ea[k]], y[eb[k]]) / CELL_M);
    for (let cx = x1; cx <= x2; cx++) {
      for (let cy = y1; cy <= y2; cy++) {
        const key = cellKey(cx, cy);
        const list = cells.get(key);
        if (list) list.push(s);
        else cells.set(key, [s]);
      }
    }
  }
  const segLen = Float64Array.from(segA, (a, s) => Math.hypot(x[a] - x[segB[s]], y[a] - y[segB[s]]));
  return { file, fetchedAt, lat0, lng0, kx, x, y, start, to, len, segA: Int32Array.from(segA), segB: Int32Array.from(segB), segLen, cells };
}

/** 점(위도, 경도)을 가장 가까운 길 조각 위에 붙인다. MAX_SNAP_M 안에 길이 없으면 null. */
function snap(g: Graph, lat: number, lng: number): Snap | null {
  const px = (lng - g.lng0) * g.kx;
  const py = (lat - g.lat0) * M_PER_DEG;
  const cx = Math.floor(px / CELL_M);
  const cy = Math.floor(py / CELL_M);
  const rings = Math.ceil(MAX_SNAP_M / CELL_M) + 1;
  let best: Snap | null = null;
  for (let r = 0; r <= rings; r++) {
    if (best && (r - 1) * CELL_M > best.off) break;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const list = g.cells.get(cellKey(cx + dx, cy + dy));
        if (!list) continue;
        for (const s of list) {
          const ax = g.x[g.segA[s]];
          const ay = g.y[g.segA[s]];
          const vx = g.x[g.segB[s]] - ax;
          const vy = g.y[g.segB[s]] - ay;
          const l2 = vx * vx + vy * vy;
          const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0;
          const off = Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
          if (!best || off < best.off) best = { seg: s, t, off };
        }
      }
    }
  }
  return best && best.off <= MAX_SNAP_M ? best : null;
}

/** 붙인 점에서 길을 따라 모든 꼭짓점까지 가장 짧은 거리(m, 못 가면 Infinity) */
function shortest(g: Graph, from: Snap): Float64Array {
  const dist = new Float64Array(g.x.length).fill(Infinity);
  const keys: number[] = [];
  const nodes: number[] = [];
  const push = (d: number, v: number) => {
    let i = keys.length;
    keys.push(d);
    nodes.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= d) break;
      keys[i] = keys[p];
      nodes[i] = nodes[p];
      i = p;
    }
    keys[i] = d;
    nodes[i] = v;
  };
  const pop = (): [number, number] => {
    const top: [number, number] = [keys[0], nodes[0]];
    const d = keys.pop()!;
    const v = nodes.pop()!;
    if (keys.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= keys.length) break;
        const c = l + 1 < keys.length && keys[l + 1] < keys[l] ? l + 1 : l;
        if (keys[c] >= d) break;
        keys[i] = keys[c];
        nodes[i] = nodes[c];
        i = c;
      }
      keys[i] = d;
      nodes[i] = v;
    }
    return top;
  };
  const relax = (v: number, d: number) => {
    if (d < dist[v]) {
      dist[v] = d;
      push(d, v);
    }
  };
  const l = g.segLen[from.seg];
  relax(g.segA[from.seg], from.off + from.t * l);
  relax(g.segB[from.seg], from.off + (1 - from.t) * l);
  while (keys.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    if (d > MAX_WALK_M) break;
    for (let k = g.start[u]; k < g.start[u + 1]; k++) relax(g.to[k], d + g.len[k]);
  }
  return dist;
}

/** 핀에서 붙인 점까지 길을 따라 걷는 거리(m). 같은 길 조각 위면 조각을 따라 바로 가는 길도 본다. */
function walkTo(g: Graph, dist: Float64Array, pin: Snap, at: Snap): number {
  const l = g.segLen[at.seg];
  let d = Math.min(dist[g.segA[at.seg]] + at.t * l, dist[g.segB[at.seg]] + (1 - at.t) * l);
  if (at.seg === pin.seg) d = Math.min(d, pin.off + Math.abs(at.t - pin.t) * l);
  return d + at.off;
}

let cached: Graph | null = null;

/** 네모를 덮는 길 그래프(받아 둔 파일이 30일 안이면 그것, 아니면 새로 받음) */
async function graphFor(box: Box): Promise<Graph> {
  const hit = cachedFiles().find((f) => contains(f.box, box) && Date.now() - f.at < MAX_AGE_MS);
  const file = hit?.file ?? (await fetchOsm(roundBox(box)));
  if (cached?.file !== file) {
    const meta = cachedFiles().find((f) => f.file === file)!;
    cached = buildGraph(file, meta.box, new Date(meta.at).toISOString());
  }
  return cached;
}

/** 요청 본문의 핀 목록을 확인한다(MAX_WALK_PINS개까지, 위도와 경도는 숫자). 잘못됐으면 null. */
export function walkPinsOf(input: unknown): WalkPin[] | null {
  if (!Array.isArray(input) || input.length > MAX_WALK_PINS) return null;
  const pins: WalkPin[] = [];
  for (const p of input as Partial<WalkPin>[]) {
    if (typeof p?.id !== 'string' || !/^[\w-]{1,20}$/.test(p.id) || pins.some((x) => x.id === p.id)) return null;
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number' || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return null;
    pins.push({ id: p.id, name: String(p.name ?? '').slice(0, WALK_NAME_MAX), lat: p.lat, lng: p.lng });
  }
  return pins;
}

/** 요청 본문의 표시 핀 목록을 확인한다(MAX_MARK_PINS개까지). 없으면 빈 목록, 잘못됐으면 null. */
export function markPinsOf(input: unknown): WalkPin[] | null {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > MAX_MARK_PINS) return null;
  const marks: WalkPin[] = [];
  for (const p of input as Partial<WalkPin>[]) {
    if (typeof p?.id !== 'string' || !/^[\w-]{1,20}$/.test(p.id) || marks.some((x) => x.id === p.id)) return null;
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number' || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return null;
    marks.push({ id: p.id, name: '', lat: p.lat, lng: p.lng });
  }
  return marks;
}

/**
 * 핀들에서 좌표가 있는 모든 매물과 표시 핀까지 걷는 거리. 어느 핀에서도 재지 못한 매물은 뺀다. 핀이 없으면 길 데이터를 받지 않고 빈 값.
 * 길 데이터 네모는 거리 핀과 켜 둔 지역으로만 정한다(멀리 꽂은 표시 핀 때문에 네모가 커지거나 재기를 거절하지 않게). 네모 밖 표시 핀은 null.
 */
export async function walkFromPins(pins: WalkPin[], marks: WalkPin[] = []): Promise<WalkView> {
  if (pins.length === 0) return { fetchedAt: '', ids: [], meters: {}, missing: [], marks: {} };
  const g = await graphFor(neededBox(pins));
  const listings = store
    .allListings()
    .filter((r) => r.lat != null && r.lng != null)
    .map((r) => ({ id: r.id, at: snap(g, r.lat!, r.lng!) }));
  const markAt = marks.map((m) => ({ id: m.id, at: snap(g, m.lat, m.lng) }));
  const meters: Record<string, (number | null)[]> = {};
  const markMeters: Record<string, Record<string, number | null>> = {};
  const missing: string[] = [];
  for (const pin of pins) {
    const from = snap(g, pin.lat, pin.lng);
    if (!from) {
      missing.push(pin.id);
      meters[pin.id] = listings.map(() => null);
      markMeters[pin.id] = Object.fromEntries(marks.map((m) => [m.id, null]));
      continue;
    }
    const dist = shortest(g, from);
    const to = (at: Snap | null) => {
      if (!at) return null;
      const d = walkTo(g, dist, from, at);
      return Number.isFinite(d) && d <= MAX_WALK_M ? Math.round(d / 10) * 10 : null;
    };
    meters[pin.id] = listings.map(({ at }) => to(at));
    markMeters[pin.id] = Object.fromEntries(markAt.map(({ id, at }) => [id, to(at)]));
  }
  const keep = listings.map((_, i) => pins.some((p) => meters[p.id][i] != null));
  return {
    fetchedAt: g.fetchedAt,
    ids: listings.filter((_, i) => keep[i]).map((l) => l.id),
    meters: Object.fromEntries(Object.entries(meters).map(([id, list]) => [id, list.filter((_, i) => keep[i])])),
    missing,
    marks: markMeters,
  };
}
