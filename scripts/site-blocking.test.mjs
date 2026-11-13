import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as format from '../shared/format.ts';
import * as geo from '../shared/geo.ts';
import * as types from '../server/collectors/types.ts';

function loadCollector(id, overrides = {}) {
  const code = ts.transpileModule(fs.readFileSync(new URL(`../server/collectors/${id}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const dependencies = {
    '../config.js': { PAGE_DELAY_MS: 0 }, '../geo.js': geo,
    './types.js': types, '../../shared/format.js': format, ...overrides,
  };
  const context = { exports: {}, URL, require: id => dependencies[id] };
  vm.runInNewContext(code, context);
  return context.exports[id];
}

function collect(collector, session, issues) {
  return collector.collect({
    areas: [{ name: '가상 지역', lat: 35, lng: 126, radiusM: 500 }],
    session: { rest: async () => {}, pause: async () => {}, badges: async () => {}, screenshot: async () => null, record() {}, ...session },
    log() {}, progress() {}, classify: () => new Map(),
    partial: (reason, retryable) => issues.push({ reason, retryable }),
  });
}

test('a blocked station stops the provider and keeps the earlier station results', async () => {
  const stations = ['가상역 하나', '가상역 둘', '가상역 셋'].map((name, index) => ({ name, lat: 35, lng: 126 + index / 1000 }));
  const collector = loadCollector('ziptoss', { '../station-catalog.js': { knownStations: () => stations } });

  const opened = [];
  const issues = [];
  let reads = 0;
  const result = await collect(collector, {
    page: {
      evaluate: async () => ++reads === 1 ? [{ id: 1111, type: 11 }] : 1,
      waitForLoadState: async () => {},
      waitForFunction: async () => {},
    },
    goto: async (_source, url) => { opened.push(url); return { status: () => opened.length === 1 ? 200 : 429 }; },
  }, issues);
  assert.equal(opened.length, 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].listing.sourceId, '1111');
  assert.equal(issues[0].retryable, false);
  assert.match(issues[0].reason, /429/);
});

function simulatedPage(emit, status = 403) {
  let listener;
  let navigation = '';
  const opened = [];
  const page = {
    on(_event, handler) { listener = handler; },
    off(_event, handler) { assert.equal(handler, listener); listener = undefined; },
    url: () => navigation,
    waitForResponse: async () => null,
    locator: () => ({ first: () => ({ isVisible: async () => false }), boundingBox: async () => null }),
  };
  const goto = async (_source, url) => {
    navigation = url;
    opened.push(url);
    if (opened.length > 1) return { status: () => status };
    const api = new URL(url);
    api.hostname = api.hostname.replace(/^(www\.)?/, 'api.');
    emit((path, body) => {
      const address = new URL(path, api);
      listener({ url: () => address.href, status: () => 200, json: async () => body });
    });
    return { status: () => 200 };
  };
  return { page, goto, opened, listening: () => !!listener };
}

test('a blocked map category keeps the completed category and detaches its response listener', async () => {
  const collector = loadCollector('peterpanz');
  const issues = [];
  const f = simulatedPage(emit => emit('/houses/area?pageIndex=1', {
    houses: { group: [{ hidx: 2222 }] }, totalCount: 1,
    debug: { search: { latitudeFrom: 34.99, latitudeTo: 35.01, longitudeFrom: 125.99, longitudeTo: 126.01 } },
  }));
  f.page.evaluate = async () => ({ listRight: 0, width: 900 });
  const result = await collect(collector, f, issues);
  assert.equal(f.opened.length, 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].listing.sourceId, '2222');
  assert.equal(issues[0].retryable, false);
  assert.match(issues[0].reason, /403/);
  assert.equal(f.listening(), false);
});

test('a blocked room category keeps verified district rows and detaches its response listener', async () => {
  const collector = loadCollector('gobang', { './gus.js': { gusFor: () => ['가상구'] } });
  const issues = [];
  const f = simulatedPage(emit => {
    emit('/v2/house-sigungus?category=fixture', { result: [{ sigunguCode: '99', sigunguName: '가상구', houseCount: 1 }] });
    emit('/v2/houses?dongliCode=99&pageNo=1', { result: [{ no: 3333 }] });
  }, 429);
  f.page.evaluate = async () => ({});
  const result = await collect(collector, f, issues);
  assert.equal(f.opened.length, 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].listing.sourceId, '3333');
  assert.equal(issues[0].retryable, false);
  assert.match(issues[0].reason, /429/);
  assert.equal(f.listening(), false);
});
