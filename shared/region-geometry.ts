import data from './region-boundaries.json';

export const regionBoundaries = data as unknown as {
  type: 'FeatureCollection'; metadata: typeof data.metadata;
  features: { type: 'Feature'; properties: { sggcd: string; sggnm: string; sidonm: string }; geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] } }[];
};
export const boundaryOf = (code: string) => regionBoundaries.features.find((f) => f.properties.sggcd === code.slice(0, 5));
export function regionBounds(code: string): [number, number, number, number] | null {
  const feature = boundaryOf(code);
  if (!feature) return null;
  const points = (feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : feature.geometry.coordinates.flat()) as number[][][];
  const all = points.flat();
  return [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
}
function ringContains(ring: number[][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (Math.abs((y - yi) * (xj - xi) - (x - xi) * (yj - yi)) < 1e-12 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Polygon with holes; a bounding box is never used as proof of membership. */
export function pointInRegion(code: string, lat: number, lng: number): boolean {
  const feature = boundaryOf(code);
  if (!feature || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return pointInGeometry(feature.geometry, lat, lng);
}
export function pointInGeometry(geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] }, lat: number, lng: number): boolean {
  const polygons = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
  return polygons.some(([outer, ...holes]) => ringContains(outer, lng, lat) && !holes.some((ring) => ringContains(ring, lng, lat)));
}
export const regionColor = (code: string) => ['#2563eb', '#d97706', '#7c3aed', '#059669', '#db2777', '#0891b2'][Number(code.slice(0, 5)) % 6];
