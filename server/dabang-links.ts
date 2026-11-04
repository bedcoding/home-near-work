import * as store from './db.js';
import { withDabangRoom } from './dabang-parse.js';

/**
 * 원본 열기 주소에 방 id가 없는 저장된 다방 매물(예전 방식 주소)에 원본 데이터의 방 id를 붙인다. 서버를 켤 때 부른다.
 * 이미 붙어 있거나 원본에 id가 없으면 그대로 둔다. 고친 매물 수를 돌려준다.
 */
export function refreshDabangUrls(): number {
  const rows = store.db.prepare("SELECT id, data, raw FROM listings WHERE source = 'dabang' AND raw IS NOT NULL").all() as { id: string; data: string; raw: string }[];
  const update = store.db.prepare('UPDATE listings SET data = ? WHERE id = ?');
  let changed = 0;
  store.db.transaction(() => {
    for (const row of rows) {
      let roomId: unknown, data: { url?: unknown };
      try { roomId = JSON.parse(row.raw)?.id; data = JSON.parse(row.data); } catch { continue; }
      const next = withDabangRoom(data.url, roomId);
      if (!next || next === data.url) continue;
      update.run(JSON.stringify({ ...data, url: next }), row.id);
      changed++;
    }
  })();
  return changed;
}
