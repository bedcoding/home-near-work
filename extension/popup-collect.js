(() => {
  const el = id => document.getElementById(`collect-${id}`);
  const STATE_KEY = 'hnw-browse-state', SELECTED_KEY = 'hnw-naver-selected';
  let areas = [], selected = new Set(), pending = false, state = null;
  let filterContext = null, reading = false, filterError = '';
  let sources = [], sourceId = null;
  const status = { running: '수집 중', paused: '수집 중단됨', done: '수집 종료' };
  const fail = message => { el('error').textContent = message; el('error').hidden = !message; };
  function paint() {
    const running = state?.status === 'running';
    el('start').disabled = pending || running || reading || !selected.size || !filterContext;
    el('preset-save').disabled = pending || running || reading || !selected.size || !filterContext;
    el('start').textContent = pending ? '요청 처리 중입니다' : running ? '수집 진행 중' : reading ? '필터 확인 중입니다' : !sourceId ? '네이버 탭 선택 후 수집 가능' : !filterContext ? '필터 확인 후 수집 가능' : !selected.size ? '수집할 지역을 선택하세요' : '현재 필터로 선택 지역 수집';
    el('source').disabled = pending || reading || running || !sources.length;
    el('source-refresh').disabled = pending || reading || running;
    el('filter-read').disabled = pending || reading || running || !sourceId;
    el('filter').textContent = reading ? '현재 네이버 필터를 읽는 중입니다.' : filterContext ? '선택한 탭의 주소에서 읽은 조건입니다. 수집 창의 첫 응답도 같은 조건인지 확인합니다.' : filterError || '필터를 적용한 네이버 탭에서 현재 필터를 읽어 주세요.';
    el('filter-conditions').hidden = !filterContext;
    el('filter-conditions').textContent = '';
    if (filterContext) for (const row of HNW_NAVER_LEDGER.conditions(filterContext.filter)) {
      const label=document.createElement('dt'),value=document.createElement('dd');
      label.textContent=row.label;value.textContent=row.value;el('filter-conditions').append(label,value);
    }
    for (const input of el('areas').querySelectorAll('input')) input.disabled = pending || running;
    const allJobs = state?.jobs || [];
    const jobs = allJobs.filter(j => j.site === 'naver' && j.naverScope?.kind === 'naver-region');
    el('progress').hidden = !jobs.length;
    el('empty').hidden = !!jobs.length;
    el('empty').textContent = running && !jobs.length ? '다른 사이트의 조회가 진행 중입니다. 네이버 수집은 해당 조회가 끝난 뒤 시작할 수 있습니다.'
      : '아직 네이버 구나 동 수집 기록이 없습니다. 위에서 지역을 선택하고 수집을 시작하세요.';
    if (!jobs.length) return;
    const pinned = jobs.every(job => !!job.naverScope.filter);
    const complete = jobs.filter(j => j.status === 'complete' && j.receipt?.naverCoverage?.complete === true).length;
    const ended = jobs.filter(j => !['running','pending'].includes(j.status)).length;
    const started = state.createdAt ? new Date(state.createdAt).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Seoul'}) : '';
    el('run').textContent = `${state.status === 'done' ? '최근 네이버 조회' : '네이버 조회'}${started ? ` ${started}` : ''}, ${jobs.map(j => j.areaName).join(', ')}`;
    el('state').textContent = `${status[state.status] || '상태 확인 필요'}, 완료 지역 ${complete}/${jobs.length}`;
    el('bar').max = Math.max(1, jobs.length); el('bar').value = ended;
    const total = jobs.reduce((sum,j) => sum + (j.receipt?.listings || 0), 0);
    const active = allJobs[state.index];
    const current = jobs.includes(active) ? active : null, proof = current?.receipt?.naverCoverage;
    el('counts').textContent = `응답 ${jobs.reduce((sum,j) => sum + (j.receipt?.responses || 0),0)}개, 저장 처리 ${total}건${proof ? `, 현재 ${proof.pages}페이지, ${proof.received}/${proof.total ?? '?'}건` : ''}`;
    el('detail').textContent = current ? `${current.areaName}, ${current.note || state.detail || '준비 중'}` : state.status === 'done' && complete < jobs.length ? '일부 확인 또는 실패한 지역이 있습니다. 로그를 확인하고 미확인 지역을 다시 수집하세요.' : state.detail || '';
    if (!pinned) el('detail').textContent = '이전 조회에는 필터가 저장되지 않았습니다. 현재 필터를 확인한 뒤 새 수집을 시작해 주세요.';
    else el('run').textContent += `, 저장한 필터: ${HNW_NAVER_LEDGER.summary(jobs[0].naverScope.filter)}`;
    el('results').textContent = '';
    for (const job of jobs) {
      const li = document.createElement('li'), coverage = job.receipt?.naverCoverage;
      li.textContent = `${job.areaName}, ${coverage ? `${coverage.pages}페이지, 수신 ${coverage.received}/${coverage.total ?? '?'}건, 저장 ${coverage.stored ?? '?'}건` : '목록 수신 대기'}, ${job.status === 'complete' && coverage?.complete ? '완료' : job.status === 'running' ? '조회 중' : job.status === 'pending' ? '대기' : '미확인'}`;
      el('results').appendChild(li);
    }
    el('pause').hidden = !running; el('resume').hidden = state.status !== 'paused' || !pinned;
    el('retry').hidden = running || !pinned || !jobs.some(j => ['partial','failed','needs-input'].includes(j.status));
    for (const id of ['pause','resume','retry']) el(id).disabled = pending;
    el('log').textContent = '';
    for (const event of [...(state.logs || [])].reverse().filter(event => event.site === 'naver' && jobs.includes(allJobs[event.jobIndex]) || event.jobIndex == null && jobs.length === allJobs.length).slice(0,12)) {
      const li = document.createElement('li'), job = allJobs[event.jobIndex];
      const label = {open:'페이지 열기',connected:'페이지 연결',received:'목록 수신',saved:'서버 저장 확인',action:'목록 탐색',waiting:'응답 대기','job-end':'지역 조회 종료',pause:'중단',done:'순회 종료',error:'오류'}[event.code] || event.code;
      li.textContent = `${new Date(event.at).toLocaleTimeString('ko-KR',{hour12:false})} ${job?.areaName || ''} ${label}${event.listings != null ? `, 저장 처리 ${event.listings}건` : ''}`;
      el('log').appendChild(li);
    }
  }
  async function loadAreas() {
    const got = await chrome.storage.local.get(SELECTED_KEY);
    areas = (await hnwReadAreas()).filter(a => a.enabled && a.purpose !== 'alert' && a.region);
    selected = new Set(areas.filter(a => !Array.isArray(got[SELECTED_KEY]) || got[SELECTED_KEY].includes(a.region.code)).map(a => a.region.code));
    el('areas').textContent = '';
    if (!areas.length) { el('areas').textContent = '대시보드의 수집 지역 관리에서 구나 동을 추가하세요.'; paint(); return; }
    for (const area of areas) {
      const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
      input.type = 'checkbox'; input.checked = selected.has(area.region.code); text.textContent = area.name;
      input.addEventListener('change', async () => {
        if (input.checked) selected.add(area.region.code); else selected.delete(area.region.code);
        await chrome.storage.local.set({[SELECTED_KEY]: [...selected]}); paint();
      });
      label.append(input,text); el('areas').appendChild(label);
    }
    paint();
  }
  async function send(command) {
    if (pending) return;
    if (command === 'start' && (!filterContext || !selected.size || reading || state?.status === 'running')) return;
    pending = true; fail(''); paint();
    try {
      const response = await chrome.runtime.sendMessage({ type:'browse-command', command,
        ...(command === 'start' ? {areas:areas.filter(a => selected.has(a.region.code)), sites:['naver'],naverFilterKey:filterContext.key,naverSourceTabId:sourceId} : {}) });
      if (!response || response.error) throw new Error(response?.error || '확장 실행 상태를 받지 못했습니다. 팝업을 다시 열어 주세요.');
      state = response.state;
    } catch(error) { fail(error.message); }
    finally { pending = false; paint(); }
  }
  async function workerMessage(message) {
    let timeout;
    try {
      return await Promise.race([chrome.runtime.sendMessage(message),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('확장 응답이 지연되고 있습니다. 팝업을 다시 열어 주세요.')),10000);})]);
    } finally { clearTimeout(timeout); }
  }
  async function loadSources() {
    if (pending || reading || state?.status === 'running') return;
    const previous=sourceId;
    reading=true;filterContext=null;filterError='';paint();
    try {
      const response=await workerMessage({type:'naver-filter-tabs'});
      if (!Array.isArray(response?.tabs) || response.error) throw new Error(response?.error || '네이버 탭 목록을 받지 못했습니다. 팝업을 다시 열어 주세요.');
      sources=response.tabs;
      sourceId=sources.some(tab=>tab.id===previous) ? previous : previous!=null ? null : sources.find(tab=>tab.active)?.id ?? (sources.length===1 ? sources[0].id : null);
      el('source').textContent='';
      const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=sources.length ? '필터를 적용한 탭을 선택하세요' : '열린 네이버 매물 탭이 없습니다';el('source').appendChild(placeholder);
      for(const tab of sources) {
        const option=document.createElement('option');option.value=String(tab.id);option.textContent=`${tab.title}${tab.active ? ' (현재 탭)' : ''}`;el('source').appendChild(option);
      }
      el('source').value=sourceId==null ? '' : String(sourceId);
      if(!sourceId)filterError=sources.length ? '필터를 적용한 네이버 탭을 위에서 선택해 주세요.' : '네이버 지도를 열고 구나 동 매물 목록에 필터를 적용한 뒤 탭 목록을 새로고침해 주세요.';
    } catch(error) { sources=[];sourceId=null;filterError=error.message; }
    finally { reading=false;paint(); }
    if(sourceId)await readFilter();
  }
  async function readFilter() {
    if (!sourceId || pending || reading || state?.status === 'running') return;
    reading = true; filterContext = null; filterError = ''; paint();
    try {
      const response = await workerMessage({type:'naver-filter-state',tabId:sourceId});
      if (!response?.context?.filter || response.error) throw new Error(response?.error || '필터를 받지 못했습니다. 네이버 탭을 새로고침한 뒤 다시 읽어 주세요.');
      filterContext = response.context;
    } catch(error) { filterError = error.message; }
    finally { reading = false; paint(); }
  }
  el('source').addEventListener('change',()=>{
    if (pending || reading || state?.status === 'running') return;
    const id=Number(el('source').value);sourceId=sources.some(tab=>tab.id===id) ? id : null;
    filterContext=null;filterError=sourceId ? '' : '필터를 적용한 네이버 탭을 위에서 선택해 주세요.';paint();
    if(sourceId)void readFilter();
  });
  el('source-refresh').addEventListener('click',()=>void loadSources());
  el('preset-save').addEventListener('click',async()=>{
    if(pending || reading || !filterContext || !selected.size || state?.status==='running')return;
    pending=true;fail('');el('preset-notice').hidden=true;paint();
    try {
      const response=await workerMessage({type:'naver-preset-save',tabId:sourceId,filterKey:filterContext.key,areaIds:areas.filter(area=>selected.has(area.region.code)).map(area=>area.id)});
      if(!response?.preset || response.error)throw new Error(response?.error || '예약 조건 저장을 확인하지 못했습니다.');
      el('preset-notice').textContent='조건과 지역을 저장했습니다. 대시보드의 브라우저 예약 조회에서 네이버를 추가하고 예약을 켜세요.';el('preset-notice').hidden=false;
    }catch(error){fail(error.message);}finally{pending=false;paint();}
  });
  el('filter-read').addEventListener('click',()=>void readFilter());
  el('start').addEventListener('click', () => void send('start'));
  for (const command of ['pause','resume','retry']) el(command).addEventListener('click', () => void send(command));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STATE_KEY]) { state = changes[STATE_KEY].newValue || null; paint(); }
    if (changes['hnw-area-list']) void loadAreas();
  });
  void chrome.storage.local.get(STATE_KEY).then(got => { state = got[STATE_KEY] || null; paint(); });
  void loadAreas();
  void loadSources();
})();
