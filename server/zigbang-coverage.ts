import type { parseZigbangItemRows } from './zigbang-parse.js';

export interface ZigbangCoverage {
  stationId: string;
  radiusKm: number;
  total: number | null;
  received: number;
  stored: number;
  excluded: number;
  missing: number;
  unreadable: number;
  complete: boolean;
  reason: string;
}

export interface ZigbangLedger {
  stationId: string;
  query?: string;
  expected?: string[];
  invalid?: string;
  details: Record<string, 'unreadable' | 'received' | 'stored' | 'outside'>;
}

const MAX_IDS = 100_000;
const zigbangHost = (url: URL) => url.protocol === 'https:' && !url.username && !url.password && !url.port && /(^|\.)zigbang\.com$/.test(url.hostname);

export function zigbangPageStation(pageUrl: unknown): string | null {
  try {
    const url = new URL(typeof pageUrl === 'string' ? pageUrl : '');
    return zigbangHost(url) ? /^\/home\/oneroom\/subways\/([1-9]\d*)\/items\/?$/.exec(url.pathname)?.[1] ?? null : null;
  } catch { return null; }
}

/** The first page and list establish one immutable station/query, never a union of filters. */
export function recordZigbangPage(ledger: ZigbangLedger, pageUrl: unknown) {
  if (zigbangPageStation(pageUrl) !== ledger.stationId) ledger.invalid ||= 'station-changed';
}

export function recordZigbangStationList(ledger: ZigbangLedger, url: string, body: string) {
  try {
    const u = new URL(url);
    const station = /\/items\/subways\/([1-9]\d*)\/onerooms$/.exec(u.pathname)?.[1];
    if (!zigbangHost(u) || station !== ledger.stationId) { ledger.invalid ||= 'station-changed'; return; }
    if (u.searchParams.getAll('radius').length !== 1 || Number(u.searchParams.get('radius')) !== 1) {
      ledger.invalid ||= 'radius-mismatch'; return;
    }
    const query = JSON.stringify([u.pathname, [...u.searchParams].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))]);
    if (ledger.query && ledger.query !== query) { ledger.invalid ||= 'query-changed'; return; }
    ledger.query = query;
    const rows = JSON.parse(body)?.items;
    if (!Array.isArray(rows) || rows.length > MAX_IDS || rows.some((r) => !Number.isSafeInteger(r?.id) || r.id <= 0)) {
      ledger.invalid ||= 'unreadable-list'; return;
    }
    const ids = [...new Set<string>(rows.map((r) => String(r.id)))].sort();
    if (ids.length !== rows.length) { ledger.invalid ||= 'duplicate-list-id'; return; }
    if (ledger.expected && JSON.stringify(ledger.expected) !== JSON.stringify(ids)) { ledger.invalid ||= 'list-changed'; return; }
    ledger.expected = ids;
  } catch { ledger.invalid ||= 'unreadable-list'; }
}

export function recordZigbangDetails(ledger: ZigbangLedger, parsed: ReturnType<typeof parseZigbangItemRows>) {
  if (!parsed.valid) { ledger.invalid ||= 'unreadable-details'; return; }
  for (const id of parsed.unreadableIds) ledger.details[id] = 'unreadable';
  for (const { listing } of parsed.items) ledger.details[listing.sourceId] = 'received';
  const ids = Object.keys(ledger.details);
  if (ids.length > MAX_IDS) {
    ledger.invalid ||= 'coverage-limit';
    ledger.details = Object.fromEntries(ids.slice(0, MAX_IDS).map((id) => [id, ledger.details[id]]));
  }
}

export function zigbangCoverage(ledger: ZigbangLedger): ZigbangCoverage {
  const expected = ledger.expected ?? [];
  const count = (state: string) => expected.filter((id) => ledger.details[id] === state).length;
  const stored = count('stored');
  const excluded = count('outside');
  const unreadable = count('unreadable');
  const received = expected.filter((id) => !!ledger.details[id]).length;
  const missing = expected.length - received;
  const reason = ledger.invalid || (ledger.expected === undefined ? 'missing-list' : missing ? 'missing-details'
    : unreadable ? 'unreadable-details' : stored + excluded !== expected.length ? 'unverified-storage' : 'complete');
  return { stationId: ledger.stationId, radiusKm: 1, total: ledger.expected?.length ?? null, received, stored, excluded,
    missing, unreadable, complete: reason === 'complete', reason };
}
