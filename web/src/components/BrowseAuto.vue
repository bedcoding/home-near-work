<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Area } from '../../../shared/types';
const props = defineProps<{ areas: Area[]; scopes: Record<string, { name: string; dong: string }[]>; scopesReady: boolean }>();
type RunStatus = 'queued' | 'running' | 'paused' | 'complete' | 'partial' | 'failed' | 'expired';
type AutoSite = 'dabang' | 'zigbang' | 'naver';
const SITES: { id: AutoSite; name: string; scope: string }[] = [
  { id: 'dabang', name: '다방', scope: '지정한 동, 원/투룸, 사이트 필터' },
  { id: 'zigbang', name: '직방', scope: '역 1km, 원룸, 사이트 필터' },
  { id: 'naver', name: '네이버', scope: '구나 동 전체, 저장한 필터' },
];
interface AutoRun { id: string; trigger: 'scheduled' | 'manual'; status: RunStatus; createdAt: number; updatedAt: number; totalJobs: number; completeJobs: number; partialJobs: number; failedJobs: number; stale?: boolean; message?: string }
interface NaverPreset {areaIds:number[];updatedAt:number;summary:string;conditions:{label:string;value:string}[]}
interface AutoState { enabled: boolean; areaIds: number[]; sites: AutoSite[]; zigbangAreaIds: number[];naverAreaIds:number[];naverPreset:NaverPreset|null;naverError:string|null; configuredJobs: number; configError: string | null; schedule: { time: string | null; day: number | null }; last: AutoRun | null }
const STATUS: Record<RunStatus, string> = { queued: '실행 대기', running: '조회 중', paused: '중단됨', complete: '선택 목록 저장 완료', partial: '일부 확인', failed: '실패', expired: '실행 대기 만료' };
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
function readState(input: unknown): AutoState {
  const x = input as AutoState | null;
  if (!x || typeof x !== 'object' || typeof x.enabled !== 'boolean' || !Array.isArray(x.areaIds)
    || !x.areaIds.every((id) => count(id) && id > 0) || !count(x.configuredJobs)
    || !(x.configError === null || typeof x.configError === 'string')
    || !x.schedule || !(x.schedule.time === null || typeof x.schedule.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x.schedule.time))
    || !(x.schedule.day === null || count(x.schedule.day) && x.schedule.day <= 6)) throw new Error('예약 조회 상태를 확인하지 못했습니다.');
  if (x.sites !== undefined && (!Array.isArray(x.sites) || x.enabled && !x.sites.length || x.sites.length > SITES.length
    || new Set(x.sites).size !== x.sites.length || !x.sites.every((site) => SITES.some((candidate) => candidate.id === site)))) throw new Error('예약 사이트를 확인하지 못했습니다.');
  if (x.zigbangAreaIds !== undefined && (!Array.isArray(x.zigbangAreaIds) || !x.zigbangAreaIds.every((id) => count(id) && id > 0))) throw new Error('직방 예약 범위를 확인하지 못했습니다.');
  if(x.naverAreaIds!==undefined && (!Array.isArray(x.naverAreaIds) || !x.naverAreaIds.every(id=>count(id)&&id>0)))throw new Error('네이버 예약 범위를 확인하지 못했습니다.');
  if(x.naverPreset!=null && (!Array.isArray(x.naverPreset.areaIds) || !x.naverPreset.areaIds.every(id=>count(id)&&id>0) || !count(x.naverPreset.updatedAt) || typeof x.naverPreset.summary!=='string' || !Array.isArray(x.naverPreset.conditions)))throw new Error('저장한 네이버 필터를 확인하지 못했습니다.');
  if (x.last !== null && (!x.last || typeof x.last.id !== 'string' || !['scheduled', 'manual'].includes(x.last.trigger)
    || !Object.hasOwn(STATUS, x.last.status)
    || ![x.last.createdAt, x.last.updatedAt, x.last.totalJobs, x.last.completeJobs, x.last.partialJobs, x.last.failedJobs].every(count)
    || x.last.stale !== undefined && typeof x.last.stale !== 'boolean'
    || x.last.message !== undefined && typeof x.last.message !== 'string')) throw new Error('예약 조회 결과를 확인하지 못했습니다.');
  return { ...x, sites: x.sites === undefined ? ['dabang'] : SITES.filter((site) => x.sites.includes(site.id)).map((site) => site.id), zigbangAreaIds: x.zigbangAreaIds ?? [],naverAreaIds:x.naverAreaIds??[],naverPreset:x.naverPreset??null,naverError:x.naverError??null };
}
const state = ref<AutoState | null>(null);
const editing = ref(false), draftEnabled = ref(false), loading = ref(false);
const draftAreaIds = ref<number[]>([]);
const draftSites = ref<AutoSite[]>(['dabang']);
const busy = ref<'save' | 'run' | null>(null);
const loadError = ref<string | null>(null), actionError = ref<string | null>(null), notice = ref<string | null>(null);
const now = ref(Date.now());
let revision = 0, disposed = false;
let poll: number | undefined, refreshController: AbortController | undefined;
const controllers = new Set<AbortController>(), timers = new Set<number>();
const availabilityReady = computed(() => !!state.value && (!draftSites.value.includes('dabang') || props.scopesReady));
const availableAreas = computed(() => props.areas.filter((a) => {
  if(!a.enabled || !draftSites.value.length)return false;
  if(a.region)return draftSites.value.includes('naver') && !!state.value?.naverPreset && state.value.naverAreaIds.includes(a.id);
  return draftSites.value.some(site=>site!=='naver') && (!draftSites.value.includes('dabang') || props.scopesReady && props.scopes[a.id]?.length)
    && (!draftSites.value.includes('zigbang') || state.value?.zigbangAreaIds.includes(a.id));
}));
// 구 수집 지역이 있으면 다방은 일반 자동 확인의 구 전체 수집이 모은다. 예약에서 또 돌면 중복 조회라 새로 고르지 않게 한다.
const dabangByServer = computed(() => props.areas.some((a) => a.enabled && a.purpose !== 'alert' && a.region?.kind === 'gu'));
// 켜진 구, 동이나 지하철역이 있으면 직방은 일반 자동 확인이 서버에서 역 1km 원룸을 모은다. 예약에서 또 돌면 중복이라 새로 고르지 않게 한다.
const zigbangByServer = computed(() => props.areas.some((a) => a.enabled));
const siteOptions = computed(() => SITES.filter((site) => (site.id !== 'dabang' || !dabangByServer.value || draftSites.value.includes('dabang'))
  && (site.id !== 'zigbang' || !zigbangByServer.value || draftSites.value.includes('zigbang'))));
const unavailableAreaIds = computed(() => draftAreaIds.value.filter((id) => !availableAreas.value.some((a) => a.id === id)));
const selectedKnown = computed(() => unavailableAreaIds.value.length === 0);
const unresolved = computed(() => !!state.value?.last && ['queued', 'running', 'paused'].includes(state.value.last.status));
const dirty = computed(() => !!state.value && (draftEnabled.value !== state.value.enabled
  || [...draftAreaIds.value].sort((a, b) => a - b).join(',') !== [...state.value.areaIds].sort((a, b) => a - b).join(',')
  || [...draftSites.value].sort().join(',') !== [...state.value.sites].sort().join(',')));
const canSave = computed(() => !!state.value && !busy.value && dirty.value && draftSites.value.length > 0
  && (!draftEnabled.value || availabilityReady.value && selectedKnown.value && draftAreaIds.value.length > 0));
const canRun = computed(() => !!state.value && !busy.value && !loadError.value && !dirty.value && !state.value.configError && state.value.configuredJobs > 0 && !unresolved.value);
const scheduleText = computed(() => {
  const schedule = state.value?.schedule;
  if (!schedule) return '예약 시각 확인 중';
  if (!schedule.time) return '기존 자동 확인이 꺼져 있습니다';
  return `${schedule.day === null ? '매일' : `매주 ${'일월화수목금토'[schedule.day]}요일`} ${schedule.time}`;
});
function areaScopeText(id: number, sites: AutoSite[]) {
  if(props.areas.find(area=>area.id===id)?.region)return `네이버: 구나 동 전체, ${state.value?.naverPreset ? '저장한 필터' : '필터 저장 필요'}`;
  return sites.filter(site=>site!=='naver').map((site) => site === 'dabang'
    ? `다방: ${props.scopes[id]?.map((r) => r.dong).join(', ') || '동별 범위 확인 필요'}, 원/투룸, 사이트 필터`
    : '직방: 역 1km, 원룸, 사이트 필터').join(' / ');
}
const savedScopeText = computed(() => state.value?.areaIds.map((id) => {
  const area = props.areas.find((a) => a.id === id);
  return area ? `${area.name}: ${areaScopeText(id, state.value!.sites)}` : '지역 설정 확인 필요';
}).join(' / ') ?? '');
const staleRun = computed(() => !!state.value?.last && (state.value.last.stale || state.value.last.status === 'running' && now.value - state.value.last.updatedAt > 120000));
const lastStatusText = computed(() => state.value?.last ? staleRun.value ? '진행 확인 필요' : STATUS[state.value.last.status] : '실행 기록 없음');
const attention = computed(() => staleRun.value || !!state.value?.last && ['paused', 'partial', 'failed', 'expired'].includes(state.value.last.status));
const dateText = (at: number) => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
function syncDraft() { if (state.value) { draftEnabled.value = state.value.enabled; draftAreaIds.value = [...state.value.areaIds]; draftSites.value = [...state.value.sites]; } }
function openSettings() { syncDraft(); editing.value = true; actionError.value = null; notice.value = null; }
function closeSettings() { editing.value = false; syncDraft(); }
async function request(method: string, path: string, controller: AbortController, body?: unknown) {
  controllers.add(controller);
  const timeout = window.setTimeout(() => controller.abort(), 8000); timers.add(timeout);
  try {
    const response = await fetch(path, { method, cache: 'no-store', signal: controller.signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '서버가 예약 조회 요청을 처리하지 못했습니다.');
    return readState(result);
  } finally { window.clearTimeout(timeout); timers.delete(timeout); controllers.delete(controller); }
}
async function refresh() {
  now.value = Date.now();
  if (busy.value || loading.value || disposed) return;
  loading.value = true;
  const version = revision, controller = new AbortController(); refreshController = controller;
  try {
    const result = await request('GET', '/api/browse/auto', controller);
    if (disposed || version !== revision) return;
    state.value = result; loadError.value = null;
    if (!editing.value) syncDraft();
  } catch { if (!disposed && version === revision) loadError.value = '예약 조회 상태를 불러오지 못했습니다. 마지막으로 확인한 내용이며 다시 연결 중입니다.'; }
  finally { if (refreshController === controller) { refreshController = undefined; loading.value = false; } }
}
async function mutate(action: 'save' | 'run') {
  if (action === 'save' ? !canSave.value : !canRun.value) return;
  busy.value = action; revision++; refreshController?.abort(); actionError.value = null; notice.value = null;
  try {
    const result = await request(action === 'save' ? 'PUT' : 'POST', action === 'save' ? '/api/browse/auto' : '/api/browse/auto/run', new AbortController(), action === 'save' ? { enabled: draftEnabled.value, areaIds: [...draftAreaIds.value], sites: [...draftSites.value] } : {});
    if (disposed) return;
    state.value = result; loadError.value = null; syncDraft();
    if (action === 'save') editing.value = false;
    notice.value = action === 'save' ? '예약 조회 설정을 저장했습니다.' : '실행 요청을 등록했습니다. 아래 상태에서 확장의 수신 여부를 확인할 수 있습니다.';
  } catch (error) { if (!disposed) actionError.value = error instanceof Error && error.name !== 'AbortError' ? error.message : '서버 응답을 확인하지 못했습니다. 아래 상태를 갱신해 실행 여부를 확인해 주세요.'; }
  finally { if (!disposed) { busy.value = null; void refresh(); } }
}
onMounted(async () => { poll = window.setInterval(() => void refresh(), 5000); await refresh(); });
onBeforeUnmount(() => { disposed = true; window.clearInterval(poll); for (const c of controllers) c.abort(); for (const t of timers) window.clearTimeout(t); });
</script>

<template>
  <section class="browse-auto" aria-labelledby="browse-auto-title">
    <div class="auto-heading">
      <div class="auto-title"><h3 id="browse-auto-title">브라우저 예약 조회</h3><span v-if="state" class="badge" :class="{ enabled: state.enabled && state.schedule.time }">{{ state.enabled ? state.schedule.time ? '예약 켜짐' : '예약 시각 꺼짐' : '예약 꺼짐' }}</span></div>
      <div class="auto-actions"><button class="btn btn-sm" :disabled="!canRun" @click="mutate('run')">{{ busy === 'run' ? '실행 요청 중…' : '지금 실행' }}</button><button v-if="!editing" class="btn btn-sm" :disabled="!state || !!busy" @click="openSettings">예약 설정</button></div>
    </div>
    <template v-if="state">
      <p class="schedule"><strong>{{ scheduleText }}</strong><span v-if="state.configuredJobs">, 조회 작업 {{ state.configuredJobs }}개</span></p>
      <p v-if="savedScopeText" class="scope-text">{{ savedScopeText }}</p><p v-else class="help">예약 설정에서 조회할 사이트와 지역 범위를 먼저 저장해 주세요.</p>
      <p v-if="!state.schedule.time" class="help">예약으로 실행하려면 설정 탭의 ‘자동 확인’ 시각을 켜 주세요. ‘지금 실행’은 별도로 사용할 수 있습니다.</p>
      <p class="help">다방 구 전체는 일반 자동조회에 포함됩니다. 아래에서는 네이버 구나 동 전체와 기존 역, 동 범위를 예약합니다. 크롬과 이 PC의 대시보드 서버가 켜져 있으면 확장이 전용 탭에서 조회합니다.</p>
      <details v-if="state.naverPreset" class="saved-filter"><summary>저장한 네이버 필터 확인</summary><dl><template v-for="row in state.naverPreset.conditions" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></template></dl></details>
      <p v-else class="help">네이버 예약은 위 순차 조회에서 네이버를 고르고 ‘이 조건과 지역을 예약용으로 저장’을 누른 뒤 설정합니다. 확장 아이콘 메뉴에서도 저장할 수 있습니다.</p>
      <p v-if="state.naverError" class="notice">{{ state.naverError }}</p>
      <p v-if="state.configError && state.areaIds.length" class="notice" role="alert">{{ state.configError }}</p>
      <form v-if="editing" class="auto-settings" @submit.prevent="mutate('save')">
        <label class="check enable-check"><input v-model="draftEnabled" type="checkbox" :disabled="!!busy">기존 자동 확인 시각에 선택한 사이트도 조회</label>
        <fieldset :disabled="!!busy"><legend>조회할 사이트</legend>
          <div class="area-options"><label v-for="site in siteOptions" :key="site.id" class="check"><input v-model="draftSites" type="checkbox" :value="site.id"><span>{{ site.name }}<small>{{ site.scope }}</small></span></label></div>
          <p v-if="!draftSites.length" class="help">사이트를 하나 이상 선택해 주세요.</p>
          <p v-if="draftSites.includes('zigbang')" class="help">직방 예약 조회는 확장 0.8.9 이상이 필요합니다. 역 1km 범위는 지역 설정 반경과 별개입니다.</p>
          <p v-if="draftSites.includes('naver')" class="help">네이버는 저장한 필터를 사용합니다. 구나 동 지역을 선택하세요. 역 반경은 알림용이며 네이버 수집 범위를 제한하지 않습니다.</p>
        </fieldset>
        <fieldset :disabled="!!busy"><legend>예약에 저장할 지역</legend><p v-if="!availabilityReady" class="help">조회 가능한 범위를 불러오는 중입니다.</p><p v-else-if="!draftSites.length" class="help">사이트를 선택하면 조회 가능한 지역을 표시합니다.</p><p v-else-if="!availableAreas.length" class="help">선택한 모든 사이트에서 조회할 수 있는 지역이 없습니다. 다방은 동별 범위, 직방은 역 바로가기 정보가 필요합니다.</p>
          <div v-else class="area-options"><label v-for="area in availableAreas" :key="area.id" class="check"><input v-model="draftAreaIds" type="checkbox" :value="area.id"><span>{{ area.name }}<small>{{ areaScopeText(area.id, draftSites) }}</small></span></label></div>
          <div v-if="availabilityReady && unavailableAreaIds.length" class="area-options"><label v-for="id in unavailableAreaIds" :key="id" class="check"><input v-model="draftAreaIds" type="checkbox" :value="id"><span>사용할 수 없는 지역<small>선택한 사이트의 범위 정보가 없습니다. 선택을 해제하거나 지역 설정을 확인해 주세요.</small></span></label></div>
        </fieldset>
        <p class="help">이 범위는 일회 조회의 선택과 별도로 저장합니다. 예약을 꺼도 이미 시작한 조회는 계속되며, 위 진행 화면에서 중단할 수 있습니다.</p>
        <div class="auto-actions"><button class="btn btn-sm btn-primary" type="submit" :disabled="!canSave">{{ busy === 'save' ? '저장 중…' : '설정 저장' }}</button><button class="btn btn-sm" type="button" :disabled="!!busy" @click="closeSettings">닫기</button></div>
      </form>
      <div class="last-run" :class="{ attention }" aria-live="polite">
        <div class="last-heading"><strong>{{ lastStatusText }}</strong><span v-if="state.last" class="help">{{ state.last.trigger === 'scheduled' ? '예약 실행' : '지금 실행' }}, {{ dateText(state.last.createdAt) }}</span></div>
        <template v-if="state.last">
          <p v-if="staleRun" class="notice">진행 신호가 늦어 현재 실행 여부를 확인하지 못했습니다. 크롬의 조회 탭과 활동 로그를 확인해 주세요.</p><p v-else-if="state.last.message" class="help">{{ state.last.message }}</p><p v-else-if="state.last.status === 'queued'" class="help">크롬 확장이 실행 요청을 받기를 기다립니다.</p>
          <p v-if="state.last.status === 'paused'" class="help">중단된 작업은 위 진행 화면의 ‘이어하기’로 재개할 수 있습니다.</p>
          <p class="result-counts">저장 완료 {{ state.last.completeJobs }} / {{ state.last.totalJobs }}<span v-if="state.last.partialJobs">, 일부 확인 {{ state.last.partialJobs }}</span><span v-if="state.last.failedJobs">, 실패 {{ state.last.failedJobs }}</span></p><p class="help">마지막 진행 확인 {{ dateText(state.last.updatedAt) }}</p>
        </template>
      </div>
    </template>
    <p v-else-if="loading" class="help" role="status">예약 조회 설정을 불러오는 중입니다.</p>
    <div v-if="loadError || actionError" class="notice" role="alert"><p>{{ actionError || loadError }}</p><button class="btn btn-sm" :disabled="loading || !!busy" @click="refresh">상태 다시 확인</button></div>
    <p v-if="notice" class="help" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.browse-auto { display:grid; gap:10px; border:1px solid var(--line); border-radius:10px; padding:18px 20px; background:var(--surface); }
.auto-heading,.auto-title,.auto-actions,.last-heading { display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px; }
.auto-heading { justify-content:space-between; }
h3 { margin:0; font-size:17px; }
p { margin:0; line-height:1.6; }
.badge { padding:3px 8px; border-radius:5px; background:var(--surface-2); color:var(--muted); font-size:12px; font-weight:600; }
.badge.enabled { background:var(--down-soft); color:var(--down); }
.schedule,.scope-text { font-size:14px; }
.scope-text { color:var(--ink-2); overflow-wrap:anywhere; }
.help { font-size:13px; color:var(--muted); }
.saved-filter { font-size:14px; }.saved-filter summary { cursor:pointer; }.saved-filter dl { display:grid;grid-template-columns:130px minmax(0,1fr);gap:8px 16px; }.saved-filter dt { color:var(--muted); }.saved-filter dd { margin:0;overflow-wrap:anywhere; }
.auto-settings { display:grid; gap:12px; margin-top:4px; padding:16px; background:var(--surface-2); border-radius:8px; }
.enable-check { font-weight:600; }
fieldset { min-width:0; border:0; padding:0; margin:0; }
legend { font-size:14px; font-weight:600; margin-bottom:6px; }
.area-options { display:flex; flex-wrap:wrap; gap:8px 24px; }
.check { min-height:44px; }
.check input { accent-color:var(--accent); }
small { display:block; font-weight:400; font-size:12px; color:var(--muted); }
.last-run { display:grid; gap:5px; padding:12px 14px; background:var(--surface-2); border-radius:8px; font-size:14px; }
.last-run.attention { border-left:3px solid var(--up); }
.last-run.attention .last-heading strong { color:var(--up); }
.result-counts { font-size:13px; font-variant-numeric:tabular-nums; }
.notice { display:grid; justify-items:start; gap:8px; color:var(--up); font-size:13px; }
.notice .btn { background:var(--surface); }
@media (max-width:720px) { .browse-auto { padding:16px; } .auto-heading { align-items:flex-start; } }
</style>
