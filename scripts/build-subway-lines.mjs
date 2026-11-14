// 지도에 깔 지하철 노선 모양을 만든다: node scripts/build-subway-lines.mjs [받은 원본을 둘 폴더]
// - OpenStreetMap(Overpass API)에서 수도권 전철 노선 묶음(route_master)을 찾고, 노선마다 그 노선이 지나는 선로(way)를 받는다.
// - 노선마다 선로를 이어 붙이고 몇 m 안쪽의 굴곡은 줄여 web/src/subway-lines.json에 쓴다. 노선 이름은 역 목록(server/stations-kric.json)과 같게 맞춘다.
// - Overpass 서버는 자주 꽉 차서(502, 504) 몇 바퀴 돌아도 안 되는 노선은 OSM 기본 API에서 운행 계통마다 받는다(노선 하나에 요청 몇 건).
// - 원본 폴더를 주면 받은 것을 노선마다 그 폴더에 두고, 다시 돌릴 때는 이미 받은 노선은 받지 않는다
//   (중간에 끊겨도 이어 받고, 줄이는 방법만 바꿔 볼 때도 다시 받지 않는다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'src', 'subway-lines.json');
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
/** 역 목록이 다루는 범위(수도권과 충남, 강원 일부). 이 안을 지나는 노선의 묶음을 찾는다. */
const BBOX = '36.7,126.3,38.1,127.9';
/** 이만큼(m) 안쪽의 굴곡은 지운다. 확대 16에서 2px 안팎이다. */
const TOLERANCE_M = 4;

/**
 * OSM 노선 묶음 이름(한글, 영문, 숫자만 남긴 것) → [지도에 쓸 이름, 역 목록에서 같은 노선으로 칠 이름들].
 * 역 목록은 1호선 북쪽 구간을 '경원선'으로 따로 적어서 1호선에 붙인다. 공항철도 직통열차는 일반열차와 선로가 같아 뺀다.
 */
const LINES = {
  수도권전철1호선: ['1호선', '경원선'],
  서울지하철2호선: ['2호선'],
  수도권전철3호선: ['3호선'],
  수도권전철4호선: ['4호선'],
  수도권전철5호선: ['5호선'],
  서울지하철6호선: ['6호선'],
  수도권전철7호선: ['7호선'],
  수도권전철8호선: ['8호선'],
  서울지하철9호선: ['9호선'],
  경의중앙선: ['경의중앙선'],
  수도권전철수인분당선: ['수인분당선'],
  수도권전철신분당선: ['신분당선'],
  수도권전철경춘선: ['경춘선'],
  수도권전철경강선: ['경강선'],
  수도권전철서해선: ['서해선'],
  인천국제공항철도일반열차: ['공항철도'],
  수도권광역급행철도A선: ['GTX-A'],
  인천도시철도1호선: ['인천1호선'],
  인천도시철도2호선: ['인천2호선'],
  우이신설선: ['우이신설선'],
  신림선: ['신림선'],
  김포골드라인: ['김포골드라인'],
  의정부경전철: ['의정부경전철'],
  용인경전철: ['에버라인'],
};
const norm = (s) => String(s ?? '').replace(/[^0-9A-Za-z가-힣]/g, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Overpass에 묻는다. 서버가 바쁘면(429, 502, 504) 다른 서버로 돌아가며 rounds 바퀴까지 다시 묻는다. */
async function overpass(query, rounds = 8) {
  let last = '';
  for (let round = 0; round < rounds; round++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'subway-lines-build/1.0' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(240_000),
        });
        const text = await res.text();
        if (res.ok && text.startsWith('{')) return JSON.parse(text);
        last = `${url} ${res.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`;
      } catch (e) {
        last = `${url} ${e instanceof Error ? e.message : String(e)}`;
      }
      console.error(`다시 시도: ${last}`);
      await sleep(5_000);
    }
    if (round + 1 < rounds) await sleep(Math.min(60_000, 15_000 * (round + 1)));
  }
  throw new Error(`Overpass 응답 없음: ${last}`);
}

const OSM_API = 'https://api.openstreetmap.org/api/0.6';
async function osmGet(url) {
  let last = '';
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'subway-lines-build/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return await res.json();
      last = `${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    console.error(`다시 시도: ${url} ${last}`);
    await sleep(3_000 * (i + 1));
  }
  throw new Error(`OSM API 응답 없음: ${url} ${last}`);
}

/**
 * Overpass 대신 OSM 기본 API에서 노선 묶음 하나를 받는다. 묶음과 그 운행 계통(relation/full)을 받아
 * Overpass 응답과 같은 모양(계통의 members, 선로의 geometry)으로 맞춘다.
 */
async function osmApiLine(id) {
  const master = (await osmGet(`${OSM_API}/relation/${id}.json`)).elements[0];
  const elements = [master];
  const ways = new Map();
  for (const m of master.members.filter((m) => m.type === 'relation')) {
    await sleep(400);
    const full = (await osmGet(`${OSM_API}/relation/${m.ref}/full.json`)).elements;
    const nodes = new Map(full.filter((e) => e.type === 'node').map((e) => [e.id, e]));
    for (const e of full) {
      if (e.type === 'relation' && e.id === m.ref) elements.push(e);
      if (e.type === 'way' && !ways.has(e.id)) {
        const geometry = e.nodes.map((n) => nodes.get(n)).filter(Boolean).map((n) => ({ lat: n.lat, lon: n.lon }));
        ways.set(e.id, { type: 'way', id: e.id, geometry });
      }
    }
  }
  for (const w of ways.values()) elements.push(w);
  return { elements };
}

/** dir이 있으면 그 안의 file을 먼저 읽고, 없으면 get으로 받아 거기에 둔다. */
async function cached(dir, file, get) {
  const p = dir ? path.join(dir, file) : null;
  if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  const v = await get();
  if (p) fs.writeFileSync(p, JSON.stringify(v));
  return v;
}

async function fetchRaw(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const masters = await cached(dir, 'masters.json', async () => ({
    fetchedAt: new Date().toISOString(),
    ...(await overpass(
      `[out:json][timeout:180];relation["route"~"^(subway|train|light_rail|monorail|tram)$"](${BBOX})->.r;rel(br.r)["route_master"];out tags;`,
    )),
  }));
  const keys = Object.keys(LINES);
  const picked = masters.elements.filter((e) => LINES[norm(e.tags?.name)]).sort((a, b) => keys.indexOf(norm(a.tags.name)) - keys.indexOf(norm(b.tags.name)));
  if (!picked.length) throw new Error('고를 노선 묶음이 없습니다.');
  const elements = [];
  for (const m of picked) {
    // 노선 하나씩 묻는다. 한꺼번에 물으면 바쁜 서버에서 시간 안에 끝나지 않는다.
    const body = await cached(dir, `line-${m.id}.json`, async () => {
      try {
        return await overpass(`[out:json][timeout:180];rel(id:${m.id})->.m;.m out body;rel(r.m)->.routes;.routes out body;way(r.routes);out skel geom qt;`, 2);
      } catch (e) {
        console.error(`OSM API로 받음: ${m.tags.name} (${e instanceof Error ? e.message : String(e)})`);
        return osmApiLine(m.id);
      }
    });
    console.error(`받음: ${m.tags.name} (${body.elements.length}개)`);
    for (const e of body.elements) elements.push(e);
  }
  return { fetchedAt: masters.fetchedAt, masters: picked, elements };
}

/** 위도, 경도를 그 근처 평면 m로(가까운 거리만 재므로 충분) */
function projector(lat0) {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_540;
  return ([lat, lng]) => [lng * kx, lat * ky];
}

function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** 더글러스-포이커로 tol(m) 안쪽 굴곡을 지운다(양 끝은 남긴다). */
function simplify(points, tol) {
  if (points.length <= 2) return points;
  const xy = points.map(projector(points[0][0]));
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(xy[i], xy[a], xy[b]);
      if (d > max) {
        max = d;
        at = i;
      }
    }
    if (at > 0 && max > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** 끝점을 공유하는 선로끼리 이어 긴 선으로 만든다(갈림목에서는 아무 쪽으로나 이어도 그림은 같다). */
function chain(lines) {
  const key = (p) => `${p[0]},${p[1]}`;
  const ends = new Map();
  const add = (k, i) => (ends.get(k) ?? ends.set(k, []).get(k)).push(i);
  lines.forEach((l, i) => {
    add(key(l[0]), i);
    add(key(l[l.length - 1]), i);
  });
  const used = new Uint8Array(lines.length);
  const take = (k) => {
    for (const i of ends.get(k) ?? []) {
      if (used[i]) continue;
      used[i] = 1;
      return lines[i];
    }
    return null;
  };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let path = [...lines[i]];
    for (let next; (next = take(key(path[path.length - 1]))); ) {
      const fwd = key(next[0]) === key(path[path.length - 1]);
      path = path.concat((fwd ? next : [...next].reverse()).slice(1));
    }
    for (let prev; (prev = take(key(path[0]))); ) {
      const fwd = key(prev[prev.length - 1]) === key(path[0]);
      path = (fwd ? prev : [...prev].reverse()).slice(0, -1).concat(path);
    }
    out.push(path);
  }
  return out;
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;
/** 받은 때(ISO)를 이 컴퓨터 시간대의 날짜로(UTC로 자르면 한국 아침 9시 전에는 하루 이르다) */
const localDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function build(raw) {
  const rels = new Map();
  const ways = new Map();
  for (const e of raw.elements) {
    if (e.type === 'relation') rels.set(e.id, e);
    else if (e.type === 'way' && e.geometry?.length >= 2) ways.set(e.id, e.geometry.map((g) => [g.lat, g.lon]));
  }
  const lines = [];
  const missing = new Set(Object.keys(LINES));
  for (const m of raw.masters) {
    const k = norm(m.tags.name);
    missing.delete(k);
    const [name, ...aliases] = LINES[k];
    const master = rels.get(m.id);
    const wayIds = new Set();
    for (const r of master?.members ?? []) {
      if (r.type !== 'relation') continue;
      for (const w of rels.get(r.ref)?.members ?? []) {
        // 승강장(platform)과 정차 위치(stop)는 빼고 선로만 쓴다.
        if (w.type === 'way' && !/platform|stop/.test(w.role)) wayIds.add(w.ref);
      }
    }
    const segs = [...wayIds].map((id) => ways.get(id)).filter(Boolean);
    const paths = chain(segs)
      .map((p) => simplify(p, TOLERANCE_M).map(([a, b]) => [round5(a), round5(b)]))
      .map((p) => p.filter((q, i) => !i || q[0] !== p[i - 1][0] || q[1] !== p[i - 1][1]))
      .filter((p) => p.length >= 2)
      .map((p) => p.flat());
    if (!paths.length) {
      console.error(`선로가 없어 뺌: ${m.tags.name}`);
      continue;
    }
    const color = /^#[0-9a-f]{6}$/i.test(m.tags.colour ?? '') ? m.tags.colour.toUpperCase() : '#5B6573';
    lines.push({ name, aliases, color, paths });
  }
  if (missing.size) console.error(`OSM에서 못 찾은 노선: ${[...missing].join(', ')}`);
  const order = Object.values(LINES).map((v) => v[0]);
  lines.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return {
    source: "OpenStreetMap 기여자(https://www.openstreetmap.org/copyright, ODbL 1.0). Overpass API로 받은 수도권 전철 노선 묶음(route_master)의 선로",
    baseDate: localDate(raw.fetchedAt),
    note: `노선 묶음의 모든 운행 계통이 지나는 선로를 이어 붙이고 ${TOLERANCE_M}m 안쪽 굴곡을 지움. 이름은 역 목록(server/stations-kric.json)의 노선 이름, aliases는 역 목록에서 같은 노선으로 칠 이름.`,
    lines,
  };
}

const raw = await fetchRaw(process.argv[2] ? path.resolve(process.argv[2]) : null);
const data = build(raw);
const text = `${JSON.stringify(data, null, 0)}\n`;
fs.writeFileSync(OUT, text);
const points = data.lines.reduce((n, l) => n + l.paths.reduce((m, p) => m + p.length / 2, 0), 0);
console.log(`${data.lines.length}개 노선, 선 ${data.lines.reduce((n, l) => n + l.paths.length, 0)}개, 점 ${points}개, ${(text.length / 1024).toFixed(0)}KB → ${path.relative(ROOT, OUT)}`);
for (const l of data.lines) console.log(`  ${l.name} ${l.color} 선 ${l.paths.length}개, 점 ${l.paths.reduce((m, p) => m + p.length / 2, 0)}개`);
