import assert from 'node:assert/strict';
import test from 'node:test';
import { createRevisionRefresh } from '../web/src/refresh.ts';

test('a change the screen already applied does not reload the big lists, other changes still do', async () => {
  let loads = 0;
  const refresh = createRevisionRefresh(async () => { loads += 1; });
  assert.equal(await refresh('r1'), true);
  refresh.advance('r1', 'r2');
  assert.equal(await refresh('r2'), false, 'only the seen mark changed since the last load');
  refresh.advance('r1', 'r3');
  assert.equal(await refresh('r3'), true, 'something else changed before the mark, so it reloads');
  assert.equal(loads, 2);
});
