<script setup lang="ts">
import { computed } from 'vue';
import { nearReason, type NoticeView } from '../../../shared/types';
import { ago, money, pyeong } from '../format';
import { NOTICE_HOME, NOTICE_SHORT, periodState, periodText } from '../notices';

// 공고 한 줄: 상태(접수 기간) | 종류 | 제목(누르면 원문, 새 공고면 확인 처리)과 지역, 출처 | 숫자(보증금과 평) | 게시일.
// 칸 너비를 정해 두어 줄끼리 같은 자리에 같은 값이 온다. 목록 칸이 좁으면 종류를 제목 아래 줄로 옮긴다.
// 숫자 칸은 목록에 숫자가 있는 공고가 하나라도 있을 때만 모든 줄에 둔다(factsCol).
/**
 * gus: 켜 둔 지역 근처 구. 주면 모집 지역(regions)을 근처 구 먼저 굵게 보인다.
 * names: 켜 둔 지역 바로 근처의 역과 지역 이름. gus와 함께 주면 근처일 가능성이 높은 공고에 '근처' 표시를 붙인다(nearReason).
 */
const props = defineProps<{ notice: NoticeView; factsCol?: boolean; gus?: string[]; names?: string[] }>();
const emit = defineEmits<{ ack: [] }>();

const n = computed(() => props.notice);

/** 상태 칸: 접수 기간을 알면 오늘 기준(접수 예정, 접수중, 마감), 아니면 사이트 상태 글자('접수중 10.02~10.04'는 상태와 기간으로 나눔). */
const status = computed(() => {
  const st = periodState(n.value.period);
  if (st) return { word: st.word, period: periodText(n.value.period!), tone: st.tone };
  const raw = (n.value.status ?? '').trim();
  const m = /^(.*?)\s*(\d{2}\.\d{2}~\d{2}\.\d{2})$/.exec(raw);
  const word = (m ? m[1] : raw).trim();
  const tone = /마감|종료|완료|취소|낙찰|중지/.test(word) ? 'closed' : /예정/.test(word) ? 'soon' : /접수중|모집중|공고중|진행중/.test(word) ? 'open' : '';
  return { word: word || '상태 모름', period: m?.[2] ?? '', tone };
});

/** 게시일 'YYYY-MM-DD' → 올해면 '09.23', 아니면 '24.10.21'. 없으면 처음 본 날. */
const posted = computed(() => {
  const d = n.value.postedAt;
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return { text: ago(n.value.firstSeenAt), title: '처음 본 날' };
  const md = `${d.slice(5, 7)}.${d.slice(8, 10)}`;
  return { text: Number(d.slice(0, 4)) === new Date().getFullYear() ? md : `${d.slice(2, 4)}.${md}`, title: `게시일 ${d.slice(0, 10)}` };
});

/**
 * 모집 지역(구): gus를 받았고 구를 알면 근처 구(near)를 먼저, 나머지는 '외 N곳'. 근처 구가 없으면 첫 구와 '외 N곳'.
 * title은 모집 지역 전체와, 다른 곳 공고에서 가져온 구면 그 출처.
 */
const regions = computed(() => {
  const all = n.value.regions;
  if (!props.gus || !all.length) return null;
  const near = all.filter((r) => props.gus!.includes(r));
  const head = near.length ? [] : [all[0]];
  const rest = all.length - near.length - head.length;
  const from = n.value.regionsFrom ? `, ${NOTICE_SHORT[n.value.regionsFrom]}에 올라온 같은 공고 기준` : '';
  return { near, head: head.join(''), rest, title: `모집 지역 ${all.length}곳(구 단위${from}): ${all.join(', ')}` };
});
/** 근처일 가능성이 높은 까닭(마우스를 올리면 보임). 아니면 null. */
const near = computed(() => (props.gus && props.names ? nearReason(n.value, props.gus, props.names) : null));
/** 지역: 모집 지역(구)을 보이면 쓰지 않고, 제목에 이미 들어 있어도(공매 공고는 제목이 소재지) 다시 쓰지 않는다. */
const place = computed(() => (!regions.value && n.value.place && !n.value.title.includes(n.value.place) ? n.value.place : null));
</script>

<template>
  <li class="notice" :class="{ new: n.isNew, old: !n.current, 'with-facts': factsCol, near: !!near }">
    <div class="status" :class="status.tone">
      <b>{{ status.word }}</b>
      <small class="num">{{ status.period }}</small>
    </div>
    <div class="kind">{{ n.kind ?? '' }}</div>
    <div class="main">
      <a class="title" :href="n.url ?? NOTICE_HOME[n.source]" target="_blank" rel="noopener" @click="n.isNew && emit('ack')">
        <span v-if="near" class="chip chip-near" :title="`켜 둔 지역 근처일 가능성이 높음: ${near}`">근처</span><span v-if="n.isNew" class="chip chip-new">신규</span>{{ n.title }} ↗
      </a>
      <div class="sub muted">
        <span v-if="n.kind" class="kind-sub">{{ n.kind }}</span>
        <span v-if="regions" :title="regions.title">
          <b v-if="regions.near.length" class="near-gu">{{ regions.near.join(', ') }}</b>{{ regions.head }}<template v-if="regions.rest"> 외 {{ regions.rest }}곳</template>
        </span>
        <span v-if="place">{{ place }}</span>
        <span v-if="n.facts?.note">{{ n.facts.note }}</span>
        <span>{{ NOTICE_SHORT[n.source] }}</span>
        <span v-if="!n.current" title="이 공고가 사이트 목록에서 마지막으로 보인 날(상태는 그때 기준)">마지막으로 본 날 {{ ago(n.lastSeenAt) }}</span>
      </div>
    </div>
    <div v-if="factsCol" class="facts">
      <span v-if="n.facts?.amount" class="amount"><small>{{ n.facts.amount.label }}</small> <b class="num">{{ money(n.facts.amount.value) }}</b></span>
      <span v-if="n.facts?.areaM2" class="area num" :title="`전용 ${n.facts.areaM2}㎡`">{{ pyeong(n.facts.areaM2) }}평</span>
    </div>
    <div class="date muted num" :title="posted.title">{{ posted.text }}</div>
  </li>
</template>

<style scoped>
.notice {
  display: grid; grid-template-columns: 104px 120px minmax(0, 1fr) 64px; gap: 4px 14px; align-items: start;
  padding: 10px 0; border-top: 1px solid var(--line);
}
.notice:first-child { border-top: 0; }
.status { display: grid; line-height: 1.3; }
.status b { font-size: 15px; font-weight: 800; color: var(--ink-2); }
.status small { min-height: 1.3em; font-size: 13px; font-weight: 600; color: var(--ink-2); }
.status.open b { color: var(--down); }
.status.soon b { color: var(--accent); }
.status.closed b, .status.closed small { color: var(--muted); font-weight: 600; }
.kind { font-size: 14px; font-weight: 700; color: var(--ink-2); line-height: 1.3; overflow-wrap: anywhere; }
.main { display: grid; gap: 2px; min-width: 0; }
.title { color: var(--ink); text-decoration: none; font-size: 15px; line-height: 1.4; }
.title:hover { text-decoration: underline; }
.title .chip { margin-right: 6px; vertical-align: 1px; }
.notice.new .title { font-weight: 700; }
.sub { display: flex; flex-wrap: wrap; gap: 0 12px; font-size: 13px; }
.date { font-size: 13px; text-align: right; line-height: 1.6; }
.kind-sub { display: none; font-weight: 700; color: var(--ink-2); }
.near-gu { color: var(--accent); }
/* 근처일 가능성이 높은 공고: 옅은 파란 바탕과 왼쪽 띠(글자 줄은 다른 줄과 맞춤). */
.notice.near { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); padding-inline: 10px; margin-inline: -10px; }
.notice.old .title, .notice.old .kind { color: var(--ink-2); }
/* 숫자 칸: 보증금(크게)과 평(작게)을 오른쪽 끝을 맞춰 세로로. */
.notice.with-facts { grid-template-columns: 104px 120px minmax(0, 1fr) 120px 64px; }
.facts { display: grid; justify-items: end; line-height: 1.3; white-space: nowrap; }
.facts .amount b { font-size: 16px; font-weight: 800; }
.facts .amount small { font-size: 12px; font-weight: 600; color: var(--muted); }
.facts .area { font-size: 13px; font-weight: 600; color: var(--ink-2); }
/* 좁으면(지도 옆 목록) 종류 칸을 빼고 제목 아래 줄에 쓴다. 더 좁으면 게시일도 그 아래로. */
@container (max-width: 680px) {
  .notice { grid-template-columns: 92px minmax(0, 1fr) 56px; gap: 4px 12px; }
  .notice.with-facts { grid-template-columns: 92px minmax(0, 1fr) 112px 56px; }
  .kind { display: none; }
  .kind-sub { display: inline; }
}
@container (max-width: 440px) {
  .notice, .notice.with-facts { grid-template-columns: 84px minmax(0, 1fr); }
  .facts { grid-column: 2; justify-items: start; grid-auto-flow: column; justify-content: start; gap: 10px; }
  .date { grid-column: 2; text-align: left; line-height: 1.3; }
}
</style>
