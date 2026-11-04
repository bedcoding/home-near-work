import { ref, watch } from 'vue';
import { api } from './api';
import { profile } from './profile';
import { distanceM } from '../../shared/geo';
import { MAX_MARK_PINS, MAX_WALK_PINS, WALK_KMH, WALK_NAME_MAX, walkMinutes, type PinKind, type WalkPin } from '../../shared/walk';

// 지도에 꽂은 핀(이 브라우저 localStorage 'hnw-walk-pins')과 거리 핀에서 매물까지 걷는 거리.
// 거리 핀(MAX_WALK_PINS개까지)은 자리가 바뀌면 서버(/api/walk)에 다시 묻고, 매물 카드와 지도 정보 창은 walkTimes로 핀마다 걷는 시간을 보인다.
// 표시 핀(MAX_MARK_PINS개까지)은 지도에 이름만 보이고, 마우스를 올리면 markDistances로 거리 핀마다 걷는 거리를 보인다.

const KEY = 'hnw-walk-pins';

/** 종류마다 꽂을 수 있는 핀 수 */
export function pinMax(kind: PinKind) {
  return kind === 'mark' ? MAX_MARK_PINS : MAX_WALK_PINS;
}
const isWalk = (p: WalkPin) => p.kind !== 'mark';
/** 새 매물이 보여 다시 물을 때 이 간격(ms) 안에는 한 번만 묻는다 */
const RECHECK_MS = 60000;

function load(): WalkPin[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Partial<WalkPin>[];
    if (!Array.isArray(list)) return [];
    return list
      .filter((p) => typeof p?.id === 'string' && typeof p.lat === 'number' && typeof p.lng === 'number')
      .map((p): WalkPin => ({ id: p.id!, name: String(p.name ?? '').slice(0, WALK_NAME_MAX), lat: p.lat!, lng: p.lng!, kind: p.kind === 'mark' ? 'mark' : 'walk' }))
      .filter((p, i, list) => list.slice(0, i + 1).filter((x) => x.kind === p.kind).length <= pinMax(p.kind!));
  } catch {
    return [];
  }
}

/** 꽂은 핀(꽂은 순서, 거리 핀과 표시 핀 모두) */
export const walkPins = ref<WalkPin[]>(load());
/** 그 종류 핀 수 */
export const pinCount = (kind: PinKind) => walkPins.value.filter((p) => (p.kind ?? 'walk') === kind).length;
/** 매물 id → 핀 id → 걷는 거리(m, 못 잰 핀은 null) */
const meters = ref(new Map<string, Record<string, number | null>>());
/** 거리 핀 id → 표시 핀 id → 걷는 거리(m, 못 잰 곳은 null) */
const markMeters = ref<Record<string, Record<string, number | null>>>({});
/** 묻는 중인지, 오류, 길 데이터(오픈스트리트맵)를 받은 때, 근처에 길이 없어 못 잰 핀 id */
export const walkState = ref<{ loading: boolean; error: string | null; fetchedAt: string | null; missing: string[] }>({
  loading: false,
  error: null,
  fetchedAt: null,
  missing: [],
});

let asked = 0;
let askedAt = 0;
/** 거리 핀에서 모든 매물까지 걷는 거리를 다시 묻는다(늦게 온 옛 답은 버림) */
async function refresh() {
  const pins = walkPins.value.filter(isWalk).map(({ id, name, lat, lng }) => ({ id, name, lat, lng }));
  const marks = walkPins.value.filter((p) => !isWalk(p)).map(({ id, name, lat, lng }) => ({ id, name, lat, lng }));
  const ask = ++asked;
  askedAt = Date.now();
  if (!pins.length) {
    meters.value = new Map();
    markMeters.value = {};
    walkState.value = { loading: false, error: null, fetchedAt: null, missing: [] };
    return;
  }
  walkState.value = { ...walkState.value, loading: true, error: null };
  try {
    const view = await api.walk(pins, marks);
    if (ask !== asked) return;
    const next = new Map<string, Record<string, number | null>>();
    view.ids.forEach((id, i) => next.set(id, Object.fromEntries(pins.map((p) => [p.id, view.meters[p.id]?.[i] ?? null]))));
    meters.value = next;
    markMeters.value = view.marks ?? {};
    walkState.value = { loading: false, error: null, fetchedAt: view.fetchedAt, missing: view.missing };
  } catch (e) {
    if (ask !== asked) return;
    walkState.value = { ...walkState.value, loading: false, error: e instanceof Error ? e.message : String(e) };
  }
}

watch(
  walkPins,
  (pins) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(pins));
    } catch {
      // 저장소를 못 쓰면 이번 화면에서만 쓴다.
    }
  },
  { deep: true },
);
// 이름만 바꿀 때는 다시 묻지 않는다. 표시 핀을 꽂거나 옮기거나 빼면 그 핀까지 거리도 다시 잰다.
watch(() => walkPins.value.map((p) => `${p.kind ?? 'walk'}:${p.id}:${p.lat}:${p.lng}`).join('|'), refresh, { immediate: true });

const known = new Set<string>();
/** 화면에 보이는 매물 중 처음 보는 매물이 있으면(조회나 확장으로 새로 들어옴) 다시 묻는다. 1분에 한 번까지. */
export function ensureWalk(ids: string[]) {
  let fresh = false;
  for (const id of ids) {
    if (known.has(id)) continue;
    known.add(id);
    fresh = true;
  }
  if (fresh && walkPins.value.some(isWalk) && !walkState.value.loading && Date.now() - askedAt > RECHECK_MS) void refresh();
}

/** 지도에서 누른 자리에 핀을 꽂는다. 이름은 거리 핀 '핀 1', 표시 핀 '표시 1'처럼 비어 있는 번호. 그 종류가 이미 다 찼으면 false. */
export function addWalkPin(lat: number, lng: number, kind: PinKind = 'walk'): boolean {
  if (pinCount(kind) >= pinMax(kind)) return false;
  const used = new Set(walkPins.value.map((p) => p.name));
  const word = kind === 'mark' ? '표시' : '핀';
  let n = 1;
  while (used.has(`${word} ${n}`)) n++;
  walkPins.value.push({ id: `p${Date.now().toString(36)}`, name: `${word} ${n}`, lat, lng, kind });
  return true;
}

/** 핀 종류를 바꾼다(바꿀 종류가 다 찼으면 바꾸지 않고 false) */
export function setPinKind(id: string, kind: PinKind): boolean {
  const pin = walkPins.value.find((p) => p.id === id);
  if (!pin || (pin.kind ?? 'walk') === kind || pinCount(kind) >= pinMax(kind)) return false;
  pin.kind = kind;
  return true;
}

export function moveWalkPin(id: string, lat: number, lng: number) {
  const pin = walkPins.value.find((p) => p.id === id);
  if (pin) Object.assign(pin, { lat, lng });
}

/** 핀 이름을 바꾼다(앞뒤 빈칸을 빼고 WALK_NAME_MAX자까지, 비우면 그대로) */
export function renameWalkPin(id: string, name: string) {
  const pin = walkPins.value.find((p) => p.id === id);
  const text = name.trim().slice(0, WALK_NAME_MAX);
  if (pin && text) pin.name = text;
}

export function removeWalkPin(id: string) {
  walkPins.value = walkPins.value.filter((p) => p.id !== id);
}

/** 매물에서 거리 핀마다 걷는 거리(m)와 시간(분, 내 조건의 걷는 속도로 셈). 핀 순서대로, 못 잰 핀은 뺀다. */
export function walkTimes(id: string): { pin: WalkPin; meters: number; minutes: number }[] {
  const row = meters.value.get(id);
  if (!row) return [];
  const kmh = profile.value.walkKmh ?? WALK_KMH;
  return walkPins.value.filter(isWalk).flatMap((pin) => {
    const m = row[pin.id];
    return m == null ? [] : [{ pin, meters: m, minutes: walkMinutes(m, kmh) }];
  });
}

/**
 * 표시 핀에서 거리 핀마다 거리(핀 순서대로). 길을 따라 잰 값이 있으면 meters와 minutes, 아직 재는 중이거나 못 쟀으면 null.
 * straight는 곧은 거리(m)라 길을 못 잰 때도 보일 수 있다.
 */
export function markDistances(id: string): { pin: WalkPin; meters: number | null; minutes: number | null; straight: number }[] {
  const mark = walkPins.value.find((p) => p.id === id);
  if (!mark) return [];
  const kmh = profile.value.walkKmh ?? WALK_KMH;
  return walkPins.value.filter(isWalk).map((pin) => {
    const m = markMeters.value[pin.id]?.[id] ?? null;
    return { pin, meters: m, minutes: m == null ? null : walkMinutes(m, kmh), straight: distanceM(mark.lat, mark.lng, pin.lat, pin.lng) };
  });
}
