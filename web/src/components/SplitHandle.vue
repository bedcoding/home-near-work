<script setup lang="ts">
import { ref } from 'vue';
import { MAP_SHARE_DEFAULT, MAP_SHARE_MAX, MAP_SHARE_MIN, mapShare } from '../mapWidth';

// 목록과 지도 사이 경계. 끌면 지도 칸 폭이 바뀌고(지도가 있는 탭이 모두 같이 쓰고 기억함), 두 번 누르면 처음 폭으로 돌아간다.
// 키보드로는 왼쪽, 오른쪽 화살표로 5%씩 옮긴다. 목록 칸은 440px, 지도 칸은 320px보다 좁아지지 않는다.
// 부모 칸(목록, 경계, 지도 세 칸 격자)의 폭으로 비율을 잰다. 좁은 화면에서 한 줄로 쌓일 때는 부모가 숨긴다.

const el = ref<HTMLElement | null>(null);
const dragging = ref(false);
let frame = 0;
let lastX = 0;

/** 비율을 25~75%, 그리고 지도 320px 이상, 목록 440px 이상이 되게 맞춘다. */
function clampShare(share: number, width: number) {
  const low = Math.max(MAP_SHARE_MIN, (320 / width) * 100);
  const high = Math.min(MAP_SHARE_MAX, 100 - (440 / width) * 100);
  return high < low ? MAP_SHARE_DEFAULT : Math.min(Math.max(share, low), high);
}
/** 목록과 지도를 담은 칸의 자리. 부모가 display: contents(매물 탭)면 크기가 없어서 크기가 있는 조상까지 올라간다. */
function boxWidth() {
  let box = el.value?.parentElement ?? null;
  while (box && box.getBoundingClientRect().width === 0) box = box.parentElement;
  return box?.getBoundingClientRect() ?? null;
}

function apply() {
  frame = 0;
  const r = boxWidth();
  if (r && r.width > 0) mapShare.value = clampShare(((r.right - lastX) / r.width) * 100, r.width);
}
function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  dragging.value = true;
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return;
  lastX = e.clientX;
  // 지도 크기를 다시 재는 일이 잦지 않게 화면 그리기 한 번에 한 번만 바꾼다.
  if (!frame) frame = requestAnimationFrame(apply);
}
function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
}
function onKey(e: KeyboardEvent) {
  const r = boxWidth();
  if (!r) return;
  // 경계를 왼쪽으로 옮기면 지도가 넓어진다.
  if (e.key === 'ArrowLeft') mapShare.value = clampShare(mapShare.value + 5, r.width);
  else if (e.key === 'ArrowRight') mapShare.value = clampShare(mapShare.value - 5, r.width);
  else return;
  e.preventDefault();
}
const reset = () => (mapShare.value = MAP_SHARE_DEFAULT);
</script>

<template>
  <div
    ref="el" class="split-handle" :class="{ dragging }" role="separator" aria-orientation="vertical" tabindex="0"
    aria-label="목록과 지도 폭 조절" :aria-valuemin="MAP_SHARE_MIN" :aria-valuemax="MAP_SHARE_MAX" :aria-valuenow="Math.round(mapShare)"
    title="끌어서 지도 폭을 바꿉니다. 두 번 누르면 처음 폭으로 돌아갑니다."
    @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp"
    @dblclick="reset" @keydown="onKey"
  >
    <span class="grip" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
/* 지도처럼 화면에 따라 내려와서, 목록을 내려도 경계를 잡을 수 있다. 부모가 --split-top, --split-height로 지도와 맞춘다. */
.split-handle {
  position: sticky; top: var(--split-top, calc(var(--app-header-height, 76px) + 16px)); align-self: start;
  display: grid; place-items: center; width: 12px; height: var(--split-height, calc(100dvh - var(--app-header-height, 76px) - 32px)); min-height: 420px;
  border-radius: 6px; cursor: col-resize; touch-action: none;
}
.split-handle:hover, .split-handle.dragging, .split-handle:focus-visible { background: var(--accent-soft); }
.grip { width: 4px; height: 48px; border-radius: 999px; background: var(--line-strong); }
.split-handle:hover .grip, .split-handle.dragging .grip, .split-handle:focus-visible .grip { background: var(--accent); }
</style>
