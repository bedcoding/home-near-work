<script setup lang="ts">
import { computed } from 'vue';
import type { NoticeSourceId, NoticeSourceStatus, NoticeView } from '../../../shared/types';
import { failedNoticeSources, isPastNotice, todayIso } from '../notices';
import CountTooltip from './CountTooltip.vue';
import SubscriptionRow from './SubscriptionRow.vue';

// 청약 탭: 서울 전체 청약(분양) 공고. 접수중 → 접수 예정 → 기간 모름 순으로 위에 두고, 끝난 청약은 '지난 청약'으로 접어 둔다.

const props = defineProps<{
  /** 청약 공고(새 공고 먼저) */
  notices: NoticeView[];
  /** 청약 공고를 모으는 곳 */
  sources: NoticeSourceId[];
  /** 곳별 마지막 수집 결과 */
  status: Partial<Record<NoticeSourceId, NoticeSourceStatus>>;
}>();
const emit = defineEmits<{ ack: [ids: number[]] }>();

const today = todayIso();
/** 순서 값: 접수중(마감 가까운 순) → 접수 예정(시작 가까운 순) → 기간 모름(게시 최신 순) */
function rank(n: NoticeView): [number, string] {
  const p = n.period;
  if (p && p.start <= today) return [0, p.end];
  if (p) return [1, p.start];
  return [2, ''];
}
const upcoming = computed(() =>
  props.notices
    .filter((n) => !isPastNotice(n, today))
    .sort((a, b) => {
      const [ra, ka] = rank(a);
      const [rb, kb] = rank(b);
      return ra - rb || ka.localeCompare(kb) || (b.postedAt ?? '').localeCompare(a.postedAt ?? '');
    }),
);
/** 끝난 청약(접수 끝 최근 순) */
const past = computed(() =>
  props.notices
    .filter((n) => isPastNotice(n, today))
    .sort((a, b) => (b.period?.end ?? b.postedAt ?? '').localeCompare(a.period?.end ?? a.postedAt ?? '')),
);
const newIds = computed(() => props.notices.filter((n) => n.isNew).map((n) => n.id));
const failed = computed(() => failedNoticeSources(props.sources, props.status));
</script>

<template>
  <section class="subs">
    <div class="head">
      <strong class="total num">청약 <CountTooltip :text="`신규 ${newIds.length}건`">{{ upcoming.length }}건</CountTooltip></strong>
      <span class="muted scope" title="청약홈(APT 분양, 무순위, 잔여세대, 오피스텔, 도시형)과 SH, LH 공공분양 중 서울 공고">서울 전체</span>
      <span v-for="f in failed" :key="f.id" class="failed" :title="f.title">{{ f.text }}</span>
    </div>

    <p v-if="!notices.length" class="empty muted">'조회하기'를 누르면 모읍니다.</p>
    <template v-else>
      <ul v-if="upcoming.length" class="rows">
        <SubscriptionRow v-for="n in upcoming" :key="n.id" :notice="n" @ack="emit('ack', [n.id])" />
      </ul>
      <p v-else class="none muted">접수 예정이거나 접수중인 청약이 없습니다.</p>
      <details v-if="past.length" class="old">
        <summary>지난 청약 {{ past.length }}건</summary>
        <ul class="rows">
          <SubscriptionRow v-for="n in past" :key="n.id" :notice="n" @ack="emit('ack', [n.id])" />
        </ul>
      </details>
    </template>
  </section>
</template>

<style scoped>
.subs { display: grid; gap: 14px; max-width: 1180px; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 40px; }
.total { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; }
.scope { font-size: 13px; font-weight: 600; margin-right: 4px; }
.failed { font-size: 13px; font-weight: 700; color: var(--new); }
.rows {
  list-style: none; margin: 0; padding: 4px 14px; container-type: inline-size;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
}
.none { margin: 0; font-size: 14px; }
.old summary { cursor: pointer; padding: 8px 0; font-weight: 700; color: var(--muted); }
.old[open] summary { margin-bottom: 8px; }
.empty { padding: 32px 0; text-align: center; }
</style>
