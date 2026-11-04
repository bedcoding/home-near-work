import * as store from './db.js';
import context from './naver-context.js';
import ledger from './naver-ledger.js';
import type { Area } from '../shared/types.js';

const KEY='naver_browse_preset';
const error=(message:string)=>Object.assign(new Error(message),{statusCode:409});
export function readNaverPreset() {
  const raw=store.getSetting(KEY);if(!raw)return null;
  try {
    const saved=JSON.parse(raw);
    if(!Number.isSafeInteger(saved.updatedAt) || !Array.isArray(saved.areaIds) || !saved.areaIds.every((id:unknown)=>Number.isSafeInteger(id) && Number(id)>0))throw new Error('invalid');
    return {...context.read({pageUrl:saved.pageUrl}),areaIds:saved.areaIds as number[],updatedAt:saved.updatedAt as number};
  } catch {throw error('저장한 네이버 필터를 읽지 못했습니다. 순차 조회의 네이버 필터나 확장 아이콘 메뉴에서 조건을 다시 저장해 주세요.');}
}
export function naverPresetState() {
  const saved=readNaverPreset();
  return saved ? {areaIds:saved.areaIds,updatedAt:saved.updatedAt,summary:saved.summary,conditions:ledger.conditions(saved.filter)} : null;
}
export function saveNaverPreset(input:{pageUrl?:unknown;areaIds?:unknown}) {
  if(typeof input?.pageUrl!=='string' || !Array.isArray(input.areaIds) || !input.areaIds.length || input.areaIds.length>100 || !input.areaIds.every(id=>Number.isSafeInteger(id) && Number(id)>0))throw error('예약에 저장할 필터와 수집 지역을 확인해 주세요.');
  const areas=store.listAreas();
  const areaIds=[...new Set(input.areaIds)] as number[];
  if(areaIds.some(id=>!areas.some(area=>area.id===id && area.enabled && area.purpose!=='alert' && ['gu','dong'].includes(area.region?.kind || ''))))throw error('예약에는 켜진 구나 동 수집 지역을 선택해 주세요.');
  let selected:ReturnType<typeof context.read>;
  try {selected=context.read({pageUrl:input.pageUrl});}catch(cause){throw error(cause instanceof Error ? cause.message : '네이버 필터를 확인해 주세요.');}
  store.setSetting(KEY,JSON.stringify({pageUrl:selected.pageUrl,areaIds,updatedAt:Date.now()}));
  return naverPresetState();
}
export function naverAreaJob(area:Area) {
  const preset=readNaverPreset();
  if(!preset)throw error('순차 조회의 네이버 필터나 확장 아이콘 메뉴에서 네이버 필터와 지역을 예약용으로 먼저 저장해 주세요.');
  if(!area.region || area.purpose==='alert')throw error('네이버 예약에는 구나 동 수집 지역이 필요합니다.');
  return context.forArea({name:area.name,region:area.region},preset,`https://fin.land.naver.com/map?center=${area.lng}-${area.lat}`);
}
