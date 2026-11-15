import { regionBounds } from '../shared/region-geometry.js';
import type { Area } from '../shared/types.js';
import { bbox } from './geo.js';

const VIEW_EDGE_PADDING_M = 10;

export interface PeterpanzBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

function validBounds(bounds: PeterpanzBounds): PeterpanzBounds | null {
  const { west, south, east, north } = bounds;
  return [west, south, east, north].every(Number.isFinite) &&
    west >= -180 && east <= 180 && south >= -90 && north <= 90 && west < east && south < north
    ? bounds
    : null;
}

function coordinate(value: unknown): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && value.trim() ? Number(value) : NaN;
}

export function parsePeterpanzBounds(raw: unknown): PeterpanzBounds | null {
  if (!raw || typeof raw !== 'object') return null;
  const { latitudeFrom, latitudeTo, longitudeFrom, longitudeTo } = raw as Record<string, unknown>;
  return validBounds({ west: coordinate(longitudeFrom), south: coordinate(latitudeFrom), east: coordinate(longitudeTo), north: coordinate(latitudeTo) });
}

export function peterpanzTargetBounds(area: Pick<Area, 'region' | 'lat' | 'lng' | 'radiusM'>): PeterpanzBounds | null {
  if (area.region?.kind === 'gu') {
    const bounds = regionBounds(area.region.code);
    if (!bounds) return null;
    const [west, south, east, north] = bounds;
    return validBounds({ west, south, east, north });
  }
  const { latMin: south, latMax: north, lngMin: west, lngMax: east } = bbox(area.lat, area.lng, area.radiusM);
  return validBounds({ west, south, east, north });
}

function subtract(target: PeterpanzBounds, covered: PeterpanzBounds): PeterpanzBounds[] {
  const west = Math.max(target.west, covered.west);
  const south = Math.max(target.south, covered.south);
  const east = Math.min(target.east, covered.east);
  const north = Math.min(target.north, covered.north);
  if (west >= east || south >= north) return [target];

  // Slice the overlap out without making the remaining strips overlap each other.
  const gaps: PeterpanzBounds[] = [];
  if (target.south < south) gaps.push({ ...target, north: south });
  if (north < target.north) gaps.push({ ...target, south: north });
  if (target.west < west) gaps.push({ west: target.west, south, east: west, north });
  if (east < target.east) gaps.push({ west: east, south, east: target.east, north });
  return gaps;
}

/** Only windows with complete lists should count toward coverage. */
export function remainingPeterpanzBounds(target: PeterpanzBounds, completed: readonly PeterpanzBounds[]): PeterpanzBounds[] {
  let remaining = [target];
  for (const view of completed) remaining = remaining.flatMap(gap => subtract(gap, view));
  return remaining;
}

function largestPeterpanzGap(gaps: readonly PeterpanzBounds[]): PeterpanzBounds | null {
  let largest: PeterpanzBounds | null = null;
  let largestArea = 0;
  for (const gap of gaps) {
    const area = (gap.east - gap.west) * (gap.north - gap.south);
    if (area > largestArea) {
      largest = gap;
      largestArea = area;
    }
  }
  return largest;
}

export function peterpanzBoundsCenter({ west, south, east, north }: PeterpanzBounds) {
  return { lat: (south + north) / 2, lng: (west + east) / 2 };
}

/** Aim a similarly sized view where it can cover the most remaining area. */
export function nextPeterpanzViewCenter(target: PeterpanzBounds, gaps: readonly PeterpanzBounds[], view: PeterpanzBounds) {
  const largest = largestPeterpanzGap(gaps);
  if (!largest) return null;
  const anchor = peterpanzBoundsCenter(largest);
  const halfLat = (view.north - view.south) / 2;
  const halfLng = (view.east - view.west) / 2;
  const paddingLat = VIEW_EDGE_PADDING_M / 111320;
  const paddingLng = paddingLat / Math.cos(peterpanzBoundsCenter(target).lat * Math.PI / 180);
  const positions = (low: number, high: number, half: number, preferred: number, padding: number) => {
    const first = low + half;
    const last = high - half;
    if (first >= last) return [(low + high) / 2];
    // The site can round or shift a requested center slightly. Verification still uses its returned bounds.
    const center = preferred <= first ? first - padding : preferred >= last ? last + padding : preferred;
    return [first - padding, last + padding, center];
  };
  let best = null;
  let bestArea = 0;
  for (const lat of positions(target.south, target.north, halfLat, anchor.lat, paddingLat)) {
    for (const lng of positions(target.west, target.east, halfLng, anchor.lng, paddingLng)) {
      const area = gaps.reduce((sum, gap) => {
        const height = Math.max(0, Math.min(gap.north, lat + halfLat) - Math.max(gap.south, lat - halfLat));
        const width = Math.max(0, Math.min(gap.east, lng + halfLng) - Math.max(gap.west, lng - halfLng));
        return sum + height * width;
      }, 0);
      if (area > bestArea) {
        bestArea = area;
        best = { lat, lng };
      }
    }
  }
  return best;
}

export function peterpanzBoundsShortages(target: PeterpanzBounds, viewport: PeterpanzBounds): string[] {
  const latMeters = 111320;
  const lngMeters = latMeters * Math.cos(peterpanzBoundsCenter(target).lat * Math.PI / 180);
  const meters = {
    북쪽: (target.north - viewport.north) * latMeters,
    남쪽: (viewport.south - target.south) * latMeters,
    동쪽: (target.east - viewport.east) * lngMeters,
    서쪽: (viewport.west - target.west) * lngMeters,
  };
  return Object.entries(meters)
    .filter(([, distance]) => distance > 0)
    .map(([direction, distance]) => `${direction} ${Math.ceil(distance)}m 부족`);
}
