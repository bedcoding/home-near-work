/** 읽기를 모두 마친 버전만 기억한다. 실패한 버전은 다음 폴링에서 다시 읽는다. */
export function createRevisionRefresh(load: () => Promise<void>) {
  let loadedRevision: string | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  const refresh = (revision: string, force = false): Promise<boolean> => {
    const result = pending.catch(() => {}).then(async () => {
      if (!force && revision === loadedRevision) return false;
      await load();
      loadedRevision = revision;
      return true;
    });
    pending = result;
    return result;
  };
  /**
   * 화면이 직접 바꾸고 이미 화면에 반영한 변화(예: '봤음')만 든 버전이면 다시 읽지 않게 읽은 버전으로 친다.
   * from은 바꾸기 직전 서버 버전이라, 그때까지 화면이 다 읽은 상태(from과 같음)일 때만 to로 옮긴다.
   */
  const advance = (from: string, to: string) => {
    pending = pending.catch(() => {}).then(() => {
      if (loadedRevision === from) loadedRevision = to;
    });
  };
  return Object.assign(refresh, { advance });
}
