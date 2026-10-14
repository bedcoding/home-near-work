<script setup lang="ts">
import { ref } from 'vue';
import type { NoticeFileView } from '../../../shared/types';
import { ago } from '../format';

// 직접 받은 공고 첨부 파일: 파일마다 근처 줄 수, 파일 이름, 받은 때. 누르면 근처 줄(맞은 이름은 굵게, 위에 표 머리 줄).
// showNotice면 맞춘 공고 제목도 보인다(공고 줄 밖에 따로 보일 때).
defineProps<{ files: NoticeFileView[]; showNotice?: boolean }>();

const open = ref(new Set<number>());
function toggle(id: number) {
  const next = new Set(open.value);
  if (!next.delete(id)) next.add(id);
  open.value = next;
}

/** 근처 동이나 역 이름이 나온 줄이 있으면 '근처 N', 근처 구만 나왔으면 '근처 구 N' */
function chip(f: NoticeFileView): { text: string; tone: string } {
  if (f.status !== 'ok') return { text: '못 읽음', tone: 'bad' };
  if (f.nearCount) return { text: `근처 ${f.nearCount}`, tone: 'near' };
  if (f.guCount) return { text: `근처 구 ${f.guCount}`, tone: 'gu' };
  return { text: '근처 없음', tone: 'none' };
}

function title(f: NoticeFileView): string {
  if (f.status !== 'ok') return f.error ?? '';
  return [
    `읽은 줄 ${f.lineCount}개 중 근처 동이나 역 이름이 나온 줄 ${f.nearCount}개, 근처 구 이름만 나온 줄 ${f.guCount}개`,
    f.byGu.length ? `구별 줄 수: ${f.byGu.slice(0, 10).map((g) => `${g.gu} ${g.count}`).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 줄을 맞은 이름 앞, 이름, 뒤로 나눈다(이름을 굵게 보이려고). */
function parts(text: string, match: string): [string, string, string] {
  const i = text.indexOf(match);
  return i < 0 ? [text, '', ''] : [text.slice(0, i), match, text.slice(i + match.length)];
}
</script>

<template>
  <div class="files">
    <div v-for="f in files" :key="f.id" class="file">
      <button type="button" class="file-head" :disabled="!f.lines.length" :aria-expanded="open.has(f.id)" :title="title(f)" @click="toggle(f.id)">
        <span class="tag" :class="chip(f).tone">{{ chip(f).text }}</span>
        <span class="name">{{ f.name }}</span>
        <span v-if="showNotice" class="notice-title">{{ f.noticeTitle ?? '공고 못 찾음' }}</span>
        <span class="when">{{ ago(f.downloadedAt) }}</span>
        <span v-if="f.lines.length" class="chev" aria-hidden="true">{{ open.has(f.id) ? '▴' : '▾' }}</span>
      </button>
      <ol v-if="open.has(f.id)" class="lines">
        <template v-for="(l, i) in f.lines" :key="i">
          <li v-if="l.header && l.header !== f.lines[i - 1]?.header" class="header">{{ l.header }}</li>
          <li class="line" :class="l.level">{{ parts(l.text, l.match)[0] }}<b>{{ parts(l.text, l.match)[1] }}</b>{{ parts(l.text, l.match)[2] }}</li>
        </template>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.files { display: grid; gap: 4px; margin-top: 4px; }
.file-head {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; width: 100%; padding: 4px 0;
  border: 0; background: transparent; font: inherit; font-size: 13px; color: var(--ink-2); text-align: left; cursor: pointer;
}
.file-head:disabled { cursor: default; }
.file-head:not(:disabled):hover .name { text-decoration: underline; }
.tag { padding: 1px 7px; border-radius: 6px; font-size: 12px; font-weight: 800; white-space: nowrap; }
.tag.near { background: var(--accent); color: #fff; }
.tag.gu { background: var(--accent-soft); color: var(--accent); }
.tag.none { background: var(--surface-2); color: var(--muted); }
.tag.bad { background: var(--up-soft); color: var(--up); }
.name { font-weight: 600; overflow-wrap: anywhere; }
.notice-title { color: var(--ink-2); overflow-wrap: anywhere; }
.when { color: var(--muted); }
.chev { color: var(--muted); }
.lines {
  list-style: none; margin: 2px 0 6px; padding: 8px 10px; display: grid; gap: 3px;
  border-radius: 8px; background: var(--surface-2); font-size: 13px; line-height: 1.45;
}
.header { margin-top: 4px; font-size: 12px; font-weight: 700; color: var(--muted); overflow-wrap: anywhere; }
.header:first-child { margin-top: 0; }
.line { color: var(--ink); overflow-wrap: anywhere; }
.line.gu { color: var(--ink-2); }
.line b { color: var(--accent); }
</style>
