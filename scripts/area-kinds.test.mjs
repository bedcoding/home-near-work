import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionAreas, lastAreaKindError, missingAreaKinds, primaryAreas } from '../shared/regions.ts';

// 합성 지역만 쓴다.
const gu = (id, extra = {}) => ({ id, name: `가상구 ${id}`, lat: 37.5, lng: 127, radiusM: 3000, enabled: true, purpose: 'collection',
  region: { kind: 'gu', code: '99123', sido: '예시도', sigungu: '가상구', dong: null, name: '예시도 가상구' }, ...extra });
const station = (id, extra = {}) => ({ id, name: `가상역 ${id}`, lat: 37.51, lng: 127.01, radiusM: 1000, enabled: true, purpose: 'alert', ...extra });

test('수집 지역은 켜진 구나 동과 켜진 지하철역(알림용 포함)을 함께 쓴다', () => {
  const areas = [gu(1), station(2), station(3, { enabled: false }), gu(4, { purpose: 'alert' })];
  assert.deepEqual(collectionAreas(areas).map((a) => a.id), [1, 2]);
  assert.deepEqual(primaryAreas(areas).map((a) => a.id), [1], '목록의 수집 구, 동 안 판단은 그대로다');
});

test('구나 동과 지하철역 중 빠진 쪽을 알려 준다', () => {
  assert.deepEqual(missingAreaKinds([gu(1), station(2)]), []);
  assert.deepEqual(missingAreaKinds([gu(1)]), ['station']);
  assert.deepEqual(missingAreaKinds([station(2)]), ['region']);
  assert.deepEqual(missingAreaKinds([gu(1, { enabled: false }), station(2, { enabled: false })]), ['region', 'station']);
});

test('마지막 구나 동, 마지막 지하철역은 끄거나 지울 수 없고, 하나 더 있으면 된다', () => {
  const areas = [gu(1), station(2)];
  assert.match(lastAreaKindError(areas, 1, { enabled: false }), /마지막 구나 동/);
  assert.match(lastAreaKindError(areas, 2, { deleted: true }), /마지막 지하철역/);
  assert.equal(lastAreaKindError(areas, 2, { enabled: true }), null);
  assert.equal(lastAreaKindError([...areas, station(3)], 2, { enabled: false }), null);
  assert.equal(lastAreaKindError([...areas, gu(4)], 1, { deleted: true }), null);
  // 이미 한쪽이 빈 상태에서 다른 지역을 바꾸는 것은 막지 않는다(화면 경고로 알린다).
  assert.equal(lastAreaKindError([gu(1), gu(4)], 1, { enabled: false }), null);
});
