import { COLLECTION_AMOUNT_LABELS } from '../../shared/collection-price-limits';
import type { CollectionPriceLimits } from '../../shared/types';

const key = 'hnw-common-collection-prices';
const fields = Object.keys(COLLECTION_AMOUNT_LABELS) as (keyof typeof COLLECTION_AMOUNT_LABELS)[];

export function loadCommonCollectionPrices(): CollectionPriceLimits | null {
  try {
    const limits = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!limits || typeof limits.excludeSale !== 'boolean' || !fields.every(field => {
      const amount = limits[field];
      return amount === null || (Number.isSafeInteger(amount) && amount >= 0);
    })) return null;
    return {
      saleMax: limits.saleMax, jeonseMax: limits.jeonseMax, monthlyDepositMax: limits.monthlyDepositMax,
      monthlyMax: limits.monthlyMax, excludeSale: limits.excludeSale,
    };
  } catch {
    return null;
  }
}

export function saveCommonCollectionPrices(limits: CollectionPriceLimits | null) {
  try {
    if (limits) localStorage.setItem(key, JSON.stringify(limits));
    else localStorage.removeItem(key);
  } catch {
    // 조회는 브라우저 저장소 없이도 가능하다.
  }
}

export function commonPricesForRun(limits: CollectionPriceLimits | null, rentalOnly: boolean): CollectionPriceLimits | null {
  if (!limits || !rentalOnly) return limits;
  if (limits.jeonseMax === null && limits.monthlyDepositMax === null && limits.monthlyMax === null) return null;
  return { ...limits, saleMax: null, excludeSale: true };
}
