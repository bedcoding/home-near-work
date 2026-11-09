import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createListingsBody } from '../server/listings-body.ts';

/** 워커 답과 같은 모양. 이 시험들은 캐시와 워커 다루기만 보므로 매물 경계는 비우고 본문만 담는다. */
const bodyOnly = (text) => ({ body: Buffer.from(text), ids: [], offsets: Uint32Array.of(1) });

/** 시험이 직접 답하는 가짜 워커. 만들기를 부탁받을 때마다 requests가 는다. */
class FakeWorker extends EventEmitter {
  requests = 0;
  terminated = false;
  postMessage() { this.requests++; }
  reply(text) { this.emit('message', { ok: true, ...bodyOnly(text) }); }
  fail(error) { this.emit('message', { ok: false, error }); }
  crash() { this.emit('error', new Error('synthetic crash')); }
  ref() {}
  unref() {}
  async terminate() {
    this.terminated = true;
    this.emit('exit', 1);
  }
}

/** 조건이 맞을 때까지 이벤트 루프를 돌린다. */
async function until(check) {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check());
}

function fakeListings(t, options = {}) {
  const workers = [];
  const logs = [];
  const state = { revision: 'r1' };
  const listings = createListingsBody({
    revision: () => state.revision,
    buildHere: () => { throw new Error('본 스레드에서 만들면 안 된다'); },
    startWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    log: (message) => logs.push(message),
    ...options,
  });
  t.after(() => listings.close());
  return { listings, workers, logs, state };
}

test('같은 자료 버전의 요청은 만들기 하나를 같이 기다리고, 그 사이 버전이 바뀌면 끝난 뒤 한 번 더 만든다', async (t) => {
  const { listings, workers, state } = fakeListings(t);
  const a = listings.body();
  const b = listings.body();
  assert.equal(workers.length, 1);
  assert.equal(workers[0].requests, 1, '겹친 요청은 만들기 하나를 같이 기다린다');
  // 만드는 중에 자료가 바뀌었다. 이때 들어온 요청은 앞선 만들기가 끝난 뒤 다시 만든 것 하나를 같이 받는다.
  state.revision = 'r2';
  const c = listings.body();
  const d = listings.body();
  workers[0].reply('["first"]');
  assert.equal(String(await a), '["first"]');
  assert.equal(String(await b), '["first"]');
  await until(() => workers[0].requests === 2);
  workers[0].reply('["second"]');
  assert.equal(String(await c), '["second"]');
  assert.equal(String(await d), '["second"]');
  // 버전이 그대로면 만들어 둔 것을 준다.
  assert.equal(String(await listings.body()), '["second"]');
  assert.equal(workers[0].requests, 2);
  assert.equal(workers.length, 1, '워커 하나를 다시 쓴다');
});

test('자료 버전은 만들기 전에 기억해서, 만드는 중에 쓴 것은 다음 요청에서 다시 만든다', async (t) => {
  const { listings, workers, state } = fakeListings(t);
  const a = listings.body();
  state.revision = 'r2';
  workers[0].reply('["before write"]');
  assert.equal(String(await a), '["before write"]');
  const b = listings.body();
  assert.equal(workers[0].requests, 2, '만들기 전 버전(r1)으로 기억했으니 r2에서는 다시 만든다');
  workers[0].reply('["after write"]');
  assert.equal(String(await b), '["after write"]');
  assert.equal(String(await listings.body()), '["after write"]');
  assert.equal(workers[0].requests, 2);
});

test('버전이 같아도 cacheMs가 지나면 다시 만든다', async (t) => {
  const { listings, workers } = fakeListings(t, { cacheMs: 20 });
  const a = listings.body();
  workers[0].reply('["a"]');
  await a;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const b = listings.body();
  assert.equal(workers[0].requests, 2);
  workers[0].reply('["b"]');
  assert.equal(String(await b), '["b"]');
});

test('워커를 못 띄우거나 워커가 죽거나 늦으면 본 스레드에서 만들고, 세 번 연달아 실패하면 더는 띄우지 않는다', async (t) => {
  let revision = 0;
  let starts = 0;
  const workers = [];
  const logs = [];
  const listings = createListingsBody({
    revision: () => String(revision),
    buildHere: () => bodyOnly(`["here ${revision}"]`),
    startWorker: () => {
      starts++;
      if (starts === 1) throw new Error('synthetic start failure');
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    log: (message) => logs.push(message),
    timeoutMs: 30,
  });
  t.after(() => listings.close());

  // 띄우지 못함
  assert.equal(String(await listings.body()), '["here 0"]');
  assert.match(logs[0], /synthetic start failure/);
  // 만드는 중에 죽음: 그 워커는 끄고 다음 만들기에서 새로 띄운다.
  revision++;
  const crashed = listings.body();
  workers[0].crash();
  assert.equal(String(await crashed), '["here 1"]');
  assert.ok(workers[0].terminated);
  // 성공하면 실패 횟수를 지운다.
  revision++;
  const ok = listings.body();
  assert.equal(workers.length, 2);
  workers[1].reply('["worker 2"]');
  assert.equal(String(await ok), '["worker 2"]');
  // 만들다 오류, 시간 안에 못 만듦, 또 죽음: 세 번 연달아 실패
  revision++;
  const failed = listings.body();
  workers[1].fail('synthetic build error');
  assert.equal(String(await failed), '["here 3"]');
  revision++;
  assert.equal(String(await listings.body()), '["here 4"]', '답이 없는 워커는 timeoutMs 뒤 본 스레드에서 만든다');
  assert.ok(workers[2].terminated);
  revision++;
  const crashedAgain = listings.body();
  workers[3].crash();
  assert.equal(String(await crashedAgain), '["here 5"]');
  assert.match(logs.at(-1), /3번 연달아 실패/);
  // 그 뒤로는 워커를 띄우지 않는다.
  revision++;
  assert.equal(String(await listings.body()), '["here 6"]');
  assert.equal(workers.length, 4);
});

test('일이 없는 워커는 idleMs 뒤 끄고, 다음 만들기에서 다시 띄운다', async (t) => {
  const { listings, workers, state } = fakeListings(t, { idleMs: 20 });
  const a = listings.body();
  workers[0].reply('["a"]');
  await a;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(workers[0].terminated);
  state.revision = 'r2';
  const b = listings.body();
  assert.equal(workers.length, 2);
  workers[1].reply('["b"]');
  assert.equal(String(await b), '["b"]');
});

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

test('실제 워커는 임시 DB에서 본 스레드와 바이트까지 같은 목록을 만들고 DB에 쓰지 않는다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-listings-'));
  // 처음 켤 때 기본 지역을 만드는 일은 이 시험과 상관없어 이미 한 것으로 둔다.
  const seed = new Database(path.join(dir, 'app.db'));
  seed.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('areas_seeded', '1');");
  seed.close();
  process.env.HNW_DATA_DIR = dir;
  const store = await import('../server/db.ts');
  const { buildListingViews } = await import('../server/views.ts');
  const logs = [];
  const listings = createListingsBody({
    revision: store.dataRevision,
    buildHere: () => { throw new Error(`워커에서 만들지 못했다: ${logs.join(' / ')}`); },
    log: (message) => logs.push(message),
  });
  t.after(async () => {
    await listings.close();
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const at = '2026-01-01T00:00:00.000Z';
  const naverRaw = { representativeArticleInfo: { complexNumber: 12345, complexName: '예시아파트', articleDetail: { articleFeatureDescription: '풀옵션' } } };
  store.insertListing('naver:1', listing('naver', '1'), 'key-naver-1', 'sig', 9, { runId: 9, pageUrl: null, screenshot: '/runs/9/shot.png' }, naverRaw, at);
  store.insertListing('peterpanz:1', listing('peterpanz', '1', { buildingType: '원룸' }), 'key-peterpanz-1', 'sig', 9, null, { additional_options: { is_full_option: 1 } }, at);
  store.insertListing('ziptoss:1', listing('ziptoss', '1', { buildingType: '다가구' }), 'key-ziptoss-1', 'sig', 9, null, { options: ['에어컨'] }, at);
  store.insertListing('dabang:1', listing('dabang', '1', { buildingType: '원룸' }), 'key-dabang-1', 'sig', 9, null, null, at);
  store.setVerdict('dabang:1', 'discard');
  store.markSeen(['naver:1'], at);

  const before = store.dataRevision();
  const body = await listings.body();
  assert.deepEqual(logs, []);
  assert.equal(store.dataRevision(), before, '워커는 DB에 쓰지 않는다(자료 버전 그대로)');
  const views = buildListingViews();
  assert.ok(body.equals(Buffer.from(JSON.stringify(views))), '본 스레드에서 만든 것과 바이트까지 같다');
  // 변화분 응답이 쓰는 매물 id 순서와 매물마다 경계도 같이 넘어온다.
  const json = await listings.json();
  assert.equal(json.body, body);
  assert.deepEqual(json.ids, views.map((l) => l.id));
  views.forEach((l, i) => assert.equal(json.body.subarray(json.offsets[i], json.offsets[i + 1] - 1).toString('utf8'), JSON.stringify(l)));
  const list = JSON.parse(body.toString('utf8'));
  assert.deepEqual(list.map((l) => l.id).sort(), ['dabang:1', 'naver:1', 'peterpanz:1', 'ziptoss:1']);
  assert.equal(list.find((l) => l.id === 'dabang:1').verdict, 'discard');

  // 본 스레드에서 쓴 것은 다음 요청에서 워커가 다시 읽는다.
  store.setNote('naver:1', '예시 메모', at);
  const after = JSON.parse((await listings.body()).toString('utf8'));
  assert.equal(after.find((l) => l.id === 'naver:1').note, '예시 메모');
  assert.deepEqual(logs, []);
});
