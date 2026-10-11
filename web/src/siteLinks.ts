import type { Area, Station } from '../../shared/types';
import { distanceM } from './format';

/** 바로 가기 하나. where는 어디가 열리는지(마우스를 올리면 보인다). */
export interface SiteLink {
  id: string;
  name: string;
  url: string;
  where: string;
  main?: boolean;
}

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function base62(n: number): string {
  let s = '';
  do {
    s = BASE62[n % 62] + s;
    n = Math.floor(n / 62);
  } while (n > 0);
  return s;
}

/**
 * 네이버 새 지도(fin.land) 주소의 center 값. 경도와 위도를 각각 ×10^7 + 2×10^9 한 정수를 62진수(0-9a-zA-Z)로 적고 '-'로 잇는다.
 * 확장의 sites.js에도 같은 계산이 있다.
 */
export function naverCenter(lat: number, lng: number): string {
  return `${base62(Math.round(lng * 1e7) + 2e9)}-${base62(Math.round(lat * 1e7) + 2e9)}`;
}

const peterpanzCenter = (lat: number, lng: number) => encodeURIComponent(JSON.stringify({ y: lat, _lat: lat, x: lng, _lng: lng }));

/** 당근부동산 지도 범위 값(주소의 mv): '남쪽 위도,서쪽 경도,북쪽 위도,동쪽 경도,확대'. 지역 반경의 1.3배 네모. */
function daangnView(area: Area, zoom: number): string {
  const dLat = (area.radiusM * 1.3) / 111320;
  const dLng = (area.radiusM * 1.3) / (111320 * Math.cos((area.lat * Math.PI) / 180));
  return [area.lat - dLat, area.lng - dLng, area.lat + dLat, area.lng + dLng].map((v) => v.toFixed(5)).concat(String(zoom)).join(',');
}

/**
 * 사이트 바로 가기. 네이버, 피터팬, 다방, KB부동산은 고른 지역 가운데로, 집토스와 당근부동산은 가까운 역 페이지로,
 * 직방은 가까운 역의 직방 역 번호로, 호갱노노는 가까운 역 옆 단지 화면으로 연다(Station.zigbangId, hogangnonoApt). 모르면 첫 화면.
 */
export function siteLinks(area: Area | null, stations: Station[]): SiteLink[] {
  const zoom = area && area.radiusM > 1200 ? 13 : 14;
  const station = area
    ? stations.map((s) => ({ s, d: distanceM(area.lat, area.lng, s.lat, s.lng) })).filter((x) => x.d <= 2000).sort((a, b) => a.d - b.d)[0]?.s
    : undefined;
  const home = '첫 화면을 엽니다';
  return [
    {
      id: 'naver',
      name: '네이버 부동산',
      main: true,
      url: area ? `https://fin.land.naver.com/map?center=${naverCenter(area.lat, area.lng)}&zoom=${zoom}` : 'https://fin.land.naver.com/map',
      where: area ? `${area.name} 가운데로 네이버 부동산 지도를 엽니다` : '네이버 부동산 지도를 엽니다',
    },
    {
      id: 'peterpanz',
      name: '피터팬',
      // 수집기와 같은 주소(빌라와 주택 지도)
      url: area
        ? `https://www.peterpanz.com/villa?zoomLevel=${zoom}&center=${peterpanzCenter(area.lat, area.lng)}&dong=&gungu=&filter=${encodeURIComponent('buildingType;["빌라/주택"]')}&filter_version=5.1`
        : 'https://www.peterpanz.com/',
      where: area ? `${area.name} 가운데로 피터팬 빌라와 주택 지도를 엽니다` : '피터팬 첫 화면을 엽니다',
    },
    {
      id: 'ziptoss',
      name: '집토스',
      url: station ? `https://ziptoss.com/map/${encodeURIComponent(station.name)}` : 'https://ziptoss.com/',
      where: station ? `집토스 ${station.name} 주변 매물 페이지를 엽니다` : '집토스 첫 화면을 엽니다',
    },
    { id: 'courtauction', name: '법원경매', url: 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml', where: '법원경매정보 물건상세검색을 엽니다' },
    {
      id: 'dabang',
      name: '다방',
      url: area ? `https://www.dabangapp.com/map/onetwo?m_lat=${area.lat}&m_lng=${area.lng}&m_zoom=${zoom}` : 'https://www.dabangapp.com/',
      where: area ? `${area.name} 가운데로 다방 지도를 엽니다` : home,
    },
    {
      id: 'zigbang',
      name: '직방',
      url: station?.zigbangId ? `https://www.zigbang.com/home/oneroom/subways/${encodeURIComponent(station.zigbangId)}/items` : 'https://www.zigbang.com/',
      where: station?.zigbangId ? `직방 ${station.name} 원룸 목록을 엽니다` : home,
    },
    {
      id: 'kbland',
      name: 'KB부동산',
      url: area ? `https://kbland.kr/map?xy=${area.lat},${area.lng},${zoom}` : 'https://kbland.kr/',
      where: area ? `${area.name} 가운데로 KB부동산 지도를 엽니다` : home,
    },
    {
      id: 'hogangnono',
      name: '호갱노노',
      url: station?.hogangnonoApt ? `https://hogangnono.com/apt/${encodeURIComponent(station.hogangnonoApt)}` : 'https://hogangnono.com/',
      where: station?.hogangnonoApt ? `호갱노노를 ${station.name} 옆 단지 화면으로 엽니다` : home,
    },
    {
      id: 'daangn',
      name: '당근부동산',
      url: station ? `https://realty.daangn.com/map/subway/${encodeURIComponent(station.name.replace(/역$/, ''))}${area ? `?mv=${encodeURIComponent(daangnView(area, zoom))}` : ''}` : 'https://realty.daangn.com/',
      where: station ? `당근부동산 ${station.name} 근처 매물 지도를 엽니다` : home,
    },
  ];
}
