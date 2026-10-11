<script setup lang="ts">
import { computed } from 'vue';
import { money } from '../../../shared/format';
import type { NoticeView } from '../../../shared/types';
import { monthDay, NOTICE_HOME, NOTICE_SHORT, periodState, periodText } from '../notices';

// 청약 공고 한 줄: 상태(접수 기간) | 종류 | 단지 이름(누르면 모집공고문)과 위치, 세대수, 시공사, 출처 | 공급금액과 입주 | 당첨 발표.
// 칸 너비를 정해 두어 줄끼리 같은 자리에 같은 값이 온다. 목록 칸이 좁으면 종류를 이름 아래 줄로 옮긴다.
const props = defineProps<{ notice: NoticeView }>();
const emit = defineEmits<{ ack: [] }>();

const n = computed(() => props.notice);
const d = computed(() => n.value.detail);

/** 접수 기간을 알면 오늘 기준 상태, 모르면 사이트 상태 글자 */
const status = computed(() => {
  const st = periodState(n.value.period);
  if (st) return { word: st.word, period: periodText(n.value.period!), when: st.when, tone: st.tone };
  const word = (n.value.status ?? '').trim();
  return { word: word || '기간 모름', period: '', when: '', tone: /마감|종료|완료/.test(word) ? 'closed' : '' };
});

/** 공급금액(주택형별 최고가 기준)의 가장 낮은 값~높은 값 */
const price = computed(() => {
  const x = d.value;
  if (!x?.priceMin || !x.priceMax) return null;
  return x.priceMin === x.priceMax ? money(x.priceMin) : `${money(x.priceMin)} ~ ${money(x.priceMax)}`;
});

const facts = computed(() => {
  const x = d.value;
  return [
    n.value.place,
    x?.households ? `${x.households.toLocaleString('ko-KR')}세대` : null,
    x?.builder,
    NOTICE_SHORT[n.value.source],
  ].filter((v): v is string => !!v);
});
</script>

<template>
  <li class="sub-row" :class="{ new: n.isNew, past: status.tone === 'closed' }">
    <div class="status" :class="status.tone">
      <b>{{ status.word }}</b>
      <small class="num">{{ status.period }}</small>
      <small v-if="status.when" class="when">{{ status.when }}</small>
    </div>
    <div class="kind">{{ n.kind ?? '' }}</div>
    <div class="main">
      <a
        class="title" :href="n.url ?? NOTICE_HOME[n.source]" target="_blank" rel="noopener"
        :title="n.url ? '모집공고문을 엽니다' : '공고 목록을 엽니다'" @click="n.isNew && emit('ack')"
      >
        <span v-if="n.isNew" class="chip chip-new">신규</span>{{ n.title }} ↗
      </a>
      <div class="sub muted">
        <span v-if="n.kind" class="kind-sub">{{ n.kind }}</span>
        <span v-for="f in facts" :key="f">{{ f }}</span>
      </div>
    </div>
    <div class="price num" :title="price ? '주택형별 공급금액(최고가 기준)의 가장 낮은 값 ~ 높은 값' : undefined">
      <b v-if="price">{{ price }}</b>
      <small v-else-if="d">공고문 참조</small>
      <small>{{ d?.moveIn ? `입주 ${d.moveIn}` : '' }}</small>
    </div>
    <div class="winners muted num">
      <template v-if="d?.winnersAt">발표 {{ monthDay(d.winnersAt) }}</template>
    </div>
  </li>
</template>

<style scoped>
.sub-row {
  display: grid; grid-template-columns: 96px 112px minmax(0, 1fr) 170px 72px; gap: 4px 14px; align-items: start;
  padding: 10px 0; border-top: 1px solid var(--line);
}
.sub-row:first-child { border-top: 0; }
.status { display: grid; line-height: 1.3; }
.status b { font-size: 15px; font-weight: 800; color: var(--ink-2); }
.status small { font-size: 13px; font-weight: 600; color: var(--ink-2); }
.status .when { color: var(--accent); }
.status.open b, .status.open .when { color: var(--down); }
.status.soon b { color: var(--accent); }
.status.closed b, .status.closed small { color: var(--muted); font-weight: 600; }
.kind { font-size: 14px; font-weight: 700; color: var(--ink-2); line-height: 1.3; overflow-wrap: anywhere; }
.main { display: grid; gap: 2px; min-width: 0; }
.title { color: var(--ink); text-decoration: none; font-size: 15px; font-weight: 700; line-height: 1.4; }
.title:hover { text-decoration: underline; }
.title .chip { margin-right: 6px; vertical-align: 1px; }
.sub { display: flex; flex-wrap: wrap; gap: 0 12px; font-size: 13px; }
.kind-sub { display: none; font-weight: 700; color: var(--ink-2); }
.price { display: grid; line-height: 1.3; text-align: right; }
.price b { font-size: 16px; font-weight: 800; white-space: nowrap; }
.price small { font-size: 12px; color: var(--muted); }
.winners { font-size: 13px; text-align: right; line-height: 1.6; }
.sub-row.past .title { color: var(--ink-2); font-weight: 600; }
/* 좁으면 종류 칸을 빼고 이름 아래 줄에 쓴다. 더 좁으면 금액과 발표도 아래로. */
@container (max-width: 760px) {
  .sub-row { grid-template-columns: 92px minmax(0, 1fr) 150px; gap: 4px 12px; }
  .kind { display: none; }
  .kind-sub { display: inline; }
  .winners { grid-column: 3; }
}
@container (max-width: 480px) {
  .sub-row { grid-template-columns: 84px minmax(0, 1fr); }
  .price, .winners { grid-column: 2; text-align: left; }
}
</style>
