import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import naverLedger from '../server/naver-ledger.ts';
import {target as naverTarget,page as naverPage} from './fixtures/naver-region.mjs';

const source = fs.readFileSync(new URL('../extension/browse-page.js', import.meta.url), 'utf8');

// A small synthetic DOM exercises the actual message listener without loading a
// browser profile, site, configuration, or database. Unsupported selectors fail.
function matchesOne(el, selector) {
  const tag = selector.match(/^[a-z][a-z0-9]*/i)?.[0];
  if (tag && tag.toLowerCase() !== el.tag) return false;
  const attributes = [...selector.matchAll(/\[([\w-]+)(?:(\*=|=)"([^"]*)")?\]/g)];
  const rest = selector.replace(/^[a-z][a-z0-9]*/i, '').replace(/\[[^\]]*\]/g, '');
  assert.equal(rest, '', `Test DOM needs selector support: ${selector}`);
  return attributes.every(([, key, op, expected]) => {
    const value = el.getAttribute(key);
    return op === '=' ? value === expected : op === '*=' ? value?.includes(expected) : value !== null;
  });
}
function matches(el, selector) {
  return selector.split(',').some(part => matchesOne(el, part.trim()));
}
class Element {
  constructor(tag, options = {}) {
    this.tag = tag;
    this.attrs = options.attrs || {};
    this.ownText = options.text || '';
    this.style = { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'visible', ...options.style };
    this.rect = { left: 20, top: 20, width: 200, height: 100, ...options.rect };
    this.clientHeight = options.clientHeight ?? this.rect.height;
    this.scrollHeight = options.scrollHeight ?? this.clientHeight;
    this.scrollTop = options.scrollTop ?? 0;
    this.children = [];
    this.parentElement = null;
    this.clicks = 0;
    this.scrolls = [];
  }
  get textContent() { return [this.ownText, ...this.children.map(child => child.textContent)].filter(Boolean).join(' '); }
  set textContent(value) { this.ownText=String(value); this.children=[]; }
  get innerText() {
    return [this.ownText, ...this.children.filter(child => !Object.hasOwn(child.attrs, 'hidden') && child.style.display !== 'none' && child.style.visibility !== 'hidden').map(child => child.innerText)].filter(Boolean).join(' ');
  }
  append(...children) {
    for (const child of children) { child.parentElement = this; this.children.push(child); }
    return this;
  }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  setAttribute(name,value) {this.attrs[name]=String(value);}
  appendChild(child) {this.append(child);return child;}
  getBoundingClientRect() { return { ...this.rect, bottom: this.rect.top + this.rect.height, right: this.rect.left + this.rect.width }; }
  closest(selector) {
    for (let el = this; el; el = el.parentElement) if (matches(el, selector)) return el;
    return null;
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  contains(other) { for (let el = other; el; el = el.parentElement) if (el === this) return true; return false; }
  click() { this.clicks++; this.onClick?.(); }
  scrollTo({ top }) {
    this.scrollTop = Math.min(Math.max(top, 0), this.scrollHeight - this.clientHeight);
    this.scrolls.push(this.scrollTop);
    this.onScroll?.(this.scrollTop);
  }
}
const element = (tag, options) => new Element(tag, options);
function fixture(site = 'dabang') {
  let now = 100_000;
  let listener;
  let captureListener;
  let overlay;
  const body = element('body');
  const root = element('html').append(body);
  const domains = { naver: 'land.naver.com', dabang: 'www.dabangapp.com', zigbang: 'www.zigbang.com', kb: 'kbland.kr', hogangnono: 'hogangnono.com', daangn: 'www.daangn.com' };
  const location = new URL(`https://${domains[site]}/map`);
  const window = { addEventListener(type, fn) { if (type === 'message') captureListener = fn; } };
  const document = {
    body, documentElement: root,
    createElement: tag => element(tag),
    querySelectorAll: selector => root.querySelectorAll(selector),
    elementFromPoint(x, y) {
      if (overlay) return overlay;
      return [...root.querySelectorAll('button, a, [role="button"]')].reverse().find(el => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
      }) || body;
    },
  };
  const context = {
    URL, URLSearchParams, window, document, location, HNW_SITE: { id: site }, HNW_NAVER_LEDGER: naverLedger, innerHeight: 900, innerWidth: 1400,
    getComputedStyle: el => el.style,
    Date: class extends Date { static now() { return now; } },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
  };
  vm.runInNewContext(source, context);
  return {
    body, location,
    advance(ms) { now += ms; },
    overlay(el) { overlay = el; },
    filterContext(){let answer;listener({type:'naver-filter-context'},{},value=>{answer=value;});return answer;},
    requestStarted(order){captureListener({source:window,origin:location.origin,data:{__hnw:'naver-list-request',url:'https://fin.land.naver.com/front-api/v1/article/legalDivisionArticleList',requestOrder:order}});},
    indicator(extra) {listener({type:'browse-indicator',jobId:'synthetic-job',...extra},{},()=>{});return body.children.find(el=>el.attrs['aria-label']==='매물 수집 진행 상황');},
    step(extra = {}) {
      let answer;
      listener({ type: 'browse-step', site, jobId: 'synthetic-job', ...extra }, {}, value => { answer = value; });
      assert.ok(answer, 'content script must reply');
      return answer;
    },
    capture(payload = {}, event = {}) {
      const url = site === 'naver' ? 'https://land.naver.com/api/clusteredArticles'
        : site === 'dabang' ? 'https://api.dabangapp.com/api/v5/room-list/map'
          : 'https://apis.zigbang.com/house/property/v1/items/list';
      captureListener({ source: window, origin: location.origin, data: { __hnw: 'capture', status: 200, url, ...payload }, ...event });
    },
  };
}
function list(f, { id = 'synthetic-101', height = 1000, top = 0, attributes = {} } = {}) {
  const box = element('div', { style: { overflowY: 'auto' }, clientHeight: 200, scrollHeight: height, scrollTop: top, ...attributes });
  box.append(element('article', { attrs: { 'data-room-id': id } }));
  f.body.append(box);
  return box;
}
const dabang = id => ({ body: JSON.stringify({ result: { roomList: [{ seq: id }] } }) });
const dabangPage = (page, ids, { total = 3, limit = 1, hasMore = true, filters = 'synthetic', premium = [] } = {}) => ({
  url: `https://api.dabangapp.com/api/v5/room-list/category/one-two/bbox?filters=${filters}&page=${page}`,
  body: JSON.stringify({ result: { roomList: ids.map(seq => ({ seq })), premiumList: [{ roomList: premium.map(seq => ({ seq })) }], page, total, limit, hasMore, region: null } }),
});
const naver = (clusterId, ids) => ({ requestBody: JSON.stringify({ clusterId }), body: JSON.stringify({ result: { list: ids.map(articleNumber => ({ representativeArticleInfo: { articleNumber } })) } }) });
const bubble = (id, left) => element('button', { attrs: { 'data-nlogs-area': 'pin*art.bubble', 'data-cluster-id': id }, rect: { left, top: 400, width: 60, height: 50 }, text: '2개의 매물' });

test('Naver region traversal opens only the exact selected region and requires the final cursor page',()=>{
  const f=fixture('naver');
  const marker=element('button',{text:'가상구 매물 2 단지 1'}); f.body.append(marker);
  assert.equal(f.step({naverScope:naverTarget}).kind,'action'); assert.equal(marker.clicks,1);
  const panel=element('div',{attrs:{id:'region_detail'}}), box=element('div',{style:{overflowY:'auto'},clientHeight:200,scrollHeight:800});
  box.append(element('article',{attrs:{'data-article-id':'101'}})); panel.append(box); f.body.append(panel);
  f.capture(naverPage(['101'],{next:['a'],more:true,total:2}));
  assert.equal(f.step({naverScope:naverTarget}).kind,'action'); assert.ok(box.scrollTop>0);
  assert.notEqual(f.step({naverScope:naverTarget}).kind,'complete');
  f.capture(naverPage(['102'],{cursor:['a'],total:2}));
  assert.equal(f.step({naverScope:naverTarget}).waiting,true); f.advance(4000);
  assert.equal(f.step({naverScope:naverTarget}).naverCoverage.complete,true);
});

test('Naver blocked or changed region results do not trigger a generic map-bubble fallback',()=>{
  const f=fixture('naver'); f.capture(naverPage(['101'],{filter:{legalDivisionNumbers:['9988800000']}}));
  const unrelated=bubble('unrelated',30); f.body.append(unrelated);
  assert.notEqual(f.step({naverScope:naverTarget}).kind,'complete'); assert.equal(unrelated.clicks,0);
});

test('filter context returns current URL despite camera changes and pending or out-of-order responses',()=>{
  const f=fixture('naver');assert.equal(f.filterContext().pageUrl,f.location.href);
  f.requestStarted(1);f.capture({...naverPage(),requestOrder:1,requestPageUrl:f.location.href});
  assert.equal(f.filterContext().pageUrl,f.location.href);
  f.requestStarted(2);assert.equal(f.filterContext().pageUrl,f.location.href);
  f.capture({...naverPage(),requestOrder:2,requestPageUrl:f.location.href});assert.equal(f.filterContext().pageUrl,f.location.href);
  f.capture({...naverPage(),requestOrder:1,requestPageUrl:f.location.href});assert.equal(f.filterContext().pageUrl,f.location.href);
  f.location.search='?zoom=12.015&center=another-camera';assert.equal(f.filterContext().pageUrl,f.location.href);
});

test('the owned collection page visibly distinguishes running counts from a partial stop',()=>{
  const f=fixture('naver');
  const box=f.indicator({areaName:'가상구',state:'running',status:'running',pages:3,received:90,total:8000,stored:90,lastAt:100000,message:'다음 목록 확인 중'});
  assert.match(box.textContent,/수집 중/); assert.match(box.textContent,/수신 90\/8000건, 저장 90건/);
  f.indicator({areaName:'가상구',state:'done',status:'partial',pages:3,received:90,total:8000,stored:90,lastAt:100000,message:'다음 응답을 받지 못했습니다'});
  assert.match(box.textContent,/일부 확인, 수집 멈춤/); assert.doesNotMatch(box.textContent,/선택 조건 저장 완료/);
  const other=fixture('dabang'); assert.equal(other.indicator({state:'running'}),undefined);
});

test('only successful, same-window/site listing responses authorize a bounded list scroll', () => {
  const f = fixture();
  const box = list(f);
  const payload = dabang('synthetic-101');
  assert.equal(f.step().kind, 'idle');
  f.capture(payload, { origin: 'https://example.invalid' });
  f.capture(payload, { source: {} });
  f.capture({ ...payload, url: 'https://example.invalid/api/v5/room-list/map' });
  f.capture({ ...payload, status: 403 });
  f.capture({ ...payload, status: undefined });
  assert.equal(f.step().kind, 'idle');
  assert.equal(box.scrollTop, 0);
  f.capture(payload);
  assert.equal(f.step().kind, 'action');
  assert.equal(box.scrollTop, 160);
  for (let i = 0; i < 5; i++) f.step();
  assert.equal(box.scrollTop, 800);
  assert.ok(box.scrolls.every((top, i, all) => top <= 800 && top - (all[i - 1] || 0) <= 160));
});

test('a matched card inside a dialog never authorizes scrolling', () => {
  const f = fixture();
  const box = list(f);
  f.body.children = [];
  f.body.append(element('div', { attrs: { role: 'dialog' } }).append(box));
  f.capture(dabang('synthetic-101'));
  assert.equal(f.step().kind, 'idle');
  assert.equal(box.scrollTop, 0);
});

test('pagination clicks are limited to the verified list and wait for another response', () => {
  const f = fixture();
  const box = list(f, { height: 200 });
  const contact = element('button', { text: '연락하기', rect: { left: 30, top: 30 } });
  const more = element('button', { text: '매물 더 보기', rect: { left: 30, top: 160 } });
  const unrelated = element('button', { text: '더 보기', rect: { left: 600, top: 30 } });
  box.append(contact, more);
  f.body.append(unrelated);
  f.capture(dabang('synthetic-101'));
  assert.equal(f.step().kind, 'action');
  assert.equal(more.clicks, 1);
  assert.equal(contact.clicks + unrelated.clicks, 0);
  assert.equal(f.step().waiting, true);
  f.advance(12_001);
  assert.equal(f.step().waiting, false);
  assert.equal(more.clicks, 1);
  f.capture(dabang('synthetic-102'));
  assert.equal(f.step().kind, 'action');
  assert.equal(more.clicks, 2);
});

test('overlay-covered pagination is never clicked', () => {
  const f = fixture();
  const box = list(f, { height: 200 });
  const more = element('button', { text: '더 보기' });
  box.append(more);
  f.overlay(element('div'));
  f.capture(dabang('synthetic-101'));
  assert.equal(f.step().kind, 'idle');
  assert.equal(more.clicks, 0);
});

test('Naver drains the selected cluster and waits for stable end before selecting another', () => {
  const f = fixture('naver');
  const first = bubble('synthetic-cluster-a', 400);
  const second = bubble('synthetic-cluster-b', 500);
  f.body.append(first, second);
  assert.equal(f.step().kind, 'action');
  assert.equal(first.clicks, 1);
  assert.equal(f.step().waiting, true);
  assert.equal(second.clicks, 0);
  const box = list(f, { id: 'synthetic-201', height: 520 });
  f.capture(naver('synthetic-cluster-a', ['synthetic-201']));
  assert.equal(f.step().kind, 'action');
  assert.equal(box.scrollTop, 160);
  assert.equal(second.clicks, 0);
  assert.equal(f.step().kind, 'action');
  assert.equal(box.scrollTop, 320);
  assert.equal(f.step().waiting, true);
  f.advance(4_999);
  assert.equal(f.step().waiting, true);
  assert.equal(second.clicks, 0);
  f.advance(1);
  assert.equal(f.step().kind, 'action');
  assert.equal(second.clicks, 1);
  assert.equal(first.clicks, 1);
});

test('Naver does not hide an unrecognized nonempty list by moving to another cluster', () => {
  const f = fixture('naver');
  const first = bubble('synthetic-cluster-a', 400);
  const second = bubble('synthetic-cluster-b', 500);
  f.body.append(first, second);
  f.step();
  f.capture(naver('synthetic-cluster-a', ['synthetic-201']));
  f.advance(30_000);
  assert.equal(f.step().kind, 'idle');
  assert.equal(second.clicks, 0);
});

test('Naver moves past a confirmed empty cluster after settling', () => {
  const f = fixture('naver');
  const first = bubble('synthetic-cluster-a', 400);
  const second = bubble('synthetic-cluster-b', 500);
  f.body.append(first, second);
  f.step();
  f.capture(naver('synthetic-cluster-a', []));
  assert.equal(f.step().waiting, true);
  f.advance(5_000);
  assert.equal(f.step().kind, 'action');
  assert.equal(second.clicks, 1);
});

test('visible security and login gates are blocked on supported and observation-only sites', () => {
  for (const site of ['naver', 'dabang', 'zigbang', 'kb', 'hogangnono', 'daangn']) {
    const f = fixture(site);
    f.body.append(element('div', { attrs: { role: 'dialog' }, text: '로그인이 필요합니다' }));
    assert.equal(f.step().kind, 'blocked', site);
    f.body.children = [element('iframe', { attrs: { src: 'https://example.invalid/captcha' }, rect: { width: 240, height: 100 } })];
    assert.equal(f.step().kind, 'blocked', site);
    f.body.children = [element('h1', { text: 'Access denied' })];
    assert.equal(f.step().kind, 'blocked', site);
  }
});

test('hidden gates and an ordinary sign-in navigation button do not block observation-only pages', () => {
  const f = fixture('kb');
  f.body.append(element('div', { attrs: { hidden: '' } }).append(element('h1', { text: 'Access denied' })));
  f.body.append(element('nav').append(element('button', { text: '로그인' })));
  assert.equal(f.step().kind, 'unsupported');
});

test('continuous incoming pages cannot exceed the per-page action budget', () => {
  const f = fixture('zigbang');
  const box = list(f, { id: 'synthetic-301', height: 100_000 });
  f.capture({ body: JSON.stringify({ items: [{ item_id: 'synthetic-301' }] }) });
  for (let i = 0; i < 40; i++) assert.equal(f.step().kind, 'action');
  assert.equal(f.step().kind, 'idle');
  assert.equal(box.scrolls.length, 40);
});

test('Zigbang DIV cards with a received title and price authorize their enclosing list scroll', () => {
  const f = fixture('zigbang');
  const box = element('div', { style: { overflowY: 'auto' }, clientHeight: 200, scrollHeight: 1000 });
  const card = element('div', { attrs: { id: 'animatedComponent' } }).append(
    element('div', { text: 'Synthetic bright room' }),
    element('div', { text: '월세 1,000/45' }),
  );
  box.append(card);
  f.body.append(box);
  assert.equal(f.step().kind, 'idle');
  f.capture({ body: JSON.stringify({ items: [{ item_id: 'synthetic-401', title: 'Synthetic bright room' }] }) });
  assert.equal(f.step().kind, 'action');
  assert.equal(box.scrollTop, 160);
  assert.equal(card.clicks, 0);
});

test('Zigbang DIV cards without matching title and bounded price text never authorize scrolling', () => {
  for (const [title, price] of [
    ['Unrelated room', '월세 1,000/45'],
    ['Synthetic bright room', '가격 문의'],
    ['Synthetic bright room', `월세 1,000/45 ${'extra '.repeat(300)}`],
  ]) {
    const f = fixture('zigbang');
    const box = element('div', { style: { overflowY: 'auto' }, clientHeight: 200, scrollHeight: 1000 });
    box.append(element('div', { attrs: { id: 'animatedComponent' } }).append(
      element('div', { text: title }), element('div', { text: price }),
    ));
    f.body.append(box);
    f.capture({ body: JSON.stringify({ items: [{ item_id: 'synthetic-401', title: 'Synthetic bright room' }] }) });
    assert.equal(f.step().kind, 'idle');
    assert.equal(box.scrollTop, 0);
  }
});

test('the additional DIV card selector is restricted to Zigbang', () => {
  const f = fixture('dabang');
  const box = element('div', { style: { overflowY: 'auto' }, clientHeight: 200, scrollHeight: 1000 });
  box.append(element('div', { attrs: { id: 'animatedComponent' }, text: 'Synthetic bright room 월세 1,000/45' }));
  f.body.append(box);
  f.capture({ body: JSON.stringify({ result: { roomList: [{ seq: 'synthetic-401', roomTitle: 'Synthetic bright room' }] } }) });
  assert.equal(f.step().kind, 'idle');
  assert.equal(box.scrollTop, 0);
});

test('Dabang numeric pagination follows response pages, excludes advertising IDs, and waits for requested page', () => {
  const f = fixture();
  const box = list(f, { id: '101', height: 200 });
  const unrelated = element('button', { text: '2', rect: { left: 600, top: 20 } });
  const two = element('button', { text: '2', rect: { left: 20, top: 220 } });
  const three = element('button', { text: '3', rect: { left: 240, top: 220 } });
  box.append(two, three);
  f.body.append(unrelated);
  f.capture(dabangPage(1, [101], { premium: [999] }));
  const first = f.step();
  assert.equal(first.kind, 'action');
  assert.equal(first.coverage.regularUnique, 1);
  assert.equal(two.clicks, 1);
  assert.equal(three.clicks + unrelated.clicks, 0);
  assert.equal(f.step().waiting, true);
  f.advance(12001);
  assert.equal(f.step().waiting, false);
  assert.equal(two.clicks, 1);
  f.capture(dabangPage(2, [102]));
  assert.equal(f.step().kind, 'action');
  assert.equal(three.clicks, 1);
  f.capture(dabangPage(3, [103], { hasMore: false }));
  assert.equal(f.step().waiting, true);
  f.advance(3000);
  const end = f.step();
  assert.equal(end.kind, 'idle', 'bbox coverage cannot establish full-region completion');
  assert.equal(end.coverage.pages, 3);
  assert.equal(end.coverage.regularUnique, 3);
  assert.equal(end.coverage.lastPage, 3);
  assert.equal(end.coverage.complete, false);
});

test('Dabang uses one scroll to reach known pagination and can continue beyond 40 actions', () => {
  const f = fixture();
  const box = list(f, { id: '101', height: 10000 });
  const next = element('button', { text: '다음 페이지' });
  box.append(next);
  f.capture(dabangPage(1, [101], { total: 51 }));
  assert.equal(f.step().kind, 'action');
  assert.equal(box.scrollTop, 9800);
  for (let page = 1; page <= 50; page++) {
    if (page > 1) f.capture(dabangPage(page, [100 + page], { total: 51 }));
    assert.equal(f.step().kind, 'action');
  }
  assert.equal(next.clicks, 50);
  f.capture(dabangPage(51, [151], { total: 51, hasMore: false }));
  f.advance(3000);
  assert.equal(f.step().coverage.regularUnique, 51);
});

test('Dabang never clicks a numbered page outside its verified list or through an overlay', () => {
  for (const covered of [false, true]) {
    const f = fixture();
    const box = list(f, { id: '101', height: 200 });
    const two = element('button', { text: '2' });
    if (covered) { box.append(two); f.overlay(element('div')); }
    else f.body.append(two);
    f.capture(dabangPage(1, [101]));
    assert.equal(f.step().kind, 'idle');
    assert.equal(two.clicks, 0);
  }
});

test('Dabang stops when filters, totals, or a repeated page change during traversal', () => {
  for (const change of ['filters', 'total', 'replay']) {
    const f = fixture();
    const box = list(f, { id: '101', height: 200 });
    const next = element('button', { text: '다음 페이지' });
    box.append(next);
    f.capture(dabangPage(1, [101]));
    f.step();
    f.capture(change === 'filters' ? dabangPage(2, [102], { filters: 'changed' })
      : change === 'total' ? dabangPage(2, [102], { total: 4 }) : dabangPage(1, [102]));
    const answer = f.step();
    assert.equal(answer.kind, 'idle');
    assert.equal(answer.waiting, false);
    assert.equal(answer.coverage.complete, false);
    assert.equal(next.clicks, 1);
  }
});

test('Dabang replay does not inflate unique coverage and missing pages cannot complete', () => {
  const f = fixture();
  list(f, { id: '101', height: 200 });
  f.capture(dabangPage(1, [101]));
  f.capture(dabangPage(1, [101]));
  f.capture(dabangPage(3, [103], { hasMore: false }));
  f.advance(3000);
  const answer = f.step();
  assert.equal(answer.coverage.pages, 2);
  assert.equal(answer.coverage.regularUnique, 2);
  assert.equal(answer.coverage.complete, false);
});

const regionScope = (id = '900001') => ({
  kind: 'dabang-region', name: '예시시 예시구 예시동', dong: '예시동',
  url: `https://www.dabangapp.com/map/onetwo?search_type=region&search_id=${id}`,
});
const regionPage = (page, ids, { total = 3, limit = 1, hasMore = page < Math.max(1, Math.ceil(total / limit)),
  filters = 'synthetic', region = { gid: 900001, code: '99999101', name: '예시동' }, code = '99999101',
  dong = '예시동', viewport = '', premium = [] } = {}) => ({
  url: `https://www.dabangapp.com/api/v5/room-list/category/one-two/region?code=${code}&filters=${filters}&page=${page}${viewport}`,
  body: JSON.stringify({ result: { roomList: ids.map(seq => ({ seq, dongName: dong })),
    premiumList: [{ roomList: premium.map(seq => ({ seq, dongName: '다른예시동' })) }], page, total, limit, hasMore, region } }),
});

test('Dabang scoped traversal ignores bbox responses and completes a verified contiguous region list', () => {
  const f = fixture();
  const scope = regionScope();
  f.location.href = scope.url;
  const box = list(f, { id: '101', height: 200 });
  const next = element('button', { attrs: { 'aria-label': '다음 페이지' } });
  box.append(next);
  f.capture(dabangPage(1, [901], { total: 100 }));
  assert.equal(f.step({ scope }).waiting, true);
  assert.equal(next.clicks, 0, 'an initial bbox must not authorize region traversal');
  f.capture(regionPage(1, [101], { premium: [999] }));
  f.capture(dabangPage(2, [902], { total: 100 }));
  assert.equal(f.step({ scope }).kind, 'action', 'a later bbox must not replace the region stream');
  f.capture(regionPage(2, [102], { viewport: '&bbox=changed&zoom=15&useMap=naver' }));
  box.children[0].attrs['data-room-id'] = '102';
  assert.equal(f.step({ scope }).kind, 'action', 'viewport changes do not change a fixed region query');
  f.capture(regionPage(3, [103]));
  assert.equal(f.step({ scope }).waiting, true);
  f.advance(3000);
  const answer = f.step({ scope });
  assert.equal(answer.kind, 'complete');
  assert.equal(answer.coverage.complete, true);
  assert.equal(answer.coverage.regularUnique, 3);
  assert.equal(answer.coverage.pages, 3);
  assert.equal(answer.coverage.reason, 'complete');
  assert.equal(next.clicks, 2);
});

test('Dabang a verified empty region list completes without needing a card or pagination control', () => {
  const f = fixture();
  const scope = regionScope();
  f.location.href = scope.url;
  f.capture(regionPage(1, [], { total: 0, limit: 24 }));
  f.advance(3000);
  const answer = f.step({ scope });
  assert.equal(answer.kind, 'complete');
  assert.equal(answer.coverage.total, 0);
  assert.equal(answer.coverage.pages, 1);
});

test('Dabang region pagination cannot use cards authorized only by an unrelated bbox response', () => {
  const f = fixture();
  const scope = regionScope();
  f.location.href = scope.url;
  const box = list(f, { id: '901', height: 200 });
  const next = element('button', { text: '다음 페이지' });
  box.append(next);
  f.capture(dabangPage(1, [901]));
  f.capture(regionPage(1, [101]));
  const answer = f.step({ scope });
  assert.equal(answer.kind, 'idle');
  assert.equal(next.clicks, 0);
  box.children[0].attrs['data-room-id'] = '101';
  assert.equal(f.step({ scope }).kind, 'action');
});

test('Dabang delayed replay of an earlier page does not regress the active page', () => {
  const f = fixture();
  const scope = regionScope();
  f.location.href = scope.url;
  const box = list(f, { id: '101', height: 200 });
  const next = element('button', { text: '다음 페이지' });
  box.append(next);
  f.capture(regionPage(1, [101]));
  f.step({ scope });
  f.capture(regionPage(2, [102]));
  box.children[0].attrs['data-room-id'] = '102';
  f.step({ scope });
  f.capture(regionPage(1, [101]));
  const waiting = f.step({ scope });
  assert.equal(waiting.coverage.currentPage, 2);
  assert.equal(waiting.waiting, true);
  assert.equal(next.clicks, 2);
});

test('Dabang region proof requires matching endpoint, gid, code and dong before any action', () => {
  for (const change of [
    { region: { gid: 900002, code: '99999101', name: '예시동' } },
    { region: { gid: 900001, code: '99999102', name: '예시동' } },
    { region: { gid: 900001, code: '99999101', name: '다른예시동' } },
    { code: '99999101&code=99999102' },
  ]) {
    const f = fixture();
    const scope = regionScope();
    f.location.href = scope.url;
    const box = list(f, { id: '101', height: 200 });
    const next = element('button', { text: '다음 페이지' });
    box.append(next);
    f.capture(regionPage(1, [101], change));
    assert.equal(f.step({ scope }).waiting, true);
    f.advance(15000);
    const answer = f.step({ scope });
    assert.notEqual(answer.kind, 'complete');
    assert.equal(answer.waiting, false);
    assert.equal(next.clicks, 0);
  }
});

test('Dabang missing, duplicate or outside-dong regular rows cannot establish completion', () => {
  for (const kind of ['missing-page', 'duplicate-id', 'outside-dong', 'missing-dong']) {
    const f = fixture();
    const scope = regionScope();
    f.location.href = scope.url;
    if (kind === 'missing-page') {
      f.capture(regionPage(1, [101]));
      f.capture(regionPage(3, [103]));
    } else if (kind === 'duplicate-id') {
      f.capture(regionPage(1, [101], { total: 2 }));
      f.capture(regionPage(2, [101], { total: 2 }));
    } else f.capture(regionPage(1, [101], { total: 1, dong: kind === 'missing-dong' ? null : '다른예시동' }));
    f.advance(3000);
    const answer = f.step({ scope });
    assert.equal(answer.kind, 'idle', kind);
    assert.equal(answer.coverage.complete, false, kind);
  }
});

test('Dabang changed scoped filters cannot report complete even when the replacement list has one page', () => {
  const f = fixture();
  const scope = regionScope();
  f.location.href = scope.url;
  const box = list(f, { id: '101', height: 200 });
  box.append(element('button', { text: '다음 페이지' }));
  f.capture(regionPage(1, [101]));
  f.step({ scope });
  f.capture(regionPage(1, [102], { total: 1, filters: 'changed' }));
  f.advance(3000);
  const answer = f.step({ scope });
  assert.equal(answer.kind, 'idle');
  assert.equal(answer.coverage.complete, false);
  assert.equal(answer.coverage.reason, 'changed-results');
});

test('Dabang malformed or changed region responses invalidate an earlier valid stream', () => {
  for (const kind of ['region', 'metadata', 'row-dong']) {
    const f = fixture();
    const scope = regionScope();
    f.location.href = scope.url;
    f.capture(regionPage(1, [101], { total: 1 }));
    const bad = regionPage(1, [101], { total: 1,
      ...(kind === 'region' ? { region: { gid: 900002, code: '99999101', name: '예시동' } } : {}),
      ...(kind === 'row-dong' ? { dong: '다른예시동' } : {}) });
    if (kind === 'metadata') {
      const data = JSON.parse(bad.body);
      delete data.result.page;
      bad.body = JSON.stringify(data);
    }
    f.capture(bad);
    f.advance(3000);
    const answer = f.step({ scope });
    assert.notEqual(answer.kind, 'complete', kind);
    assert.equal(answer.coverage?.complete ?? false, false, kind);
  }
});

test('Dabang scoped jobs require the same selected region and never fall back while metadata is missing', () => {
  const f = fixture();
  const scope = regionScope();
  f.location.href = scope.url;
  const box = list(f, { id: '101' });
  f.capture(dabang(101));
  assert.equal(f.step({ scope }).waiting, true);
  assert.equal(box.scrollTop, 0);
  f.advance(15000);
  assert.equal(f.step({ scope }).waiting, false);
  assert.equal(box.scrollTop, 0);
  f.location.searchParams.set('search_id', '900002');
  assert.equal(f.step({ scope }).kind, 'blocked');
});

test('Dabang scope cannot change or disappear within a job', () => {
  for (const changed of [regionScope('900002'), undefined, { ...regionScope(), dong: '다른예시동' }]) {
    const f = fixture();
    const scope = regionScope();
    f.location.href = scope.url;
    f.step({ scope });
    assert.equal(f.step({ scope: changed }).kind, 'blocked');
  }
});

test('Dabang malformed or unrelated region URLs cannot authorize any action', () => {
  for (const url of [
    'https://example.invalid/map/onetwo?search_type=region&search_id=900001',
    'https://www.dabangapp.com/map/onetwo?search_type=region&search_id=900001&search_id=900002',
    'https://www.dabangapp.com/map/onetwo?search_type=station&search_id=900001',
    'https://www.dabangapp.com/map/apt?search_type=region&search_id=900001',
  ]) {
    const f = fixture();
    const box = list(f, { id: '101' });
    f.capture(dabangPage(1, [101]));
    assert.equal(f.step({ scope: { ...regionScope(), url } }).kind, 'blocked');
    assert.equal(box.scrollTop, 0);
  }
});

test('Dabang pagination can be a sibling of the matched scroll box inside the observed list panel', () => {
  const f = fixture();
  const box = list(f, { id: '101', height: 200 });
  const two = element('button', { text: '2', rect: { left: 20, top: 220 } });
  const panel = element('div', { attrs: { id: 'onetwo-list' } }).append(box, element('div').append(two));
  f.body.children = [];
  f.body.append(panel);
  f.capture(dabangPage(1, [101]));
  assert.equal(f.step().kind, 'action');
  assert.equal(two.clicks, 1);
});

test('Dabang inconsistent pagination metadata never authorizes another page', () => {
  for (const options of [
    { total: 1, hasMore: true },
    { total: 3, hasMore: false },
    { total: 3, limit: 2, hasMore: true },
  ]) {
    const f = fixture();
    const box = list(f, { id: '101', height: 200 });
    const two = element('button', { text: '2' });
    box.append(two);
    f.capture(dabangPage(1, [101], options));
    const answer = f.step();
    assert.equal(answer.kind, 'idle');
    assert.equal(answer.coverage.reason, 'changed-results');
    assert.equal(two.clicks, 0);
  }
});

const zigbangStationPage = 'https://www.zigbang.com/home/oneroom/subways/900001/items';
const zigbangStationList = (ids, query = 'radius=1&depositMin=0', station = '900001') => ({
  url: `https://apis.zigbang.com/house/property/v1/items/subways/${station}/onerooms?${query}`,
  body: JSON.stringify({ items: ids.map(id => ({ id })) }),
});
const zigbangDetails = ids => ({ body: JSON.stringify({ items: ids.map(item_id => ({
  item_id, title: `Synthetic room ${item_id}`, location: { lat: 35.1, lng: 128.1 },
})) }) });

test('Zigbang station traversal continues beyond 40 actions and two minutes until every expected detail arrives', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  const box = list(f, { id: '101', height: 100000 });
  f.capture(zigbangStationList([101, 102, 103]));
  f.capture(zigbangDetails([101, 999]));
  for (let i = 0; i < 45; i++) assert.equal(f.step().kind, 'action');
  f.advance(120001);
  const progress = f.step();
  assert.equal(progress.kind, 'action');
  assert.equal(progress.zigbangCoverage.total, 3);
  assert.equal(progress.zigbangCoverage.received, 1, 'advertising IDs do not increase coverage');
  assert.equal(progress.zigbangCoverage.missing, 2);
  assert.match(progress.note, /상세 1\/3.*미수신 2/);
  f.capture(zigbangDetails([102, 103]));
  assert.equal(f.step().waiting, true);
  f.advance(3000);
  const finished = f.step();
  assert.equal(finished.kind, 'complete');
  assert.equal(finished.zigbangCoverage.complete, true);
  assert.equal(finished.zigbangCoverage.received, 3);
  assert.equal(box.scrolls.length, 46);
});

test('Zigbang station proof buffers details before the list and accepts the same set in another order', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  f.capture(zigbangDetails([101, 102, 999]));
  const beforeList = f.step();
  assert.equal(beforeList.kind, 'idle');
  assert.equal(beforeList.zigbangCoverage.reason, 'missing-list');
  f.capture(zigbangStationList([102, 101]));
  f.capture(zigbangStationList([101, 102], 'depositMin=0&radius=1'));
  f.advance(3000);
  const answer = f.step();
  assert.equal(answer.kind, 'complete');
  assert.equal(answer.zigbangCoverage.received, 2);
});

test('Zigbang a verified empty station list completes without a card or detail response', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  f.capture(zigbangStationList([]));
  f.advance(3000);
  const answer = f.step();
  assert.equal(answer.kind, 'complete');
  assert.equal(answer.zigbangCoverage.total, 0);
  assert.equal(answer.zigbangCoverage.received, 0);
});

test('Zigbang an advertisement card alone never authorizes a station list scroll', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  const box = list(f, { id: '999', height: 1000 });
  f.capture(zigbangStationList([101]));
  f.capture(zigbangDetails([999]));
  const answer = f.step();
  assert.equal(answer.kind, 'idle');
  assert.equal(answer.zigbangCoverage.missing, 1);
  assert.equal(box.scrollTop, 0);
});

test('Zigbang stable list end with missing details stops waiting and cannot claim completion', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  const box = list(f, { id: '101', height: 200 });
  f.capture(zigbangStationList([101, 102]));
  f.capture(zigbangDetails([101]));
  assert.equal(f.step().waiting, true);
  f.advance(5000);
  const answer = f.step();
  assert.equal(answer.kind, 'idle');
  assert.equal(answer.waiting, false);
  assert.equal(answer.zigbangCoverage.complete, false);
  assert.equal(answer.zigbangCoverage.reason, 'missing-details');
  assert.match(answer.note, /상세 1\/2.*미수신 1/);
  assert.equal(box.scrolls.length, 0);
});

test('Zigbang re-enters a verified list bottom to receive a final partial lazy-loaded batch', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  const box = list(f, { id: '101', height: 600, top: 400 });
  const expected = Array.from({ length: 11 }, (_, i) => 101 + i);
  f.capture(zigbangStationList(expected));
  f.capture(zigbangDetails(expected.slice(0, 8)));
  let leftBottom = false;
  box.onScroll = top => {
    if (top < 400) leftBottom = true;
    if (leftBottom && top === 400) f.capture(zigbangDetails(expected.slice(8)));
  };
  assert.equal(f.step().waiting, true);
  f.advance(5000);
  const retry = f.step();
  assert.equal(retry.kind, 'action');
  assert.match(retry.note, /목록 끝.*다시.*1\/3/);
  assert.equal(box.scrollTop, 150);
  assert.equal(retry.zigbangCoverage.missing, 3);
  assert.equal(f.step().kind, 'action');
  assert.equal(f.step().kind, 'action');
  assert.equal(box.scrollTop, 400);
  assert.equal(f.step().waiting, true);
  f.advance(3000);
  const answer = f.step();
  assert.equal(answer.kind, 'complete');
  assert.equal(answer.zigbangCoverage.received, expected.length);
  assert.equal(answer.zigbangCoverage.missing, 0);
  assert.equal(box.scrolls.length, 3);
});

test('Zigbang recovery leaves a strict one-viewport end threshold before re-entering it', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  const box = list(f, { id: '101', height: 1000, top: 800 });
  f.capture(zigbangStationList([101, 102]));
  f.capture(zigbangDetails([101]));
  let sentForCurrentHeight = true;
  let endCalls = 0;
  box.onScroll = top => {
    const remaining = box.scrollHeight - box.clientHeight - top;
    if (remaining > box.clientHeight) sentForCurrentHeight = false;
    if (remaining < box.clientHeight && !sentForCurrentHeight) {
      sentForCurrentHeight = true;
      endCalls++;
      f.capture(zigbangDetails([102]));
    }
  };
  assert.equal(f.step().waiting, true);
  f.advance(5000);
  assert.equal(f.step().kind, 'action');
  assert.ok(box.scrollHeight - box.clientHeight - box.scrollTop > box.clientHeight,
    'an exact one-viewport jog leaves the end latch set');
  assert.equal(f.step().kind, 'action');
  assert.equal(endCalls, 1);
  assert.equal(f.step().waiting, true);
  f.advance(3000);
  assert.equal(f.step().kind, 'complete');
});

test('Zigbang a short scroll range that cannot leave the end threshold stops incomplete', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  const box = list(f, { id: '101', height: 350, top: 150 });
  f.capture(zigbangStationList([101, 102]));
  f.capture(zigbangDetails([101]));
  assert.equal(f.step().waiting, true);
  f.advance(5000);
  const answer = f.step();
  assert.equal(answer.kind, 'idle');
  assert.equal(answer.waiting, false);
  assert.equal(answer.zigbangCoverage.complete, false);
  assert.equal(answer.zigbangCoverage.missing, 1);
  assert.equal(box.scrolls.length, 0);
});

test('Zigbang list-end recovery is bounded and duplicate or advertising responses do not renew it', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  const box = list(f, { id: '101', height: 600, top: 400 });
  f.capture(zigbangStationList([101, 102]));
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.capture(zigbangDetails([101, 999]));
    assert.equal(f.step().waiting, true);
    f.advance(5000);
    const retry = f.step();
    assert.equal(retry.kind, 'action');
    assert.match(retry.note, new RegExp(`${attempt}/3`));
    while (box.scrollTop < 400) assert.equal(f.step().kind, 'action');
  }
  f.capture(zigbangDetails([101, 999]));
  assert.equal(f.step().waiting, true);
  f.advance(5000);
  const exhausted = f.step();
  assert.equal(exhausted.kind, 'idle');
  assert.equal(exhausted.waiting, false);
  assert.equal(exhausted.zigbangCoverage.complete, false);
  assert.equal(exhausted.zigbangCoverage.received, 1);
  assert.equal(exhausted.zigbangCoverage.missing, 1);
  assert.match(exhausted.note, /3회 다시 확인.*받지 못했습니다/);
  assert.equal(box.scrolls.length, 9);
  assert.equal(f.step().kind, 'idle');
  assert.equal(box.scrolls.length, 9);
});

test('Zigbang only newly readable expected details renew list-end recovery and a new job starts fresh', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  const box = list(f, { id: '101', height: 600, top: 400 });
  f.capture(zigbangStationList([101, 102, 103, 104]));
  f.capture(zigbangDetails([101]));
  const recover = (stepExtra = {}) => {
    assert.equal(f.step(stepExtra).waiting, true);
    f.advance(5000);
    const answer = f.step(stepExtra);
    while (box.scrollTop < 400) assert.equal(f.step(stepExtra).kind, 'action');
    return answer;
  };
  for (let attempt = 1; attempt <= 3; attempt++) assert.equal(recover().kind, 'action');
  f.capture({ body: JSON.stringify({ items: [{ item_id: 102, location: { lat: 999, lng: 128 } }] }) });
  assert.equal(recover().kind, 'idle', 'an unreadable expected detail is not progress');
  f.capture(zigbangDetails([102]));
  const renewed = recover();
  assert.equal(renewed.kind, 'action');
  assert.match(renewed.note, /1\/3/);
  for (let attempt = 2; attempt <= 3; attempt++) assert.equal(recover().kind, 'action');
  assert.equal(recover().kind, 'idle');
  const newJob = recover({ jobId: 'synthetic-job-new' });
  assert.equal(newJob.kind, 'action');
  assert.match(newJob.note, /1\/3/);
});

test('Zigbang changes to station, filters, radius or expected ID set invalidate completion permanently', () => {
  for (const [capture, reason] of [
    [zigbangStationList([101], 'radius=1&depositMin=0', '900002'), 'station-changed'],
    [zigbangStationList([101], 'radius=1&depositMin=10'), 'query-changed'],
    [zigbangStationList([101], 'radius=2&depositMin=0'), 'radius-mismatch'],
    [zigbangStationList([102]), 'list-changed'],
  ]) {
    const f = fixture('zigbang');
    f.location.href = zigbangStationPage;
    const box = list(f, { id: '101', height: 1000 });
    f.capture(zigbangStationList([101]));
    f.capture(capture);
    f.capture(zigbangDetails([101, 102]));
    f.capture(zigbangStationList([101]));
    f.advance(3000);
    const answer = f.step();
    assert.equal(answer.kind, 'blocked', reason);
    assert.equal(answer.zigbangCoverage.complete, false, reason);
    assert.equal(answer.zigbangCoverage.reason, reason);
    assert.equal(box.scrollTop, 0);
  }
});

test('Zigbang malformed or duplicate expected IDs cannot establish completion', () => {
  for (const [body, reason] of [
    ['not-json', 'unreadable-list'],
    [JSON.stringify({}), 'unreadable-list'],
    [JSON.stringify({ items: [{ id: -1 }] }), 'unreadable-list'],
    [JSON.stringify({ items: [{ id: '101' }] }), 'unreadable-list'],
    [JSON.stringify({ items: [{ id: 101 }, { id: 101 }] }), 'duplicate-list-id'],
  ]) {
    const f = fixture('zigbang');
    f.location.href = zigbangStationPage;
    f.capture({ ...zigbangStationList([101]), body });
    f.capture(zigbangDetails([101]));
    const answer = f.step();
    assert.equal(answer.kind, 'blocked');
    assert.equal(answer.zigbangCoverage.reason, reason);
    assert.equal(answer.zigbangCoverage.complete, false);
  }
});

test('Zigbang unreadable detail rows remain incomplete until valid expected details are received', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  f.capture(zigbangStationList([101]));
  f.capture({ body: JSON.stringify({ items: [{ item_id: 101, location: { lat: 999, lng: 128 } }] }) });
  f.advance(3000);
  const unreadable = f.step();
  assert.equal(unreadable.kind, 'idle');
  assert.equal(unreadable.zigbangCoverage.received, 1);
  assert.equal(unreadable.zigbangCoverage.missing, 0);
  assert.equal(unreadable.zigbangCoverage.reason, 'unreadable-details');
  f.capture(zigbangDetails([101]));
  f.advance(3000);
  assert.equal(f.step().kind, 'complete');
});

test('Zigbang malformed detail arrays invalidate prior received details', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  f.capture(zigbangStationList([101]));
  f.capture(zigbangDetails([101]));
  f.capture({ body: JSON.stringify({ items: null }) });
  f.advance(3000);
  const answer = f.step();
  assert.equal(answer.kind, 'blocked');
  assert.equal(answer.zigbangCoverage.reason, 'unreadable-details');
  assert.equal(answer.zigbangCoverage.complete, false);
});

test('Zigbang station navigation within one job stops instead of changing collection range', () => {
  const f = fixture('zigbang');
  f.location.href = zigbangStationPage;
  f.capture(zigbangStationList([101]));
  f.step();
  f.location.pathname = '/home/oneroom/subways/900002/items';
  assert.equal(f.step().kind, 'blocked');
});

test('Zigbang numeric station traversal remains bounded by 30 minutes or 2000 actions', () => {
  for (const bound of ['time', 'actions']) {
    const f = fixture('zigbang');
    f.location.href = zigbangStationPage;
    const box = list(f, { id: '101', height: 1000000 });
    f.capture(zigbangStationList([101, 102]));
    f.step();
    if (bound === 'time') f.advance(1800000);
    else for (let i = 1; i < 2000; i++) assert.equal(f.step().kind, 'action');
    const answer = f.step();
    assert.equal(answer.kind, 'idle');
    assert.equal(answer.waiting, false);
    assert.equal(answer.zigbangCoverage.complete, false);
    assert.equal(box.scrolls.length, bound === 'time' ? 1 : 2000);
  }
});
