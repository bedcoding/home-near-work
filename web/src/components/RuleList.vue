<script setup lang="ts">
import { APT_STATUS_TEXT, type AptRule } from '../apt';
import type { SupportSource } from '../support';

// 조건 정리(살 때 붙는 조건, 물딱지와 현금청산): 설명 모달의 탭 안에 조건 줄(이름, 짧은 요약, 설명, 덧붙임, 근거 링크)을 보인다.
// 서울 아파트 탭과 집터 탭이 같이 쓴다.

export interface RuleItem {
  id: string;
  name: string;
  /** 이름 옆 짧은 요약(실거주 조건 등) */
  live?: string;
  text: string;
  notes?: string[];
  status?: AptRule['status'];
  sources: SupportSource[];
}

defineProps<{
  /** 맨 위 흐린 안내(조사 기준, 어디에 확인할지) */
  note?: string;
  /** 맨 위 굵은 한 줄 요약 */
  summary?: string;
  items: RuleItem[];
  /** 맨 아래 '확인할 곳' 링크 */
  links?: { label: string; url: string; title: string }[];
}>();
const dot = (date: string) => date.replace(/-/g, '.');
const tone = (status: AptRule['status']) => (status === 'ok' ? 'chip-down' : status === 'news' ? 'chip-seen' : 'chip-warn');
</script>

<template>
  <div class="rules">
    <p v-if="note" class="note">{{ note }}</p>
    <p v-if="summary" class="summary-line">{{ summary }}</p>
    <article v-for="r in items" :key="r.id" class="rule">
      <div class="rule-head">
        <strong>{{ r.name }}</strong>
        <span v-if="r.live" class="live">{{ r.live }}</span>
        <span v-if="r.status" class="chip" :class="tone(r.status)">{{ APT_STATUS_TEXT[r.status] }}</span>
      </div>
      <p>{{ r.text }}</p>
      <ul v-if="r.notes?.length" class="notes">
        <li v-for="n in r.notes" :key="n">{{ n }}</li>
      </ul>
      <div class="sources">
        <span class="src-label">근거</span>
        <a v-for="s in r.sources" :key="s.url + s.title" :href="s.url" target="_blank" rel="noopener">{{ s.title }}<span v-if="s.date" class="src-date">{{ dot(s.date) }}</span> ↗</a>
      </div>
    </article>
    <p v-if="links?.length" class="sources check-links">
      <span class="src-label">확인할 곳</span>
      <a v-for="x in links" :key="x.url" :href="x.url" target="_blank" rel="noopener" :title="x.title">{{ x.label }} ↗</a>
    </p>
  </div>
</template>

<style scoped>
.rules { display: grid; gap: 18px; }
.note { margin: 0; font-size: 13px; line-height: 1.6; color: var(--muted); }
.summary-line { margin: 0; padding: 12px 14px; border-radius: 10px; background: var(--surface-2); font-size: 15px; font-weight: 700; line-height: 1.65; }
.rule { display: grid; gap: 6px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
.rule:last-of-type { padding-bottom: 0; border-bottom: 0; }
.rule-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.rule-head strong { font-size: 16px; }
.live { font-size: 14px; font-weight: 700; color: var(--accent); }
.rule-head .chip { font-size: 12px; padding: 1px 8px; }
.rule p { margin: 0; font-size: 15px; line-height: 1.7; color: var(--ink-2); }
.notes { display: grid; gap: 2px; margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.65; color: var(--muted); }
.sources { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin: 2px 0 0; font-size: 13px; line-height: 1.6; }
.check-links { padding-top: 14px; border-top: 1px solid var(--line); }
.src-label { color: var(--muted); }
.sources a { color: var(--accent); text-decoration: none; }
.sources a:hover { text-decoration: underline; text-underline-offset: 3px; }
.src-date { margin-left: 5px; color: var(--muted); }
</style>
