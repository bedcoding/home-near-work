import { distanceM } from '../geo.js';
import { knownStations } from '../station-catalog.js';
import type { Area } from '../../shared/types.js';

/**
 * 켜진 지역 바로 근처(반경 +300m 안)의 역 이름과 지역 이름. 끝의 '역'과 ' 근처'를 빼고, 두 글자 이상만 남긴다.
 * 임대 공고 제목에 들었으면 근처일 가능성이 높다고 본다(shared/types nearReason).
 */
export function nearNamesFor(areas: Area[]): string[] {
  const strip = (name: string) => name.replace(/\s*근처\s*\d*$/, '').replace(/역$/, '').trim();
  const set = new Set<string>();
  for (const area of areas) {
    set.add(strip(area.name));
    for (const s of knownStations()) if (distanceM(area.lat, area.lng, s.lat, s.lng) <= area.radiusM + 300) set.add(strip(s.name));
  }
  return [...set].filter((n) => n.length >= 2 && n !== '찍은 곳');
}

/** 켜진 지역 반경(+600m) 안에 있는 서울 역들의 구. 법원경매 검색 조건과 공고 거르기에 쓴다. */
export function gusFor(areas: Area[]): string[] {
  const seoul = knownStations().filter((s) => s.sido === '서울' && s.gu);
  const set = new Set<string>();
  for (const area of areas) {
    for (const s of seoul) if (distanceM(area.lat, area.lng, s.lat, s.lng) <= area.radiusM + 600) set.add(s.gu);
  }
  return [...set];
}
