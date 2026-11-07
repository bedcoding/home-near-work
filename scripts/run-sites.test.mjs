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

test('빠른 조회 전월세만은 전월세 사이트만 돌고 고방(고시원), 경매, 공고는 돌지 않는다', () => {
  const quick = RUN_SCOPES.find((s) => s.id === 'rentOnly');
  assert.ok(quick?.quick);
  assert.deepEqual(quick.sources, ['dabang', 'zigbang', 'ziptoss', 'peterpanz', 'daangn']);
  assert.deepEqual(quick.sections, []);
  assert.deepEqual(quick.tabs, []);
});

test('당근: 수집용 지역마다 반경 네모 범위로 지도 매물 목록을 열고, 가까운 아는 역 화면을 길로 쓴다', async () => {
  const { daangnBox, daangnFeedUrl, daangnTargets } = await import('../server/collectors/daangn.ts');
  const box = daangnBox({ lat: 35, lng: 128, radiusM: 1000 });
  assert.equal(box.zoom, 15);
  assert.equal(daangnBox({ lat: 35, lng: 128, radiusM: 2000 }).zoom, 14);
  assert.equal(daangnBox({ lat: 35, lng: 128, radiusM: 3800 }).zoom, 13);
  const url = new URL(daangnFeedUrl('가상역', box));
  assert.equal(decodeURIComponent(url.pathname), '/map/subway/가상', '역 화면 주소는 끝의 역을 뺀 이름');
  assert.deepEqual(url.searchParams.get('region_bounds').split(',').map((v) => Math.round(Number(v) * 1000) / 1000), [34.991, 127.989, 35.009, 128.011, 15]);

  const st = (name, lat, lng) => ({ name, lat, lng });
  const gu = { id: 1, name: '가상 구', lat: 35, lng: 128, radiusM: 3000, enabled: true, purpose: 'collection', region: { kind: 'gu', code: '99999', name: '가상 구' } };
  const alert = { id: 2, name: '알림 역', lat: 35.01, lng: 128, radiusM: 2500, enabled: true, purpose: 'alert' };
  const targets = daangnTargets([gu, alert], [st('먼역', 35.2, 128), st('가상역', 35.002, 128)]);
  assert.deepEqual(targets.map((t) => [t.area.id, t.station?.name]), [[1, '가상역']], '구가 있으면 알림용 역 반경은 따로 돌지 않는다');
  assert.equal(daangnTargets([{ ...gu, lat: 36 }], [st('가상역', 35.002, 128)])[0].station, null, '5km 안에 아는 역이 없으면 길을 못 찾는다');
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
