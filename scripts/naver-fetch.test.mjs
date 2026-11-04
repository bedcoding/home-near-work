import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ledger from '../server/naver-ledger.ts';
import {target,page} from './fixtures/naver-region.mjs';

test('next requests are derived only from a verified live cursor and unchanged public filter',()=>{
  const state=ledger.create(target), first=page(['101'],{next:['next'],more:true,total:2});
  const template=JSON.parse(first.requestBody); assert.equal(ledger.nextRequest(state,template),null);
  ledger.accept(state,first);
  const request=ledger.nextRequest(state,template); assert.deepEqual(request.articlePagingRequest.lastInfo,['next']);
  assert.equal(request.articlePagingRequest.seed,'synthetic-seed');
  assert.equal(ledger.nextRequest(state,{...template,filter:{...template.filter,roomCount:[1]}}),null);
  ledger.accept(state,page(['102'],{cursor:['next'],total:2})); assert.equal(ledger.nextRequest(state,template),null);
});
test('the owned browser request uses a fixed same-origin endpoint and returns no response body',async()=>{
  const calls=[];
  const context=vm.createContext({location:{origin:'https://fin.land.naver.com',pathname:'/map'},document:{querySelectorAll:()=>[]},window:{__hnwHook:true,fetch:async(url,options)=>{calls.push({url,options});return{status:200,headers:{get:()=> 'application/json'}};}},AbortSignal});
  vm.runInContext(fs.readFileSync(new URL('../extension/naver-fetch.js',import.meta.url),'utf8'),context);
  const body=page().requestBody, result=await context.hnwFetchNaverPage(body);
  assert.equal(result.status,200); assert.equal(result.json,true); assert.equal(result.body,undefined);
  assert.equal(calls.length,1); assert.equal(calls[0].url,'https://fin.land.naver.com/front-api/v1/article/legalDivisionArticleList');
  assert.equal(calls[0].options.credentials,'same-origin'); assert.equal(calls[0].options.redirect,'error');
  assert.deepEqual(Object.keys(calls[0].options.headers),['content-type']);
  context.location.origin='https://example.invalid'; await context.hnwFetchNaverPage(body); assert.equal(calls.length,1);
  context.location.origin='https://fin.land.naver.com'; context.window.__hnwHook=false;
  await context.hnwFetchNaverPage(body); assert.equal(calls.length,1,'missing capture hook cannot send untracked requests');
  context.window.__hnwHook=true;
  context.document.querySelectorAll=()=>[{tagName:'IFRAME',getBoundingClientRect:()=>({width:300,height:200})}];
  context.getComputedStyle=()=>({display:'block',visibility:'visible'});
  assert.equal((await context.hnwFetchNaverPage(body)).error,'page-security-check'); assert.equal(calls.length,1);
});
