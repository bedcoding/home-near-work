<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Area, ListingView, Verdict } from '../../../shared/types';
import type { CatalogStation } from '../areaActions';
import { ROOM_TYPE_LABEL, ROOM_TYPES, roomTypeOf, type RoomType } from '../rooms';
import ListingCard from './ListingCard.vue';
import OverviewMap from './OverviewMap.vue';

// 고시원과 쉐어 탭: 종류 칸(전체, 고시원과 원룸텔, 쉐어하우스, 코리빙), 목록(왼쪽)과 고른 종류만 그린 지도(오른쪽).
// 목록 순서는 받은 그대로 쓰고, 고른 종류의 목록을 visible로 알린다(App의 키보드 이동과 같은 순서).

type Point = { lat: number; lng: number };
const props = defineProps<{
  /** 필터를 통과한 고시원과 쉐어(sortRooms 순서) */
  listings: ListingView[];
  /** '지역 반경 안만' 때문에 가린 수 */
  outside: number;
  areas: Area[];
  selectedId: string | null;
}>();
const emit = defineEmits<{
  /** 고른 종류의 매물(화면 순서) */
  visible: [ListingView[]];
  select: [ListingView];
  open: [ListingView];
  verdict: [ListingView, Verdict | null];
  source: [ListingView];
  raw: [ListingView];
  pick: [Point];
  area: [Area];
  station: [CatalogStation];
  /** 고시원과 쉐어의 신규와 가격 변동 표시를 모두 지움(모두 읽음) */
  ack: [];
}>();

const hasNews = (l: ListingView) => l.isNew || !!l.priceChange;
const news = computed(() => props.listings.filter((l) => l.isNew).length);
const changed = computed(() => props.listings.filter((l) => !!l.priceChange).length);

// 고른 종류는 다음에 열어도 그대로 둔다.
const KEY = 'hnw-rooms-type';
type Pick = RoomType | 'all';
const saved = localStorage.getItem(KEY);
/** 지도에 진하게 보일 펼친 목록(이 탭은 없음). 같은 배열을 써서 다시 그릴 일을 줄인다. */
const none: ListingView[] = [];
const type = ref<Pick>(saved === 'all' || (ROOM_TYPES as string[]).includes(saved ?? '') ? (saved as Pick) : 'all');
watch(type, (t) => localStorage.setItem(KEY, t));

/** 종류 칸: 전체 + 매물이 있는 종류. 칸마다 수와 새 소식 수. */
const typeChips = computed(() => {
  const count = (list: ListingView[]) => ({ total: list.length, news: list.filter(hasNews).length });
  return [
    { id: 'all' as Pick, label: '전체', ...count(props.listings) },
    ...ROOM_TYPES.map((t) => ({ id: t as Pick, label: ROOM_TYPE_LABEL[t], ...count(props.listings.filter((l) => roomTypeOf(l) === t)) })).filter(
      (c) => c.total > 0 || c.id === type.value,
    ),
  ];
});

const shown = computed(() => (type.value === 'all' ? props.listings : props.listings.filter((l) => roomTypeOf(l) === type.value)));
watch(shown, (v) => emit('visible', v), { immediate: true });

function pickType(index: number) {
  const chip = typeChips.value[index];
  if (chip) type.value = chip.id;
}
defineExpose({ pickType });
</script>

<template>
  <section class="rooms">
    <div class="head">
      <strong class="total num">고시원과 쉐어 {{ listings.length }}곳</strong>
      <span v-if="news" class="chip chip-new">신규 {{ news }}</span>
      <span v-if="changed" class="chip chip-down">가격 변동 {{ changed }}</span>
      <span v-if="outside" class="outside" title="지역 반경 밖이라 가린 곳입니다. 왼쪽 필터에서 '지역 반경 안만'을 끄면 보입니다.">반경 밖 {{ outside }}곳</span>
      <button v-if="news || changed" class="link-btn" title="이 탭의 '신규'와 가격 변동 표시를 모두 지웁니다. 매물은 그대로 남습니다" @click="emit('ack')">모두 읽음</button>
    </div>

    <nav class="types" aria-label="종류">
      <button
        v-for="(c, i) in typeChips" :key="c.id" class="type" :class="{ on: type === c.id }"
        :title="`${i + 1}번 키로도 바꿀 수 있습니다`" @click="type = c.id"
      >
        {{ c.label }}<span class="count num">{{ c.total }}</span>
        <span v-if="c.news" class="chip chip-new">신규 {{ c.news }}</span>
      </button>
    </nav>

    <div class="split">
      <div class="list">
        <ListingCard
          v-for="l in shown" :key="l.id" :listing="l" :areas="areas" :selected="l.id === selectedId"
          @select="emit('select', l)" @open="emit('open', l)" @verdict="(v) => emit('verdict', l, v)"
          @source="emit('source', l)" @raw="emit('raw', l)"
        />
        <p v-if="!shown.length" class="empty muted">조건에 맞는 곳이 없습니다.</p>
      </div>
      <aside class="map">
        <OverviewMap
          :listings="none" :background="shown" :areas="areas" :selected-id="selectedId" :fit-key="type"
          @select="(l) => emit('select', l)" @reveal="(ls) => emit('select', ls[0])" @open="(l) => emit('open', l)" @pick="(p) => emit('pick', p)" @area="(a) => emit('area', a)"
          @station="(s) => emit('station', s)"
        />
      </aside>
    </div>
  </section>
</template>

<style scoped>
.rooms { display: grid; gap: 14px; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 40px; }
.total { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; margin-right: 4px; }
.outside { font-size: 13px; font-weight: 600; color: var(--muted); }

.types { display: flex; flex-wrap: wrap; gap: 6px; }
.type {
  display: inline-flex; align-items: center; gap: 4px; min-height: 40px; padding: 0 14px;
  border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface);
  font-size: 14px; font-weight: 700; color: var(--ink-2);
}
.type:hover { border-color: var(--ink-2); }
.type.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.count { margin: 0 2px 0 4px; font-size: 13px; font-weight: 600; opacity: .75; }

/* 목록(왼쪽)과 지도(오른쪽, 따라 내려옴). 좁으면 지도가 위로 간다. 경매 탭과 같은 배치. */
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 45%); gap: 16px; align-items: start; }
.list { display: grid; gap: 8px; min-width: 0; container-type: inline-size; }
.map { position: sticky; top: 92px; height: calc(100vh - 108px); min-height: 420px; }
/* 크게 보기일 때는 위쪽 머리 줄(z-index 20)보다 위에 오게 한다. */
.map:has(.ovmap.big) { z-index: 70; }
.empty { padding: 32px 0; text-align: center; }
@media (max-width: 1280px) {
  .split { grid-template-columns: 1fr; }
  .map { position: static; order: -1; height: auto; min-height: 0; }
}
</style>
