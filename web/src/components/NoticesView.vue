<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { inGus, nearReason, type NoticeFileView, type NoticeSourceId, type NoticeSourceStatus, type NoticeView } from '../../../shared/types';
import { api } from '../api';
import { failedNoticeSources } from '../notices';
import CountTooltip from './CountTooltip.vue';
import NoticeFiles from './NoticeFiles.vue';
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
const countDetails = computed(() => `근처 ${near.value}건\n신규 ${newIds.value.length}건\n지역 밖 ${outside.value}건`);
/** 마지막 수집이 실패한 곳(목록이 그 전 것이라는 걸 숨기지 않게 머리 줄에 보인다) */
const failed = computed(() => failedNoticeSources(props.sources, props.status));

/** 직접 받은 첨부 파일을 읽은 결과. 탭을 보는 동안 10초마다 다시 받는다(받자마자 읽은 결과가 뜨게). */
const files = ref<NoticeFileView[]>([]);
async function loadFiles() {
  try {
    files.value = (await api.noticeFiles()).files;
  } catch {
    /* 대시보드가 잠깐 꺼져 있으면 다음에 받는다 */
  }
}
let timer: number | undefined;
onMounted(() => {
  void loadFiles();
  timer = window.setInterval(loadFiles, 10_000);
});
onUnmounted(() => window.clearInterval(timer));
/** 공고 번호마다 받은 파일 */
const filesByNotice = computed(() => {
  const map = new Map<number, NoticeFileView[]>();
  for (const f of files.value) if (f.noticeId != null) map.set(f.noticeId, [...(map.get(f.noticeId) ?? []), f]);
  return map;
});
/** 보이는 공고 줄에 붙지 않는 파일(공고를 못 찾았거나 이 탭에 안 보이는 공고) */
const looseFiles = computed(() => {
  const ids = new Set(shown.value.map((n) => n.id));
  return files.value.filter((f) => f.noticeId == null || !ids.has(f.noticeId));
});
</script>

<template>
  <section class="rent">
    <div class="head">
      <strong class="total num">임대 공고 <CountTooltip :text="countDetails">{{ current }}건</CountTooltip></strong>
      <span v-for="f in failed" :key="f.id" class="failed" :title="f.title">{{ f.text }}</span>
    </div>

    <div v-if="looseFiles.length" class="loose" title="공고 화면에서 받았지만 이 목록의 공고와 맞추지 못한 첨부 파일(다른 탭 공고 포함)">
      <NoticeFiles :files="looseFiles" show-notice />
    </div>

    <p v-if="!notices.length" class="empty muted">'조회하기'를 누르면 모읍니다.</p>
    <NoticeList v-else :notices="shown" :gus="gus" :names="names" :files="filesByNotice" @ack="(ids) => emit('ack', ids)" />
  </section>
</template>

<style scoped>
.rent { display: grid; gap: 14px; max-width: 1100px; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 40px; }
.total { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; margin-right: 4px; }
.failed { font-size: 13px; font-weight: 700; color: var(--new); }
.empty { padding: 32px 0; text-align: center; }
.loose { padding: 6px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
</style>
