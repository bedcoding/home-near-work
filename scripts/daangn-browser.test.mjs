import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = name => fs.readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
const graphql = 'https://realty.kr.karrotmarket.com/graphql';
const publicPage = 'https://realty.daangn.com/map/subway/Synthetic?region_bounds=10%2C20%2C11%2C21%2C14';
const mapRequest = (after = null) => ({ variables: { first: 20, after, input: {
  locationFilter: { neCoordinate: { lat: '11.0', lon: '21.0' }, swCoordinate: { lat: '10.0', lon: '20.0' } },
  propertyFilter: { salesTypes: ['ONE_ROOM', 'TWO_ROOM'] }, resolution: 14, surface: 'map',
} }, extensions: { persistedQuery: { version: 1, sha256Hash: 'a'.repeat(64) } } });

function helpers(extra = {}) {
  const context = vm.createContext({ URL, AbortSignal, ...extra });
  vm.runInContext(source('daangn-capture.js'), context);
  return { context, capture: vm.runInContext('HNW_DAANGN_CAPTURE', context), fetchPage: vm.runInContext('hnwFetchDaangnPage', context) };
}

function browser() {
  const events = [], fetches = [];
  const location = new URL(publicPage);
  class XMLHttpRequest {
    listeners = [];
    open(_method, url) { this.responseURL = url; }
    send() {}
    addEventListener(event, fn) { if (event === 'load') this.listeners.push(fn); }
    getResponseHeader() { return this.responseContentType; }
    receive(status, body, contentType) {
      this.status = status;
      this.responseText = body;
      this.responseContentType = contentType;
      for (const fn of this.listeners) fn();
    }
  }
  const pending = [];
  const window = { postMessage: event => events.push(event), fetch: (...args) => {
    fetches.push(args);
    return new Promise(resolve => pending.push(resolve));
  } };
  const context = vm.createContext({ window, location, URL, Request, XMLHttpRequest });
  vm.runInContext(source('daangn-capture.js'), context);
  vm.runInContext(source('hook.js'), context);
  async function receive(url, status, body, contentType = 'application/json') {
    pending.shift()({ url, status, headers: { get: () => contentType }, clone: () => ({ text: async () => body }) });
    await new Promise(resolve => setImmediate(resolve));
  }
  return { window, location, events, fetches, receive, XMLHttpRequest };
}

test('Daangn browser hook passively captures only projected public listing data and the verified cursor', async () => {
  const f = browser();
  f.location.searchParams.set('synthetic', 'tab-private');
  const target = `${graphql}?synthetic=discard`;
  const init = { method: 'POST', body: JSON.stringify({ variables: { after: 'cursor-a', private: 'discard' } }) };
  f.window.fetch(target, init);
  assert.deepEqual(f.fetches, [[target, init]], 'the browser request passes through unchanged');
  await f.receive(target, 200, JSON.stringify({ data: { viewer: { private: 'discard' }, articleFeed: {
    edges: [{ node: { article: { originalId: '101', isHideAddress: true, addressInfo: 'discard', viewer: { private: 'discard' }, region: { name3: 'Synthetic' } } } },
      { node: { advertisement: { private: 'discard' } } }],
    pageInfo: { hasNextPage: false, endCursor: 'cursor-b', other: 'discard' },
  } } }));
  const c = f.events[0];
  assert.equal(f.events.length, 1);
  assert.equal(c.url, graphql);
  assert.equal(c.requestPageUrl, publicPage);
  assert.deepEqual(JSON.parse(c.requestBody), { variables: { after: 'cursor-a' } });
  assert.doesNotMatch(c.body, /viewer|private|discard|addressInfo/);
  assert.equal(JSON.parse(c.body).data.articleFeed.edges[1].node.advertisement, true);
});

test('Daangn rejects unrelated or malformed responses and signals 403 and 429 without their response body', async () => {
  const f = browser();
  f.window.fetch(graphql);
  await f.receive(graphql, 200, '{"data":{"viewer":{"private":"discard"}}}');
  const unrelated = `${graphql}/other`;
  f.window.fetch(unrelated);
  await f.receive(unrelated, 403, 'discard', 'text/html');
  f.window.fetch(graphql);
  await f.receive(graphql, 403, 'discard', 'text/html');
  const xhr = new f.XMLHttpRequest();
  xhr.open('POST', graphql);
  xhr.send('discard');
  xhr.receive(429, 'discard', 'text/html');
  assert.deepEqual(f.events.map(c => [c.status, c.body, c.requestBody, c.requestPageUrl]), [[403, '', null, publicPage], [429, '', null, publicPage]]);
});

test('Daangn retains a GET cursor without forwarding the request query', async () => {
  const f = browser();
  const target = new URL(graphql);
  target.searchParams.set('variables', '{"after":null,"private":"discard"}');
  f.window.fetch(target.href);
  await f.receive(target.href, 200, '{"data":{"articleFeed":{"edges":[],"pageInfo":{"hasNextPage":false}}}}');
  assert.equal(f.events[0].url, graphql);
  assert.equal(f.events[0].requestBody, '{"variables":{"after":null}}');
});

test('Daangn ignores recommendation feeds that have no listing page cursor', async () => {
  const f = browser();
  f.window.fetch(graphql, { method: 'POST', body: JSON.stringify({ variables: { placementId: 'synthetic-placement', first: 20 } }) });
  await f.receive(graphql, 200, JSON.stringify({ data: { articleFeed: {
    edges: [], pageInfo: { hasNextPage: false, endCursor: null },
  } } }));
  assert.deepEqual(f.events, [], 'an unrelated empty feed cannot finish the listing traversal');
});

test('Daangn learns a public map request and replaces only its acknowledged cursor', () => {
  const { capture } = helpers();
  const initial = mapRequest();
  const raw = JSON.stringify(initial);
  const projected = capture.requestBody(raw);
  assert.deepEqual(JSON.parse(projected), initial);
  const next = capture.nextRequest(projected, 'cursor-next');
  assert.deepEqual(JSON.parse(next), { ...initial, variables: { ...initial.variables, after: 'cursor-next' } });
  assert.equal(initial.variables.after, null);
  assert.equal(capture.requestTemplate(next), next, 'worker validation keeps the exact public query stable');
  assert.equal(capture.nextRequest(next, null), null, 'a next page needs its received nonempty cursor');
  assert.equal(capture.nextRequest(next, ''), null);
  const target = new URL(graphql);
  target.searchParams.set('variables', JSON.stringify(initial.variables));
  target.searchParams.set('extensions', JSON.stringify(initial.extensions));
  assert.equal(capture.requestBody(null, target.href), projected);
});

test('Daangn unsupported search templates stay passive and cannot replay unknown fields or operations', () => {
  const { capture } = helpers();
  const cases = [
    request => { request.variables.private = 'discard'; },
    request => { request.variables.input.private = 'discard'; },
    request => { request.variables.input.locationFilter.private = 'discard'; },
    request => { request.variables.input.propertyFilter.private = 'discard'; },
    request => { request.variables.input.locationFilter.neCoordinate.private = 'discard'; },
    request => { request.extensions.private = 'discard'; },
    request => { request.query = 'mutation SyntheticMutation { synthetic }'; },
    request => { request.extensions.persistedQuery.sha256Hash = 'unverified'; },
    request => { request.variables.input.locationFilter.swCoordinate.lat = '12'; },
    request => { request.variables.input.locationFilter.neCoordinate.lon = '181'; },
    request => { request.variables.input.resolution = Infinity; },
    request => { request.variables.first = 0; },
    request => { request.variables.input.surface = 'https://example.invalid/private'; },
  ];
  for (const mutate of cases) {
    const request = mapRequest('cursor-a');
    mutate(request);
    const raw = JSON.stringify(request);
    assert.equal(capture.requestTemplate(raw), null);
    assert.equal(capture.nextRequest(raw, 'cursor-b'), null);
    assert.deepEqual(JSON.parse(capture.requestBody(raw)), { variables: { after: 'cursor-a' } });
  }
});

test('Daangn template metadata survives hook and worker projection without forwarding raw request fields', async () => {
  const f = browser();
  const request = mapRequest('cursor-a');
  const init = { method: 'POST', body: JSON.stringify(request) };
  f.window.fetch(graphql, init);
  await f.receive(graphql, 200, JSON.stringify({ data: { articleFeed: {
    edges: [], pageInfo: { hasNextPage: false, endCursor: 'cursor-b' },
  } } }));
  assert.deepEqual(JSON.parse(f.events[0].requestBody), request);
  const { capture } = helpers();
  const reprojected = capture.capture({ ...f.events[0], pageUrl: publicPage, template: { private: 'discard' } });
  assert.deepEqual(JSON.parse(reprojected.requestBody), request);
  assert.doesNotMatch(JSON.stringify(reprojected), /template|private|discard/);
});

test('Daangn public cursor executor uses its pinned document and the ordinary fetch capture path', async () => {
  const calls = [];
  const window = { __hnwHook: true, fetch: async (...args) => {
    calls.push(args);
    return { status: 200, headers: { get: () => 'application/json' } };
  } };
  const location = new URL(publicPage);
  const { capture, fetchPage } = helpers({ window, location, document: { querySelectorAll: () => [] } });
  const request = capture.nextRequest(JSON.stringify(mapRequest()), 'cursor-b');
  const response = await fetchPage(request, publicPage);
  assert.deepEqual(JSON.parse(JSON.stringify(response)), { status: 200, json: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], graphql);
  assert.equal(calls[0][1].body, request);
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(Object.keys(calls[0][1].headers), ['content-type']);
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].redirect, 'error');
  const moved = new URL(publicPage);
  moved.searchParams.set('region_bounds', '10,20,11,22,14');
  location.href = moved.href;
  assert.equal((await fetchPage(request, publicPage)).error, 'collection-document-missing');
  assert.equal(calls.length, 1);
  location.href = publicPage;
  assert.equal((await fetchPage(JSON.stringify({ variables: { after: 'cursor-b' } }), publicPage)).error, 'invalid-request');
  assert.equal(calls.length, 1);
});

test('Daangn public cursor executor reports access denial and visible security checks without continuing', async () => {
  const calls = [];
  const window = { __hnwHook: true, fetch: async (...args) => { calls.push(args); return { status: 403, headers: { get: () => 'text/html' } }; } };
  const elements = [];
  const { capture, fetchPage } = helpers({ window, location: new URL(publicPage), document: { querySelectorAll: () => elements },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  const request = capture.nextRequest(JSON.stringify(mapRequest()), 'cursor-b');
  assert.equal((await fetchPage(request, publicPage)).status, 403);
  assert.equal(calls.length, 1);
  elements.push({ tagName: 'IFRAME', getBoundingClientRect: () => ({ width: 200, height: 100 }), innerText: '' });
  assert.equal((await fetchPage(request, publicPage)).error, 'page-security-check');
  assert.equal(calls.length, 1);
});
