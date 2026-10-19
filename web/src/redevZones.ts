import { ref, watch } from 'vue';
import type { RedevZoneGroup, RedevZonesView } from '../../shared/types';
import { api } from './api';

// 지도에 칠하는 정비사업 구역. 매물, 경매, 집터, 서울 아파트, 고시원과 쉐어 탭 지도가 같이 쓴다.
// 구역은 처음 켤 때 한 번 받고, 칠할지는 이 브라우저에 기억한다(처음은 켬).

/** 묶음마다 이름과 색 */
export const ZONE_GROUPS: { id: RedevZoneGroup; name: string; color: string }[] = [
  { id: 'redev', name: '재개발과 재건축', color: '#2f9e44' },
  { id: 'promo', name: '재정비촉진', color: '#5c940d' },
  { id: 'small', name: '모아타운과 가로주택 등', color: '#0b7285' },
  { id: 'public', name: '공공주택 지구와 복합', color: '#e8590c' },
];
export const ZONE_COLOR = Object.fromEntries(ZONE_GROUPS.map((g) => [g.id, g.color])) as Record<RedevZoneGroup, string>;
/** 파일을 받는 곳(서울 열린데이터광장 OA-22712) */
export const ZONE_SOURCE_URL = 'https://data.seoul.go.kr/dataList/OA-22712/F/1/datasetView.do';

const KEY = 'hnw-redev-zones';
function readOn() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export const zones = ref<RedevZonesView | null>(null);
export const zonesOn = ref(readOn());
/** ZIP을 읽는 중 */
export const zonesBusy = ref(false);
/** 열린데이터광장에서 새 파일을 확인하는 중 */
export const zonesChecking = ref(false);
export const zonesError = ref<string | null>(null);
/** 마지막 '새 파일 확인' 결과 글 */
export const zonesMessage = ref<string | null>(null);
watch(zonesOn, (on) => {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* 기억만 못 함 */
  }
  if (on) void loadZones();
});

let loading: Promise<void> | null = null;
/** 구역을 한 번 받는다(이미 받았으면 그대로). */
export function loadZones(): Promise<void> {
  if (zones.value) return Promise.resolve();
  loading ??= api
    .redevZones()
    .then((v) => {
      zones.value = v;
      zonesError.value = null;
    })
    .catch((e) => {
      zonesError.value = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** 열린데이터광장의 최신판을 보고 새것이면 받아 바꾼다(1~2분 걸릴 수 있음). */
export async function checkZonesNow() {
  zonesChecking.value = true;
  zonesError.value = null;
  zonesMessage.value = null;
  try {
    const { message, ...view } = await api.updateRedevZones();
    zones.value = view;
    zonesMessage.value = message;
    zonesOn.value = true;
  } catch (e) {
    zonesError.value = `새 파일 확인 실패: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    zonesChecking.value = false;
  }
}

/** 서울플랜+ ZIP을 넣고 새 구역으로 바꾼다. */
export async function uploadZones(file: File) {
  zonesBusy.value = true;
  zonesError.value = null;
  try {
    zones.value = await api.uploadRedevZones(file);
    zonesOn.value = true;
  } catch (e) {
    zonesError.value = e instanceof Error ? e.message : String(e);
  } finally {
    zonesBusy.value = false;
  }
}
