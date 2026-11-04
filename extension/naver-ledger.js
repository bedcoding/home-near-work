// Shared by the extension and local receiver. Only a contiguous, unchanged region list can complete.
globalThis.HNW_NAVER_LEDGER = (() => {
  const TYPES = ['A01','A04','B01','A02','E03','B02','A05','A06','A07','C02','F01','C01','C03','D05','C04'];
  const DEFAULT_FALSE_FILTERS = new Set(['filtersExclusiveSpace', 'hasArticlePhoto', 'isAuthorizedByOwner', 'hasArticle']);
  const SELECTIONS = new Set(['tradeTypes','realEstateTypes','legalDivisionNumbers','roomCount','bathRoomCount','optionTypes','oneRoomShapeTypes','moveInTypes','floorTypes','directionTypes','parkingTypes','entranceTypes']);
  const canonical = value => JSON.stringify(value, function (_key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
  });
  const empty = value => value == null || value === '' || Array.isArray(value) && !value.length ||
    typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(empty);
  function safeJson(value, depth = 0) {
    if (depth > 8) throw new Error('invalid-filter');
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
    if (Array.isArray(value) && value.length <= 200) return value.map(item => safeJson(item, depth + 1));
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) throw new Error('invalid-filter');
    const result = {};
    for (const [key,item] of Object.entries(value)) {
      if (['__proto__','prototype','constructor'].includes(key)) throw new Error('invalid-filter');
      result[key] = safeJson(item, depth + 1);
    }
    return result;
  }
  function normalizedFilter(filter) {
    const result = {};
    for (const [key,value] of Object.entries(filter)) {
      if (empty(value) || value === false && DEFAULT_FALSE_FILTERS.has(key)) continue;
      result[key] = SELECTIONS.has(key) && Array.isArray(value) ? [...new Set(value)].sort() : value;
    }
    return result;
  }
  const fingerprint = (filter,paging) => canonical([normalizedFilter(filter),paging.size,paging.articleSortType]);
  function scope(value) {
    if (!value || value.kind !== 'naver-region' || !/^[1-9]\d{9}$/.test(value.code) ||
        typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120) throw new Error('네이버 구나 동 범위를 확인해 주세요.');
    const result = { kind: 'naver-region', code: value.code, name: value.name.trim().normalize('NFC') };
    if (value.filter !== undefined) {
      const filter = safeJson(value.filter);
      if (!filter || Array.isArray(filter) || !Array.isArray(filter.tradeTypes) || !filter.tradeTypes.length || filter.tradeTypes.some(type => !['A1','B1','B2','B3'].includes(type)) ||
          !Array.isArray(filter.realEstateTypes) || !filter.realEstateTypes.length || filter.realEstateTypes.length > 40 || filter.realEstateTypes.some(type => !/^[A-Z]\d{2}$/.test(type)) ||
          typeof value.sort !== 'string' || !/^[A-Z][A-Z0-9_]{0,39}$/.test(value.sort)) throw new Error('invalid-filter');
      result.filter = { ...filter, legalDivisionNumbers:[result.code], legalDivisionType:result.code.endsWith('00000') ? 'GUN' : 'EUP' };
      result.sort = value.sort;
      if (JSON.stringify(result.filter).length > 16000) throw new Error('invalid-filter');
    }
    return result;
  }
  function checkFilter(target,filter) {
    if (!filter || canonical(filter.legalDivisionNumbers) !== canonical([target.code]) || filter.legalDivisionType !== (target.code.endsWith('00000') ? 'GUN' : 'EUP')) throw new Error('filter');
    if (target.filter) {
      if (canonical(normalizedFilter(filter)) !== canonical(normalizedFilter(target.filter))) throw new Error('filter-changed');
      return;
    }
    if (canonical([...(filter.tradeTypes || [])].sort()) !== canonical(['A1','B1','B2','B3']) || canonical([...(filter.realEstateTypes || [])].sort()) !== canonical([...TYPES].sort())) throw new Error('filter');
    if (Object.entries(filter).some(([key,value]) => !['legalDivisionNumbers','legalDivisionType','tradeTypes','realEstateTypes'].includes(key) && !(value === false && DEFAULT_FALSE_FILTERS.has(key)) && !empty(value))) throw new Error('restricted-filter');
  }
  function matchesFilter(target,filter) { try { checkFilter(target,filter); return true; } catch { return false; } }
  const endpoint = url => { try { const u = new URL(url); return u.protocol === 'https:' && !u.port && !u.username && !u.password && u.hostname === 'fin.land.naver.com' && /\/article\/legalDivisionArticleList\/?$/.test(u.pathname); } catch { return false; } };
  const create = target => ({ scope: scope(target), pages: 0, ids: [], next: [], ended: false, signatures: {} });
  function accept(ledger, capture) {
    if (!endpoint(capture.url)) return;
    if (!(capture.status >= 200 && capture.status < 300)) { ledger.invalid ||= 'response-status'; return; }
    try {
      const req = JSON.parse(capture.requestBody), response = JSON.parse(capture.body)?.result;
      const filter = req?.filter, paging = req?.articlePagingRequest;
      checkFilter(ledger.scope,filter);
      if (!paging || !Number.isSafeInteger(paging.size) || paging.size < 1 || paging.size > 100 ||
          (ledger.scope.sort ? paging.articleSortType !== ledger.scope.sort : !['DATE_DESC','RANKING_DESC'].includes(paging.articleSortType)) ||
          !Array.isArray(paging.lastInfo) || !response || !Array.isArray(response.list) || !Array.isArray(response.lastInfo) ||
          typeof response.hasNextPage !== 'boolean' || !Number.isSafeInteger(response.totalCount) || response.totalCount < 0 || response.totalCount > 200000) throw new Error('metadata');
      const query = fingerprint(filter,paging);
      if (ledger.query && ledger.query !== query) throw new Error('changed-query');
      const input = canonical(paging.lastInfo), signature = canonical([response.totalCount, response.seed, response.lastInfo, response.hasNextPage,
        response.list.map(item => [item?.representativeArticleInfo?.articleNumber, (item?.duplicatedArticleInfo?.articleInfoList || []).map(x => x.articleNumber)]), paging.seed ?? null]);
      if (ledger.signatures[input]) {
        if (ledger.signatures[input] !== signature) throw new Error('changed-page');
        return;
      }
      if (ledger.ended || input !== canonical(ledger.next) || ledger.pages && paging.seed !== ledger.seed ||
          !ledger.pages && (paging.lastInfo.length || paging.seed != null)) throw new Error('cursor-order');
      if (ledger.pages && (response.seed !== ledger.seed || response.totalCount !== ledger.total)) throw new Error('changed-total');
      const ids = response.list.map(item => {
        const rep = item?.representativeArticleInfo;
        if (!/^\d+$/.test(String(rep?.articleNumber ?? ''))) throw new Error('unreadable-row');
        const numbers = [String(rep.articleNumber), ...(item.duplicatedArticleInfo?.articleInfoList || []).map(x => String(x.articleNumber))];
        if (numbers.some(id => !/^\d+$/.test(id))) throw new Error('unreadable-row');
        return numbers.sort((a,b) => Number(a)-Number(b))[0];
      });
      if (response.list.length > paging.size || new Set(ids).size !== ids.length || ids.some(id => ledger.ids.includes(id)) ||
          response.hasNextPage && (!ids.length || !response.lastInfo.length || canonical(response.lastInfo) === input || response.seed == null)) throw new Error('invalid-page');
      ledger.query ||= query; ledger.total ??= response.totalCount; ledger.seed ??= response.seed;
      ledger.signatures[input] = signature; ledger.pages++; ledger.ids.push(...ids); ledger.next = response.lastInfo;
      ledger.ended = !response.hasNextPage;
    } catch (error) { ledger.invalid ||= error?.message || 'invalid-response'; }
  }
  function coverage(ledger, stored = null) {
    const total = ledger.total ?? null, received = ledger.ids.length;
    return { code: ledger.scope.code, pages: ledger.pages, total, received, stored,
      complete: !ledger.invalid && ledger.pages > 0 && ledger.ended && received === total && (stored === null || stored === received),
      reason: ledger.invalid || (!ledger.ended ? 'more-pages' : received !== total ? 'count-mismatch' : stored !== null && stored !== received ? 'storage-mismatch' : 'complete') };
  }
  function nextRequest(ledger, template) {
    const paging = template?.articlePagingRequest;
    if (!ledger.pages || ledger.invalid || ledger.ended || !paging ||
        fingerprint(template.filter,paging) !== ledger.query) return null;
    return JSON.parse(JSON.stringify({ filter: template.filter, articlePagingRequest: {
      size: paging.size, userChannelType: 'PC', articleSortType: paging.articleSortType, seed: ledger.seed, lastInfo: ledger.next,
    } }));
  }
  function conditions(filter) {
    const deals={A1:'매매',B1:'전세',B2:'월세',B3:'단기'};
    const types={A01:'아파트',A02:'오피스텔',A04:'재건축',A05:'연립',A06:'다세대',A07:'도시형생활주택',B01:'아파트 분양권',B02:'오피스텔 분양권',
      C01:'원룸',C02:'빌라',C03:'단독/다가구',C04:'전원주택',C06:'한옥주택',D01:'사무실',D02:'상가',D03:'건물',D04:'상가건물',D05:'상가주택',
      E01:'숙박/콘도',E02:'공장/창고',E03:'토지',E04:'지식산업센터',F01:'재개발',G01:'고시원',Z00:'기타'};
    const money=value=>value>=100000000 ? `${(value/100000000).toLocaleString('ko-KR')}억원` : `${(value/10000).toLocaleString('ko-KR')}만원`;
    const range=(value,format)=> {
      if (!value || value.min==null && value.max==null) return '제한 없음';
      if (value.min==null || value.min===0) return value.max==null ? '제한 없음' : `${format(value.max)} 이하`;
      return value.max==null ? `${format(value.min)} 이상` : `${format(value.min)} ~ ${format(value.max)}`;
    };
    const trades=filter.tradeTypes || [];
    const rows=[{label:'거래 유형',value:trades.map(type=>deals[type]||type).join(', ')},
      {label:'매물 유형',value:(filter.realEstateTypes || []).map(type=>types[type]||type).join(', ')},
      {label:'매매가',value:trades.includes('A1') ? range(filter.dealPrice,money) : '매매 제외'},
      {label:'보증금과 전세금',value:trades.some(type=>['B1','B2','B3'].includes(type)) ? range(filter.warrantyPrice,money) : '임대 제외'},
      {label:'월세',value:trades.some(type=>['B2','B3'].includes(type)) ? range(filter.rentPrice,money) : '월세와 단기 제외'},
      {label:filter.filtersExclusiveSpace ? '전용면적' : '면적',value:range(filter.space,value=>`${value.toLocaleString('ko-KR')}㎡`)}];
    const known=['tradeTypes','realEstateTypes','legalDivisionNumbers','legalDivisionType','dealPrice','warrantyPrice','rentPrice','space','filtersExclusiveSpace'];
    const labels={roomCount:'방 개수',bathRoomCount:'욕실 개수',optionTypes:'시설',oneRoomShapeTypes:'원룸 구조',moveInTypes:'입주 가능일',floorTypes:'층',directionTypes:'방향',
      parkingTypes:'주차 시설',entranceTypes:'현관 구조',hasArticlePhoto:'사진 있는 매물만',isAuthorizedByOwner:'집주인 인증만',hasArticle:'매물 있는 단지만',
      approvalElapsedYear:'사용승인 경과 연수',managementFee:'관리비',householdNumber:'세대수',loanRatioType:'융자금',walkingMinuteToSubwayStation:'역까지 도보 시간'};
    for(const [key,value] of Object.entries(normalizedFilter(filter))) {
      if (known.includes(key)) continue;
      const counts={RCF01:'1개',RCF02:'2개',RCF03:'3개',RCF04:'4개 이상'};
      const display=value===true ? '적용' : Array.isArray(value) ? value.map(item=>['roomCount','bathRoomCount'].includes(key) ? counts[item] || item : item).join(', ') : typeof value==='object'
        ? range(value,key==='managementFee' ? money : n=>String(n)) : String(value);
      rows.push({label:labels[key] || key,value:display});
    }
    return rows;
  }
  const summary = filter => conditions(filter).map(row=>`${row.label}: ${row.value}`).join(', ');
  return { TYPES, scope, endpoint, create, accept, coverage, nextRequest, matchesFilter, summary, conditions };
})();
