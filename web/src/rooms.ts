import { priceAmount } from '../../shared/format';
import { listingSection, type ListingView } from '../../shared/types';

// 고시원, 원룸텔, 쉐어하우스, 코리빙(방 한 칸씩 빌리는 곳). 매매와 전월세와 따로 '고시원과 쉐어' 탭에서 본다.

const typesOf = (l: Pick<ListingView, 'buildingType'>) =>
  (l.buildingType ?? '').split(',').map((t) => t.trim()).filter(Boolean);

/** 고시원과 쉐어 탭 매물(고방의 원룸, 투룸, 오피스텔이 아닌 것). 매물 탭에는 넣지 않는다. */
export const isRoomStay = (l: Pick<ListingView, 'source' | 'buildingType'>) => listingSection(l) === 'room';

/** 유형 글자: 사이트 유형 '고시원, 원룸텔' → '고시원, 원룸텔' */
export const roomTypesText = (l: Pick<ListingView, 'buildingType'>) => typesOf(l).join(', ') || null;

/** 고시원과 쉐어의 가격이 둘이면 그 곳 방 중 가장 싼 방 ~ 비싼 방이라 '0/22 ~ 0/40'처럼 잇는다. 아니면 null. */
export function roomRange(l: Pick<ListingView, 'source' | 'buildingType' | 'prices'>): string | null {
  const ps = l.prices;
  return isRoomStay(l) && ps.length > 1 ? `${priceAmount(ps[0])} ~ ${priceAmount(ps[ps.length - 1])}` : null;
}

/** 탭 안 종류 칸. 여러 유형이 붙은 곳('코리빙, 쉐어하우스')은 사이트가 앞에 둔 유형으로 센다. */
export type RoomType = 'gosi' | 'share' | 'coliving' | 'etc';
export const ROOM_TYPES: RoomType[] = ['gosi', 'share', 'coliving', 'etc'];
export const ROOM_TYPE_LABEL: Record<RoomType, string> = { gosi: '고시원과 원룸텔', share: '쉐어하우스', coliving: '코리빙', etc: '그 밖' };
const TYPE_OF: Record<string, RoomType> = { 고시원: 'gosi', 원룸텔: 'gosi', 쉐어하우스: 'share', 코리빙: 'coliving' };

export function roomTypeOf(l: Pick<ListingView, 'buildingType'>): RoomType {
  for (const t of typesOf(l)) if (TYPE_OF[t]) return TYPE_OF[t];
  return 'etc';
}

const hasNews = (l: ListingView) => l.isNew || !!l.priceChange;
const lowest = (l: ListingView, key: 'monthly' | 'deposit') => Math.min(...l.prices.map((p) => p[key] ?? Infinity), Infinity);

/** 새 소식 먼저, 그다음 가장 싼 방 월세 → 보증금이 낮은 순. */
export function sortRooms(list: ListingView[]): ListingView[] {
  return [...list].sort(
    (a, b) =>
      Number(hasNews(b)) - Number(hasNews(a)) ||
      lowest(a, 'monthly') - lowest(b, 'monthly') ||
      lowest(a, 'deposit') - lowest(b, 'deposit') ||
      b.firstSeenAt.localeCompare(a.firstSeenAt),
  );
}
