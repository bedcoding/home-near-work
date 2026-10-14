// 네이버 부동산(fin.land) 화면이 받은 매물 목록 응답을 NormalizedListing으로 바꾼다.
// 응답은 크롬 확장이 보낸 것이다(naver-capture.ts).
// 목록 한 줄은 '대표 매물 + 같은 집을 올린 다른 중개사 매물' 묶음이라, 묶음 하나를 매물 하나로 본다.

import { toNumber } from './collectors/types.js';
import { floorText, money, priceText } from '../shared/format.js';
import type { DealType, ExplainRow, NormalizedListing, PriceOption } from '../shared/types.js';

// 거래 유형 코드. A1 매매, B1 전세, B2 월세, B3 단기.
const DEALS: Record<string, DealType> = { A1: 'sale', B1: 'jeonse', B2: 'monthly', B3: 'short' };
// 매물 종류 코드. 모르는 코드는 그대로 보인다.
const TYPES: Record<string, string> = { A01: '아파트', A04: '재건축', B01: '아파트 분양권', C03: '단독/다가구', D05: '상가주택', E03: '토지' };

/** 원 → 만원 */
const manwon = (value: unknown) => {
  const n = toNumber(value);
  return n == null ? null : Math.round(n / 10000);
};

export interface NaverItem {
  listing: NormalizedListing;
  /** 묶음 안의 모든 매물 번호(중개사마다 다르다). */
  numbers: string[];
  raw: unknown;
}

/** 목록 응답(result.list)의 한 줄을 매물 하나로 바꾼다. 모양이 다르면 null. */
export function normalizeNaverItem(item: any): NaverItem | null {
  const rep = item?.representativeArticleInfo;
  if (!rep?.articleNumber) return null;
  const numbers = [
    ...new Set([String(rep.articleNumber), ...(item.duplicatedArticleInfo?.articleInfoList ?? []).map((a: any) => String(a.articleNumber))]),
  ].sort((a, b) => Number(a) - Number(b));

  const tradeType = String(rep.tradeType ?? '');
  const deal = DEALS[tradeType];
  const p = rep.priceInfo ?? {};
  const price: PriceOption | null = deal
    ? {
        deal,
        deposit: deal === 'sale' ? null : manwon(p.warrantyPrice),
        monthly: deal === 'monthly' || deal === 'short' ? manwon(p.rentPrice) : null,
        price: deal === 'sale' ? manwon(p.dealPrice) : null,
      }
    : null;

  // 층은 '7'처럼 숫자일 때도 있고 '저·중·고'로만 나올 때도 있다.
  const fl = rep.articleDetail?.floorDetailInfo ?? {};
  const target = String(fl.targetFloor ?? '');
  const floorNumber = /^-?\d+$/.test(target) ? Number(target) : null;
  const complexNumber = toNumber(rep.complexNumber);
  const direction = rep.articleDetail?.direction ?? '';
  const coords = rep.address?.coordinates ?? {};

  const listing: NormalizedListing = {
    source: 'naver',
    // 대표 매물은 볼 때마다 바뀔 수 있어서, 묶음에서 가장 오래된(작은) 번호를 고정 번호로 쓴다.
    sourceId: numbers[0],
    // 단지 매물 목록 주소를 연다.
    url: complexNumber ? `https://fin.land.naver.com/complexes/${complexNumber}?tab=article` : `https://fin.land.naver.com/articles/${rep.articleNumber}`,
    title: [rep.complexName || rep.articleName, rep.dongName ? `${rep.dongName}동` : null].filter(Boolean).join(' '),
    thumbnail: rep.articleMedia?.imageUrl ?? rep.articleMedia?.photos?.[0]?.imagePath ?? null,
    lat: toNumber(coords.yCoordinate),
    lng: toNumber(coords.xCoordinate),
    address: [rep.address?.city, rep.address?.division, rep.address?.sector].filter(Boolean).join(' ') || null,
    dong: rep.address?.sector ?? null,
    // 층이 '중'처럼 나오면 층 숫자로 구분이 안 되므로, 단지·동에 층 구간과 방향까지 붙여 같은 집을 가린다.
    buildingKey: complexNumber ? `nv-c${complexNumber}-${rep.dongName ?? ''}-${floorNumber == null ? target : ''}-${direction}` : null,
    buildingType: TYPES[rep.realEstateType] ?? rep.realEstateType ?? null,
    roomLabel: null,
    rooms: null,
    areaM2: toNumber(rep.spaceInfo?.exclusiveSpace),
    floor: floorNumber,
    totalFloors: toNumber(fl.totalFloor),
    basement: floorNumber != null ? floorNumber < 0 : /지하|반지/.test(target) ? true : null,
    rooftop: /옥탑/.test(target) ? true : null,
    builtYear: toNumber(String(rep.buildingInfo?.buildingConjunctionDate ?? '').slice(0, 4)),
    maintenance: manwon(p.managementFeeAmount),
    elevator: null,
    parking: null,
    availableFrom: null,
    updatedAt: rep.verificationInfo?.articleConfirmDate ?? rep.verificationInfo?.exposureStartDate ?? null,
    prices: price ? [price] : [],
  };

  const explain: ExplainRow[] = [
    {
      label: '가격',
      raw: `tradeType="${tradeType}", priceInfo.dealPrice=${p.dealPrice ?? '없음'}원, warrantyPrice=${p.warrantyPrice ?? '없음'}원, rentPrice=${p.rentPrice ?? '없음'}원`,
      value: listing.prices.map(priceText).join(', ') || '없음',
      note: '원 → 만원으로 바꿈. B2(월세)·B3(단기) 코드는 추정',
    },
    { label: '매물 종류', raw: `realEstateType="${rep.realEstateType ?? ''}"`, value: listing.buildingType ?? '모름' },
    {
      label: '전용면적',
      raw: `spaceInfo.exclusiveSpace=${rep.spaceInfo?.exclusiveSpace ?? '없음'}, supplySpace=${rep.spaceInfo?.supplySpace ?? '없음'}`,
      value: listing.areaM2 != null ? `${listing.areaM2}㎡` : '모름',
    },
    {
      label: '층',
      raw: `articleDetail.floorInfo="${rep.articleDetail?.floorInfo ?? ''}"`,
      value: floorText(listing),
      note: '저·중·고로만 나오면 층 숫자는 모름으로 둠',
    },
    { label: '관리비', raw: `priceInfo.managementFeeAmount=${p.managementFeeAmount ?? '없음'}원`, value: listing.maintenance != null ? `${money(listing.maintenance)}만` : '모름', note: '원 → 만원으로 바꿈' },
    {
      label: '확인일',
      raw: `verificationInfo.articleConfirmDate="${rep.verificationInfo?.articleConfirmDate ?? ''}", exposureStartDate="${rep.verificationInfo?.exposureStartDate ?? ''}"`,
      value: listing.updatedAt ?? '모름',
    },
    { label: '위치', raw: `address.coordinates=${coords.yCoordinate}, ${coords.xCoordinate}`, value: `${listing.lat}, ${listing.lng}` },
    {
      label: '같은 집 묶음',
      raw: `duplicatedArticleInfo.realtorCount=${item.duplicatedArticleInfo?.realtorCount ?? 1}, 매물 번호 ${numbers.join(', ')}`,
      value: `중개사 ${numbers.length}곳, 고정 번호 ${listing.sourceId}`,
      note: '네이버가 같은 집으로 묶은 매물을 하나로 봄',
    },
    { label: '건물 식별값', raw: `complexNumber=${rep.complexNumber ?? '없음'}, dongName="${rep.dongName ?? ''}", 층 구간 "${target}", 방향 "${direction}"`, value: listing.buildingKey ?? '없음', note: '재등록(같은 집) 판정에 씀' },
  ];
  listing.explain = explain;
  return { listing, numbers, raw: item };
}

/** 목록 응답 본문에서 매물들을 꺼낸다. 목록 모양이 아니면 null. */
export function parseNaverList(body: string): { items: NaverItem[]; totalCount: number | null } | null {
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const list = json?.result?.list;
  if (!Array.isArray(list)) return null;
  const items = list.map(normalizeNaverItem).filter((x): x is NaverItem => x !== null);
  return { items, totalCount: toNumber(json.result.totalCount) };
}
