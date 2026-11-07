<script setup lang="ts">
import { computed } from 'vue';
import type { Area } from '../../../shared/types';
import { naverCenter } from '../siteLinks';
import { dateTime } from '../format';
import HelpTip from './HelpTip.vue';

// 순차 조회 패널의 '네이버 필터' 아래에 들어가는 지역 지도 단추.
const props = defineProps<{ areas: Area[]; receivedAt: string | null }>();
const help = computed(() =>
  '지역 가운데의 네이버 지도만 엽니다. 거기서 필터를 적용한 뒤 위의 탭 목록 새로고침을 누르세요. 확장을 업데이트했으면 네이버 탭을 한 번 새로고침하세요. '
  + `최근 네이버 화면 수신: ${props.receivedAt ? dateTime(props.receivedAt) : '아직 없음'}(수신 시각은 고른 조건을 다 모았다는 뜻은 아닙니다).`);
const links = computed(() => props.areas.filter(a => a.enabled && a.purpose !== 'alert' && a.region).map(a => ({
  id: a.id, name: a.name,
  url: `https://fin.land.naver.com/map?center=${naverCenter(a.lat, a.lng)}&zoom=${a.region?.kind === 'gu' ? 11 : 14}`,
})));
</script>

<template>
  <!-- 지역 가운데의 네이버 지도를 여는 단추만 두고, 설명과 최근 수신 시각은 (?)에 담는다. -->
  <div class="naver-manual">
    <a v-for="link in links" :key="link.id" class="btn btn-sm" :href="link.url" target="_blank" rel="noopener noreferrer">{{ link.name }} 지도 열기 ↗</a>
    <a v-if="!links.length" class="btn btn-sm" href="https://fin.land.naver.com/map" target="_blank" rel="noopener noreferrer">네이버 지도 열기 ↗</a>
    <HelpTip :text="help" />
  </div>
</template>

<style scoped>
.naver-manual { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
</style>
