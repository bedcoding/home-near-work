// 사용자가 시작한 지역 순회. 진행표와 미전송 응답은 로컬 저장소에 보관한다.
// 페이지 열림/화면 응답 수신은 전체 매물 수집 완료로 취급하지 않는다.
const HNW_BROWSE = (() => {
  const KEY = 'hnw-browse-state';
  const OUTBOX = 'hnw-browse-pending:';
  const AUTO_REPORT = 'hnw-browse-auto-report';
  const AUTO_STARTED = 'hnw-browse-auto-started';
  const ALARM = 'hnw-browse';
  // 당근부동산은 대시보드 서버의 '조회하기'가 모으므로 순차 조회에서 다루지 않는다.
  const SITES = ['naver', 'dabang', 'zigbang', 'kbland', 'hogangnono'];
  const LISTINGS = ['naver', 'dabang', 'zigbang'];
  let serial = Promise.resolve();
  let timer;
  let timerAt = 0;
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
      ...(job ? { current: { site: job.site, actions: job.actions || 0, received: job.received || 0,
        ...(job.naverCursorLedger ? { pages: job.naverCursorLedger.pages, listings: job.naverCursorLedger.ids.length,
          ...(job.naverCursorLedger.total != null ? { total: job.naverCursorLedger.total } : {}), lastListAt: job.naverListAt || 0 } : {}) } } : {}),
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
  const save = async (state, replacedReport = null) => {
    state.updatedAt = Date.now();
    state.heartbeatAt = Date.now();
    const autoReport = state.automaticRequestId ? automaticReport(state) : replacedReport;
    await chrome.storage.local.set({ [KEY]: state, ...(autoReport ? { [AUTO_REPORT]: autoReport } : {}) });
    report(state);
    const job = state.jobs?.[state.index] || state.jobs?.[state.index - 1];
    if (state.tabId != null && job?.site === 'naver' && job.naverScope) {
      void chrome.tabs.sendMessage(state.tabId, { type: 'browse-indicator', jobId: job.id, state: state.status,
        status: job.status, message: job.note || state.detail || '', areaName: job.areaName,
        pages: job.naverCursorLedger?.pages || 0, received: job.naverCursorLedger?.ids.length || 0,
        total: job.naverCursorLedger?.total ?? null, stored: job.receipt?.naverCoverage?.stored ?? 0,
        lastAt: job.naverListAt || null,
        filterSummary: job.naverScope.filter ? HNW_NAVER_LEDGER.summary(job.naverScope.filter) : '',
      }, job.documentId ? { documentId: job.documentId } : { frameId: 0 }).catch(() => {});
    }
  };
  function automaticReport(state, status = state.status) {
    if (!state.jobs.length && state.phase === 'error') status = 'failed';
    return { requestId: state.automaticRequestId, runId: state.id, status,
      totalJobs: state.jobs.length,
      completeJobs: state.jobs.filter((j) => j.status === 'complete').length,
      partialJobs: state.jobs.filter((j) => ['partial', 'visited'].includes(j.status)).length,
      failedJobs: state.jobs.filter((j) => ['failed', 'needs-input'].includes(j.status)).length,
      token: crypto.randomUUID() };
  }
  const keys = async () => (chrome.storage.local.getKeys ? await chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null)))
    .filter((k) => k.startsWith(OUTBOX)).sort();
  function schedule(delay = 3000) {
    const at=Date.now()+delay;
    if (timer && timerAt<=at) return;
    if (timer) clearTimeout(timer);
    timerAt=at;
    timer = setTimeout(() => { timer = null; timerAt=0; void tick().catch(() => {}); }, delay);
  }
  function paceNaverPage(job, page) {
    if (!page || job.naverDelayPage===page) return;
    job.naverDelayPage=page;
    job.naverDelayMs=3000+Math.floor(Math.random()*2001);
    // Persist the deadline so alarms and worker recovery cannot skip the wait.
    job.naverNextAt=Date.now()+job.naverDelayMs;
  }
  function isDashboard(sender) {
    try {
      const u = new URL(sender.url || sender.tab?.url);
      return sender.frameId === 0 && ['http://localhost:8787', 'http://127.0.0.1:8787'].includes(u.origin);
    } catch { return false; }
  }
  function isPopup(sender) {
    return typeof chrome.runtime.id === 'string' && sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('popup.html');
  }
  function samePage(expected, actual) {
    try {
      const a = new URL(expected), b = new URL(actual);
      if (a.origin !== b.origin || a.pathname.replace(/\/$/, '') !== b.pathname.replace(/\/$/, '')) return false;
      if (a.hostname.endsWith('dabangapp.com') && a.searchParams.get('search_type') === 'region') {
        return b.searchParams.getAll('search_type').length === 1 && b.searchParams.get('search_type') === 'region' &&
          b.searchParams.getAll('search_id').length === 1 && a.searchParams.get('search_id') === b.searchParams.get('search_id');
      }
      return true;
    } catch { return false; }
  }
  function zigbangStation(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && !u.port && !u.username && !u.password && ['www.zigbang.com', 'zigbang.com'].includes(u.hostname)
        ? /^\/home\/oneroom\/subways\/([1-9]\d*)\/items\/?$/.exec(u.pathname)?.[1] || null : null;
    } catch { return null; }
  }
  function verifiedZigbang(job, page) {
    const stationId = zigbangStation(job.url), stored = job.receipt?.zigbangCoverage;
    return stationId && !job.captureGap && page?.complete === true && stored?.complete === true &&
      page.stationId === stationId && stored.stationId === stationId && page.radiusKm === 1 && stored.radiusKm === 1 &&
      Number.isSafeInteger(page.total) && page.total >= 0 && page.total === stored.total &&
      page.received === page.total && page.missing === 0 && stored.received === stored.total && stored.missing === 0 &&
      stored.unreadable === 0 && Number.isSafeInteger(stored.stored) && stored.stored >= 0 &&
      Number.isSafeInteger(stored.excluded) && stored.excluded >= 0 && stored.stored + stored.excluded === stored.total;
  }
  function pinnedZigbang(value) {
    if (!value || typeof value.stationId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.stationId) || value.radiusKm !== 1 ||
        typeof value.url !== 'string' || zigbangStation(value.url) !== value.stationId) throw new Error('직방 예약의 역 1km 범위를 확인해 주세요.');
    const url = new URL(value.url);
    if (url.search || url.hash || url.hostname !== 'www.zigbang.com') throw new Error('직방 예약의 역 주소를 확인해 주세요.');
    return { stationId: value.stationId, radiusKm: 1, url: url.href };
  }
  function dabangRegions(input) {
    if (input === undefined) return [];
    if (!Array.isArray(input) || !input.length || input.length > 50) throw new Error('다방 동별 범위를 확인해 주세요.');
    const unique = new Map();
    for (const value of input) {
      const u = new URL(value?.url);
      if (value?.kind !== 'dabang-region' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 ||
          typeof value.dong !== 'string' || !value.dong.trim() || value.dong.length > 60 ||
          u.protocol !== 'https:' || !['www.dabangapp.com', 'dabangapp.com'].includes(u.hostname) || u.port || u.username || u.password || u.hash ||
          u.pathname !== '/map/onetwo' || u.searchParams.getAll('search_type').length !== 1 || u.searchParams.get('search_type') !== 'region' ||
          u.searchParams.getAll('search_id').length !== 1 || !/^\d{1,20}$/.test(u.searchParams.get('search_id'))) throw new Error('다방 동별 범위를 확인해 주세요.');
      u.hostname = 'www.dabangapp.com'; u.searchParams.sort();
      unique.set(u.searchParams.get('search_id'), { kind: 'dabang-region', name: value.name.trim().normalize('NFC'), dong: value.dong.trim().normalize('NFC'), url: u.href });
    }
    return [...unique.values()];
  }
  function hasRegion(link) {
    const u = new URL(link.url);
    if (link.id === 'zigbang') return /\/subways\/[^/]+\/items/.test(u.pathname);
    if (link.id === 'hogangnono') return /^\/apt\/[^/]+/.test(u.pathname);
    return true;
  }
  function usefulCapture(c) {
    try {
      const u = new URL(c.url);
      if (c.site === 'naver') return /\/(?:articleClusters|boundedArticles|clusteredArticles|legalDivisionArticleList)\/?$/.test(u.pathname);
      if (c.site === 'dabang') return u.pathname.includes('/room-list/');
      if (c.site === 'zigbang') return /\/items\/(list|subways\/[^/]+\/onerooms)$/.test(u.pathname) || u.pathname.endsWith('/common/subway/all');
      if (c.site === 'kbland') return u.pathname.endsWith('/stutCdFilter/count');
      if (c.site === 'hogangnono') return u.pathname.includes('/api/apt/');
      return false;
    } catch { return false; }
  }
  async function jobsFor(areas, chosen, runId, automatic = false, naverContext = null) {
    const got = await chrome.storage.local.get(['sites', 'hnw-stations']);
    const selected = SITES.filter((id) => chosen.includes(id) && hnwEnabled(got.sites, HNW_SITES.find((s) => s.id === id)));
    if (!selected.length) throw new Error('확장에서 켜 둔 사이트 중 조회할 곳을 골라 주세요.');
    if (automatic && chosen.some((id) => !selected.includes(id))) throw new Error('예약한 사이트가 확장에서 꺼져 있습니다. 사이트를 켠 뒤 다시 실행해 주세요.');
    const unique = new Map();
    for (const input of areas) {
      const area = areaFrom(input);
      if (!area || area.radiusM <= 0 || area.radiusM > 50000) throw new Error('지역 위치와 반경을 확인해 주세요.');
      // 네이버는 구나 동 전체를, 다른 사이트는 역 지역을 맡는다. 대시보드는 둘을 한 순회에 함께 보낼 수 있다.
      const areaSites=selected.filter(site=>input.region ? site==='naver' : site!=='naver');
      if(!areaSites.length)throw new Error(automatic ? '선택한 사이트와 예약 지역의 범위가 다릅니다.' : '네이버는 구나 동 지역을, 다른 사이트는 역 지역을 조회합니다. 지역과 사이트 선택을 확인해 주세요.');
      area.browseSites=areaSites;
      area.dabangRegions = dabangRegions(input.dabangRegions);
      if (areaSites.includes('naver') && (!input.region || input.purpose === 'alert' || !['gu','dong'].includes(input.region.kind))) throw new Error('네이버는 수집할 구나 동을 선택해 주세요.');
      if (areaSites.includes('naver') && input.region && input.purpose !== 'alert') {
        const code = input.region.code;
        area.region = {kind:input.region.kind,code,name:input.region.name || area.name};
        let pinnedContext=naverContext;
        if(automatic) {
          pinnedContext=HNW_NAVER_CONTEXT.read({pageUrl:input.naver?.url});
          const saved=HNW_NAVER_LEDGER.scope(input.naver?.scope);
          const targetCode=input.region.kind==='gu' && /^\d{5}$/.test(code) ? `${code}00000` : code;
          if(saved.code!==targetCode || saved.sort!==pinnedContext.sort || !saved.filter || !HNW_NAVER_LEDGER.matchesFilter(saved,pinnedContext.filter))throw new Error('예약에 저장한 네이버 범위와 필터가 다릅니다.');
        }
        area.naverContext=pinnedContext;
        area.naverScope = HNW_NAVER_LEDGER.scope({ kind: 'naver-region', code: input.region.kind === 'gu' && /^\d{5}$/.test(code) ? `${code}00000` : code, name: input.region.name || area.name,
          ...(pinnedContext ? {filter:pinnedContext.filter,sort:pinnedContext.sort} : {}) });
      }
      if (automatic && areaSites.includes('zigbang')) area.zigbangStation = pinnedZigbang(input.zigbangStation);
      unique.set(`${area.lat}|${area.lng}|${area.radiusM}|${JSON.stringify(area.dabangRegions)}|${JSON.stringify(area.zigbangStation)}|${JSON.stringify(area.naverScope)}`, area);
    }
    const jobs = [];
    for (const area of unique.values()) {
      for (const generated of hnwSiteLinks(area, got['hnw-stations']).filter((l) => area.browseSites.includes(l.id))) {
        const link = automatic && generated.id === 'zigbang' ? { ...generated, url: area.zigbangStation.url } : generated;
        if (link.id === 'naver' && area.naverScope) {
          if (!area.naverContext) throw new Error('현재 네이버 필터를 읽지 못했습니다. 무필터 수집은 시작하지 않았습니다.');
          const copied = HNW_NAVER_CONTEXT.forArea(area,area.naverContext,link.url);
          jobs.push({ id: `${runId}:${jobs.length}`, areaName: area.name, area, site: 'naver', siteName: link.name,
            url: copied.url, naverScope: copied.scope, status: 'pending', note: '현재 필터를 유지한 목록 조회 대기 중' });
          continue;
        }
        if (link.id === 'dabang' && area.dabangRegions.length) {
          for (const scope of area.dabangRegions) jobs.push({ id: `${runId}:${jobs.length}`, areaName: `${area.name} · ${scope.dong}`, area,
            site: link.id, siteName: `${link.name} 원/투룸`, url: scope.url, scope, status: 'pending', note: '선택한 동의 목록 조회 대기 중' });
          continue;
        }
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
  function isNaverMapTab(tab) {
    try { const url=new URL(tab?.url); return Number.isInteger(tab?.id) && tab.id>0 && url.origin==='https://fin.land.naver.com' && url.pathname.replace(/\/$/,'')==='/map'; } catch { return false; }
  }
  async function naverFilterTabs() {
    const [tabs,active]=await Promise.all([chrome.tabs.query({url:'https://fin.land.naver.com/map*'}),chrome.tabs.query({active:true,currentWindow:true})]);
    const activeId=active?.[0]?.id;
    return tabs.filter(isNaverMapTab).map(tab=>({id:tab.id,title:String(tab.title || '네이버 매물 지도').slice(0,160),active:tab.id===activeId}));
  }
  async function readNaverContext(tabId) {
    let tab;
    if(tabId!==undefined) {
      if(!Number.isInteger(tabId) || tabId<=0) throw new Error('필터를 읽을 네이버 탭을 선택해 주세요.');
      tab=await chrome.tabs.get(tabId).catch(()=>null);
      if(!tab)throw new Error('선택한 네이버 탭이 닫혔습니다. 탭 목록을 다시 불러와 주세요.');
    } else tab=(await chrome.tabs.query({active:true,currentWindow:true}))?.[0];
    if (!isNaverMapTab(tab)) throw new Error('현재 탭에서는 네이버 필터를 읽을 수 없습니다. 필터를 적용한 네이버 매물 탭을 선택해 주세요.');
    const context = HNW_NAVER_CONTEXT.read({pageUrl:tab.url});
    return {...context,tabId:tab.id};
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
      if (!job || job.status !== 'running' || job !== state.jobs[state.index] || sender.tab?.id !== state.tabId || sender.frameId !== 0 || message.documentToken !== job.documentToken ||
          (job.documentId && sender.documentId !== job.documentId)) return true;
      const c = message.capture;
      if (!c || c.site !== job.site || !samePage(job.url, c.pageUrl) || typeof c.body !== 'string' || c.body.length > 2000000) return true;
      if (!usefulCapture(c)) return true;
      if (job.naverScope?.filter) {
        if (!HNW_NAVER_LEDGER.endpoint(c.url)) return true;
        let matches = false;
        try { matches = HNW_NAVER_LEDGER.matchesFilter(job.naverScope,JSON.parse(c.requestBody).filter); } catch { /* Reject an unverified filter. */ }
        if (!matches) {
          job.blocked = job.note = '새 창의 필터가 선택한 조건과 다릅니다. 무필터 수집은 중단했습니다.';
          phase(state,'error',job.note,'error'); await save(state); schedule(); return true;
        }
      }
      if ((await keys()).length >= 200) {
        job.captureGap = true;
        state.status = 'paused'; job.blocked = '미전송 응답이 많아 수신을 멈췄습니다. 서버 연결을 복구한 뒤 미확인 재시도를 눌러 주세요.';
        job.note = job.blocked;
        phase(state, 'paused', job.note, 'pause');
        await save(state);
        return true;
      }
      const batchId = crypto.randomUUID();
      await chrome.storage.local.set({ [`${OUTBOX}${Date.now()}:${batchId}`]: { jobId: job.id, batchId, captures: [c], ...(job.scope ? { scope: job.scope } : {}), ...(job.naverScope ? { naverScope: job.naverScope } : {}) } });
      job.lastCaptureAt = Date.now();
      if (job.naverScope && HNW_NAVER_LEDGER.endpoint(c.url)) {
        job.naverCursorLedger ||= HNW_NAVER_LEDGER.create(job.naverScope);
        HNW_NAVER_LEDGER.accept(job.naverCursorLedger, c);
        if (job.naverCursorLedger.invalid) job.blocked ||= `구·동 목록 확인을 멈췄습니다 (${job.naverCursorLedger.invalid}). 받은 목록은 저장합니다.`;
        else {
          job.naverTemplate ||= JSON.parse(c.requestBody);
          job.naverListAt = Date.now();
          // A received page (including an idempotent replay) resolves only its own request.
          if (job.naverAwaiting?.cursor === JSON.stringify(JSON.parse(c.requestBody).articlePagingRequest.lastInfo)) job.naverAwaiting = null;
        }
      }
      job.received = (job.received || 0) + 1;
      record(state, 'received', job, { responses: job.received });
      if ([401, 403, 429].includes(c.status)) job.blocked = `사이트가 요청을 거절했습니다(HTTP ${c.status}). 직접 확인이 필요합니다.`;
      await save(state);
      await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
      schedule(job.naverScope ? 0 : 3000);
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
      if (job) {
        job.receipt = receipt;
        if (job.naverScope && !job.naverCursorLedger?.ended) paceNaverPage(job,receipt.naverCoverage?.pages || job.naverCursorLedger?.pages);
      }
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
  async function naverNextPage(state, job) {
    const ledger = job.naverCursorLedger;
    if (!ledger?.pages) return false;
    const local = HNW_NAVER_LEDGER.coverage(ledger);
    if (ledger.ended) {
      const stored = job.receipt?.naverCoverage;
      if (!job.captureGap && local.complete && stored?.complete && stored.code === job.naverScope.code &&
          stored.pages === local.pages && stored.total === local.total && stored.stored === local.received) {
        await finishJob(state, 'complete', `선택한 지역과 필터의 목록 ${stored.pages}페이지, 매물 ${stored.stored}건의 서버 저장을 확인했습니다.`);
      } else {
        job.completionWaitAt ||= Date.now();
        if (Date.now() - job.completionWaitAt >= 15000) await finishJob(state, 'partial', `마지막 페이지를 받았지만 수신 ${local.received}/${local.total}건과 서버 저장 확인이 일치하지 않습니다.`);
        else { job.note = '마지막 페이지를 받았습니다. 선택한 조건의 목록과 서버 저장을 대조하는 중입니다.'; phase(state, 'saving', job.note); await save(state); }
      }
      schedule(); return true;
    }
    if (job.naverAwaiting) {
      if (Date.now() - job.naverAwaiting.at >= 20000) await finishJob(state, 'partial', '다음 페이지의 수신·저장 응답을 확인하지 못했습니다. 받은 자료는 보관했습니다.');
      else { job.note = `${ledger.pages}페이지 · ${local.received}/${local.total}건 수신, 다음 페이지 응답을 기다리는 중`; phase(state, 'waiting', job.note); await save(state); }
      schedule(); return true;
    }
    const request = HNW_NAVER_LEDGER.nextRequest(ledger, job.naverTemplate);
    if (!request) { await finishJob(state, 'needs-input', '다음 페이지의 조회 범위와 페이지 정보를 확인하지 못했습니다.'); schedule(); return true; }
    paceNaverPage(job,ledger.pages);
    const remaining=job.naverNextAt-Date.now();
    if (remaining>0) {
      job.note=`${ledger.pages}페이지 저장 확인, 다음 페이지까지 ${(job.naverDelayMs/1000).toFixed(1)}초 대기`;
      phase(state,'waiting',job.note,'waiting'); await save(state); schedule(remaining); return true;
    }
    job.naverAwaiting = { at: Date.now(), cursor: JSON.stringify(ledger.next) };
    job.actions++; job.lastActionAt = Date.now(); job.idle = 0;
    job.note = `${ledger.pages}페이지 · ${local.received}/${local.total}건 수신, ${ledger.pages + 1}페이지를 요청하는 중`;
    phase(state, 'exploring', job.note); record(state, 'action', job, { actions: job.actions }); await save(state);
    let response;
    try {
      const executed = await Promise.race([chrome.scripting.executeScript({
        target: { tabId: state.tabId, ...(job.documentId ? { documentIds: [job.documentId] } : { frameIds: [0] }) },
        world: 'MAIN', func: hnwFetchNaverPage, args: [JSON.stringify(request)],
      }), new Promise(resolve => setTimeout(() => resolve(null), 20000))]);
      response = executed?.[0]?.result;
    } catch { response = { error: 'request-failed' }; }
    if (!response || response.error || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300 || !response.json) {
      job.blocked = response?.error === 'page-security-check' ? '보안 확인 또는 로그인이 필요한 화면입니다. 자동 요청을 중단했습니다.'
        : response?.status ? `다음 페이지 요청을 확인하지 못했습니다 (HTTP ${response.status}). 자동 요청을 중단했습니다.` : '다음 페이지 요청을 실행하지 못했습니다. 자동 요청을 중단했습니다.';
    }
    await save(state); schedule(); return true;
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
        const win = await chrome.windows.create({ url: 'about:blank', focused: !state.automaticRequestId });
        state.tabId = win.tabs?.[0]?.id;
        if (state.tabId == null) throw new Error('조회 탭을 만들지 못했습니다.');
      } else {
        try { await chrome.tabs.get(state.tabId); } catch {
          state.tabId = null; state.status = 'paused'; job.note = '조회 창이 닫혔습니다. 이어하기를 누르면 새 창에서 계속합니다.'; phase(state, 'paused', job.note, 'pause'); await save(state); return;
        }
      }
      Object.assign(job, { status: 'running', note: '페이지를 여는 중', startedAt: Date.now(), lastCaptureAt: 0, lastActionAt: 0, settlingAt: 0, completionWaitAt: 0, loadedAt: 0, actions: 0, idle: 0, documentToken: null, documentId: null, blocked: null });
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
    const scopedDabang = job.site === 'dabang' && job.scope?.kind === 'dabang-region';
    const stationZigbang = job.site === 'zigbang' && !!zigbangStation(job.url);
    const bounded = job.naverScope ? age >= 14400000 || job.actions >= 10000 : scopedDabang || stationZigbang ? age >= 1800000 || job.actions >= 2000 : age >= 120000 || job.actions >= 40;
    if (!bounded && job.naverScope && await naverNextPage(state, job)) return;
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
        chrome.tabs.sendMessage(state.tabId, { type: 'browse-step', jobId: job.id, site: job.site, ...(job.scope ? { scope: job.scope } : {}), ...(job.naverScope ? { naverScope: job.naverScope } : {}) }, job.documentId ? { documentId: job.documentId } : { frameId: 0 }),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
    } catch { result = null; }
    if (!result) {
      await finishJob(state, 'failed', '페이지 탐색 스크립트가 답하지 않습니다. 확장과 페이지를 새로고침해 주세요.'); schedule(); return;
    }
    job.note = String(result.note || '응답 확인 중').slice(0, 300);
    if (job.naverScope && result.kind === 'complete') {
      const page = result.naverCoverage, stored = job.receipt?.naverCoverage;
      if (!job.captureGap && page?.complete && stored?.complete && page.code === job.naverScope.code && stored.code === page.code && page.total === stored.total && page.received === stored.stored && page.pages === stored.pages) {
        await finishJob(state, 'complete', `선택한 지역과 필터의 목록 ${stored.pages}페이지, 매물 ${stored.stored}건의 서버 저장을 확인했습니다.`);
        schedule(); return;
      }
      job.completionWaitAt ||= Date.now();
      result = { kind: 'idle', waiting: Date.now() - job.completionWaitAt < 15000 };
      job.note = '구·동 목록의 마지막 페이지와 서버 저장 확인을 기다립니다.';
    }
    if (scopedDabang && result.kind === 'complete') {
      // A page's last-page claim is insufficient: its durable server receipt must agree.
      if (job.receipt?.coverage?.complete === true && !job.captureGap) {
        await finishJob(state, 'complete', `선택한 동의 현재 원/투룸 필터 목록 ${job.receipt.coverage.pages}페이지 저장을 확인했습니다. 중복 없는 매물 ${job.receipt.uniqueListings}건입니다.`);
        schedule(); return;
      }
      job.completionWaitAt ||= Date.now();
      result = { kind: 'idle', waiting: Date.now() - job.completionWaitAt < 15000 };
      job.note = '목록의 마지막 페이지를 확인했습니다. 전체 페이지와 매물의 서버 저장 확인을 기다립니다.';
    }
    if (stationZigbang && result.kind === 'complete') {
      if (verifiedZigbang(job, result.zigbangCoverage)) {
        const coverage = job.receipt.zigbangCoverage;
        await finishJob(state, 'complete', `역 1km 원룸 목록 ${coverage.total}건의 상세정보를 확인했습니다. 저장 ${coverage.stored}건${coverage.excluded ? `, 설정한 지역 범위 밖 제외 ${coverage.excluded}건` : ''}입니다.`);
        schedule(); return;
      }
      job.completionWaitAt ||= Date.now();
      result = { kind: 'idle', waiting: Date.now() - job.completionWaitAt < 15000 };
      job.note = '역 1km 목록의 상세정보를 확인했습니다. 서버의 매물별 저장·범위 제외 확인을 기다립니다.';
    }
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
  async function command(message, automaticRequestId = null) {
    let state = await read();
    let replacedReport = null;
    if (message.command === 'start') {
      if (state?.status === 'running') throw new Error('이미 지역 순회가 진행 중입니다.');
      if ((await keys()).length && state?.status === 'paused' && message.sites?.includes('naver') && state.jobs?.some(job=>job.site==='naver'&&!job.naverScope?.filter)) await flushOutbox(state);
      if ((await keys()).length) throw new Error('보관 중인 응답이 있습니다. 이어하기로 먼저 저장해 주세요.');
      if (!Array.isArray(message.areas) || !message.areas.length || message.areas.length > 100) throw new Error('조회할 지역을 1~100곳 골라 주세요.');
      const id = automaticRequestId || crypto.randomUUID();
      const chosen = Array.isArray(message.sites) ? message.sites : ['naver', 'dabang', 'zigbang'];
      if (state?.automaticRequestId && state.status === 'paused') {
        replacedReport = automaticReport(state, 'failed');
      }
      state = { id, status: 'running', jobs: [], index: 0, createdAt: Date.now(), updatedAt: Date.now(), tabId: null, logs: [],
        ...(automaticRequestId ? { automaticRequestId } : {}) };
      record(state, 'start');
      phase(state, 'preparing', '서버에서 지역 바로가기 정보를 확인합니다. 최대 5초까지 기다립니다.', 'hints');
      // 이전 예약의 종료 보고와 새 수동 상태를 한 번에 저장한다.
      await save(state, replacedReport);
      try {
        await refreshHints();
        const naverContext = chosen.includes('naver') && !automaticRequestId ? await readNaverContext(message.naverSourceTabId) : null;
        if (naverContext && message.naverFilterKey && message.naverFilterKey !== naverContext.key) throw new Error('필터가 미리보기와 달라졌습니다. 현재 필터를 다시 읽은 뒤 시작해 주세요.');
        state.jobs = await jobsFor(message.areas, chosen, id, !!automaticRequestId,naverContext);
        phase(state, 'opening', '조회할 지역과 사이트 목록을 준비했습니다. 전용 탭을 여는 중입니다.', 'ready');
      } catch (error) {
        state.status = automaticRequestId ? 'done' : 'paused';
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
      if (state.jobs.some(job=>job.site==='naver'&&!job.naverScope?.filter)) throw new Error('이전 조회에는 필터가 저장되지 않았습니다. 현재 필터로 새 수집을 시작해 주세요.');
      if (message.command === 'retry') {
        if ((await keys()).length) throw new Error('보관된 응답부터 이어하기로 저장해 주세요.');
        await refreshHints();
        // 수동 재시도는 새 조회다. 이전 예약 회차의 저장 확인을 재사용하지 않는다.
        if (state.automaticRequestId) {
          replacedReport = automaticReport(state, state.status === 'paused' ? 'failed' : 'done');
          delete state.automaticRequestId;
          state.id = crypto.randomUUID();
        }
        const got = await chrome.storage.local.get('hnw-stations');
        for (const job of state.jobs) {
          if (!['failed', 'partial', 'needs-input'].includes(job.status)) continue;
          const link = job.naverScope ? { id: 'naver', url: job.url } : job.scope ? { id: 'dabang', url: job.scope.url } : hnwSiteLinks(job.area, got['hnw-stations']).find((l) => l.id === job.site);
          if (!link || !hasRegion(link)) continue;
          Object.assign(job, { id: crypto.randomUUID(), url: link.url, status: 'pending', note: '재시도 대기', receipt: undefined, received: 0,
            captureGap: false, completionWaitAt: 0, waitNote: null, naverCursorLedger: null, naverTemplate: null, naverAwaiting: null, naverListAt: 0,
            naverDelayPage: 0, naverDelayMs: 0, naverNextAt: 0 });
        }
        state.index = 0;
      }
      // Reloading a region starts a new vendor seed. Preserve completed regions,
      // but never mix the resumed region's new pages into its old cursor ledger.
      if (message.command === 'resume' && state.jobs.some(job => job.status === 'running' && job.naverScope)) {
        if (!(await flushOutbox(state))) throw new Error('보관 중인 응답을 먼저 저장하고 다시 이어하기를 눌러 주세요.');
        for (const job of state.jobs) if (job.status === 'running' && job.naverScope) {
          Object.assign(job, { id: crypto.randomUUID(), receipt: undefined, received: 0, captureGap: false, completionWaitAt: 0, waitNote: null, naverCursorLedger: null, naverTemplate: null, naverAwaiting: null, naverListAt: 0,
            naverDelayPage: 0, naverDelayMs: 0, naverNextAt: 0 });
        }
      }
      for (const job of state.jobs) if (job.status === 'running') job.status = 'pending';
      if (state.tabId != null) {
        try { await chrome.tabs.get(state.tabId); } catch { state.tabId = null; }
      }
      state.status = 'running';
      phase(state, 'opening', message.command === 'retry' ? '미확인 작업을 다시 준비했습니다.' : '중단한 조회를 이어갑니다.', message.command === 'retry' ? 'retry' : 'resume');
    } else throw new Error('알 수 없는 순회 명령입니다.');
    if (state) {
      await save(state, replacedReport);
      if (state.status === 'running') {
        await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
        schedule();
      }
    }
    return state;
  }
  async function automaticReady() {
    const state = await read();
    return !['running', 'paused'].includes(state?.status) && !(await keys()).length;
  }
  async function startAutomatic(request) {
    return locked(async () => {
      if (!request || typeof request.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(request.id) ||
          !Array.isArray(request.sites) || !request.sites.length || request.sites.length > 3 ||
          new Set(request.sites).size !== request.sites.length || request.sites.some((s) => !['dabang', 'zigbang', 'naver'].includes(s)) ||
          !Array.isArray(request.areas) || !request.areas.length || request.areas.length > 100 ||
          request.areas.some((a) => !a || !a.region && request.sites.includes('dabang') && (!Array.isArray(a.dabangRegions) || !a.dabangRegions.length))) throw new Error('invalid automatic request');
      if (request.sites.includes('zigbang')) for (const area of request.areas.filter(a=>!a.region)) pinnedZigbang(area.zigbangStation);
      const existing = await read();
      if (existing?.id === request.id && existing.automaticRequestId === request.id) return existing;
      const started = (await chrome.storage.local.get(AUTO_STARTED))[AUTO_STARTED];
      if (started === request.id) throw Object.assign(new Error('automatic request already consumed'), { code: 'consumed' });
      if (!(await automaticReady())) throw Object.assign(new Error('another tour needs attention'), { code: 'busy' });
      // 먼저 실행 식별자를 남긴다. 중간에 워커가 종료되면 재실행 대신 확인 필요로 보고한다.
      await chrome.storage.local.set({ [AUTO_STARTED]: request.id });
      return command({ command: 'start', areas: request.areas, sites: request.sites }, request.id);
    });
  }
  async function message(input, sender) {
    if(input.type==='naver-preset-save') {
      if(!isPopup(sender) && !isDashboard(sender))throw new Error('대시보드나 확장 팝업에서 조건을 저장해 주세요.');
      const current=await readNaverContext(input.tabId);
      if(current.key!==input.filterKey)throw new Error('필터가 미리보기와 달라졌습니다. 다시 읽은 뒤 저장해 주세요.');
      return postJson('/api/browse/naver-preset',{pageUrl:current.pageUrl,areaIds:input.areaIds},'PUT',5000);
    }
    if (input.type === 'naver-filter-tabs') {
      if (!isPopup(sender) && !isDashboard(sender)) throw new Error('대시보드나 확장 팝업에서 네이버 탭을 선택해 주세요.');
      return {tabs:await naverFilterTabs()};
    }
    if (input.type === 'naver-filter-state') {
      if (!isPopup(sender) && !isDashboard(sender)) throw new Error('대시보드나 확장 팝업에서 필터를 확인해 주세요.');
      const context=await readNaverContext(input.tabId);
      // 대시보드에는 미리보기 문구와 시작 때 대조할 키만 넘긴다. 탭 주소와 원래 필터는 확장 안에 둔다.
      return {context:isPopup(sender) ? context : {key:context.key,tabId:context.tabId,conditions:HNW_NAVER_LEDGER.conditions(context.filter)}};
    }
    // 상태 읽기는 저장/페이지 요청 뒤에 줄 세우지 않는다. 저장소의 마지막 확정 상태를 즉시 돌려준다.
    if (input.type === 'browse-status') {
      if (!isDashboard(sender) && !isPopup(sender)) throw new Error('대시보드 또는 확장 팝업에서만 지역 순회를 조작할 수 있습니다.');
      return { state: await read() };
    }
    return locked(async () => {
      if (input.type === 'browse-context') return context(input, sender);
      if (!isDashboard(sender) && !isPopup(sender)) throw new Error('대시보드 또는 확장 팝업에서만 지역 순회를 조작할 수 있습니다.');
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
  return { message, capture, tick, read, ownsTab, samePage, hasRegion, recover, diagnostic, startAutomatic, automaticReady };
})();
