import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

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
  get innerText() {
    return [this.ownText, ...this.children.filter(child => !Object.hasOwn(child.attrs, 'hidden') && child.style.display !== 'none' && child.style.visibility !== 'hidden').map(child => child.innerText)].filter(Boolean).join(' ');
  }
  append(...children) {
    for (const child of children) { child.parentElement = this; this.children.push(child); }
    return this;
  }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  getBoundingClientRect() { return { ...this.rect, bottom: this.rect.top + this.rect.height, right: this.rect.left + this.rect.width }; }
  closest(selector) {
    for (let el = this; el; el = el.parentElement) if (matches(el, selector)) return el;
    return null;
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  contains(other) { for (let el = other; el; el = el.parentElement) if (el === this) return true; return false; }
  click() { this.clicks++; this.onClick?.(); }
  scrollTo({ top }) { this.scrollTop = Math.min(Math.max(top, 0), this.scrollHeight - this.clientHeight); this.scrolls.push(this.scrollTop); }
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
    URL, window, document, location, HNW_SITE: { id: site }, innerHeight: 900, innerWidth: 1400,
    getComputedStyle: el => el.style,
    Date: class extends Date { static now() { return now; } },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
  };
  vm.runInNewContext(source, context);
  return {
    body,
    advance(ms) { now += ms; },
    overlay(el) { overlay = el; },
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
const naver = (clusterId, ids) => ({ requestBody: JSON.stringify({ clusterId }), body: JSON.stringify({ result: { list: ids.map(articleNumber => ({ representativeArticleInfo: { articleNumber } })) } }) });
const bubble = (id, left) => element('button', { attrs: { 'data-nlogs-area': 'pin*art.bubble', 'data-cluster-id': id }, rect: { left, top: 400, width: 60, height: 50 }, text: '2개의 매물' });

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
