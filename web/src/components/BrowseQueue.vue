<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Area } from '../../../shared/types';
import { radiusText } from '../format';
import BrowseAuto from './BrowseAuto.vue';
import HelpTip from './HelpTip.vue';
import NaverManual from './NaverManual.vue';

const props = defineProps<{
  areas: Area[];
  extension: { version: string; sites: string[]; browse?: boolean; browseError?: string } | null;
  naverReceivedAt?: string | null;
}>();
const emit = defineEmits<{ close: []; manageAreas: [] }>();

interface DabangRegionScope { kind: 'dabang-region'; name: string; dong: string; url: string }
interface Coverage { pages: number; totalPages: number | null; total: number | null; regularUnique: number; complete: boolean; reason: string }
interface ZigbangCoverage {
  stationId: string; radiusKm: number; total: number | null; received: number; stored: number;
  excluded: number; missing: number; unreadable: number; complete: boolean; reason: string;
}
interface NaverCoverage { pages: number; total: number | null; received: number; stored: number | null; complete: boolean }
interface Receipt {
  responses: number; listings: number; newCount: number; changedCount: number;
  uniqueListings?: number; excludedOutside?: number; excludedUnknown?: number; retainedOutside?: number; retainedUnknown?: number; coverage?: Coverage;
  zigbangCoverage?: ZigbangCoverage; naverCoverage?: NaverCoverage;
}
/** 서버가 받은 응답과 저장 처리 수(페이지 확인 줄에 마우스를 올리면 보인다) */
const receiptText = (r: Receipt) =>
  `서버 응답 ${r.responses}건, 저장 처리 ${r.listings}건${r.uniqueListings !== undefined ? `, 중복 없는 매물 ${r.uniqueListings}건` : ''}`;

// 화면에 늘어놓던 설명은 제목 옆 (?)에 모았다.
const PANEL_HELP = '크롬 확장이 새 전용 창에서 고른 지역과 사이트를 차례로 확인합니다. PC와 대시보드 서버를 켜 두세요. '
  + '진행 상황은 아래 진행 표시와 수집 창에서 보고, 확장 아이콘 메뉴에서도 같은 조회를 시작하고 볼 수 있습니다.';
const NAVER_HELP = '네이버 지도에서 가격과 거래 조건 필터를 적용한 매물 탭을 고르세요. 시작할 때 그 탭 주소에서 필터를 다시 읽어 같을 때만 '
  + '전용 창에 복사하고, 고른 구나 동의 목록을 마지막 페이지까지 확인합니다. 수집 창의 조건이 달라지면 멈춥니다. '
  + '이어하기와 다시 조회는 시작할 때의 조건을 그대로 씁니다. 필터를 바꾸려면 새로 시작하세요. 역 지역은 네이버로 조회하지 않습니다.';
type JobStatus = 'pending' | 'running' | 'complete' | 'partial' | 'failed' | 'visited' | 'needs-input';
interface BrowseJob {
  id: string;
  areaName: string;
  site: string;
  siteName: string;
  url: string;
  status: JobStatus;
  note: string;
  receipt?: Receipt;
  scope?: DabangRegionScope;
  startedAt?: number;
  actions?: number;
  received?: number;
  lastCaptureAt?: number;
}
type Phase = 'preparing' | 'opening' | 'loading' | 'exploring' | 'waiting' | 'saving' | 'paused' | 'done' | 'error';
const PHASES: Record<Phase, string> = {
  preparing: '지역 바로가기를 준비하고 있습니다', opening: '전용 탭에서 페이지를 여는 중입니다',
  loading: '페이지와 매물 목록이 뜨기를 기다립니다', exploring: '매물 목록을 확인하고 있습니다',
  waiting: '추가 응답이 도착하기를 기다립니다', saving: '받은 데이터를 서버에 저장하고 있습니다',
  paused: '순회를 멈췄습니다', done: '순회가 끝났습니다', error: '확인이 필요한 문제가 있습니다',
};
const LOG_LABELS = {
  start: '순회 준비 시작', hints: '지역 바로가기 정보 확인', ready: '조회할 순서 준비 완료',
  open: '전용 탭에서 페이지 열기', connected: '페이지 연결 확인', action: '목록 탐색',
  received: '브라우저 데이터 수신', saved: '서버 저장 확인', waiting: '추가 응답 대기',
  pause: '순회 중단', resume: '순회 이어하기', retry: '미확인 항목 재시도',
  'job-end': '이 항목의 조회 종료', done: '전체 순회 종료', error: '문제 발생, 항목의 확인할 내용 참고',
  recovered: '저장된 작업 상태 복구',
};
type LogCode = keyof typeof LOG_LABELS;
interface ActivityEvent { at: number; code: LogCode; jobIndex?: number; site?: string; responses?: number; listings?: number; actions?: number }
interface BrowseState {
  id: string;
  status: 'running' | 'paused' | 'done';
  jobs: BrowseJob[];
  index: number;
  updatedAt: number;
  createdAt?: number;
  phaseAt?: number;
  heartbeatAt?: number;
  phase?: Phase;
  detail?: string;
  logs?: ActivityEvent[];
}
type Command = 'start' | 'pause' | 'resume' | 'retry';

const SITES = [
  // 네이버는 열어 둔 네이버 탭의 필터가 있어야 해서 처음에는 고르지 않는다.
  { id: 'naver', name: '네이버', mode: '구나 동 전체', defaultOn: false },
  { id: 'dabang', name: '다방', mode: '기존 동별 원·투룸', defaultOn: true },
  { id: 'zigbang', name: '직방', mode: '매물 목록', defaultOn: true },
  { id: 'kbland', name: 'KB부동산', mode: '건수 확인', defaultOn: false },
  { id: 'hogangnono', name: '호갱노노', mode: '화면 확인', defaultOn: false },
  // 당근부동산은 '조회하기'가 서버에서 모으므로 여기서 고르지 않는다.
];
const STATUS: Record<JobStatus, string> = {
  pending: '대기', running: '조회 중', complete: '선택 목록 저장 완료', partial: '일부 확인', failed: '실패', visited: '화면 확인', 'needs-input': '직접 확인 필요',
};
const HOSTS = new Set(['fin.land.naver.com', 'new.land.naver.com', 'www.dabangapp.com', 'www.zigbang.com', 'kbland.kr', 'hogangnono.com']);
const safeLink = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOSTS.has(u.hostname) ? u.href : null;
  } catch { return null; }
};
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function readRegion(value: unknown): DabangRegionScope | null {
  if (!value || typeof value !== 'object') return null;
  const x = value as DabangRegionScope;
  if (x.kind !== 'dabang-region' || typeof x.name !== 'string' || !x.name.trim() || x.name.length > 120
    || typeof x.dong !== 'string' || !x.dong.trim() || x.dong.length > 60 || typeof x.url !== 'string') return null;
  try {
    const url = new URL(x.url);
    if (url.protocol !== 'https:' || !['www.dabangapp.com', 'dabangapp.com'].includes(url.hostname) || url.username || url.password || url.port
      || url.pathname !== '/map/onetwo' || url.searchParams.get('search_type') !== 'region' || !/^\d{1,20}$/.test(url.searchParams.get('search_id') || '')) return null;
  } catch { return null; }
  return { kind: x.kind, name: x.name.trim(), dong: x.dong.trim(), url: x.url };
}
function validCoverage(value: Coverage) {
  return value && isCount(value.pages) && isCount(value.regularUnique) && (value.totalPages === null || isCount(value.totalPages))
    && (value.total === null || isCount(value.total)) && typeof value.complete === 'boolean' && typeof value.reason === 'string' && value.reason.length <= 300;
}
function validZigbangCoverage(value: ZigbangCoverage) {
  return value && typeof value.stationId === 'string' && /^\d{1,20}$/.test(value.stationId) && value.radiusKm === 1
    && (value.total === null || isCount(value.total))
    && ['received', 'stored', 'excluded', 'missing', 'unreadable'].every((key) => isCount(value[key as keyof ZigbangCoverage]))
    && typeof value.complete === 'boolean' && typeof value.reason === 'string' && value.reason.length <= 300
    && (!value.complete || value.total !== null && value.received === value.total && value.stored + value.excluded === value.total && value.missing === 0 && value.unreadable === 0);
}
function validReceipt(receipt: Receipt) {
  return receipt && ['responses', 'listings', 'newCount', 'changedCount'].every((key) => isCount(receipt[key as keyof Receipt]))
    && ['uniqueListings', 'excludedOutside', 'excludedUnknown', 'retainedOutside', 'retainedUnknown'].every((key) => receipt[key as keyof Receipt] === undefined || isCount(receipt[key as keyof Receipt]))
    && (receipt.coverage === undefined || validCoverage(receipt.coverage))
    && (receipt.zigbangCoverage === undefined || validZigbangCoverage(receipt.zigbangCoverage));
}
function zigbangStationId(job: BrowseJob) {
  if (job.site !== 'zigbang') return null;
  try {
    const url = new URL(job.url);
    return url.protocol === 'https:' && url.hostname === 'www.zigbang.com' && !url.username && !url.password && !url.port
      ? /^\/home\/oneroom\/subways\/(\d{1,20})\/items\/?$/.exec(url.pathname)?.[1] ?? null : null;
  } catch { return null; }
}
function zigbangCoverageFor(job: BrowseJob) {
  const coverage = job.receipt?.zigbangCoverage;
  return coverage && coverage.stationId === zigbangStationId(job) ? coverage : null;
}
function statusLabel(job: BrowseJob) {
  if (job.status === 'complete' && job.site === 'zigbang') {
    return zigbangCoverageFor(job)?.complete ? '역 1km 목록 확인 완료' : '이전 조회 결과 · 범위 확인 필요';
  }
  return STATUS[job.status];
}
function naverCoverageFor(job: BrowseJob) {
  const c = job.site === 'naver' ? job.receipt?.naverCoverage : undefined;
  return c && isCount(c.pages) && isCount(c.received) && (c.total === null || isCount(c.total))
    && (c.stored === null || c.stored === undefined || isCount(c.stored)) && typeof c.complete === 'boolean' ? c : null;
}
function naverCoverageText(coverage: NaverCoverage) {
  return `${coverage.pages}페이지, 목록 수신 ${coverage.received}/${coverage.total ?? '?'}건, 저장 ${coverage.stored ?? '?'}건`;
}
function zigbangCoverageText(coverage: ZigbangCoverage) {
  return `상세 수신 ${coverage.received}/${coverage.total ?? '?'}건 · 저장 ${coverage.stored}건 · 범위 밖 제외 ${coverage.excluded}건`;
}
function zigbangMissingText(coverage: ZigbangCoverage) {
  return `상세 미수신 ${coverage.missing}건 · 읽기 실패 ${coverage.unreadable}건`;
}
function zigbangCoverageReason(coverage: ZigbangCoverage) {
  if (coverage.complete) return '';
  const reasons: Record<string, string> = {
    'missing-list': '역 1km의 매물 번호 목록을 아직 받지 못했습니다',
    'missing-details': '아직 상세를 받지 못한 매물이 있습니다',
    'unreadable-details': '상세를 읽지 못한 매물이 있습니다',
    'unverified-storage': '받은 상세의 서버 저장 확인이 남아 있습니다',
    'station-changed': '조회 중 역이 바뀌었습니다',
    'radius-mismatch': '역 1km 범위와 다른 응답이 왔습니다',
    'query-changed': '조회 중 검색 조건이 바뀌었습니다',
    'unreadable-list': '매물 번호 목록을 읽지 못했습니다',
    'duplicate-list-id': '매물 번호 목록에 중복이 있어 전체 범위를 확인할 수 없습니다',
    'list-changed': '조회 중 매물 번호 목록이 바뀌었습니다',
    'response-status': '정상적으로 받지 못한 응답이 있습니다',
    'response-scope': '선택한 역 1km의 응답인지 확인이 필요합니다',
    'coverage-limit': '확인 한도에 도달해 일부만 확인했습니다',
  };
  return reasons[coverage.reason] || '역 1km 목록의 상세 수신과 서버 저장을 확인하는 중입니다';
}
function coverageText(coverage: Coverage) {
  return `페이지 ${coverage.pages}/${coverage.totalPages ?? '?'} · 중복 없는 일반 매물 ${coverage.regularUnique}/${coverage.total ?? '?'}건`;
}
function coverageReason(coverage: Coverage) {
  if (coverage.complete) return '';
  const reasons: Record<string, string> = {
    'missing-metadata': '페이지 정보 확인 필요', 'missing-pages': '아직 저장되지 않은 페이지가 있습니다',
    'count-mismatch': '목록 전체 건수와 받은 매물 수가 다릅니다', 'unverified-dong': '동을 확인하지 못한 매물이 있습니다',
    'unverified-region': '동별 검색 범위 확인 필요', 'query-changed': '조회 중 검색 조건이 바뀌었습니다',
    'total-changed': '조회 중 전체 매물 수가 바뀌었습니다', 'page-changed': '조회 중 같은 페이지의 매물이 바뀌었습니다',
    'inconsistent-pages': '페이지 정보가 서로 맞지 않습니다', 'unreadable-row': '읽지 못한 매물이 있습니다',
    'unreadable-response': '읽지 못한 응답이 있습니다', 'response-scope': '선택한 동의 응답인지 확인 필요',
    'coverage-limit': '확인 한도에 도달해 일부만 확인했습니다',
  };
  return reasons[coverage.reason] || '전체 페이지와 저장 결과를 확인하는 중입니다';
}
/** 확장 메시지의 상태만 받아 화면에 쓴다. 원응답이나 지역 좌표는 결과에 표시하지 않는다. */
function readState(value: unknown): BrowseState | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const x = value as BrowseState;
  if (typeof x.id !== 'string' || !['running', 'paused', 'done'].includes(x.status) || !Array.isArray(x.jobs) || x.jobs.length > 3000 || !isCount(x.index) || !isCount(x.updatedAt)) return undefined;
  if (['createdAt', 'phaseAt', 'heartbeatAt'].some((k) => x[k as 'createdAt'] !== undefined && !isCount(x[k as 'createdAt']))) return undefined;
  if (x.phase !== undefined && !Object.hasOwn(PHASES, x.phase) || x.detail !== undefined && (typeof x.detail !== 'string' || x.detail.length > 1000)) return undefined;
  if (x.logs !== undefined && (!Array.isArray(x.logs) || x.logs.length > 100 || !x.logs.every((e) => e && isCount(e.at) && Object.hasOwn(LOG_LABELS, e.code)
    && (e.site === undefined || SITES.some((s) => s.id === e.site))
    && ['jobIndex', 'responses', 'listings', 'actions'].every((k) => e[k as 'jobIndex'] === undefined || isCount(e[k as 'jobIndex']))))) return undefined;
  if (!x.jobs.every((j) => j && typeof j.id === 'string' && typeof j.areaName === 'string' && typeof j.site === 'string' && typeof j.siteName === 'string'
    && typeof j.url === 'string' && Object.hasOwn(STATUS, j.status) && typeof j.note === 'string'
    && ['startedAt', 'actions', 'received', 'lastCaptureAt'].every((k) => j[k as 'startedAt'] === undefined || isCount(j[k as 'startedAt']))
    && (j.scope === undefined || readRegion(j.scope))
    && (j.receipt === undefined || validReceipt(j.receipt)))) return undefined;
  return x;
}

const ready = computed(() => props.extension?.browse === true);
/** 연결된 확장이 0.minor.patch 이상인지 */
function extensionAtLeast(minor: number, patch: number) {
  const parts = (props.extension?.version ?? '').split('.').map(Number);
  return parts.length === 3 && parts.every(Number.isSafeInteger) &&
    (parts[0] > 0 || parts[1] > minor || parts[1] === minor && parts[2] >= patch);
}
// 0.8.22부터 대시보드도 열린 네이버 탭의 필터를 읽어 네이버를 다른 사이트와 함께 시작한다.
const naverVersionReady = computed(() => extensionAtLeast(8, 22));
// 수집 지역에 구가 있으면 다방은 위의 구 전체 자동수집이 모은다. 순차 조회에서 또 돌면 같은 매물을 중복 조회하므로 뺀다.
const dabangByServer = computed(() => props.areas.some((a) => a.enabled && a.purpose !== 'alert' && a.region?.kind === 'gu'));
// 켜진 구, 동이나 지하철역이 있으면 직방은 '조회하기'와 자동 확인이 지역 안 역들의 1km 원룸을 서버에서 모은다. 순차 조회에서 또 돌면 중복이라 뺀다.
const zigbangByServer = computed(() => props.areas.some((a) => a.enabled));
const sites = computed(() => SITES.filter((s) => (s.id !== 'naver' || naverVersionReady.value) && (s.id !== 'dabang' || !dabangByServer.value)
  && (s.id !== 'zigbang' || !zigbangByServer.value) && props.extension?.sites.includes(s.id)));
const naverEnabled = computed(() => !!props.extension?.sites.includes('naver'));
const naverAvailable = computed(() => sites.value.some((s) => s.id === 'naver'));
const selectedAreas = ref<number[]>([]);
const selectedSites = ref<string[]>([]);
const areaScopes = ref<Record<string, DabangRegionScope[]>>({});
const scopesReady = ref(false);
const scopesLoading = ref(false);
const scopeError = ref<string | null>(null);
let scopeController: AbortController | undefined;
let scopeTimeout: number | undefined;
async function loadScopes() {
  if (scopesLoading.value) return;
  scopesReady.value = false;
  scopesLoading.value = true;
  scopeError.value = null;
  const controller = new AbortController();
  scopeController = controller;
  scopeTimeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/browse/scopes', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('scopes unavailable');
    const data = await response.json();
    if (!data?.scopes || typeof data.scopes !== 'object' || Array.isArray(data.scopes)) throw new Error('invalid scopes');
    const next: Record<string, DabangRegionScope[]> = {};
    for (const [id, regions] of Object.entries(data.scopes)) {
      if (!/^\d+$/.test(id) || !Array.isArray(regions) || !regions.length || regions.length > 50) throw new Error('invalid scopes');
      next[id] = regions.map((region) => {
        const parsed = readRegion(region);
        if (!parsed) throw new Error('invalid scope');
        return parsed;
      });
    }
    areaScopes.value = next;
    scopesReady.value = true;
  } catch {
    scopeError.value = '저장된 동별 조회 범위를 불러오지 못했습니다. 범위가 바뀌지 않도록 시작을 멈췄습니다. 서버 연결을 확인하고 다시 불러와 주세요.';
  } finally {
    window.clearTimeout(scopeTimeout);
    scopesLoading.value = false;
    scopeController = undefined;
  }
}
let initializedAreas = false;
let initializedSites = false;
watch(() => props.areas.map((a) => a.id), (ids) => {
  if (!initializedAreas && ids.length) { selectedAreas.value = [...ids]; initializedAreas = true; }
  else selectedAreas.value = selectedAreas.value.filter((id) => ids.includes(id));
}, { immediate: true });
watch(sites, (available) => {
  if (!initializedSites && available.length) {
    selectedSites.value = available.filter((s) => s.defaultOn).map((s) => s.id);
    initializedSites = true;
  } else selectedSites.value = selectedSites.value.filter((id) => available.some((s) => s.id === id));
}, { immediate: true });

const state = ref<BrowseState | null>(null);
const error = ref<string | null>(null);
const pending = ref<Command | null>(null);
const pendingAt = ref(0);
const pendingRequestId = ref<string | null>(null);
const pendingBaseStateId = ref<string | null>(null);
const received = ref(false);
const lastResponse = ref(0);
const now = ref(Date.now());
const localEvents = ref<{ at: number; text: string }[]>([]);
let requestSequence = 0;
const requestPrefix = `browse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let stateRevision = 0;
let lastStateSequence = 0;
const requests = new Map<string, { sequence: number; revision: number }>();
function requestId() {
  const id = `${requestPrefix}-${++requestSequence}`;
  requests.set(id, { sequence: requestSequence, revision: stateRevision });
  if (requests.size > 64) requests.delete(requests.keys().next().value!);
  return id;
}
let errorKind: 'command' | 'connection' | null = null;
let firstRequestAt = 0;
const running = computed(() => state.value?.status === 'running');
const activeState = computed(() => pending.value === 'start' && state.value?.id === pendingBaseStateId.value ? null : state.value);
const incompleteJobs = computed(() => state.value?.jobs.filter((j) => ['partial', 'failed', 'needs-input'].includes(j.status)) ?? []);
const incomplete = computed(() => incompleteJobs.value.length);
const finished = computed(() => activeState.value?.jobs.filter((j) => !['pending', 'running'].includes(j.status)).length ?? 0);
const current = computed(() => activeState.value?.jobs.find((j) => j.status === 'running'));
const totals = computed(() => activeState.value?.jobs.reduce((sum, j) => ({
  responses: sum.responses + (j.receipt?.responses ?? 0),
  listings: sum.listings + (j.receipt?.listings ?? 0),
  newCount: sum.newCount + (j.receipt?.newCount ?? 0),
  changedCount: sum.changedCount + (j.receipt?.changedCount ?? 0),
}), { responses: 0, listings: 0, newCount: 0, changedCount: 0 }));
const chosenAreas = computed(() => props.areas.filter((a) => selectedAreas.value.includes(a.id)));
const chosenSites = computed(() => sites.value.filter((site) => selectedSites.value.includes(site.id)));
// 확장의 순회 계획과 같은 기준이다. 네이버는 구나 동 전체를, 다른 사이트는 역 지역을 맡는다.
const covers = (area: Area, site: string) => area.region ? site === 'naver' && area.purpose !== 'alert' : site !== 'naver';
/** 고른 사이트가 하나도 안 보는 지역이면 그 까닭(지역 칸을 흐리게 하고 작은 글씨로 보인다). 사이트를 안 골랐으면 흐리게 하지 않는다. */
const unusedReason = (area: Area): string | null => {
  if (!chosenSites.value.length || chosenSites.value.some((site) => covers(area, site.id))) return null;
  if (!area.region) return '네이버는 역을 안 봄';
  return area.purpose === 'alert' ? '알림용이라 안 봄' : '네이버만 봄';
};
const plannedJobs = computed(() => chosenAreas.value.flatMap((area) => chosenSites.value.filter((site) => covers(area, site.id)).flatMap((site) => {
  if (site.id === 'naver') return [{ key: `${area.id}:naver`, areaId: area.id, site: site.id, areaName: area.name, siteName: site.name,
    label: area.region?.kind === 'gu' ? '구 전체' : '동 전체', detail: '고른 네이버 탭의 필터로 전체 목록을 마지막 페이지까지 확인', scoped: false }];
  const regions = site.id === 'dabang' ? [...new Map((areaScopes.value[area.id] ?? [])
    .map((scope) => [new URL(scope.url).searchParams.get('search_id'), scope])).values()] : [];
  return regions.length
    ? regions.map((scope) => ({ key: `${area.id}:${site.id}:${scope.url}`, areaId: area.id, site: site.id, areaName: area.name, siteName: site.name, label: scope.dong, detail: scope.name, scoped: true }))
    : [{ key: `${area.id}:${site.id}`, areaId: area.id, site: site.id, areaName: area.name, siteName: site.name,
      label: site.id === 'zigbang' ? '역 1km 원룸' : '지도와 필터 범위',
      detail: site.id === 'zigbang' ? `알려진 역의 1km 원룸 목록. 지역 설정 반경 ${radiusText(area.radiusM)}와 별개이며 사이트의 현재 필터가 적용됩니다.` : `역 중심 반경 ${radiusText(area.radiusM)}의 지도를 열고 사이트의 현재 필터 범위를 조회`, scoped: false }];
})));
const naverJobs = computed(() => plannedJobs.value.filter((job) => job.site === 'naver'));
const startAreas = computed(() => chosenAreas.value.filter((area) => plannedJobs.value.some((job) => job.areaId === area.id)));
const skippedAreas = computed(() => chosenAreas.value.filter((area) => !plannedJobs.value.some((job) => job.areaId === area.id)));
const skipNote = computed(() => {
  if (!skippedAreas.value.length) return '';
  const notes = [`이번 조회에서 빠지는 지역: ${skippedAreas.value.map((a) => a.name).join(', ')}.`];
  if (skippedAreas.value.some((a) => a.region)) notes.push(naverAvailable.value
    ? '구나 동 전체는 네이버를 고르면 함께 조회합니다.'
    : '구나 동 전체는 네이버로 조회합니다. 확장에서 네이버를 켜 두고 확장이 0.8.22 이상이면 여기서 고를 수 있습니다.');
  if (skippedAreas.value.some((a) => !a.region)) notes.push('역 지역은 네이버가 아닌 사이트를 하나 이상 골라야 조회합니다.');
  return notes.join(' ');
});
const runExpanded = ref(false);
watch(() => [activeState.value?.id, activeState.value?.status, pending.value] as const, ([id, status, command], [previousId]) => {
  if (command || status === 'running' || status === 'paused') runExpanded.value = true;
  else if (id !== previousId) runExpanded.value = false;
});
const runScopeLabel = computed(() => [...new Set(activeState.value?.jobs.map((job) => `${job.areaName}(${job.siteName})`) ?? [])].join(', '));
const runDate = computed(() => activeState.value ? new Date(activeState.value.createdAt || activeState.value.updatedAt).toLocaleString('ko-KR', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}) : '');
const scopeVersionReady = computed(() => !selectedSites.value.includes('dabang') || !chosenAreas.value.some((a) => areaScopes.value[a.id]?.length) || extensionAtLeast(8, 4));
const zigbangVersionReady = computed(() => !selectedSites.value.includes('zigbang') || extensionAtLeast(8, 9));
const connectionStale = computed(() => !received.value || !!lastResponse.value && now.value - lastResponse.value > 12000);
const canStart = computed(() => ready.value && scopesReady.value && scopeVersionReady.value && zigbangVersionReady.value && naverSourceReady.value && !connectionStale.value && !pending.value && !running.value && plannedJobs.value.length > 0);
const stateLabel = computed(() => state.value?.status === 'running' ? '지역을 차례로 확인하고 있습니다' : state.value?.status === 'paused' ? '순회를 멈췄습니다' : state.value?.status === 'done' ? '순회가 끝났습니다' : '대기 중');
const workerStale = computed(() => activeState.value?.status === 'running' && !!activeState.value.heartbeatAt && now.value - activeState.value.heartbeatAt > 20000);
const seconds = (since: number, until = now.value) => Math.max(0, Math.floor((until - since) / 1000));
const duration = (s: number) => s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
const elapsed = computed(() => {
  const s = activeState.value;
  const start = s?.createdAt || s?.jobs.find((j) => j.startedAt)?.startedAt || pendingAt.value;
  return start ? duration(seconds(start, s?.status === 'done' ? s.updatedAt : now.value)) : '확인 중';
});
const progressTitle = computed(() => {
  if (connectionStale.value && (error.value || lastResponse.value)) return '현재 진행 상태를 확인할 수 없습니다';
  if (workerStale.value) return '작업 진행 신호가 늦습니다';
  if (error.value && !activeState.value) return '실행 요청 확인이 필요합니다';
  if (activeState.value?.phase) return PHASES[activeState.value.phase];
  if (pending.value) return pending.value === 'start' ? '시작 요청을 보냈습니다' : '확장프로그램의 실행 확인을 기다립니다';
  return stateLabel.value;
});
const progressDetail = computed(() => activeState.value?.detail || current.value?.note || (pending.value ? '확장프로그램의 응답을 기다립니다. 아직 페이지 탐색이 시작됐다는 확인은 없습니다.' : '아래 항목별 결과와 활동 로그에서 확인할 내용을 볼 수 있습니다.'));
const capturedCount = computed(() => activeState.value?.jobs.reduce((sum, j) => sum + (j.received ?? 0), 0) ?? 0);
const actionCount = computed(() => activeState.value?.jobs.reduce((sum, j) => sum + (j.actions ?? 0), 0) ?? 0);
const lastReplyText = computed(() => lastResponse.value ? `마지막 상태 응답 ${duration(seconds(lastResponse.value))} 전${connectionStale.value ? ', 연결 확인 필요' : ''}` : '확장프로그램 상태 응답 대기 중');
const timeText = (at: number) => new Date(at).toLocaleTimeString('ko-KR', { hour12: false });
function eventText(event: ActivityEvent) {
  const context = [event.jobIndex !== undefined ? `${event.jobIndex + 1}번째 항목` : '', SITES.find((s) => s.id === event.site)?.name].filter(Boolean).join(', ');
  const counts = [event.responses !== undefined ? `응답 ${event.responses}건` : '', event.listings !== undefined ? `매물 저장 처리 ${event.listings}건` : '', event.actions !== undefined ? `탐색 ${event.actions}회` : ''].filter(Boolean).join(', ');
  return [context, [LOG_LABELS[event.code], counts].filter(Boolean).join(', ')].filter(Boolean).join(': ');
}
const activity = computed(() => [...(activeState.value?.logs ?? []).map((event) => ({ at: event.at, text: eventText(event) })), ...localEvents.value]
  .sort((a, b) => b.at - a.at).slice(0, 100));
function localEvent(text: string) {
  localEvents.value = [...localEvents.value, { at: Date.now(), text }].slice(-12);
}
let poll: number | undefined;
let commandTimeout: number | undefined;

// 네이버 필터는 열린 네이버 탭의 주소에서 확장이 읽는다. 대시보드는 탭 목록과 조건 문구, 시작 때 대조할 키만 받는다.
interface NaverTab { id: number; title: string; active: boolean }
interface NaverSource { key: string; tabId: number; conditions: { label: string; value: string }[] }
type NaverRequest = 'naver-filter-tabs' | 'naver-filter-state' | 'naver-preset-save';
const naverChosen = computed(() => chosenSites.value.some((site) => site.id === 'naver'));
const naverTabs = ref<NaverTab[]>([]);
const naverTabId = ref<number | null>(null);
const naverSource = ref<NaverSource | null>(null);
const naverBusy = ref<NaverRequest | null>(null);
const naverError = ref<string | null>(null);
const naverPresetNotice = ref<string | null>(null);
let naverRequestId: string | null = null;
let naverSequence = 0;
let naverTimeout: number | undefined;
const naverSourceReady = computed(() => !naverJobs.value.length || !naverBusy.value && !!naverSource.value && naverSource.value.tabId === naverTabId.value);
// 0.8.23부터 대시보드에서도 읽은 필터와 고른 구나 동을 브라우저 예약 조회용으로 저장한다.
const naverPresetVersionReady = computed(() => extensionAtLeast(8, 23));
const canSaveNaverPreset = computed(() => naverPresetVersionReady.value && naverJobs.value.length > 0 && naverSourceReady.value);
const naverStatus = computed(() => naverBusy.value === 'naver-filter-tabs' ? '열린 네이버 매물 탭을 찾고 있습니다.'
  : naverBusy.value === 'naver-filter-state' ? '고른 탭의 필터를 읽고 있습니다.'
  : naverError.value ?? (naverSource.value ? '고른 탭의 주소에서 읽은 조건입니다. 시작할 때 다시 읽어 같을 때만 수집하고, 수집 창의 응답도 같은 조건인지 확인합니다.'
    : naverTabs.value.length ? '필터를 적용한 네이버 탭을 골라 주세요.'
    : '네이버 지도에서 구나 동 매물 목록에 필터를 적용한 뒤 탭 목록 새로고침을 눌러 주세요.'));
function readNaverTabs(value: unknown): NaverTab[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const tabs = value as NaverTab[];
  return tabs.every((t) => t && Number.isSafeInteger(t.id) && t.id > 0 && typeof t.title === 'string' && t.title.length <= 160 && typeof t.active === 'boolean')
    ? tabs.map(({ id, title, active }) => ({ id, title, active })) : null;
}
function readNaverSource(value: unknown): NaverSource | null {
  const x = value as NaverSource | null;
  if (!x || typeof x !== 'object' || typeof x.key !== 'string' || !x.key || x.key.length > 20000 || !Number.isSafeInteger(x.tabId) || x.tabId <= 0
    || !Array.isArray(x.conditions) || x.conditions.length > 60
    || !x.conditions.every((row) => row && typeof row.label === 'string' && row.label.length <= 80 && typeof row.value === 'string' && row.value.length <= 1000)) return null;
  return { key: x.key, tabId: x.tabId, conditions: x.conditions.map(({ label, value }) => ({ label, value })) };
}
function naverRequest(type: NaverRequest, extra: { tabId?: number; filterKey?: string; areaIds?: number[] } = {}) {
  if (!ready.value) return;
  naverRequestId = `${requestPrefix}-naver-${++naverSequence}`;
  naverBusy.value = type;
  naverError.value = null;
  naverPresetNotice.value = null;
  window.clearTimeout(naverTimeout);
  naverTimeout = window.setTimeout(() => {
    naverRequestId = null;
    naverBusy.value = null;
    naverError.value = '확장이 네이버 탭 확인에 답하지 않았습니다. 대시보드를 새로고침한 뒤 다시 시도해 주세요.';
  }, 10000);
  window.postMessage({ source: 'hnw-dashboard', type, requestId: naverRequestId, ...extra }, location.origin);
}
function loadNaverTabs() {
  naverRequest('naver-filter-tabs');
}
function readNaverFilter() {
  naverSource.value = null;
  if (naverTabId.value !== null) naverRequest('naver-filter-state', { tabId: naverTabId.value });
}
function saveNaverPreset() {
  if (!canSaveNaverPreset.value || !naverSource.value) return;
  naverRequest('naver-preset-save', { tabId: naverSource.value.tabId, filterKey: naverSource.value.key, areaIds: naverJobs.value.map((job) => job.areaId) });
}
function chooseNaverTab(value: string) {
  const id = Number(value);
  naverTabId.value = naverTabs.value.some((tab) => tab.id === id) ? id : null;
  readNaverFilter();
}
function onNaverReply(data: { requestId?: unknown; requestType?: unknown; error?: unknown; tabs?: unknown; context?: unknown; preset?: unknown }) {
  if (!naverRequestId || data.requestId !== naverRequestId) return;
  naverRequestId = null;
  naverBusy.value = null;
  window.clearTimeout(naverTimeout);
  if (typeof data.error === 'string') { naverError.value = data.error.slice(0, 300); return; }
  if (data.requestType === 'naver-filter-tabs') {
    const tabs = readNaverTabs(data.tabs);
    if (!tabs) { naverError.value = '네이버 탭 목록을 확인하지 못했습니다. 다시 불러와 주세요.'; return; }
    const previous = naverTabId.value;
    naverTabs.value = tabs;
    // 고른 탭이 닫혔으면 다른 탭으로 바꾸지 않고 다시 고르게 한다.
    naverTabId.value = tabs.some((tab) => tab.id === previous) ? previous
      : previous !== null ? null : tabs.find((tab) => tab.active)?.id ?? (tabs.length === 1 ? tabs[0].id : null);
    readNaverFilter();
    if (previous !== null && naverTabId.value === null) naverError.value = '고른 네이버 탭이 닫혔습니다. 필터를 적용한 탭을 다시 골라 주세요.';
  } else if (data.requestType === 'naver-filter-state') {
    const source = readNaverSource(data.context);
    if (source && source.tabId === naverTabId.value) naverSource.value = source;
    else naverError.value = '고른 탭의 필터를 확인하지 못했습니다. 필터를 다시 읽어 주세요.';
  } else if (data.requestType === 'naver-preset-save') {
    const preset = data.preset as { areaIds?: unknown } | null;
    if (preset && Array.isArray(preset.areaIds)) naverPresetNotice.value = '이 조건과 지역을 예약용으로 저장했습니다. 아래 브라우저 예약 조회의 ‘예약 설정’에서 네이버를 켜세요.';
    else naverError.value = '예약용 저장을 확인하지 못했습니다. 아래 브라우저 예약 조회에서 저장한 필터를 확인해 주세요.';
  }
}
watch(() => naverChosen.value && ready.value, (load) => { if (load) loadNaverTabs(); });

function requestStatus() {
  now.value = Date.now();
  if (!ready.value) return;
  firstRequestAt ||= Date.now();
  window.postMessage({ source: 'hnw-dashboard', type: 'browse-status', requestId: requestId() }, location.origin);
  if (now.value - (lastResponse.value || firstRequestAt) > 12000 && errorKind !== 'command') {
    errorKind = 'connection';
    error.value = '확장프로그램 응답이 늦습니다. 표시된 내용은 마지막으로 확인한 상태입니다. 연결 다시 확인을 눌러 주세요.';
  }
}
function reconnect() {
  error.value = null;
  errorKind = null;
  received.value = false;
  lastResponse.value = 0;
  firstRequestAt = 0;
  window.postMessage({ source: 'hnw-dashboard', type: 'ping' }, location.origin);
  requestStatus();
}
function onMessage(event: MessageEvent) {
  if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'hnw-extension') return;
  if (event.data.type === 'naver-filter') { onNaverReply(event.data); return; }
  if (event.data.type !== 'browse-status') return;
  const request =typeof event.data.requestId === 'string' ? requests.get(event.data.requestId) : undefined;
  if (event.data.requestId !== undefined && !request) return;
  const commandReply = !!pendingRequestId.value && event.data.requestId === pendingRequestId.value && event.data.requestType === 'browse-command';
  if (typeof event.data.error === 'string') {
    if (commandReply || event.data.requestType !== 'browse-command') {
      error.value = event.data.error;
      errorKind = commandReply ? 'command' : 'connection';
      received.value = false;
      if (commandReply) { localEvent('실행 요청에 오류 응답이 왔습니다. 안내 내용을 확인해 주세요.'); clearPending(); }
    }
    return;
  }
  const next = readState(event.data.state);
  if (next === undefined) return;
  const currentReply = !request || request.revision === stateRevision && request.sequence >= lastStateSequence;
  if (currentReply && !(next && state.value?.id === next.id && next.updatedAt < state.value.updatedAt)) {
    state.value = next;
    if (request) lastStateSequence = request.sequence;
    else stateRevision++;
  }
  received.value = true;
  lastResponse.value = now.value = Date.now();
  if (commandReply) {
    localEvent('확장프로그램이 실행 요청에 응답했습니다.');
    clearPending();
    error.value = null;
    errorKind = null;
  } else if (errorKind === 'connection') { error.value = null; errorKind = null; }
}
function clearPending() {
  pending.value = null;
  pendingRequestId.value = null;
  window.clearTimeout(commandTimeout);
}
function command(command: Command) {
  if (!ready.value || pending.value || command === 'start' && !canStart.value) return;
  pending.value = command;
  pendingAt.value = now.value = Date.now();
  pendingRequestId.value = requestId();
  pendingBaseStateId.value = state.value?.id ?? null;
  if (command === 'start') localEvents.value = [];
  localEvent(`${{ start: '시작', pause: '중단', resume: '이어하기', retry: '재시도' }[command]} 요청을 보냈습니다. 확장프로그램의 실행 확인을 기다립니다.`);
  error.value = null;
  errorKind = null;
  try {
    window.postMessage({
      source: 'hnw-dashboard', type: 'browse-command', command, requestId: pendingRequestId.value,
      ...(command === 'start' ? {
        areas: startAreas.value.map(({ id, name, lat, lng, radiusM, region }) => ({ id, name, lat, lng, radiusM,
          ...(region ? { region: { kind: region.kind, code: region.code, name: region.name } }
            : areaScopes.value[id] ? { dabangRegions: areaScopes.value[id].map(({ kind, name, dong, url }) => ({ kind, name, dong, url })) } : {}),
        })),
        // Vue의 반응형 배열(Proxy)은 postMessage로 복제할 수 없다.
        sites: chosenSites.value.filter((site) => plannedJobs.value.some((job) => job.site === site.id)).map((site) => site.id),
        ...(naverJobs.value.length && naverSource.value ? { naverSourceTabId: naverSource.value.tabId, naverFilterKey: naverSource.value.key } : {}),
      } : {}),
    }, location.origin);
  } catch {
    clearPending();
    errorKind = 'command';
    error.value = '실행 요청을 확장프로그램에 전달하지 못했습니다. 대시보드를 새로고침한 뒤 다시 시도해 주세요.';
    localEvent('실행 요청 전송에 실패했습니다. 조회는 시작되지 않았습니다.');
    return;
  }
  window.clearTimeout(commandTimeout);
  commandTimeout = window.setTimeout(() => {
    clearPending();
    errorKind = 'command';
    error.value = '요청 후 12초 동안 실행 확인을 받지 못했습니다. 작업은 시작됐을 수 있어 상태 조회를 계속합니다. 아래 상태와 전용 탭을 먼저 확인해 주세요.';
    localEvent('실행 확인 대기 시간이 지났습니다. 실제 작업 상태를 다시 조회합니다.');
    requestStatus();
  }, 12000);
}
watch(ready, (v) => { if (v) requestStatus(); });
onMounted(async () => {
  window.addEventListener('message', onMessage);
  requestStatus();
  poll = window.setInterval(requestStatus, 2000);
  await loadScopes();
});
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  window.clearInterval(poll);
  window.clearTimeout(commandTimeout);
  window.clearTimeout(naverTimeout);
  scopeController?.abort();
  window.clearTimeout(scopeTimeout);
});
</script>

<template>
  <section id="browse-queue" class="browse-queue management-shell" aria-labelledby="browse-title">
    <div class="heading">
      <div>
        <h2 id="browse-title" tabindex="-1">확장프로그램으로 순차 조회<HelpTip :text="PANEL_HELP" /></h2>
      </div>
      <div class="heading-actions">
        <button class="btn btn-sm" @click="emit('manageAreas')">지역 추가와 관리</button>
        <button class="btn btn-sm" aria-label="지역 순차 조회 닫기" @click="emit('close')">닫기 (Esc)</button>
      </div>
    </div>
    <p v-if="!extension" class="notice">확장이 설치된 크롬에서 대시보드를 열어 주세요.</p>
    <div v-else-if="!ready" class="notice">
      <p>{{ extension.browseError || '확장프로그램을 업데이트한 뒤 대시보드를 새로고침해 주세요.' }} 현재 연결된 버전은 {{ extension.version }}입니다.</p>
      <button class="btn btn-sm" @click="reconnect">연결 다시 확인</button>
    </div>
    <template v-else>
      <div class="choices">
        <fieldset :disabled="running || !!pending">
          <legend>1. 지역 <span class="muted">{{ selectedAreas.length }}곳 선택</span></legend>
          <p v-if="!areas.length" class="muted">지역 탭에서 조회할 지역을 먼저 켜 주세요.</p>
          <template v-else>
            <div v-if="areas.length > 1" class="select-actions">
              <button type="button" @click="selectedAreas = areas.map((a) => a.id)">모두 선택</button>
              <button type="button" @click="selectedAreas = []">선택 해제</button>
            </div>
            <div class="check-list area-list">
              <label v-for="a in areas" :key="a.id" :class="{ selected: selectedAreas.includes(a.id), unused: !!unusedReason(a) }">
                <input v-model="selectedAreas" type="checkbox" :value="a.id">
                <span>{{ a.name }}<small>{{ unusedReason(a) ?? (a.region ? (a.region.kind === 'gu' ? '구 전체' : '법정동 전체') : selectedSites.includes('dabang') && areaScopes[a.id]?.length ? '동별 범위' : `반경 ${radiusText(a.radiusM)}`) }}</small></span>
              </label>
            </div>
          </template>
        </fieldset>
        <fieldset :disabled="running || !!pending">
          <legend>2. 사이트 <span class="muted">{{ selectedSites.length }}곳 선택</span></legend>
          <p v-if="!sites.length" class="muted">확장 아이콘에서 조회할 사이트를 켜 주세요.</p>
          <div class="check-list site-list">
            <label v-for="s in sites" :key="s.id" :class="{ selected: selectedSites.includes(s.id) }">
              <input v-model="selectedSites" type="checkbox" :value="s.id">
              <span>{{ s.name }}<small>{{ s.mode }}</small></span>
            </label>
            <div v-if="naverEnabled && !naverVersionReady" class="icon-site" title="확장이 0.8.22 이상으로 자동 업데이트되면 여기서 고를 수 있습니다. 그 전에는 확장 아이콘 메뉴에서 시작하세요.">
              <span class="icon-mark" aria-hidden="true"></span>
              <span>네이버<small>확장 업데이트 후 선택</small></span>
            </div>
          </div>
        </fieldset>
      </div>

      <fieldset v-if="naverChosen" class="naver-source" :disabled="running || !!pending">
        <legend>3. 네이버 필터 <span class="muted">{{ naverSource ? '읽음' : '확인 필요' }}</span><HelpTip :text="NAVER_HELP" /></legend>
        <div class="naver-source-row">
          <select aria-label="필터를 읽을 네이버 탭" :disabled="!!naverBusy || !naverTabs.length" @change="chooseNaverTab(($event.target as HTMLSelectElement).value)">
            <option value="" :selected="naverTabId === null">{{ naverTabs.length ? '필터를 적용한 네이버 탭을 고르세요' : '열린 네이버 매물 탭이 없습니다' }}</option>
            <option v-for="tab in naverTabs" :key="tab.id" :value="tab.id" :selected="tab.id === naverTabId">{{ tab.title }}</option>
          </select>
          <button type="button" class="btn btn-sm" :disabled="!!naverBusy" @click="loadNaverTabs">탭 목록 새로고침</button>
          <button type="button" class="btn btn-sm" :disabled="!!naverBusy || naverTabId === null" @click="readNaverFilter">필터 다시 읽기</button>
        </div>
        <!-- 필터를 읽은 뒤에는 상태 글 대신 읽은 조건만 보인다(읽는 중, 오류, 아직 고르지 않음일 때만 글로 알린다). -->
        <p v-if="naverBusy || naverError || !naverSource" class="help" :class="{ 'stale-help': naverError && !naverBusy }" role="status">{{ naverStatus }}</p>
        <ul v-else class="naver-conditions" aria-label="읽은 네이버 필터">
          <li v-for="(row, index) in naverSource.conditions" :key="index" :title="`${row.label}: ${row.value}`"><b>{{ row.label }}</b>{{ row.value }}</li>
        </ul>
        <NaverManual :areas="areas" :received-at="naverReceivedAt ?? null" />
      </fieldset>

      <div class="launch-panel" aria-label="이번 조회 범위">
        <div class="launch-summary">
          <div class="section-heading"><h3>이번 조회</h3><span v-if="scopesReady && plannedJobs.length" class="count-badge">예상 {{ plannedJobs.length }}개 조회</span></div>
          <p v-if="scopesLoading" class="help" role="status">저장된 동별 범위를 불러오는 중입니다.</p>
          <ol v-else-if="scopesReady && plannedJobs.length" class="planned-jobs">
            <li v-for="(job, index) in plannedJobs" :key="job.key">
              <span class="job-number">{{ index + 1 }}</span>
              <strong :title="job.detail">{{ job.scoped ? job.label : job.areaName }}</strong>
              <span class="muted">{{ job.siteName }}, {{ job.scoped ? '원/투룸' : job.label }}</span>
            </li>
          </ol>
          <p v-else-if="scopesReady" class="help">지역과 사이트를 하나 이상 골라 주세요.</p>
          <!-- 빠지는 지역은 이름만 한 줄로 보이고, 왜 빠지는지는 (?)에 둔다. -->
          <p v-if="skippedAreas.length" class="skip-line" role="status">빠짐: {{ skippedAreas.map((a) => a.name).join(', ') }}<HelpTip :text="skipNote" /></p>
        </div>
        <div class="launch-action">
          <button
            class="btn btn-primary start-button" :disabled="!canStart" :title="state?.status === 'paused' ? '새로 시작하면 중단된 순회를 대체합니다' : undefined"
            @click="command('start')"
          >{{ pending === 'start' ? '시작 확인 중…' : running ? '조회 진행 중' : '선택한 범위 조회 시작' }}</button>
          <span v-if="!received && !error" class="help" role="status">확장 연결 확인 중…</span>
          <span v-else-if="naverJobs.length && !naverSourceReady" class="help">네이버 필터를 먼저 읽어 주세요</span>
        </div>
      </div>
      <p v-if="scopesReady && !scopeVersionReady" class="notice" role="alert">동별 조회는 확장 0.8.4 이상이 필요합니다. 확장이 자동 업데이트된 뒤 대시보드를 새로고침해 주세요. 현재 연결: {{ extension?.version }}</p>
      <div v-if="scopeError" class="notice" role="alert">
        <p>{{ scopeError }}</p>
        <button class="btn btn-sm" :disabled="scopesLoading" @click="loadScopes">조회 범위 다시 불러오기</button>
      </div>
      <div v-if="error" class="notice" role="alert">
        <p>{{ error }}</p>
        <button class="btn btn-sm" :disabled="!!pending" @click="reconnect">연결 다시 확인</button>
      </div>

      <section v-if="pending || activeState || localEvents.length" class="run-panel" :class="{ live: pending || activeState?.status !== 'done', uncertain: connectionStale || workerStale }" aria-label="조회 진행과 최근 결과">
        <button v-if="activeState?.status === 'done' && !pending" class="run-toggle" :aria-expanded="runExpanded" aria-controls="browse-run-body" @click="runExpanded = !runExpanded">
          <span class="run-toggle-title"><strong>최근 조회 결과</strong><span class="help">{{ runDate }}</span><span class="result-badge" :class="{ attention: incomplete }">{{ incomplete ? `미완료 작업 ${incomplete}개` : `${activeState.jobs.length}개 조회 종료` }}</span></span>
          <span class="previous-scope">{{ runScopeLabel }}</span>
          <span class="toggle-label">{{ runExpanded ? '접기 ▴' : '펼치기 ▾' }}</span>
        </button>
        <div v-if="runExpanded || pending || activeState?.status !== 'done'" id="browse-run-body" class="run-body">
          <div class="progress-panel" aria-label="순차 조회 진행 상황">
            <div class="progress-heading">
              <strong role="status" aria-live="polite">{{ progressTitle }}</strong>
              <span class="elapsed">경과 {{ elapsed }}</span>
            </div>
            <p v-if="current" class="current-job">{{ current.areaName }}, {{ current.siteName }}<span v-if="activeState"> ({{ activeState.index + 1 }}/{{ activeState.jobs.length }})</span></p>
            <p v-if="current && naverCoverageFor(current)" class="page-progress">{{ naverCoverageText(naverCoverageFor(current)!) }}</p>
            <p v-if="current?.receipt?.coverage" class="page-progress">{{ coverageText(current.receipt.coverage) }}</p>
            <template v-if="current && zigbangCoverageFor(current)">
              <p class="page-progress">{{ zigbangCoverageText(zigbangCoverageFor(current)!) }}</p>
              <p class="help">{{ zigbangMissingText(zigbangCoverageFor(current)!) }}</p>
            </template>
            <p class="progress-detail">{{ connectionStale || workerStale ? '마지막 확인 내용: ' : '' }}{{ progressDetail }}</p>
            <progress v-if="activeState?.jobs.length" :value="finished" :max="activeState.jobs.length" :aria-label="`${activeState.jobs.length}개 중 ${finished}개 항목 조회 종료`" />
            <div v-if="activeState" class="counters">
              <span>조회 종료 <b>{{ finished }} / {{ activeState.jobs.length }}</b></span>
              <span>신규 매물 <b>{{ totals?.newCount ?? 0 }}건</b></span>
              <span>가격 변경 <b>{{ totals?.changedCount ?? 0 }}건</b></span>
              <span>서버 수신 <b>{{ totals?.responses ?? 0 }}건</b></span>
            </div>
            <div class="run-actions">
              <button v-if="running" class="btn btn-sm" :disabled="!!pending" @click="command('pause')">{{ pending === 'pause' ? '중단하는 중…' : '조회 중단' }}</button>
              <button v-if="activeState?.status === 'paused'" class="btn btn-sm" :disabled="!!pending || !received" @click="command('resume')">{{ pending === 'resume' ? '이어가는 중…' : '중단한 조회 이어하기' }}</button>
              <p class="help">{{ lastReplyText }}</p>
            </div>
            <p v-if="connectionStale || workerStale" class="stale-help">응답이 늦어 마지막으로 받은 상태를 보여 줍니다.</p>
          </div>
          <div v-if="activeState" class="results">
            <div class="section-heading"><h3>항목별 결과</h3><span class="help">{{ activeState.jobs.length }}개 조회</span></div>
            <div class="job-results">
              <article v-for="j in activeState.jobs" :key="j.id" class="job-result">
                <div class="job-heading">
                  <span><strong>{{ j.areaName }}</strong> <span class="muted">{{ j.siteName }}</span></span>
                  <span class="result-badge" :class="j.status === 'complete' && j.site === 'zigbang' && !zigbangCoverageFor(j)?.complete ? 'attention' : j.status">{{ statusLabel(j) }}</span>
                </div>
                <template v-if="j.receipt">
                  <p v-if="j.receipt.coverage" class="page-progress" :title="receiptText(j.receipt)">{{ coverageText(j.receipt.coverage) }}</p>
                  <p v-if="j.receipt.coverage && !j.receipt.coverage.complete" class="stale-help">{{ coverageReason(j.receipt.coverage) }}</p>
                  <template v-if="zigbangCoverageFor(j)">
                    <p class="page-progress">{{ zigbangCoverageText(zigbangCoverageFor(j)!) }}</p>
                    <p class="help">{{ zigbangMissingText(zigbangCoverageFor(j)!) }}</p>
                    <p v-if="!zigbangCoverageFor(j)!.complete" class="stale-help">{{ zigbangCoverageReason(zigbangCoverageFor(j)!) }}</p>
                  </template>
                  <p v-if="naverCoverageFor(j)" class="page-progress" :title="receiptText(j.receipt)">{{ naverCoverageText(naverCoverageFor(j)!) }}</p>
                  <!-- 페이지 확인 줄이 없을 때만 서버가 받은 수를 글로 보인다(있으면 그 줄에 마우스를 올려 본다). -->
                  <p v-if="!j.receipt.coverage && !naverCoverageFor(j)" class="help">{{ receiptText(j.receipt) }}</p>
                  <p v-if="j.scope" class="help">주변 함께 저장 {{ j.receipt.retainedOutside ?? 0 }}건, 동 미확인 저장 {{ j.receipt.retainedUnknown ?? 0 }}건, 저장 제외 {{ (j.receipt.excludedOutside ?? 0) + (j.receipt.excludedUnknown ?? 0) }}건</p>
                </template>
                <p v-else class="help">저장 확인 전</p>
                <!-- 지금 도는 작업의 메모는 위 진행 표시에 이미 보이므로 카드에서는 되풀이하지 않는다. -->
                <p v-if="j.note && !(j.id === current?.id && j.note === progressDetail)" class="job-note">{{ j.note }}</p>
                <a v-if="safeLink(j.url)" :href="safeLink(j.url)!" target="_blank" rel="noopener" class="job-link">{{ j.siteName }}에서 직접 확인 ↗</a>
              </article>
            </div>
            <div v-if="incomplete && !running" class="retry-area">
              <button class="btn btn-sm" :disabled="!!pending || connectionStale" @click="command('retry')">{{ pending === 'retry' ? '재조회 준비 중…' : `미완료 작업 ${incomplete}개 처음부터 다시 조회` }}</button>
              <HelpTip :text="`다시 조회할 대상: ${incompleteJobs.map((j) => `${j.areaName}(${j.siteName}${j.scope ? `, ${j.scope.dong}` : ''})`).join(', ')}. 목록을 처음부터 다시 보고, 이미 저장된 매물은 최신 정보로 갱신합니다.`" />
            </div>
          </div>
          <details class="activity">
            <summary>활동 로그 <span class="muted">{{ activity.length }}건, 최신순</span></summary>
            <p class="help log-counts">목록 탐색 {{ actionCount }}회, 브라우저 수신 {{ capturedCount }}건, 매물 저장 처리 {{ totals?.listings ?? 0 }}건</p>
            <ol v-if="activity.length" aria-label="조회 활동 로그">
              <li v-for="(event, index) in activity" :key="`${event.at}-${index}`"><time>{{ timeText(event.at) }}</time><span>{{ event.text }}</span></li>
            </ol>
            <p v-else class="help">아직 활동 로그가 없습니다.</p>
          </details>
        </div>
      </section>

    </template>
    <BrowseAuto :areas="areas" :scopes="areaScopes" :scopes-ready="scopesReady">
      <!-- 네이버 필터를 예약용으로 저장하는 단추는 예약 칸 안에 둔다(예약을 안 쓰면 접힌 채로 안 보인다). -->
      <template #preset>
        <div v-if="ready && naverChosen" class="naver-preset-row">
          <template v-if="naverPresetVersionReady">
            <button type="button" class="btn btn-sm" :disabled="!canSaveNaverPreset" @click="saveNaverPreset">{{ naverBusy === 'naver-preset-save' ? '저장하는 중…' : '지금 고른 네이버 필터와 지역을 예약용으로 저장' }}</button>
            <HelpTip text="1번에서 고른 구나 동과 위에서 읽은 네이버 필터를 예약 조회용으로 저장합니다. 바로 수집하지는 않습니다." />
            <span v-if="naverPresetNotice" class="help" role="status">{{ naverPresetNotice }}</span>
          </template>
          <span v-else class="help">예약용 저장은 확장 0.8.23 이상에서 됩니다.</span>
        </div>
      </template>
    </BrowseAuto>
  </section>
</template>

<style scoped>
.browse-queue { margin-block: 18px; padding: 24px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); display: grid; gap: 20px; font-size: 16px; scroll-margin-top: calc(var(--app-header-height, 80px) + 16px); }
.heading { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 16px; }
.heading-actions { display: flex; flex-wrap: wrap; gap: 8px; }
h2 { margin: 0 0 6px; font-size: 22px; }
h3 { margin: 0; font-size: 16px; }
p { margin: 0; line-height: 1.6; }
.heading p { font-size: 14px; }
.choices { display: grid; grid-template-columns: 1fr 1.2fr; gap: 20px; }
fieldset { min-width: 0; margin: 0; padding: 12px 16px 16px; border: 1px solid var(--line); border-radius: 10px; }
legend { font-weight: 700; padding: 0 6px; }
legend .muted { margin-left: 6px; font-weight: 400; font-size: 13px; }
.select-actions { display: flex; gap: 8px; margin-bottom: 8px; }
.select-actions button { min-height: 36px; padding: 0 8px; border: 0; border-radius: 6px; background: var(--surface-2); font-size: 13px; }
.check-list { display: grid; gap: 8px; max-height: 220px; overflow-y: auto; padding: 3px; }
.area-list { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
.site-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.check-list label { display: flex; align-items: center; gap: 9px; min-height: 58px; padding: 8px 10px; border: 1px solid transparent; border-radius: 8px; cursor: pointer; font-size: 15px; }
.check-list label:hover { background: var(--surface-2); }
.check-list label.selected { background: var(--accent-soft); border-color: #b7ccec; }
/* 고른 사이트가 안 보는 지역: 흐리게 두고 작은 글씨로 까닭을 보인다(골라 둔 것은 그대로 두어 사이트를 바꾸면 다시 쓰인다). */
.check-list label.unused { opacity: .5; }
.check-list input { width: 17px; height: 17px; flex: none; margin: 0; accent-color: var(--accent); }
.check-list small { display: block; margin-top: 1px; color: var(--muted); font-size: 12px; font-weight: 400; }
.icon-site { display: flex; align-items: center; gap: 9px; min-height: 58px; padding: 8px 10px; border: 1px dashed var(--line); border-radius: 8px; font-size: 15px; }
.icon-mark { width: 17px; flex: none; text-align: center; color: var(--muted); font-size: 13px; }
.naver-source { display: grid; gap: 10px; }
.naver-source-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.naver-preset-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.naver-source-row select { flex: 1 1 260px; min-width: 0; min-height: 36px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: inherit; font: inherit; font-size: 14px; }
/* 읽은 네이버 필터: 표 대신 한 줄씩 늘어나는 작은 칸(긴 값은 줄이고 마우스를 올리면 전부 보인다) */
.naver-conditions { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
.naver-conditions li { display: inline-flex; gap: 6px; max-width: 100%; padding: 4px 10px; border-radius: 6px; background: var(--surface-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.naver-conditions li b { color: var(--muted); font-weight: 600; }
.skip-line { margin: 0; font-size: 13px; color: var(--muted); }
fieldset:disabled { opacity: .65; }
fieldset:disabled label { cursor: default; }
.launch-panel { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 20px 24px; background: var(--accent-soft); border: 1px solid #c9d8ee; border-radius: 10px; }
.launch-summary { min-width: 0; display: grid; gap: 12px; }
.section-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.count-badge { padding: 3px 9px; border-radius: 6px; background: var(--surface); font-size: 13px; color: var(--accent); font-weight: 700; }
.planned-jobs { display: grid; gap: 8px; padding: 0; margin: 0; list-style: none; max-height: 210px; overflow: auto; }
.planned-jobs li { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; line-height: 1.5; }
.planned-jobs .muted { font-size: 13px; }
.job-number { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; color: var(--accent); background: var(--surface); font-size: 12px; font-weight: 700; }
.scope-note { font-size: 13px; color: var(--ink-2); }
.launch-action { flex: none; display: grid; justify-items: center; gap: 8px; }
.start-button { min-height: 48px; padding: 0 22px; font-size: 16px; }
.help { font-size: 13px; color: var(--muted); }
.notice { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 14px 16px; border: 1px solid #ebc6ae; border-radius: 8px; color: var(--up); background: var(--up-soft); font-size: 14px; }
.notice p { flex: 1 1 340px; }
.run-panel { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.run-panel.live { border: 2px solid var(--accent); }
.run-panel.uncertain { border-color: var(--up); }
.run-toggle { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px 16px; width: 100%; padding: 16px 20px; border: 0; background: var(--surface); text-align: left; }
.run-toggle:hover { background: var(--surface-2); }
.run-toggle-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.previous-scope { grid-row: 2; font-size: 13px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.toggle-label { grid-column: 2; grid-row: 1 / 3; font-size: 13px; white-space: nowrap; color: var(--muted); }
.run-body { padding: 20px; display: grid; gap: 22px; }
.run-toggle + .run-body { border-top: 1px solid var(--line); }
.progress-panel { display: grid; gap: 12px; }
.progress-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.progress-heading strong { font-size: 18px; }
.elapsed { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.current-job { font-weight: 700; }
.current-job span { font-size: 13px; font-weight: 400; color: var(--muted); }
.page-progress { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.progress-detail { font-size: 14px; color: var(--ink-2); }
.counters { display: flex; flex-wrap: wrap; gap: 12px 28px; padding: 12px 16px; background: var(--surface-2); border-radius: 8px; font-size: 13px; }
.counters b { margin-left: 8px; font-size: 16px; font-variant-numeric: tabular-nums; }
progress { width: 100%; height: 10px; accent-color: var(--accent); }
.run-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.retry-area { display: grid; justify-items: start; gap: 10px; }
.retry-targets { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.7; }
.retry-targets .help { display: block; }
.stale-help { color: var(--up); font-size: 13px; }
.results { display: grid; gap: 12px; }
.job-results { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; max-height: 520px; overflow-y: auto; }
.job-result { display: grid; align-content: start; gap: 8px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; }
.job-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; font-size: 15px; }
.result-badge { display: inline-block; padding: 3px 8px; font-size: 12px; font-weight: 600; border-radius: 5px; color: var(--muted); background: var(--surface-2); }
.result-badge.attention, .result-badge.partial, .result-badge.failed, .result-badge.needs-input { color: var(--up); background: var(--up-soft); }
.result-badge.complete { color: var(--down); background: var(--down-soft); }
.result-badge.running { color: var(--accent); background: var(--accent-soft); }
.job-note { font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; }
.job-link { justify-self: start; display: inline-flex; align-items: center; min-height: 36px; font-size: 13px; }
summary { cursor: pointer; font-weight: 600; font-size: 14px; min-height: 36px; padding: 6px 0; }
summary .muted { margin-left: 6px; font-weight: 400; font-size: 13px; }
.activity { border-top: 1px solid var(--line); padding-top: 10px; }
.activity ol { list-style: none; max-height: 240px; overflow-y: auto; padding: 0; margin: 10px 0 0; }
.activity li { display: flex; align-items: baseline; gap: 16px; padding: 6px 0; font-size: 13px; line-height: 1.5; }
.activity time { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.log-counts { margin-top: 8px; }
button:disabled { cursor: not-allowed; }
@media (max-width: 1000px) { .choices { grid-template-columns: 1fr 1.25fr; gap: 12px; } .site-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) {
  .browse-queue { margin: 12px auto; padding: 16px; gap: 16px; }
  .choices { grid-template-columns: 1fr; }
  .launch-panel { align-items: stretch; flex-direction: column; gap: 20px; padding: 16px; }
  .launch-action { justify-items: stretch; text-align: center; }
  .job-results { grid-template-columns: 1fr; }
  .run-body, .run-toggle { padding: 16px; }
  .activity li { gap: 10px; }
}
</style>
