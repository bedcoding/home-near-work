import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { STALE_SOURCES } from '../shared/types.ts';

// 매물 목록(buildListingViews)을 메모리 DB와 꾸며 낸 매물로 돌린다. 정비구역과 실거래 비교는 이 시험과 상관없어 비워 둔다.
const transpile = (file) => ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const dbCode = transpile('../server/db.ts');
const viewsCode = transpile('../server/views.ts');

function run(code, dependencies) {
  const context = { exports: {}, require: (id) => { assert.ok(id in dependencies, id); return dependencies[id]; } };
  vm.runInNewContext(code, context);
  return context.exports;
}

function memoryStore(t) {
  const store = run(dbCode, {
    'node:fs': { mkdirSync() {} }, 'node:crypto': { randomUUID }, 'better-sqlite3': Database,
    './config.js': { DATA_DIR: '', RUNS_DIR: '', DB_PATH: ':memory:' },
    './stations.js': { DEFAULT_AREAS: [], findStation() { throw new Error('No station lookup in test'); } },
    '../shared/types.js': { SEOUL_GUS: [], STALE_SOURCES },
  });
  t.after(() => store.db.close());
  return store;
}

async function loadViews(store) {
  return run(viewsCode, {
    './db.js': store,
    './collectors/types.js': await import('../server/collectors/types.ts'),
    './identity.js': await import('../server/identity.ts'),
    './lots.js': await import('../server/lots.ts'),
    './redev-zones.js': { zonesLookup: () => () => null },
    './trade-compare.js': { tradeComparer: () => () => null },
    './zigbang-parse.js': await import('../server/zigbang-parse.ts'),
    '../shared/format.js': await import('../shared/format.ts'),
    './run-files.js': await import('../server/run-files.ts'),
    '../shared/kinds.js': await import('../shared/kinds.ts'),
    '../shared/types.js': await import('../shared/types.ts'),
  });
}

/** 다른 vm에서 만든 값도 견줄 수 있게 평범한 값으로 바꾼다. */
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

function listing(source, sourceId, extra = {}) {
  return {
    source, sourceId, url: `https://example.invalid/${source}/${sourceId}`, title: '예시 매물', thumbnail: null, lat: null, lng: null,
    address: '예시도 가상구 예시동 1', dong: '예시동', buildingKey: `building-${sourceId}`, buildingType: '아파트', roomLabel: null, rooms: null,
    areaM2: 33, floor: 3, totalFloors: 5, basement: false, rooftop: false, builtYear: null, maintenance: null, elevator: null, parking: null,
    availableFrom: null, updatedAt: null, prices: [{ deal: 'monthly', deposit: 1000, monthly: 50, price: null }],
    explain: [{ label: '가격', raw: 'price: 1000/50', value: '1000/50' }],
    ...extra,
  };
}

const NAVER_RAW = {
  articleNumber: 'synthetic-1',
  representativeArticleInfo: {
    complexNumber: 12345, complexName: '예시아파트', priceInfo: { dealPrice: 1 },
    articleDetail: { articleFeatureDescription: '풀옵션, 1층은 근린생활시설입니다', directions: '남향' },
  },
  duplicatedArticleInfo: {
    articleInfoList: [
      { articleDetail: { articleFeatureDescription: '' } },
      { articleDetail: { articleFeatureDescription: '위반건축물 있음' }, realtorName: '예시공인' },
      { articleDetail: {} },
      null,
    ],
  },
};

function fill(store) {
  // 조회 번호 3까지의 폴더는 지웠다(그 조회의 스크린샷은 출처 보기를 숨긴다).
  store.setSetting('run_files_purged_through', '3');
  const add = (id, l, raw, ref) => store.insertListing(id, l, `key-${id}`, 'sig', ref?.runId ?? 9, ref, raw, '2026-01-01T00:00:00.000Z');
  add('naver:1', listing('naver', '1'), NAVER_RAW, { runId: 9, pageUrl: 'https://example.invalid/page?very=long', screenshot: '/runs/9/shot.png' });
  add('naver:2', listing('naver', '2', { title: '예시 투룸' }), { representativeArticleInfo: { articleDetail: {} } }, { runId: 2, pageUrl: null, screenshot: '/runs/2/shot.png' });
  add('peterpanz:1', listing('peterpanz', '1', { buildingType: '원룸' }), { additional_options: { is_full_option: 1, have_elevator: 0 }, photos: ['a', 'b'] }, { runId: 9, pageUrl: null, screenshot: null });
  add('peterpanz:2', listing('peterpanz', '2', { buildingType: '원룸' }), { photos: [] }, { runId: 9, pageUrl: null, screenshot: null });
  add('ziptoss:1', listing('ziptoss', '1', { buildingType: '다가구' }), {
    options: ['에어컨', '냉장고'], prices: [{ isFullOption: false }], building: { mainPurpose: '제2종근린생활시설', subPurpose: '', type: '다가구' },
  }, { runId: 9, pageUrl: null, screenshot: '/runs/9/z.png' });
  add('dabang:1', listing('dabang', '1', { buildingType: '원룸' }), null, null);
}

test('네이버와 피터팬 원본은 목록이 읽는 칸만 원본과 같은 값으로 뽑는다', (t) => {
  const store = memoryStore(t);
  fill(store);
  const full = store.rawBySource('naver');
  const slim = store.naverViewRaw();
  assert.deepEqual([...slim.keys()].sort(), [...full.keys()].sort());
  for (const [id, raw] of full) {
    const rep = raw.representativeArticleInfo;
    const s = slim.get(id);
    assert.deepEqual(plain(s.representativeArticleInfo), plain({
      complexNumber: rep?.complexNumber ?? null, complexName: rep?.complexName ?? null,
      articleDetail: { articleFeatureDescription: rep?.articleDetail?.articleFeatureDescription ?? null },
    }), id);
    assert.deepEqual(
      plain(s.duplicatedArticleInfo.articleInfoList.map((x) => x.articleDetail.articleFeatureDescription)),
      plain((raw.duplicatedArticleInfo?.articleInfoList ?? []).map((x) => x?.articleDetail?.articleFeatureDescription ?? null)),
      id,
    );
  }
  assert.deepEqual(plain(store.peterpanzViewRaw().get('peterpanz:1')), { additional_options: { is_full_option: 1, have_elevator: 0 } });
  assert.deepEqual(plain(store.peterpanzViewRaw().get('peterpanz:2')), {});
});

test('매물 목록은 큰 칸을 빼도 원본 통째로 낸 옵션과 건축물대장 표시가 같고, 출처 보기는 따로 받는다', async (t) => {
  const store = memoryStore(t);
  fill(store);
  const views = await loadViews(store);
  const list = plain(views.buildListingViews());
  const byId = new Map(list.map((l) => [l.id, l]));
  assert.equal(list.length, 6);
  for (const l of list) {
    for (const gone of ['seenRef', 'identityKey', 'buildingKey', 'explain']) assert.ok(!(gone in l), `${l.id} ${gone}`);
  }
  // 원본 통째로 낸 값과 같다(네이버와 피터팬은 쓰는 칸만 읽고, 집토스는 원본 그대로 읽는다).
  const rawOf = new Map([...store.rawBySource('naver'), ...store.rawBySource('peterpanz'), ...store.rawBySource('ziptoss')]);
  for (const l of list) {
    const raw = rawOf.get(l.id);
    const data = store.listingRaw(l.id).data;
    assert.deepEqual(l.options, plain(views.optionsRef(l.source, raw, l.title)), `${l.id} options`);
    assert.deepEqual(l.ledger, plain(views.ledgerRef(l.source, data, raw)), `${l.id} ledger`);
  }
  assert.deepEqual(byId.get('naver:1').options, { list: null, full: true });
  assert.equal(byId.get('naver:1').ledger.neigh.from, '네이버 소개 글');
  assert.equal(byId.get('naver:1').ledger.violation.text, '위반건축물 있음');
  assert.deepEqual(byId.get('peterpanz:1').options, { list: null, full: true });
  assert.equal(byId.get('peterpanz:2').options, null);
  // 스크린샷이 남은 매물만 출처 보기를 보인다(지운 조회 2번의 스크린샷은 숨긴다).
  assert.deepEqual(list.filter((l) => l.sourceShot).map((l) => l.id).sort(), ['naver:1', 'ziptoss:1']);
  assert.deepEqual(plain(views.listingSource('naver:1')), { runId: 9, pageUrl: 'https://example.invalid/page?very=long', screenshot: '/runs/9/shot.png' });
  assert.deepEqual(plain(views.listingSource('naver:2')), { runId: 2, pageUrl: null, screenshot: null });
  assert.equal(views.listingSource('dabang:1'), null);
  assert.equal(views.listingSource('missing:1'), undefined);
});
