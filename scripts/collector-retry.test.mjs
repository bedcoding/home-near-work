import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as peterpanzCoverage from '../server/peterpanz-coverage.ts';

// Collector dependencies are replaced in memory. These tests cannot open the real database or make network requests.
class BlockedError extends Error {}
const noop = async () => {};
const toNumber = (v) => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const common = {
  '../config.js': { PAGE_DELAY_MS: 0, LOCAL: {} },
  '../peterpanz-coverage.js': peterpanzCoverage,
  './types.js': { BlockedError, toNumber },
  '../../shared/format.js': { priceText: () => '', floorText: () => '', money: String, yesNo: String },
};
function load(file, dependencies = {}) {
  const source = fs.readFileSync(new URL(`../server/collectors/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  const deps = { ...common, ...dependencies };
  vm.runInNewContext(outputText, {
    exports, URL, Map, Set,
    require: (id) => {
      assert.ok(Object.hasOwn(deps, id), `Unexpected dependency: ${id}`);
      return deps[id];
    },
  });
  return exports;
}
function context(session) {
  const partials = [];
  return {
    partials, areas: [{ name: 'SyntheticArea', lat: 1, lng: 1, radiusM: 500 }], aptGus: [],
    partial: (reason) => partials.push(reason), log: () => {}, progress: () => {}, classify: () => new Map(),
    session: { visible: false, rest: noop, pause: noop, record: () => {}, badges: noop, screenshot: async () => null, ...session },
  };
}

test('ziptoss retains a partial result when one station returns HTTP 500', async () => {
  const { ziptoss } = load('ziptoss.ts', {
    '../geo.js': { distanceM: () => 0 },
    '../station-catalog.js': { knownStations: () => [{ name: 'SyntheticA', lat: 1, lng: 1 }, { name: 'SyntheticB', lat: 1, lng: 1 }] },
  });
  let request = 0, evaluation = 0;
  const ctx = context({
    goto: async () => {
      const status = ++request === 1 ? 500 : 200;
      return { status: () => status };
    },
    page: {
      evaluate: async () => ++evaluation === 1 ? [{ id: 123, building: { point: { coordinates: [1, 1] } }, prices: [] }] : 0,
      waitForLoadState: noop, waitForFunction: noop,
    },
  });
  ctx.areas[0].id = 1;
  ctx.areas.push({ ...ctx.areas[0], id: 2, name: 'SyntheticAreaB' });
  const coverage = [];
  ctx.coverage = (row, ids) => coverage.push({ row, ids });
  assert.equal((await ziptoss.collect(ctx)).length, 1);
  assert.match(ctx.partials.join(), /HTTP 500/);
  assert.equal(request, 2);
  assert.equal(coverage.length, 2);
  for (const { row, ids } of coverage) {
    assert.equal(row.pages, 1);
    assert.equal(row.totalPages, 2);
    assert.equal(row.total, null);
    assert.equal(row.received, 1);
    assert.deepEqual([...ids], ['123']);
    assert.equal(row.complete, false);
  }
});

test('ziptoss distinguishes completed station pages from administrative coverage', async () => {
  const { ziptoss } = load('ziptoss.ts', {
    '../geo.js': { distanceM: () => 0 },
    '../station-catalog.js': { knownStations: () => [{ name: 'SyntheticA', lat: 1, lng: 1 }, { name: 'SyntheticB', lat: 1, lng: 1 }] },
  });
  let evaluation = 0;
  const ctx = context({
    goto: async () => ({ status: () => 200 }),
    page: {
      evaluate: async () => ++evaluation % 2 === 1 ? [{ id: 123 }] : 0,
      waitForLoadState: noop, waitForFunction: noop,
    },
  });
  ctx.areas[0].id = 1;
  ctx.areas.push({ ...ctx.areas[0], id: 2, name: 'SyntheticAreaB', region: {} });
  const coverage = [];
  ctx.coverage = (row) => coverage.push(row);
  assert.equal((await ziptoss.collect(ctx)).length, 2);
  assert.equal(coverage.length, 2);
  for (const row of coverage) {
    assert.equal(row.pages, 2);
    assert.equal(row.totalPages, 2);
    assert.equal(row.received, 1);
  }
  assert.equal(coverage[0].complete, true);
  assert.equal(coverage[1].complete, false);
  assert.match(coverage[1].reason, /구나 동 전체 범위/);
});

async function collectZiptossMap({ block = false, cancel = false, district = null, shortWithoutEnd = false, duplicate = false } = {}) {
  const { ziptoss } = load('ziptoss.ts', {
    '../geo.js': { distanceM: (lat, lng, otherLat, otherLng) => Math.hypot(lat - otherLat, lng - otherLng) * 100000 },
    '../peterpanz-coverage.js': { ...peterpanzCoverage, peterpanzTargetBounds: () => district },
    '../station-catalog.js': { knownStations: () => [{ name: 'SyntheticStation', lat: 1, lng: 1 }] },
  });
  const frame = {};
  const events = new Map();
  const opened = [];
  const receipts = [];
  let listingPage = 0;
  let mapVisits = 0;
  let focus = { lat: 1, lng: 1 };
  let evaluations = 0;
  let stopped = false;
  const row = id => ({ id, building: { point: { coordinates: [1, 1] } }, prices: [] });
  async function emit(number, { status = 200, west = focus.lng - 0.01, center = focus.lng, pathname = '/api/zp/search', sort = 'recent', count = 50, malformed = false, repeatFirst = false } = {}) {
    const uri = `https://ziptoss.com${pathname}?zoom=3&page=${number}&minLat=${focus.lat - 0.01}&maxLat=${focus.lat + 0.01}&minLng=${west}&maxLng=${focus.lng + 0.01}&lat=${focus.lat}&lng=${center}${sort ? `&sort=${sort}` : ''}`;
    const req = { resourceType: () => 'xhr', method: () => 'GET', url: () => uri, frame: () => frame };
    events.get('request')(req);
    const listings = Array.from({ length: count }, (_, index) => row((mapVisits - 1) * 1000 + (repeatFirst ? 0 : (number - 1) * 50) + index + 1));
    await events.get('response')({ request: () => req, url: () => uri, status: () => status, json: async () => malformed ? {} : listings });
  }
  const ctx = context({
    goto: async (_source, url) => {
      const u = new URL(url);
      opened.push(u.pathname);
      if (opened.at(-1) === '/') {
        mapVisits++;
        focus = { lat: Number(u.searchParams.get('lat')), lng: Number(u.searchParams.get('lng')) };
        listingPage = 1;
        await emit(1, { pathname: '/other' });
        await emit(1, { center: focus.lng + 0.01 });
        await emit(1, { sort: '', count: 0 });
        await emit(1, { malformed: true });
        await emit(1, { count: district ? 10 : 50 });
      }
      return { status: () => 200 };
    },
    wheel: async (_x, _y, delta) => {
      if (delta < 0) return;
      if (cancel) {
        stopped = true;
        return;
      }
      if (district && shortWithoutEnd && mapVisits === 1) return;
      listingPage++;
      await emit(listingPage, { west: focus.lng - 0.015, status: 429 });
      await emit(listingPage, { sort: 'other', status: 429 });
      const repeatFirst = duplicate && listingPage === 2;
      await emit(listingPage, { status: block ? 429 : 200, count: repeatFirst ? 1 : district ? 0 : 50, repeatFirst });
    },
    page: {
      on: (event, callback) => events.set(event, callback),
      off: (event, callback) => { if (events.get(event) === callback) events.delete(event); },
      mainFrame: () => frame,
      viewportSize: () => ({ width: 1280, height: 860 }),
      locator: () => ({ boundingBox: async () => ({ x: 0, y: 200, width: 449, height: 640 }) }),
      evaluate: async () => ++evaluations === 1 ? [row(1)] : 0,
      waitForLoadState: noop, waitForFunction: noop, waitForTimeout: noop,
    },
  });
  Object.assign(ctx.areas[0], { id: 1, region: { kind: 'gu', code: '99001' } });
  if (block || cancel) ctx.areas.push({ ...ctx.areas[0], id: 2, name: 'SyntheticAreaB' });
  ctx.stopped = () => stopped;
  ctx.coverage = (receipt, ids) => receipts.push({ receipt, ids });
  const items = await ziptoss.collect(ctx);
  return { items, opened, receipts, partials: ctx.partials, listeners: events.size, listingPage };
}

test('ziptoss uses the sorted list, saves bounded pages, and keeps the district unconfirmed', async () => {
  const result = await collectZiptossMap();
  assert.equal(result.listingPage, 12);
  assert.equal(result.items.length, 600);
  assert.match(result.items[0].pageUrl, /\/map\//);
  assert.equal(result.listeners, 0);
  const { receipt, ids } = result.receipts.find(x => x.receipt.category === 'map-window');
  assert.equal(ids.length, 600);
  assert.equal(receipt.pages, 12);
  assert.equal(receipt.total, null);
  assert.equal(receipt.complete, false);
  assert.deepEqual(result.partials, []);
});

test('ziptoss preserves station and prior map results on access limits and cancellation', async () => {
  for (const options of [{ block: true }, { cancel: true }]) {
    const result = await collectZiptossMap(options);
    assert.equal(result.opened.filter(path => path === '/').length, 1);
    assert.equal(result.items.length, 50);
    assert.match(result.items[0].pageUrl, /\/map\//);
    assert.equal(result.listeners, 0);
    const map = result.receipts.find(x => x.receipt.category === 'map-window').receipt;
    assert.equal(map.pages, 1);
    assert.equal(map.complete, false);
    assert.match(map.reason, options.block ? /HTTP 429/ : /조회 중단/);
  }
});

test('ziptoss only confirms the district after verified terminal pages cover every map gap', async () => {
  const district = { west: 0.984, south: 0.993, east: 1.016, north: 1.007 };
  const complete = await collectZiptossMap({ district });
  const coverage = complete.receipts.find(x => x.receipt.category === 'map-window');
  assert.ok(complete.opened.filter(path => path === '/').length > 1);
  assert.equal(coverage.receipt.complete, true);
  assert.equal(coverage.ids.length, complete.items.length);
  assert.equal(complete.receipts.find(x => x.receipt.category === 'station-pages').receipt.complete, true);

  const partial = await collectZiptossMap({ district, shortWithoutEnd: true });
  assert.ok(partial.opened.filter(path => path === '/').length > 1, 'continue to other map gaps after an incomplete window');
  const map = partial.receipts.find(x => x.receipt.category === 'map-window').receipt;
  assert.equal(map.complete, false);
  assert.match(map.reason, /목록 끝 표시.*미확인/);

  const overlapping = await collectZiptossMap({ district, duplicate: true });
  const repeated = overlapping.receipts.find(x => x.receipt.category === 'map-window').receipt;
  assert.equal(repeated.complete, false, 'a terminal response cannot certify repeated rows within the same list');
  assert.match(repeated.reason, /목록 안에서 매물 1건이 반복됨/);
});

async function collectMangrove(secondRooms) {
  const { mangrove } = load('coliving.ts');
  let branch = 0;
  const ctx = context({
    goto: async (_source, url) => ({ status: () => 200, url: () => url, text: async () => '<loc>https://mangrove.city/region/synthetic/a</loc><loc>https://mangrove.city/region/synthetic/b</loc>' }),
    page: {
      route: noop, unroute: noop, waitForLoadState: noop,
      evaluate: async () => ({ rooms: ++branch === 1 ? [{ roomTypeId: 'synthetic-room', name: 'SyntheticRoom', monthly: 1000000 }] : secondRooms, name: 'SyntheticBranch', lat: 1, lng: 1, address: null }),
    },
  });
  const items = await mangrove.collect(ctx);
  return { items, partials: ctx.partials };
}
test('mangrove distinguishes missing branch data from a valid empty room list', async () => {
  const failed = await collectMangrove(null);
  assert.equal(failed.items.length, 1);
  assert.equal(failed.partials.length, 1);
  const empty = await collectMangrove([]);
  assert.equal(empty.items.length, 1);
  assert.equal(empty.partials.length, 0);
});

test('betterliving warns when the response contains fewer units than the total', async () => {
  const { betterliving } = load('coliving.ts');
  const response = { status: () => 200, url: () => 'https://example.invalid/units', json: async () => ({ total: 2, items: [{ unitId: 'synthetic', coordinate: { lat: 1, lon: 1 } }] }) };
  const ctx = context({ goto: async () => response, page: { waitForResponse: async () => response } });
  assert.equal((await betterliving.collect(ctx)).length, 1);
  assert.equal(ctx.partials.length, 1);
});

test('celib without configured branches is not a complete empty result', async () => {
  const { celib } = load('coliving.ts');
  const ctx = context({ page: {} });
  assert.equal((await celib.collect(ctx)).length, 0);
  assert.equal(ctx.partials.length, 1);
});

async function collectCourt({ missingSchedule = false, shortFirstPage = false } = {}) {
  const { courtauction } = load('courtauction.ts', {
    proj4: { default: () => [1, 1] }, './gus.js': { gusFor: () => ['Synthetic구'] },
    '../../shared/types.js': { isApartmentType: () => false, LAND_PREFIX: 'Land:', SHOP_PREFIX: 'Shop:' },
  });
  let responseIndex = 0;
  const locator = { first() { return this; }, isVisible: async () => false, count: async () => 0, inputValue: async () => '40', selectOption: noop };
  const ctx = context({
    goto: async () => ({ status: () => 200 }), hover: noop, click: noop,
    page: {
      url: () => 'https://example.invalid/search', locator: () => locator, waitForSelector: noop, evaluate: async () => ['synthetic-from', 'synthetic-to'],
      waitForResponse: async () => {
        const index = ++responseIndex;
        if (missingSchedule && index === 4) return null;
        const rows = index === 1 ? [{ docid: 'synthetic-lot', boCd: 'synthetic', saNo: 'synthetic', maemulSer: '1', buldList: '1층 10㎡' }] : [];
        return { status: () => 200, url: () => 'https://example.invalid/search', json: async () => ({ data: { dlt_srchResult: rows, dma_pageInfo: { totalCnt: index === 1 && shortFirstPage ? 2 : rows.length } } }) };
      },
    },
  });
  const items = await courtauction.collect(ctx);
  return { items, partials: ctx.partials };
}
test('courtauction marks a missing nearby-district scheduled-search response partial', async () => {
  const result = await collectCourt({ missingSchedule: true });
  assert.equal(result.items.length, 1);
  assert.ok(result.partials.length);
});
test('courtauction marks unread pages partial but accepts confirmed empty searches', async () => {
  assert.ok((await collectCourt({ shortFirstPage: true })).partials.length);
  assert.equal((await collectCourt()).partials.length, 0);
});

async function collectGobang({ missingDistricts = false, shortList = false } = {}) {
  const { gobang } = load('gobang.ts', { './gus.js': { gusFor: () => ['Synthetic구'] } });
  let onResponse;
  const emit = (url, result) => onResponse({ url: () => url, status: () => 200, json: async () => ({ result }) });
  const ctx = context({
    goto: async () => {
      if (!missingDistricts) emit('https://api.gobang.kr/v2/house-sigungus?synthetic=1', shortList ? [{ sigunguCode: 'synthetic', sigunguName: 'Synthetic구', houseCount: 2 }] : []);
      if (shortList) emit('https://api.gobang.kr/v2/houses?dongliCode=synthetic&pageNo=1', [{ no: 1, name: 'SyntheticRoom', latitude: 1, longitude: 1 }]);
      return { status: () => 200 };
    },
    wheel: noop,
    page: { on: (_event, fn) => { onResponse = fn; }, off: () => {}, waitForResponse: async () => null, evaluate: async () => ({}), url: () => 'https://example.invalid/list' },
  });
  const items = await gobang.collect(ctx);
  return { items, partials: ctx.partials };
}
test('gobang distinguishes an unread district list from a confirmed empty list', async () => {
  assert.ok((await collectGobang({ missingDistricts: true })).partials.length);
  assert.equal((await collectGobang()).partials.length, 0);
});
test('gobang marks a stalled list with missing rows partial', async () => {
  const result = await collectGobang({ shortList: true });
  assert.ok(result.items.length);
  assert.ok(result.partials.length);
});

async function collectPeterpanz({ narrow = false, shortList = false, empty = false, skipped = false, recoverSkipped = false,
  wrongMap = false, missingRows = false, stopOnContinuation = false, district = false, incompleteDistrict = false,
  truncated = false, recheck = 'stable' } = {}) {
  const districtBounds = { west: 0.99, south: 0.99, east: 1.01, north: 1.01 };
  const { peterpanz } = load('peterpanz.ts', { '../peterpanz-coverage.js': {
    ...peterpanzCoverage,
    peterpanzTargetBounds: area => district ? districtBounds : peterpanzCoverage.peterpanzTargetBounds(area),
  } });
  const listeners = new Map();
  let lateFirstPage;
  let stopped = false;
  const coverage = [];
  const continuationPages = [];
  const mapCenters = [];
  const locator = { first() { return this; }, isVisible: async () => false, boundingBox: async () => null };
  const ctx = context({
    goto: async (_site, url) => {
      // 줌 15 지도(남북 약 2.7km). narrow는 반경 500m를 다 덮지 못하는 좁은 지도.
      const span = wrongMap ? 0.1 : 0.012;
      const { x: lng } = JSON.parse(new URL(url).searchParams.get('center'));
      const firstDistrictView = district && lng <= 1.005;
      mapCenters.push(lng);
      const responseFor = (pageIndex, ids) => {
        const request = { url: () => `https://api.peterpanz.com/houses/area${district ? '/pc' : ''}?pageIndex=${pageIndex}` };
        listeners.get('request')(request);
        return {
          request: () => request, url: request.url, status: () => 200,
          json: async () => ({
            totalCount: district ? 2 : empty ? 0 : skipped ? 101 : shortList || truncated ? 51 : 1,
            ...(truncated && { orderId: 'synthetic-order' }),
            houses: missingRows ? null : { group: { rows: ids.map(hidx => ({ hidx })) } },
            debug: { search: { latitudeFrom: 1 - span, latitudeTo: 1 + span,
              longitudeFrom: lng - (district ? 0.018 : narrow ? 0.001 : span), longitudeTo: lng + (district ? 0.004 : span) } },
          }),
        };
      };
      const emit = (pageIndex, ids) => listeners.get('response')(responseFor(pageIndex, ids));
      if (district) {
        emit(1, firstDistrictView ? incompleteDistrict ? [1] : [1, 2] : [2, 3]);
        if (firstDistrictView) lateFirstPage = responseFor(1, [90, 91]);
        else listeners.get('response')(lateFirstPage);
      } else {
        emit(1, empty ? [] : truncated ? Array.from({ length: 49 }, (_, index) => index + 1) : [1]);
      }
      if (skipped) emit(3, Array.from({ length: 100 }, (_, index) => index + 2));
      if (truncated) emit(2, [51]);
      return { status: () => 200 };
    },
    page: {
      on: (event, fn) => { listeners.set(event, fn); }, off: () => {}, waitForResponse: async () => null,
      locator: () => locator, url: () => 'https://example.invalid/map',
      evaluate: async (_fn, arg) => {
        if (!arg) return { listRight: 0, width: 1000 };
        const pageIndex = Number(new URL(arg).searchParams.get('pageIndex'));
        continuationPages.push(pageIndex);
        if (stopOnContinuation) {
          stopped = true;
          throw new Error('Synthetic page closed');
        }
        if (truncated && pageIndex === 1) {
          assert.equal(new URL(arg).searchParams.get('order_id'), 'synthetic-order');
          if (recheck === 'blocked') return { status: 429, json: null };
          const body = { totalCount: 51, orderId: recheck === 'changed-order' ? 'another-order' : 'synthetic-order',
            houses: { group: { rows: Array.from({ length: 50 }, (_, index) => ({ hidx: index + (recheck === 'changed-list' ? 2 : 1) })) } } };
          const request = { url: () => arg };
          listeners.get('request')(request);
          listeners.get('response')({ request: () => request, url: request.url, status: () => 200, json: async () => body });
          return { status: 200, json: body };
        }
        if (recoverSkipped && pageIndex === 2) return { status: 200, json: { houses: { group: { rows: [{ hidx: 2 }] } } } };
        return { status: 500, json: null };
      },
    },
  });
  if (district) ctx.areas[0].region = { kind: 'gu' };
  ctx.stopped = () => stopped;
  ctx.coverage = (row, ids) => coverage.push({ row, ids });
  const items = await peterpanz.collect(ctx);
  return { items, partials: ctx.partials, coverage, continuationPages, mapCenters };
}
test('peterpanz marks uncovered radius and failed continuation partial', async () => {
  const narrow = await collectPeterpanz({ narrow: true });
  assert.match(narrow.partials.join(), /서쪽 389m 부족/);
  assert.equal(narrow.coverage.length, 3);
  assert.equal(narrow.coverage[0].row.complete, false);
  assert.equal(narrow.coverage[0].ids.join(), '1');
  const short = await collectPeterpanz({ shortList: true });
  assert.ok(short.items.length);
  assert.equal(short.coverage[0].row.pages, 1);
  assert.equal(short.coverage[0].row.totalPages, 2);
  assert.equal(short.coverage[0].row.received, 1);
  assert.equal(short.coverage[0].row.total, 51);
  assert.match(short.coverage[0].row.reason, /2쪽 응답을 읽지 못함/);
});
test('peterpanz accepts complete and confirmed empty map results', async () => {
  for (const empty of [false, true]) {
    const result = await collectPeterpanz({ empty });
    assert.equal(result.partials.length, 0);
    assert.ok(result.coverage.every(({ row }) => row.complete && row.total === (empty ? 0 : 1)));
  }
  const missing = await collectPeterpanz({ empty: true, missingRows: true });
  assert.equal(missing.coverage.length, 3);
  assert.ok(missing.coverage.every(({ row }) => !row.complete && row.total == null));
});
test('peterpanz distinguishes a skipped page from a failed map open', async () => {
  const unresolved = await collectPeterpanz({ skipped: true });
  const skipped = unresolved.coverage[0].row;
  assert.deepEqual(unresolved.continuationPages, [2, 2, 2]);
  assert.equal(skipped.received, skipped.total);
  assert.equal(skipped.pages, 2);
  assert.equal(skipped.totalPages, 3);
  assert.equal(skipped.complete, false);
  assert.match(skipped.reason, /목록 3쪽 중 2쪽만 확인/);
  const wrongMap = await collectPeterpanz({ wrongMap: true });
  assert.equal(wrongMap.items.length, 0);
  assert.ok(wrongMap.coverage.every(({ row }) => row.pages === 0 && row.total == null && !row.complete));
});
test('peterpanz recovers only the missing middle page when the ID count already matches', async () => {
  const result = await collectPeterpanz({ skipped: true, recoverSkipped: true });
  assert.deepEqual(result.continuationPages, [2, 2, 2]);
  assert.ok(result.coverage.every(({ row }) => row.complete && row.pages === 3 && row.received === 101));
});
test('peterpanz retains the verified rows when stopping closes the pending continuation', async () => {
  const result = await collectPeterpanz({ shortList: true, stopOnContinuation: true });
  assert.deepEqual(result.continuationPages, [2]);
  assert.equal(result.items.length, 1);
  assert.equal(result.coverage.length, 1);
  const { row } = result.coverage[0];
  assert.equal(row.received, 1);
  assert.equal(row.complete, false);
  assert.match(row.reason, /조회가 중단됨/);
});

test('peterpanz collects the uncovered part of a district and deduplicates overlapping views', async () => {
  const result = await collectPeterpanz({ district: true });
  assert.equal(result.partials.length, 0);
  assert.equal(result.mapCenters.length, 6);
  for (let i = 0; i < result.mapCenters.length; i += 2) {
    assert.equal(result.mapCenters[i], 1);
    assert.ok(result.mapCenters[i + 1] > 1.005);
  }
  assert.equal(result.items.length, 3);
  assert.equal(result.coverage.length, 3);
  for (const { row, ids } of result.coverage) {
    assert.equal(row.complete, true);
    assert.equal(row.pages, 2);
    assert.equal(row.totalPages, 2);
    assert.equal(row.total, null);
    assert.equal(row.received, 3);
    assert.equal(ids.join(), '1,2,3');
  }
});

test('peterpanz checks the next district window after an underfilled list without marking the district complete', async () => {
  const result = await collectPeterpanz({ district: true, incompleteDistrict: true });
  assert.equal(result.mapCenters.length, 6);
  assert.deepEqual(result.continuationPages, [1, 1, 1], 'retry only the underfilled page in each first window');
  assert.equal(result.items.length, 3);
  assert.ok(result.coverage.every(({ row, ids }) => !row.complete && row.pages === 2 &&
    ids.join() === '1,2,3' && !row.reason.includes('미확인 구간')));
});

test('peterpanz retries only the underfilled page and accepts recovery in the same ordered list', async () => {
  const result = await collectPeterpanz({ truncated: true });
  assert.deepEqual(result.continuationPages, [1, 1, 1]);
  assert.ok(result.coverage.every(({ row }) => row.complete && row.pages === 2 && row.received === 51));
  assert.equal(result.items.length, 51);
});

test('peterpanz does not certify a retry with changed ordering or missing previously received IDs', async () => {
  for (const recheck of ['changed-order', 'changed-list']) {
    const result = await collectPeterpanz({ truncated: true, recheck });
    assert.deepEqual(result.continuationPages, [1, 1, 1]);
    assert.ok(result.coverage.every(({ row }) => !row.complete && row.pages === 2 && row.received === 50));
    assert.equal(result.items.length, 50);
  }
});

test('peterpanz stops after a denied recheck and keeps the previously received pages', async () => {
  const result = await collectPeterpanz({ truncated: true, recheck: 'blocked' });
  assert.deepEqual(result.continuationPages, [1]);
  assert.equal(result.mapCenters.length, 1);
  assert.equal(result.items.length, 50);
  assert.equal(result.coverage[0].row.complete, false);
  assert.match(result.coverage[0].row.reason, /HTTP 429/);
});

const trustDeps = { './trust-docs.js': { readTrustDocs: noop } };
test('trust pagination follows only observed links with matching search conditions', () => {
  const { nextBoardPage } = load('trusts.ts', trustDeps);
  const current = 'https://example.invalid/list?page=1&keyword=synthetic';
  const next = 'https://example.invalid/list?page=2&keyword=synthetic';
  assert.equal(nextBoardPage(current, [next], 'page').nextUrl, next);
  assert.equal(nextBoardPage(current, ['https://elsewhere.invalid/list?page=2&keyword=synthetic'], 'page').nextUrl, null);
  assert.equal(nextBoardPage(current, ['/list?page=2&keyword=unrelated'], 'page').nextUrl, null);
  assert.equal(nextBoardPage(current, [], 'page').nextUrl, null);
});

test('a trust board reads the observed second page and stops when there is no next link', async () => {
  const { mghat } = load('trusts.ts', trustDeps);
  let currentUrl = '', pageNo = 1;
  const ctx = context({
    goto: async (_source, url) => { currentUrl = url; pageNo = Number(new URL(url).searchParams.get('page')); return { status: () => 200 }; },
    page: {
      url: () => currentUrl, waitForSelector: noop,
      evaluate: async (_fn, arg) => {
        if (arg) return [{ href: `/auction/disposal/${pageNo}/show.do`, title: 'Synthetic구 공고', status: '', date: '', kind: '' }];
        const next = new URL(currentUrl); next.searchParams.set('page', '2');
        return pageNo === 1 ? [next.href] : [];
      },
    },
  });
  const items = await mghat.collect(ctx, ['Synthetic구']);
  assert.equal(items.length, 2);
  assert.equal(ctx.partials.length, 0);
});

test('a failed district keeps earlier trust notices and permits a later district to finish', async () => {
  const { mghat } = load('trusts.ts', trustDeps);
  const visited = [];
  let currentUrl = '', keyword = '';
  const ctx = context({
    goto: async (_source, url) => {
      currentUrl = url;
      keyword = new URL(url).searchParams.get('keyword');
      visited.push(keyword);
      return { status: () => keyword === 'SyntheticB' ? 500 : 200 };
    },
    page: {
      url: () => currentUrl,
      waitForSelector: noop,
      evaluate: async (_fn, arg) => arg ? [{
        href: `/auction/disposal/${keyword === 'SyntheticA' ? 1 : 3}/show.do`,
        title: `${keyword}구 공고`, status: '', date: '', kind: '',
      }] : [],
    },
  });
  const items = await mghat.collect(ctx, ['SyntheticA구', 'SyntheticB구', 'SyntheticC구']);
  assert.deepEqual(Array.from(items, item => item.sourceId), ['1', '3']);
  assert.deepEqual(visited, ['SyntheticA', 'SyntheticB', 'SyntheticC']);
  assert.equal(ctx.partials.length, 1);
  assert.match(ctx.partials[0], /SyntheticB구.*HTTP 500/);
});

test('trust board stops after access limiting without dropping notices already read', async () => {
  let docReads = 0;
  const { mghat } = load('trusts.ts', { './trust-docs.js': { readTrustDocs: async () => { docReads++; } } });
  const visited = [], retryable = [];
  let currentUrl = '';
  const ctx = context({
    goto: async (_source, url) => {
      currentUrl = url;
      const params = new URL(url).searchParams;
      visited.push([params.get('keyword'), params.get('page')]);
      return { status: () => params.get('page') === '2' ? 429 : 200 };
    },
    page: {
      url: () => currentUrl,
      waitForSelector: noop,
      evaluate: async (_fn, arg) => {
        if (arg) return [{ href: '/auction/disposal/1/show.do', title: 'SyntheticA구 공고', status: '', date: '', kind: '' }];
        const next = new URL(currentUrl); next.searchParams.set('page', '2');
        return [next.href];
      },
    },
  });
  ctx.partial = (reason, retry) => { ctx.partials.push(reason); retryable.push(retry); };
  const items = await mghat.collect(ctx, ['SyntheticA구', 'SyntheticB구']);
  assert.equal(items.length, 1);
  assert.deepEqual(visited, [['SyntheticA', '1'], ['SyntheticA', '2']]);
  assert.equal(docReads, 0);
  assert.match(ctx.partials[0], /HTTP 429/);
  assert.deepEqual(retryable, [false]);
});
