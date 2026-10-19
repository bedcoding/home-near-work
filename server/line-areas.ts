import * as store from './db.js';
import { stationCatalog } from './stations.js';
import type { Area } from '../shared/types.js';

// 노선 단위로 지역 켜기(지역 탭 '노선으로 보기'). 노선의 역은 수도권 전철역 목록(stations-kric.json)의 노선 칸을 따른다.
// - only: 지금 켜 둔 지역을 기억해 두고(이미 기억해 둔 것이 있으면 그것을 그대로 둠) 그 노선 역만 켠다.
// - add: 그 노선 역을 더 켠다. off: 그 노선 역을 끈다(지역은 하나는 켜져 있어야 함).
// - 없는 역은 고른 반경으로 새로 만들고, 이미 있는 역은 반경을 그대로 둔다.
// - restore: 기억해 둔 지역만 다시 켜고, 기억해 둔 뒤 노선으로 새로 만든 지역은 지운다.

const BEFORE_KEY = 'areas_before_line';
export type LineMode = 'only' | 'add' | 'off';
/** 기억해 둔 것: 마지막으로 고른 노선, 그 전에 켜 둔 지역 번호, 그 뒤 노선으로 새로 만든 지역 번호 */
type Before = { line: string; ids: number[]; created: number[] };

const readBefore = (): Before | null => {
  try {
    return JSON.parse(store.getSetting(BEFORE_KEY) || 'null') as Before | null;
  } catch {
    return null;
  }
};

/** 그 노선의 역(이름 순). 모르는 노선이면 빈 목록. */
export const lineStations = (line: string) =>
  stationCatalog()
    .stations.filter((s) => s.lines.includes(line))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

/** 되돌릴 수 있으면 마지막으로 고른 노선과 전에 켜 둔 지역 수 */
export function areaRestoreState(): { line: string; count: number } | null {
  const before = readBefore();
  return before ? { line: before.line, count: before.ids.length } : null;
}

/** 노선 역을 켜거나 끈다. 바뀐 지역 목록과 결과 한 줄을 돌려준다. */
export function applyLine(line: string, mode: LineMode, radiusM: number): { areas: Area[]; text: string } {
  const stations = lineStations(line);
  if (!stations.length) throw new Error(`역 목록에 '${line}' 역이 없습니다.`);
  const names = new Set(stations.map((s) => s.name));
  const areas = store.listAreas();
  if (mode === 'off') {
    if (!areas.some((a) => a.enabled && !names.has(a.name))) throw new Error('지역이 하나는 켜져 있어야 합니다. 다른 지역을 켠 뒤 끄세요.');
    const off = areas.filter((a) => a.enabled && names.has(a.name));
    for (const a of off) store.updateArea(a.id, { enabled: false });
    return { areas: store.listAreas(), text: `${line} 역 ${off.length}곳을 껐습니다.` };
  }
  let before = readBefore();
  if (mode === 'only') before = { line, ids: before?.ids ?? areas.filter((a) => a.enabled).map((a) => a.id), created: before?.created ?? [] };
  let created = 0;
  let turnedOn = 0;
  for (const s of stations) {
    const a = areas.find((x) => x.name === s.name);
    if (!a) {
      const made = store.createArea({ name: s.name, lat: s.lat, lng: s.lng, radiusM, enabled: true });
      before?.created.push(made.id);
      created++;
    } else if (!a.enabled) {
      store.updateArea(a.id, { enabled: true });
      turnedOn++;
    }
  }
  let turnedOff = 0;
  if (mode === 'only') {
    for (const a of areas) {
      if (a.enabled && !names.has(a.name)) {
        store.updateArea(a.id, { enabled: false });
        turnedOff++;
      }
    }
  }
  if (before) store.setSetting(BEFORE_KEY, JSON.stringify({ ...before, line }));
  const parts = [`${line} 역 ${stations.length}곳 켬`, created ? `새로 만든 곳 ${created}` : '', turnedOn ? `다시 켠 곳 ${turnedOn}` : '', turnedOff ? `끈 다른 지역 ${turnedOff}` : ''];
  return { areas: store.listAreas(), text: `${parts.filter(Boolean).join(', ')}.` };
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
