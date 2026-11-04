import ledger from '../../server/naver-ledger.ts';
export const target = {kind:'naver-region',code:'9912300000',name:'예시도 가상구'};
export function page(ids = ['101'], {cursor = [], next = [], more = false, total = ids.length, seed = 'synthetic-seed', requestSeed = cursor.length ? seed : undefined, filter = {}, sort = 'DATE_DESC', size = 5} = {}) {
  return {site:'naver',status:200,pageUrl:'https://fin.land.naver.com/map',url:'https://fin.land.naver.com/front-api/v1/article/legalDivisionArticleList',
    requestBody:JSON.stringify({filter:{legalDivisionNumbers:[target.code],legalDivisionType:'GUN',tradeTypes:['A1','B1','B2','B3'],realEstateTypes:ledger.TYPES,...filter},
      articlePagingRequest:{size,userChannelType:'PC',articleSortType:sort,lastInfo:cursor,...(requestSeed == null ? {} : {seed:requestSeed})}}),
    body:JSON.stringify({result:{seed,lastInfo:next,hasNextPage:more,totalCount:total,list:ids.map(articleNumber => ({representativeArticleInfo:{articleNumber,articleName:'Synthetic residence',realEstateType:'C01',tradeType:'B2',priceInfo:{warrantyPrice:10000000,rentPrice:400000},address:{city:'예시도',division:'가상구',sector:'가상동',coordinates:{xCoordinate:128,yCoordinate:36}}}}))}})};
}
