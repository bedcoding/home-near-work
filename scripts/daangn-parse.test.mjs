import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptDaangnPage, createDaangnLedger, daangnCoverage, daangnRequest, daangnStationName, parseDaangnArticles } from '../server/daangn-parse.ts';

// 합성 응답만 쓴다. 실제 역, 주소, 매물 번호는 쓰지 않는다.
const PAGE_URL = 'https://realty.daangn.com/map/subway/%EC%98%88%EC%8B%9C';
const article = (id, type, trades, extra = {}) => ({
  id: `synthetic-${id}`, originalId: String(id), salesTypeV3: { type }, trades, area: '24.5', topFloor: '5', floor: '3',
  region: { name: '가상동', name3: '가상동' }, buildingName: null, addressInfo: '예시구 가상동', isHideAddress: false,
  publicCoordinate: { lat: '35.1', lon: '128.1' }, images: [{ thumbnail: 'https://example.invalid/thumb.jpg' }], ...extra,
});
const body = (articles, hasNextPage, endCursor) => JSON.stringify({ data: { subwayStationArticleConnection: {
  edges: articles.map((a) => ({ node: { article: a }, cursor: `c${a.originalId}` })), pageInfo: { endCursor, hasNextPage } } } });
const request = (after, station = '900', filter = { salesTypes: [] }) => JSON.stringify({ variables: { after, first: 10, propertyFilter: filter, subwayStationPoiId: station }, extensions: {} });
const MONTH = [{ __typename: 'MonthTrade', type: 'MONTH', deposit: 1000, monthlyPay: 60 }];

test('주거용 매물만 공통 형식으로 바꾸고 상가와 사무실은 번호만 센다', () => {
  const page = parseDaangnArticles(body([
    article(101, 'ONE_ROOM', MONTH),
    article(102, 'OFFICETEL', [{ type: 'BORROW', deposit: 21000 }]),
    article(103, 'APART', [{ type: 'BUY', price: 85000 }]),
    article(104, 'STORE', MONTH),
    article(105, 'OFFICE', MONTH),
    article(106, 'HOUSE', [{ type: 'SHORT', deposit: 100, monthlyPay: 90 }], { publicCoordinate: null }),
  ], true, 'next-1'));
  assert.equal(page.valid, true);
  assert.deepEqual(page.ids, ['101', '102', '103', '104', '105', '106']);
  assert.deepEqual(page.excludedIds, ['104', '105']);
  assert.deepEqual(page.unreadableIds, ['106'], '좌표가 없는 주거용 매물은 저장하지 않고 따로 센다');
  const [one, officetel, apt] = page.items.map((i) => i.listing);
  assert.deepEqual(one.prices, [{ deal: 'monthly', deposit: 1000, monthly: 60, price: null }]);
  assert.deepEqual([one.roomLabel, one.buildingType, one.url], ['원룸', null, 'https://realty.daangn.com/articles/101']);
  assert.deepEqual([one.lat, one.lng, one.areaM2, one.floor, one.totalFloors], [35.1, 128.1, 24.5, 3, 5]);
  assert.deepEqual(officetel.prices, [{ deal: 'jeonse', deposit: 21000, monthly: null, price: null }]);
  assert.equal(officetel.buildingType, '오피스텔');
  assert.deepEqual(apt.prices, [{ deal: 'sale', deposit: null, monthly: null, price: 85000 }]);
  assert.deepEqual([page.hasNextPage, page.endCursor], [true, 'next-1']);
  assert.equal(parseDaangnArticles('{"data":{"viewer":{}}}').valid, false);
});

test('역 화면 주소와 요청 본문에서 역 이름, 역 번호, 이어 받을 위치를 읽는다', () => {
  assert.equal(daangnStationName(PAGE_URL), '예시');
  assert.equal(daangnStationName('https://realty.daangn.com/articles/1'), null);
  assert.equal(daangnStationName('https://example.invalid/map/subway/x'), null);
  assert.deepEqual(daangnRequest(request('c1')), { stationPoiId: '900', after: 'c1', filter: '{"salesTypes":[]}' });
  assert.equal(daangnRequest('not json'), null);
  assert.equal(daangnRequest(JSON.stringify({ variables: { subwayStationPoiId: 'x' } })), null);
});

test('끝 페이지까지 이어 받고 주거용 매물이 모두 저장돼야 완료로 본다', () => {
  const ledger = createDaangnLedger('예시');
  acceptDaangnPage(ledger, { pageUrl: PAGE_URL, requestBody: request(null), status: 200, body: body([article(201, 'ONE_ROOM', MONTH), article(202, 'STORE', MONTH)], true, 'p1') });
  assert.equal(daangnCoverage(ledger).reason, 'more-pages');
  acceptDaangnPage(ledger, { pageUrl: PAGE_URL, requestBody: request('p1'), status: 200, body: body([article(203, 'TWO_ROOM', MONTH)], false, 'p2') });
  assert.equal(daangnCoverage(ledger).reason, 'unverified-storage');
  ledger.articles['201'] = 'stored';
  ledger.articles['203'] = 'stored';
  assert.deepEqual(daangnCoverage(ledger), { stationPoiId: '900', pages: 2, received: 3, stored: 2, excluded: 1, unreadable: 0, complete: true, reason: 'complete' });
});

test('역, 조건, 페이지 순서가 바뀌거나 요청 본문이 없으면 완료로 인정하지 않는다', () => {
  const cases = [
    [{ requestBody: request('wrong-cursor') }, 'list-changed'],
    [{ requestBody: request('p1', '901') }, 'station-changed'],
    [{ requestBody: request('p1', '900', { salesTypes: ['ONE_ROOM'] }) }, 'query-changed'],
    [{ requestBody: null }, 'missing-request'],
    [{ pageUrl: 'https://realty.daangn.com/map/subway/%EB%8B%A4%EB%A5%B8' }, 'response-scope'],
    [{ status: 500 }, 'response-status'],
  ];
  for (const [change, reason] of cases) {
    const ledger = createDaangnLedger('예시');
    acceptDaangnPage(ledger, { pageUrl: PAGE_URL, requestBody: request(null), status: 200, body: body([article(301, 'ONE_ROOM', MONTH)], true, 'p1') });
    acceptDaangnPage(ledger, { pageUrl: PAGE_URL, requestBody: request('p1'), status: 200, body: body([article(302, 'ONE_ROOM', MONTH)], false, 'p2'), ...change });
    for (const id of Object.keys(ledger.articles)) ledger.articles[id] = 'stored';
    const coverage = daangnCoverage(ledger);
    assert.equal(coverage.complete, false, reason);
    assert.equal(coverage.reason, reason);
  }
});

test('지도 매물 목록(articleFeed)도 주거용만 바꾸고, 광고 칸은 건너뛰며, 다음 페이지 여부를 읽는다', async () => {
  const { parseDaangnFeed } = await import('../server/daangn-parse.ts');
  const feed = (nodes, hasNextPage, endCursor) => JSON.stringify({ data: { articleFeed: {
    edges: nodes.map((node, i) => ({ node, cursor: `f${i}` })), pageInfo: { endCursor, hasNextPage } } } });
  const page = parseDaangnFeed(feed([
    { type: 'ARTICLE', article: article(201, 'TWO_ROOM', MONTH) },
    { type: 'ADVERTISEMENT', article: null, advertisement: { id: 'ad-1' } },
    { type: 'ARTICLE', article: article(202, 'STORE', MONTH) },
  ], true, 'feed-next'));
  assert.equal(page.valid, true);
  assert.deepEqual(page.ids, ['201', '202']);
  assert.deepEqual(page.excludedIds, ['202']);
  assert.deepEqual(page.items.map((i) => i.listing.roomLabel), ['투룸 이상']);
  assert.deepEqual([page.hasNextPage, page.endCursor], [true, 'feed-next']);
  assert.equal(parseDaangnFeed(feed([{ type: 'ARTICLE', article: null }], false, null)).valid, false, '광고도 매물도 아닌 칸은 못 읽은 것으로 본다');
  assert.equal(parseDaangnFeed('{"data":{"count":3}}').hasNextPage, null);
});
