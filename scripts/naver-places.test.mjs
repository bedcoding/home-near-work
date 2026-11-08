import assert from 'node:assert/strict';
import test from 'node:test';
import { naverComplexOf, naverLink, rememberNaverPlaces } from '../web/src/naverPlaces.ts';

// 가상의 매물(좌표는 서울 근처의 아무 자리, 단지 번호와 주소는 지어낸 값)
const at = { lat: 37.5, lng: 127.0 };
const naverComplex = (no, kind, lat = at.lat, lng = at.lng) => ({ id: `naver:${no}`, source: 'naver', url: `https://fin.land.naver.com/complexes/${no}?tab=article`, buildingType: kind, lat, lng });
const other = (id, kind, dLatM = 0, source = 'zigbang') => ({ id, source, url: 'https://example.invalid/room', buildingType: kind, lat: at.lat + dLatM / 111000, lng: at.lng });

test('네이버 단지 매물은 그 단지 화면을 연다', () => {
  const l = naverComplex('101', '아파트');
  assert.equal(naverComplexOf(l), '101');
  const link = naverLink(l);
  assert.equal(link.url, 'https://fin.land.naver.com/complexes/101');
  assert.equal(link.label, '네이버 단지 ↗');
});

test('다른 사이트 매물은 같은 자리의 같은 종류 네이버 단지를 열고, 없으면 지도를 연다', () => {
  rememberNaverPlaces([naverComplex('201', '아파트'), naverComplex('202', '빌라'), naverComplex('203', '오피스텔', at.lat + 0.01)]);
  const apt = naverLink(other('a', '아파트', 33));
  assert.equal(apt.url, 'https://fin.land.naver.com/complexes/201', '아파트는 50m 안 단지');
  assert.match(apt.title, /다른 단지일 수 있습니다/);
  assert.equal(naverLink(other('b', '아파트', 80)).label, '네이버 지도 ↗', '50m 밖이면 지도');
  assert.equal(naverLink(other('c', '빌라', 10)).url, 'https://fin.land.naver.com/complexes/202', '빌라는 15m 안 단지');
  assert.equal(naverLink(other('d', '빌라', 25)).label, '네이버 지도 ↗', '빌라는 이웃 건물을 잡지 않게 15m까지만');
  assert.equal(naverLink(other('e', '오피스텔', 10)).label, '네이버 지도 ↗', '종류가 다르면 맞추지 않는다');
  assert.equal(naverLink(other('f', '단독', 0)).label, '네이버 지도 ↗', '단독은 맞추지 않는다');
});

test('네이버 단지가 아닌 네이버 매물은 지도를 열고, 상세는 원본 열기라고 알려 준다', () => {
  rememberNaverPlaces([naverComplex('301', '빌라')]);
  const link = naverLink({ id: 'naver:9', source: 'naver', url: 'https://fin.land.naver.com/articles/9', buildingType: '빌라', ...at });
  assert.equal(link.label, '네이버 지도 ↗');
  assert.match(link.title, /원본 열기/);
});

test('위치를 모르는 매물은 단추를 두지 않는다', () => {
  assert.equal(naverLink({ id: 'x', source: 'dabang', url: 'https://example.invalid', buildingType: '빌라', lat: null, lng: null }), null);
});
