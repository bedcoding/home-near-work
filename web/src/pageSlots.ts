/**
 * 쪽 번호 줄에 놓을 쪽(0부터). 7쪽까지는 모두 두고, 넘으면 첫 쪽, 지금 쪽 둘레, 끝 쪽만 두고 사이는 줄임표(null)로 둔다.
 * 예: 16쪽 중 첫 쪽이면 1 2 3 4 5 … 16, 8쪽이면 1 … 7 8 9 … 16. 지도 매물 창과 매물 탭의 묶음 목록이 같이 쓴다.
 */
export function pageSlots(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i);
  if (page <= 3) return [0, 1, 2, 3, 4, null, pages - 1];
  if (page >= pages - 4) return [0, null, pages - 5, pages - 4, pages - 3, pages - 2, pages - 1];
  return [0, null, page - 1, page, page + 1, null, pages - 1];
}
