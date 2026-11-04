import codes from './seoul-bjdong.json';
import { boundaryOf, regionBounds } from '../shared/region-geometry.js';
import { distanceM } from '../shared/geo.js';
import { validRegion } from '../shared/regions.js';
import type { AdministrativeRegion, Area } from '../shared/types.js';

export function regionCatalog(): AdministrativeRegion[] {
  return Object.entries(codes).flatMap(([sigungu, item]) => {
    const base = { sido: '서울특별시', sigungu };
    return [{ ...base, kind: 'gu' as const, code: item.code, dong: null, name: `${base.sido} ${sigungu}` },
      ...Object.entries(item.dongs).map(([dong, suffix]) => ({ ...base, kind: 'dong' as const, code: item.code + suffix, dong, name: `${base.sido} ${sigungu} ${dong}` }))];
  });
}
export function canonicalRegion(value: unknown): AdministrativeRegion | null {
  if (!validRegion(value)) return null;
  const found = regionCatalog().find((r) => r.code === value.code && r.kind === value.kind);
  return found && (['sido', 'sigungu', 'dong', 'name'] as const).every((key) => found[key] === value[key]) ? found : null;
}
export function regionArea(code: string): Omit<Area, 'id'> | null {
  const region = regionCatalog().find((r) => r.code === code);
  const bounds = region && regionBounds(code);
  if (!region || !bounds || !boundaryOf(code)) return null;
  const [west, south, east, north] = bounds;
  const lat = (south + north) / 2, lng = (west + east) / 2;
  return { name: region.dong ?? region.sigungu, region, purpose: 'collection', lat, lng, radiusM: Math.ceil(distanceM(south, west, north, east) / 2), enabled: true };
}
