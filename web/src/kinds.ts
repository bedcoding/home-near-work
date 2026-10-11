import { LAND_PREFIX, SHOP_PREFIX, type ListingView } from '../../shared/types';

/** 매물 유형(사이트마다 다른 건물 유형 글자를 공통으로 묶은 것). */
export type Kind = 'apt' | 'officetel' | 'villa' | 'shop' | 'land' | 'etc' | 'unknown';
export const KINDS: Kind[] = ['apt', 'officetel', 'villa', 'shop', 'land', 'etc', 'unknown'];
export const KIND_LABEL: Record<Kind, string> = { apt: '아파트', officetel: '오피스텔', villa: '빌라와 주택', shop: '상가', land: '토지', etc: '기타', unknown: '모름' };

/**
 * 건물 유형 글자로 공통 유형을 정한다. 여러 용도가 섞이면 아파트 → 오피스텔 → 빌라와 주택 순서로 본다.
 * 빌라와 주택: 다세대, 연립, 빌라, 도시형생활주택, 공동주택, 다가구, 단독, 다중주택. 상가: 경매 상가(상업용 검색으로 모은 것). 토지: 땅만 파는 경매.
 * 기타: 근린생활시설, 업무시설 등 주거 용도가 없는 것.
 * 네이버의 모르는 종류 코드(A02 등)와 고방 '원·투룸'(건물 유형이 아니라 방 구조)은 '모름'.
 */
export function kindOf(l: Pick<ListingView, 'buildingType'>): Kind {
  const t = (l.buildingType ?? '').trim();
  if (!t || /^[A-Z]\d{2}$/.test(t) || t === '원·투룸') return 'unknown';
  if (t.startsWith(SHOP_PREFIX)) return 'shop';
  if (t.startsWith(LAND_PREFIX)) return 'land';
  if (/아파트|재건축|분양권/.test(t)) return 'apt';
  if (/오피스텔/.test(t)) return 'officetel';
  if (/다세대|연립|빌라|도시형생활주택|공동주택|다가구|단독|다중주택|주택/.test(t)) return 'villa';
  return 'etc';
}
