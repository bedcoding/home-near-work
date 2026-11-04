import assert from 'node:assert/strict';
import test from 'node:test';
import { coverageMetrics } from '../shared/collection-coverage.ts';
const scope = (id, total, received, extra = {}) => ({ areaId: id, areaName: '가상구', category: 'synthetic', label: '예시 유형',
  total, received, pages: 1, totalPages: 1, stored: received, complete: false, reason: 'synthetic count difference', ...extra });

test('response ratios use displayed scope totals and keep overlapping scopes as a labelled aggregate', () => {
  const result = coverageMetrics([scope(1, 11, 10), scope(2, 19, 18, { pages: 3, totalPages: 3 })]);
  assert.equal(result.displayed, 30);
  assert.equal(result.received, 28);
  assert.equal(result.gap, 2);
  assert.equal(result.gapPercent, 2 / 30 * 100);
  assert.equal(result.pagesReceived, 4);
  assert.equal(result.pagesPlanned, 4);
  assert.equal(coverageMetrics([scope(1, 4, 3), scope(2, 4, 3)]).received, 6, 'this is not a unique-home count');
});

test('unconfirmed totals and empty lists do not invent a zero gap or a percentage', () => {
  for (const rows of [[], [scope(1, null, 2)], [scope(1, -1, 2)], [scope(1, 3, NaN)]]) {
    const result = coverageMetrics(rows);
    assert.equal(result.displayed, null);
    assert.equal(result.gap, null);
    assert.equal(result.responsePercent, null);
  }
  const empty = coverageMetrics([scope(1, 0, 0)]);
  assert.equal(empty.gap, 0);
  assert.equal(empty.responsePercent, null);
  assert.equal(coverageMetrics([scope(1, null, 0, { totalPages: null })]).pagesPlanned, null);
});

test('extra rows in one scope cannot cancel a short response in another scope', () => {
  const result = coverageMetrics([scope(1, 6, 4), scope(2, 4, 6)]);
  assert.equal(result.gap, 2);
  assert.equal(result.excess, 2);
  assert.equal(result.gapPercent, 20);
});
