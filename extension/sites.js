// 확장이 켜고 끌 수 있는 부동산 사이트 목록. 백그라운드, 팝업, 사이트 안 스크립트가 같이 쓴다.
// ready: 지도 동그라미 '봤음' 표시가 되는 곳.
// 나머지는 켜 두면 그 사이트 화면이 받은 데이터와 화면 구조를 대시보드로 보낸다.
// 다방, 직방, KB부동산, 호갱노노, 당근부동산은 기본으로 켜 둔다.
// 피터팬, 집토스는 '조회하기'가 따로 모으므로 기본으로 끈다.
// base: 그 사이트가 데이터를 받아 오는 주소(이 도메인과 그 하위 주소의 응답만 읽는다).
const HNW_SITES = [
  { id: 'naver', name: '네이버 부동산', matches: ['https://fin.land.naver.com/*', 'https://new.land.naver.com/*'], base: 'land.naver.com', ready: true, defaultOn: true },
  { id: 'peterpanz', name: '피터팬', matches: ['https://www.peterpanz.com/*'], base: 'peterpanz.com', ready: false },
  { id: 'dabang', name: '다방', matches: ['https://www.dabangapp.com/*'], base: 'dabangapp.com', ready: false, defaultOn: true },
  { id: 'zigbang', name: '직방', matches: ['https://www.zigbang.com/*'], base: 'zigbang.com', ready: false, defaultOn: true },
  { id: 'kbland', name: 'KB부동산', matches: ['https://kbland.kr/*'], base: 'kbland.kr', ready: false, defaultOn: true },
  { id: 'hogangnono', name: '호갱노노', matches: ['https://hogangnono.com/*'], base: 'hogangnono.com', ready: false, defaultOn: true },
  { id: 'daangn', name: '당근부동산', matches: ['https://realty.daangn.com/*'], base: 'daangn.com', ready: false, defaultOn: true },
  { id: 'ziptoss', name: '집토스', matches: ['https://ziptoss.com/*'], base: 'ziptoss.com', ready: false },
];

/** 주소로 사이트를 찾는다. */
function hnwSiteFor(hostname) {
  return (
    HNW_SITES.find((s) =>
      s.matches.some((m) => {
        const host = m.replace(/^https:\/\//, '').replace(/\/\*$/, '');
        return hostname === host;
      }),
    ) || null
  );
}

/** 저장된 켜기/끄기 값과 기본값을 합친다. */
function hnwEnabled(toggles, site) {
  return toggles && typeof toggles[site.id] === 'boolean' ? toggles[site.id] : !!site.defaultOn;
}

// ---------- 바로 가기 ----------
// 지도 주소에 위치를 넘길 수 있는 곳(네이버, 피터팬, 다방, KB부동산)은 고른 지역 가운데로, 집토스와 당근부동산은 가까운 역 페이지로,
// 직방은 가까운 역의 직방 역 번호로, 호갱노노는 가까운 역 옆 단지 화면으로 연다(역 번호, 단지 번호는 대시보드가 역 목록에 붙여 줌).
// 그 값을 모르면 첫 화면을 연다. 대시보드의 web/src/siteLinks.ts와 같게 유지한다.

const HNW_BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function hnwBase62(n) {
  let s = '';
  do {
    s = HNW_BASE62[n % 62] + s;
    n = Math.floor(n / 62);
  } while (n > 0);
  return s;
}

/**
 * 네이버 새 지도(fin.land) 주소의 center 값. 경도, 위도를 각각 ×10^7 + 2×10^9 한 정수를 62진수(0-9a-zA-Z)로 적고 '-'로 잇는다.
 */
function hnwNaverCenter(lat, lng) {
  return `${hnwBase62(Math.round(lng * 1e7) + 2e9)}-${hnwBase62(Math.round(lat * 1e7) + 2e9)}`;
}

/** 당근부동산 지도 범위 값(주소의 mv): '남쪽 위도,서쪽 경도,북쪽 위도,동쪽 경도,확대'. 지역 반경의 1.3배 네모. */
function hnwDaangnView(area, zoom) {
  const dLat = (area.radiusM * 1.3) / 111320;
  const dLng = (area.radiusM * 1.3) / (111320 * Math.cos((area.lat * Math.PI) / 180));
  return [area.lat - dLat, area.lng - dLng, area.lat + dLat, area.lng + dLng].map((v) => v.toFixed(5)).concat(String(zoom)).join(',');
}

/** area: { name, lat, lng, radiusM } 또는 null. stations: [{ name, lat, lng, zigbangId?, hogangnonoApt? }] */
function hnwSiteLinks(area, stations) {
  const zoom = area && area.radiusM > 1200 ? 13 : 14;
  const station = area
    ? (stations || [])
        .map((s) => ({ s, d: hnwDistanceM(area.lat, area.lng, s.lat, s.lng) }))
        .filter((x) => x.d <= 2000)
        .sort((a, b) => a.d - b.d)[0]?.s
    : null;
  const center = area ? encodeURIComponent(JSON.stringify({ y: area.lat, _lat: area.lat, x: area.lng, _lng: area.lng })) : '';
  const home = '첫 화면을 엽니다';
  return [
    {
      id: 'naver',
      name: '네이버 부동산',
      main: true,
      url: area ? `https://fin.land.naver.com/map?center=${hnwNaverCenter(area.lat, area.lng)}&zoom=${zoom}` : null,
      where: area ? `${area.name} 가운데로 네이버 부동산 지도를 엽니다` : '마지막으로 본 네이버 지도를 엽니다',
    },
    {
      id: 'peterpanz',
      name: '피터팬',
      url: area
        ? `https://www.peterpanz.com/villa?zoomLevel=${zoom}&center=${center}&dong=&gungu=&filter=${encodeURIComponent('buildingType;["빌라/주택"]')}&filter_version=5.1`
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
      url: station && station.zigbangId ? `https://www.zigbang.com/home/oneroom/subways/${encodeURIComponent(station.zigbangId)}/items` : 'https://www.zigbang.com/',
      where: station && station.zigbangId ? `직방 ${station.name} 원룸 목록을 엽니다` : home,
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
      url: station && station.hogangnonoApt ? `https://hogangnono.com/apt/${encodeURIComponent(station.hogangnonoApt)}` : 'https://hogangnono.com/',
      where: station && station.hogangnonoApt ? `호갱노노를 ${station.name} 옆 단지 화면으로 엽니다` : home,
    },
    {
      id: 'daangn',
      name: '당근부동산',
      url: station ? `https://realty.daangn.com/map/subway/${encodeURIComponent(station.name.replace(/역$/, ''))}${area ? `?mv=${encodeURIComponent(hnwDaangnView(area, zoom))}` : ''}` : 'https://realty.daangn.com/',
      where: station ? `당근부동산 ${station.name} 근처 매물 지도를 엽니다` : home,
    },
  ];
}

/** 지역도, 마지막으로 본 네이버 지도도 없을 때 여는 네이버 지도(서울시청 가운데). */
const HNW_NAVER_DEFAULT_URL = 'https://fin.land.naver.com/map?center=3zhAz4-2ALXsc&zoom=15';

// ---------- 한 번에 열기 ----------
// 확장에서 켜 둔 사이트의 바로 가기만 새 창 하나에 연다(네이버가 첫 탭).
// 확장 목록에 없는 법원경매와 꺼 둔 사이트는 뺀다. 피터팬, 집토스는 '조회하기'가 모으므로 기본으로 꺼져 있다.

/** 대시보드 '조회하기'가 스스로 모으는 곳(열지 않아도 됨). */
const HNW_AUTO_SITES = ['peterpanz', 'ziptoss', 'courtauction'];

/** 한 번에 열 바로 가기(open)와 뺀 바로 가기(rest). */
function hnwOpenLinks(area, stations, toggles) {
  const on = (link) => {
    const site = HNW_SITES.find((s) => s.id === link.id);
    return !!site && hnwEnabled(toggles, site);
  };
  const links = hnwSiteLinks(area, stations);
  return { open: links.filter(on), rest: links.filter((l) => !on(l)) };
}

/** 짧은 이름(네이버 부동산 → 네이버, KB부동산 → KB). */
const hnwShortName = (name) => name.replace(/ ?부동산$/, '');
