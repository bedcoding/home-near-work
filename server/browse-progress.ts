// 순차 조회의 익명 진단 정보만 보관한다. 지역 이름, 주소, 좌표, 원응답은 받지 않는다.
const SITES = ['naver', 'dabang', 'zigbang', 'kbland', 'hogangnono', 'daangn'] as const;
const STATUSES = ['running', 'paused', 'done'] as const;
const PHASES = ['preparing', 'opening', 'loading', 'exploring', 'waiting', 'saving', 'paused', 'done', 'error'] as const;
const EVENT_CODES = ['start', 'hints', 'ready', 'open', 'connected', 'action', 'received', 'saved', 'waiting', 'pause', 'resume', 'retry', 'job-end', 'done', 'error', 'recovered'] as const;

type Site = typeof SITES[number];
export interface BrowseProgressTotals {
  responses: number;
  listings: number;
  newCount: number;
  changedCount: number;
}
export interface BrowseProgressEvent {
  at: number;
  code: typeof EVENT_CODES[number];
  jobIndex?: number;
  site?: Site;
  responses?: number;
  listings?: number;
  actions?: number;
}
export interface BrowseProgress {
  id: string;
  status: typeof STATUSES[number];
  phase: typeof PHASES[number];
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  receivedAt: number;
  index: number;
  totalJobs: number;
  totals: BrowseProgressTotals;
  current?: { site: Site; actions: number; received: number };
  logs: BrowseProgressEvent[];
}

function invalid(): never {
  // 실제 입력값이나 예외 내용을 응답, 로그에 다시 노출하지 않는다.
  throw Object.assign(new Error('순차 조회 진행 정보가 올바르지 않습니다.'), { statusCode: 400 });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid();
  return value as T;
}
function event(value: unknown): BrowseProgressEvent {
  const raw = object(value);
  const result: BrowseProgressEvent = { at: count(raw.at), code: choice(raw.code, EVENT_CODES) };
  if (raw.site !== undefined) result.site = choice(raw.site, SITES);
  for (const key of ['jobIndex', 'responses', 'listings', 'actions'] as const) {
    if (raw[key] !== undefined) result[key] = count(raw[key]);
  }
  return result;
}

/** 허용한 항목만 새 객체로 만들고 최근 이벤트를 100개까지 남긴다. */
export function normalizeBrowseProgress(input: unknown, receivedAt = Date.now()): BrowseProgress {
  const raw = object(input);
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(raw.id)) return invalid();
  const totals = object(raw.totals);
  if (!Array.isArray(raw.logs)) return invalid();
  const result: BrowseProgress = {
    id: raw.id,
    status: choice(raw.status, STATUSES),
    phase: choice(raw.phase, PHASES),
    createdAt: count(raw.createdAt),
    updatedAt: count(raw.updatedAt),
    heartbeatAt: count(raw.heartbeatAt),
    receivedAt: count(receivedAt),
    index: count(raw.index),
    totalJobs: count(raw.totalJobs),
    totals: {
      responses: count(totals.responses),
      listings: count(totals.listings),
      newCount: count(totals.newCount),
      changedCount: count(totals.changedCount),
    },
    logs: raw.logs.map(event).slice(-100),
  };
  if (result.index > result.totalJobs) return invalid();
  if (raw.current !== undefined) {
    const current = object(raw.current);
    result.current = { site: choice(current.site, SITES), actions: count(current.actions), received: count(current.received) };
  }
  return result;
}
