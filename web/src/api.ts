import type { AlertSettings, AppState, Area, AuctionResultSummary, AuctionResultView, AutoCheckState, CourtRegionStat, ExplainRow, HouseTradeSummary, ListingView, NoticeFileView, NoticeSourceId, NoticeSourceStatus, NoticeView, RunDetail, RunInfo, SourceId, Station, Verdict } from '../../shared/types';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `요청이 실패했습니다 (${res.status})`);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  state: () => request<AppState>('GET', '/api/state'),
  listings: () => request<ListingView[]>('GET', '/api/listings'),
  raw: (id: string) => request<{ explain: ExplainRow[]; raw: unknown }>('GET', `/api/listings/${enc(id)}/raw`),
  setVerdict: (id: string, verdict: Verdict | null) => request('POST', `/api/listings/${enc(id)}/verdict`, { verdict }),
  ack: (id: string) => request('POST', `/api/listings/${enc(id)}/ack`),
  /** 법원경매 물건 상세를 프로그램이 띄운 크롬 창에 연다 */
  openCourt: (id: string) => request('POST', `/api/listings/${enc(id)}/open-court`),
  /** 신규와 가격 변동 표시를 지운다(ids가 없으면 전부) */
  ackAll: (ids?: string[]) => request('POST', '/api/events/ack', ids ? { ids } : {}),
  /** sources를 주면 그 사이트만 조회한다(없으면 전부) */
  startRun: (visible: boolean, sources?: SourceId[]) => request<{ runId: number }>('POST', '/api/runs', sources ? { visible, sources } : { visible }),
  /** 자동 확인 시각(null이면 끄기)과 창 표시를 바꾼다. */
  setAutoCheck: (body: { time?: string | null; day?: number | null; visible?: boolean; noticeTime?: string | null }) => request<AutoCheckState>('PUT', '/api/auto-check', body),
  /** 조회가 끝나면 띄울 알림 설정을 바꾼다(준 값만). 바뀐 전체 설정을 돌려준다. */
  setAlerts: (body: Partial<AlertSettings>) => request<AlertSettings>('PUT', '/api/alerts', body),
  stopRun: () => request('POST', '/api/runs/stop'),  runs: () => request<RunInfo[]>('GET', '/api/runs'),
  run: (id: number) => request<RunDetail>('GET', `/api/runs/${id}`),
  createArea: (area: Omit<Area, 'id'>) => request<Area>('POST', '/api/areas', area),
  updateArea: (id: number, patch: Partial<Omit<Area, 'id'>>) => request<Area>('PUT', `/api/areas/${id}`, patch),
  deleteArea: (id: number) => request('DELETE', `/api/areas/${id}`),
  /** 고를 수 있는 역 전체(수도권 전철역, 좌표, 노선, 시도, 구 포함). */
  stationCatalog: () =>
    request<{ source: string; baseDate: string; stations: (Station & { lines: string[]; sido: string; gu: string | null })[] }>('GET', '/api/stations/catalog'),
  /** 공고(가격 없는 공매와 임대 공고)와 곳별 마지막 수집 결과 */
  notices: () => request<{ notices: NoticeView[]; sources: Partial<Record<NoticeSourceId, NoticeSourceStatus>> }>('GET', '/api/notices'),
  /** 새 공고 표시를 지운다(ids가 없으면 전부) */
  ackNotices: (ids?: number[]) => request('POST', '/api/notices/ack', ids ? { ids } : {}),
  /** 직접 받은 공고 첨부 파일을 읽은 결과(받은 시각 최근 순) */
  noticeFiles: () => request<{ files: NoticeFileView[] }>('GET', '/api/notice-files'),
  /** 법원경매 매각 결과(매각기일 최근 순)와 구별 지역별 매각통계 */
  auctionResults: () => request<{ results: AuctionResultView[]; stats: CourtRegionStat[]; compare: AuctionResultSummary[] }>('GET', '/api/auction-results'),
  /** 국토부 실거래가 단독주택 매매 중 지은 지 age년 넘은 것의 요약(서울, 최근 1년) */
  houseTrades: (age: number) => request<HouseTradeSummary>('GET', `/api/house-trades?age=${age}`),
  /** 국토부 실거래를 지금 받고 요약을 돌려준다 */
  fetchHouseTrades: (age: number) => request<HouseTradeSummary>('POST', '/api/house-trades/fetch', { age }),
};
