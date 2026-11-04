/** 읽기를 모두 마친 버전만 기억한다. 실패한 버전은 다음 폴링에서 다시 읽는다. */
export function createRevisionRefresh(load: () => Promise<void>) {
  let loadedRevision: string | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  return (revision: string, force = false): Promise<boolean> => {
    const result = pending.catch(() => {}).then(async () => {
      if (!force && revision === loadedRevision) return false;
      await load();
      loadedRevision = revision;
      return true;
    });
    pending = result;
    return result;
  };
}
