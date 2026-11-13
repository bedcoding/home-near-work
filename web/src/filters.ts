import { normalizeFilters, type Filters } from '../../shared/filters';

// 목록 필터는 이 브라우저에만 저장한다. 알림 조건은 설정에서 독립적으로 저장한다.
export { DEFAULT_FILTERS, dealOptions, FILTER_DEALS, filterJudge, isNoOption, passes, plainFilters, type Filters } from '../../shared/filters';

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
  // 왼쪽 필터의 지역 칸(고른 구 안만 보기, 최대 거리)은 안 써서 뺐다. 다시 켤 단추가 없으니 늘 끈 채로 둔다.
  return { ...f, insideAreas: false, distanceMax: null };
}

export function saveFilters(f: Filters) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* 저장이 막혀도 필터는 동작한다 */
  }
}
