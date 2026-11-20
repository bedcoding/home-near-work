// 당근 지도에서 이미 받은 공개 매물 목록만 추린다.
const HNW_DAANGN_CAPTURE = (() => {
  const origin = 'https://realty.daangn.com';
  const graphql = 'https://realty.kr.karrotmarket.com/graphql';
  const maxBody = 2000000;
  const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_+=/.:\-]{1,1024}$/.test(value);
  const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
  const fields = (value, names) => Object.fromEntries(names.map(name => [name, scalar(value?.[name])]));
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

  function page(value) {
    try {
      const url = new URL(value);
      const path = url.pathname.replace(/\/$/, '');
      if (url.origin !== origin || url.username || url.password || (path !== '/map' && !/^\/map\/subway\/[^/]+$/.test(path))) return null;
      const safe = new URL(path, origin);
      const bounds = url.searchParams.getAll('region_bounds');
      if (!bounds.length) return safe.href;
      if (bounds.length !== 1 || !/^-?\d{1,3}(?:\.\d{1,8})?(?:,-?\d{1,3}(?:\.\d{1,8})?){3},\d{1,2}$/.test(bounds[0])) return null;
      const [south, west, north, east, zoom] = bounds[0].split(',').map(Number);
      if (south < -90 || north > 90 || south >= north || west < -180 || east > 180 || west >= east || zoom < 1 || zoom > 22) return null;
      safe.searchParams.set('region_bounds', bounds[0]);
      return safe.href;
    } catch { return null; }
  }

  function endpoint(value) {
    try {
      const url = new URL(value, origin);
      return !url.username && !url.password && `${url.origin}${url.pathname}` === graphql;
    } catch { return false; }
  }

  function requestValue(raw, getUrl = null) {
    if (!getUrl && (typeof raw !== 'string' || raw.length > maxBody)) return null;
    try {
      if (!getUrl) return JSON.parse(raw);
      const url = new URL(getUrl, origin);
      return { variables: JSON.parse(url.searchParams.get('variables') ?? 'null'),
        extensions: JSON.parse(url.searchParams.get('extensions') ?? 'null') };
    } catch { return null; }
  }

  function coordinate(value) {
    if (!keys(value, ['lat', 'lon'])) return null;
    for (const [name, limit] of [['lat', 90], ['lon', 180]]) {
      const part = value[name];
      if (!(typeof part === 'number' || typeof part === 'string' && /^-?\d{1,3}(?:\.\d{1,12})?$/.test(part)) ||
          !Number.isFinite(Number(part)) || Math.abs(Number(part)) > limit) return null;
    }
    return { lat: value.lat, lon: value.lon };
  }

  function requestTemplate(raw, getUrl = null) {
    const request = requestValue(raw, getUrl);
    if (!keys(request, ['variables', 'extensions']) || !keys(request.extensions, ['persistedQuery'])) return null;
    const variables = request?.variables;
    const input = variables?.input;
    if (!keys(variables, ['first', 'after', 'input']) || !Number.isInteger(variables.first) || variables.first < 1 || variables.first > 100 ||
        variables.after !== null && !opaque(variables.after) || !keys(input, ['locationFilter', 'propertyFilter', 'resolution', 'surface'])) return null;
    if (!keys(input.locationFilter, ['neCoordinate', 'swCoordinate']) || !keys(input.propertyFilter, ['salesTypes'])) return null;
    const ne = coordinate(input.locationFilter.neCoordinate), sw = coordinate(input.locationFilter.swCoordinate);
    const salesTypes = input.propertyFilter.salesTypes;
    if (!ne || !sw || Number(sw.lat) >= Number(ne.lat) || Number(sw.lon) >= Number(ne.lon) ||
        !Array.isArray(salesTypes) || salesTypes.length > 30 || salesTypes.some(type => typeof type !== 'string' || !/^[A-Z][A-Z0-9_]{0,39}$/.test(type)) ||
        typeof input.resolution !== 'number' || !Number.isFinite(input.resolution) || input.resolution < 0 || input.resolution > 100 ||
        typeof input.surface !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(input.surface)) return null;
    const persisted = request.extensions?.persistedQuery;
    if (!keys(persisted, ['version', 'sha256Hash']) || persisted.version !== 1 || typeof persisted.sha256Hash !== 'string' || !/^[a-f0-9]{64}$/i.test(persisted.sha256Hash)) return null;
    // Preserve the site's public search, page size and learned operation. Extra fields never enter a replay.
    return JSON.stringify({ variables: { first: variables.first, after: variables.after, input: {
      locationFilter: { neCoordinate: ne, swCoordinate: sw }, propertyFilter: { salesTypes: [...salesTypes] },
      resolution: input.resolution, surface: input.surface,
    } }, extensions: { persistedQuery: { version: 1, sha256Hash: persisted.sha256Hash } } });
  }

  function nextRequest(rawTemplate, after) {
    if (!opaque(after)) return null;
    const template = requestTemplate(rawTemplate);
    if (!template) return null;
    const request = JSON.parse(template);
    request.variables.after = after;
    return JSON.stringify(request);
  }

  function requestBody(raw, getUrl = null) {
    try {
      const variables = requestValue(raw, getUrl)?.variables;
      if (!variables || !Object.hasOwn(variables, 'after') || variables.after !== null && !opaque(variables.after)) return null;
      return requestTemplate(raw, getUrl) || JSON.stringify({ variables: { after: variables.after } });
    } catch { return null; }
  }

  function body(raw) {
    if (typeof raw !== 'string' || raw.length > maxBody) return null;
    try {
      const data = JSON.parse(raw);
      const feed = data?.data?.articleFeed;
      if (data?.errors?.length || !Array.isArray(feed?.edges) || typeof feed.pageInfo?.hasNextPage !== 'boolean') return null;
      return JSON.stringify({ data: { articleFeed: {
        edges: feed.edges.map(edge => {
          const a = edge?.node?.article;
          if (!a || typeof a !== 'object' || Array.isArray(a)) return { node: edge?.node?.advertisement ? { advertisement: true } : null };
          return { node: { article: {
            ...fields(a, ['originalId', 'buildingName', 'area', 'floor', 'topFloor', 'isHideAddress']),
            ...(a.isHideAddress === true ? {} : fields(a, ['addressInfo'])),
            salesTypeV3: fields(a.salesTypeV3, ['type']),
            publicCoordinate: fields(a.publicCoordinate, ['lat', 'lon']),
            region: fields(a.region, ['name', 'name2', 'name3']),
            trades: Array.isArray(a.trades) ? a.trades.map(trade => fields(trade, ['type', 'deposit', 'monthlyPay', 'price'])) : [],
            images: Array.isArray(a.images) ? a.images.slice(0, 1).map(image => fields(image, ['thumbnail'])) : [],
          } } };
        }),
        pageInfo: { hasNextPage: feed.pageInfo.hasNextPage, endCursor: opaque(feed.pageInfo.endCursor) ? feed.pageInfo.endCursor : null },
      } } });
    } catch { return null; }
  }

  function capture(value, allowDenial = false) {
    const pageUrl = page(value?.pageUrl);
    const status = value?.status;
    if (!pageUrl || !endpoint(value?.url) || !Number.isInteger(status)) return null;
    const result = { at: new Date().toISOString(), site: 'daangn', pageUrl, url: graphql,
      method: ['GET', 'POST'].includes(value.method) ? value.method : null, status, requestBody: null, body: '' };
    if (status === 403 || status === 429) return allowDenial ? result : null;
    if (status < 200 || status >= 300) return null;
    result.body = body(value.body);
    result.requestBody = requestBody(value.requestBody);
    return result.body && result.requestBody ? result : null;
  }

  return { graphql, page, endpoint, requestTemplate, nextRequest, requestBody, body, capture };
})();

// The owned map document makes the ordinary public request. Its hook sends the
// response through the same durable capture path as the site's own requests.
async function hnwFetchDaangnPage(body, expectedPage) {
  if (typeof HNW_DAANGN_CAPTURE === 'undefined' || !window.__hnwHook ||
      HNW_DAANGN_CAPTURE.page(location.href) !== HNW_DAANGN_CAPTURE.page(expectedPage) ||
      !HNW_DAANGN_CAPTURE.page(expectedPage)) return { error: 'collection-document-missing' };
  if (typeof body !== 'string' || body.length > 20000 || HNW_DAANGN_CAPTURE.requestTemplate(body) !== body) return { error: 'invalid-request' };
  try {
    for (const element of document.querySelectorAll('iframe[src*="captcha"], iframe[title*="challenge"], [id="captcha"], [id="challenge-form"], h1, h2, [role="alert"], [role="dialog"], dialog')) {
      const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (!bounds.width || !bounds.height || style.display === 'none' || style.visibility === 'hidden') continue;
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      if (element.tagName === 'IFRAME' || /접근[이을 ]*(?:제한|차단)|비정상적인?\s*(?:접근|요청)|자동(?:입력|접속)\s*방지|로그인(?:이|을)?\s*(?:필요|해\s*주세요|후)|verify (?:that )?you are human|access denied/i.test(text)) return { error: 'page-security-check' };
    }
    const response = await window.fetch(HNW_DAANGN_CAPTURE.graphql, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
      credentials: 'same-origin', mode: 'cors', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, json: (response.headers.get('content-type') || '').includes('json') };
  } catch { return { error: 'request-failed' }; }
}
