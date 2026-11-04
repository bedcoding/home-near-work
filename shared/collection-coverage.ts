import type { CollectionCoverage } from './types.js';

/** Scope totals overlap. These figures describe list responses, not distinct missing homes. */
export function coverageMetrics(rows: CollectionCoverage[]) {
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const comparable = rows.length > 0 && rows.every(row => count(row.total) && count(row.received));
  const displayed = comparable ? rows.reduce((sum, row) => sum + row.total!, 0) : null;
  const received = rows.reduce((sum, row) => sum + (count(row.received) ? row.received : 0), 0);
  const gap = comparable ? rows.reduce((sum, row) => sum + Math.max(0, row.total! - row.received), 0) : null;
  const excess = comparable ? rows.reduce((sum, row) => sum + Math.max(0, row.received - row.total!), 0) : null;
  const allPagesKnown = rows.length > 0 && rows.every(row => count(row.totalPages) && row.totalPages > 0);
  return {
    displayed, received, gap, excess,
    responsePercent: displayed != null && displayed > 0 ? received / displayed * 100 : null,
    gapPercent: displayed != null && displayed > 0 && gap != null ? gap / displayed * 100 : null,
    pagesReceived: rows.reduce((sum, row) => sum + (count(row.pages) ? row.pages : 0), 0),
    pagesPlanned: allPagesKnown ? rows.reduce((sum, row) => sum + row.totalPages!, 0) : null,
  };
}
