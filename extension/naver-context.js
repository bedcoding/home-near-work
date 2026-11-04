// Copy a verified page filter and its public map URL. Never synthesize an unrestricted fallback.
globalThis.HNW_NAVER_CONTEXT = (() => {
  function mapUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'fin.land.naver.com' || url.port || url.username || url.password ||
        url.pathname.replace(/\/$/,'') !== '/map' || url.href.length > 20000 || url.searchParams.getAll('layer').length !== 1) throw new Error('네이버의 구나 동 매물 목록을 열고 필터를 적용해 주세요.');
    return url;
  }
  function regionLayer(url) {
    let layers;
    try { layers = JSON.parse(HNW_LZ_STRING.decompressFromEncodedURIComponent(url.searchParams.get('layer'))); } catch { /* Fail closed below. */ }
    if (!Array.isArray(layers) || layers.length > 10) throw new Error('현재 화면의 필터 주소를 읽지 못했습니다. 네이버 탭을 새로고침해 주세요.');
    const regions = layers.filter(layer => layer?.id === 'region_detail');
    if (regions.length !== 1 || !/^[1-9]\d{9}$/.test(regions[0].params?.legalDivisionNumber)) throw new Error('구나 동의 매물 목록을 먼저 열어 주세요.');
    return regions[0];
  }
  function pageFilter(url,layer) {
    // Map filters are public URL state. Reading them must not depend on a
    // request's camera URL, response timing, or the site's local-storage defaults.
    const query=url.searchParams;
    const get=key=>{
      if(query.getAll(key).length>1)throw new Error('필터 주소에 같은 조건이 중복돼 있습니다. 네이버에서 조건을 다시 적용해 주세요.');
      return query.get(key);
    };
    const list=key=>{
      const value=get(key);if(!value)return [];
      return [...new Set(value.split('-'))].sort();
    };
    if(!get('tradeTypes') || !get('realEstateTypes'))throw new Error('주소에서 거래 유형과 매물 유형을 확인하지 못했습니다. 네이버에서 필터를 한 번 적용해 주세요.');
    const filter={tradeTypes:list('tradeTypes'),realEstateTypes:list('realEstateTypes')};
    const range=(key,limit)=>{
      const raw=get(key);if(raw==null)return;
      const parts=raw.split('-');
      if(parts.length!==2 || !/^\d+(?:\.\d+)?$/.test(parts[0]) || !/^(?:\d+(?:\.\d+)?|Infinity)?$/.test(parts[1]))throw new Error('가격이나 면적 조건을 해석하지 못했습니다. 네이버에서 조건을 다시 적용해 주세요.');
      const min=Number(parts[0]),upper=Number(parts[1]);
      const max=!Number.isFinite(upper) || upper===0 || upper>=limit ? undefined : upper;
      if(!Number.isFinite(min) || max!==undefined && min>max)throw new Error('필터의 최소와 최대 범위를 확인해 주세요.');
      return min===0 && max===undefined ? undefined : {min,...(max===undefined ? {} : {max})};
    };
    for(const [key,limit] of Object.entries({dealPrice:999999990000,warrantyPrice:999999990000,rentPrice:999999990000,space:100000,approvalElapsedYear:25,managementFee:600000,householdNumber:4000})) {
      const value=range(key,limit);if(value)filter[key]=value;
    }
    for(const [key,target] of Object.entries({roomCount:'roomCount',bathRoomCount:'bathRoomCount',facilities:'optionTypes',oneRoomShapeTypes:'oneRoomShapeTypes',moveInTypes:'moveInTypes',floor:'floorTypes',direction:'directionTypes',parkingTypes:'parkingTypes',entranceTypes:'entranceTypes'})) {
      const values=list(key);if(values.length)filter[target]=values;
    }
    for(const [key,target] of Object.entries({exclusiveSpaceMode:'filtersExclusiveSpace',hasArticlePhoto:'hasArticlePhoto',isAuthorizedByOwner:'isAuthorizedByOwner',hasArticleComplex:'hasArticle'})) {
      const value=get(key);if(value==null)continue;
      if(!['true','false'].includes(value))throw new Error('필터의 선택 여부를 해석하지 못했습니다. 네이버에서 조건을 다시 적용해 주세요.');
      if(value==='true')filter[target]=true;
    }
    const loan=get('loanRatioType');if(loan)filter.loanRatioType=loan;
    const walking=get('subwayWalkingMinute');
    if(walking!=null) {
      if(!/^\d+(?:\.\d+)?$/.test(walking))throw new Error('역까지 도보 시간 조건을 확인해 주세요.');
      const max=Number(walking);if(max>0 && max<25)filter.walkingMinuteToSubwayStation={min:0,max};
    }
    if(!filter.tradeTypes.includes('A1'))delete filter.dealPrice;
    if(!filter.tradeTypes.some(type=>['B1','B2','B3'].includes(type)))delete filter.warrantyPrice;
    if(!filter.tradeTypes.some(type=>['B2','B3'].includes(type)))delete filter.rentPrice;
    const sort=layer.searchParams?.articleSortingType || 'RANKING_DESC';
    return HNW_NAVER_LEDGER.scope({kind:'naver-region',code:layer.params.legalDivisionNumber,name:'현재 화면',filter,sort});
  }
  function read(snapshot) {
    if (!snapshot || snapshot.error) throw new Error(snapshot?.error || '현재 네이버 필터를 받지 못했습니다. 네이버 탭을 새로고침해 주세요.');
    const url = mapUrl(snapshot.pageUrl), layer = regionLayer(url), pinned=pageFilter(url,layer);
    const context = {pageUrl:url.href,filter:pinned.filter,sort:pinned.sort};
    context.key = JSON.stringify({filter:pinned.filter,sort:pinned.sort});
    context.summary = HNW_NAVER_LEDGER.summary(context.filter);
    return context;
  }
  function forArea(area, context, generatedUrl) {
    const source = mapUrl(context.pageUrl), layer = JSON.parse(JSON.stringify(regionLayer(source)));
    const code = area.region.kind === 'gu' && /^\d{5}$/.test(area.region.code) ? `${area.region.code}00000` : area.region.code;
    const pinned = HNW_NAVER_LEDGER.scope({kind:'naver-region',code,name:area.region.name || area.name,filter:context.filter,sort:context.sort});
    layer.params.legalDivisionNumber = pinned.code;
    // Keep all global and layer filter parameters, changing only the selected region and camera.
    source.searchParams.set('center',new URL(generatedUrl).searchParams.get('center'));
    source.searchParams.set('zoom',area.region.kind === 'gu' ? '11' : '14');
    source.searchParams.set('showOnlySelectedRegion','true');
    source.searchParams.set('layer',HNW_LZ_STRING.compressToEncodedURIComponent(JSON.stringify([layer])));
    return {url:source.href,scope:pinned};
  }
  return {read,forArea};
})();
