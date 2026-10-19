import type { AlertSettings, AppState, Area, AuctionResultSummary, AuctionResultView, AutoCheckState, CourtRegionStat, ExplainRow, HouseTradeSummary, ListingView, MarketView, NoticeFileView, NoticeSourceId, NoticeSourceStatus, NoticeView, RedevZonesView, RunDetail, RunInfo, RunScope, SourceId, Station, Verdict } from '../../shared/types';

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
  /** scope를 주면 그 탭에 보이는 사이트와 공고만 조회한다(없으면 전부) */
  startRun: (visible: boolean, scope?: RunScope) => request<{ runId: number }>('POST', '/api/runs', scope ? { visible, scope } : { visible }),
  /** 자동 확인 시각(null이면 끄기)과 창 표시를 바꾼다. */
  setAutoCheck: (body: { time?: string | null; day?: number | null; visible?: boolean; noticeTime?: string | null }) => request<AutoCheckState>('PUT', '/api/auto-check', body),
  /** 조회가 끝나면 띄울 알림 설정을 바꾼다(준 값만). 바뀐 전체 설정을 돌려준다. */
  setAlerts: (body: Partial<AlertSettings>) => request<AlertSettings>('PUT', '/api/alerts', body),
  stopRun: () => request('POST', '/api/runs/stop'),  runs: () => request<RunInfo[]>('GET', '/api/runs'),
  run: (id: number) => request<RunDetail>('GET', `/api/runs/${id}`),
  createArea: (area: Omit<Area, 'id'>) => request<Area>('POST', '/api/areas', area),
  updateArea: (id: number, patch: Partial<Omit<Area, 'id'>>) => request<Area>('PUT', `/api/areas/${id}`, patch),
  deleteArea: (id: number) => request('DELETE', `/api/areas/${id}`),
  /** 노선 역을 켜고 끈다(mode: only 그 노선만, add 더하기, off 끄기). 없는 역은 radiusM으로 만든다. */
  areaLine: (line: string, mode: 'only' | 'add' | 'off', radiusM: number) =>
    request<{ areas: Area[]; text: string }>('POST', '/api/areas/line', { line, mode, radiusM }),
  /** 노선으로 바꾸기 전에 켜 둔 지역으로 되돌린다. */
  restoreAreas: () => request<{ areas: Area[]; text: string }>('POST', '/api/areas/restore'),
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
  /** 시세 통계 탭 자료(KB 지수, 서울 아파트 거래량, 구별 급지표) */
  market: () => request<MarketView>('GET', '/api/market'),
  /** 시세 통계 자료를 지금 받고 탭 자료를 돌려준다(처음에는 몇 분 걸릴 수 있다) */
  fetchMarket: () => request<MarketView>('POST', '/api/market/fetch'),
  /** 지도에 칠하는 정비사업 구역(넣어 둔 서울플랜+ 파일) */
  redevZones: () => request<RedevZonesView>('GET', '/api/redev-zones'),
  /** 열린데이터광장 최신판을 보고 새것이면 받아 바꾼다(message는 결과 글) */
  updateRedevZones: () => request<RedevZonesView & { message: string }>('POST', '/api/redev-zones/update'),
  /** 서울플랜+ ZIP을 넣는다(본문 그대로) */
  uploadRedevZones: async (file: File) => {
    const res = await fetch(`/api/redev-zones?name=${enc(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `파일을 넣지 못했습니다 (${res.status})`);
    return data as RedevZonesView;
  },
  /** 서울 아파트 탭에서 고른 구를 통째로 바꾼다. 바뀐 목록을 돌려준다. */
  setAptGus: (gus: string[]) => request<{ aptGus: string[] }>('PUT', '/api/apt-gus', { gus }),
  /** 경매·공매 아파트 단지 세대수를 건축물대장에서 지금 채운다. 결과 한 줄을 돌려준다. */
  fillHouseholds: () => request<{ text: string }>('POST', '/api/apt-households/fill'),
  /** 집터 경매·공매의 재개발 구역을 토지이용계획으로 지금 확인한다. 결과 한 줄을 돌려준다. */
  checkZones: () => request<{ text: string }>('POST', '/api/plot-zones/check'),
  /** 단지 세대수를 넣거나 고친다(null이면 지움) */
  setHouseholds: (key: string, name: string, households: number | null) => request('PUT', '/api/apt-complexes', { key, name, households }),
};
