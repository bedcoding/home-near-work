// 객체마다 계산 결과를 기억해 두는 작은 도구.
// 화면은 크롬 확장이 순회하는 동안 바뀐 매물만 새 객체로 바꾼 목록을 받는다(변화분, web/src/listingsSync.ts).
// 바뀌지 않은 매물은 같은 객체로 남으므로, 결과가 매물과 몇 가지 다른 값(필터, 지역)으로만 정해지는 계산은
// 매물 객체마다 기억해 두면 수만 건을 다시 도는 계산이 바뀐 매물만 다시 계산한다.

/**
 * 열쇠마다 객체 → 결과를 기억하는 WeakMap을 준다. 열쇠는 결과를 정하는 다른 값(필터, 지역 등)을 글자로 만든 것이다.
 * 처음 보는 열쇠면 새 WeakMap을 만들고, 최근에 쓴 열쇠 keep개의 기억만 남긴다(필터나 지역이 바뀌면 예전 기억은 밀려난다).
 * keep은 한 번 다시 그릴 때 쓰는 열쇠 수보다 넉넉해야 서로 밀어내지 않는다. 객체가 없어지면 그 기억도 같이 없어진다.
 */
export function keyedMemo<T>(keep: number) {
  const maps = new Map<string, WeakMap<object, T>>();
  return (key: string): WeakMap<object, T> => {
    let m = maps.get(key);
    if (m) maps.delete(key);
    else {
      m = new WeakMap();
      if (maps.size >= keep) maps.delete(maps.keys().next().value as string);
    }
    maps.set(key, m);
    return m;
  };
}
