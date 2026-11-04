import { distanceM } from '../geo.js';
import { knownStations } from '../station-catalog.js';
import type { Area } from '../../shared/types.js';
import { primaryAreas, stationAreas } from '../../shared/regions.js';

/**
 * 켜진 지역 바로 근처(반경 +300m 안)의 역 이름과 지역 이름. 끝의 '역'과 ' 근처'를 빼고, 두 글자 이상만 남긴다.
 * 임대 공고 제목에 들었으면 근처일 가능성이 높다고 본다(shared/types nearReason).
 */
export function nearNamesFor(areas: Area[]): string[] {
  const strip = (name: string) => name.replace(/\s*근처\s*\d*$/, '').replace(/역$/, '').trim();
  const set = new Set<string>();
  for (const area of primaryAreas(areas)) {
    if (area.region) {
      set.add(area.region.sigungu);
      if (area.region.dong) set.add(area.region.dong);
      continue;
    }
    set.add(strip(area.name));
    for (const s of knownStations()) if (distanceM(area.lat, area.lng, s.lat, s.lng) <= area.radiusM + 300) set.add(strip(s.name));
  }
  return [...set].filter((n) => n.length >= 2 && n !== '찍은 곳');
}

/**
 * 켜진 지역 반경(+600m) 안에 있는 서울 역들의 구. 법원경매 검색 조건과 공고 거르기에 쓴다.
 * withStations: 구나 동이 있어도 켜진 지하철역 반경의 구까지 더한다(조회하기의 고방, 법원경매, 온비드 수집 범위).
 */
export function gusFor(areas: Area[], withStations = false): string[] {
  const seoul = knownStations().filter((s) => s.sido === '서울' && s.gu);
  const set = new Set<string>();
  const targets = withStations ? [...new Map([...primaryAreas(areas), ...stationAreas(areas)].map((a) => [a.id, a])).values()] : primaryAreas(areas);
  for (const area of targets) {
    if (area.region) { if (area.region.sido === '서울특별시') set.add(area.region.sigungu); continue; }
    for (const s of seoul) if (distanceM(area.lat, area.lng, s.lat, s.lng) <= area.radiusM + 600) set.add(s.gu);
  }
  return [...set];
}
