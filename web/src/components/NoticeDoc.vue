<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TrustDocView } from '../../../shared/types';
import { manwon } from '../format';
import { todayIso } from '../notices';

// 신탁 공매 공고 줄 아래 공고문 칸: '공고문 8차'를 누르면 차수별 입찰일, 개찰일, 최저가 표(다음 입찰 차수는 굵게, 지난 차수는 흐리게).
// 받거나 읽지 못했으면 짧은 이름표만, 까닭은 마우스를 올리면 보인다. 그림 공고문을 글자 인식으로 읽었으면 '글자 인식' 이름표.
// link면 공고문 파일 링크를 둔다(공고 제목 링크와 다를 때).
const props = defineProps<{ doc: TrustDocView; link?: boolean }>();

const open = ref(false);
const today = todayIso();
const md = (iso: string | null) => (iso ? `${iso.slice(5, 7)}.${iso.slice(8, 10)}` : '');
/** 오늘이나 그 뒤 첫 입찰 차수 */
const next = computed(() => props.doc.rounds.find((r) => r.bid != null && r.bid >= today) ?? null);
const problem = computed(() =>
  props.doc.error
    ? { text: '공고문 못 읽음', title: props.doc.error }
    : props.doc.lines === 0
      ? { text: '공고문 글자 없음', title: '그림으로 된 공고문이라 글자를 읽지 못했습니다' }
      : !props.doc.rounds.length
        ? { text: '공고문 차수 표 없음', title: '공고문에서 차수별 입찰일과 최저가 표를 찾지 못했습니다' }
        : null,
);
</script>

<template>
  <div class="doc">
    <div class="doc-head">
      <button
        v-if="!problem" type="button" class="doc-toggle" :aria-expanded="open" :title="`${doc.name}: 차수별 입찰일과 최저가`"
        @click="open = !open"
      >
        <span class="tag">공고문 {{ doc.rounds.length }}차</span><span class="chev" aria-hidden="true">{{ open ? '▴' : '▾' }}</span>
      </button>
      <span v-else class="tag bad" :title="problem.title">{{ problem.text }}</span>
      <span v-if="doc.ocr" class="tag bad" title="그림으로 된 공고문을 글자 인식으로 읽었습니다. 숫자와 날짜가 틀릴 수 있습니다">글자 인식</span>
      <a v-if="link && doc.url" class="file" :href="doc.url" target="_blank" rel="noopener" :title="doc.name">파일 ↗</a>
    </div>
    <table v-if="open && !problem" class="rounds">
      <thead>
        <tr><th scope="col">차수</th><th scope="col">입찰</th><th scope="col">개찰</th><th scope="col" class="r">최저가</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in doc.rounds" :key="r.no" :class="{ next: r === next, past: r.bid != null && r.bid < today }">
          <th scope="row">{{ r.no }}차</th>
          <td class="num">{{ md(r.bid) }}</td>
          <td class="num">{{ md(r.open) }}</td>
          <td class="num r">{{ r.price != null ? manwon(r.price) : '' }}<small v-if="r.count > 1" class="muted"> {{ r.count }}건 중 최저</small></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.doc { display: grid; gap: 4px; margin-top: 4px; }
.doc-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 13px; }
.doc-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 2px 0; border: 0; background: transparent; font: inherit; cursor: pointer; }
.doc-toggle:hover .tag { text-decoration: underline; }
.tag { padding: 1px 7px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 800; white-space: nowrap; }
.tag.bad { background: var(--surface-2); color: var(--muted); }
.chev { color: var(--muted); }
.file { color: var(--ink-2); text-decoration: none; }
.file:hover { text-decoration: underline; }
/* 차수 표: 날짜와 금액은 칸마다 같은 자리(금액은 오른쪽 맞춤) */
.rounds {
  justify-self: start; border-collapse: separate; border-spacing: 0; margin: 2px 0 6px;
  border-radius: 8px; background: var(--surface-2); font-size: 13px;
}
.rounds th, .rounds td { padding: 4px 12px; text-align: left; white-space: nowrap; }
.rounds thead th { font-size: 12px; font-weight: 700; color: var(--muted); }
.rounds tbody th { font-weight: 700; color: var(--ink-2); }
.rounds .r { text-align: right; }
.rounds tr.past th, .rounds tr.past td { color: var(--muted); }
.rounds tr.next th, .rounds tr.next td { font-weight: 800; color: var(--ink); }
</style>
