<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Area } from '../../../shared/types';
import { radiusText } from '../format';

const props = defineProps<{
  areas: Area[];
  extension: { version: string; sites: string[]; browse?: boolean; browseError?: string } | null;
}>();
const emit = defineEmits<{ close: [] }>();

interface Receipt { responses: number; listings: number; newCount: number; changedCount: number }
type JobStatus = 'pending' | 'running' | 'partial' | 'failed' | 'visited' | 'needs-input';
interface BrowseJob {
  id: string;
  areaName: string;
  site: string;
  siteName: string;
  url: string;
  status: JobStatus;
  note: string;
  receipt?: Receipt;
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
  { id: 'naver', name: '네이버', mode: '매물 목록', defaultOn: true },
  { id: 'dabang', name: '다방', mode: '매물 목록', defaultOn: true },
  { id: 'zigbang', name: '직방', mode: '매물 목록', defaultOn: true },
  { id: 'kbland', name: 'KB부동산', mode: '건수 확인', defaultOn: false },
  { id: 'hogangnono', name: '호갱노노', mode: '화면 확인', defaultOn: false },
  { id: 'daangn', name: '당근', mode: '화면 확인', defaultOn: false },
];
const STATUS: Record<JobStatus, string> = {
  pending: '대기', running: '조회 중', partial: '일부 확인', failed: '실패', visited: '화면 확인', 'needs-input': '직접 확인 필요',
};
const HOSTS = new Set(['fin.land.naver.com', 'new.land.naver.com', 'www.dabangapp.com', 'www.zigbang.com', 'kbland.kr', 'hogangnono.com', 'realty.daangn.com']);
const safeLink = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOSTS.has(u.hostname) ? u.href : null;
  } catch { return null; }
};
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
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
    && (j.receipt === undefined || j.receipt !== null && ['responses', 'listings', 'newCount', 'changedCount'].every((k) => isCount(j.receipt![k as keyof Receipt]))))) return undefined;
  return x;
}

const ready = computed(() => props.extension?.browse === true);
const sites = computed(() => SITES.filter((s) => props.extension?.sites.includes(s.id)));
const selectedAreas = ref<number[]>([]);
const selectedSites = ref<string[]>([]);
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
const incomplete = computed(() => state.value?.jobs.filter((j) => ['partial', 'failed', 'needs-input'].includes(j.status)).length ?? 0);
const finished = computed(() => activeState.value?.jobs.filter((j) => !['pending', 'running'].includes(j.status)).length ?? 0);
const current = computed(() => activeState.value?.jobs.find((j) => j.status === 'running'));
const totals = computed(() => activeState.value?.jobs.reduce((sum, j) => ({
  responses: sum.responses + (j.receipt?.responses ?? 0),
  listings: sum.listings + (j.receipt?.listings ?? 0),
  newCount: sum.newCount + (j.receipt?.newCount ?? 0),
  changedCount: sum.changedCount + (j.receipt?.changedCount ?? 0),
}), { responses: 0, listings: 0, newCount: 0, changedCount: 0 }));
const chosenAreas = computed(() => props.areas.filter((a) => selectedAreas.value.includes(a.id)));
const connectionStale = computed(() => !received.value || !!lastResponse.value && now.value - lastResponse.value > 12000);
const canStart = computed(() => ready.value && !connectionStale.value && !pending.value && !running.value && chosenAreas.value.length > 0 && selectedSites.value.length > 0);
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
  if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'hnw-extension' || event.data.type !== 'browse-status') return;
  const request = typeof event.data.requestId === 'string' ? requests.get(event.data.requestId) : undefined;
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
        areas: chosenAreas.value.map(({ id, name, lat, lng, radiusM }) => ({ id, name, lat, lng, radiusM })),
        // Vue의 반응형 배열(Proxy)은 postMessage로 복제할 수 없다.
        sites: [...selectedSites.value],
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
onMounted(() => {
  window.addEventListener('message', onMessage);
  requestStatus();
  poll = window.setInterval(requestStatus, 2000);
});
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  window.clearInterval(poll);
  window.clearTimeout(commandTimeout);
});
</script>

<template>
  <section id="browse-queue" class="browse-queue" aria-labelledby="browse-title">
    <div class="heading">
      <div>
        <h2 id="browse-title">지역 순차 조회</h2>
        <p class="muted">전용 탭 하나로 선택한 지역을 차례로 엽니다. 네이버, 다방, 직방은 확인 가능한 목록을 펼치거나 내려서 받습니다.</p>
      </div>
      <button class="btn btn-sm" aria-label="지역 순차 조회 패널 닫기" @click="emit('close')">접기</button>
    </div>
    <p v-if="!extension" class="notice">확장이 설치된 크롬에서 대시보드를 열어 주세요.</p>
    <div v-else-if="!ready" class="notice">
      <p>{{ extension.browseError || '확장프로그램을 업데이트한 뒤 대시보드를 새로고침해 주세요.' }} 현재 연결된 버전은 {{ extension.version }}입니다.</p>
      <button class="btn btn-sm" @click="reconnect">연결 다시 확인</button>
    </div>
    <template v-else>
      <div v-if="pending || activeState || localEvents.length" class="progress-panel" :class="{ uncertain: connectionStale || workerStale }" aria-label="순차 조회 진행 상황">
        <div class="progress-heading">
          <strong role="status" aria-live="polite">{{ progressTitle }}</strong>
          <span class="elapsed">경과 {{ elapsed }}</span>
        </div>
        <p v-if="current" class="current-job">{{ current.areaName }}, {{ current.siteName }}<span v-if="activeState"> ({{ activeState.index + 1 }}/{{ activeState.jobs.length }}번째 항목)</span></p>
        <p>{{ connectionStale || workerStale ? '마지막 확인 내용: ' : '' }}{{ progressDetail }}</p>
        <p v-if="pending && activeState" class="help">요청 응답을 기다리는 동안에도 확인된 작업 상태를 계속 갱신합니다.</p>
        <div v-if="activeState" class="counters">
          <span>종료한 항목 <b>{{ finished }}/{{ activeState.jobs.length }}</b></span>
          <span>목록 탐색 <b>{{ actionCount }}회</b></span>
          <span>브라우저 수신 <b>{{ capturedCount }}건</b></span>
          <span>서버 수신 확인 <b>{{ totals?.responses ?? 0 }}건</b></span>
          <span>매물 저장 처리 <b>{{ totals?.listings ?? 0 }}건</b></span>
        </div>
        <progress v-if="activeState?.jobs.length" :value="finished" :max="activeState.jobs.length" :aria-label="`${activeState.jobs.length}개 중 ${finished}개 항목 조회 종료`" />
        <p class="help">{{ lastReplyText }}<template v-if="activeState?.heartbeatAt && activeState.status === 'running'">, 마지막 작업 신호 {{ duration(seconds(activeState.heartbeatAt)) }} 전</template></p>
        <p v-if="connectionStale || workerStale" class="stale-help">표시된 내용은 마지막으로 확인한 상태입니다. 실제 진행 여부는 아직 확인되지 않았습니다.</p>
        <details class="activity" open>
          <summary>활동 로그 <span class="muted">최근 {{ activity.length }}건, 최신순</span></summary>
          <ol v-if="activity.length" aria-label="조회 활동 로그">
            <li v-for="(event, index) in activity" :key="`${event.at}-${index}`"><time>{{ timeText(event.at) }}</time><span>{{ event.text }}</span></li>
          </ol>
          <p v-else class="help">이 작업의 활동 로그가 아직 없습니다. 항목별 확인 상태를 참고해 주세요.</p>
        </details>
      </div>
      <div class="choices">
        <fieldset :disabled="running || !!pending">
          <legend>지역 <span class="muted">{{ selectedAreas.length }}곳 선택</span></legend>
          <p v-if="!areas.length" class="muted">지역 탭에서 조회할 지역을 먼저 켜 주세요.</p>
          <template v-else>
            <button type="button" class="linkish" @click="selectedAreas = areas.map((a) => a.id)">모두 선택</button>
            <button type="button" class="linkish" @click="selectedAreas = []">선택 해제</button>
            <div class="check-list">
              <label v-for="a in areas" :key="a.id"><input v-model="selectedAreas" type="checkbox" :value="a.id">{{ a.name }} <span class="muted">{{ radiusText(a.radiusM) }}</span></label>
            </div>
          </template>
        </fieldset>
        <fieldset :disabled="running || !!pending">
          <legend>사이트</legend>
          <p v-if="!sites.length" class="muted">확장 아이콘에서 조회할 사이트를 켜 주세요.</p>
          <div class="check-list">
            <label v-for="s in sites" :key="s.id"><input v-model="selectedSites" type="checkbox" :value="s.id">{{ s.name }} <span class="muted">{{ s.mode }}</span></label>
          </div>
        </fieldset>
      </div>
      <p class="help">조회 중 전용 탭의 화면이 자동으로 바뀝니다. KB는 건수만, 호갱노노와 당근은 화면 데이터만 확인하며 개별 매물로 정리하지 않습니다.</p>
      <details class="how-it-works">
        <summary>어떤 원리로 동작하나요?</summary>
        <ol>
          <li>선택한 지역과 사이트를 조회 순서로 만들고, 크롬 확장이 전용 탭 하나에서 지역별 URL을 차례로 엽니다.</li>
          <li>네이버, 다방, 직방에서 확인 가능한 매물 목록을 펼치거나 내립니다. 이때 페이지가 받은 데이터를 확장이 수신합니다.</li>
          <li>받은 데이터를 이 PC의 서버에 보내 매물을 정리하고, 서버가 저장을 확인한 건수를 위에 표시합니다.</li>
        </ol>
        <p class="help">한 항목에서 최대 2분 또는 40회까지 탐색하고 마지막 응답을 최대 15초 더 기다립니다. 로딩 지연, 로그인이나 인증 화면, 인식하지 못한 목록은 확인할 내용에 표시됩니다. 화면에서 확인한 범위만 처리하므로 지역 전체 매물의 수집 완료를 뜻하지 않습니다.</p>
      </details>
      <div class="actions">
        <button class="btn btn-primary" :disabled="!canStart" @click="command('start')">{{ pending === 'start' ? '시작하는 중…' : state ? '선택한 조건으로 새 순회' : '선택 지역 조회 시작' }}</button>
        <button v-if="running" class="btn" :disabled="!!pending" @click="command('pause')">{{ pending === 'pause' ? '중단하는 중…' : '중단' }}</button>
        <button v-if="state?.status === 'paused'" class="btn" :disabled="!!pending || !received" @click="command('resume')">{{ pending === 'resume' ? '이어가는 중…' : '이어하기' }}</button>
        <button v-if="incomplete && !running" class="btn" :disabled="!!pending" @click="command('retry')">{{ pending === 'retry' ? '재시도 준비 중…' : `미확인 ${incomplete}곳 다시 조회` }}</button>
        <button v-if="error" class="btn" :disabled="!!pending" @click="reconnect">연결 다시 확인</button>
        <span v-if="!received && !error" class="muted" role="status">확장프로그램 상태 확인 중…</span>
        <span v-else-if="!state" class="muted">{{ chosenAreas.length }}개 지역 × {{ selectedSites.length }}개 사이트</span>
      </div>
      <p v-if="error" class="notice" role="alert">{{ error }}</p>
      <div v-if="activeState" class="results">
        <div class="result-summary" role="status" aria-live="polite">
          <strong>항목별 확인 결과</strong>
          <span v-if="totals && totals.responses">신규 {{ totals.newCount }}건, 가격 변경 {{ totals.changedCount }}건</span>
        </div>
        <p class="help">순회가 끝나도 해당 지역의 매물이 모두 수집된 것은 아닙니다. 저장 처리 건수에는 같은 매물의 갱신이 포함됩니다. 패널을 접어도 순회는 계속됩니다.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th scope="col">지역과 사이트</th><th scope="col">확인 상태</th><th scope="col">서버 저장 결과</th><th scope="col">확인할 내용</th></tr></thead>
            <tbody>
              <tr v-for="j in activeState.jobs" :key="j.id" :class="j.status">
                <th scope="row">{{ j.areaName }}<small>{{ j.siteName }}</small></th>
                <td>{{ STATUS[j.status] }}</td>
                <td><template v-if="j.receipt">응답 {{ j.receipt.responses }}건<small>매물 저장 처리 {{ j.receipt.listings }}건</small></template><span v-else class="muted">저장 확인 전</span></td>
                <td>{{ j.note }} <a v-if="safeLink(j.url)" :href="safeLink(j.url)!" target="_blank" rel="noopener">직접 열기 ↗</a></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.browse-queue { margin: 14px 0; padding: 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); display: grid; gap: 14px; }
.heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h2 { margin: 0 0 6px; font-size: 18px; }
p { margin: 0; line-height: 1.55; }
.choices { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
fieldset { min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
legend { font-weight: 700; padding: 0 4px; }
legend .muted { font-weight: 400; font-size: 13px; }
.linkish { margin: 0 12px 8px 0; }
.check-list { display: flex; flex-wrap: wrap; gap: 8px 18px; max-height: 190px; overflow-y: auto; }
.check-list label { display: flex; align-items: center; gap: 5px; min-height: 30px; font-size: 14px; }
.check-list input { margin: 0 3px 0 0; }
.check-list .muted { font-size: 12px; }
.help { font-size: 13px; color: var(--muted); }
.notice { padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; color: var(--up); background: var(--surface); }
.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.progress-panel { display: grid; gap: 10px; padding: 16px; border: 2px solid var(--primary, #28425e); border-radius: 10px; background: var(--surface); }
.progress-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.progress-heading strong { font-size: 17px; }
.elapsed { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.current-job { font-weight: 700; }
.current-job span { font-size: 13px; font-weight: 400; color: var(--muted); }
.counters { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 13px; }
.counters b { margin-left: 4px; font-variant-numeric: tabular-nums; }
progress { width: 100%; height: 9px; accent-color: var(--primary, #28425e); }
.uncertain { border-color: var(--up); }
.stale-help { color: var(--up); font-size: 13px; }
.activity { border-top: 1px solid var(--line); padding-top: 8px; }
summary { cursor: pointer; font-weight: 600; font-size: 13px; }
summary .muted { margin-left: 6px; font-weight: 400; }
.activity ol { list-style: none; max-height: 190px; overflow-y: auto; padding: 0; margin: 8px 0 0; }
.activity li { display: flex; align-items: baseline; gap: 12px; padding: 4px 0; font-size: 12px; line-height: 1.5; }
.activity time { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.how-it-works ol { padding-left: 22px; margin: 8px 0; font-size: 13px; line-height: 1.7; }
.results { display: grid; gap: 10px; }
.result-summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; font-size: 14px; }
.table-wrap { max-height: 400px; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; vertical-align: top; padding: 10px; border-bottom: 1px solid var(--line); }
thead th { position: sticky; top: 0; background: var(--surface); white-space: nowrap; }
tbody th { min-width: 120px; }
small { display: block; margin-top: 3px; font-size: 12px; font-weight: 400; color: var(--muted); }
td a { display: inline-block; margin-left: 6px; white-space: nowrap; }
tr.failed td:nth-child(2), tr.needs-input td:nth-child(2), tr.partial td:nth-child(2) { color: var(--up); font-weight: 700; }
tr.running td:nth-child(2) { font-weight: 700; }
button:disabled { cursor: not-allowed; }
@media (max-width: 720px) { .choices { grid-template-columns: 1fr; } .browse-queue { padding: 12px; } table { min-width: 620px; } }
</style>
