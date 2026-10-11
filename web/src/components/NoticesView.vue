<script setup lang="ts">
import { computed } from 'vue';
import { inGus, nearReason, type NoticeSourceId, type NoticeSourceStatus, type NoticeView } from '../../../shared/types';
import { failedNoticeSources } from '../notices';
import NoticeList from './NoticeList.vue';

// 임대 공고 탭: SH, LH, 고방의 청년과 공공 임대 공고, 청약홈 민간임대. 지금 사이트 목록에 올라와 있는 공고를 위에 두고, 내려간 공고는 접어 둔다.
// 공공임대는 월세와 같은 종류라, '지역 반경 안만'이 켜져 있으면 켜진 지역 근처 구의 공고만 보인다(구를 모르는 공고는 늘 보임).
// 켜 둔 지역 바로 근처일 가능성이 높은 공고(nearReason)는 '근처' 표시를 붙여 맨 위로 올린다.

const props = defineProps<{
  /** 임대 공고(새 공고 먼저, 게시일 최신 순) */
  notices: NoticeView[];
  /** 임대 공고를 모으는 곳 */
  sources: NoticeSourceId[];
  /** 곳별 마지막 수집 결과 */
  status: Partial<Record<NoticeSourceId, NoticeSourceStatus>>;
  /** 켜진 지역 근처 서울 구 */
  gus: string[];
  /** 켜진 지역 바로 근처의 역과 지역 이름 */
  names: string[];
  /** 필터 '지역 반경 안만' */
  inside: boolean;
}>();
const emit = defineEmits<{ ack: [ids: number[]] }>();

const isNear = (n: NoticeView) => !!nearReason(n, props.gus, props.names);
/** 보이는 공고: 근처일 가능성이 높은 것을 먼저(그 안에서는 받은 순서 그대로). */
const shown = computed(() => {
  const list = props.inside ? props.notices.filter((n) => inGus(n.regions, props.gus)) : props.notices;
  return [...list.filter(isNear), ...list.filter((n) => !isNear(n))];
});
/** 지역 밖이라 가린 공고 수(지금 올라와 있는 것) */
const outside = computed(() => props.notices.filter((n) => n.current).length - shown.value.filter((n) => n.current).length);
const current = computed(() => shown.value.filter((n) => n.current).length);
/** 근처일 가능성이 높은 공고 수(지금 올라와 있는 것) */
const near = computed(() => shown.value.filter((n) => n.current && isNear(n)).length);
const newIds = computed(() => shown.value.filter((n) => n.isNew).map((n) => n.id));
/** 마지막 수집이 실패한 곳(목록이 그 전 것이라는 걸 숨기지 않게 머리 줄에 보인다) */
const failed = computed(() => failedNoticeSources(props.sources, props.status));
</script>

<template>
  <section class="rent">
    <div class="head">
      <strong class="total num">임대 공고 {{ current }}건</strong>
      <span
        v-if="near" class="chip chip-near"
        :title="`제목에 ${names.join(', ')} 중 하나가 들었거나 모집 지역이 모두 ${gus.join(', ')} 안인 공고입니다. 맨 위에 둡니다.`"
      >근처 {{ near }}</span>
      <span v-if="newIds.length" class="chip chip-new">신규 {{ newIds.length }}</span>
      <span
        v-if="outside" class="outside"
        :title="`켜 둔 지역 근처 구(${gus.join(', ')})가 아닌 공고입니다. 왼쪽 필터에서 '지역 반경 안만'을 끄면 보입니다.`"
      >지역 밖 {{ outside }}건</span>
      <span v-for="f in failed" :key="f.id" class="failed" :title="f.title">{{ f.text }}</span>
      <button v-if="newIds.length" class="btn btn-sm" @click="emit('ack', newIds)">모두 확인</button>
    </div>

    <p v-if="!notices.length" class="empty muted">'조회하기'를 누르면 모읍니다.</p>
    <NoticeList v-else :notices="shown" :gus="gus" :names="names" @ack="(ids) => emit('ack', ids)" />
  </section>
</template>

<style scoped>
.rent { display: grid; gap: 14px; max-width: 1100px; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 40px; }
.total { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; margin-right: 4px; }
.outside { font-size: 13px; font-weight: 600; color: var(--muted); }
.failed { font-size: 13px; font-weight: 700; color: var(--new); }
.empty { padding: 32px 0; text-align: center; }
</style>
