import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ledger from '../server/naver-ledger.ts';
import {selectedFilter} from './fixtures/naver-context.mjs';

const source=fs.readFileSync(new URL('../extension/popup-collect.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../extension/popup.html',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
class Element {
  children=[]; listeners={}; ownText=''; hidden=false; disabled=false; value='';
  get textContent(){return this.ownText;} set textContent(value){this.ownText=value;this.children=[];}
  append(...children){this.children.push(...children);} appendChild(child){this.append(child);}
  addEventListener(type,fn){this.listeners[type]=fn;}
  querySelectorAll(selector){assert.equal(selector,'input');return this.children.flatMap(el=>el.type==='checkbox'?[el]:el.querySelectorAll(selector));}
}
async function popup({offline=false,filterUnavailable=false,tabs=[{id:99,title:'Synthetic filtered map',active:true}]}={}) {
  const elements=new Map([...html.matchAll(/id="(collect-[^"]+)"/g)].map(([,id])=>[id,new Element()]));
  const areas=[{id:1,name:'가상구',enabled:true,purpose:'collection',lat:35,lng:128,radiusM:1000,region:{kind:'gu',code:'99123',name:'예시도 가상구'}},
    {id:2,name:'상상동',enabled:true,purpose:'collection',lat:35.1,lng:128.1,radiusM:1000,region:{kind:'dong',code:'9988810100',name:'예시도 상상동'}},
    {id:3,name:'가상역',enabled:true,purpose:'alert'}, {id:4,name:'꺼진구',enabled:false,purpose:'collection',region:{kind:'gu',code:'99777'}}];
  const saved={}, messages=[],filterReads=[]; let onChange;
  const chrome={storage:{local:{get:async key=>({[key]:saved[key]}),set:async value=>Object.assign(saved,value)},onChanged:{addListener:fn=>{onChange=fn;}}},
    runtime:{sendMessage:async message=>{if(message.type==='naver-filter-tabs')return {tabs};
      if(message.type==='naver-filter-state'){filterReads.push(message.tabId);return filterUnavailable?{error:'Refresh the source list'}:{context:{key:'synthetic-filter-key',filter:selectedFilter,summary:ledger.summary(selectedFilter)}};}
      if(message.type==='naver-preset-save'){messages.push(structuredClone(message));return {preset:{areaIds:message.areaIds,summary:'Synthetic saved filter'}};}
      messages.push(structuredClone(message)); if(offline)throw new Error('Synthetic connection failure'); return {state:{status:'running',jobs:message.areas.map(a=>({areaName:a.name,site:'naver',naverScope:{kind:'naver-region',filter:selectedFilter},status:'pending'})),index:0}};}}};
  vm.runInNewContext(source,{document:{getElementById:id=>{assert.ok(elements.has(id),id);return elements.get(id);},createElement:()=>new Element()},chrome,hnwReadAreas:async()=>areas,HNW_NAVER_LEDGER:ledger,Date,Set,setTimeout,clearTimeout});
  await settle();
  return {el:id=>elements.get(`collect-${id}`),messages,filterReads,saved,change:state=>onChange({'hnw-browse-state':{newValue:state}},'local')};
}
test('popup starts only checked collection regions and sends their administrative identity to the worker',async()=>{
  const p=await popup();
  const boxes=p.el('areas').querySelectorAll('input'); assert.equal(boxes.length,2);
  boxes[0].checked=false; await boxes[0].listeners.change();
  p.el('start').listeners.click(); await settle();
  assert.deepEqual(p.messages[0].sites,['naver']); assert.equal(p.messages[0].areas.length,1);
  assert.equal(p.messages[0].areas[0].region.code,'9988810100'); assert.equal(p.el('start').disabled,true);
  assert.equal(p.messages[0].naverFilterKey,'synthetic-filter-key');
  assert.equal(p.messages[0].naverSourceTabId,99);
  assert.equal(p.el('filter-conditions').hidden,false);
  const preview=p.el('filter-conditions').children.map(el=>el.textContent).join(' ');
  assert.match(preview,/전세, 월세/);assert.match(preview,/원룸, 빌라/);assert.match(preview,/2.5억원 이하/);assert.match(preview,/77만원 이하/);assert.match(preview,/매매 제외/);
  assert.match(p.el('state').textContent,/수집 중/);
});
test('popup reopening can render partial results honestly and offers retry rather than claiming completion',async()=>{
  const p=await popup(); p.change({status:'done',jobs:[{areaName:'가상구',site:'naver',naverScope:{kind:'naver-region',filter:selectedFilter},status:'partial',receipt:{responses:2,listings:5}}],index:1,logs:[]});
  assert.match(p.el('state').textContent,/완료 지역 0\/1/);
  assert.match(p.el('detail').textContent,/일부 확인/); assert.equal(p.el('retry').hidden,false);
  assert.match(p.el('counts').textContent,/저장 처리 5건/);
});

test('another source or a legacy map tour cannot appear as a completed region collection',async()=>{
  const p=await popup();
  for(const job of [{site:'zigbang',status:'complete',receipt:{responses:60,listings:800}}, {site:'naver',status:'complete',receipt:{responses:10,listings:100}}]) {
    p.change({status:'done',jobs:[job],index:1,logs:[]});
    assert.equal(p.el('progress').hidden,true); assert.equal(p.el('empty').hidden,false);
    assert.match(p.el('empty').textContent,/아직 네이버/); assert.equal(p.el('start').disabled,false);
  }
  p.change({status:'running',jobs:[{site:'zigbang',status:'running'}],index:0,logs:[]});
  assert.equal(p.el('start').disabled,true); assert.match(p.el('empty').textContent,/다른 사이트/);
});

test('region result names and counts refer to the saved run rather than the current checkbox selection',async()=>{
  const p=await popup();
  p.change({status:'done',jobs:[{areaName:'가상구',site:'naver',naverScope:{kind:'naver-region'},status:'complete',receipt:{responses:2,listings:5,naverCoverage:{pages:2,total:5,received:5,stored:5,complete:true}}}],index:1,logs:[]});
  assert.match(p.el('run').textContent,/최근 네이버 조회.*가상구/); assert.match(p.el('state').textContent,/완료 지역 1\/1/);
  assert.match(p.el('results').children[0].textContent,/수신 5\/5건, 저장 5건, 완료/);
});

test('missing source filters disable start and legacy unrestricted runs cannot be resumed or retried',async()=>{
  const p=await popup({filterUnavailable:true});
  assert.equal(p.el('start').disabled,true);assert.match(p.el('filter').textContent,/Refresh/);
  assert.equal(p.el('start').textContent,'필터 확인 후 수집 가능');
  p.el('start').listeners.click();await settle();assert.equal(p.messages.length,0);
  p.change({status:'paused',jobs:[{site:'naver',naverScope:{kind:'naver-region'},status:'partial'}],index:0});
  assert.equal(p.el('resume').hidden,true);assert.equal(p.el('retry').hidden,true);
  assert.match(p.el('detail').textContent,/필터가 저장되지 않았습니다/);
});

test('popup opened elsewhere reads the single available map but requires a choice among multiple maps',async()=>{
  const single=await popup({tabs:[{id:77,title:'Synthetic filtered map',active:false}]});
  assert.deepEqual(single.filterReads,[77]);assert.equal(single.el('start').disabled,false);
  const p=await popup({tabs:[{id:77,title:'First map',active:false},{id:88,title:'Second map',active:false}]});
  assert.equal(p.el('start').disabled,true);assert.deepEqual(p.filterReads,[]);assert.match(p.el('filter').textContent,/위에서 선택/);
  p.el('source').value='88';p.el('source').listeners.change();await settle();
  assert.deepEqual(p.filterReads,[88]);assert.equal(p.el('start').disabled,false);
  p.el('start').listeners.click();await settle();assert.equal(p.messages[0].naverSourceTabId,88);
});

test('no available map explains the disabled start and refresh updates the available source',async()=>{
  const tabs=[],p=await popup({tabs});assert.equal(p.el('start').disabled,true);assert.equal(p.el('filter-read').disabled,true);
  assert.match(p.el('start').textContent,/탭 선택/);assert.match(p.el('filter').textContent,/탭 목록을 새로고침/);
  tabs.push({id:33,title:'New map',active:false});p.el('source-refresh').listeners.click();await settle();
  assert.deepEqual(p.filterReads,[33]);assert.equal(p.el('start').disabled,false);
});

test('saving a preset sends only confirmed conditions and selected collection IDs without starting a tour',async()=>{
  const p=await popup();const boxes=p.el('areas').querySelectorAll('input');boxes[1].checked=false;await boxes[1].listeners.change();
  await p.el('preset-save').listeners.click();await settle();
  assert.equal(p.messages.length,1);assert.equal(p.messages[0].type,'naver-preset-save');assert.deepEqual(p.messages[0].areaIds,[1]);
  assert.equal(p.messages[0].tabId,99);assert.equal(p.messages[0].filterKey,'synthetic-filter-key');assert.equal(p.el('preset-notice').hidden,false);
});
test('popup start failure restores controls and displays the worker error',async()=>{
  const p=await popup({offline:true}); p.el('start').listeners.click(); await settle();
  assert.equal(p.el('start').disabled,false); assert.equal(p.el('error').hidden,false);
  assert.match(p.el('error').textContent,/Synthetic connection failure/);
});
