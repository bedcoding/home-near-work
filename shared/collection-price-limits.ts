import { manwon } from './format.js';
import type { CollectionPriceLimits } from './types.js';

export const COLLECTION_AMOUNT_LABELS = {
  saleMax: '매매가',
  jeonseMax: '전세금',
  monthlyDepositMax: '월세 보증금',
  monthlyMax: '월세',
} as const;

export function collectionPriceSummary(limits: CollectionPriceLimits): string {
  const sameDeposit = limits.jeonseMax !== null && limits.jeonseMax === limits.monthlyDepositMax;
  const amounts = (Object.keys(COLLECTION_AMOUNT_LABELS) as (keyof typeof COLLECTION_AMOUNT_LABELS)[])
    .flatMap(key => {
      const value = limits[key];
      if (value === null || (key === 'saleMax' && limits.excludeSale) || (key === 'monthlyDepositMax' && sameDeposit)) return [];
      const label = key === 'jeonseMax' && sameDeposit ? '보증금과 전세금' : COLLECTION_AMOUNT_LABELS[key];
      return [`${label} ${manwon(value)}원 이하`];
    });
  if (limits.excludeSale) amounts.unshift('매매 제외');
  return amounts.join(', ') || '가격 제한 없음';
}
