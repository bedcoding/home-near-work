<script setup lang="ts">
import { nextTick, ref } from 'vue';
import type { ListingView } from '../../../shared/types';
import { householdLookupUrl } from '../apt';

// 서울 아파트 탭 카드의 세대수 칩. 세대수는 수집처 목록에 없어서 단지마다 한 번 직접 넣는다(같은 단지 물건에 같이 보임).
// 모르면 '세대수 넣기', 알면 '1,200세대'. 누르면 그 자리에서 숫자 칸과 찾아보기 링크가 열린다. 빈칸으로 저장하면 지운다.

const props = defineProps<{ listing: ListingView }>();
const emit = defineEmits<{ save: [key: string, name: string, households: number | null] }>();

const editing = ref(false);
const value = ref<number | null>(null);
const input = ref<HTMLInputElement | null>(null);
const error = ref<string | null>(null);

async function edit() {
  value.value = props.listing.apt?.households ?? null;
  error.value = null;
  editing.value = true;
  await nextTick();
  input.value?.focus();
}

function save() {
  const apt = props.listing.apt;
  if (!apt) return;
  const n = value.value;
  if (n != null && (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 20000)) {
    error.value = '1에서 20,000 사이 정수';
    return;
  }
  emit('save', apt.complexKey, apt.complexName, n ?? null);
  editing.value = false;
}
</script>

<template>
  <span v-if="listing.apt" class="households" @click.stop>
    <template v-if="!editing">
      <button
        v-if="listing.apt.households != null" class="chip chip-seen hh" type="button"
        :title="`${listing.apt.complexName}: 직접 넣은 세대수입니다. 누르면 고칩니다.`" @click="edit"
      >{{ listing.apt.households.toLocaleString('ko-KR') }}세대</button>
      <button v-else class="chip chip-warn hh" type="button" :title="`${listing.apt.complexName}의 세대수를 모릅니다. 누르면 넣습니다(같은 단지 물건에 같이 보임).`" @click="edit">
        세대수 넣기
      </button>
    </template>
    <form v-else class="hh-edit" @submit.prevent="save" @keydown.esc.stop.prevent="editing = false">
      <label class="sr-only" :for="`hh-${listing.id}`">{{ listing.apt.complexName }} 세대수</label>
      <input :id="`hh-${listing.id}`" ref="input" v-model.number="value" type="number" min="1" max="20000" step="1" inputmode="numeric" placeholder="세대수" />
      <button class="btn btn-sm btn-primary" type="submit">저장</button>
      <button class="btn btn-sm" type="button" @click="editing = false">취소</button>
      <a class="lookup" :href="householdLookupUrl(listing)" target="_blank" rel="noopener" :title="`${listing.apt.complexName} 세대수 찾아보기`">찾아보기 ↗</a>
      <span v-if="error" class="err" role="alert">{{ error }}</span>
    </form>
  </span>
</template>

<style scoped>
.households { display: inline-flex; align-items: center; }
.hh { border: 0; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
.hh-edit { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.hh-edit input { width: 96px; min-height: 30px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface); font-size: 13px; }
.hh-edit .btn { min-height: 30px; padding: 0 10px; font-size: 13px; }
.lookup { font-size: 13px; color: var(--accent); text-decoration: none; white-space: nowrap; }
.lookup:hover { text-decoration: underline; text-underline-offset: 3px; }
.err { font-size: 12px; font-weight: 700; color: var(--new); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
