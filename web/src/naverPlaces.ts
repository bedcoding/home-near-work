import type { ListingView } from '../../shared/types';
import { distanceM } from '../../shared/geo';
import { kindOf } from './kinds';
import { naverCenter } from './siteLinks';

// 카드와 지도 정보 창의 '네이버' 단추가 여는 곳을 고른다.
// - 네이버 단지 매물: 그 단지 화면(fin.land.naver.com/complexes/번호).
// - 다른 사이트 매물: 같은 자리에 같은 종류의 네이버 단지가 있으면 그 단지 화면. 위치로 찾은 것이라 다른 단지일 수 있어 단추 설명에 적는다.
// - 그 밖: 지금처럼 그 자리의 네이버 부동산 지도.
// 다른 사이트 매물은 네이버 매물 번호가 없어서 그 매물의 네이버 상세는 열 수 없다.

/** 단추 하나: 여는 주소, 글자, 마우스를 올리면 보이는 설명 */
export interface NaverLink {
  url: string;
  label: string;
  title: string;
}

/** 네이버 단지 화면 주소 */
const complexUrl = (no: string) => `https://fin.land.naver.com/complexes/${no}`;

/** 네이버 매물의 단지 번호. 단지 매물은 원본 주소가 단지 화면이라 거기서 읽는다(아니면 null). */
export function naverComplexOf(l: Pick<ListingView, 'source' | 'url'>): string | null {
  if (l.source !== 'naver') return null;
  return /\/complexes\/(\d+)/.exec(l.url ?? '')?.[1] ?? null;
}

/**
 * 같은 자리로 치는 거리(m). 아파트와 오피스텔은 단지가 넓어 50m, 빌라는 이웃 건물을 잘못 잡지 않게 15m.
 * 그 밖의 종류(단독, 원룸 건물 등)는 네이버 단지가 거의 없어 맞추지 않는다.
 * 실제 매물로 재 보니 다른 사이트 매물 1만 8천여 건 중 50m 안 같은 종류 단지는 33%, 15m 안은 8%였다.
 */
const NEAR_M: Record<string, number> = { apt: 50, officetel: 50, villa: 15 };

interface Place {
  no: string;
  lat: number;
  lng: number;
  kind: string;
}
/** 자리를 나눠 두는 칸(위도와 경도 0.001도, 약 110m × 88m). 찾을 거리가 칸보다 작아서 둘레 아홉 칸만 본다. */
const CELL = 0.001;
const cellKey = (lat: number, lng: number) => `${Math.floor(lat / CELL)},${Math.floor(lng / CELL)}`;

let source: readonly ListingView[] = [];
let builtFrom: readonly ListingView[] | null = null;
let places = new Map<string, Place[]>();

/**
 * 네이버 단지 매물의 자리를 모을 매물 목록을 알려 준다(매물 탭이 받은 매물 전체). 목록이 바뀔 때마다 부르지만
 * 실제로 모으는 일은 단추를 처음 만들 때 한 번만 한다('봤음'이나 버림처럼 표시만 바뀐 때마다 다시 모으지 않게).
 */
export function rememberNaverPlaces(listings: readonly ListingView[]) {
  source = listings;
}

function ensurePlaces() {
  if (builtFrom === source) return;
  builtFrom = source;
  const next = new Map<string, Place[]>();
  for (const l of source) {
    const no = naverComplexOf(l);
    if (!no || l.lat == null || l.lng == null) continue;
    const key = cellKey(l.lat, l.lng);
    const place = { no, lat: l.lat, lng: l.lng, kind: kindOf(l) };
    const cell = next.get(key);
    if (cell) cell.push(place);
    else next.set(key, [place]);
  }
  places = next;
}

/** l과 같은 자리(NEAR_M 안)에 있는 같은 종류의 네이버 단지 중 가장 가까운 것 */
function nearestComplex(l: ListingView): Place | null {
  const kind = kindOf(l);
  const limit = NEAR_M[kind];
  if (!limit || l.lat == null || l.lng == null) return null;
  ensurePlaces();
  const gy = Math.floor(l.lat / CELL);
  const gx = Math.floor(l.lng / CELL);
  let best: Place | null = null;
  let bestM = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const p of places.get(`${gy + dy},${gx + dx}`) ?? []) {
        if (p.kind !== kind) continue;
        const m = distanceM(l.lat, l.lng, p.lat, p.lng);
        if (m <= limit && m < bestM) {
          best = p;
          bestM = m;
        }
      }
    }
  }
  return best;
}

/** 카드와 지도 정보 창의 '네이버' 단추. 위치를 모르는 매물이면 null(단추를 두지 않는다). */
export function naverLink(l: ListingView): NaverLink | null {
  const own = naverComplexOf(l);
  if (own) return { url: complexUrl(own), label: '네이버 단지 ↗', title: '네이버 부동산에서 이 단지 화면을 엽니다' };
  if (l.lat == null || l.lng == null) return null;
  const near = l.source === 'naver' ? null : nearestComplex(l);
  if (near) {
    return {
      url: complexUrl(near.no),
      label: '네이버 단지 ↗',
      title: `같은 자리(${NEAR_M[kindOf(l)]}m 안)에 있는 같은 종류의 네이버 단지 화면을 엽니다. 위치로 찾은 것이라 다른 단지일 수 있습니다`,
    };
  }
  return {
    url: `https://fin.land.naver.com/map?center=${naverCenter(l.lat, l.lng)}&zoom=16`,
    label: '네이버 지도 ↗',
    title: l.source === 'naver'
      ? '이 자리를 네이버 부동산 지도로 엽니다. 이 매물의 네이버 상세는 원본 열기로 봅니다'
      : '이 자리를 네이버 부동산 지도로 엽니다(같은 자리의 네이버 단지를 찾지 못했습니다)',
  };
}
