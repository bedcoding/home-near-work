// 지역 순회 전용 페이지 조작. 요청 한 번에 매물 목록의 읽기 조작 하나만 한다.
// 페이지가 받은 매물 번호/제목으로 확인한 목록만 내리고, 지도 이동, 필터 변경, 연락, 찜, 로그인은 하지 않는다.
(() => {
  if (globalThis.__hnwBrowsePage) return;
  globalThis.__hnwBrowsePage = true;
  const SITE = typeof HNW_SITE !== 'undefined' && HNW_SITE ? HNW_SITE.id : null;
  const BUBBLE = 'button[data-nlogs-area="pin*art.bubble"], button[class*="BubbleMarker"]';
  const SUPPORTED = ['naver', 'dabang', 'zigbang'];
  const MAX_ACTIONS = 40;
  const ids = new Set();
  const titles = new Set();
  const complexes = new Set();
  let responseVersion = 0;
  let responseAt = 0;
  let lastCluster = null;
  let job = null;
  const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const result = (kind, note, waiting = false) => ({ kind, note, waiting });

  function reset(id) {
    job = { id, actions: 0, visited: new Set(), active: null, lastMore: null, stable: null };
  }

  function visible(el, inViewport = true) {
    if (!el || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (!inViewport || (r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth));
  }

  function canClick(el) {
    if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
    const top = document.elementFromPoint(x, y);
    return !!top && (top === el || el.contains(top));
  }

  function blocked() {
    for (const el of document.querySelectorAll('iframe[src*="captcha"], iframe[title*="challenge"], [id="captcha"], [id="challenge-form"]')) {
      const r = el.getBoundingClientRect();
      if (visible(el) && r.width >= 150 && r.height >= 70) return '보안 확인 화면이 있어 직접 확인이 필요합니다';
    }
    const denial = /접근[이을 ]*(?:제한|차단)|비정상적인?\s*(?:접근|요청)|자동(?:입력|접속)\s*방지|로봇이\s*아닙니다|access denied|verify (?:that )?you are human|403\s*forbidden/i;
    const login = /로그인(?:이|을)?\s*(?:필요|해\s*주세요|후)|로그인해야|sign in to continue/i;
    for (const el of document.querySelectorAll('h1, h2, [role="alert"], [role="dialog"], dialog[open], form')) {
      if (!visible(el)) continue;
      const text = tidy(el.innerText || el.textContent);
      if (text.length > 2500) continue;
      if (denial.test(text)) return '접근 제한 또는 보안 확인 화면이 있어 직접 확인이 필요합니다';
      if (login.test(text)) return '로그인이 필요한 화면입니다';
    }
    // 오류 화면이 일반 div만으로 만들어진 경우. 정상 페이지의 안내/약관 문구는 읽지 않는다.
    const bodyText = tidy(document.body?.innerText);
    if (bodyText.length < 600 && denial.test(bodyText)) return '접근 제한 또는 보안 확인 화면이 있어 직접 확인이 필요합니다';
    return null;
  }

  // MAIN world hook이 전달한 동일 창, 동일 출처 응답만 이용한다. 개인 정보 응답은 기존 hook에서 제외한다.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.__hnw !== 'capture') return;
    const c = event.data;
    if (!Number.isFinite(c.status) || c.status < 200 || c.status >= 300 || typeof c.body !== 'string') return;
    try {
      const u = new URL(c.url, location.href);
      const host = SITE === 'naver' ? 'land.naver.com' : SITE === 'dabang' ? 'dabangapp.com' : SITE === 'zigbang' ? 'zigbang.com' : '';
      if (!host || (u.hostname !== host && !u.hostname.endsWith(`.${host}`))) return;
      const data = JSON.parse(c.body);
      let rows;
      if (SITE === 'naver' && /Articles$/.test(u.pathname) && Array.isArray(data?.result?.list)) {
        const req = typeof c.requestBody === 'string' ? JSON.parse(c.requestBody) : null;
        const cluster = typeof req?.clusterId === 'string' ? req.clusterId : null;
        if (cluster !== lastCluster) { ids.clear(); titles.clear(); complexes.clear(); }
        lastCluster = cluster;
        rows = data.result.list.map((x) => x?.representativeArticleInfo).filter(Boolean);
        for (const x of rows) {
          if (x.articleNumber != null) ids.add(String(x.articleNumber));
          if (x.complexNumber != null) complexes.add(String(x.complexNumber));
        }
        if (job?.active) {
          job.active.received = true;
          job.active.items += data.result.list.length;
        }
      } else if (SITE === 'dabang' && u.pathname.includes('/room-list/') && Array.isArray(data?.result?.roomList)) {
        rows = [...data.result.roomList, ...(data.result.premiumList || []).flatMap((p) => Array.isArray(p?.roomList) ? p.roomList : [])];
        for (const x of rows) {
          if (x?.seq != null) ids.add(String(x.seq));
          if (typeof x?.roomTitle === 'string' && tidy(x.roomTitle).length >= 4) titles.add(tidy(x.roomTitle));
        }
      } else if (SITE === 'zigbang' && /\/items\/list$/.test(u.pathname) && Array.isArray(data?.items)) {
        rows = data.items;
        for (const x of rows) {
          if (x?.item_id != null) ids.add(String(x.item_id));
          if (typeof x?.title === 'string' && tidy(x.title).length >= 4) titles.add(tidy(x.title));
        }
      }
      if (!rows) return;
      responseVersion += 1;
      responseAt = Date.now();
      // 한 페이지에서 무한히 커지지 않게 제한한다. 모르는 카드는 조작하지 않는다.
      while (ids.size > 5000) ids.delete(ids.values().next().value);
      while (titles.size > 1000) titles.delete(titles.values().next().value);
    } catch { /* 모양이 다른 응답으로는 조작 대상을 만들지 않는다. */ }
  });

  function listingElements() {
    const out = [];
    for (const a of [...document.querySelectorAll('a[href]')].slice(0, 3000)) {
      try {
        const u = new URL(a.getAttribute('href'), location.href);
        if (u.origin !== location.origin) continue;
        const segments = u.pathname.split('/').filter(Boolean);
        const last = segments[segments.length - 1];
        const isListing = ids.has(last) && /(?:articles?|items?|rooms?)\//i.test(u.pathname);
        const isComplexList = SITE === 'naver' && complexes.has(last) && /\/complexes\//.test(u.pathname) && u.searchParams.get('tab') === 'article';
        if ((isListing || isComplexList) && visible(a, false)) out.push(a);
      } catch { /* 잘못된 주소는 무시한다. */ }
    }
    // 링크가 없는 카드도 응답의 매물 번호나 제목+가격이 일치할 때만 목록으로 인정한다.
    const cards = '[data-room-id], [data-item-id], [data-article-id], [role="listitem"], li, article'
      + (SITE === 'zigbang' ? ', [id="animatedComponent"]' : '');
    for (const el of [...document.querySelectorAll(cards)].slice(0, 3000)) {
      if (!visible(el, false)) continue;
      const id = el.getAttribute('data-room-id') || el.getAttribute('data-item-id') || el.getAttribute('data-article-id');
      const text = tidy(el.innerText || el.textContent);
      const titleMatch = titles.size && text.length < 1500 && /(?:월세|전세|매매)\s*[\d,]/.test(text) && [...titles].some((title) => text.includes(title));
      if ((id && ids.has(id)) || titleMatch) out.push(el);
    }
    return [...new Set(out)];
  }

  function listContainer() {
    const candidates = new Map();
    for (const item of listingElements()) {
      let el = item.parentElement;
      for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
        if (el === document.body || el === document.documentElement) break;
        if (el.closest('nav, header, [role="dialog"], dialog')) break;
        const style = getComputedStyle(el);
        if (visible(el) && /(auto|scroll)/.test(style.overflowY) && el.clientHeight >= 80) {
          candidates.set(el, (candidates.get(el) || 0) + 1);
          break;
        }
      }
    }
    return [...candidates].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  function act(note, fn) {
    fn();
    job.actions++;
    job.stable = null;
    return result('action', note);
  }

  function scrollList() {
    const box = listContainer();
    if (!box) return result('idle', '응답과 일치하는 매물 목록의 스크롤 영역을 확인하지 못했습니다');
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    if (box.scrollTop < max - 3) {
      const next = Math.min(max, box.scrollTop + Math.max(120, Math.round(box.clientHeight * 0.8)));
      return act('매물 목록을 아래로 확인하는 중', () => box.scrollTo({ top: next, behavior: 'instant' }));
    }
    for (const button of box.querySelectorAll('button, [role="button"]')) {
      // 확인한 목록 안의 짧고 명시적인 페이지 버튼만 클릭한다.
      const label = tidy(button.getAttribute('aria-label') || button.innerText || button.textContent);
      if (!/^(?:(?:매물|방|목록)\s*)?(?:더\s*보기|다음(?:\s*페이지)?)$/.test(label) || !canClick(button)) continue;
      if (job.lastMore?.button === button && job.lastMore.version === responseVersion) {
        return result('idle', '추가 목록 응답을 기다리는 중', Date.now() - job.lastMore.at < 12000);
      }
      return act('매물 목록의 다음 부분을 여는 중', () => {
        job.lastMore = { button, version: responseVersion, at: Date.now() };
        button.click();
      });
    }
    const signature = `${responseVersion}:${box.scrollHeight}:${box.scrollTop}`;
    if (!job.stable || job.stable.signature !== signature) job.stable = { signature, since: Date.now() };
    if (Date.now() - Math.max(job.stable.since, responseAt) < 5000) return result('idle', '목록 끝에서 추가 응답을 기다리는 중', true);
    return result('idle', '현재 목록 끝까지 확인했습니다. 전체 매물 수집 여부는 별도 확인이 필요합니다');
  }

  function bubbleKey(el) {
    const id = el.getAttribute('data-cluster-id') || el.getAttribute('data-marker-id');
    if (id) return id;
    const r = el.getBoundingClientRect();
    return `${Math.round(r.left)}:${Math.round(r.top)}:${tidy(el.textContent)}`;
  }

  function step(message) {
    if (message.site !== SITE) return result('unsupported', '이 사이트는 화면 확인만 지원합니다');
    if (typeof message.jobId !== 'string' || !message.jobId || message.jobId.length > 120) return result('unsupported', '조회 작업을 확인할 수 없습니다');
    if (!job || job.id !== message.jobId) reset(message.jobId);
    const reason = blocked();
    if (reason) return result('blocked', reason);
    if (!SUPPORTED.includes(SITE)) return result('unsupported', '이 사이트는 화면 확인만 지원합니다');
    if (job.actions >= MAX_ACTIONS) return result('idle', '한 페이지의 자동 탐색 한도에 도달했습니다. 일부만 확인했을 수 있습니다');
    if (SITE !== 'naver') return scrollList();

    if (job.active) {
      if (!job.active.received) return result('idle', '선택한 지도 묶음의 매물 목록 응답을 기다리는 중', Date.now() - job.active.at < 15000);
      if (!job.active.items) {
        // 정상적인 빈 응답에는 식별할 카드가 없다. 응답이 안정된 뒤 다음 묶음으로 간다.
        if (Date.now() - responseAt < 5000) return result('idle', '빈 목록의 추가 응답을 기다리는 중', true);
      } else {
        const scrolled = scrollList();
        if (scrolled.kind === 'action' || scrolled.waiting) return scrolled;
        // 목록 영역을 식별하지 못했으면 다른 묶음을 누르며 실패를 감추지 않는다.
        if (!job.stable) return scrolled;
      }
      job.visited.add(job.active.key);
      job.active = null;
      job.lastMore = null;
      job.stable = null;
    }
    const bubbles = [...document.querySelectorAll(BUBBLE)].filter(canClick);
    const next = bubbles.find((el) => !job.visited.has(bubbleKey(el)));
    if (!next) return result('idle', bubbles.length ? '화면에 보이는 지도 묶음 탐색을 마쳤습니다. 화면 밖은 확인하지 않았습니다' : '눌러 볼 지도 묶음을 확인하지 못했습니다');
    return act('지도 묶음의 매물 목록을 여는 중', () => {
      job.active = { key: bubbleKey(next), received: false, items: 0, at: Date.now() };
      next.click();
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'browse-reset') {
      reset(typeof message.jobId === 'string' ? message.jobId : null);
      sendResponse(result('idle', '탐색 상태를 초기화했습니다'));
      return;
    }
    if (message?.type !== 'browse-step') return;
    try { sendResponse(step(message)); }
    catch { sendResponse(result('idle', '화면 구조가 달라 자동 탐색을 계속할 수 없습니다')); }
  });
})();
