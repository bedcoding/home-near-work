<script setup lang="ts">
import { ref } from 'vue';
import { APT_STATUS_TEXT, type AptRule } from '../apt';
import type { SupportSource } from '../support';

// 조건 정리 칸(살 때 붙는 조건, 물딱지와 현금청산): 접는 칸 하나에 조건 줄(이름, 짧은 요약, 설명, 덧붙임, 근거 링크).
// 서울 아파트 탭과 집터 탭이 같이 쓴다. 펼침은 이 브라우저에 기억한다.

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

const props = defineProps<{
  name: string;
  /** 이름 옆 흐린 글자 */
  count: string;
  /** 제목 줄에 마우스를 올리면 보일 설명 */
  title: string;
  /** 펼치면 맨 위 굵은 한 줄 */
  summary?: string;
  items: RuleItem[];
  /** 맨 아래 '확인할 곳' 링크 */
  links?: { label: string; url: string; title: string }[];
  /** 펼침을 기억하는 localStorage 키, 처음 펼칠지 */
  storageKey: string;
  defaultOpen?: boolean;
}>();

function read(): boolean {
  try {
    const v = localStorage.getItem(props.storageKey);
    return v == null ? !!props.defaultOpen : v === 'true';
  } catch {
    return !!props.defaultOpen;
  }
}
const open = ref(read());
function onToggle(e: Event) {
  open.value = (e.target as HTMLDetailsElement).open;
  try {
    localStorage.setItem(props.storageKey, String(open.value));
  } catch {
    /* 기억만 못 함 */
  }
}
const dot = (date: string) => date.replace(/-/g, '.');
const tone = (status: AptRule['status']) => (status === 'ok' ? 'chip-down' : status === 'news' ? 'chip-seen' : 'chip-warn');
</script>

<template>
  <details class="fold rule-fold" :open="open" @toggle="onToggle">
    <summary :title="title">
      <span class="fold-name">{{ name }}</span>
      <span class="muted fold-count">{{ count }}</span>
    </summary>
    <div class="fold-body">
      <p v-if="summary" class="summary-line">{{ summary }}</p>
      <div class="rule-list">
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
      </div>
      <p v-if="links?.length" class="sources check-links">
        <span class="src-label">확인할 곳</span>
        <a v-for="x in links" :key="x.url" :href="x.url" target="_blank" rel="noopener" :title="x.title">{{ x.label }} ↗</a>
      </p>
    </div>
  </details>
</template>

<style scoped>
.summary-line { margin: 0 0 12px; font-size: 14px; font-weight: 700; line-height: 1.6; }
.rule-list { display: grid; gap: 12px; }
.rule { display: grid; gap: 4px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.rule:last-child { padding-bottom: 0; border-bottom: 0; }
.rule-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.rule-head strong { font-size: 14px; }
.live { font-size: 13px; font-weight: 700; color: var(--accent); }
.rule-head .chip { font-size: 11px; padding: 1px 7px; }
.rule p { margin: 0; font-size: 13px; line-height: 1.65; color: var(--ink-2); }
.notes { margin: 2px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.6; color: var(--muted); }
.sources { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin-top: 2px; font-size: 12px; }
.check-links { margin: 12px 0 0; padding-top: 10px; border-top: 1px solid var(--line); }
.src-label { color: var(--muted); }
.sources a { color: var(--accent); text-decoration: none; }
.sources a:hover { text-decoration: underline; text-underline-offset: 3px; }
.src-date { margin-left: 5px; color: var(--muted); }
</style>
