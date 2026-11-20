import assert from 'node:assert/strict';
import test from 'node:test';
import { addressSiteLinks, areaAddressOf, priceSiteLinks, searchAddressOf } from '../web/src/priceSites.ts';

// 가상의 매물(좌표는 서울 근처의 아무 자리)
const at = (buildingType, lat = 37.5665, lng = 126.978) => ({ lat, lng, buildingType });

test('KB부동산과 호갱노노 단추는 두 사이트 지도를 매물 좌표 가운데로 연다', () => {
  const [kb, hogang] = priceSiteLinks(at('빌라'));
  assert.equal(kb.url, 'https://kbland.kr/map?xy=37.5665,126.978,17');
  assert.equal(kb.label, 'KB부동산 ↗');
  assert.equal(hogang.url, 'https://hogangnono.com/map?lat=37.5665&lng=126.978&zoom=17&mode=item');
  assert.equal(hogang.label, '호갱노노 ↗');
  assert.match(hogang.title, /오피스텔, 원룸, 빌라/);
});

test('호갱노노는 아파트면 아파트 탭으로 연다', () => {
  const hogang = priceSiteLinks(at('아파트'))[1];
  assert.equal(hogang.url, 'https://hogangnono.com/map?lat=37.5665&lng=126.978&zoom=17&mode=apt');
  assert.match(hogang.title, /아파트 지도/);
});

test('좌표는 소수점 아래 7자리까지만 넣는다', () => {
  assert.equal(priceSiteLinks(at('오피스텔', 37.123456789, 127.000000049))[0].url, 'https://kbland.kr/map?xy=37.1234568,127,17');
});

test('위치를 모르거나 토지, 상가면 단추를 두지 않는다', () => {
  assert.deepEqual(priceSiteLinks({ lat: null, lng: null, buildingType: '아파트' }), []);
  assert.deepEqual(priceSiteLinks(at('토지')), []);
  assert.deepEqual(priceSiteLinks(at('토지: 대지')), [], '경매 토지');
  assert.deepEqual(priceSiteLinks(at('상업용: 근린상가')), [], '상가');
});

// 아래 주소는 모양만 맞춘 가상의 주소다(번지와 건물 이름은 지어낸 값).
test('번지나 도로명 번호가 있으면 시도, 구, 동, 번지까지만 남긴다', () => {
  assert.equal(searchAddressOf('서울특별시 노원구 예시동 101 예시마을 3층 302호'), '서울 노원구 예시동 101');
  assert.equal(searchAddressOf('노원구 예시동 102-3 예시하임 제1동 제2층 제201호'), '서울 노원구 예시동 102-3', '시도가 없는 서울 구');
  assert.equal(searchAddressOf('서울특별시 은평구 예시동2가 45-6'), '서울 은평구 예시동2가 45-6', '동 이름에 숫자가 든 곳');
  assert.equal(searchAddressOf('서울특별시 은평구 예시로12길 34'), '서울 은평구 예시로12길 34', '도로명 주소');
  assert.equal(searchAddressOf('서울시 중구 세종대로 110'), '서울 중구 세종대로 110');
  assert.equal(searchAddressOf('서울특별시 송파구 가락동 산 12-3'), '서울 송파구 가락동 산12-3', '산 번지');
  assert.equal(searchAddressOf('강서구 예시동 77번지 2층의 일부'), '서울 강서구 예시동 77');
  assert.equal(searchAddressOf('서울특별시 강서구 예시동 88-9외 2필지 예시타워 제3층 제301호'), '서울 강서구 예시동 88-9', '경매의 여러 필지');
  assert.equal(searchAddressOf('경기도 수원시 팔달구 인계동 1000'), '경기 수원시 팔달구 인계동 1000');
  assert.equal(searchAddressOf('경기도 양평군 양서면 예시리 55'), '경기 양평군 양서면 예시리 55');
});

test('동까지만 있거나 주소가 아닌 글자면 검색 주소를 만들지 않는다', () => {
  assert.equal(searchAddressOf('노원구 예시동'), null);
  assert.equal(searchAddressOf('서울시 중구 예시로3가'), null, '동 이름의 숫자는 번지가 아니다');
  assert.equal(searchAddressOf('예시로3가 예시푸르지오'), null, '구가 없다');
  assert.equal(searchAddressOf('예시코리빙 예시점 101'), null, '지점 이름');
  assert.equal(searchAddressOf('예시로3가역 5분, 예시시장 7분'), null);
  assert.equal(searchAddressOf(null), null);
});

test('번지 있는 매물에 집품 검색 링크와 부동산플래닛 주소 복사 단추를 둔다', () => {
  const [zippoom, planet] = addressSiteLinks({ buildingType: '아파트' }, '서울특별시 노원구 예시동 101 예시마을 3층 302호');
  assert.equal(zippoom.url, `https://zippoom.com/search/${encodeURIComponent('서울 노원구 예시동 101')}?searchWithAddress=false`);
  assert.equal(zippoom.label, '집품 ↗');
  assert.equal(zippoom.copy, undefined);
  assert.equal(planet.url, 'https://map.bdsplanet.com/');
  assert.equal(planet.label, '부동산플래닛 ↗');
  assert.equal(planet.copy, '서울 노원구 예시동 101');
  assert.match(planet.title, /Ctrl\+V/);
});

test('토지와 상가는 집품(집 리뷰) 없이 부동산플래닛만 둔다', () => {
  assert.deepEqual(addressSiteLinks({ buildingType: '토지: 대지' }, '서울특별시 노원구 예시동 101').map((b) => b.label), ['부동산플래닛 ↗']);
  assert.deepEqual(addressSiteLinks({ buildingType: '상업용: 근린상가' }, '서울특별시 노원구 예시동 101').map((b) => b.label), ['부동산플래닛 ↗']);
});

test('번지 없이 동까지만 있으면 시도, 구, 동까지 남긴다', () => {
  assert.equal(areaAddressOf('노원구 예시동'), '서울 노원구 예시동');
  assert.equal(areaAddressOf('서울시 은평구 예시동2가'), '서울 은평구 예시동2가');
  assert.equal(areaAddressOf('서울특별시 노원구 예시동 101 예시마을 3층 302호'), '서울 노원구 예시동', '번지는 뺀다');
  assert.equal(areaAddressOf('예시동2가 예시타워'), null, '구가 없다');
  assert.equal(areaAddressOf('노원구'), null, '동이 없다');
  assert.equal(areaAddressOf(null), null);
});

test('동까지만 있는 매물은 집품을 동 검색으로, 부동산플래닛은 동 이름을 복사해 연다', () => {
  const [zippoom, planet] = addressSiteLinks({ buildingType: '빌라' }, '노원구 예시동');
  assert.equal(zippoom.url, `https://zippoom.com/search/${encodeURIComponent('서울 노원구 예시동')}?searchWithAddress=false`);
  assert.match(zippoom.title, /이 동\(서울 노원구 예시동\)으로/);
  assert.equal(planet.url, 'https://map.bdsplanet.com/');
  assert.equal(planet.copy, '서울 노원구 예시동');
  assert.match(planet.title, /그 동 건물들이 추천에 뜨고/);
  assert.deepEqual(addressSiteLinks({ buildingType: '빌라' }, '예시동2가 예시타워'), [], '구를 모르면 없다');
});

test('주소 칸이 비었거나 구가 빠진 매물은 동 이름과 좌표가 든 서울 구로 동을 만든다', () => {
  // 좌표는 서울시청 근처(중구), 동 이름은 지어낸 값
  const planet = addressSiteLinks({ buildingType: '빌라', dong: '예시동', lat: 37.5665, lng: 126.978 }, null).at(-1);
  assert.equal(planet.copy, '서울 중구 예시동');
  assert.equal(addressSiteLinks({ buildingType: '빌라', dong: '예시동2가', lat: 37.5665, lng: 126.978 }, '예시동2가 예시타워').at(-1).copy, '서울 중구 예시동2가');
  assert.deepEqual(addressSiteLinks({ buildingType: '빌라', dong: '예시동', lat: 35.1, lng: 129.0 }, null), [], '서울 밖 좌표');
  assert.deepEqual(addressSiteLinks({ buildingType: '빌라', dong: null, lat: 37.5665, lng: 126.978 }, null), [], '동 이름이 없다');
});
