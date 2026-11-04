import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Collector dependencies are replaced in memory. These tests cannot open the real database or make network requests.
class BlockedError extends Error {}
const noop = async () => {};
const toNumber = (v) => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const common = {
  '../config.js': { PAGE_DELAY_MS: 0, LOCAL: {} },
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
    goto: async () => ({ status: () => ++request === 1 ? 500 : 200 }),
    page: {
      evaluate: async () => ++evaluation === 1 ? [{ id: 123, building: { point: { coordinates: [1, 1] } }, prices: [] }] : { cards: 0, rows: 0 },
      waitForLoadState: noop, waitForFunction: noop,
    },
  });
  assert.equal((await ziptoss.collect(ctx)).length, 1);
  assert.match(ctx.partials.join(), /HTTP 500/);
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

async function collectPeterpanz({ narrow = false, shortList = false, empty = false } = {}) {
  const { peterpanz } = load('peterpanz.ts');
  let onResponse;
  const locator = { first() { return this; }, isVisible: async () => false, boundingBox: async () => null };
  const ctx = context({
    goto: async () => {
      const span = narrow ? 0.001 : 0.1;
      onResponse({
        url: () => 'https://api.peterpanz.com/houses/area?pageIndex=1', status: () => 200,
        json: async () => ({ totalCount: empty ? 0 : shortList ? 51 : 1, houses: empty ? {} : { group: { rows: [{ hidx: 1, location: { coordinate: { latitude: 1, longitude: 1 } } }] } }, debug: { search: { latitudeFrom: 1 - span, latitudeTo: 1 + span, longitudeFrom: 1 - span, longitudeTo: 1 + span } } }),
      });
      return { status: () => 200 };
    },
    page: {
      on: (_event, fn) => { onResponse = fn; }, off: () => {}, waitForResponse: async () => null,
      locator: () => locator, url: () => 'https://example.invalid/map',
      evaluate: async (_fn, arg) => arg ? { status: 500, json: null } : { listRight: 0, width: 1000 },
    },
  });
  const items = await peterpanz.collect(ctx);
  return { items, partials: ctx.partials };
}
test('peterpanz marks uncovered radius and failed continuation partial', async () => {
  assert.ok((await collectPeterpanz({ narrow: true })).partials.length);
  const short = await collectPeterpanz({ shortList: true });
  assert.ok(short.items.length);
  assert.ok(short.partials.length);
});
test('peterpanz accepts complete and confirmed empty map results', async () => {
  assert.equal((await collectPeterpanz()).partials.length, 0);
  assert.equal((await collectPeterpanz({ empty: true })).partials.length, 0);
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
