/** 핀 종류: walk 매물까지 걷는 시간을 재는 핀, mark 지도에 표시만 하는 핀 */
export type PinKind = 'walk' | 'mark';

/** 지도에 꽂은 핀. id는 화면이 정한 짧은 글자, name은 카드와 정보 창에 보일 이름. kind가 없으면 walk. */
export interface WalkPin {
  id: string;
  name: string;
  lat: number;
  lng: number;
  kind?: PinKind;
}

/**
 * 핀에서 매물까지 길을 따라 걷는 거리. ids는 매물 id, meters[핀 id][i]는 ids[i] 매물까지 m(10m 단위).
 * 길이 이어지지 않거나 매물이 길 데이터 밖이면 null. missing은 근처에 길이 없어 재지 못한 핀 id.
 * fetchedAt은 길 데이터(오픈스트리트맵)를 받은 때.
 */
export interface WalkView {
  fetchedAt: string;
  ids: string[];
  meters: Record<string, (number | null)[]>;
  missing: string[];
  /** marks[거리 핀 id][표시 핀 id]: 거리 핀에서 표시 핀까지 걷는 거리(m, 10m 단위). 못 재면 null. */
  marks: Record<string, Record<string, number | null>>;
}

/** 꽂을 수 있는 거리 핀 수 */
export const MAX_WALK_PINS = 3;
/** 꽂을 수 있는 표시 핀 수 */
export const MAX_MARK_PINS = 20;
/** 핀 이름 글자 수 */
export const WALK_NAME_MAX = 8;
/** 걷는 속도 기본값(시속 km) */
export const WALK_KMH = 4;

/** 걷는 거리(m)를 분으로(1분보다 짧아도 1분) */
export const walkMinutes = (meters: number, kmh = WALK_KMH) => Math.max(1, Math.round(meters / ((kmh * 1000) / 60)));
