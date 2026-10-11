import type { Area, Station } from '../../shared/types';
import { api } from './api';

/** 역 목록 전체(수도권 전철역 658곳). 지역 탭과 지도가 같이 쓰므로 한 번만 받는다. */
export type CatalogStation = Station & { lines: string[]; sido: string; gu: string | null };
let catalog: Promise<CatalogStation[]> | null = null;
export function loadCatalog(): Promise<CatalogStation[]> {
  catalog ??= api.stationCatalog().then((d) => d.stations).catch((e) => {
    catalog = null;
    throw e;
  });
  return catalog;
}

/**
 * 역 이름으로 지역을 켜고 끈다(지역 탭이나 지도에서 역을 누를 때). 없는 역이면 1km로 만들어 켠다.
 * 모두 끄면 아무것도 안 보이므로 마지막 켜진 지역은 끄지 않는다.
 */
export async function toggleStationArea(all: Area[], station: { name: string; lat: number; lng: number }): Promise<void> {
  const area = all.find((a) => a.name === station.name);
  if (area) return setAreaEnabled(all, area, !area.enabled);
  await api.createArea({ name: station.name, lat: station.lat, lng: station.lng, radiusM: 1000, enabled: true });
}

export async function setAreaEnabled(all: Area[], area: Area, enabled: boolean): Promise<void> {
  if (!enabled && area.enabled && all.filter((a) => a.enabled).length <= 1) throw new Error('지역이 하나는 켜져 있어야 합니다.');
  await api.updateArea(area.id, { enabled });
}
