import * as store from './db.js';
import { distanceM } from './geo.js';

// 사이트 바로 가기를 그 동네로 바로 여는 데 쓰는 값. 크롬 확장이 받은 응답(사용자가 그 사이트를 볼 때 화면이 받은 것)에서 배운다.
// 직방: 지하철역 번호(`/common/subway/all`의 id·name·lat·lng, 수도권만). 호갱노노: 단지 번호(`/api/apt/bounding`의 id·name·lat·lng, 본 동네마다 쌓임).

interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

const ZIGBANG_KEY = 'link_zigbang_subways';
const HOGANGNONO_KEY = 'link_hogangnono_apts';
/** 호갱노노 단지는 최근 본 것부터 이만큼만 둔다. */
const HOGANGNONO_MAX = 5000;

function read(key: string): Place[] {
  try {
    const v = JSON.parse(store.getSetting(key) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const place = (x: Record<string, unknown>): Place | null => {
  const lat = Number(x.lat);
  const lng = Number(x.lng);
  const id = typeof x.id === 'number' || typeof x.id === 'string' ? String(x.id) : '';
  return id && typeof x.name === 'string' && Number.isFinite(lat) && Number.isFinite(lng) ? { id, name: x.name, lat, lng } : null;
};

/** 받은 응답 하나에서 배운다. 배운 것이 있으면 true. 모양이 다르면 그냥 넘어간다. */
export function learnLinkHints(site: string, url: string, body: string): boolean {
  try {
    if (site === 'zigbang' && url.includes('/common/subway/all')) {
      const list = JSON.parse(body);
      if (!Array.isArray(list)) return false;
      const places = list.filter((s) => s?.subway_area === '수도권').map(place).filter((p): p is Place => !!p);
      if (places.length === 0) return false;
      store.setSetting(ZIGBANG_KEY, JSON.stringify(places));
      return true;
    }
    if (site === 'hogangnono' && url.includes('/api/apt/bounding')) {
      const data = JSON.parse(body)?.data;
      const items: unknown[] = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data) : [];
      const found = items.map((x) => (x && typeof x === 'object' ? place(x as Record<string, unknown>) : null)).filter((p): p is Place => !!p);
      if (found.length === 0) return false;
      const byId = new Map(read(HOGANGNONO_KEY).map((p) => [p.id, p]));
      for (const p of found) {
        byId.delete(p.id);
        byId.set(p.id, p);
      }
      store.setSetting(HOGANGNONO_KEY, JSON.stringify([...byId.values()].slice(-HOGANGNONO_MAX)));
      return true;
    }
  } catch {
    /* 읽을 수 없는 응답은 배우지 않는다 */
  }
  return false;
}

/** 직방 역 번호 → 역 이름(배운 수도권 역 목록에서). 모르면 null. */
export function zigbangStationName(id: string): string | null {
  return read(ZIGBANG_KEY).find((p) => p.id === id)?.name ?? null;
}

/** 남아 있는 화면 데이터에서 다시 배운다(서버를 켤 때). */
export function learnFromStoredCaptures() {
  for (const r of store.capturesMatching('zigbang', '%/common/subway/all%')) learnLinkHints('zigbang', r.url, r.body);
  for (const r of store.capturesMatching('hogangnono', '%/api/apt/bounding%')) learnLinkHints('hogangnono', r.url, r.body);
}

function nearest(list: Place[], lat: number, lng: number, maxM: number): Place | null {
  let best: { p: Place; d: number } | null = null;
  for (const p of list) {
    const d = distanceM(lat, lng, p.lat, p.lng);
    if (d <= maxM && (!best || d < best.d)) best = { p, d };
  }
  return best?.p ?? null;
}

/**
 * 역마다 바로 가기 값을 붙인다. zigbangId: 직방 역 번호(이름이 같은 역이 2km 안, 없으면 300m 안 가장 가까운 역).
 * hogangnonoApt: 역에서 500m 안 가장 가까운 호갱노노 단지 번호. 모르면 붙이지 않는다.
 */
export function withLinkHints<T extends { name: string; lat: number; lng: number }>(stations: T[]): (T & { zigbangId?: string; hogangnonoApt?: string })[] {
  const zigbang = read(ZIGBANG_KEY);
  const apts = read(HOGANGNONO_KEY);
  return stations.map((s) => {
    const z = zigbang.find((p) => p.name === s.name && distanceM(s.lat, s.lng, p.lat, p.lng) <= 2000) ?? nearest(zigbang, s.lat, s.lng, 300);
    const h = nearest(apts, s.lat, s.lng, 500);
    return { ...s, ...(z ? { zigbangId: z.id } : {}), ...(h ? { hogangnonoApt: h.id } : {}) };
  });
}
