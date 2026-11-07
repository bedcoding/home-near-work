<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';

// 설명 모달: 화면에는 버튼 하나만 두고, 누르면 모달 안에서 탭으로 나눠 보여 준다.
// 긴 설명과 참고 자료(조건 정리, 통계, 범례)를 목록 위에 늘어놓으면 매물이 밀려 내려가서, 필요할 때만 열어 보게 모았다.
// 탭 내용은 탭 id 이름의 슬롯으로 받는다. 고른 탭은 이 브라우저에 기억한다.
// <dialog>라서 Esc를 누르거나 바깥(어두운 곳)을 누르면 닫힌다. 닫혀 있을 때는 탭 내용을 그리지 않는다.

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  /** 모달 제목 */
  heading: string;
  /** 탭(보일 것만). sub는 탭 내용 맨 위 흐린 한 줄(조사한 날 등). 탭이 하나면 탭 줄을 숨긴다. */
  tabs: { id: string; label: string; sub?: string }[];
  /** 버튼 글자(기본 '설명') */
  label?: string;
  /** 고른 탭을 기억하는 localStorage 키 */
  storageKey: string;
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const body = ref<HTMLElement | null>(null);
const tabEls = ref<HTMLButtonElement[]>([]);
const isOpen = ref(false);
const headingId = useId();

function read() {
  try {
    return localStorage.getItem(props.storageKey);
  } catch {
    return null;
  }
}
const picked = ref<string | null>(read());
const current = computed(() => props.tabs.find((t) => t.id === picked.value) ?? props.tabs[0] ?? null);

function pick(id: string) {
  picked.value = id;
  if (body.value) body.value.scrollTop = 0;
  try {
    localStorage.setItem(props.storageKey, id);
  } catch {
    /* 기억만 못 함 */
  }
}

async function open(id?: string) {
  if (id) pick(id);
  isOpen.value = true;
  await nextTick();
  dialog.value?.showModal();
}
function close() {
  dialog.value?.close();
}
/** 바깥(어두운 곳)을 누르면 닫는다. 모달 안은 .info-box가 꽉 채운다. */
function onClick(e: MouseEvent) {
  if (e.target === dialog.value) close();
}
/** 탭 줄에서 왼쪽, 오른쪽 화살표와 Home, End로 탭을 옮긴다. */
function onTabKey(e: KeyboardEvent) {
  const last = props.tabs.length - 1;
  const i = props.tabs.findIndex((t) => t.id === current.value?.id);
  const next =
    e.key === 'ArrowRight' ? (i >= last ? 0 : i + 1)
      : e.key === 'ArrowLeft' ? (i <= 0 ? last : i - 1)
        : e.key === 'Home' ? 0
          : e.key === 'End' ? last
            : -1;
  if (next < 0) return;
  e.preventDefault();
  pick(props.tabs[next].id);
  tabEls.value[next]?.focus();
}

defineExpose({ open, close });
</script>

<template>
  <button type="button" class="info-btn" v-bind="$attrs" @click="open()">
    <span class="info-mark" aria-hidden="true">?</span>{{ label ?? '설명' }}
  </button>
  <dialog ref="dialog" class="info-dialog" :aria-labelledby="headingId" @click="onClick" @close="isOpen = false">
    <div v-if="isOpen" class="info-box">
      <header class="info-head">
        <h2 :id="headingId">{{ heading }}</h2>
        <button type="button" class="btn btn-sm" @click="close">닫기</button>
      </header>
      <div v-if="tabs.length > 1" class="info-tabs" role="tablist" :aria-label="heading" @keydown="onTabKey">
        <button
          v-for="t in tabs" :key="t.id" ref="tabEls" type="button" role="tab" class="info-tab" :class="{ on: t.id === current?.id }"
          :aria-selected="t.id === current?.id" :tabindex="t.id === current?.id ? 0 : -1" @click="pick(t.id)"
        >{{ t.label }}</button>
      </div>
      <div ref="body" class="info-body" :role="tabs.length > 1 ? 'tabpanel' : undefined" :aria-label="tabs.length > 1 ? current?.label : undefined">
        <!-- 탭마다 key를 달리 줘서 탭을 바꾸면 내용을 새로 그린다(같은 key면 Vue가 서로 다른 탭 내용을 덮어쓰려다 깨진다). -->
        <div v-if="current" :key="current.id">
          <p v-if="current.sub" class="info-sub">{{ current.sub }}</p>
          <slot :name="current.id" />
        </div>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.info-btn {
  display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 13px 0 8px;
  border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface);
  font-size: 13px; font-weight: 700; color: var(--ink-2); white-space: nowrap; cursor: pointer;
}
.info-btn:hover { border-color: var(--ink-2); color: var(--ink); }
.info-mark {
  display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%;
  background: var(--ink-2); color: #fff; font-size: 11px; font-weight: 800; line-height: 1;
}
.info-btn:hover .info-mark { background: var(--ink); }

/* 탭을 바꿔도 모달 크기가 출렁이지 않게 높이를 정해 두고, 안쪽만 스크롤한다. 표가 든 탭(실거래, 매각 결과)도 넉넉하게 1240px까지. */
.info-dialog {
  width: min(1240px, calc(100vw - 48px)); height: min(1080px, calc(100dvh - 48px)); max-width: none; max-height: none;
  padding: 0; border: 0; border-radius: 14px; background: var(--surface); color: var(--ink);
  box-shadow: 0 16px 48px rgba(22, 32, 46, .3);
}
.info-dialog::backdrop { background: rgba(22, 32, 46, .45); }
.info-box { display: flex; flex-direction: column; height: 100%; }
.info-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px 14px 24px; border-bottom: 1px solid var(--line); }
.info-head h2 { margin: 0; font-size: 18px; font-weight: 800; }
.info-head .btn { margin-left: auto; }
.info-tabs { display: flex; flex-wrap: wrap; gap: 2px 6px; padding: 6px 16px 0; border-bottom: 1px solid var(--line); }
.info-tab {
  min-height: 42px; margin-bottom: -1px; padding: 0 12px; border: 0; border-bottom: 3px solid transparent; background: none;
  font-size: 14px; font-weight: 700; color: var(--muted); cursor: pointer;
}
.info-tab:hover { color: var(--ink); }
.info-tab.on { color: var(--ink); border-bottom-color: var(--ink); }
.info-body { flex: 1; min-height: 0; overflow: auto; padding: 18px 24px 28px; font-size: 15px; line-height: 1.7; }
.info-sub { margin: 0 0 14px; font-size: 13px; color: var(--muted); }
@media (max-width: 600px) {
  .info-head { padding: 14px 14px 12px 16px; }
  .info-tabs { padding-inline: 8px; }
  .info-body { padding: 14px 16px 20px; }
}
</style>
