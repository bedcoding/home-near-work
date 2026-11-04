import type {} from './naver-ledger.js';
interface Context { pageUrl: string; filter: Record<string, unknown>; sort: string; key: string; summary: string }
declare global {
  var HNW_NAVER_CONTEXT: {
    read(snapshot: {pageUrl: string}): Context;
    forArea(area: {name: string; region: {kind: string; code: string; name?: string}}, context: Context, generatedUrl: string): {url: string; scope: ReturnType<typeof HNW_NAVER_LEDGER.scope>};
  };
}
export {};
