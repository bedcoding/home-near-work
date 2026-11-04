import fs from 'node:fs';
import path from 'node:path';
import { PAGE_DELAY_MS, RUNS_DIR } from '../config.js';
import * as store from '../db.js';
import { learnLinkHints, zigbangStations } from '../link-hints.js';
import { createZigbangCollector } from '../zigbang-collect.js';
import { ZIGBANG_STATION_IDS_KEY } from '../zigbang-client.js';

export const zigbang = createZigbangCollector({
  fetch: (input, init) => fetch(input, init),
  stations: zigbangStations,
  learnStations: (url, body) => learnLinkHints('zigbang', url, body),
  touch: (ids, at) => store.touchListings('zigbang', ids, at),
  readSeen: () => {
    try {
      const value = JSON.parse(store.getSetting(ZIGBANG_STATION_IDS_KEY) ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  },
  writeSeen: (value) => store.setSetting(ZIGBANG_STATION_IDS_KEY, JSON.stringify(value)),
  save: (runId, name, body) => {
    const dir = path.join(RUNS_DIR, String(runId), 'zigbang');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  },
  delayMs: PAGE_DELAY_MS,
});
