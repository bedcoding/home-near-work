import assert from 'node:assert/strict';
import test from 'node:test';
import { daangnFilter, daangnPriceViews, daangnPricesMatch } from '../server/daangn-price.ts';

// 합성 값만 쓴다. 실제 역, 주소, 매물 번호는 쓰지 않는다.
const HOMES = ['ONE_ROOM', 'TWO_ROOM', 'OFFICETEL', 'APART', 'HOUSE'];
const unset = { saleMax: null, jeonseMax: null, monthlyDepositMax: null, monthlyMax: null, excludeSale: false };
const open = { monthlyMax: null, depositMax: null, saleMax: null };

test('가격 조건이 없으면 거래 종류를 가리지 않는 목록 하나만 연다', () => {
  assert.deepEqual(daangnPriceViews(), [null]);
  assert.deepEqual(daangnPriceViews(unset), [null]);
  assert.deepEqual(daangnFilter(null), { salesTypes: HOMES });
});

test('상한이 걸린 거래 종류는 따로 열고, 상한이 없는 종류끼리는 한 목록으로 묶는다', () => {
  const caps = { ...unset, jeonseMax: 20000, monthlyDepositMax: 1000, monthlyMax: 55 };
  assert.deepEqual(daangnPriceViews(caps), [
    { suffix: '-monthly', label: '월세와 단기', tradeTypes: ['MONTH', 'SHORT'], monthlyMax: 55, depositMax: 1000, saleMax: null },
    { suffix: '-jeonse', label: '전세', tradeTypes: ['BORROW'], monthlyMax: null, depositMax: 20000, saleMax: null },
    { suffix: '-sale', label: '매매', tradeTypes: ['BUY'], ...open },
  ]);
  assert.deepEqual(daangnPriceViews({ ...caps, excludeSale: true }).map(view => view.suffix), ['-monthly', '-jeonse'], '매매 제외면 매매 목록을 열지 않는다');
  assert.deepEqual(daangnPriceViews({ ...unset, saleMax: 50000 }), [
    { suffix: '-sale', label: '매매', tradeTypes: ['BUY'], monthlyMax: null, depositMax: null, saleMax: 50000 },
    { suffix: '-monthly-jeonse', label: '월세와 단기, 전세', tradeTypes: ['MONTH', 'SHORT', 'BORROW'], ...open },
  ]);
  assert.deepEqual(daangnPriceViews({ ...unset, excludeSale: true }), [
    { suffix: '-monthly-jeonse', label: '월세와 단기, 전세', tradeTypes: ['MONTH', 'SHORT', 'BORROW'], ...open },
  ]);
});

test('전월세만 조회는 단기와 매매를 빼고 연다', () => {
  assert.deepEqual(daangnPriceViews(undefined, true), [
    { suffix: '-monthly-jeonse', label: '월세, 전세', tradeTypes: ['MONTH', 'BORROW'], ...open },
  ]);
  assert.deepEqual(daangnPriceViews({ ...unset, saleMax: 50000, monthlyMax: 70 }, true).map(view => [view.suffix, view.tradeTypes, view.saleMax]), [
    ['-monthly', ['MONTH'], null], ['-jeonse', ['BORROW'], null],
  ]);
});

test('사이트에 보내는 상한은 사이트 눈금으로 올리고, 눈금 끝을 넘으면 보내지 않는다', () => {
  const view = (caps) => ({ suffix: '-x', label: 'x', tradeTypes: ['MONTH'], ...open, ...caps });
  const range = maxAmount => ({ minAmount: 0, maxAmount });
  assert.deepEqual(daangnFilter(view({ monthlyMax: 55, depositMax: 1000 })),
    { salesTypes: HOMES, tradeTypes: ['MONTH'], monthlyPay: range(60), depositPay: range(1000) });
  for (const [cap, sent] of [[0, 0], [1, 10], [300, 300], [301, null]]) {
    assert.deepEqual(daangnFilter(view({ monthlyMax: cap })).monthlyPay, sent === null ? undefined : range(sent), `월세 ${cap}`);
  }
  for (const [cap, sent] of [[0, 0], [500, 1000], [10000, 10000], [10001, 15000], [12000, 15000], [200000, 200000], [200001, null]]) {
    assert.deepEqual(daangnFilter(view({ depositMax: cap })).depositPay, sent === null ? undefined : range(sent), `보증금 ${cap}`);
  }
  for (const [cap, sent] of [[43000, 45000], [400000, 400000], [400001, null]]) {
    assert.deepEqual(daangnFilter(view({ saleMax: cap })).pricePay, sent === null ? undefined : range(sent), `매매가 ${cap}`);
  }
});

test('받은 매물은 정확한 상한으로 다시 거른다', () => {
  const caps = { ...unset, jeonseMax: 20000, monthlyDepositMax: 1000, monthlyMax: 55, saleMax: 50000 };
  const monthly = (deposit, rent) => ({ deal: 'monthly', deposit, monthly: rent, price: null });
  const jeonse = deposit => ({ deal: 'jeonse', deposit, monthly: null, price: null });
  const sale = price => ({ deal: 'sale', deposit: null, monthly: null, price });
  assert.equal(daangnPricesMatch([monthly(5000, 300)]), true, '조건이 없으면 모두 통과');
  assert.equal(daangnPricesMatch([monthly(1000, 55)], caps), true);
  assert.equal(daangnPricesMatch([monthly(1000, 60)], caps), false, '눈금으로 올려 받은 60은 상한 55 밖');
  assert.equal(daangnPricesMatch([monthly(2000, 50)], caps), false);
  assert.equal(daangnPricesMatch([monthly(2000, 50), jeonse(20000)], caps), true, '거래 조건 중 하나라도 맞으면 저장');
  assert.equal(daangnPricesMatch([jeonse(20001)], caps), false);
  assert.equal(daangnPricesMatch([sale(50000)], caps), true);
  assert.equal(daangnPricesMatch([sale(50000)], { ...caps, excludeSale: true }), false);
  assert.equal(daangnPricesMatch([{ deal: 'short', deposit: 100, monthly: 50, price: null }], caps), true);
  assert.equal(daangnPricesMatch([{ deal: 'short', deposit: 100, monthly: 50, price: null }], caps, true), false, '전월세만 조회는 단기를 뺀다');
  assert.equal(daangnPricesMatch([], caps), false, '읽은 가격이 없으면 조건 안이라고 볼 수 없다');
});

// 가짜 화면으로 수집 루프를 돌린다. 지도마다 목록 한 쪽을 주고 끝낸다.
async function collect({ priceLimits, rentalOnly, pages }) {
  const { collectDaangn, daangnFeedUrl } = await import('../server/collectors/daangn.ts');
  const listeners = new Map();
  const frame = { url: () => frameUrl };
  let frameUrl = 'about:blank';
  const opened = [], coverage = [], logs = [], shots = [];
  const article = (id, type, trades) => ({
    originalId: String(id), salesTypeV3: { type }, trades, area: '24.5', topFloor: '5', floor: '3',
    region: { name: '가상동', name3: '가상동' }, buildingName: null, addressInfo: '예시구 가상동', isHideAddress: false,
    publicCoordinate: { lat: '35.1', lon: '128.1' }, images: [],
  });
  const session = {
    page: {
      on: (event, handler) => { listeners.set(event, handler); },
      off: event => { listeners.delete(event); },
      mainFrame: () => frame,
      evaluate: async () => null,
      waitForTimeout: async () => {},
    },
    record() {}, rest: async () => {}, wheel: async () => {},
    screenshot: async (_source, name) => { shots.push(name); return null; },
    goto: async (_source, targetUrl) => {
      const rows = pages[opened.length] ?? [];
      opened.push(targetUrl);
      frameUrl = targetUrl;
      listeners.get('framenavigated')(frame);
      const request = { url: () => 'https://realty.kr.karrotmarket.com/graphql', method: () => 'POST', postDataJSON: () => null,
        frame: () => frame, isNavigationRequest: () => false };
      listeners.get('request')(request);
      listeners.get('response')({ request: () => request, url: request.url, status: () => 200,
        text: async () => JSON.stringify({ data: { articleFeed: {
          edges: rows.map(row => ({ node: { article: article(...row) } })), pageInfo: { endCursor: `end-${opened.length}`, hasNextPage: false } } } }) });
      return { status: () => 200 };
    },
  };
  const box = { south: 35, west: 127, north: 36, east: 128, zoom: 14 };
  const items = await collectDaangn({
    session, priceLimits, rentalOnly, log: line => logs.push(line), progress() {}, partial() {},
    coverage: (row, ids) => coverage.push({ category: row.category, label: row.label, complete: row.complete, ids }),
  }, [{ area: { id: 1, name: '가상동' }, station: { name: '가상역' }, box }]);
  return { items, opened, coverage, logs, shots, expectedUrl: view => daangnFeedUrl('가상역', box, view) };
}

const MONTH = (deposit, monthlyPay) => [{ type: 'MONTH', deposit, monthlyPay }];
const BORROW = deposit => [{ type: 'BORROW', deposit }];

test('가격 조건이 없으면 지도를 한 번 열고 받은 주거 매물을 모두 저장한다', async () => {
  const run = await collect({ pages: [[[1, 'OPEN_ONE_ROOM', MONTH(5000, 300)], [2, 'TWO_ROOM', BORROW(90000)]]] });
  assert.deepEqual(run.opened, [run.expectedUrl(null)]);
  assert.deepEqual(JSON.parse(new URL(run.opened[0]).searchParams.get('af')), { salesTypes: HOMES });
  assert.deepEqual(run.coverage, [{ category: 'map', label: '지도 매물', complete: true, ids: ['1', '2'] }]);
  assert.deepEqual(run.shots, ['가상동']);
});

test('가격 조건이 있으면 거래 종류별로 지도를 열고 상한 밖 매물은 저장하지 않는다', async () => {
  const priceLimits = { saleMax: null, jeonseMax: 20000, monthlyDepositMax: 1000, monthlyMax: 55, excludeSale: true };
  const run = await collect({ priceLimits, pages: [
    [[1, 'OPEN_ONE_ROOM', MONTH(1000, 55)], [2, 'SPLIT_ONE_ROOM', MONTH(1000, 60)]],
    [[3, 'TWO_ROOM', BORROW(20000)], [4, 'APART', BORROW(21000)]],
  ] });
  const filters = run.opened.map(url => JSON.parse(new URL(url).searchParams.get('af')));
  assert.deepEqual(filters, [
    { salesTypes: HOMES, tradeTypes: ['MONTH', 'SHORT'], monthlyPay: { minAmount: 0, maxAmount: 60 }, depositPay: { minAmount: 0, maxAmount: 1000 } },
    { salesTypes: HOMES, tradeTypes: ['BORROW'], depositPay: { minAmount: 0, maxAmount: 20000 } },
  ]);
  assert.equal(new URL(run.opened[0]).searchParams.get('region_bounds'), new URL(run.opened[1]).searchParams.get('region_bounds'), '같은 지도 범위를 연다');
  assert.deepEqual(run.items.map(item => item.listing.sourceId), ['1', '3']);
  assert.deepEqual(run.coverage, [
    { category: 'map-monthly', label: '지도 매물 (월세와 단기)', complete: true, ids: ['1'] },
    { category: 'map-jeonse', label: '지도 매물 (전세)', complete: true, ids: ['3'] },
  ]);
  assert.deepEqual(run.shots, ['가상동-monthly', '가상동-jeonse']);
  assert.ok(run.logs.some(line => /가상동 월세와 단기 .*가격 조건 밖 1건 제외/.test(line)), run.logs.join('\n'));
});
