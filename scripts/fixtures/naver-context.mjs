import LZString from 'lz-string';
import {page,target} from './naver-region.mjs';

// Unrelated synthetic prices, regions and filters for browser protocol tests.
export const selectedFilter = {tradeTypes:['B1','B2'],realEstateTypes:['C01','C02'],
  warrantyPrice:{min:0,max:250000000},rentPrice:{min:0,max:770000},roomCount:['RCF01','RCF02'],hasArticlePhoto:true};
export function snapshot(filter = {}, code = target.code) {
  const request=JSON.parse(page([],{filter:{...filter,legalDivisionNumbers:[code]},sort:'RANKING_DESC'}).requestBody);
  const searchParams={tab:'article',articleSortingType:'RANKING_DESC'};
  const layer=LZString.compressToEncodedURIComponent(JSON.stringify([{id:'region_detail',params:{legalDivisionNumber:code},searchParams}]));
  const url=new URL('https://fin.land.naver.com/map');
  for(const [key,value] of Object.entries({center:'synthetic-center',zoom:14,showOnlySelectedRegion:true,layer}))url.searchParams.set(key,String(value));
  const aliases={optionTypes:'facilities',floorTypes:'floor',directionTypes:'direction',filtersExclusiveSpace:'exclusiveSpaceMode',hasArticle:'hasArticleComplex',walkingMinuteToSubwayStation:'subwayWalkingMinute'};
  for(const [key,value] of Object.entries(request.filter)) {
    if(key.startsWith('legalDivision') || value==null)continue;
    const raw=key==='walkingMinuteToSubwayStation' ? String(value.max ?? 25) : Array.isArray(value) ? value.join('-') : typeof value==='object' ? `${value.min ?? 0}-${value.max ?? 'Infinity'}` : String(value);
    if(raw)url.searchParams.set(aliases[key] || key,raw);
  }
  return {pageUrl:url.href,requestPageUrl:url.href,request};
}
