import test from 'node:test';
import assert from 'node:assert/strict';
import ledger from '../server/naver-ledger.ts';
import {target,page} from './fixtures/naver-region.mjs';
import {selectedFilter} from './fixtures/naver-context.mjs';

test('region ledger requires all contiguous pages, matching totals, and storage readback',()=>{
  const state=ledger.create(target);
  const first=page(['101'],{next:['cursor-a'],more:true,total:2});
  ledger.accept(state,first); ledger.accept(state,first);
  assert.equal(state.pages,1); assert.equal(ledger.coverage(state,1).complete,false);
  ledger.accept(state,page(['102'],{cursor:['cursor-a'],total:2}));
  assert.equal(ledger.coverage(state).complete,true);
  assert.equal(ledger.coverage(state,1).complete,false);
  assert.equal(ledger.coverage(state,2).complete,true);
});
test('missing first pages, changed scope/filters/cursor/seed/counts and unreadable rows cannot complete',()=>{
  for(const variant of ['cursor','seed','total','filter','scope','duplicate','unreadable','status']) {
    const state=ledger.create(target); ledger.accept(state,page(['101'],{next:['cursor-a'],more:true,total:2}));
    const capture=page(variant==='duplicate'?['101']:['102'],{cursor:variant==='cursor'?['wrong']:['cursor-a'],total:variant==='total'?3:2,
      requestSeed:variant==='seed'?'wrong':'synthetic-seed',filter:variant==='filter'?{rentPrice:{max:100000}}:variant==='scope'?{legalDivisionNumbers:['9988800000']}:{} });
    if(variant==='unreadable')capture.body=capture.body.replace('"articleNumber":"102"','"articleNumber":null');
    if(variant==='status')capture.status=429;
    ledger.accept(state,capture); assert.equal(ledger.coverage(state,2).complete,false,variant);
  }
  const late=ledger.create(target); ledger.accept(late,page(['102'],{cursor:['cursor-a']}));
  assert.equal(ledger.coverage(late,1).complete,false);
});
test('valid empty result completes; map aggregates never constitute list evidence',()=>{
  const state=ledger.create(target); ledger.accept(state,{...page([]),url:'https://fin.land.naver.com/front-api/v1/article/boundedArticlesCount'});
  assert.equal(state.pages,0); ledger.accept(state,page([])); assert.equal(ledger.coverage(state,0).complete,true);
});

const defaultFilter={roomCount:[],bathRoomCount:[],optionTypes:[],oneRoomShapeTypes:[],moveInTypes:[],filtersExclusiveSpace:false,
  floorTypes:[],directionTypes:[],hasArticlePhoto:false,isAuthorizedByOwner:false,parkingTypes:[],entranceTypes:[],hasArticle:false};
test('ordinary ranking order and disabled default flags allow contiguous thirty-row pages',()=>{
  const state=ledger.create(target), first=Array.from({length:30},(_,i)=>String(100+i));
  ledger.accept(state,page(first,{size:30,sort:'RANKING_DESC',filter:defaultFilter,next:['a',1,2],more:true,total:31}));
  assert.equal(state.invalid,undefined); assert.equal(state.pages,1); assert.equal(ledger.coverage(state).reason,'more-pages');
  ledger.accept(state,page(['130'],{size:30,sort:'RANKING_DESC',filter:defaultFilter,cursor:['a',1,2],total:31}));
  assert.equal(ledger.coverage(state,31).complete,true);
});
test('enabled restrictions, unknown boolean flags and mid-run sorting changes remain incomplete',()=>{
  for(const restriction of [{hasArticlePhoto:true},{filtersExclusiveSpace:true},{hasArticle:true},{isAuthorizedByOwner:true},{unknownFilter:false},{roomCount:[1]}]) {
    const state=ledger.create(target); ledger.accept(state,page(['101'],{sort:'RANKING_DESC',filter:{...defaultFilter,...restriction}}));
    assert.equal(ledger.coverage(state,1).complete,false); assert.equal(state.invalid,'restricted-filter');
  }
  const state=ledger.create(target);
  ledger.accept(state,page(['101'],{sort:'RANKING_DESC',filter:defaultFilter,more:true,next:['a'],total:2}));
  ledger.accept(state,page(['102'],{sort:'DATE_DESC',filter:defaultFilter,cursor:['a'],total:2}));
  assert.equal(state.invalid,'changed-query'); assert.equal(ledger.coverage(state,2).complete,false);
});

test('pinned price, rent, housing and other restrictions survive every cursor request',()=>{
  const first=page(['101'],{filter:selectedFilter,sort:'RANKING_DESC',more:true,next:['a'],total:2});
  const template=JSON.parse(first.requestBody), scope={...target,filter:template.filter,sort:'RANKING_DESC'}, state=ledger.create(scope);
  ledger.accept(state,first);assert.equal(state.invalid,undefined);
  assert.deepEqual(ledger.nextRequest(state,template).filter,template.filter);
  const reordered={...template.filter,tradeTypes:['B2','B1'],roomCount:['RCF02','RCF01'],hasArticle:false,optionTypes:[]};
  ledger.accept(state,page(['102'],{filter:reordered,sort:'RANKING_DESC',cursor:['a'],total:2}));
  assert.equal(ledger.coverage(state,2).complete,true);
  for(const change of [{rentPrice:null},{warrantyPrice:{max:999000000}},{roomCount:[]},{realEstateTypes:ledger.TYPES},{tradeTypes:['A1','B1','B2','B3']}]) {
    const altered=ledger.create(scope);ledger.accept(altered,page(['101'],{filter:{...template.filter,...change},sort:'RANKING_DESC'}));
    assert.equal(altered.invalid,'filter-changed');assert.equal(altered.pages,0);
  }
});

test('filter preview distinguishes excluded transactions, uncapped prices and enabled restrictions',()=>{
  const rows=Object.fromEntries(ledger.conditions(selectedFilter).map(row=>[row.label,row.value]));
  assert.equal(rows['매매가'],'매매 제외');assert.equal(rows['보증금과 전세금'],'2.5억원 이하');assert.equal(rows['월세'],'77만원 이하');
  assert.equal(rows['매물 유형'],'원룸, 빌라');assert.equal(rows['사진 있는 매물만'],'적용');assert.equal(rows['방 개수'],'1개, 2개');
  const uncapped=Object.fromEntries(ledger.conditions({tradeTypes:['A1','B1','B2','B3'],realEstateTypes:['A01']}).map(row=>[row.label,row.value]));
  for(const label of ['매매가','보증금과 전세금','월세','면적'])assert.equal(uncapped[label],'제한 없음');
});
