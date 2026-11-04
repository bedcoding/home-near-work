<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { type Area, type AutoCheckState, type RunInfo, type RunProgress } from '../../../shared/types';
import { api } from '../api';
import { dateTime } from '../format';
import { coverageMetrics } from '../../../shared/collection-coverage';
const props = defineProps<{ areas: Area[]; running: RunProgress | null; auto: AutoCheckState | null }>();
const emit = defineEmits<{ start: []; manageAreas: []; history: [] }>();
const last = ref<RunInfo | null>(null);
const error = ref('');
const collectionAreas = computed(() => props.areas.filter(a => a.enabled && a.purpose !== 'alert' && a.region?.kind === 'gu'));
const plannedScopes = computed(() => collectionAreas.value.length * 4);
const live = computed(() => {
  const coverage = props.running?.coverage?.filter(row => row.source === 'dabang' || !row.source && ['one-two', 'house-villa', 'officetel', 'apt'].includes(row.category));
  return coverage?.length && props.running ? { ...props.running, coverage } : null;
});
const current = computed(() => live.value?.coverage?.some(row => !row.storageChecked) ? live.value : null);
const rows = computed(() => live.value?.coverage ?? last.value?.summary?.sources.find(s => s.source === 'dabang')?.coverage ?? []);
const lastSummary = computed(() => last.value?.summary?.sources.find(s => s.source === 'dabang'));
const metrics = computed(() => coverageMetrics(rows.value));
const difference = (row: typeof rows.value[number]) => row.total == null ? null : Math.max(0, row.total - row.received);
const percent = (value: number | null) => value == null ? '비교 불가' : `${value.toFixed(1)}%`;
async function load() {
  try { last.value = (await api.runs()).find(r => r.status !== 'running' && r.summary?.sources.some(s => s.source === 'dabang' && s.coverage)) ?? null; error.value = ''; }
  catch { error.value = '최근 다방 조회 결과를 불러오지 못했습니다.'; }
}
onMounted(load);
watch(() => props.running?.runId, (next, previous) => { if (!next && previous) void load(); });
</script>

<template>
  <section class="dabang-collection management-shell" data-source="dabang" aria-labelledby="dabang-collection-title">
    <div class="heading"><div><h2 id="dabang-collection-title">다방 구 전체 자동수집</h2><p class="muted">원·투룸 · 주택/빌라 · 오피스텔 · 아파트</p></div><button class="btn btn-sm" @click="emit('manageAreas')">수집 지역 관리</button></div>
    <p v-if="collectionAreas.length" class="scope">{{ collectionAreas.map(a => a.name).join(' · ') }} <span class="muted">{{ plannedScopes }}개 조회 범위</span></p>
    <p v-else>수집 지역에서 서울의 구를 하나 이상 선택해 주세요.</p>
    <p class="muted">구 경계 전체를 포함하는 범위의 공개 중개 매물을 마지막 페이지까지 읽습니다. 가격·면적은 제한하지 않으며, 주변 매물도 저장합니다. 알림은 별도로 설정한 역 반경과 가격 조건을 따릅니다.</p>
    <div class="actions"><button class="btn btn-primary" :disabled="!!running || !collectionAreas.length" @click="emit('start')">{{ current ? '다방 수집 중' : '다방 구 전체 수집 시작' }}</button><button class="btn btn-sm" @click="emit('history')">조회 기록·로그</button></div>
    <p class="muted">일반 ‘조회하기’에도 포함됩니다. 예약 자동조회: {{ auto?.time ? `${auto.day == null ? '매일' : ['일','월','화','수','목','금','토'][auto.day] + '요일'} ${auto.time}` : '꺼짐' }} · 실행 시 PC와 대시보드 서버가 켜져 있어야 합니다.</p>
    <p v-if="current" role="status" aria-live="polite">{{ current.message }}</p>
    <template v-if="rows.length">
      <p class="result-title">{{ live ? '이번 조회' : '최근 조회 ' + (last ? dateTime(last.finishedAt ?? last.startedAt) : '') }} · {{ current ? plannedScopes : rows.length }}개 범위{{ current ? ' 조회 중' : ' 조회 결과' }}</p>
      <div class="coverage-metrics" aria-label="페이지 수신과 표시 건수 비교">
        <div><span>페이지 수신</span><strong>{{ metrics.pagesReceived }} / {{ metrics.pagesPlanned ?? '?' }}</strong></div>
        <div><span>표시 건수 대비 수신율</span><strong>{{ current ? '조회 중' : percent(metrics.responsePercent) }}</strong></div>
        <div><span>표시 건수와의 차이</span><strong>{{ current ? '조회 중' : metrics.gap == null ? '비교 불가' : `${metrics.gap.toLocaleString()}건` }}<small v-if="!current && metrics.gapPercent != null">{{ percent(metrics.gapPercent) }}</small></strong></div>
      </div>
      <p v-if="!current && metrics.displayed != null" class="muted">구·유형별 합계: 표시 {{ metrics.displayed.toLocaleString() }}건 / 실제 응답 {{ metrics.received.toLocaleString() }}건. 같은 매물이 중복될 수 있으며, 차이는 고유 매물의 누락 개수가 아닙니다.</p>
      <p v-if="!live && lastSummary" class="result-title">중복 제거 후 서버 저장 {{ lastSummary.kept.toLocaleString() }}건<span v-if="lastSummary.incidentalCount" class="muted"> · 주변·지역 미확인 {{ lastSummary.incidentalCount.toLocaleString() }}건 포함</span></p>
      <p class="mobile-table-hint muted">표를 좌우로 밀면 서버 저장 건수와 확인 상태를 볼 수 있습니다.</p>
      <div class="table-scroll"><table><thead><tr><th>범위·유형</th><th>페이지</th><th>일반 목록 / 표시 총건수</th><th>차이</th><th>서버 저장</th><th>상태</th></tr></thead><tbody>
        <tr v-for="row in rows" :key="`${row.areaId}-${row.category}`"><td>{{ row.areaName }} · {{ row.label }}</td><td>{{ row.pages }} / {{ row.totalPages ?? '?' }}</td><td>{{ row.received }} / {{ row.total ?? '?' }}건</td><td>{{ current ? '조회 중' : difference(row) == null ? '?' : `${difference(row)}건` }}<small v-if="!current && row.total != null && row.total > 0">{{ percent(difference(row)! / row.total * 100) }}</small></td><td>{{ current ? '수집 후 확인' : `${row.stored}건` }}</td><td><span :class="{ warning: !row.complete && (!current || !row.reason.startsWith('목록 조회 중') && row.pages > 0) }">{{ row.complete ? current ? '목록 확인' : '전체 확인' : current && row.reason.startsWith('목록 조회 중') ? '조회 중' : current && !row.pages ? '대기' : '일부 확인' }}</span><small>{{ row.reason }}</small></td></tr>
      </tbody></table></div>
      <p class="muted">표시 총건수와 받은 매물 수가 다르거나 읽지 못한 페이지가 있으면 ‘일부 확인’으로 남깁니다. 받은 매물은 저장하며, 확인되지 않은 매물을 즉시 사라짐으로 처리하지 않습니다.</p>
      <p class="muted">서버 저장은 광고 매물을 포함하며, 구·유형이 겹치는 같은 매물은 하나로 저장합니다.</p>
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.dabang-collection { display:grid; gap:14px; padding:24px; margin-bottom:20px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); }
.coverage-metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; }
.coverage-metrics > div { display:grid; gap:6px; padding:14px 16px; border:1px solid var(--line); border-radius:8px; background:var(--surface-2); }
.coverage-metrics span { color:var(--ink-2); font-size:13px; } .coverage-metrics strong { font-size:22px; font-variant-numeric:tabular-nums; } .coverage-metrics strong small { display:inline; margin-left:10px; font-size:14px; font-weight:500; }
.heading,.actions { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; }
.actions { justify-content:flex-start; } h2 { margin:0 0 8px; font-size:22px; } p { margin:0; line-height:1.6; } .scope,.result-title { font-weight:600; } .scope span { margin-left:8px; font-weight:400; } .muted { font-size:14px; } .table-scroll { overflow-x:auto; } table { width:100%; min-width:820px; border-collapse:collapse; font-size:14px; } th,td { text-align:left; padding:12px; border-bottom:1px solid var(--line); } th { color:var(--ink-2); background:var(--surface-2); white-space:nowrap; } td { vertical-align:top; } td:last-child { min-width:220px; } small { display:block; margin-top:4px; color:var(--muted); } .warning { color:var(--up); } .mobile-table-hint { display:none; }
@media (max-width:720px) { .mobile-table-hint { display:block; } }
</style>
