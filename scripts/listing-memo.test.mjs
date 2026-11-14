import assert from 'node:assert/strict';
import test from 'node:test';
import { keyedMemo } from '../shared/memo.ts';
import { DEFAULT_FILTERS, dealOptions, filterJudge, passes } from '../shared/filters.ts';

// 변화분을 받으면 바뀌지 않은 매물은 같은 객체로 남으므로, 화면은 필터 판정을 매물 객체마다 기억해 쓴다.
// 기억한 판정이 원래 판정과 같은지, 바뀐 매물(새 객체)과 바뀐 필터는 다시 판정하는지 본다. 매물은 지어낸 값이다.
const listing = (id, prices) => ({
  id, prices, buildingType: '빌라', areaM2: 30, basement: false, rooftop: false, floor: 2, lat: 37.5, lng: 127,
  title: '시험 매물', address: '예시시 예시구', dong: null, roomLabel: null, legalDongCode: null, options: null,
});

test('filterJudge는 passes, dealOptions와 같은 결과를 매물 객체마다 기억하고, 새 객체와 바뀐 필터는 다시 판정한다', () => {
  const monthly = { deal: 'monthly', deposit: 1000, monthly: 50, price: null };
  const a = listing('a', [monthly]);
  const b = listing('b', [{ deal: 'jeonse', deposit: 20000, monthly: null, price: null }]);
  const f = { ...DEFAULT_FILTERS, insideAreas: false, monthlyMax: 60 };
  const judge = filterJudge(f, []);
  for (const l of [a, b]) {
    assert.equal(judge.passes(l), passes(l, f, []));
    for (const deal of ['monthly', 'jeonse']) assert.deepEqual(judge.dealOptions(l, deal), dealOptions(l, deal, f, []));
  }
  // 내용이 같은 필터면 기억한 결과(같은 배열)를 다시 쓴다.
  assert.equal(filterJudge({ ...f }, []).dealOptions(a, 'monthly'), judge.dealOptions(a, 'monthly'));
  // 가격이 바뀐 매물은 새 객체로 오므로 다시 판정한다.
  assert.equal(filterJudge(f, []).passes({ ...a, prices: [{ ...monthly, monthly: 70 }] }), false);
  // 필터가 바뀌면 다시 판정한다.
  assert.equal(filterJudge({ ...f, monthlyMax: 40 }, []).passes(a), false);
  assert.equal(filterJudge(f, []).passes(a), true);
});

test('keyedMemo는 최근에 쓴 열쇠의 기억만 남긴다', () => {
  const memo = keyedMemo(2);
  const o = {};
  memo('a').set(o, 1);
  memo('b').set(o, 2);
  assert.equal(memo('a').get(o), 1);
  memo('c').set(o, 3);
  // a를 다시 써서 b가 가장 오래됐으므로 c를 만들 때 b가 밀려났다.
  assert.equal(memo('a').get(o), 1);
  assert.equal(memo('c').get(o), 3);
  assert.equal(memo('b').get(o), undefined);
});
