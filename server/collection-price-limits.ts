import { createHash } from 'node:crypto';
import { COLLECTION_AMOUNT_LABELS } from '../shared/collection-price-limits.js';
import type { CollectionPriceLimits, CollectionPriceLimitsState, CollectionPriceOverrides, RunScope, SourceId } from '../shared/types.js';

const upstreamSites: readonly SourceId[] = ['dabang', 'zigbang'];
const amountKeys = Object.keys(COLLECTION_AMOUNT_LABELS) as (keyof typeof COLLECTION_AMOUNT_LABELS)[];
const unrestricted: CollectionPriceLimits = { saleMax: null, jeonseMax: null, monthlyDepositMax: null, monthlyMax: null, excludeSale: false };
export const collectionPriceLimitsKey = (source: SourceId) => `collection_price_limits_${source}`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseLimits(value: unknown): CollectionPriceLimits | null {
  if (value === null) return null;
  const row = asRecord(value);
  if (!row || typeof row.excludeSale !== 'boolean'
    || Object.keys(row).some(key => key !== 'excludeSale' && !Object.hasOwn(COLLECTION_AMOUNT_LABELS, key))) {
    throw new Error('매물 가격 제한 설정을 확인해 주세요.');
  }
  const limits: CollectionPriceLimits = { ...unrestricted, excludeSale: row.excludeSale };
  for (const key of amountKeys) {
    const amount = row[key];
    if (amount === null) continue;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(`${COLLECTION_AMOUNT_LABELS[key]} 상한은 만원 단위의 0 이상 정수로 입력해 주세요.`);
    }
    limits[key] = amount;
  }
  return limits.excludeSale || amountKeys.some(key => limits[key] !== null) ? limits : null;
}

export function collectionPriceLimitsChange(value: unknown): { source: SourceId; limits: CollectionPriceLimits | null } {
  const row = asRecord(value);
  const source = upstreamSites.find(site => site === row?.source);
  if (!source) throw new Error('수집 가격 제한을 지원하는 사이트를 선택해 주세요.');
  return { source, limits: parseLimits(row?.limits) };
}

/** Validate temporary conditions against the sites selected for this run. */
export function collectionPriceOverrides(value: unknown, sources: readonly SourceId[]): CollectionPriceOverrides {
  if (value === undefined) return {};
  const row = asRecord(value);
  if (!row) throw new Error('이번 조회에 적용할 가격 조건을 확인해 주세요.');
  const overrides: CollectionPriceOverrides = {};
  for (const [key, limits] of Object.entries(row)) {
    const source = upstreamSites.find(site => site === key && sources.includes(site));
    if (!source) throw new Error('이번 조회에서 가격 조건을 바꿀 수 있는 사이트를 선택해 주세요.');
    overrides[source] = parseLimits(limits);
  }
  return overrides;
}

function commonCollectionPriceSites(sources: readonly SourceId[]): SourceId[] {
  return sources.filter(source => upstreamSites.includes(source));
}

export function validateCommonPriceLimits(value: unknown, sources: readonly SourceId[]): CollectionPriceLimits | null {
  if (value === undefined) return null;
  const limits = parseLimits(value);
  if (limits && commonCollectionPriceSites(sources).length === 0) {
    throw new Error('이번 조회에는 공통 가격 조건을 적용할 매물 사이트가 없습니다.');
  }
  return limits;
}

export function collectionPriceLimitsState(
  read: (key: string) => string | null, sources: readonly SourceId[] = upstreamSites,
): CollectionPriceLimitsState {
  const limits: CollectionPriceLimitsState['limits'] = {};
  for (const source of upstreamSites) {
    if (!sources.includes(source)) continue;
    const saved = read(collectionPriceLimitsKey(source));
    if (saved === null) continue;
    try {
      const parsed = parseLimits(JSON.parse(saved));
      if (parsed) limits[source] = parsed;
    } catch {
      throw new Error('저장된 수집 가격 제한을 읽지 못했습니다.');
    }
  }
  return { limits, upstreamSites };
}

/** Apply temporary conditions, then any restriction imposed by the run's scope. */
export function runCollectionPriceLimits(
  read: (key: string) => string | null, sources: readonly SourceId[], scope?: RunScope,
  overrides?: CollectionPriceOverrides, common?: CollectionPriceLimits | null,
): CollectionPriceLimitsState {
  if (common) {
    const limits: CollectionPriceLimitsState['limits'] = {};
    for (const source of commonCollectionPriceSites(sources)) {
      limits[source] = { ...common, excludeSale: common.excludeSale || scope === 'rentOnly' };
    }
    return { limits, upstreamSites };
  }
  const state = collectionPriceLimitsState(read, sources);
  for (const source of upstreamSites) {
    if (!sources.includes(source)) continue;
    const override = overrides?.[source];
    if (override === null) delete state.limits[source];
    else if (override) state.limits[source] = { ...override };
    if (scope === 'rentOnly') {
      state.limits[source] = { ...(state.limits[source] ?? unrestricted), excludeSale: true };
    }
  }
  return state;
}

/** Compares the effective conditions shown before a run with the ones available when it starts. */
export function collectionPriceLimitsToken(limits: CollectionPriceLimitsState['limits']): string {
  const snapshot = Object.keys(limits).sort().flatMap(key => {
    const source = key as SourceId;
    const value = limits[source];
    if (!value) return [];
    const caps = amountKeys.map(field => field === 'saleMax' && value.excludeSale ? null : value[field]);
    return value.excludeSale || caps.some(amount => amount !== null) ? [[source, value.excludeSale, ...caps]] : [];
  });
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
