import type { Area } from '../shared/types.js';

const EARTH_RADIUS_M = 6371000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

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
