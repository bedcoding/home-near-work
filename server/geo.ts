import { distanceM } from '../shared/geo.js';
import type { Area } from '../shared/types.js';

const toRad = (deg: number) => (deg * Math.PI) / 180;

export { distanceM };

/** 중심과 반경을 감싸는 위경도 사각형. */
export function bbox(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(toRad(lat)));
  return { latMin: lat - dLat, latMax: lat + dLat, lngMin: lng - dLng, lngMax: lng + dLng };
}

/** 가장 가까운 지역과 그 거리. 좌표가 없으면 null. */
export function nearestArea(areas: Area[], lat: number | null, lng: number | null) {
  if (lat == null || lng == null || areas.length === 0) return null;
  let best: { area: Area; distance: number } | null = null;
  for (const area of areas) {
    const distance = distanceM(area.lat, area.lng, lat, lng);
    if (!best || distance < best.distance) best = { area, distance };
  }
  return best;
}
