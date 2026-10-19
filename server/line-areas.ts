import * as store from './db.js';
import { stationCatalog } from './stations.js';
import type { Area, LineViewSetting } from '../shared/types.js';

// 노선 탭: 고른 노선의 역마다 반경을 그려 그 안의 매물을 역별로 본다. 켜진 지역(회사 근처)은 건드리지 않는다.
// - 노선의 역은 수도권 전철역 목록(stations-kric.json)의 노선 칸을 따른다.
// - 노선 역은 켜진 지역과 따로 자리 번호(store.lineStationSpot)를 둬서, 노선 조회의 기준점과 '사라짐'이 회사 근처 지역과 섞이지 않는다.
// - 고른 노선(설정 line_view)의 역 반경은 크롬 확장이 보낸 화면 데이터를 저장할 때도 지역으로 친다(노선 탭에서 역 사이트를 열어 모은 것).
// 지역 탭 '노선으로 보기'로 바꾸기 전 지역으로 되돌리기(areas_before_line)는 그 기능을 노선 탭으로 옮기기 전에 쓴 사람을 위해 남겨 둔다.

const VIEW_KEY = 'line_view';
const BEFORE_KEY = 'areas_before_line';
/** 노선 탭 역 반경으로 고를 수 있는 값(m) */
export const LINE_RADII = [300, 500, 700, 1000];

/** 그 노선의 역(이름 순). 모르는 노선이면 빈 목록. */
export const lineStations = (line: string) =>
  stationCatalog()
    .stations.filter((s) => s.lines.includes(line))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

/** 노선 탭에서 고른 노선과 역 반경. 고르지 않았으면 null. */
export function lineView(): LineViewSetting | null {
  try {
    const v = JSON.parse(store.getSetting(VIEW_KEY) || 'null') as LineViewSetting | null;
    return v && lineStations(v.line).length && LINE_RADII.includes(v.radiusM) ? v : null;
  } catch {
    return null;
  }
}

/** 노선 탭에서 고른 노선과 반경을 바꾼다(line이 null이면 고르지 않음). 모르는 노선이나 반경이면 오류. */
export function setLineView(line: string | null, radiusM: number): LineViewSetting | null {
  if (line === null) {
    store.setSetting(VIEW_KEY, '');
    return null;
  }
  if (!lineStations(line).length) throw new Error(`역 목록에 '${line}' 역이 없습니다.`);
  if (!LINE_RADII.includes(radiusM)) throw new Error(`반경은 ${LINE_RADII.join(', ')}m 중 하나여야 합니다.`);
  const v = { line, radiusM };
  store.setSetting(VIEW_KEY, JSON.stringify(v));
  return v;
}

/** 노선 역을 조회 범위(Area)로. id는 노선 역 자리 번호라 켜진 지역과 겹치지 않는다. */
export function lineAreas(line: string, radiusM: number): Area[] {
  return lineStations(line).map((s) => ({ id: store.lineStationSpot(s.name), name: s.name, lat: s.lat, lng: s.lng, radiusM, enabled: true }));
}

/** 고른 노선의 역 범위(고르지 않았으면 빈 목록). 크롬 확장 화면 데이터를 저장할 때 켜진 지역과 함께 쓴다. */
export function activeLineAreas(): Area[] {
  const v = lineView();
  return v ? lineAreas(v.line, v.radiusM) : [];
}

// ---------- 예전 '이 노선만 켜기'에서 되돌리기 ----------

type Before = { line: string; ids: number[]; created: number[] };
const readBefore = (): Before | null => {
  try {
    return JSON.parse(store.getSetting(BEFORE_KEY) || 'null') as Before | null;
  } catch {
    return null;
  }
};

/** 되돌릴 수 있으면 마지막으로 고른 노선과 전에 켜 둔 지역 수 */
export function areaRestoreState(): { line: string; count: number } | null {
  const before = readBefore();
  return before ? { line: before.line, count: before.ids.length } : null;
}

/** 노선으로 바꾸기 전에 켜 둔 지역으로 되돌린다. 그 뒤 노선으로 새로 만든 지역은 지운다. */
export function restoreAreas(): { areas: Area[]; text: string } {
  const before = readBefore();
  if (!before) throw new Error('되돌릴 지역이 없습니다.');
  const areas = store.listAreas();
  const keep = new Set(before.ids.filter((id) => areas.some((a) => a.id === id)));
  if (!keep.size) {
    store.setSetting(BEFORE_KEY, '');
    throw new Error('전에 켜 둔 지역이 모두 지워져 되돌릴 수 없습니다.');
  }
  const made = new Set(before.created.filter((id) => !keep.has(id)));
  for (const a of areas) {
    if (made.has(a.id)) store.deleteArea(a.id);
    else if (a.enabled !== keep.has(a.id)) store.updateArea(a.id, { enabled: keep.has(a.id) });
  }
  store.setSetting(BEFORE_KEY, '');
  return { areas: store.listAreas(), text: `전에 켜 둔 지역 ${keep.size}곳으로 되돌렸습니다${made.size ? `(노선으로 만든 지역 ${made.size}곳 지움)` : ''}.` };
}
