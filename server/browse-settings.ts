import type { Area } from '../shared/types.js';
import { normalizeDabangRegionScope, type DabangRegionScope } from './browse-scope.js';

export const BROWSE_SCOPES_KEY = 'browse_area_scopes';

/** Private preferences are anchored to the original area, so reused IDs cannot inherit them. */
export function readBrowseScopes(raw: string | null, areas: Area[]): Record<string, DabangRegionScope[]> {
  if (raw == null) return {};
  const input: unknown = JSON.parse(raw);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid browse settings');
  const result: Record<string, DabangRegionScope[]> = {};
  for (const [id, value] of Object.entries(input)) {
    const area = areas.find((a) => String(a.id) === id);
    if (!area) continue;
    if (!value || typeof value !== 'object') throw new Error('invalid browse settings');
    const entry = value as { area?: { name?: unknown; lat?: unknown; lng?: unknown }; regions?: unknown };
    if (entry.area?.name !== area.name || entry.area.lat !== area.lat || entry.area.lng !== area.lng ||
        !Array.isArray(entry.regions) || !entry.regions.length || entry.regions.length > 50) throw new Error('browse area changed');
    result[id] = entry.regions.map((r) => {
      const scope = normalizeDabangRegionScope(r);
      if (!scope) throw new Error('invalid browse scope');
      return scope;
    });
  }
  return result;
}
