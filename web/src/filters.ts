import { normalizeFilters, type Filters } from '../../shared/filters';

// 목록 필터는 이 브라우저에만 저장한다. 알림 조건은 설정에서 독립적으로 저장한다.
export { DEFAULT_FILTERS, dealOptions, FILTER_DEALS, isNoOption, passes, type Filters } from '../../shared/filters';

const KEY = 'hnw-filters-v1';

/** 저장된 목록 필터를 읽는다(지금 필터에 없는 항목과 값은 버림). */
export function loadFilters(): Filters {
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    /* 저장된 값을 못 읽으면 기본값 */
  }
  const f = normalizeFilters(saved);
  return f;
}

export function saveFilters(f: Filters) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* 저장이 막혀도 필터는 동작한다 */
  }
}
