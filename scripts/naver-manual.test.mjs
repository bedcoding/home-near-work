import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNaverItem, parseNaverList } from '../server/naver-parse.ts';
import { RUN_SCOPES } from '../shared/types.ts';

const item = (type, id = '101') => ({ representativeArticleInfo: {
  articleNumber: id, realEstateType: type, articleName: 'Synthetic residence', tradeType: 'B2',
  priceInfo: { warrantyPrice: 20000000, rentPrice: 400000 },
  address: { city: '예시도', division: '가상구', sector: '가상동', coordinates: { xCoordinate: 128, yCoordinate: 35 } },
} });

test('manual region-list format retains each housing type and normalizes prices', () => {
  const labels = { A01: '아파트', A02: '오피스텔', C01: '원룸', C02: '빌라', C03: '단독/다가구', A05: '연립', A06: '다세대', G01: '고시원' };
  const parsed = parseNaverList(JSON.stringify({ result: { totalCount: 100, hasNextPage: true,
    list: Object.keys(labels).map((type, i) => item(type, String(100 + i))) } }));
  assert.equal(parsed.items.length, Object.keys(labels).length);
  assert.equal(parsed.totalCount, 100, 'displayed total stays distinct from the received page length');
  assert.deepEqual(parsed.items.map(x => x.listing.buildingType), Object.values(labels));
  for (const x of parsed.items) assert.deepEqual(x.listing.prices, [{ deal: 'monthly', deposit: 2000, monthly: 40, price: null }]);
  assert.equal(normalizeNaverItem(item('UNRECOGNIZED')).listing.buildingType, 'UNRECOGNIZED');
});

test('manual source is absent from normal and scheduled automatic run scopes', () => {
  assert.equal(RUN_SCOPES.some(scope => scope.sources.includes('naver')), false);
  assert.equal(RUN_SCOPES.some(scope => scope.id === 'naver'), false);
});
