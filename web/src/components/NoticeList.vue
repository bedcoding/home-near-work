<script setup lang="ts">
import { computed } from 'vue';
import type { NoticeFileView, NoticeView } from '../../../shared/types';
import NoticeRow from './NoticeRow.vue';

// 공고 목록: 지금 사이트 목록에 올라와 있는 공고, 그 아래 목록에서 내려간 공고('예전 공고', 접어 둠).
const props = defineProps<{
  /** 새 공고 먼저, 게시일 최신 순 */
  notices: NoticeView[];
  /** 켜 둔 지역 근처 구. 주면 줄마다 모집 지역을 근처 구 먼저 보인다(임대 공고). */
  gus?: string[];
  /** 켜 둔 지역 바로 근처의 역과 지역 이름. 주면 근처일 가능성이 높은 공고에 '근처' 표시를 붙인다. */
  names?: string[];
  /** 공고 번호마다 직접 받은 첨부 파일을 읽은 결과 */
  files?: Map<number, NoticeFileView[]>;
  /** 목록 테두리 없이 그린다(카드 안에 넣을 때) */
  bare?: boolean;
}>();
const emit = defineEmits<{ ack: [ids: number[]] }>();

const now = computed(() => props.notices.filter((n) => n.current));
const old = computed(() => props.notices.filter((n) => !n.current));
/** 보증금 같은 숫자가 있는 공고(든든전세 집)가 있으면 모든 줄에 숫자 칸을 둔다. */
const factsCol = computed(() => props.notices.some((n) => n.facts && (n.facts.amount || n.facts.areaM2 || n.facts.note)));
</script>

<template>
  <div class="notice-list" :class="{ bare }">
    <ul v-if="now.length" class="rows">
      <NoticeRow v-for="n in now" :key="n.id" :notice="n" :facts-col="factsCol" :gus="gus" :names="names" :files="files?.get(n.id)" @ack="emit('ack', [n.id])" />
    </ul>
    <details v-if="old.length" class="old">
      <summary title="사이트 목록에서 내려간 공고입니다(마감됐거나 목록에서 밀려남). 상태는 마지막으로 본 때 기준입니다.">예전 공고 {{ old.length }}건</summary>
      <ul class="rows">
        <NoticeRow v-for="n in old" :key="n.id" :notice="n" :facts-col="factsCol" :gus="gus" :names="names" :files="files?.get(n.id)" @ack="emit('ack', [n.id])" />
      </ul>
    </details>
  </div>
</template>

<style scoped>
.notice-list { display: grid; gap: 10px; }
.rows {
  list-style: none; margin: 0; padding: 4px 14px; container-type: inline-size;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
}
.bare .rows { padding: 0; border: 0; border-radius: 0; background: none; }
.old summary { cursor: pointer; padding: 8px 0; font-weight: 700; color: var(--muted); }
.old[open] summary { margin-bottom: 8px; }
</style>
