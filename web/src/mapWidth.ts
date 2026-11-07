import { computed, ref, watch } from 'vue';

// 목록 옆 지도 칸의 폭: 목록과 지도를 담은 칸 폭에 대한 지도 비율(%). 지도가 있는 탭(매물, 경매와 집터, 서울 아파트,
// 고시원과 쉐어, 노선)이 모두 같이 쓰고, 이 브라우저에 기억한다. 목록과 지도 사이 경계(SplitHandle)를 끌어 바꾼다.

const KEY = 'hnw-map-share';
export const MAP_SHARE_DEFAULT = 50;
export const MAP_SHARE_MIN = 25;
export const MAP_SHARE_MAX = 75;

function read(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v >= MAP_SHARE_MIN && v <= MAP_SHARE_MAX ? v : MAP_SHARE_DEFAULT;
  } catch {
    return MAP_SHARE_DEFAULT;
  }
}

export const mapShare = ref(read());
watch(mapShare, (v) => {
  try {
    localStorage.setItem(KEY, String(Math.round(v * 10) / 10));
  } catch {
    /* 기억만 못 함 */
  }
});

/** 목록과 지도를 담은 칸에 붙이는 CSS 변수(--map-share) */
export const mapShareStyle = computed(() => ({ '--map-share': `${mapShare.value}%` }));
