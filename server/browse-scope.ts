/** Private browser-tour preferences are stored in the local database, never as defaults. */
export interface DabangRegionScope {
  kind: 'dabang-region';
  name: string;
  dong: string;
  url: string;
}

const invalidScope = () => Object.assign(new Error('다방 동별 조회 범위가 올바르지 않습니다.'), { statusCode: 400 });
const cleanLabel = (value: unknown, max: number): string => {
  if (typeof value !== 'string') throw invalidScope();
  const text = value.trim().normalize('NFC');
  if (!text || text.length > max || /[\u0000-\u001f\u007f<>]/u.test(text)) throw invalidScope();
  return text;
};

function regionUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2000) throw invalidScope();
  let url: URL;
  try { url = new URL(value); } catch { throw invalidScope(); }
  if (url.protocol !== 'https:' || !['www.dabangapp.com', 'dabangapp.com'].includes(url.hostname) ||
      url.port || url.username || url.password || url.hash || url.pathname !== '/map/onetwo' ||
      url.searchParams.get('search_type') !== 'region' || !/^\d{1,20}$/.test(url.searchParams.get('search_id') ?? '')) throw invalidScope();
  for (const key of ['search_type', 'search_id', 'm_lat', 'm_lng', 'm_zoom']) {
    if (url.searchParams.getAll(key).length > 1) throw invalidScope();
  }
  for (const [key, min, max] of [['m_lat', 33, 39], ['m_lng', 124, 132], ['m_zoom', 1, 22]] as const) {
    if (!url.searchParams.has(key)) continue;
    const value = Number(url.searchParams.get(key));
    if (!Number.isFinite(value) || value < min || value > max) throw invalidScope();
  }
  url.hostname = 'www.dabangapp.com';
  url.searchParams.sort();
  return url;
}

export function normalizeDabangRegionScope(value: unknown): DabangRegionScope | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidScope();
  const scope = value as Record<string, unknown>;
  if (scope.kind !== 'dabang-region') throw invalidScope();
  return { kind: 'dabang-region', name: cleanLabel(scope.name, 120), dong: cleanLabel(scope.dong, 60), url: regionUrl(scope.url).href };
}

/** A changed viewport is allowed, but leaving the explicitly selected region is not. */
export function matchesDabangRegionPage(scope: DabangRegionScope, pageUrl: unknown): boolean {
  try {
    return regionUrl(pageUrl).searchParams.get('search_id') === new URL(scope.url).searchParams.get('search_id');
  } catch { return false; }
}

export function sameDabangRegionScope(a: DabangRegionScope | null | undefined, b: DabangRegionScope | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Region responses carry both the page's internal ID and the legal-dong code. */
export function matchesDabangRegionResponse(scope: DabangRegionScope, requestUrl: string, region: unknown): boolean {
  try {
    const url = new URL(requestUrl);
    const value = region as Record<string, unknown> | null;
    return url.protocol === 'https:' && ['www.dabangapp.com', 'dabangapp.com'].includes(url.hostname) &&
      !url.port && !url.username && !url.password && !url.hash &&
      url.pathname === '/api/v5/room-list/category/one-two/region' &&
      url.searchParams.getAll('code').length === 1 && url.searchParams.getAll('filters').length === 1 &&
      /^\d{8}$/.test(url.searchParams.get('code') ?? '') && !!value &&
      Number.isSafeInteger(value.gid) && Number(value.gid) > 0 &&
      String(value.gid) === new URL(scope.url).searchParams.get('search_id') &&
      value.code === url.searchParams.get('code') && typeof value.name === 'string' &&
      value.name.trim().normalize('NFC') === scope.dong;
  } catch { return false; }
}

/** A map response can arrive before the selected region's list. It is not that list. */
export function isDabangMapResponse(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return url.protocol === 'https:' && ['www.dabangapp.com', 'dabangapp.com'].includes(url.hostname) &&
      !url.port && !url.username && !url.password && !url.hash &&
      url.pathname === '/api/v5/room-list/category/one-two/bbox';
  } catch { return false; }
}
