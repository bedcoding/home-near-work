import { pointInGeometry, regionBoundaries } from '../../shared/region-geometry';
import { SEOUL_GUS, type ListingView } from '../../shared/types';
import { kindOf } from './kinds';
import { coord, type NaverLink } from './naverPlaces';

// 카드와 지도 정보 창에서 시세와 리뷰 사이트를 여는 단추. 데이터는 받아 오지 않고 링크만 건다.
// 주소 형식은 2026-11-21에 실제로 열어 확인했다.
// - KB부동산: kbland.kr/map?xy=위도,경도,확대. 역 두 곳의 좌표로 열어 지도 가운데가 맞음.
// - 호갱노노: hogangnono.com/map?lat=위도&lng=경도&zoom=확대&mode=apt 또는 item(오피스텔, 원룸, 빌라 탭).
//   첫 화면 주소(hogangnono.com/?lat=...)는 좌표를 무시하고 마지막으로 본 자리로 간다.
//   두 곳 모두 그 자리에 핀을 찍지는 않으므로 지도 한가운데가 이 매물 자리다.
// - 집품: zippoom.com/search/주소?searchWithAddress=false. 지번('서울 중구 태평로1가 31')이든 도로명('서울 중구 세종대로 110')이든
//   그 건물이 검색 결과 맨 위에 나온다. searchWithAddress=true는 다른 건물이 먼저 나왔다. 지도 주소(/map)는 좌표를 무시한다.
// - 부동산플래닛: 검색창에 주소를 넣으면 그 건물 화면으로 가지만, 검색어를 주소창으로 넘기는 방법이 없다.
//   건물 화면 주소(map.bdsplanet.com/내부값/N/Z/1/0)는 사이트가 필지 번호를 바꾼 값이라 만들 수 없어서,
//   주소를 복사해 두고 실거래가 지도를 연다(검색창에 붙여 넣으면 됨). 지도 주소에 좌표를 넣어도 마지막으로 본 자리로 열린다.
//   사이트 안쪽 조회 주소를 서버에서 불러 건물 화면 주소를 만드는 방식은 사이트가 허락한 방식이 아니어서 쓰지 않는다.
// 집품과 부동산플래닛은 번지나 도로명 번호까지 있는 주소(법원경매, 온비드, 일부 코리빙과 당근)면 그 건물로, 중개 사이트 매물처럼
// '구 동'까지만 있으면 그 동으로 연다(동 검색 결과나 복사한 동 이름에 번지를 더 넣으면 됨). 다방 '주소 보기'도 확인한 한 건(2026-11-21)은 동까지만 줬다.

/** 단추 하나. copy가 있으면 누를 때 그 글자를 복사하고 url을 연다. */
export interface SiteButton extends NaverLink {
  copy?: string;
}

/** 건물 단위로 보이는 확대 */
const ZOOM = 17;

/**
 * 이 매물 자리를 KB부동산과 호갱노노 지도로 여는 단추들. 위치를 모르거나 토지, 상가면 두지 않는다(두 곳 모두 집 시세를 보는 곳).
 * 호갱노노는 아파트면 아파트 탭으로, 그 밖의 집은 오피스텔, 원룸, 빌라 탭으로 연다.
 */
export function priceSiteLinks(l: Pick<ListingView, 'lat' | 'lng' | 'buildingType'>): NaverLink[] {
  if (l.lat == null || l.lng == null) return [];
  const kind = kindOf(l);
  if (kind === 'land' || kind === 'shop') return [];
  const lat = coord(l.lat);
  const lng = coord(l.lng);
  const apt = kind === 'apt';
  const center = '핀은 없고 지도 한가운데가 이 매물 자리입니다';
  return [
    {
      url: `https://kbland.kr/map?xy=${lat},${lng},${ZOOM}`,
      label: 'KB부동산 ↗',
      title: `KB부동산 지도를 이 매물 자리 가운데로 엽니다. ${center}. 주변 단지 KB시세와 실거래가를 봅니다`,
    },
    {
      url: `https://hogangnono.com/map?lat=${lat}&lng=${lng}&zoom=${ZOOM}&mode=${apt ? 'apt' : 'item'}`,
      label: '호갱노노 ↗',
      title: `호갱노노 ${apt ? '아파트' : '오피스텔, 원룸, 빌라'} 지도를 이 매물 자리 가운데로 엽니다. ${center}. 주변 실거래가와 매물을 봅니다`,
    },
  ];
}

/** 시도 이름을 짧게('서울특별시', '서울시' → '서울', '경기도' → '경기', '충청북도' → '충북'). 시도가 아니면 null. */
function sidoOf(word: string): string | null {
  const short: [RegExp, string][] = [
    [/^서울(특별시|시)?$/, '서울'], [/^부산(광역시|시)?$/, '부산'], [/^대구(광역시|시)?$/, '대구'], [/^인천(광역시|시)?$/, '인천'],
    [/^광주(광역시)?$/, '광주'], [/^대전(광역시|시)?$/, '대전'], [/^울산(광역시|시)?$/, '울산'], [/^세종(특별자치시|시)?$/, '세종'],
    [/^경기(도)?$/, '경기'], [/^강원(특별자치도|도)?$/, '강원'], [/^(충청북도|충북)$/, '충북'], [/^(충청남도|충남)$/, '충남'],
    [/^(전라북도|전북특별자치도|전북)$/, '전북'], [/^(전라남도|전남)$/, '전남'], [/^(경상북도|경북)$/, '경북'], [/^(경상남도|경남)$/, '경남'],
    [/^제주(특별자치도|도)?$/, '제주'],
  ];
  return short.find(([re]) => re.test(word))?.[1] ?? null;
}

/**
 * 집품과 부동산플래닛 검색에 넣을 주소. 주소 글자에 번지('예시동 123', '예시동2가 45-6', '산 12')나 도로명 번호('예시로12길 34')가
 * 있을 때만 '시도 구 동 번지' 또는 '시도 구 도로명 번호'로 만들고, 그 뒤의 건물 이름, 동, 층, 호는 뺀다.
 * 시도가 없고 서울 구면 '서울'을 붙인다(대구에도 중구 태평로1가가 있어 시도가 없으면 다른 곳이 먼저 나온다).
 * 동까지만 있거나('노원구 예시동') 시, 군, 구를 못 찾으면 null.
 */
export function searchAddressOf(address: string | null | undefined): string | null {
  const p = parseAddress(address);
  return p?.number ? [p.sido, ...p.gus, ...p.places, p.number].filter(Boolean).join(' ') : null;
}

/**
 * 번지 없이 '시도 구 동'까지 남긴 주소('노원구 예시동' → '서울 노원구 예시동', 번지가 있으면 번지를 뺀다).
 * 중개 사이트 매물처럼 동까지만 있을 때 집품과 부동산플래닛을 그 동으로 여는 데 쓴다. 시, 군, 구나 동을 못 찾으면 null.
 */
export function areaAddressOf(address: string | null | undefined): string | null {
  const p = parseAddress(address);
  return p ? [p.sido, ...p.gus, ...p.places].filter(Boolean).join(' ') : null;
}

/** 주소 글자를 시도, 시군구, 동이나 도로명, 번지로 나눈다(번지는 없으면 null). 시, 군, 구나 동, 도로명을 못 찾으면 null. */
function parseAddress(address: string | null | undefined): { sido: string | null; gus: string[]; places: string[]; number: string | null } | null {
  const words = (address ?? '').replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  let sido = words[0] ? sidoOf(words[0]) : null;
  if (sido) i++;
  const gus: string[] = [];
  while (i < words.length && /^[가-힣]+(시|군|구)$/.test(words[i])) gus.push(words[i++]);
  if (!gus.length) return null;
  if (!sido && gus.some((g) => SEOUL_GUS.includes(g))) sido = '서울';
  const places: string[] = [];
  while (i < words.length && /^[가-힣0-9]+(동|가|리|읍|면|로|길)$/.test(words[i])) places.push(words[i++]);
  const last = places[places.length - 1];
  if (!last) return null;
  const road = /(로|길)$/.test(last);
  // 번지: 도로명 뒤에는 건물 번호(12, 12-3), 동, 가, 리 뒤에는 지번(12, 12-3, 산12, 산 12, 12번지, 경매의 '12-3외 2필지')
  const bare = (w: string | undefined) => (w ?? '').replace(/(번지|외)$/, '');
  const next = bare(words[i]);
  let number: string | null = null;
  if (road && /^\d+(-\d+)?$/.test(next)) number = next;
  else if (!road && /^산?\d+(-\d+)?$/.test(next)) number = next;
  else if (!road && next === '산' && /^\d+(-\d+)?$/.test(bare(words[i + 1]))) number = `산${bare(words[i + 1])}`;
  return { sido, gus, places, number };
}

/** 좌표가 든 서울 구 이름(대시보드 구 경계로 찾음, 서울 밖이거나 위치를 모르면 null) */
function seoulGuAt(lat: number | null | undefined, lng: number | null | undefined): string | null {
  if (lat == null || lng == null) return null;
  return regionBoundaries.features.find((f) => pointInGeometry(f.geometry, lat, lng))?.properties.sggnm ?? null;
}

/**
 * 집품과 부동산플래닛을 여는 단추들. 번지까지 있으면 그 건물로, 동까지만 있으면 그 동으로 연다(주소를 못 읽으면 없음).
 * 다방처럼 주소 칸이 비었거나 구가 빠진 매물은 매물의 동 이름과 좌표가 든 서울 구로 '서울 구 동'을 만든다.
 * 집품은 그 주소나 동의 검색 결과를 연다(집 리뷰라 토지, 상가는 뺀다). 부동산플래닛은 주소나 동을 복사하고 실거래가 지도를 연다.
 */
export function addressSiteLinks(l: Pick<ListingView, 'buildingType' | 'dong' | 'lat' | 'lng'>, address: string | null | undefined): SiteButton[] {
  const exact = searchAddressOf(address);
  const gu = l.dong && /^[가-힣0-9]+(동|가|리)$/.test(l.dong) ? seoulGuAt(l.lat, l.lng) : null;
  const target = exact ?? areaAddressOf(address) ?? (gu ? `서울 ${gu} ${l.dong}` : null);
  if (!target) return [];
  const kind = kindOf(l);
  const out: SiteButton[] = [];
  if (kind !== 'land' && kind !== 'shop') {
    out.push({
      url: `https://zippoom.com/search/${encodeURIComponent(target)}?searchWithAddress=false`,
      label: '집품 ↗',
      title: exact
        ? `집품에서 이 주소(${target})로 검색한 결과를 엽니다. 맨 위 건물을 누르면 거주 리뷰가 보입니다`
        : `집품에서 이 동(${target})으로 검색한 결과를 엽니다. 번지를 모르는 매물이라 건물은 직접 골라야 합니다. 번지를 알면 위 검색창에 더 넣으면 그 건물로 좁혀집니다`,
    });
  }
  out.push({
    url: 'https://map.bdsplanet.com/',
    label: '부동산플래닛 ↗',
    title: exact
      ? `이 주소(${target})를 복사하고 부동산플래닛 실거래가 지도를 엽니다. 위 검색창에 Ctrl+V로 붙여 넣고 고르면 그 건물로 갑니다`
      : `이 동(${target})을 복사하고 부동산플래닛 실거래가 지도를 엽니다. 위 검색창에 Ctrl+V로 붙여 넣으면 그 동 건물들이 추천에 뜨고, 하나를 고르면 지도가 그 동으로 갑니다. 번지를 알면 뒤에 더 넣으면 그 건물로 갑니다`,
    copy: target,
  });
  return out;
}

/** 글자를 클립보드에 복사한다. 클립보드를 못 쓰는 창이면 숨긴 글상자로 복사한다. */
export function copyText(text: string) {
  const fallback = () => {
    const box = document.createElement('textarea');
    box.value = text;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    try { document.execCommand('copy'); } finally { box.remove(); }
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback);
  else fallback();
}
