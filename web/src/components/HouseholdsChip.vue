<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { ListingView } from '../../../shared/types';
import { householdLookupUrl } from '../apt';

// 서울 아파트 탭 카드의 세대수 칩. 세대수는 수집처 목록에 없어서 건축물대장에서 채우거나(경매와 공매, 공공데이터포털 키가 있을 때)
// 단지마다 한 번 직접 넣는다(같은 단지 물건에 같이 보임, 직접 넣은 값이 먼저).
// 대장에서 읽은 것은 '1,200세대, 3개 동, 15층'(세대가 있는 동 수, 가장 높은 동 지상층수), 직접 넣은 것은 '1,200세대'.
// 대장에서 못 찾았으면 '대장에서 못 찾음', 모르면 '세대수 넣기'. 누르면 그 자리에서 숫자 칸과 찾아보기 링크가 열린다. 빈칸으로 저장하면 직접 넣은 값을 지운다.

const props = defineProps<{ listing: ListingView }>();
const emit = defineEmits<{ save: [key: string, name: string, households: number | null] }>();

const BASIS: Record<string, string> = { recap: '총괄표제부 세대수', title: '동마다 표제부 세대수 합', ho: '세대수가 비어 있어 호수 합' };
const day = (iso: string) => new Date(iso).toLocaleDateString('ko-KR');
/** 칩 글자 */
const label = computed(() => {
  const a = props.listing.apt;
  if (!a) return '';
  if (a.households == null) return a.registry?.status === 'none' ? '대장에서 못 찾음' : '세대수 넣기';
  const parts = [`${a.households.toLocaleString('ko-KR')}세대`];
  const r = a.registry;
  if (a.householdsFrom === 'registry' && r) {
    if (r.buildings) parts.push(`${r.buildings}개 동`);
    if (r.floors) parts.push(`${r.floors}층`);
  }
  return parts.join(', ');
});
/** 칩에 마우스를 올리면 보이는 설명 */
const title = computed(() => {
  const a = props.listing.apt;
  if (!a) return '';
  const r = a.registry;
  const lines: string[] = [];
  if (a.householdsFrom === 'manual') lines.push(`${a.complexName}: 직접 넣은 세대수입니다.`);
  if (r?.status === 'ok') {
    lines.push(
      `건축물대장(${r.basis ? BASIS[r.basis] : ''}, ${day(r.checkedAt)} 조회): ${r.households?.toLocaleString('ko-KR') ?? '?'}세대`,
      [r.name, r.purpose].filter(Boolean).join(', '),
      [r.buildings ? `세대가 있는 동 ${r.buildings}개` : '', r.floors ? `가장 높은 동 지상 ${r.floors}층` : ''].filter(Boolean).join(', '),
    );
  } else if (r?.status === 'none') lines.push(`건축물대장(${day(r.checkedAt)} 조회): ${r.error ?? '못 찾음'}`);
  else if (r?.status === 'error') lines.push(`건축물대장 조회 실패(다음에 다시 봄): ${r.error ?? ''}`);
  else if (a.households == null) lines.push(`${a.complexName}의 세대수를 모릅니다.`);
  lines.push(a.households == null ? '누르면 직접 넣습니다(같은 단지 물건에 같이 보임).' : '누르면 직접 고칩니다(직접 넣은 값이 먼저).');
  return lines.filter(Boolean).join('\n');
});

const editing = ref(false);
const value = ref<number | null>(null);
const input = ref<HTMLInputElement | null>(null);
const error = ref<string | null>(null);

async function edit() {
  const a = props.listing.apt;
  value.value = a?.householdsFrom === 'manual' ? a.households : null;
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
    <button v-if="!editing" class="chip hh" :class="listing.apt.households != null ? 'chip-seen' : 'chip-warn'" type="button" :title="title" @click="edit">
      {{ label }}
    </button>
    <form v-else class="hh-edit" @submit.prevent="save" @keydown.esc.stop.prevent="editing = false">
      <label class="sr-only" :for="`hh-${listing.id}`">{{ listing.apt.complexName }} 세대수</label>
      <input
        :id="`hh-${listing.id}`" ref="input" v-model.number="value" type="number" min="1" max="20000" step="1" inputmode="numeric"
        :placeholder="listing.apt.registry?.households ? `대장 ${listing.apt.registry.households}` : '세대수'"
      />
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
