import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import proj4 from 'proj4';
import { DATA_DIR } from './config.js';
import { guOfCode } from './lots.js';
import type { RedevZoneFeature, RedevZoneGroup, RedevZonesView } from '../shared/types.js';

// 지도에 칠하는 정비사업 구역. 서울 열린데이터광장 '서울시 도시계획사업 현황(서울플랜+) 공간정보'(OA-22712) ZIP을 사용자가 받아 넣으면
// 안의 shp(UPIS_C_UQ120)를 읽어 위경도로 바꿔 data 폴더(redev-zones.json)에 둔다. 파일은 저장소에 넣지 않는다.
// - 좌표계는 .prj를 읽어 정한다(가로 메르카토르, Bessel 1841 또는 GRS 1980 타원체만). 2026-09 파일은 Bessel(EPSG:5174와 같은 값)이다.
//   Bessel에서 세계측지계로는 PROJ가 고르는 EPSG:5191 'Korean 1985 to WGS 84 (1)'(몰로덴스키-바데카스, 기준점 회전)을 proj4가 쓰는
//   원점 회전 7변수(위치 벡터)로 바꾼 값을 쓴다. 서울 여섯 곳에서 PROJ 9.8.1(pyproj 3.8.0) 결과와 0.1cm 안으로 같았다.
//   EPSG:5191 값을 원점 회전으로 그대로 넣으면 약 16m 어긋난다.
// - 사업 종류와 추진 단계 이름은 같은 ZIP에 든 '서울플랜+코드정의표(대민용).xlsx'(2026-09 판)를 옮겨 적었다. 표에 없는 코드는 코드 그대로 보인다.
// - 정비사업, 소규모 정비사업, 재정비촉진사업, 국토부사업(공공주택지구, 도심 공공주택 복합사업)만 남기고, 준공·입주중·후보지철회는 뺀다.
//   역세권사업(장기전세, 청년안심주택 등)과 기타사업(도시개발, 리모델링, 시장정비, 도시재생, 사전협상)은 넣지 않는다.

const FILE = path.join(DATA_DIR, 'redev-zones.json');
const LAYER = 'UPIS_C_UQ120';
/** EPSG:5191(이동 -145.907, 505.034, 685.756m, 회전 -1.162, 2.347, 1.592초(좌표틀), 축척 6.342ppm, 기준점 -3159521.31, 4068151.32, 3748113.85m)을 원점 회전으로 바꾼 것 */
const BESSEL_TOWGS84 = '-114.620,475.963,675.018,1.162,-2.347,-1.592,6.342';
/** 꼭짓점을 줄일 때 허용하는 어긋남(m) */
const SIMPLIFY_M = 0.5;

/** 대분류 → 지도 묶음 */
const GROUP_OF: Record<string, RedevZoneGroup> = { BZ100: 'redev', BZ200: 'small', BZ400: 'promo', BZ500: 'public' };
/** 소분류 이름(코드정의표 01. 사업유형_코드) */
const TYPE_NAME: Record<string, string> = {
  BZ101: '신속통합기획', BZ102: '재개발(도시정비형)', BZ103: '재개발(주택정비형)', BZ104: '재건축(단독)', BZ105: '재건축(공동)',
  BZ107: '주거환경개선(관리형)', BZ108: '주거환경개선(정비형)',
  BZ201: '모아타운', BZ202: '가로주택정비사업', BZ203: '자율주택정비사업', BZ204: '소규모재건축사업', BZ205: '소규모재개발사업',
  BZ401: '재정비촉진지구', BZ402: '재정비촉진구역', BZ403: '존치정비구역', BZ404: '존치관리구역',
  BZ501: '공공주택지구조성사업', BZ502: '도심 공공주택 복합사업',
};
/** 테두리만 그리는 넓은 구역(안에 사업 구역이 따로 있거나, 존치관리구역처럼 헐지 않는 곳) */
const OUTLINE = new Set(['BZ201', 'BZ401', 'BZ404']);
/** 추진 단계 이름(코드정의표 02. 추진단계_코드) */
const STAGE_NAME: Record<string, string> = {
  PP0101: '대상지선정(추진중)', PP0102: '대상지선정', PP0103: '기획완료', PP0104: '보류',
  PP0201: '입안제안', PP0202: '열람공고', PP0203: '위원회심의', PP0204: '구역지정', PP0205: '추진위구성', PP0206: '조합설립인가',
  PP0207: '건축심의', PP0208: '사업시행인가', PP0209: '관리처분계획인가', PP0210: '착공', PP0211: '준공',
  PP0301: '대상지선정', PP0302: '정비계획수립', PP0303: '위원회심의', PP0304: '구역지정', PP0305: '사업시행인가', PP0306: '착공', PP0307: '준공(일부)', PP0308: '준공',
  PP0401: '수립범위 자문', PP0402: '대상지선정', PP0403: '관리지역고시', PP0404: '사전자문', PP0405: '위원회심의', PP0406: '관리지역고시',
  PP0500: '조합설립인가 추진중(연번부여)', PP0501: '조합설립인가', PP0502: '건축심의', PP0503: '사업시행인가', PP0504: '착공', PP0505: '준공',
  PP0601: '주민합의체 구성', PP0602: '건축심의', PP0603: '사업시행인가', PP0604: '착공', PP0605: '준공',
  PP0701: '조합설립추진중', PP0702: '조합설립인가', PP0703: '건축심의', PP0704: '사업시행계획인가', PP0705: '착공', PP0706: '준공',
  PP1001: '지구지정', PP1002: '지구변경',
  PP1101: '대상지선정', PP1102: '촉진계획수립(변경)', PP1103: '열람공고', PP1104: '위원회심의', PP1105: '구역지정', PP1107: '추진위구성',
  PP1108: '조합설립인가', PP1109: '건축심의', PP1110: '사업시행인가', PP1111: '관리처분계획인가', PP1112: '착공', PP1113: '준공',
  PP2101: '구역지정', PP2102: '구역변경',
  PP2001: '입안제안', PP2002: '열람공고', PP2003: '위원회심의', PP2004: '구역지정', PP2005: '지구계획승인(변경)', PP2006: '착공', PP2007: '준공',
  PP1201: '예정지구지정', PP1202: '후보지선정', PP1203: '지구지정', PP1204: '설계공모완료', PP1205: '사업계획승인', PP1206: '착공',
  PP1207: '준공', PP1208: '입주중', PP1209: '후보지철회',
  // 남기지 않는 사업의 단계도 다른 사업 구역에 붙어 나올 수 있어 같이 둔다(예: 재개발 구역에 장기전세 단계).
  PP0801: '대상지선정', PP0802: '사전검토', PP0803: '입안제안', PP0804: '열람공고', PP0805: '위원회심의', PP0806: '구역지정', PP0807: '건축심의',
  PP0808: '사업계획승인', PP0809: '착공', PP0810: '준공',
  PP0901: '대상지선정', PP0902: '통심위 사전자문', PP0903: '입안제안', PP0904: '열람공고', PP0905: '위원회심의', PP0906: '구역지정', PP0907: '건축심의',
  PP0908: '사업계획승인', PP0909: '건축허가', PP0910: '착공', PP0911: '사용승인', PP0912: '입주',
  PP1901: '입주자 모집공고 완료',
  PP1801: '대상지선정', PP1802: '통심위 사전자문', PP1803: '입안제안', PP1804: '열람공고', PP1805: '위원회심의', PP1806: '구역지정',
  PP1807: '건축심의/통합심의', PP1808: '사업계획승인', PP1809: '착공', PP1810: '준공',
  PP1301: '입안제안', PP1302: '열람공고', PP1303: '위원회심의', PP1304: '구역지정', PP1305: '실시계획인가', PP1306: '준공',
  PP1401: '조합설립인가', PP1402: '1차 안전진단', PP1403: '건축심의', PP1404: '리모델링허가승인', PP1405: '2차 안전진단', PP1406: '착공', PP1407: '준공',
  PP1501: '추진계획수립중', PP1502: '추진계획승인', PP1503: '조합설립인가', PP1504: '사업시행계획인가', PP1505: '관리처분계획인가', PP1506: '착공', PP1507: '준공',
  PP1601: '대상지선정', PP1602: '활성화계획수립', PP1603: '마중물사업(추진중)', PP1604: '사업완료',
  PP2201: '대상지 선정', PP2202: '제안서접수', PP2203: '협상조정협의회 운영', PP2204: '협상완료', PP2205: '입안절차 진행', PP2206: '도시건축공동위 심의',
  PP2207: '결정고시', PP2208: '인허가 절차', PP2209: '착공', PP2210: '준공',
};
/** 끝났거나 접은 사업(지도에서 뺀다) */
const ENDED = new Set(['PP0211', 'PP0308', 'PP0505', 'PP0605', 'PP0706', 'PP1113', 'PP2007', 'PP1207', 'PP1208', 'PP1209']);

type Ring = [number, number][];

/** dBASE 표를 읽는다. 글자는 UTF-8로 읽히면 UTF-8, 아니면 EUC-KR(CP949)로 읽는다. */
export function parseDbf(bytes: Uint8Array): Record<string, string>[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true);
  const headLen = view.getUint16(8, true);
  const recLen = view.getUint16(10, true);
  const fields: { name: string; len: number }[] = [];
  for (let o = 32; o < headLen - 1 && bytes[o] !== 0x0d; o += 32) {
    const raw = bytes.subarray(o, o + 11);
    const end = raw.indexOf(0);
    fields.push({ name: new TextDecoder('latin1').decode(end < 0 ? raw : raw.subarray(0, end)), len: bytes[o + 16] });
  }
  let decoder: TextDecoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(bytes.subarray(headLen, headLen + recLen * Math.min(count, 200)));
  } catch {
    decoder = new TextDecoder('euc-kr');
  }
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < count; i++) {
    let o = headLen + i * recLen + 1; // 첫 바이트는 지움 표시
    const row: Record<string, string> = {};
    for (const f of fields) {
      row[f.name] = decoder.decode(bytes.subarray(o, o + f.len)).replace(/\0/g, '').trim();
      o += f.len;
    }
    rows.push(row);
  }
  return rows;
}

/** shp의 다각형(종류 5, 15, 25)을 레코드 순서대로 읽는다. 고리마다 [x, y] 목록, 빈 도형은 null. */
export function parseShp(bytes: Uint8Array): (Ring[] | null)[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shapes: (Ring[] | null)[] = [];
  let o = 100;
  while (o + 8 <= bytes.byteLength) {
    const len = view.getInt32(o + 4, false) * 2;
    const at = o + 8;
    const type = view.getInt32(at, true);
    if (type === 5 || type === 15 || type === 25) {
      const parts = view.getInt32(at + 36, true);
      const points = view.getInt32(at + 40, true);
      const starts = Array.from({ length: parts }, (_, i) => view.getInt32(at + 44 + i * 4, true));
      const base = at + 44 + parts * 4;
      const rings: Ring[] = starts.map((start, i) => {
        const end = i + 1 < parts ? starts[i + 1] : points;
        const ring: Ring = [];
        for (let p = start; p < end; p++) ring.push([view.getFloat64(base + p * 16, true), view.getFloat64(base + p * 16 + 8, true)]);
        return ring;
      });
      shapes.push(rings);
    } else {
      shapes.push(null);
    }
    o = at + len;
  }
  return shapes;
}

/** .prj(WKT)의 가로 메르카토르 값으로 위경도 변환을 만든다. 모르는 좌표계면 오류. */
export function projectorOf(prj: string): (x: number, y: number) => [number, number] {
  const param = (name: string) => {
    const m = new RegExp(`PARAMETER\\["${name}",\\s*(-?[\\d.]+)`, 'i').exec(prj);
    if (!m) throw new Error(`좌표계 파일(.prj)에 ${name} 값이 없습니다`);
    return Number(m[1]);
  };
  if (!/PROJECTION\["Transverse_Mercator"\]/i.test(prj)) throw new Error('좌표계 파일(.prj)이 가로 메르카토르(TM)가 아닙니다');
  const bessel = /Bessel/i.test(prj);
  if (!bessel && !/GRS_?1980|GRS 1980/i.test(prj)) throw new Error('좌표계 파일(.prj)의 타원체가 Bessel 1841이나 GRS 1980이 아닙니다');
  const def = [
    '+proj=tmerc', `+lat_0=${param('Latitude_Of_Origin')}`, `+lon_0=${param('Central_Meridian')}`, `+k=${param('Scale_Factor')}`,
    `+x_0=${param('False_Easting')}`, `+y_0=${param('False_Northing')}`,
    bessel ? `+ellps=bessel +towgs84=${BESSEL_TOWGS84}` : '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0', '+units=m +no_defs',
  ].join(' ');
  const p = proj4(def, 'EPSG:4326');
  return (x, y) => p.forward([x, y]) as [number, number];
}

/** 점 p와 선분 a-b 사이 거리 */
function segDist(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** 닫힌 고리의 꼭짓점을 tol(m) 안에서 줄인다(더글러스-포이커). 너무 줄면 그대로 둔다. */
export function simplifyRing(ring: Ring, tol: number): Ring {
  if (ring.length <= 5) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  // 닫힌 고리는 처음 점에서 가장 먼 점으로 둘로 나눠 줄인다.
  let far = 1;
  for (let i = 1; i < ring.length - 1; i++) if (Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]) > Math.hypot(ring[far][0] - ring[0][0], ring[far][1] - ring[0][1])) far = i;
  keep[far] = 1;
  const stack: [number, number][] = [[0, far], [far, ring.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let best = -1;
    let dist = tol;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(ring[i], ring[s], ring[e]);
      if (d > dist) {
        dist = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

/** 고리의 부호 있는 넓이(시계 방향이면 음수) */
const signedArea = (r: Ring) => r.reduce((sum, p, i) => sum + (i + 1 < r.length ? p[0] * r[i + 1][1] - r[i + 1][0] * p[1] : 0), 0) / 2;

function inside(p: [number, number], ring: Ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** shp 고리들을 바깥 고리(시계 방향)와 그 안의 구멍으로 묶는다. 방향이 모두 같으면 모두 바깥 고리로 본다. */
function polygonsOf(rings: Ring[]): Ring[][] {
  const outers = rings.filter((r) => signedArea(r) < 0);
  if (!outers.length) return rings.map((r) => [r]);
  const polys = outers.map((r) => [r]);
  for (const hole of rings.filter((r) => signedArea(r) >= 0)) {
    const owner = polys.find((poly) => inside(hole[0], poly[0])) ?? polys[polys.length - 1];
    owner.push(hole);
  }
  return polys;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const dateOf = (yyyymmdd: string) => (/^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : null);

/** ZIP에서 이름이 '…/UPIS_C_UQ120.확장자'인 파일 */
function entry(files: Record<string, Uint8Array>, ext: string): Uint8Array | null {
  const key = Object.keys(files).find((k) => k.toUpperCase().endsWith(`${LAYER}.${ext}`.toUpperCase()));
  return key ? files[key] : null;
}

/** 서울플랜+ ZIP을 읽어 지도에 그릴 구역으로 바꿔 저장하고 돌려준다. */
export function importRedevZones(zip: Uint8Array, fileName: string | null): RedevZonesView {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new Error('ZIP 파일을 열지 못했습니다. 서울 열린데이터광장에서 받은 ZIP 그대로 넣어 주세요.');
  }
  const shp = entry(files, 'shp');
  const dbf = entry(files, 'dbf');
  const prj = entry(files, 'prj');
  if (!shp || !dbf || !prj) {
    throw new Error(`ZIP 안에 ${LAYER}.shp, .dbf, .prj가 없습니다. '서울시 도시계획사업 현황(서울플랜+) 공간정보' 파일인지 확인해 주세요.`);
  }
  const toLngLat = projectorOf(new TextDecoder().decode(prj));
  const rows = parseDbf(dbf);
  const shapes = parseShp(shp);
  if (rows.length !== shapes.length) throw new Error(`도형 수(${shapes.length})와 표의 줄 수(${rows.length})가 다릅니다`);
  const features: RedevZoneFeature[] = [];
  let done = 0;
  let other = 0;
  let fileDate: string | null = null;
  rows.forEach((row, i) => {
    const date = dateOf(row.CREATE_DAT ?? '');
    if (date && (!fileDate || date > fileDate)) fileDate = date;
    const group = GROUP_OF[row.LCLAS_CL];
    const rings = shapes[i];
    if (!group || !rings?.length) {
      other++;
      return;
    }
    if (ENDED.has(row.PROPEL_CD)) {
      done++;
      return;
    }
    const polys = polygonsOf(rings).map((poly) =>
      poly.map((ring) => simplifyRing(ring, SIMPLIFY_M).map(([x, y]) => toLngLat(x, y)).map(([lng, lat]) => [round6(lng), round6(lat)] as [number, number])),
    );
    const code = row.SCLAS_CL;
    features.push({
      type: 'Feature',
      properties: {
        id: row.PRESENT_SN,
        name: row.DGM_NM || TYPE_NAME[code] || code,
        group,
        type: TYPE_NAME[code] ?? code,
        outline: OUTLINE.has(code),
        stage: row.PROPEL_CD ? (STAGE_NAME[row.PROPEL_CD] ?? `단계 코드 ${row.PROPEL_CD}`) : null,
        date,
        gu: guOfCode(row.SIGNGU_SE) ?? null,
      },
      geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys },
    });
  });
  // 넓은 구역(테두리만)을 먼저 그려 안의 사업 구역이 위에 오게 한다.
  features.sort((a, b) => Number(b.properties.outline) - Number(a.properties.outline));
  const view: RedevZonesView = { importedAt: new Date().toISOString(), fileDate, fileName, count: features.length, skipped: { done, other }, features };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(view));
  return view;
}

/** 저장해 둔 구역. 넣은 적이 없으면 빈 것. */
export function redevZones(): RedevZonesView {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) as RedevZonesView;
  } catch {
    return { importedAt: null, fileDate: null, fileName: null, count: 0, skipped: { done: 0, other: 0 }, features: [] };
  }
}
