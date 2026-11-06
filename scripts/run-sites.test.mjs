import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLECTORS } from '../server/collectors/index.ts';
import { RUN_ALL_SOURCES, RUN_PARALLEL_SITES, RUN_SCOPES } from '../shared/types.ts';

test("화면에 적는 '조회하기' 사이트 목록이 실제로 도는 수집기와 순서까지 같다", () => {
  assert.deepEqual(COLLECTORS.map((c) => c.id), RUN_ALL_SOURCES);
});

test('탭 하나만 조회의 사이트는 모두 전부 조회에 들어 있다', () => {
  for (const scope of RUN_SCOPES) for (const id of scope.sources) assert.ok(RUN_ALL_SOURCES.includes(id), `${scope.id}: ${id}`);
});

test('동시에 도는 사이트 수는 1 이상', () => {
  assert.ok(Number.isInteger(RUN_PARALLEL_SITES) && RUN_PARALLEL_SITES >= 1);
});

test('피터팬: 역 근처 지도만 통과하고, 역이 들어 있어도 서울 전체로 열린 지도는 다시 연다', async () => {
  const { openedNear } = await import('../server/collectors/peterpanz.ts');
  const area = { id: 1, name: '가상역', lat: 35, lng: 128, radiusM: 1000, enabled: true };
  const box = (dLat, dLng) => ({ latitudeFrom: area.lat - dLat, latitudeTo: area.lat + dLat, longitudeFrom: area.lng - dLng, longitudeTo: area.lng + dLng });
  assert.equal(openedNear(area, box(0.0126, 0.017), 15), true); // 남북 약 2.8km
  assert.equal(openedNear(area, box(0.025, 0.033), 14), true); // 남북 약 5.5km
  assert.equal(openedNear(area, box(0.1, 0.13), 15), false); // 남북 약 22km(서울 전체)
  assert.equal(openedNear(area, { ...box(0.0126, 0.017), latitudeFrom: area.lat + 0.01 }, 15), false); // 역이 지도 밖
  assert.equal(openedNear(area, null, 15), false);
});
