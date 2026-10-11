import { LOCAL } from './config.js';
import * as store from './db.js';
import { distanceM } from './geo.js';
import { stationCatalog, type CatalogStation, type StationInfo } from './stations.js';

export { stationCatalog, type CatalogStation } from './stations.js';

/**
 * 알고 있는 역: 설정의 knownStations(config/local.json) + 지역으로 만든 목록 역 + 지도에서 찍은 지역(역 이름이 아닌 지역) 2km 안의 목록 역.
 * 수집기(집토스 역 페이지, 법원경매 구)와 필터의 '아는 역'이 쓴다.
 * sido는 서울이면 '서울'이고, 법원경매는 서울 역의 구만 쓴다(검색 화면을 서울특별시로 고르므로).
 */
export function knownStations(): (StationInfo & { sido: string })[] {
  const areas = store.listAreas();
  const names = new Set([...(LOCAL.knownStations ?? []), ...areas.map((a) => a.name)]);
  const stations = stationCatalog().stations;
  const picked = areas.filter((a) => a.enabled && !stations.some((s) => s.name === a.name));
  const nearPicked = (s: CatalogStation) => picked.some((a) => distanceM(a.lat, a.lng, s.lat, s.lng) <= Math.max(a.radiusM + 600, 2000));
  return stations
    .filter((s) => names.has(s.name) || nearPicked(s))
    .map((s) => ({ name: s.name, label: s.label, lat: s.lat, lng: s.lng, gu: s.gu ?? '', sido: s.sido }));
}
