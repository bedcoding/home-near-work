// 예약 요청은 서버에, 수신한 회차와 보고서는 확장 저장소에 남긴다.
// 대시보드 탭 없이도 동작하며, 같은 회차를 다시 받아도 새 순회를 만들지 않는다.
const HNW_AUTO_BROWSE = (() => {
  const CLIENT = 'hnw-browse-auto-client';
  const REPORT = 'hnw-browse-auto-report';
  const ACK = 'hnw-browse-auto-ack';
  let polling = false;

  async function report(clientId) {
    const stored = await chrome.storage.local.get([REPORT, ACK]);
    const pending = stored[REPORT];
    if (!pending || stored[ACK] === pending.token) return;
    const { token, ...payload } = pending;
    try {
      await postJson('/api/browse/auto/report', { clientId, ...payload }, 'POST', 5000);
    } catch (error) {
      // 서버가 다른 회차로 넘어갔거나 설정을 해제한 기록은 재전송하지 않는다.
      // 네트워크 오류/5xx는 ACK를 남기지 않아 다음 알람에서 다시 보낸다.
      if (error?.status !== 409 && error?.status !== 410) throw error;
    }
    await chrome.storage.local.set({ [ACK]: token });
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      let clientId = (await chrome.storage.local.get(CLIENT))[CLIENT];
      if (typeof clientId !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(clientId)) {
        clientId = crypto.randomUUID();
        await chrome.storage.local.set({ [CLIENT]: clientId });
      }
      await report(clientId);
      // 수동 실행·중단 작업과 미전송 응답을 덮어쓰지 않는다.
      if (!(await HNW_BROWSE.automaticReady())) return;
      const { request } = await postJson('/api/browse/auto/poll', { clientId, version: chrome.runtime.getManifest().version }, 'POST', 5000);
      if (!request) return;
      try {
        await HNW_BROWSE.startAutomatic(request);
      } catch (error) {
        if (error?.code === 'busy') return;
        const state = await HNW_BROWSE.read();
        // 준비 과정의 중단 상태가 저장됐으면 그 보고서를 사용한다.
        if (state?.automaticRequestId !== request.id) {
          await chrome.storage.local.set({ [REPORT]: {
            requestId: request.id, runId: request.id, status: 'failed',
            totalJobs: 0, completeJobs: 0, partialJobs: 0, failedJobs: 0, token: crypto.randomUUID(),
          } });
        }
      }
      await report(clientId);
    } finally { polling = false; }
  }
  return { poll };
})();
