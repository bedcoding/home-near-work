import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import LZString from 'lz-string';
import ledger from '../server/naver-ledger.ts';
import {snapshot,selectedFilter} from './fixtures/naver-context.mjs';

const context=vm.createContext({URL,HNW_NAVER_LEDGER:ledger});
for(const name of ['vendor/lz-string.js','naver-context.js'])vm.runInContext(fs.readFileSync(new URL(`../extension/${name}`,import.meta.url),'utf8'),context);
const api=context.HNW_NAVER_CONTEXT;
const plain=x=>JSON.parse(JSON.stringify(x));

test('new collection URLs retain every global and layer filter while changing only region and camera',()=>{
  const source=snapshot(selectedFilter), selected=api.read(source), url=new URL(source.pageUrl);
  const layers=JSON.parse(LZString.decompressFromEncodedURIComponent(url.searchParams.get('layer')));
  layers.push({id:'article_detail',params:{articleNumber:'999'}});
  url.searchParams.set('layer',LZString.compressToEncodedURIComponent(JSON.stringify(layers)));
  selected.pageUrl=url.href;
  const area={name:'상상구',region:{kind:'gu',code:'99888',name:'예시도 상상구'}};
  const copied=api.forArea(area,selected,'https://fin.land.naver.com/map?center=another-center');
  const result=new URL(copied.url);
  for(const [key,value] of url.searchParams)if(!['center','zoom','layer','showOnlySelectedRegion'].includes(key))assert.equal(result.searchParams.get(key),value,key);
  const region=JSON.parse(LZString.decompressFromEncodedURIComponent(result.searchParams.get('layer')));
  assert.equal(region.length,1); assert.deepEqual(region[0].searchParams,layers[0].searchParams);
  assert.equal(region[0].params.legalDivisionNumber,'9988800000'); assert.equal(result.searchParams.get('zoom'),'11');
  assert.equal(result.searchParams.get('center'),'another-center');
  assert.equal(ledger.matchesFilter(copied.scope,{...source.request.filter,legalDivisionNumbers:['9988800000']}),true);
  assert.equal(copied.scope.sort,'RANKING_DESC'); assert.match(selected.summary,/2.5억원/); assert.match(selected.summary,/77만원/);
});

test('unavailable, ambiguous or invalid URL filters never yield an unrestricted fallback',()=>{
  const valid=snapshot(selectedFilter);
  for(const source of [null,{error:'refresh required'},
    {...valid,pageUrl:'https://example.invalid/map'},
    {...valid,pageUrl:valid.pageUrl+'&layer=duplicate'}])assert.throws(()=>api.read(source));
  const url=new URL(valid.pageUrl);url.searchParams.delete('layer');
  assert.throws(()=>api.read({...valid,pageUrl:url.href,requestPageUrl:url.href}));
  url.searchParams.set('layer',LZString.compressToEncodedURIComponent('[{"id":"region_detail","params":{"legalDivisionNumber":"9988800000"}}]'));
  assert.equal(api.read({...valid,pageUrl:url.href,requestPageUrl:url.href}).filter.legalDivisionNumbers[0],'9988800000');
});

test('current URL filters are readable without a response and ignore stale captures and camera changes',()=>{
  const source=snapshot(selectedFilter),initial=api.read({pageUrl:source.pageUrl});
  const moved=new URL(source.pageUrl);moved.searchParams.set('center','moved-camera');moved.searchParams.set('zoom','12.0154826');
  const layers=JSON.parse(LZString.decompressFromEncodedURIComponent(moved.searchParams.get('layer')));layers[0].searchParams.tab='article';
  moved.searchParams.set('layer',LZString.compressToEncodedURIComponent(JSON.stringify(layers)));
  const current=api.read({pageUrl:moved.href,requestPageUrl:source.pageUrl,request:JSON.parse('{}')});
  assert.equal(current.key,initial.key);assert.deepEqual(plain(current.filter.rentPrice),{min:0,max:770000});
  moved.searchParams.set('rentPrice','0-990000');
  const changed=api.read({...source,pageUrl:moved.href});
  assert.notEqual(changed.key,initial.key);assert.equal(changed.filter.rentPrice.max,990000);
});

test('the public map filter codec retains API aliases and explicitly unrestricted ranges',()=>{
  const filter={...selectedFilter,dealPrice:{min:0,max:123000000},space:{min:12,max:44},filtersExclusiveSpace:true,
    optionTypes:['AIRCON'],floorTypes:['GROUND'],directionTypes:['EAST'],bathRoomCount:['RCF01'],
    walkingMinuteToSubwayStation:{min:0,max:8},loanRatioType:'00',hasArticle:true,managementFee:{min:0,max:90000},
    approvalElapsedYear:{min:0,max:8},householdNumber:{min:100,max:500},entranceTypes:['HALL'],parkingTypes:['AVAILABLE'],moveInTypes:['NOW'],oneRoomShapeTypes:['OPEN']};
  const result=api.read({pageUrl:snapshot(filter).pageUrl});
  assert.equal(ledger.matchesFilter({kind:'naver-region',code:result.filter.legalDivisionNumbers[0],filter:result.filter},{...filter,dealPrice:undefined,legalDivisionNumbers:result.filter.legalDivisionNumbers,legalDivisionType:'GUN'}),true);
  for(const [key,value] of [['tradeTypes',''],['realEstateTypes',''],['rentPrice','invalid'],['rentPrice','900-100'],['hasArticlePhoto','maybe']]) {
    const url=new URL(snapshot(selectedFilter).pageUrl);url.searchParams.set(key,value);assert.throws(()=>api.read({pageUrl:url.href}));
  }
  const unlimited=new URL(snapshot(selectedFilter).pageUrl);unlimited.searchParams.set('rentPrice','0-Infinity');
  assert.equal(api.read({pageUrl:unlimited.href}).filter.rentPrice,undefined);
  unlimited.searchParams.append('warrantyPrice','0-9');assert.throws(()=>api.read({pageUrl:unlimited.href}));
});
