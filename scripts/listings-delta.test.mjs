import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOrder, mergeListings, orderPatch } from '../shared/listings-delta.ts';
import { createListingsCache, encodeListings } from '../server/listings-cache.ts';

// 매물 목록 변화분: 서버가 지난 목록과 견줘 보낸 변화분을 화면이 가진 목록에 합치면 서버가 지금 보낼 전체 목록과 같아야 한다.

/** 시험마다 같은 순서가 나오는 난수 */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const listing = (id, extra = {}) => ({ id, title: `매물 ${id}`, prices: [{ deal: 'monthly', deposit: 1000, monthly: 50 }], note: null, ...extra });
const parse = (buf) => JSON.parse(buf.toString('utf8'));

test('순서 바꾸기: 뒤에 붙은 새 매물, 없어진 매물, 자리 옮긴 매물을 모두 맞게 되살린다', () => {
  const base = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(orderPatch(base, base, new Set()), undefined, '순서가 그대로면 보내지 않는다');
  assert.equal(orderPatch(base, ['a', 'c', 'e'], new Set(['b', 'd'])), undefined, '없어진 매물만 빠지면 보내지 않는다');
  assert.deepEqual(orderPatch(base, [...base, 'f', 'g'], new Set()), [5, 'f', 'g'], '새 매물이 뒤에 붙으면 짧다');
  const cases = [
    { next: ['e', 'a', 'b', 'c', 'd'], removed: [] },
    { next: ['b', 'c', 'a', 'x', 'd', 'e'], removed: [] },
    { next: ['x', 'e', 'd', 'y'], removed: ['a', 'b', 'c'] },
    { next: [], removed: base },
    { next: ['z'], removed: base },
  ];
  for (const { next, removed } of cases) {
    const gone = new Set(removed);
    const patch = orderPatch(base, next, gone) ?? [];
    assert.deepEqual(applyOrder(base, patch, gone), next, JSON.stringify(next));
  }
  assert.deepEqual(applyOrder([], ['a', 'b'], new Set()), ['a', 'b']);
  assert.equal(applyOrder(['a'], [2], new Set()), null, '기준 목록이 모자라면 null');
});

test('순서 바꾸기: 아무렇게나 섞고 넣고 뺀 순서도 되살린다', () => {
  const rand = random(7);
  for (let round = 0; round < 300; round++) {
    const base = Array.from({ length: Math.floor(rand() * 40) }, (_, i) => `id${i}`);
    const next = base.filter(() => rand() > 0.2);
    for (let k = Math.floor(rand() * 5); k > 0; k--) next.splice(Math.floor(rand() * (next.length + 1)), 0, `new${round}-${k}`);
    if (rand() < 0.5) {
      for (let k = Math.floor(rand() * 4); k > 0 && next.length > 1; k--) {
        const [moved] = next.splice(Math.floor(rand() * next.length), 1);
        next.splice(Math.floor(rand() * (next.length + 1)), 0, moved);
      }
    }
    const removed = new Set(base.filter((id) => !next.includes(id)));
    const patch = orderPatch(base, next, removed);
    assert.deepEqual(patch ? applyOrder(base, patch, removed) : base.filter((id) => !removed.has(id)), next);
  }
});

test('합치기: 바뀌지 않은 매물은 가진 객체를 그대로 쓰고, 바뀐 것이 없으면 같은 배열을 돌려준다', () => {
  const list = [listing('a'), listing('b'), listing('c')];
  const same = mergeListings(list, { since: 't1', token: 't1', size: 3, changed: [], removed: [] });
  assert.equal(same, list);
  const b2 = listing('b', { note: '바뀜' });
  const merged = mergeListings(list, { since: 't1', token: 't2', size: 3, changed: [b2, listing('d')], removed: ['c'], order: [2, 'd'] });
  assert.deepEqual(merged.map((l) => l.id), ['a', 'b', 'd']);
  assert.equal(merged[0], list[0]);
  assert.equal(merged[1], b2);
  assert.notEqual(merged, list);
  assert.equal(mergeListings(list, { since: 't1', token: 't2', size: 4, changed: [], removed: [] }), null, '매물 수가 안 맞으면 null');
  assert.equal(mergeListings(list, { since: 't1', token: 't2', size: 3, changed: [], removed: [], order: ['a', 'b', 'zz'] }), null, '없는 매물을 놓으라 하면 null');
});

test('응답 JSON: 전체는 JSON.stringify와 바이트까지 같고, 매물마다 경계로 자른 조각은 그 매물의 JSON이다', () => {
  const views = [listing('a', { title: '역세권 "신축"\n줄바꿈   😀' }), listing('b'), listing('c', { prices: [] })];
  const json = encodeListings(views);
  assert.ok(json.body.equals(Buffer.from(JSON.stringify(views))));
  assert.deepEqual(json.ids, ['a', 'b', 'c']);
  views.forEach((v, i) => assert.equal(json.body.subarray(json.offsets[i], json.offsets[i + 1] - 1).toString('utf8'), JSON.stringify(v)));
  assert.equal(encodeListings([]).body.toString(), '[]');
});

test('서버 기억: 지난 목록 버전부터의 변화분을 합치면 지금 전체 목록과 같다(몇 벌 앞에서도)', () => {
  const cache = createListingsCache(4);
  assert.equal(cache.token(), null);
  const v1 = Array.from({ length: 50 }, (_, i) => listing(`m${i}`));
  const t1 = cache.remember(encodeListings(v1));
  assert.equal(cache.full().toString(), JSON.stringify(v1));
  const screen1 = parse(cache.full());

  // 확장이 순회하며 몇 건을 바꾸고, 새 매물을 넣고, 오래된 매물을 지운다.
  const v2 = v1.filter((l) => l.id !== 'm3').map((l) => (l.id === 'm10' ? { ...l, note: '가격 바뀜' } : l));
  v2.push(listing('n1'));
  const t2 = cache.remember(encodeListings(v2));
  assert.notEqual(t2, t1);
  const d12 = parse(cache.since(t1));
  assert.deepEqual(d12.changed.map((l) => l.id).sort(), ['m10', 'n1']);
  assert.deepEqual(d12.removed, ['m3']);
  assert.deepEqual(d12.order, [49, 'n1']);
  const screen2 = mergeListings(screen1, d12);
  assert.deepEqual(screen2, parse(cache.full()));
  assert.equal(screen2[0], screen1[0], '바뀌지 않은 매물은 같은 객체');

  const v3 = [listing('n2'), ...v2.map((l) => (l.id === 'm20' ? { ...l, prices: [] } : l))];
  const t3 = cache.remember(encodeListings(v3));
  assert.deepEqual(mergeListings(screen2, parse(cache.since(t2))), v3);
  assert.deepEqual(mergeListings(screen1, parse(cache.since(t1))), v3, '두 벌 앞 목록에서도 맞게 합친다');

  const now = parse(cache.since(t3));
  assert.deepEqual({ ...now, changed: now.changed.length }, { since: t3, token: t3, size: v3.length, removed: [], changed: 0 });
  assert.equal(cache.remember(encodeListings(v3.map((l) => ({ ...l })))), t3, '다시 만든 목록이 같으면 버전을 그대로 둔다');
  assert.equal(cache.since('예전-서버-1'), null, '모르는 버전이면 전체를 보내게 null');
});

test('서버 기억: 늦게 끝난 요청이 예전 목록을 다시 줘도 지금 목록을 되돌리지 않는다', () => {
  const cache = createListingsCache();
  const old = encodeListings([listing('a')]);
  cache.remember(old);
  const t2 = cache.remember(encodeListings([listing('a', { note: '새것' })]));
  assert.equal(cache.remember(old), t2);
  assert.equal(parse(cache.full())[0].note, '새것');
});

test('서버 기억: 너무 오래된 버전은 잊어서 전체를 보내게 한다', () => {
  const cache = createListingsCache(3);
  const tokens = [];
  for (let k = 0; k < 4; k++) tokens.push(cache.remember(encodeListings([listing('a', { note: `메모 ${k}` })])));
  assert.equal(cache.since(tokens[0]), null);
  assert.ok(cache.since(tokens[1]));
  const other = createListingsCache(3);
  other.remember(encodeListings([listing('a')]));
  assert.notEqual(other.token(), tokens[0], '서버를 다시 켜면 버전이 겹치지 않는다');
});
