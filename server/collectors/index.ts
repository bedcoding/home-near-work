import { betterliving, celib, mangrove } from './coliving.js';
import { courtauction } from './courtauction.js';
import { daangn } from './daangn.js';
import { gobang } from './gobang.js';
import { onbid } from './onbid.js';
import { peterpanz } from './peterpanz.js';
import { ziptoss } from './ziptoss.js';
import { dabang } from './dabang.js';
import { zigbang } from './zigbang.js';
import type { Collector } from './types.js';

// 개발할 때 HNW_SOURCES=ziptoss 처럼 일부 사이트만 돌릴 수 있다.
const only = process.env.HNW_SOURCES?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];

/** 조회 순서대로(shared/types.ts의 RUN_ALL_SOURCES와 같게 둔다. 테스트가 확인함). */
export const COLLECTORS: Collector[] = [dabang, zigbang, ziptoss, peterpanz, daangn, gobang, betterliving, mangrove, celib, courtauction, onbid].filter(
  (c) => only.length === 0 || only.includes(c.id),
);
