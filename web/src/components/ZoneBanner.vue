<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ListingView } from '../../../shared/types';
import { ZONE_CHECKED, ZONE_LINKS, zoneView } from '../zones';

// 집터 카드의 재개발 구역 표시: 구역 안이면 카드 이름표 줄 맨 위의 경고 띠(part banner, 펼치면 현금청산 조건과 근거),
// 아니면 다른 이름표 뒤의 작은 표시(part chip: 구역 없음, 확인 전 등). 카드 한 장에 두 자리를 따로 넣고, 맞는 쪽만 보인다.

const props = defineProps<{
  listing: ListingView;
  /** 브이월드 키를 넣어 두었는지 */
  keySet: boolean;
  /** 매매 매물(지번이 없어 확인하지 못함) */
  sale?: boolean;
  /** 이 자리에 보일 것: banner 경고 띠, chip 작은 표시 */
  part: 'banner' | 'chip';
}>();

const view = computed(() => {
  const v = zoneView(props.listing.zone, props.keySet, props.sale);
  return v && v.banner === (props.part === 'banner') ? v : null;
});
const open = ref(false);
const dot = (date: string) => date.replace(/-/g, '.');
const day = (iso: string) => new Date(iso).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
</script>

<template>
  <div v-if="view?.banner" class="zone-banner" :class="view.tone" role="note">
    <div class="zone-head">
      <strong class="zone-label">{{ view.label }}</strong>
      <span v-for="z in view.zones" :key="z.text" class="zone-name" :title="z.title">{{ z.text }}</span>
      <button type="button" class="zone-toggle" :aria-expanded="open" @click.stop="open = !open">{{ open ? '접기' : '왜 위험한지' }}</button>
    </div>
    <p class="zone-summary">{{ view.summary }}</p>
    <div v-if="open" class="zone-more" @click.stop>
      <ul class="zone-rules">
        <li v-for="r in view.rules" :key="r.id">
          {{ r.text }}
          <span class="zone-sources">
            <a v-for="s in r.sources" :key="s.url + s.title" :href="s.url" target="_blank" rel="noopener">{{ s.title }}<template v-if="s.date"> ({{ dot(s.date) }})</template> ↗</a>
          </span>
        </li>
      </ul>
      <p class="zone-check">
        <span>확인할 곳</span>
        <a v-for="x in ZONE_LINKS" :key="x.url" :href="x.url" target="_blank" rel="noopener" :title="x.title">{{ x.label }} ↗</a>
        <span v-if="view.pnu" class="num" title="토지이음에서 찾을 때 쓰는 필지 번호(PNU)">필지 번호 {{ view.pnu }}</span>
      </p>
      <p class="zone-basis">
        브이월드 토지이용계획{{ view.checkedAt ? ` ${day(view.checkedAt)} 조회` : '' }} 기준(법적 효력은 없음), 법령은 {{ dot(ZONE_CHECKED) }}에 원문을 확인했습니다.
        사업 단계와 권리산정기준일은 이 표시에 없습니다.
      </p>
    </div>
  </div>
  <span v-else-if="view" class="chip chip-muted zone-chip" :title="view.title">{{ view.label }}</span>
</template>

<style scoped>
/* 카드 이름표 줄(flex)의 첫 줄을 통째로 쓴다. 고른 카드는 어두운 바탕이라 글자색 값을 밝게 바꾸므로, 밝은 띠 안에서는 원래 값으로 되돌린다. */
.zone-banner {
  --ink: #16202e; --ink-2: #3b4656; --muted: #6b7584; --accent: #1f5fbf;
  flex: 1 0 100%; display: grid; gap: 4px; min-width: 0; padding: 8px 10px; border: 1px solid; border-radius: 8px; font-size: 13px; line-height: 1.55;
}
.zone-banner.danger { background: var(--new-soft); border-color: #f2b8ba; color: #8c1d22; }
.zone-banner.warn { background: #fff4d6; border-color: #ecd08c; color: #6b4600; }
.zone-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
.zone-label { font-size: 14px; font-weight: 800; }
.zone-name { padding: 1px 7px; border-radius: 5px; background: rgba(255, 255, 255, .7); font-size: 12px; font-weight: 700; white-space: nowrap; cursor: help; }
.zone-toggle {
  margin-left: auto; min-height: 30px; padding: 0 10px; border: 1px solid currentColor; border-radius: 6px;
  background: rgba(255, 255, 255, .7); color: inherit; font-size: 12px; font-weight: 700;
}
.zone-summary { margin: 0; color: var(--ink-2); }
.zone-more { display: grid; gap: 6px; padding-top: 4px; border-top: 1px solid rgba(0, 0, 0, .08); color: var(--ink-2); }
.zone-rules { display: grid; gap: 6px; margin: 0; padding-left: 18px; }
.zone-sources { display: inline-flex; flex-wrap: wrap; gap: 0 10px; margin-left: 6px; font-size: 12px; }
.zone-sources a, .zone-check a { color: var(--accent); text-decoration: none; }
.zone-sources a:hover, .zone-check a:hover { text-decoration: underline; text-underline-offset: 3px; }
.zone-check { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.zone-check > span:first-child { font-weight: 700; }
.zone-basis { margin: 0; font-size: 12px; color: var(--muted); }
.zone-chip { cursor: help; }
</style>
