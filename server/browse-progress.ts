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
  current?: { site: Site; actions: number; received: number; pages?: number; listings?: number; total?: number; lastListAt?: number };
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
    for (const key of ['pages', 'listings', 'total', 'lastListAt'] as const) {
      if (current[key] !== undefined) result.current[key] = count(current[key]);
    }
  }
  return result;
}

const SITE_NAMES: Record<Site, string> = { naver: '네이버', dabang: '다방', zigbang: '직방', kbland: 'KB부동산', hogangnono: '호갱노노', daangn: '당근' };

function consoleText(progress: BrowseProgress, e: BrowseProgressEvent, latestSave: boolean): string | null {
  const job = e.jobIndex === undefined ? '' : `${e.jobIndex + 1}/${progress.totalJobs}${e.site ? ` ${SITE_NAMES[e.site]}` : ''}: `;
  const counts = `응답 ${e.responses ?? 0}건, 매물 저장 처리 ${e.listings ?? 0}건`;
  const page = progress.current;
  switch (e.code) {
    case 'ready': return `${progress.totalJobs}개 조회를 시작합니다`;
    case 'open': return `${job}페이지를 엽니다`;
    case 'saved': return `${job}서버 저장 확인, ${counts}${latestSave && page?.pages !== undefined ? `, ${page.pages}페이지, 목록 ${page.listings ?? 0}/${page.total ?? '?'}건` : ''}`;
    case 'job-end': return `${job}조회 종료, ${counts}`;
    case 'pause': return `${job}조회를 멈췄습니다. 대시보드에서 이어할 수 있습니다`;
    case 'resume': return `${job}중단한 조회를 이어갑니다`;
    case 'error': return `${job}문제가 생겨 멈췄습니다. 대시보드의 항목별 결과를 확인해 주세요`;
    case 'retry': return '미확인 항목을 처음부터 다시 조회합니다';
    case 'recovered': return '확장이 다시 시작되어 저장된 작업을 이어받았습니다';
    case 'done': return `조회 끝, ${progress.totalJobs}개 조회, 신규 ${progress.totals.newCount}건, 가격 변경 ${progress.totals.changedCount}건`;
    default: return null;
  }
}

/**
 * 확장 순차 조회의 진행을 서버 콘솔 줄로 바꾼다. 같은 이벤트는 한 번만 쓰고, 서버가 켜지기 전 이벤트는 건너뛴다.
 * 진단에는 지역 이름이 없으므로 대시보드 '이번 조회' 목록의 순서와 사이트로 적는다. 탐색과 수신 이벤트는 너무 잦아 쓰지 않는다.
 */
export function browseConsole(since = Date.now()) {
  let printed = new Set<string>();
  return (progress: BrowseProgress): string[] => {
    const latestSave = [...progress.logs].reverse().find((e) => e.code === 'saved' && e.jobIndex === progress.index);
    const keys = new Set<string>();
    const lines: string[] = [];
    for (const e of progress.logs) {
      const key = [e.at, e.code, e.jobIndex, e.site, e.responses, e.listings, e.actions].join(':');
      keys.add(key);
      if (e.at < since || printed.has(key)) continue;
      const text = consoleText(progress, e, e === latestSave);
      if (!text) continue;
      printed.add(key);
      lines.push(`[확장 조회] ${text}`);
    }
    // 진단은 최근 이벤트만 담는다. 창 밖으로 밀려난 이벤트는 다시 오지 않으므로 기억에서 뺀다.
    printed = new Set([...printed].filter((key) => keys.has(key)));
    return lines;
  };
}
