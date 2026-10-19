<script lang="ts">
/** 지금 떠 있는 설명 상자를 닫는 함수. 상자는 한 번에 하나만 띄운다. */
let closeOpen: (() => void) | null = null;
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';

// 숫자에 마우스를 올리거나 키보드로 초점을 옮기면 자세한 수를 띄우는 설명 상자.
// 마우스로 누르면 닫히고(누른 뒤 남은 초점으로는 다시 뜨지 않음), 창을 떠나도 닫힌다.
defineOptions({ inheritAttrs: false });
/** maxWidth: 긴 설명을 이 너비(px)에서 줄 바꿈한다(없으면 화면 너비까지). */
const props = withDefaults(defineProps<{ text: string; focusable?: boolean; maxWidth?: number }>(), { focusable: true });
const id = useId();
const anchor = ref<HTMLElement>();
const popup = ref<HTMLElement>();
const open = ref(false);
const position = ref({ left: '0px', top: '0px', visibility: 'hidden' as 'hidden' | 'visible' });
const above = ref(false);
let hovered = false;
let focused = false;
let dismissed = false;
/** 이 숫자(또는 감싼 버튼)를 마지막으로 누른 포인터 종류: mouse, touch, pen */
let lastPointer = '';
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let focusOwner: HTMLElement | null = null;

function cancelClose() {
  if (closeTimer !== undefined) clearTimeout(closeTimer);
  closeTimer = undefined;
}

function place() {
  if (!open.value || !anchor.value || !popup.value) return;
  const target = anchor.value.getBoundingClientRect();
  const box = popup.value.getBoundingClientRect();
  const inset = 8;
  const width = document.documentElement.clientWidth;
  const height = window.innerHeight;
  above.value = target.bottom + box.height > height - inset && target.top >= box.height + inset;
  position.value = {
    left: `${Math.max(inset, Math.min(target.left + (target.width - box.width) / 2, width - box.width - inset))}px`,
    top: `${Math.max(inset, Math.min(above.value ? target.top - box.height : target.bottom, height - box.height - inset))}px`,
    visibility: 'visible',
  };
}

function show() {
  cancelClose();
  if (dismissed || !props.text || open.value) return;
  if (closeOpen && closeOpen !== hide) closeOpen();
  closeOpen = hide;
  position.value.visibility = 'hidden';
  open.value = true;
  void nextTick(place);
}

/** 상자를 닫고, 올림과 초점 표시도 지운다(다시 올리거나 초점을 옮기면 다시 뜬다). */
function hide() {
  cancelClose();
  hovered = false;
  focused = false;
  open.value = false;
  if (closeOpen === hide) closeOpen = null;
}

function closeWhenIdle() {
  cancelClose();
  // 닫기를 조금 늦춰 숫자에서 상자로 마우스를 옮길 틈을 준다.
  closeTimer = setTimeout(() => {
    if (hovered || focused) return;
    hide();
    dismissed = false;
  }, 100);
}

function enter() {
  hovered = true;
  dismissed = false;
  show();
}

function leave() {
  hovered = false;
  closeWhenIdle();
}

/** 마우스로 눌러 생긴 초점은 상자를 띄우지 않는다(키보드 초점과 터치로 누른 초점만). */
function focus(event: FocusEvent) {
  if (lastPointer === 'mouse' && !(event.target as HTMLElement).matches(':focus-visible')) return;
  focused = true;
  dismissed = false;
  show();
}

function blur() {
  focused = false;
  closeWhenIdle();
}

/** 마우스로 누르면 닫는다. 마우스를 뗐다가 다시 올리면 다시 뜬다. */
function press(event: PointerEvent) {
  lastPointer = event.pointerType;
  if (event.pointerType !== 'mouse') return;
  dismissed = true;
  hide();
}

function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !open.value) return;
  event.preventDefault();
  event.stopPropagation();
  dismissed = true;
  hide();
}

function stopActivation(event: KeyboardEvent) {
  if (!props.focusable || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  event.stopPropagation();
}

function describeOwner(value: boolean) {
  if (!focusOwner) return;
  const ids = (focusOwner.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((value) => value && value !== id);
  if (value) ids.push(id);
  if (ids.length) focusOwner.setAttribute('aria-describedby', ids.join(' '));
  else focusOwner.removeAttribute('aria-describedby');
}

watch(open, (value) => {
  if (value) {
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('blur', hide);
    document.addEventListener('keydown', escape, true);
  } else {
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('blur', hide);
    document.removeEventListener('keydown', escape, true);
  }
  describeOwner(value);
});
watch(() => props.text, () => {
  if (!props.text) hide();
  else if (open.value) void nextTick(place);
});

onMounted(() => {
  if (props.focusable) return;
  focusOwner = anchor.value?.parentElement?.closest<HTMLElement>('button, a[href], [tabindex]') ?? null;
  focusOwner?.addEventListener('focus', focus);
  focusOwner?.addEventListener('blur', blur);
  focusOwner?.addEventListener('pointerdown', press);
});

onBeforeUnmount(() => {
  hide();
  describeOwner(false);
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  window.removeEventListener('blur', hide);
  document.removeEventListener('keydown', escape, true);
  focusOwner?.removeEventListener('focus', focus);
  focusOwner?.removeEventListener('blur', blur);
  focusOwner?.removeEventListener('pointerdown', press);
});
</script>

<template>
  <span
    v-bind="$attrs"
    ref="anchor"
    class="count-tooltip"
    :tabindex="focusable && text ? 0 : undefined"
    :aria-describedby="open ? id : undefined"
    @pointerenter="enter"
    @pointerleave="leave"
    @pointerdown="press"
    @focus="focus"
    @blur="blur"
    @keydown="stopActivation"
  ><slot /></span>
  <Teleport to="body">
    <span v-if="open" :id="id" ref="popup" class="count-tooltip-popup" :class="{ above }" :style="[position, maxWidth ? { maxWidth: `min(${maxWidth}px, calc(100vw - 16px))` } : {}]" role="tooltip" @pointerenter="enter" @pointerleave="leave">
      <span class="count-tooltip-text">{{ text }}</span>
    </span>
  </Teleport>
</template>

<style scoped>
.count-tooltip { display: inline; cursor: help; }
.count-tooltip-popup {
  position: fixed; z-index: 10000; display: block; width: max-content;
  max-width: calc(100vw - 16px); max-height: calc(100dvh - 16px); padding-top: 8px;
  font: 500 13px/1.65 var(--font); color: var(--ink); text-align: left;
  white-space: pre-line; overflow-wrap: anywhere;
}
.count-tooltip-popup.above { padding-top: 0; padding-bottom: 8px; }
.count-tooltip-text {
  display: block; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface); box-shadow: 0 4px 16px #1d2c431f;
}
</style>
