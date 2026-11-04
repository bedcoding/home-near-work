<script setup lang="ts">
import { computed } from 'vue';
import type { Area } from '../../../shared/types';
import { naverCenter } from '../siteLinks';
import { dateTime } from '../format';

// 순차 조회 패널의 '네이버 필터' 아래에 들어가는 지도 링크와 안내.
const props = defineProps<{ areas: Area[]; receivedAt: string | null }>();
const links = computed(() => props.areas.filter(a => a.enabled && a.purpose !== 'alert' && a.region).map(a => ({
  id: a.id, name: a.name,
  url: `https://fin.land.naver.com/map?center=${naverCenter(a.lat, a.lng)}&zoom=${a.region?.kind === 'gu' ? 11 : 14}`,
})));
</script>

<template>
  <div class="naver-manual">
    <div class="links">
      <a v-for="link in links" :key="link.id" class="btn btn-sm" :href="link.url" target="_blank" rel="noopener noreferrer">{{ link.name }} 지도 열기 ↗</a>
      <a v-if="!links.length" class="btn btn-sm" href="https://fin.land.naver.com/map" target="_blank" rel="noopener noreferrer">네이버 지도 열기 ↗</a>
      <span class="muted">지역 중심의 지도만 엽니다. 필터를 적용한 뒤 탭 목록 새로고침을 누르세요.</span>
    </div>
    <p class="receipt">최근 네이버 화면 수신: {{ receivedAt ? dateTime(receivedAt) : '아직 없음' }}<span class="muted">, 수신 시각은 선택 조건의 수집 완료를 뜻하지 않습니다.</span></p>
    <details>
      <summary>자세한 순서와 예약</summary>
      <ol>
        <li>PC와 대시보드 서버를 켜 둡니다. 확장 업데이트 후에는 네이버 탭을 한 번 새로고침하고 필터를 확인하세요.</li>
        <li>시작하면 고른 탭의 필터를 전용 수집 창에 복사합니다. 필터를 읽지 못하거나 창의 조건이 달라지면 수집을 멈춥니다.</li>
        <li>진행 상황은 아래 진행 표시와 수집 창에서 확인합니다. 확장 아이콘 메뉴에서도 같은 수집을 시작하고 볼 수 있습니다.</li>
        <li>이어하기와 미확인 지역 재수집은 저장한 조건을 사용합니다. 필터를 바꾸려면 새 수집을 시작하세요.</li>
      </ol>
      <p class="muted">예약하려면 위의 ‘이 조건과 지역을 예약용으로 저장’을 누른 뒤 아래 브라우저 예약 조회의 ‘예약 설정’에서 네이버를 켜세요. 확장 아이콘 메뉴에서도 저장할 수 있습니다. 예약은 저장한 조건을 사용하며 일반 ‘조회하기’와는 별개입니다.</p>
    </details>
  </div>
</template>

<style scoped>
.naver-manual { display:grid; gap:10px; padding-top:12px; border-top:1px solid var(--line); }
.links { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
p,ol { margin:0; font-size:14px; line-height:1.6; } ol { padding-left:22px; } li + li { margin-top:4px; }
.links .muted,.receipt { font-size:13px; }
summary { cursor:pointer; font-weight:600; font-size:14px; min-height:36px; padding:6px 0; }
details ol { margin:4px 0 10px; }
details p { font-size:13px; }
</style>
