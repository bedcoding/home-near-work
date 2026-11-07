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
  // A document may receive an initial map response before its selected-region
  // response. Keep separate streams; never combine pages from different filters.
  const dabangStreams = new Map();
  let dabangLatest = null;
  let dabangLatestRegion = null;
  let zigbangLedger = null;
  const naverStreams = new Map();
  let responseVersion = 0;
  let responseAt = 0;
  let lastCluster = null;
  let job = null;
  const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const result = (kind, note, waiting = false) => ({ kind, note, waiting });

  function reset(id) {
    job = { id, startedAt: Date.now(), actions: 0, visited: new Set(), active: null, lastMore: null, stable: null };
  }

  function dabangScope(value) {
    if (value == null) return null;
    if (value.kind !== 'dabang-region' || typeof value.name !== 'string' || typeof value.dong !== 'string' ||
        !value.name.trim() || value.name.length > 120 || !value.dong.trim() || value.dong.length > 60) throw new Error('invalid scope');
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || !['www.dabangapp.com', 'dabangapp.com'].includes(url.hostname) ||
        url.port || url.username || url.password || url.hash || url.pathname !== '/map/onetwo' ||
        url.searchParams.getAll('search_type').length !== 1 || url.searchParams.get('search_type') !== 'region' ||
        url.searchParams.getAll('search_id').length !== 1 || !/^\d{1,20}$/.test(url.searchParams.get('search_id'))) throw new Error('invalid scope');
    return { id: url.searchParams.get('search_id'), name: value.name.trim().normalize('NFC'), dong: value.dong.trim().normalize('NFC') };
  }

  function sameDabangScope(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function isDabangScopePage(scope) {
    try {
      const current = dabangScope({ kind: 'dabang-region', name: scope.name, dong: scope.dong, url: location.href });
      return current.id === scope.id;
    } catch { return false; }
  }

  function dabangRequestKey(url) {
    // A region query is fixed by code and filters. Resizing its map changes the
    // viewport parameters without changing the selected region's list.
    const ignored = isDabangRegionUrl(url) ? ['page', 'bbox', 'zoom', 'useMap'] : ['page'];
    const query = [...url.searchParams].filter(([key]) => !ignored.includes(key)).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    return `${url.origin}${url.pathname}?${new URLSearchParams(query)}`;
  }

  function isDabangRegionUrl(url) {
    return url.protocol === 'https:' && ['www.dabangapp.com', 'dabangapp.com'].includes(url.hostname) &&
      !url.port && !url.username && !url.password && url.pathname === '/api/v5/room-list/category/one-two/region';
  }

  function dabangRegionProof(url, data) {
    const region = data.region;
    if (!isDabangRegionUrl(url) || url.searchParams.getAll('code').length !== 1 ||
        !/^\d{8}$/.test(url.searchParams.get('code') || '') || !region ||
        !Number.isSafeInteger(region.gid) || region.gid <= 0 || region.code !== url.searchParams.get('code') ||
        typeof region.name !== 'string' || !region.name.trim()) return null;
    return { id: String(region.gid), code: region.code, dong: region.name.trim().normalize('NFC') };
  }

  function matchesDabangStream(stream, scope) {
    return stream?.proof?.id === scope.id && stream.proof.dong === scope.dong;
  }

  function rememberDabangPage(url, data) {
    const metadataValid = Number.isSafeInteger(data.page) && data.page >= 1 && data.page <= 10000 &&
        Number.isSafeInteger(data.total) && data.total >= 0 && data.total <= 200000 &&
        Number.isSafeInteger(data.limit) && data.limit >= 1 && data.limit <= 1000 && typeof data.hasMore === 'boolean';
    if (!metadataValid && !isDabangRegionUrl(url)) return;
    const key = dabangRequestKey(url);
    let stream = dabangStreams.get(key);
    const proof = dabangRegionProof(url, data);
    if (!stream) {
      stream = { key, url: url.href, total: metadataValid ? data.total : null, limit: metadataValid ? data.limit : null,
        pages: new Map(), invalid: false, lastPage: null, proof };
      dabangStreams.set(key, stream);
      while (dabangStreams.size > 8) dabangStreams.delete(dabangStreams.keys().next().value);
    }
    dabangLatest = stream;
    if (isDabangRegionUrl(url)) dabangLatestRegion = stream;
    stream.at = Date.now();
    if (!metadataValid) { stream.invalid = true; return; }
    const rowIds = data.roomList.map((row) => row?.seq).filter((id) => Number.isSafeInteger(id) && id > 0).map(String);
    const signature = JSON.stringify([rowIds, proof ? data.roomList.map((row) => row.dongName ?? null) : []]);
    const prior = stream.pages.get(data.page);
    const requestPage = url.searchParams.get('page');
    const expectedPages = Math.max(1, Math.ceil(data.total / data.limit));
    const expectedRows = data.page < expectedPages ? data.limit : data.total - (expectedPages - 1) * data.limit;
    if (stream.total !== data.total || stream.limit !== data.limit || rowIds.length !== data.roomList.length ||
        JSON.stringify(stream.proof) !== JSON.stringify(proof) ||
        new Set(rowIds).size !== rowIds.length || requestPage !== null && Number(requestPage) !== data.page ||
        data.page > expectedPages || data.hasMore !== (data.page < expectedPages) || rowIds.length !== expectedRows ||
        prior && (prior.signature !== signature || prior.hasMore !== data.hasMore) ||
        stream.lastPage !== null && data.page > stream.lastPage) stream.invalid = true;
    const rowsInRegion = !!proof && data.roomList.every((row) => typeof row.dongName === 'string' && row.dongName.trim().normalize('NFC') === proof.dong);
    stream.pages.set(data.page, { ids: rowIds, signature, hasMore: data.hasMore, rowsInRegion });
    if (data.page >= (stream.page || 0)) {
      stream.page = data.page;
      stream.hasMore = data.hasMore;
      stream.cardIds = new Set(rowIds);
      stream.cardTitles = new Set(data.roomList.map((row) => tidy(row.roomTitle)).filter((title) => title.length >= 4));
    }
    stream.region = data.region;
    if (!data.hasMore) {
      if (stream.lastPage !== null && stream.lastPage !== data.page) stream.invalid = true;
      stream.lastPage = data.page;
    }
  }

  function dabangCoverage(stream, scoped = false) {
    const unique = new Set([...stream.pages.values()].flatMap((page) => page.ids)).size;
    const last = stream.lastPage;
    const contiguous = last !== null && stream.pages.size === last &&
      Array.from({ length: last }, (_, i) => stream.pages.get(i + 1)).every((page, i) => page && page.hasMore === (i + 1 < last));
    const rowsInRegion = [...stream.pages.values()].every((page) => page.rowsInRegion);
    const complete = scoped && !stream.invalid && contiguous && unique === stream.total && rowsInRegion;
    const reason = stream.invalid ? 'changed-results' : !scoped ? 'unverified-region' : !contiguous ? 'missing-pages'
      : unique !== stream.total ? 'count-mismatch' : !rowsInRegion ? 'response-scope' : 'complete';
    return { pages: stream.pages.size, totalPages: stream.limit ? Math.max(1, Math.ceil(stream.total / stream.limit)) : null,
      total: stream.total, regularUnique: unique, currentPage: stream.page,
      ...(last !== null ? { lastPage: last } : {}), complete, reason };
  }

  function zigbangStation() {
    try {
      const url = new URL(location.href);
      return url.protocol === 'https:' && /(^|\.)zigbang\.com$/.test(url.hostname) && !url.port && !url.username && !url.password
        ? /^\/home\/oneroom\/subways\/([1-9]\d*)\/items\/?$/.exec(url.pathname)?.[1] || null : null;
    } catch { return null; }
  }

  function zigbangResponse(url) {
    if (SITE !== 'zigbang' || url.protocol !== 'https:' || url.port || url.username || url.password || !/(^|\.)zigbang\.com$/.test(url.hostname)) return null;
    const station = /\/items\/subways\/([1-9]\d*)\/onerooms$/.exec(url.pathname)?.[1];
    return station ? { kind: 'list', station } : /\/items\/list$/.test(url.pathname) ? { kind: 'details' } : null;
  }

  function rememberZigbang(url, data, response) {
    const station = zigbangStation();
    if (!station) return;
    zigbangLedger ||= { stationId: station, expected: null, query: null, details: new Map(), invalid: null };
    const ledger = zigbangLedger;
    if (ledger.stationId !== station || response.kind === 'list' && response.station !== station) {
      ledger.invalid ||= 'station-changed'; return;
    }
    if (response.kind === 'list') {
      if (url.searchParams.getAll('radius').length !== 1 || Number(url.searchParams.get('radius')) !== 1) {
        ledger.invalid ||= 'radius-mismatch'; return;
      }
      const query = JSON.stringify([url.pathname, [...url.searchParams].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))]);
      if (ledger.query !== null && ledger.query !== query) { ledger.invalid ||= 'query-changed'; return; }
      ledger.query = query;
      if (!Array.isArray(data?.items) || data.items.length > 100000 || data.items.some((row) => !Number.isSafeInteger(row?.id) || row.id <= 0)) {
        ledger.invalid ||= 'unreadable-list'; return;
      }
      const expected = [...new Set(data.items.map((row) => String(row.id)))].sort();
      if (expected.length !== data.items.length) { ledger.invalid ||= 'duplicate-list-id'; return; }
      if (ledger.expected !== null && JSON.stringify(ledger.expected) !== JSON.stringify(expected)) { ledger.invalid ||= 'list-changed'; return; }
      ledger.expected = expected;
    } else {
      if (!Array.isArray(data?.items)) { ledger.invalid ||= 'unreadable-details'; return; }
      const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value
        : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
      for (const row of data.items) {
        const id = number(row?.item_id);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        const location = row.location ?? row.random_location;
        const lat = number(location?.lat), lng = number(location?.lng);
        const valid = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
        const key = String(id);
        if (valid || !ledger.details.get(key)?.valid) ledger.details.set(key, { valid, title: tidy(row.title) });
      }
      if (ledger.details.size > 100000) ledger.invalid ||= 'coverage-limit';
    }
  }

  function zigbangCoverage() {
    const ledger = zigbangLedger;
    const expected = ledger?.expected || [];
    const received = expected.filter((id) => ledger.details.has(id)).length;
    const missing = expected.length - received;
    const unreadable = expected.filter((id) => ledger.details.has(id) && !ledger.details.get(id).valid).length;
    const reason = ledger?.invalid || (ledger?.expected == null ? 'missing-list' : missing ? 'missing-details' : unreadable ? 'unreadable-details' : 'complete');
    return { stationId: ledger?.stationId || zigbangStation(), radiusKm: 1, total: ledger?.expected?.length ?? null,
      received, missing, complete: reason === 'complete', reason };
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
      const zigbang = zigbangResponse(u);
      let data;
      try { data = JSON.parse(c.body); }
      catch {
        if (zigbang) rememberZigbang(u, null, zigbang);
        return;
      }
      if (zigbang) rememberZigbang(u, data, zigbang);
      let rows;
      if (SITE === 'naver' && typeof HNW_NAVER_LEDGER !== 'undefined' && HNW_NAVER_LEDGER.endpoint(u.href)) {
        const req = JSON.parse(c.requestBody || '{}');
        const code = req.filter?.legalDivisionNumbers?.[0];
        if (/^[1-9]\d{9}$/.test(code)) {
          if (!naverStreams.has(code) || req.articlePagingRequest?.lastInfo?.length === 0) naverStreams.set(code, HNW_NAVER_LEDGER.create({ kind: 'naver-region', code, name: code, filter:req.filter, sort:req.articlePagingRequest?.articleSortType }));
          HNW_NAVER_LEDGER.accept(naverStreams.get(code), c);
        }
      }
      if (SITE === 'naver' && /\/(?:boundedArticles|clusteredArticles|legalDivisionArticleList)\/?$/.test(u.pathname) && Array.isArray(data?.result?.list)) {
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
        rememberDabangPage(u, data.result);
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
      } else if (zigbang?.kind === 'list') rows = [];
      if (!rows) return;
      responseVersion += 1;
      responseAt = Date.now();
      // 한 페이지에서 무한히 커지지 않게 제한한다. 모르는 카드는 조작하지 않는다.
      while (ids.size > 5000) ids.delete(ids.values().next().value);
      while (titles.size > 1000) titles.delete(titles.values().next().value);
    } catch { /* 모양이 다른 응답으로는 조작 대상을 만들지 않는다. */ }
  });

  function listingElements(allowedIds = ids, allowedTitles = titles) {
    const out = [];
    for (const a of [...document.querySelectorAll('a[href]')].slice(0, 3000)) {
      try {
        const u = new URL(a.getAttribute('href'), location.href);
        if (u.origin !== location.origin) continue;
        const segments = u.pathname.split('/').filter(Boolean);
        const last = segments[segments.length - 1];
        const isListing = allowedIds.has(last) && /(?:articles?|items?|rooms?)\//i.test(u.pathname);
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
      const titleMatch = allowedTitles.size && text.length < 1500 && /(?:월세|전세|매매)\s*[\d,]/.test(text) && [...allowedTitles].some((title) => text.includes(title));
      if ((id && allowedIds.has(id)) || titleMatch) out.push(el);
    }
    return [...new Set(out)];
  }

  function listContainer(allowedIds, allowedTitles) {
    const candidates = new Map();
    for (const item of listingElements(allowedIds, allowedTitles)) {
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

  function scrollList(allowedIds, allowedTitles) {
    const box = listContainer(allowedIds, allowedTitles);
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

  function recheckZigbangBottom(expected, matchingTitles) {
    const box = listContainer(expected, matchingTitles);
    const max = box ? Math.max(0, box.scrollHeight - box.clientHeight) : 0;
    if (!box || max <= box.clientHeight || box.scrollTop < max - 3 || !job.stable) return null;
    const progress = [...expected].filter((id) => zigbangLedger.details.get(id)?.valid).length;
    // A list can reach its bottom while its previous batch is still rendering.
    // Re-enter only the response-authorized list's bottom so its ordinary lazy
    // loader can run again. Ads, duplicate responses and DOM growth do not renew
    // this budget: only new, readable expected details establish progress.
    // Its one-viewport end threshold resets only beyond that distance; moving
    // exactly one viewport leaves the previously fired end event latched.
    if (!job.zigbangBottom || progress > job.zigbangBottom.progress) job.zigbangBottom = { progress, attempts: 0 };
    if (job.zigbangBottom.attempts >= 3) return result('idle', '목록 끝을 3회 다시 확인했지만 남은 상세 응답을 받지 못했습니다.');
    job.zigbangBottom.attempts++;
    return act(`남은 매물을 불러오기 위해 목록 끝을 다시 확인하는 중 (${job.zigbangBottom.attempts}/3)`,
      () => box.scrollTo({ top: Math.max(0, max - Math.max(120, Math.ceil(box.clientHeight * 1.25), box.clientHeight + 16)), behavior: 'instant' }));
  }

  function zigbangStep() {
    const station = zigbangStation();
    if (job.zigbangStation !== undefined && job.zigbangStation !== station) return result('blocked', '선택한 직방 역 검색 화면을 벗어나 탐색을 멈췄습니다. 새 순회를 시작해 주세요.');
    job.zigbangStation = station;
    if (!station) return job.actions >= MAX_ACTIONS ? result('idle', '한 페이지의 자동 탐색 한도에 도달했습니다. 일부만 확인했을 수 있습니다') : scrollList();
    const coverage = zigbangCoverage();
    const summary = `역 1km 원룸 · 상세 ${coverage.received}/${coverage.total ?? '?'} · 미수신 ${coverage.missing}`;
    const reply = (kind, note, waiting = false) => ({ ...result(kind, `${summary} · ${note}`, waiting), zigbangCoverage: coverage });
    if (coverage.stationId !== station || zigbangLedger?.invalid) return reply('blocked', '검색 범위나 목록 응답이 바뀌어 탐색을 멈췄습니다. 새 순회를 시작해 주세요.');
    if (coverage.total === null) return reply('idle', '선택한 역의 목록 응답을 기다리는 중', Date.now() - job.startedAt < 15000);
    if (coverage.complete) return Date.now() - responseAt < 3000 ? reply('idle', '마지막 상세 응답을 확인하는 중', true)
      : reply('complete', '현재 사이트 필터의 모든 매물 상세 응답을 확인했습니다.');
    if (job.actions >= 2000 || Date.now() - job.startedAt >= 1800000) return reply('idle', '탐색 한도에 도달했습니다. 남은 매물이 있어 전체 확인은 완료되지 않았습니다.');
    const expected = new Set(zigbangLedger.expected);
    const matchingTitles = new Set(zigbangLedger.expected.map((id) => zigbangLedger.details.get(id)?.title).filter((title) => title?.length >= 4));
    let next = scrollList(expected, matchingTitles);
    if (next.kind === 'idle' && !next.waiting && coverage.missing > 0) next = recheckZigbangBottom(expected, matchingTitles) || next;
    return reply(next.kind, coverage.reason === 'unreadable-details' ? `${next.note} · 읽지 못한 상세 응답이 있습니다.` : next.note, next.waiting);
  }

  function dabangPageResult(kind, note, stream, scoped, waiting = false) {
    return { ...result(kind, note, waiting), coverage: dabangCoverage(stream, scoped) };
  }

  function dabangStep(message) {
    let scope;
    try { scope = dabangScope(message.scope); }
    catch { return result('blocked', '다방 동별 조회 범위가 올바르지 않아 탐색을 멈췄습니다.'); }
    if (job.dabangScope !== undefined && !sameDabangScope(job.dabangScope, scope)) return result('blocked', '동별 조회 범위가 도중에 바뀌어 탐색을 멈췄습니다. 새 순회를 시작해 주세요.');
    job.dabangScope = scope;
    if (scope && !isDabangScopePage(scope)) return result('blocked', '선택한 동의 검색 화면을 벗어나 탐색을 멈췄습니다. 새 순회를 시작해 주세요.');
    const stream = scope ? dabangLatestRegion : dabangLatest;
    if (!stream) return scope ? result('idle', '동 검색 목록의 페이지 응답을 기다리는 중', Date.now() - job.startedAt < 15000) : scrollList();
    const scoped = !!scope && matchesDabangStream(stream, scope);
    if (scope && !scoped) return result(job.dabangKey ? 'blocked' : 'idle',
      '선택한 동과 일치하는 지역 응답을 확인하지 못했습니다.', !job.dabangKey && Date.now() - job.startedAt < 15000);
    const reply = (kind, note, waiting = false) => dabangPageResult(kind, note, stream, scoped, waiting);
    if (stream.invalid) return reply('idle', '조회 중 매물 수나 페이지 내용이 바뀌어 전체 확인을 확정할 수 없습니다. 다시 조회해 주세요.');
    if (job.dabangKey && job.dabangKey !== stream.key) return { ...reply('idle', '조회 범위나 필터가 바뀌어 페이지 확인을 멈췄습니다. 다시 조회해 주세요.'),
      coverage: { ...dabangCoverage(stream, scoped), complete: false, reason: 'changed-results' } };
    job.dabangKey ||= stream.key;
    if (job.nextPage) {
      if (stream.page === job.nextPage.expected) job.nextPage = null;
      else return reply('idle', `${job.nextPage.expected}페이지 응답을 기다리는 중`, Date.now() - job.nextPage.at < 12000);
    }
    if (!stream.hasMore) {
      if (Date.now() - stream.at < 3000) return reply('idle', '마지막 페이지의 추가 응답을 기다리는 중', true);
      const coverage = dabangCoverage(stream, scoped);
      return reply(coverage.complete ? 'complete' : 'idle', coverage.complete
        ? `동 검색 목록 ${coverage.pages}페이지, 중복 없는 매물 ${coverage.regularUnique}건을 끝까지 확인했습니다.`
        : `현재 검색 목록의 마지막 페이지까지 확인했습니다. ${coverage.pages}페이지, 중복 없는 매물 ${coverage.regularUnique}/${coverage.total}건이며 지역 전체 수집은 확인되지 않았습니다.`);
    }
    const box = scope ? listContainer(stream.cardIds, stream.cardTitles) : listContainer();
    if (!box) return reply('idle', '응답과 일치하는 매물 목록의 스크롤 영역을 확인하지 못했습니다');
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    if (box.scrollTop < max - 3) {
      const action = act(`${stream.page}페이지를 확인했고 다음 페이지 버튼으로 이동하는 중`, () => box.scrollTo({ top: max, behavior: 'instant' }));
      return { ...action, coverage: dabangCoverage(stream, scoped) };
    }
    // The observed list panel can hold pagination beside its scrolling list.
    // Never broaden to a generic ancestor: map markers and unrelated buttons
    // must remain outside the response-authorized control surface.
    const panel = box.closest('[id="onetwo-list"]') || box;
    const buttons = [...panel.querySelectorAll('button, [role="button"]')].filter(canClick);
    const next = buttons.find((button) => tidy(button.getAttribute('aria-label') || button.innerText || button.textContent) === String(stream.page + 1)) ||
      buttons.find((button) => /^(?:다음(?:\s*페이지)?|next(?:\s*page)?)$/i.test(tidy(button.getAttribute('aria-label') || button.innerText || button.textContent)));
    if (!next) return reply('idle', `${stream.page + 1}페이지가 남아 있지만 다음 페이지 버튼을 확인하지 못했습니다.`);
    const action = act(`${stream.page + 1}페이지를 여는 중`, () => {
      job.nextPage = { expected: stream.page + 1, at: Date.now() };
      next.click();
    });
    return { ...action, coverage: dabangCoverage(stream, scoped) };
  }

  function bubbleKey(el) {
    const id = el.getAttribute('data-cluster-id') || el.getAttribute('data-marker-id');
    if (id) return id;
    const r = el.getBoundingClientRect();
    return `${Math.round(r.left)}:${Math.round(r.top)}:${tidy(el.textContent)}`;
  }

  function naverRegionStep(scope) {
    const target = HNW_NAVER_LEDGER.scope(scope);
    const ledger = naverStreams.get(target.code);
    if (ledger && (!HNW_NAVER_LEDGER.matchesFilter(target,ledger.scope.filter) || target.sort && target.sort !== ledger.scope.sort)) return result('blocked','새 창의 필터가 선택한 조건과 다릅니다. 무필터 수집은 시작하지 않았습니다.');
    if (ledger?.invalid) return result('blocked', `선택한 구·동 목록의 범위 또는 페이지가 일치하지 않습니다 (${ledger.invalid}). 필터를 확인하고 새 수집을 시작해 주세요.`);
    if (!ledger?.pages) {
      const buttons = [...document.querySelectorAll('button')].filter(canClick);
      const close = buttons.find(el => tidy(el.getAttribute('aria-label') || el.textContent) === '창닫기');
      if (close) return act('지도 안내를 닫고 지역 목록을 준비하는 중', () => close.click());
      const name = target.name.split(/\s+/).at(-1);
      const candidates = buttons.filter(el => {
        const text = tidy(el.getAttribute('aria-label') || el.textContent);
        return text.replace(/\s/g, '').startsWith(name.replace(/\s/g, '') + '매물') && /매물\s*[\d,]+/.test(text);
      });
      if (!job.naverOpened && candidates.length === 1) return act(`${name}의 구·동 전체 매물 목록을 여는 중`, () => { job.naverOpened = Date.now(); candidates[0].click(); });
      return result('idle', '선택한 지역과 필터의 목록 응답을 기다립니다. 지도에 해당 지역의 매물 수가 보이는지 확인해 주세요.', Date.now() - (job.naverOpened || job.startedAt) < 20000);
    }
    const proof = HNW_NAVER_LEDGER.coverage(ledger);
    if (proof.complete) return Date.now() - responseAt < 3000 ? result('idle', '마지막 페이지의 추가 응답을 기다리는 중', true)
      : { ...result('complete', `${proof.pages}페이지, 매물 ${proof.received}건의 마지막 목록을 확인했습니다.`), naverCoverage: proof };
    if (ledger.ended) return result('blocked', `마지막 목록을 받았지만 표시 ${proof.total}건과 수신 ${proof.received}건이 다릅니다. 받은 목록은 저장했습니다.`);
    const panel = [...document.querySelectorAll('[id="region_detail"]')].find(el => visible(el));
    const box = listContainer();
    if (!panel || !box || !panel.contains(box) && panel !== box) return result('idle', '구·동 목록과 일치하는 스크롤 영역을 확인하지 못했습니다.', Date.now() - responseAt < 12000);
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    if (box.scrollTop < max - 3) return act(`${proof.pages}페이지 · ${proof.received}/${proof.total}건 수신, 다음 목록 확인 중`, () => box.scrollTo({ top: Math.min(max, box.scrollTop + Math.max(120, Math.round(box.clientHeight * .8))), behavior: 'instant' }));
    if (Date.now() - responseAt < 8000) return result('idle', `${proof.received}/${proof.total}건 수신, 다음 페이지 응답을 기다리는 중`, true);
    // Ordinary lazy lists may need their bottom re-entered after rendering. Bound retries per received page.
    if (job.naverBottom?.pages !== proof.pages) job.naverBottom = { pages: proof.pages, tries: 0 };
    if (max > box.clientHeight && job.naverBottom.tries < 3) return act('다음 목록을 불러오도록 목록 끝을 다시 확인하는 중', () => {
      job.naverBottom.tries++;
      box.scrollTo({ top: Math.max(0, max - box.clientHeight - 10), behavior: 'instant' });
    });
    return result('idle', `${proof.received}/${proof.total}건까지 받았습니다. 다음 목록 응답이 없어 일부 확인으로 남깁니다.`);
  }

  function step(message) {
    if (message.site !== SITE) return result('unsupported', '이 사이트는 화면 확인만 지원합니다');
    if (typeof message.jobId !== 'string' || !message.jobId || message.jobId.length > 120) return result('unsupported', '조회 작업을 확인할 수 없습니다');
    if (!job || job.id !== message.jobId) reset(message.jobId);
    const reason = blocked();
    if (reason) return result('blocked', reason);
    if (!SUPPORTED.includes(SITE)) return result('unsupported', '이 사이트는 화면 확인만 지원합니다');
    if (SITE === 'dabang') return dabangStep(message);
    if (SITE === 'zigbang') return zigbangStep();
    if (SITE === 'naver' && message.naverScope) return naverRegionStep(message.naverScope);
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

  let indicator = null;
  function renderIndicator(message) {
    if (SITE !== 'naver' || !document.body || typeof message.jobId !== 'string') return;
    if (!indicator) {
      indicator = document.createElement('section');
      indicator.setAttribute('aria-label', '매물 수집 진행 상황');
      indicator.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;width:390px;max-width:calc(100vw - 36px);padding:16px;border:2px solid #2360a5;border-radius:12px;background:#fff;color:#172b45;box-shadow:0 5px 24px #0003;font:14px/1.6 "Malgun Gothic",sans-serif;pointer-events:none';
      for (const tag of ['strong','div','progress','div','small','small']) indicator.appendChild(document.createElement(tag));
      document.body.appendChild(indicator);
    }
    const [heading, counts, bar, detail, hint, filter] = indicator.children;
    const complete = message.status === 'complete', active = message.state === 'running' && ['running','pending'].includes(message.status);
    heading.textContent = `${message.areaName || '네이버'}, ${complete ? '선택 조건 저장 완료' : active ? '수집 중' : message.state === 'paused' ? '수집 중단됨' : '일부 확인, 수집 멈춤'}`;
    counts.textContent = `${message.pages || 0}페이지, 수신 ${message.received || 0}/${message.total ?? '?'}건, 저장 ${message.stored || 0}건`;
    bar.max = Math.max(1, message.total || 1); bar.value = message.received || 0; bar.style.cssText = 'width:100%;height:10px;margin:8px 0';
    detail.textContent = message.message || '';
    hint.textContent = message.lastAt ? `마지막 목록 수신 ${new Date(message.lastAt).toLocaleTimeString('ko-KR',{hour12:false,timeZone:'Asia/Seoul'})}, 중단과 이어하기는 확장 팝업에서` : '페이지가 열리고 첫 목록이 도착하기를 기다립니다.';
    filter.textContent = message.filterSummary ? `적용 조건: ${message.filterSummary}` : '';
    filter.style.cssText = 'display:block;margin-top:6px;color:#425b76';
    indicator.style.borderColor = complete ? '#12825e' : active ? '#2360a5' : '#be6423';
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'naver-filter-context') {
      if (SITE !== 'naver') sendResponse({error:'필터를 읽을 네이버 매물 탭을 선택해 주세요.'});
      else sendResponse({pageUrl:location.href});
      return;
    }
    if (message?.type === 'browse-indicator') { renderIndicator(message); sendResponse({ ok: true }); return; }
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
