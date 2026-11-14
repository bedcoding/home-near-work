import type { BadgeTone, BrowserSession } from '../browser.js';
import type { Area, CollectionCoverage, CollectionPriceLimits, NormalizedListing, SourceId } from '../../shared/types.js';

export interface CollectContext {
  runId: number;
  areas: Area[];
  session: BrowserSession;
  priceLimits?: CollectionPriceLimits;
  rentalOnly?: boolean;
  /** 저장 가능한 매물 묶음을 조회 중에도 보낸다. */
  publishListings?(items: CollectedItem[]): void;
  /** 조회 기록에 한 줄 남긴다. */
  log(message: string): void;
  /** 지금 하는 일을 사이트 위 진행 띠와 대시보드에 보여 준다. */
  progress(message: string): void;
  /** 사이트 화면에 붙일 배지 종류(신규, 기존, 버림, 관심)를 정한다. */
  classify(listings: NormalizedListing[]): Map<string, BadgeTone>;
  /** 서울 아파트 탭에서 고른 구(회사와 멀어도 이 구의 아파트를 모은다) */
  aptGus: string[];
  /**
   * 일부(고른 구 하나 등)를 보지 못했지만 나머지는 계속 모을 때 부른다. 이번 결과는 다 돈 것으로 보지 않아
   * 안 보인 매물을 '사라짐'으로 두지 않는다(못 본 구의 물건이 사라진 것처럼 보이지 않게).
   */
  partial(reason: string, retryable?: boolean): void;
  stopped?(): boolean;
  /** Per-scope progress; IDs are private storage readback evidence and are not sent to the UI. */
  coverage?(row: CollectionCoverage, sourceIds: string[]): void;
}

export interface CollectedItem {
  listing: NormalizedListing;
  /** 사이트가 준 원래 데이터(원본 데이터 보기용) */
  raw: unknown;
  pageUrl: string | null;
  screenshot: string | null;
  /** 서울 아파트 탭에서 고른 구의 아파트면 그 구. 켜진 지역 반경 밖이어도 저장한다. */
  aptGu?: string;
}

export interface Collector {
  id: SourceId;
  label: string;
  /** 켜진 지역이 든 구 전체(또는 사이트 전체)를 매번 다시 본다. 다 돌았는데 안 보인 매물은 반경 밖(모은 범위)이라도 사라짐으로 둔다. */
  wholeDistrict?: boolean;
  /** 0건이어도 실패로 보지 않는다(빈 방이 없으면 목록이 비는 곳). */
  emptyOk?: boolean;
  /** Keep unreturned rows until the normal stale timeout when the source's count is not a reliable deletion signal. */
  retainMissing?: boolean;
  /** 화면을 열지 않고 서버가 사이트 자료를 바로 받는다. 조회 창에 이 사이트용 탭을 따로 열지 않고 기본 탭을 같이 쓴다(열면 끝날 때까지 빈 탭으로 남는다). */
  noTab?: boolean;
  collect(ctx: CollectContext): Promise<CollectedItem[]>;
}

/** 사이트가 요청을 막았을 때 던진다. 그 소스만 멈춘다. */
export class BlockedError extends Error {}

export const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
