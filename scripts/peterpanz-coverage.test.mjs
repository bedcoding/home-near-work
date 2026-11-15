import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextPeterpanzViewCenter, parsePeterpanzBounds, peterpanzBoundsCenter, peterpanzBoundsShortages,
  peterpanzTargetBounds, remainingPeterpanzBounds,
} from '../server/peterpanz-coverage.ts';

test('Peterpanz reads ordered coordinates without treating absent or nonnumeric values as zero', () => {
  const raw = { longitudeFrom: '1', latitudeFrom: '2', longitudeTo: 3, latitudeTo: 4 };
  assert.deepEqual(parsePeterpanzBounds(raw), { west: 1, south: 2, east: 3, north: 4 });
  for (const badWest of [null, false, '', ' ', 'invalid', 3, 4]) {
    assert.equal(parsePeterpanzBounds({ ...raw, longitudeFrom: badWest }), null);
  }
});

test('Peterpanz uses the public district boundary instead of the larger radius around it', () => {
  const district = { region: { kind: 'gu', code: '11110' } };
  const bounded = peterpanzTargetBounds(district);
  assert.ok(bounded);
  const centered = { ...peterpanzBoundsCenter(bounded), radiusM: 20000 };
  assert.deepEqual(peterpanzTargetBounds({ ...district, ...centered }), bounded);
  assert.deepEqual(peterpanzBoundsShortages(bounded, bounded), []);
  assert.deepEqual(remainingPeterpanzBounds(bounded, [bounded]), []);
  assert.equal(peterpanzBoundsShortages(peterpanzTargetBounds(centered), bounded).length, 4);
});

test('Peterpanz keeps diagonal gaps even when the outer bounds of two views cover the target', () => {
  const target = { west: 1, south: 1, east: 11, north: 11 };
  const views = [
    { west: 1, south: 1, east: 8, north: 7 },
    { west: 6, south: 5, east: 11, north: 11 },
  ];
  const gaps = remainingPeterpanzBounds(target, views);
  assert.deepEqual(gaps, [
    { west: 1, south: 7, east: 6, north: 11 },
    { west: 8, south: 1, east: 11, north: 5 },
  ]);
  assert.deepEqual(remainingPeterpanzBounds(target, [...views, ...gaps]), []);
});

test('Peterpanz keeps a wide follow-up centered across both edges while covering a narrow north or south gap', () => {
  const target = { west: 1, south: 1, east: 11, north: 11 };
  const first = { west: 3, south: 2, east: 15, north: 10 };
  const next = nextPeterpanzViewCenter(target, remainingPeterpanzBounds(target, [first]), first);
  assert.equal(next.lng, 6);
  assert.ok(next.lat < 5 || next.lat > 7);
  const second = { west: 0, east: 12, south: next.lat - 4, north: next.lat + 4 };
  const final = nextPeterpanzViewCenter(target, remainingPeterpanzBounds(target, [first, second]), second);
  assert.equal(final.lng, 6);
  assert.ok(next.lat < 5 ? final.lat > 7 : final.lat < 5);
  assert.deepEqual(remainingPeterpanzBounds(target, [first, second,
    { west: 0, east: 12, south: final.lat - 4, north: final.lat + 4 }]), []);
});
