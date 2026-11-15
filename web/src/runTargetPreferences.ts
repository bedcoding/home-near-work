import { SOURCE_LABEL, type RunScope, type SourceId } from '../../shared/types';

interface RunTargetPreferences {
  deselectedSources: SourceId[];
  includeNotices: boolean;
}

const keyFor = (scope?: RunScope) => `hnw-run-targets:${scope ?? 'all'}`;

export function loadRunTargetPreferences(scope?: RunScope): RunTargetPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(keyFor(scope)) ?? 'null');
    if (Array.isArray(saved?.deselectedSources) && typeof saved.includeNotices === 'boolean') {
      const sources = saved.deselectedSources.filter((source: unknown): source is SourceId =>
        typeof source === 'string' && Object.hasOwn(SOURCE_LABEL, source));
      return { deselectedSources: [...new Set<SourceId>(sources)], includeNotices: saved.includeNotices };
    }
  } catch {
    // 저장소를 사용할 수 없으면 기본값으로 연다.
  }
  return { deselectedSources: [], includeNotices: true };
}

export function saveRunTargetPreferences(scope: RunScope | undefined, preferences: RunTargetPreferences) {
  const { deselectedSources, includeNotices } = preferences;
  try {
    localStorage.setItem(keyFor(scope), JSON.stringify({ deselectedSources, includeNotices }));
  } catch {
    // 조회는 브라우저 저장소 없이도 가능하다.
  }
}
