<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { RUN_SCOPES, SOURCE_LABEL, type RunDetail, type RunInfo, type RunScope } from '../../../shared/types';
import { api } from '../api';
import { dateTime } from '../format';

/** 탭 하나만 돈 조회의 범위 이름 */
const scopeLabel = (scope: RunScope) => RUN_SCOPES.find((s) => s.id === scope)?.label ?? scope;

const props = defineProps<{ refreshKey: number }>();
const runs = ref<RunInfo[]>([]);
const detail = ref<RunDetail | null>(null);

async function load() {
  runs.value = await api.runs();
}
async function open(run: RunInfo) {
  detail.value = await api.run(run.id);
}

onMounted(load);
watch(() => props.refreshKey, load);

const statusText: Record<RunInfo['status'], string> = { running: '조회 중', done: '완료', error: '실패', stopped: '중단' };
const kindText: Record<'page' | 'data' | 'action', string> = { page: '페이지', data: '데이터', action: '화면 조작' };
</script>

<template>
  <section class="runs">
    <h2 title="조회마다 들른 페이지, 받은 건수, 그때 화면 스크린샷이 남습니다">조회 기록</h2>
    <table class="list">
      <thead>
        <tr><th>번호</th><th>시작</th><th>상태</th><th>방식</th><th>사이트별 결과</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="run in runs" :key="run.id">
          <td class="num tight">#{{ run.id }}</td>
          <td class="num tight">{{ dateTime(run.startedAt) }}</td>
          <td class="words">{{ statusText[run.status] }}<span v-if="run.error" class="muted">, {{ run.error }}</span></td>
          <td class="tight">{{ run.auto ? '자동, ' : '' }}{{ run.noticesOnly ? '공고만, ' : '' }}{{ run.scope ? `${scopeLabel(run.scope)}만, ` : '' }}{{ run.visible ? '보면서' : '조용히' }}</td>
          <td class="words">
            <div v-for="s in run.summary?.sources ?? []" :key="s.source" class="src">
              <strong>{{ SOURCE_LABEL[s.source] }}</strong>
              <template v-if="s.status === 'ok'">
                지역 안 {{ s.kept }}건, 신규 {{ s.newCount }}, 가격 변동 {{ s.priceChanged }}<span v-if="s.relisted">, 재등록 숨김 {{ s.relisted }}</span>
                <span v-if="s.baselineAreas.length" class="muted">, 기준점: {{ s.baselineAreas.join(', ') }}</span>
              </template>
              <span v-else class="err">실패: {{ s.error }}</span>
            </div>
          </td>
          <td><button class="btn btn-sm" @click="open(run)">자세히</button></td>
        </tr>
      </tbody>
    </table>

    <div v-if="detail" class="overlay" @click.self="detail = null">
      <div class="dialog">
        <div class="dialog-head">
          <h3>조회 #{{ detail.id }}, {{ dateTime(detail.startedAt) }}</h3>
          <button class="btn btn-sm" @click="detail = null">닫기</button>
        </div>
        <h4>그때 화면</h4>
        <div class="shots">
          <a v-for="shot in detail.screenshots" :key="shot.file" :href="shot.file" target="_blank" rel="noopener">
            <img :src="shot.file" :alt="shot.label" loading="lazy" />
            <span>{{ SOURCE_LABEL[shot.source as keyof typeof SOURCE_LABEL] ?? shot.source }}: {{ shot.label }}</span>
          </a>
          <p v-if="!detail.screenshots.length" class="muted">스크린샷이 없습니다.</p>
        </div>
        <h4>기록</h4>
        <pre class="log">{{ detail.log.join('\n') }}</pre>

        <details>
          <summary>요청 기록 {{ detail.requests.length }}건 <span class="muted">(연 페이지, 읽은 데이터, 화면 조작을 순서대로)</span></summary>
          <table class="req">
            <thead><tr><th>시각</th><th>사이트</th><th>종류</th><th>내용</th><th>주소</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in detail.requests" :key="i">
                <td class="num">{{ new Date(r.at).toLocaleTimeString('ko-KR', { hour12: false }) }}</td>
                <td>{{ SOURCE_LABEL[r.source as keyof typeof SOURCE_LABEL] ?? r.source }}</td>
                <td>{{ kindText[r.kind] }}<span v-if="r.status" class="muted"> {{ r.status }}</span></td>
                <td>{{ r.note ?? '' }}</td>
                <td class="url"><a :href="r.url" target="_blank" rel="noopener">{{ r.url }}</a></td>
              </tr>
            </tbody>
          </table>
        </details>

        <details>
          <summary>반경 밖이라 뺀 매물 {{ detail.excluded.length }}건 <span class="muted">(지역 반경 + 500m 밖, 가까운 순)</span></summary>
          <table class="req">
            <thead><tr><th>사이트</th><th>가격</th><th>제목과 주소</th><th>가장 가까운 지역까지</th></tr></thead>
            <tbody>
              <tr v-for="x in detail.excluded" :key="x.source + x.sourceId">
                <td>{{ SOURCE_LABEL[x.source as keyof typeof SOURCE_LABEL] ?? x.source }}</td>
                <td>{{ x.priceText }}</td>
                <td><a :href="x.url" target="_blank" rel="noopener">{{ x.title || '제목 없음' }}</a> <span class="muted">{{ x.address ?? '' }}</span></td>
                <td class="num">{{ x.areaName ?? '?' }} {{ x.distanceM != null ? `${x.distanceM}m` : '좌표 없음' }}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </div>
    </div>
  </section>
</template>

<style scoped>
.runs { display: grid; gap: 12px; }
h2 { margin: 0; font-size: 18px; }
p { margin: 0; }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
th, td { padding: 10px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); font-size: 14px; }
th { background: var(--surface-2); font-size: 13px; color: var(--ink-2); }
/* 조회 목록: 칸 이름과 번호, 시각, 방식은 줄을 바꾸지 않고, 글은 낱말 단위로 바꾸되 띄어쓰기 없는 긴 글자(오류 속 주소 등)는 아무 데서나 끊어 표가 넓어지지 않게 한다. */
.list thead th, .list .tight { white-space: nowrap; }
.list .words { word-break: keep-all; overflow-wrap: anywhere; }
.list td:nth-child(3) { min-width: 64px; }
.src { margin-bottom: 2px; }
.err { color: var(--new); }
.overlay { position: fixed; inset: 0; background: rgba(22, 32, 46, .45); display: grid; place-items: center; padding: 24px; z-index: 50; }
.dialog { background: var(--surface); border-radius: 12px; width: min(1100px, 100%); max-height: 90vh; overflow: auto; padding: 20px; display: grid; gap: 10px; }
.dialog-head { display: flex; align-items: center; justify-content: space-between; }
h3, h4 { margin: 0; }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.shots a { display: grid; gap: 4px; color: var(--ink-2); text-decoration: none; font-size: 13px; }
.shots img { width: 100%; aspect-ratio: 1280 / 860; object-fit: cover; border: 1px solid var(--line); border-radius: 8px; }
.log { margin: 0; padding: 12px; background: var(--ink); color: #e8edf3; border-radius: 8px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; max-height: 360px; overflow: auto; }
summary { cursor: pointer; font-weight: 600; padding: 6px 0; }
.req { margin-top: 6px; border: 1px solid var(--line); }
.req td, .req th { font-size: 13px; padding: 6px 8px; }
.url { max-width: 380px; overflow-wrap: anywhere; font-size: 12px; }
</style>
