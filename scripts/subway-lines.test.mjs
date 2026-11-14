import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { NEAR_M, nearLines } from '../web/src/subwayNear.ts';

// 지도에 까는 지하철 노선 자료(web/src/subway-lines.json, scripts/build-subway-lines.mjs로 만듦)가 역 목록(server/stations-kric.json)의
// 노선 이름과 맞는지, 거리 핀 근처 노선 고르기가 맞는지 본다. nearLines에 넣는 핀과 역은 지어낸 값이다.
const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const { lines } = read('../web/src/subway-lines.json');
const { stations } = read('../server/stations-kric.json');

test('역 목록의 노선 이름은 OSM에 노선 묶음이 없는 자기부상철도 말고 모두 노선 자료의 이름이나 다른 이름에 있다', () => {
  const names = new Set(lines.flatMap((l) => [l.name, ...l.aliases]));
  const missing = [...new Set(stations.flatMap((s) => s.lines))].filter((n) => !names.has(n) && n !== '자기부상철도');
  assert.deepEqual(missing, []);
});

test('노선 자료는 노선마다 색과, 수도권 근처 위도와 경도가 번갈아 든 선을 가진다', () => {
  assert.ok(lines.length >= 20, `노선 ${lines.length}개`);
  assert.equal(new Set(lines.map((l) => l.name)).size, lines.length);
  for (const l of lines) {
    assert.match(l.color, /^#[0-9A-F]{6}$/, l.name);
    assert.ok(l.paths.length > 0, l.name);
    for (const p of l.paths) {
      assert.ok(p.length >= 4 && p.length % 2 === 0, l.name);
      for (let i = 0; i < p.length; i += 2) {
        assert.ok(p[i] > 36 && p[i] < 38.5, `${l.name} 위도 ${p[i]}`);
        assert.ok(p[i + 1] > 126 && p[i + 1] < 128.5, `${l.name} 경도 ${p[i + 1]}`);
      }
    }
  }
});

test('nearLines는 거리 핀에서 NEAR_M 안의 역 노선만 고르고, 노선마다 가장 가까운 핀과 역을 남긴다', () => {
  const st = [
    { name: '가역', lines: ['A선', 'B선'], lat: 37.5, lng: 127.0 },
    { name: '나역', lines: ['B선'], lat: 37.5, lng: 127.005 },
    { name: '다역', lines: ['C선'], lat: 37.52, lng: 127.0 },
  ];
  // 핀에서 가역은 350m쯤, 나역은 90m쯤, 다역은 2km 넘게 떨어져 있다.
  const near = nearLines([{ name: '핀', lat: 37.5, lng: 127.004 }], st);
  assert.deepEqual([...near.keys()].sort(), ['A선', 'B선']);
  assert.equal(near.get('A선').station, '가역');
  assert.equal(near.get('B선').station, '나역');
  assert.ok(near.get('A선').m > 300 && near.get('A선').m < NEAR_M);
  // 핀이 여럿이면 노선마다 더 가까운 핀을 남긴다.
  const two = nearLines([{ name: '먼 핀', lat: 37.5, lng: 127.008 }, { name: '핀', lat: 37.5, lng: 127.004 }], st);
  assert.equal(two.get('A선').pin, '핀');
  assert.equal(nearLines([], st).size, 0);
});
