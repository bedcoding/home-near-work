import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('request-start URLs and increasing IDs distinguish stale responses without changing site requests',async()=>{
  const events=[], pending=[], location=new URL('https://fin.land.naver.com/map?filter=first');
  const xhr={open(){},send(){}};
  const window={postMessage:event=>events.push(event),fetch:()=>new Promise(resolve=>pending.push(resolve))};
  const context=vm.createContext({window,location,URL,Request,XMLHttpRequest:{prototype:xhr}});
  vm.runInContext(fs.readFileSync(new URL('../extension/hook.js',import.meta.url),'utf8'),context);
  const url='https://fin.land.naver.com/front-api/v1/article/legalDivisionArticleList';
  const first=window.fetch(url,{method:'POST',body:'first-body'});
  location.search='?filter=second';const second=window.fetch(url,{method:'POST',body:'second-body'});
  const response=()=>({url,status:200,headers:{get:()=> 'application/json'},clone:()=>({text:async()=>'{"result":{}}'})});
  pending[1](response());await second;await new Promise(resolve=>setImmediate(resolve));
  pending[0](response());await first;await new Promise(resolve=>setImmediate(resolve));
  const starts=events.filter(x=>x.__hnw==='naver-list-request'), captures=events.filter(x=>x.__hnw==='capture');
  assert.equal(starts.length,2);assert.ok(starts[1].requestOrder>starts[0].requestOrder);
  assert.equal(captures[0].requestPageUrl,'https://fin.land.naver.com/map?filter=second');
  assert.equal(captures[1].requestPageUrl,'https://fin.land.naver.com/map?filter=first');
  assert.equal(captures[1].requestBody,'first-body');assert.equal(captures[1].requestOrder,starts[0].requestOrder);
});

test('Request objects keep their request body for capture without changing the original request', async () => {
  const events = [], pending = [], sent = [], location = new URL('https://realty.daangn.com/map/subway/synthetic');
  const window = { postMessage: (event) => events.push(event), addEventListener() {},
    fetch: (input) => { sent.push(input); return new Promise((resolve) => pending.push(resolve)); } };
  const document = { readyState: 'loading', getElementById: () => null };
  const context = vm.createContext({ window, location, URL, Request, document, setTimeout, XMLHttpRequest: { prototype: { open() {}, send() {} } } });
  vm.runInContext(fs.readFileSync(new URL('../extension/hook.js', import.meta.url), 'utf8'), context);
  const url = 'https://realty.kr.karrotmarket.com/graphql';
  const request = new Request(url, { method: 'POST', body: '{"variables":{"subwayStationPoiId":"900"}}' });
  window.fetch(request);
  assert.equal(sent[0], request, 'the page request is sent as is');
  pending[0]({ url, status: 200, headers: { get: () => 'application/json' }, clone: () => ({ text: async () => '{"data":{}}' }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const capture = events.find((e) => e.__hnw === 'capture');
  assert.equal(capture.requestBody, '{"variables":{"subwayStationPoiId":"900"}}');
});
