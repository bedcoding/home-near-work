<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { DEAL_LABEL, type Area, type DealType } from '../../../shared/types';
import { DEFAULT_FILTERS, FILTER_DEALS, type Filters } from '../filters';
import { KIND_LABEL, KINDS } from '../kinds';

const filters = defineModel<Filters>({ required: true });
/**
 * unused: 지금 탭에서 안 쓰는 칸(흐리게 보인다). 'all'이면 모든 칸.
 * dealChoices: 거래 유형 칸에 보일 것(없으면 전부). singleDeal: 거래 유형을 하나만 고른다(한눈에 탭, 가운데 카드와 같은 값).
 */
const props = defineProps<{ hiddenCount: number; allAreas: Area[]; unused?: string[] | 'all'; dealChoices?: DealType[]; singleDeal?: boolean }>();
const emit = defineEmits<{ manageAreas: []; hide: [] }>();

/** 한눈에 탭 지역 칸에서 한 지역만 보고 있으면 그 이름. */
const focusText = computed(() => {
  const names = props.allAreas.filter((a) => a.enabled && filters.value.areaIds.includes(a.id)).map((a) => a.name);
  return names.length ? `${names.join(', ')}만 보는 중` : null;
});

function toggle<T>(list: T[], value: T) {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
  else list.push(value);
}

/** 빈 칸은 '제한 없음'. */
function num(event: Event): number | null {
  const v = (event.target as HTMLInputElement).value.trim();
  return v === '' ? null : Number(v);
}

function reset() {
  filters.value = { ...DEFAULT_FILTERS, deals: [], areaIds: [], kinds: [] };
}

// ---------- 칸 접기와 순서 ----------
// 제목을 누르거나 Space로 접고 편다. ⠿를 끌어 놓거나 제목에서 Alt+↑↓로 순서를 바꾼다. 순서와 접힘은 브라우저에 저장한다.
type SectionId = 'area' | 'deal' | 'kind' | 'price' | 'home' | 'text';
const SECTIONS: SectionId[] = ['area', 'deal', 'kind', 'price', 'home', 'text'];
const TITLES: Record<SectionId, string> = { area: '지역', deal: '거래 유형', kind: '매물 유형', price: '가격', home: '집', text: '검색어' };
const LAYOUT_KEY = 'hnw-filter-layout-v1';

function loadLayout(): { order: SectionId[]; collapsed: SectionId[] } {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null');
    const order = ((saved?.order ?? []) as SectionId[]).filter((id) => SECTIONS.includes(id));
    // 저장된 순서에 없는 칸(새로 생긴 칸)은 기본 순서에서 바로 앞 칸 뒤에 넣는다.
    SECTIONS.forEach((id, i) => {
      if (order.includes(id)) return;
      const prev = SECTIONS.slice(0, i).reverse().find((p) => order.includes(p));
      order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id);
    });
    return { order, collapsed: ((saved?.collapsed ?? []) as SectionId[]).filter((id) => SECTIONS.includes(id)) };
  } catch {
    return { order: [...SECTIONS], collapsed: [] };
  }
}
const layout = reactive(loadLayout());
watch(layout, (v) => {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(v));
  } catch {
    /* 저장이 막혀도 동작한다 */
  }
});

const isCollapsed = (id: SectionId) => layout.collapsed.includes(id);
const isUnused = (id: SectionId) => props.unused === 'all' || !!props.unused?.includes(id);
function toggleSection(id: SectionId) {
  layout.collapsed = isCollapsed(id) ? layout.collapsed.filter((x) => x !== id) : [...layout.collapsed, id];
}

const range = (label: string, min: number | null, max: number | null) => (min == null && max == null ? null : `${label} ${min ?? ''}~${max ?? ''}`);
/** 접은 칸 제목 옆에 보일 적용 중인 조건 */
function summary(id: SectionId): string {
  const f = filters.value;
  const parts =
    id === 'area'
      ? [focusText.value, f.insideAreas ? null : '반경 밖 포함', f.distanceMax != null ? `역까지 ${f.distanceMax}m` : null]
      : id === 'deal'
        ? [f.deals.map((d) => DEAL_LABEL[d]).join(', ') || null]
        : id === 'kind'
          ? [f.kinds.map((k) => KIND_LABEL[k]).join(', ') || null]
        : id === 'price'
          ? [range('보증금', f.depositMin, f.depositMax), range('월세', f.monthlyMin, f.monthlyMax), range('매매가', f.priceMin, f.priceMax)]
          : id === 'home'
            ? [range('면적', f.areaMin, f.areaMax), f.excludeBasement ? '반지하 빼기' : null, f.excludeFirstFloor ? '1층 빼기' : null, f.excludeRooftop ? '옥탑 빼기' : null, f.noOptionsOnly ? '무옵션만' : null]
            : [f.text.trim() ? `"${f.text.trim()}"` : null];
  return parts.filter(Boolean).join(', ');
}

const dragging = ref<SectionId | null>(null);
const dropAt = ref<{ id: SectionId; after: boolean } | null>(null);

function onDragStart(e: DragEvent, id: SectionId) {
  dragging.value = id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }
}

function onDragOver(e: DragEvent, id: SectionId) {
  if (!dragging.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  // 제목 줄 가운데를 기준으로 위인지 아래인지 정한다.
  const head = (e.currentTarget as HTMLElement).querySelector('.fsec-head')?.getBoundingClientRect();
  if (head) dropAt.value = { id, after: e.clientY > head.top + head.height / 2 };
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  const from = dragging.value;
  const to = dropAt.value;
  onDragEnd();
  if (!from || !to || from === to.id) return;
  const order = layout.order.filter((id) => id !== from);
  order.splice(order.indexOf(to.id) + (to.after ? 1 : 0), 0, from);
  layout.order = order;
}

function onDragEnd() {
  dragging.value = null;
  dropAt.value = null;
}

async function nudge(id: SectionId, delta: number, e: KeyboardEvent) {
  const el = e.currentTarget as HTMLElement;
  const order = [...layout.order];
  const i = order.indexOf(id);
  const j = i + delta;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  layout.order = order;
  await nextTick();
  el.focus();
}
</script>

<template>
  <aside class="panel" aria-label="필터">
    <div class="sections" @dragend="onDragEnd">
      <section
        v-for="id in layout.order" :key="id" class="fsec"
        :class="{
          unused: isUnused(id),
          dragging: dragging === id,
          'drop-before': dropAt?.id === id && !dropAt.after,
          'drop-after': dropAt?.id === id && dropAt.after,
        }"
        @dragover="onDragOver($event, id)" @drop="onDrop"
      >
        <div
          class="fsec-head" role="button" tabindex="0" draggable="true" :aria-expanded="!isCollapsed(id)"
          :title="isUnused(id) ? '이 탭에는 안 씀' : '눌러서 접거나 펼치기, ⠿를 끌어서 순서 바꾸기(Alt+↑↓)'"
          @dragstart="onDragStart($event, id)" @click="toggleSection(id)" @keydown.space.stop.prevent="toggleSection(id)"
          @keydown.alt.up.stop.prevent="nudge(id, -1, $event)" @keydown.alt.down.stop.prevent="nudge(id, 1, $event)"
        >
          <span class="grip" aria-hidden="true">⠿</span>
          <span class="fsec-title">{{ TITLES[id] }}<span v-if="id === 'price'" class="muted unit"> (만원)</span></span>
          <span v-if="isCollapsed(id) && summary(id)" class="fsec-sum">{{ summary(id) }}</span>
          <span class="chev" aria-hidden="true">{{ isCollapsed(id) ? '▸' : '▾' }}</span>
        </div>

        <div v-if="!isCollapsed(id)" class="fsec-body">
          <template v-if="id === 'area'">
            <p v-if="focusText" class="focus">
              {{ focusText }}
              <button class="btn btn-ghost btn-sm" @click="filters.areaIds = []">모두 보기</button>
            </p>
            <label class="check" title="끄면 모은 범위(반경 +500m)까지 보입니다"><input v-model="filters.insideAreas" type="checkbox" /> 지역 반경 안만</label>
            <label class="field">역까지 최대 거리(m)<input type="number" min="100" step="100" :value="filters.distanceMax ?? ''" @input="filters.distanceMax = num($event)" /></label>
            <button class="btn btn-sm manage" @click="emit('manageAreas')">지역 켜고 끄기</button>
          </template>

          <div v-else-if="id === 'deal'" class="chips">
            <button class="chip-btn" :class="{ on: !filters.deals.length }" :aria-pressed="!filters.deals.length" @click="filters.deals = []">전체</button>
            <button
              v-for="d in props.dealChoices ?? FILTER_DEALS" :key="d" class="chip-btn" :class="{ on: filters.deals.includes(d) }"
              :aria-pressed="filters.deals.includes(d)" @click="props.singleDeal ? (filters.deals = [d]) : toggle(filters.deals, d)"
            >
              {{ DEAL_LABEL[d] }}
            </button>
          </div>

          <div v-else-if="id === 'kind'" class="chips">
            <button class="chip-btn" :class="{ on: !filters.kinds.length }" :aria-pressed="!filters.kinds.length" @click="filters.kinds = []">전체</button>
            <button
              v-for="k in KINDS" :key="k" class="chip-btn" :class="{ on: filters.kinds.includes(k) }" :aria-pressed="filters.kinds.includes(k)"
              @click="toggle(filters.kinds, k)"
            >
              {{ KIND_LABEL[k] }}
            </button>
          </div>

          <template v-else-if="id === 'price'">
            <div class="pair">
              <label class="field">보증금 최소<input type="number" min="0" step="100" :value="filters.depositMin ?? ''" @input="filters.depositMin = num($event)" /></label>
              <label class="field">보증금 최대<input type="number" min="0" step="100" :value="filters.depositMax ?? ''" @input="filters.depositMax = num($event)" /></label>
            </div>
            <div class="pair">
              <label class="field">월세 최소<input type="number" min="0" step="5" :value="filters.monthlyMin ?? ''" @input="filters.monthlyMin = num($event)" /></label>
              <label class="field">월세 최대<input type="number" min="0" step="5" :value="filters.monthlyMax ?? ''" @input="filters.monthlyMax = num($event)" /></label>
            </div>
            <div class="pair">
              <label class="field">매매/경매가 최소<input type="number" min="0" step="1000" :value="filters.priceMin ?? ''" @input="filters.priceMin = num($event)" /></label>
              <label class="field">매매/경매가 최대<input type="number" min="0" step="1000" :value="filters.priceMax ?? ''" @input="filters.priceMax = num($event)" /></label>
            </div>
          </template>

          <template v-else-if="id === 'home'">
            <div class="pair">
              <label class="field">전용면적 최소(㎡)<input type="number" min="0" step="1" :value="filters.areaMin ?? ''" @input="filters.areaMin = num($event)" /></label>
              <label class="field">전용면적 최대(㎡)<input type="number" min="0" step="1" :value="filters.areaMax ?? ''" @input="filters.areaMax = num($event)" /></label>
            </div>
            <label class="check"><input v-model="filters.excludeBasement" type="checkbox" /> 반지하 빼기</label>
            <label class="check"><input v-model="filters.excludeFirstFloor" type="checkbox" /> 1층 빼기</label>
            <label class="check"><input v-model="filters.excludeRooftop" type="checkbox" /> 옥탑 빼기</label>
            <label
              class="check"
              title="옵션이 없다고 확인된 집만 보입니다(집토스 옵션 목록이 빈 집, 글에 '무옵션'이라고 쓴 집). 옵션을 모르는 집은 가립니다. 매매와 전월세 매물에만 걸립니다"
            ><input v-model="filters.noOptionsOnly" type="checkbox" /> 무옵션만</label>
          </template>

          <input v-else v-model="filters.text" class="text-input" type="text" placeholder="예: 역삼동, 풀옵션" aria-label="검색어" />
        </div>
      </section>
    </div>
    <div class="footer">
      <span v-if="hiddenCount" class="hidden-count" title="필터 조건에 안 맞아 화면에서만 가린 매물(버린 것 아님)">{{ hiddenCount }}건 가림</span>
      <div class="footer-actions">
        <button class="btn btn-ghost btn-sm" @click="reset">초기화</button>
        <button class="btn btn-ghost btn-sm" title="필터 칸 숨기기 (F)" @click="emit('hide')">접기</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.panel { display: grid; gap: 14px; align-content: start; }
.hidden-count { font-size: 13px; color: var(--muted); }
.footer { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 8px 0 2px; border-top: 1px solid var(--line); }
.footer-actions { display: flex; gap: 4px; margin-left: auto; }
.sections { display: grid; gap: 10px; }
.fsec { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); transition: box-shadow .12s; }
.fsec.unused { opacity: .45; }
.fsec.dragging { opacity: .4; }
.fsec.drop-before { box-shadow: 0 -4px 0 0 var(--accent); }
.fsec.drop-after { box-shadow: 0 4px 0 0 var(--accent); }
.fsec-head {
  display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 4px 12px 4px 4px;
  cursor: pointer; user-select: none; border-radius: var(--radius);
}
.grip { padding: 6px 4px 6px 8px; font-size: 18px; line-height: 1; color: var(--muted); cursor: grab; }
.fsec-title { font-weight: 700; font-size: 14px; white-space: nowrap; }
.unit { font-weight: 500; font-size: 13px; }
.fsec-sum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; color: var(--accent); }
.chev { margin-left: auto; font-size: 13px; color: var(--muted); }
.fsec-body { display: grid; gap: 8px; padding: 0 12px 12px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.manage { justify-self: start; }
.focus { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; color: var(--accent); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-btn { min-height: 36px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); font-size: 14px; font-weight: 700; }
.chip-btn.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.text-input { width: 100%; min-height: 38px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); font: inherit; }
</style>
