<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { FRAUD_CASES, FRAUD_CHECKED, FRAUD_GROUPS, FRAUD_TOOLS, type FraudGroup } from '../frauds';

// 사기 사례 탭: 부동산 사기 수법을 카드로 보인다(수법, 실제 사례, 서류에서 보이는 곳, 당하면 생기는 일, 근거 링크).
// 위에 확인 도구 링크, 거르기(매매, 임대, 분양과 조합, 토지, 경매, 투자, 서류로 못 잡는 것)와 검색어. 고른 거르기는 이 브라우저에 기억한다.

type Pick = FraudGroup | 'all' | 'blind';
const KEY = 'hnw-fraud-group';
function load(): Pick {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'all' || v === 'blind' || FRAUD_GROUPS.some((g) => g.id === v) ? (v as Pick) : 'all';
  } catch {
    return 'all';
  }
}
const pick = ref<Pick>(load());
watch(pick, (v) => {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* 기억만 못 함 */
  }
});
const query = ref('');

const inPick = (c: (typeof FRAUD_CASES)[number], p: Pick) => p === 'all' || (p === 'blind' ? !!c.blind : c.groups.includes(p));
const countOf = (p: Pick) => FRAUD_CASES.filter((c) => inPick(c, p)).length;
const shown = computed(() => {
  const words = query.value.trim().split(/\s+/).filter(Boolean);
  return FRAUD_CASES.filter((c) => {
    if (!inPick(c, pick.value)) return false;
    if (!words.length) return true;
    const text = [c.name, c.how, c.cases, c.check, c.result, ...c.docs].join(' ');
    return words.every((w) => text.includes(w));
  });
});
const groupName = (id: FraudGroup) => FRAUD_GROUPS.find((g) => g.id === id)?.name ?? id;
const dot = (iso: string) => iso.replace(/-/g, '.');
</script>

<template>
  <section class="fraud">
    <div class="fraud-head">
      <h2 class="fraud-title">사기 사례 <span class="muted num">{{ FRAUD_CASES.length }}가지</span></h2>
      <span class="muted checked" title="판결, 법령, 공공기관 안내, 언론 보도를 이날 기준으로 확인해 손으로 정리했습니다. 법률 판단은 원문과 전문가로 확인하세요.">{{ dot(FRAUD_CHECKED) }} 확인</span>
    </div>
    <nav class="tools" aria-label="확인 도구">
      <a v-for="t in FRAUD_TOOLS" :key="t.url" :href="t.url" target="_blank" rel="noopener" :title="t.title">{{ t.label }} ↗</a>
    </nav>
    <div class="bar">
      <div class="picks" role="group" aria-label="사기 사례 거르기">
        <button type="button" :aria-pressed="pick === 'all'" @click="pick = 'all'">전체 <span class="num">{{ countOf('all') }}</span></button>
        <button v-for="g in FRAUD_GROUPS" :key="g.id" type="button" :aria-pressed="pick === g.id" @click="pick = g.id">{{ g.name }} <span class="num">{{ countOf(g.id) }}</span></button>
        <button type="button" :aria-pressed="pick === 'blind'" title="계약 당일 서류만으로는 못 잡는 수법(잔금 직전 재확인, 특약, 현장 확인이 필요)" @click="pick = 'blind'">
          서류로 못 잡음 <span class="num">{{ countOf('blind') }}</span>
        </button>
      </div>
      <label class="search">
        <span class="sr-only">검색어</span>
        <input v-model="query" type="search" placeholder="검색어(근저당, 신탁 등)" />
      </label>
    </div>
    <p v-if="!shown.length" class="muted empty">맞는 사례가 없습니다</p>
    <div class="cards">
      <article v-for="c in shown" :key="c.id" class="case">
        <h3 class="case-name">{{ c.name }}</h3>
        <div class="case-tags">
          <span v-for="g in c.groups" :key="g" class="chip chip-muted">{{ groupName(g) }}</span>
          <span v-for="d in c.docs" :key="d" class="chip doc">{{ d }}</span>
          <span v-if="c.blind" class="chip chip-warn" title="계약 당일 서류만으로는 못 잡습니다">{{ c.blind }}</span>
        </div>
        <dl class="case-body">
          <dt>수법</dt><dd>{{ c.how }}</dd>
          <dt>실제 사례</dt><dd>{{ c.cases }}</dd>
          <dt>확인할 곳</dt><dd class="check">{{ c.check }}</dd>
          <dt>당하면</dt><dd class="result">{{ c.result }}</dd>
        </dl>
        <div class="case-src">
          <a v-for="s in c.sources" :key="s.url + s.title" :href="s.url" target="_blank" rel="noopener">{{ s.title }}<span v-if="s.date" class="src-date">{{ dot(s.date) }}</span> ↗</a>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.fraud { display: grid; gap: 12px; min-width: 0; }
.fraud-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
.fraud-title { margin: 0; font-size: 21px; font-weight: 700; }
.fraud-title .muted { font-size: 14px; font-weight: 500; }
.checked { font-size: 13px; cursor: help; }
.tools { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; }
.tools a { color: var(--accent); text-decoration: none; }
.tools a:hover { text-decoration: underline; text-underline-offset: 3px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.picks { display: flex; flex-wrap: wrap; gap: 4px; }
.picks button {
  min-height: 34px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface);
  font-size: 13px; font-weight: 700; color: var(--ink-2);
}
.picks button .num { margin-left: 2px; font-weight: 500; color: var(--muted); }
.picks button[aria-pressed='true'] { background: var(--ink); border-color: var(--ink); color: #fff; }
.picks button[aria-pressed='true'] .num { color: #cfdef1; }
.search { margin-left: auto; }
.search input {
  width: 220px; max-width: 100%; min-height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface); color: var(--ink-2); font-size: 13px;
}
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.empty { margin: 0; font-size: 13px; }
.cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); }
.case {
  display: grid; align-content: start; gap: 8px; min-width: 0; padding: 12px 14px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
}
.case-name { margin: 0; font-size: 16px; }
.case-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.case-tags .chip { font-size: 11px; padding: 1px 7px; }
.doc { background: var(--accent-soft); color: var(--accent); }
.case-body { display: grid; gap: 4px; margin: 0; font-size: 13px; line-height: 1.6; }
.case-body dt { margin-top: 2px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: var(--muted); }
.case-body dd { margin: 0; color: var(--ink-2); }
.case-body .check { padding: 5px 9px; border-left: 3px solid var(--down); border-radius: 0 4px 4px 0; background: var(--down-soft); color: var(--ink); }
.case-body .result { padding-left: 9px; border-left: 3px solid var(--new); }
.case-src { display: flex; flex-wrap: wrap; gap: 2px 12px; padding-top: 6px; border-top: 1px dashed var(--line); font-size: 12px; }
.case-src a { color: var(--accent); text-decoration: none; }
.case-src a:hover { text-decoration: underline; text-underline-offset: 3px; }
.src-date { margin-left: 5px; color: var(--muted); }
</style>
