import assert from 'node:assert/strict';
import test from 'node:test';
import { readBrowseScopes } from '../server/browse-settings.ts';

const area = { id: 1, name: '예시 지역', lat: 36, lng: 128, radiusM: 500, enabled: true };
const region = { kind: 'dabang-region', name: '예시동', dong: '예시동', url: 'https://www.dabangapp.com/map/onetwo?search_type=region&search_id=99991' };
const raw = JSON.stringify({ 1: { area: { name: area.name, lat: area.lat, lng: area.lng }, regions: [region] } });
test('private dong settings require an exact area anchor, never a reused ID', () => {
  assert.equal(readBrowseScopes(raw, [area])['1'][0].dong, region.dong);
  assert.deepEqual(readBrowseScopes(raw, []), {});
  assert.throws(() => readBrowseScopes(raw, [{ ...area, name: '다른 예시 지역' }]));
  assert.throws(() => readBrowseScopes(raw, [{ ...area, lat: 36.1 }]));
  assert.deepEqual(readBrowseScopes(null, [area]), {});
  assert.throws(() => readBrowseScopes('invalid', [area]));
});
