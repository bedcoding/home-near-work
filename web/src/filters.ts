import { normalizeFilters, type Filters } from '../../shared/filters';
import { api } from './api';

// 필터 판정은 서버 알림도 같이 쓰도록 shared/filters.ts에 둔다. 여기서는 이 브라우저에 저장하고 서버 알림에 알린다.
export { DEFAULT_FILTERS, dealOptions, FILTER_DEALS, isNoOption, passes, type Filters } from '../../shared/filters';

const KEY = 'hnw-filters-v1';
/** 필터를 바꾼 뒤 서버에 알리기까지 기다리는 시간(ms). 검색어를 치는 동안 여러 번 보내지 않게. */
const SYNC_DELAY_MS = 1000;

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 알림이 같은 조건으로 매물을 고르게 서버에 필터를 알린다(대시보드를 열 때 바로, 바꾸면 SYNC_DELAY_MS 뒤).
 * 개발 서버(Vite) 화면은 실제 대시보드 서버에 붙어 있어서 보내지 않는다. 못 보내도 화면은 그대로 동작한다.
 */
function syncToServer(f: Filters, delayMs: number) {
  if (import.meta.env.DEV) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    api.setAlertFilter(f).catch(() => {});
  }, delayMs);
}

/** 저장된 필터를 읽는다(지금 필터에 없는 항목과 값은 버림). 읽은 필터는 서버 알림에도 알린다. */
export function loadFilters(): Filters {
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    /* 저장된 값을 못 읽으면 기본값 */
  }
  const f = normalizeFilters(saved);
  syncToServer(f, 0);
  return f;
}

export function saveFilters(f: Filters) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* 저장이 막혀도 필터는 동작한다 */
  }
  syncToServer(f, SYNC_DELAY_MS);
}
