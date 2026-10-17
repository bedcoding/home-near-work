<script setup lang="ts">
import { SUPPORT_SECTIONS, type SupportSectionId, type SupportStep } from '../support';

// 지원 제도 탭의 순서 목록('대출 받는 순서', '보험 되는지 먼저 확인하는 순서'). 순서가 중요해서 단계를 위에서 아래로 한 줄씩 보이고 번호 사이를 세로 선으로 잇는다.
// 맨 바깥 클래스는 SupportView의 '.steps'(탭 맨 위 네 칸)와 겹치지 않게 timeline으로 둔다(부모의 scoped 스타일이 자식 맨 바깥 요소에도 걸림).

defineProps<{ steps: SupportStep[] }>();
const emit = defineEmits<{ section: [id: SupportSectionId] }>();

const sectionName = (id: SupportSectionId) => SUPPORT_SECTIONS.find((s) => s.id === id)?.name ?? '';
</script>

<template>
  <ol class="timeline">
    <li v-for="(s, i) in steps" :key="s.title">
      <span class="no num">{{ i + 1 }}</span>
      <div class="step">
        <span class="when">{{ s.when }}</span>
        <strong>{{ s.title }}</strong>
        <p>{{ s.text }}</p>
        <span v-if="s.links?.length || s.toSection" class="links">
          <a v-for="l in s.links" :key="l.url" :href="l.url" target="_blank" rel="noopener">{{ l.label }} ↗</a>
          <button v-if="s.toSection" class="linkish" @click="emit('section', s.toSection)">{{ sectionName(s.toSection) }} 칸</button>
        </span>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.timeline { display: grid; max-width: 900px; margin: 0; padding: 0; list-style: none; }
.timeline li { position: relative; display: grid; grid-template-columns: 22px minmax(0, 1fr); align-items: start; gap: 12px; padding-bottom: 16px; }
.timeline li::before { content: ''; position: absolute; left: 10px; top: 26px; bottom: 2px; width: 2px; border-radius: 1px; background: var(--line); }
.timeline li:last-child { padding-bottom: 0; }
.timeline li:last-child::before { display: none; }
.no {
  display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%;
  background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 700;
}
.step { display: grid; gap: 1px; }
.when { font-size: 12px; font-weight: 700; color: var(--accent); }
.step strong { font-size: 14px; }
.step p { margin: 3px 0 0; font-size: 13px; line-height: 1.6; color: var(--ink-2); }
.links { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin-top: 4px; font-size: 12px; }
.links a { color: var(--accent); text-decoration: none; }
.links a:hover { text-decoration: underline; text-underline-offset: 3px; }
.linkish {
  padding: 0; border: 0; background: none; font: inherit; color: var(--muted); cursor: pointer;
  text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px;
}
.linkish:hover { color: var(--ink); }
</style>
