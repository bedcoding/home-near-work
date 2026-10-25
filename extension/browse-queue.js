// 사용자가 시작한 지역 순회. 진행표와 미전송 응답은 로컬 저장소에 보관한다.
// 페이지 열림/화면 응답 수신은 전체 매물 수집 완료로 취급하지 않는다.
const HNW_BROWSE = (() => {
  const KEY = 'hnw-browse-state';
  const OUTBOX = 'hnw-browse-pending:';
  const ALARM = 'hnw-browse';
  const SITES = ['naver', 'dabang', 'zigbang', 'kbland', 'hogangnono', 'daangn'];
  const LISTINGS = ['naver', 'dabang', 'zigbang'];
  let serial = Promise.resolve();
  let timer;
  let reportTimer;
  let reporting = false;
  let latestReport;
  const locked = (fn) => {
    const result = serial.then(fn);
    serial = result.catch(() => {});
    return result;
  };
  const read = async () => (await chrome.storage.local.get(KEY))[KEY] || null;
  const ownsTab = async (tabId) => Number.isInteger(tabId) && (await read())?.tabId === tabId;
  const record = (state, code, job = state.jobs[state.index], counts = {}) => {
    const event = { at: Date.now(), code, ...counts };
    if (job) { event.jobIndex = state.jobs.indexOf(job); event.site = job.site; }
    state.logs = [...(state.logs || []), event].slice(-100);
  };
  function phase(state, next, detail, code) {
    if (state.phase !== next || state.detail !== detail) {
      state.phase = next; state.phaseAt = Date.now(); state.detail = detail;
      if (code) record(state, code);
    }
  }
  function diagnostic(state) {
    const job = state.jobs[state.index];
    return {
      id: state.id, status: state.status, phase: state.phase || (state.status === 'running' ? 'waiting' : state.status),
      createdAt: state.createdAt || state.updatedAt, updatedAt: state.updatedAt, heartbeatAt: state.heartbeatAt || state.updatedAt,
      index: state.index, totalJobs: state.jobs.length,
      totals: state.jobs.reduce((sum, j) => {
        for (const key of Object.keys(sum)) sum[key] += j.receipt?.[key] || 0;
        return sum;
      }, { responses: 0, listings: 0, newCount: 0, changedCount: 0 }),
      ...(job ? { current: { site: job.site, actions: job.actions || 0, received: job.received || 0 } } : {}),
      logs: state.logs || [],
    };
  }
  function report(state) {
    // 진단에는 지역명, 좌표, URL, 응답 본문을 보내지 않는다. 전송 실패는 순회를 막지 않는다.
    reportSnapshot(diagnostic(state));
  }
  function reportSnapshot(snapshot) {
    // 가장 최근 상태만 보내며 오래된 진단 전송을 쌓지 않는다.
    latestReport = snapshot;
    if (reporting || reportTimer) return;
    reportTimer = setTimeout(async () => {
      reportTimer = null;
      const payload = latestReport; latestReport = null; reporting = true;
      try { await postJson('/api/browse/progress', payload, 'POST', 3000); } catch { /* 진단 실패는 조회 실패가 아니다. */ }
      finally { reporting = false; if (latestReport) reportSnapshot(latestReport); }
    }, 500);
  }
  const save = async (state) => {
    state.updatedAt = Date.now();
    state.heartbeatAt = Date.now();
    await chrome.storage.local.set({ [KEY]: state });
    report(state);
  };
  const keys = async () => (chrome.storage.local.getKeys ? await chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null)))
    .filter((k) => k.startsWith(OUTBOX)).sort();
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; void tick().catch(() => {}); }, 3000);
  }
  function isDashboard(sender) {
    try {
      const u = new URL(sender.url || sender.tab?.url);
      return sender.frameId === 0 && ['http://localhost:8787', 'http://127.0.0.1:8787'].includes(u.origin);
    } catch { return false; }
  }
  function samePage(expected, actual) {
    try {
      const a = new URL(expected), b = new URL(actual);
      return a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
    } catch { return false; }
  }
  function hasRegion(link) {
    const u = new URL(link.url);
    if (link.id === 'zigbang') return /\/subways\/[^/]+\/items/.test(u.pathname);
    if (link.id === 'hogangnono') return /^\/apt\/[^/]+/.test(u.pathname);
    if (link.id === 'daangn') return /^\/map\/subway\/[^/]+/.test(u.pathname);
    return true;
  }
  function usefulCapture(c) {
    try {
      const u = new URL(c.url);
      if (c.site === 'naver') return /(?:articleClusters|Articles)$/.test(u.pathname);
      if (c.site === 'dabang') return u.pathname.includes('/room-list/');
      if (c.site === 'zigbang') return /\/items\/(list|subways\/[^/]+\/onerooms)$/.test(u.pathname) || u.pathname.endsWith('/common/subway/all');
      if (c.site === 'kbland') return u.pathname.endsWith('/stutCdFilter/count');
      if (c.site === 'hogangnono') return u.pathname.includes('/api/apt/');
      return c.site === 'daangn' && (u.hash === '#page-data' || /(?:realty|properties|listings)/.test(u.pathname));
    } catch { return false; }
  }
  async function jobsFor(areas, chosen, runId) {
    const got = await chrome.storage.local.get(['sites', 'hnw-stations']);
    const selected = SITES.filter((id) => chosen.includes(id) && hnwEnabled(got.sites, HNW_SITES.find((s) => s.id === id)));
    if (!selected.length) throw new Error('확장에서 켜 둔 사이트 중 조회할 곳을 골라 주세요.');
    const unique = new Map();
    for (const input of areas) {
      const area = areaFrom(input);
      if (!area || area.radiusM <= 0 || area.radiusM > 50000) throw new Error('지역 위치와 반경을 확인해 주세요.');
      unique.set(`${area.lat}|${area.lng}|${area.radiusM}`, area);
    }
    const jobs = [];
    for (const area of unique.values()) {
      for (const link of hnwSiteLinks(area, got['hnw-stations']).filter((l) => selected.includes(l.id))) {
        const ready = hasRegion(link);
        jobs.push({ id: `${runId}:${jobs.length}`, areaName: area.name, area, site: link.id, siteName: link.name,
          url: link.url, status: ready ? 'pending' : 'needs-input', note: ready ? '대기 중' : '이 지역의 역이나 단지 바로가기 정보가 없습니다. 사이트에서 지역을 한 번 검색한 뒤 미확인 재시도를 눌러 주세요.' });
      }
    }
    return jobs;
  }
  async function refreshHints() {
    const { stations } = await postJson('/api/browse/hints', {}, 'POST', 5000);
    if (!Array.isArray(stations)) throw new Error('지역 바로가기 정보를 받지 못했습니다. 대시보드 서버를 업데이트하고 다시 시작해 주세요.');
    await chrome.storage.local.set({ 'hnw-stations': stations });
  }
  async function context(message, sender) {
    const state = await read();
    if (!Number.isInteger(sender.tab?.id) || sender.tab.id !== state?.tabId) return null;
    const unbound = { owned: true, jobId: null };
    const job = state?.jobs[state.index];
    if (!job || state.status !== 'running' || job.status !== 'running' || sender.frameId !== 0 || !samePage(job.url, sender.url)) return unbound;
    if (typeof message.documentToken !== 'string' || !message.documentToken || message.documentToken.length > 80) return unbound;
    // 이미 연결된 문서가 새로고침/이동으로 바뀌면 조작을 멈추고 이어하기를 기다린다.
    if (job.documentToken && job.documentToken !== message.documentToken) {
      state.status = 'paused';
      job.note = '조회 탭이 새로고침되거나 이동했습니다. 이어하기를 눌러 다시 조회하세요.';
      phase(state, 'paused', job.note, 'pause');
      await save(state);
      return unbound;
    }
    job.documentToken = message.documentToken;
    job.documentId = sender.documentId || null;
    job.loadedAt = Date.now();
    phase(state, 'loading', '페이지와 연결됐습니다. 첫 목록 응답을 기다립니다.', 'connected');
    await save(state);
    return { owned: true, jobId: job.id };
  }
  async function capture(message, sender) {
    if (!message.browseJobId) return false;
    return locked(async () => {
      const state = await read();
      const job = state?.jobs.find((j) => j.id === message.browseJobId);
      if (!job || sender.tab?.id !== state.tabId || sender.frameId !== 0 || message.documentToken !== job.documentToken ||
          (job.documentId && sender.documentId !== job.documentId)) return true;
      const c = message.capture;
      if (!c || c.site !== job.site || !samePage(job.url, c.pageUrl) || typeof c.body !== 'string' || c.body.length > 2000000) return true;
      if (!usefulCapture(c)) return true;
      if ((await keys()).length >= 200) {
        job.captureGap = true;
        state.status = 'paused'; job.blocked = '미전송 응답이 많아 수신을 멈췄습니다. 서버 연결을 복구한 뒤 미확인 재시도를 눌러 주세요.';
        job.note = job.blocked;
        phase(state, 'paused', job.note, 'pause');
        await save(state);
        return true;
      }
      const batchId = crypto.randomUUID();
      await chrome.storage.local.set({ [`${OUTBOX}${Date.now()}:${batchId}`]: { jobId: job.id, batchId, captures: [c] } });
      job.lastCaptureAt = Date.now();
      job.received = (job.received || 0) + 1;
      record(state, 'received', job, { responses: job.received });
      if ([401, 403, 429].includes(c.status)) job.blocked = `사이트가 요청을 거절했습니다(HTTP ${c.status}). 직접 확인이 필요합니다.`;
      await save(state);
      await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
      schedule();
      return true;
    });
  }
  async function flushOutbox(state) {
    // 배치 하나의 ID는 성공 확인까지 바꾸지 않는다. 응답을 잃어도 서버가 중복 처리를 막는다.
    // 서버가 느려도 중단/상태 요청이 오래 밀리지 않도록 한 차례의 전송을 짧게 제한한다.
    const until = Date.now() + 1000;
    for (const key of (await keys()).slice(0, 12)) {
      const payload = (await chrome.storage.local.get(key))[key];
      if (!payload) continue;
      if (state.status === 'running') phase(state, 'saving', '받은 응답을 로컬 서버에 저장하고 확인을 기다립니다.');
      await save(state);
      const { receipt } = await postJson('/api/browse/capture', payload, 'POST', 5000);
      if (!receipt || !['responses', 'listings', 'newCount', 'changedCount'].every((k) => Number.isSafeInteger(receipt[k]) && receipt[k] >= 0)) throw new Error('서버에서 저장 결과를 확인하지 못했습니다.');
      const job = state.jobs.find((j) => j.id === payload.jobId);
      if (job) job.receipt = receipt;
      record(state, 'saved', job, { responses: receipt.responses, listings: receipt.listings });
      await save(state);
      await chrome.storage.local.remove(key);
      if (Date.now() >= until) break;
    }
    return (await keys()).length === 0;
  }
  async function finishJob(state, status, note) {
    const job = state.jobs[state.index];
    job.status = status;
    job.note = note;
    record(state, 'job-end', job, { responses: job.receipt?.responses || 0, listings: job.receipt?.listings || 0 });
    phase(state, 'waiting', note);
    state.index += 1;
    await save(state);
  }
  async function step() {
    const state = await read();
    if (!state) return;
    try {
      if (!(await flushOutbox(state))) { schedule(); return; }
    } catch {
      state.status = 'paused';
      const job = state.jobs[state.index];
      if (job) job.note = '대시보드에 저장하지 못해 응답을 보관 중입니다. 서버 연결을 확인한 뒤 이어하기를 눌러 주세요.';
      phase(state, 'paused', '서버 저장을 확인하지 못해 멈췄습니다. 받은 응답은 보관 중입니다.', 'pause');
      await save(state);
      return;
    }
    if (state.status !== 'running') { await chrome.alarms.clear(ALARM); return; }
    while (state.index < state.jobs.length && !['pending', 'running'].includes(state.jobs[state.index].status)) state.index += 1;
    if (state.index >= state.jobs.length) {
      state.status = 'done';
      phase(state, 'done', '모든 선택 작업의 확인을 마쳤습니다. 작업별 결과와 미확인 사유를 확인하세요.', 'done');
      await save(state);
      await chrome.alarms.clear(ALARM);
      return;
    }
    const job = state.jobs[state.index];
    const toggles = (await chrome.storage.local.get('sites')).sites;
    if (!hnwEnabled(toggles, HNW_SITES.find((s) => s.id === job.site))) {
      await finishJob(state, 'needs-input', '확장에서 이 사이트를 꺼서 건너뛰었습니다.'); schedule(); return;
    }
    if (job.status === 'pending') {
      phase(state, 'opening', '선택한 지역의 사이트 페이지를 전용 탭에서 엽니다.', 'open');
      await save(state);
      // 별도로 만든 탭만 사용하며 사용자가 열어 둔 다른 탭에는 접근하지 않는다.
      if (state.tabId == null) {
        const win = await chrome.windows.create({ url: 'about:blank', focused: true });
        state.tabId = win.tabs?.[0]?.id;
        if (state.tabId == null) throw new Error('조회 탭을 만들지 못했습니다.');
      } else {
        try { await chrome.tabs.get(state.tabId); } catch {
          state.tabId = null; state.status = 'paused'; job.note = '조회 창이 닫혔습니다. 이어하기를 누르면 새 창에서 계속합니다.'; phase(state, 'paused', job.note, 'pause'); await save(state); return;
        }
      }
      Object.assign(job, { status: 'running', note: '페이지를 여는 중', startedAt: Date.now(), lastCaptureAt: 0, lastActionAt: 0, settlingAt: 0, loadedAt: 0, actions: 0, idle: 0, documentToken: null, documentId: null, blocked: null });
      phase(state, 'loading', '페이지가 열리고 확장이 연결되기를 기다립니다. 최대 45초까지 확인합니다.');
      await save(state);
      const before = await chrome.tabs.get(state.tabId);
      if (before.url === job.url) await chrome.tabs.reload(state.tabId);
      else await chrome.tabs.update(state.tabId, { url: job.url });
      schedule(); return;
    }
    let tab;
    try { tab = await chrome.tabs.get(state.tabId); } catch {
      state.tabId = null; state.status = 'paused'; job.note = '조회 창이 닫혔습니다. 이어하기를 눌러 주세요.'; phase(state, 'paused', job.note, 'pause'); await save(state); return;
    }
    const age = Date.now() - job.startedAt;
    if (job.blocked) {
      await finishJob(state, 'needs-input', job.blocked); schedule(); return;
    }
    if (tab.status === 'loading' || !job.documentToken) {
      if (age > 45000) await finishJob(state, 'failed', '45초 안에 지역 페이지와 확장 연결을 확인하지 못했습니다.');
      else {
        phase(state, 'loading', '페이지가 열리고 확장이 연결되기를 기다립니다. 최대 45초까지 확인합니다.');
        await save(state);
      }
      schedule(); return;
    }
    if (!samePage(job.url, tab.url)) {
      state.status = 'paused'; job.note = '조회 탭이 다른 페이지로 이동했습니다. 이어하기로 지역 페이지를 다시 엽니다.'; phase(state, 'paused', job.note, 'pause'); await save(state); return;
    }
    if (Date.now() - job.loadedAt < 8000) {
      phase(state, 'loading', '첫 목록이 표시되고 응답이 도착하기를 기다립니다.');
      await save(state); schedule(); return;
    }
    const bounded = age >= 120000 || job.actions >= 40;
    // 마지막 스크롤/클릭 직후 이동하면 아직 도착하지 않은 목록을 잃을 수 있다.
    // 한도에서는 추가 조작을 멈추고 응답을 최대 15초 더 기다린다.
    if (bounded) {
      job.settlingAt ||= Date.now();
      const settled = Date.now() - Math.max(job.lastActionAt || 0, job.lastCaptureAt || job.loadedAt) >= 8000;
      if (!settled && Date.now() - job.settlingAt < 15000) {
        job.note = '탐색 한도에 도달해 마지막 응답의 저장을 기다리고 있습니다.';
        phase(state, 'waiting', job.note, 'waiting');
        await save(state); schedule(); return;
      }
    }
    let result;
    if (bounded) result = { kind: 'idle', note: '탐색 한도에 도달했습니다.' };
    else try {
      phase(state, 'exploring', '목록을 확인하고 필요한 스크롤 또는 펼치기를 요청합니다.');
      await save(state);
      result = await Promise.race([
        chrome.tabs.sendMessage(state.tabId, { type: 'browse-step', jobId: job.id, site: job.site }, job.documentId ? { documentId: job.documentId } : { frameId: 0 }),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
    } catch { result = null; }
    if (!result) {
      await finishJob(state, 'failed', '페이지 탐색 스크립트가 답하지 않습니다. 확장과 페이지를 새로고침해 주세요.'); schedule(); return;
    }
    job.note = String(result.note || '응답 확인 중').slice(0, 300);
    if (result.kind === 'blocked') {
      await finishJob(state, 'needs-input', job.note); schedule(); return;
    }
    if (result.kind === 'action') {
      job.actions += 1; job.lastActionAt = Date.now(); job.idle = 0;
      phase(state, 'exploring', job.note);
      record(state, 'action', job, { actions: job.actions });
    } else {
      if (result.waiting) job.idle = 0;
      else job.idle += 1;
      // 같은 대기 사유를 3초마다 로그에 반복해서 쌓지 않는다.
      if (job.waitNote !== job.note) { record(state, 'waiting', job); job.waitNote = job.note; }
      phase(state, 'waiting', job.note);
    }
    const quiet = Date.now() - (job.lastCaptureAt || job.loadedAt) >= 8000;
    if (bounded || (quiet && job.idle >= 3)) {
      const saved = job.receipt?.responses > 0;
      const listing = LISTINGS.includes(job.site);
      const status = job.captureGap ? 'needs-input' : !saved ? 'failed' : listing ? 'partial' : 'visited';
      const note = job.captureGap ? '보관 한도를 넘겨 받지 못한 응답이 있습니다. 미확인 다시 조회로 새로 확인해 주세요.'
        : !saved ? '저장된 응답을 확인하지 못했습니다. 빈 매물 결과라는 뜻은 아닙니다.'
        : listing ? `${bounded ? '한 번의 탐색 한도에 도달했습니다. ' : `${job.note} `}${job.receipt.listings ? '받은 목록을 저장했습니다.' : '응답은 저장했지만 조건에 맞는 개별 매물 저장은 확인하지 못했습니다.'} 현재 지도와 필터 범위의 일부이며 전체 매물 수집은 확인되지 않았습니다.`
        : `${job.site === 'kbland' ? '건수 응답' : '화면 응답'}을 확인했습니다. 개별 매물 목록 저장은 지원하지 않습니다.`;
      await finishJob(state, status, note);
    } else await save(state);
    schedule();
  }
  const tick = () => locked(async () => {
    try { await step(); } catch (e) {
      const state = await read();
      if (state) {
        state.status = 'paused';
        const job = state.jobs[state.index];
        if (job) job.note = `순회를 멈췄습니다: ${String(e?.message || e).slice(0, 180)}`;
        phase(state, 'error', '조회 중 오류가 발생해 멈췄습니다. 작업별 확인 내용을 참고하세요.', 'error');
        await save(state);
      }
    }
  });
  async function command(message) {
    let state = await read();
    if (message.command === 'start') {
      if (state?.status === 'running') throw new Error('이미 지역 순회가 진행 중입니다.');
      if ((await keys()).length) throw new Error('보관 중인 응답이 있습니다. 이어하기로 먼저 저장해 주세요.');
      if (!Array.isArray(message.areas) || !message.areas.length || message.areas.length > 100) throw new Error('조회할 지역을 1~100곳 골라 주세요.');
      const id = crypto.randomUUID();
      const chosen = Array.isArray(message.sites) ? message.sites : ['naver', 'dabang', 'zigbang'];
      state = { id, status: 'running', jobs: [], index: 0, createdAt: Date.now(), updatedAt: Date.now(), tabId: null, logs: [] };
      record(state, 'start');
      phase(state, 'preparing', '서버에서 지역 바로가기 정보를 확인합니다. 최대 5초까지 기다립니다.', 'hints');
      await save(state);
      try {
        await refreshHints();
        state.jobs = await jobsFor(message.areas, chosen, id);
        phase(state, 'opening', '조회할 지역과 사이트 목록을 준비했습니다. 전용 탭을 여는 중입니다.', 'ready');
      } catch (error) {
        state.status = 'paused';
        phase(state, 'error', `조회 준비에 실패했습니다${Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : ''}. 서버 연결을 확인한 뒤 새 순회를 시작해 주세요.`, 'error');
        await save(state);
        throw error;
      }
    } else if (message.command === 'pause') {
      if (state?.status === 'running') {
        state.status = 'paused'; phase(state, 'paused', '사용자가 조회를 중단했습니다.', 'pause');
      }
    } else if (message.command === 'resume' || message.command === 'retry') {
      if (!state) throw new Error('이어갈 지역 순회가 없습니다.');
      if (state.status === 'running') throw new Error('진행 중인 순회를 먼저 중단해 주세요.');
      if (!state.jobs.length) throw new Error('조회 준비가 완료되지 않았습니다. 선택한 조건으로 새 순회를 시작해 주세요.');
      if (message.command === 'retry') {
        if ((await keys()).length) throw new Error('보관된 응답부터 이어하기로 저장해 주세요.');
        await refreshHints();
        const got = await chrome.storage.local.get('hnw-stations');
        for (const job of state.jobs) {
          if (!['failed', 'partial', 'needs-input'].includes(job.status)) continue;
          const link = hnwSiteLinks(job.area, got['hnw-stations']).find((l) => l.id === job.site);
          if (!link || !hasRegion(link)) continue;
          Object.assign(job, { id: crypto.randomUUID(), url: link.url, status: 'pending', note: '재시도 대기', receipt: undefined, captureGap: false });
        }
        state.index = 0;
      }
      for (const job of state.jobs) if (job.status === 'running') job.status = 'pending';
      if (state.tabId != null) {
        try { await chrome.tabs.get(state.tabId); } catch { state.tabId = null; }
      }
      state.status = 'running';
      phase(state, 'opening', message.command === 'retry' ? '미확인 작업을 다시 준비했습니다.' : '중단한 조회를 이어갑니다.', message.command === 'retry' ? 'retry' : 'resume');
    } else throw new Error('알 수 없는 순회 명령입니다.');
    if (state) {
      await save(state);
      if (state.status === 'running') {
        await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
        schedule();
      }
    }
    return state;
  }
  async function message(input, sender) {
    // 상태 읽기는 저장/페이지 요청 뒤에 줄 세우지 않는다. 저장소의 마지막 확정 상태를 즉시 돌려준다.
    if (input.type === 'browse-status') {
      if (!isDashboard(sender)) throw new Error('대시보드에서만 지역 순회를 조작할 수 있습니다.');
      return { state: await read() };
    }
    return locked(async () => {
      if (input.type === 'browse-context') return context(input, sender);
      if (!isDashboard(sender)) throw new Error('대시보드에서만 지역 순회를 조작할 수 있습니다.');
      if (input.type === 'browse-command') return { state: await command(input) };
      return null;
    });
  }
  async function recover() {
    return locked(async () => {
      const state = await read();
      if (!state) return;
      if (state.status === 'running' && state.phase === 'preparing' && !state.jobs.length) {
        state.status = 'paused';
        phase(state, 'error', '준비 중 확장이 다시 시작됐습니다. 선택한 조건으로 새 순회를 시작해 주세요.', 'recovered');
        await save(state);
      } else if (state.status === 'running' || (await keys()).length) {
        record(state, 'recovered');
        await save(state);
        await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
        schedule();
      } else report(state);
    });
  }
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void tick(); });
  // 서비스 워커가 잠들었다가 돌아와도 기존 순회의 알람과 타이머를 다시 연결한다.
  void recover().catch(() => {});
  // 확장 업데이트는 페이지에 붙은 스크립트도 바뀌므로 사용자에게 재개를 맡긴다.
  chrome.runtime.onInstalled?.addListener(() => void locked(async () => {
    const state = await read();
    if (state?.status !== 'running') return;
    state.status = 'paused';
    phase(state, 'paused', '확장이 업데이트되어 조회를 멈췄습니다. 대시보드를 새로고침한 뒤 이어하기를 눌러 주세요.', 'recovered');
    await save(state);
  }).catch(() => {}));
  // 브라우저 재시작 시 이전 탭 번호를 신뢰하지 않는다. 사용자가 이어하기로 다시 시작한다.
  chrome.runtime.onStartup.addListener(() => void locked(async () => {
    const state = await read();
    if (state) {
      if (state.status === 'running') state.status = 'paused';
      state.tabId = null;
      const job = state.jobs[state.index];
      if (job) job.note = '브라우저가 다시 시작되었습니다. 이어하기를 눌러 주세요.';
      if (state.status === 'paused') phase(state, 'paused', '브라우저가 다시 시작되었습니다. 이어하기를 눌러 주세요.', 'recovered');
      await save(state);
    }
  }));
  return { message, capture, tick, read, ownsTab, samePage, hasRegion, recover, diagnostic };
})();
