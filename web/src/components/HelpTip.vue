<script setup lang="ts">
import CountTooltip from './CountTooltip.vue';

// 설명 글을 화면에 늘어놓지 않고 작은 (?)에 담는다. 마우스를 올리거나 키보드로 초점을 옮기면 설명 상자가 뜬다.
withDefaults(defineProps<{ text: string; maxWidth?: number }>(), { maxWidth: 440 });
</script>

<template>
  <CountTooltip :text="text" :max-width="maxWidth"><span class="help-tip" aria-label="설명 보기">?</span></CountTooltip>
</template>

<style scoped>
.help-tip {
  display: inline-grid; place-items: center; width: 18px; height: 18px; margin-left: 4px; border-radius: 50%;
  border: 1px solid var(--line-strong); background: var(--surface); color: var(--muted);
  font: 700 11px/1 var(--font); vertical-align: 1px; cursor: help;
}
.help-tip:hover { border-color: var(--accent); color: var(--accent); }
</style>
