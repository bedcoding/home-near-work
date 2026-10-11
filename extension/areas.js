// 지역(역 반경) 목록을 확장 저장소에 쓰는 공용 함수. 백그라운드·팝업·지도 스크립트가 같이 쓴다.
// 저장소 키
//   hnw-area-list   : 지역 전체 [{ id(대시보드 번호, 확장에서 새로 만든 것은 null), name, lat, lng, radiusM, enabled }]
//   hnw-areas       : 지도에 그릴 켜진 지역(naver.js가 읽음)
//   hnw-areas-edited: 확장에서 바꾸고 아직 대시보드에 못 보낸 시각(없으면 null)
//   hnw-stations    : 대시보드의 역 목록(팝업 '역으로 추가'·지도에서 찍을 때 이름 제안에 씀)

/** 목록 전체를 저장하고, 지도에 그릴 켜진 지역을 따로 둔다. edited: 확장에서 바꾼 시각 또는 null(대시보드와 맞춤). */
async function hnwWriteAreas(list, edited) {
  const areas = list.map(({ id = null, name, lat, lng, radiusM, enabled = true }) => ({ id, name, lat, lng, radiusM, enabled }));
  await chrome.storage.local.set({
    'hnw-area-list': areas,
    'hnw-areas': areas.filter((a) => a.enabled).map(({ name, lat, lng, radiusM }) => ({ name, lat, lng, radiusM })),
    'hnw-areas-edited': edited,
  });
  return areas;
}

/** 지금 지역 목록. 예전 저장 형식(켜진 지역만)만 있으면 그것으로 시작한다. */
async function hnwReadAreas() {
  const got = await chrome.storage.local.get(['hnw-area-list', 'hnw-areas']);
  if (Array.isArray(got['hnw-area-list'])) return got['hnw-area-list'];
  return (got['hnw-areas'] || []).map((a) => ({ id: null, enabled: true, ...a }));
}

/** 확장에서 지역을 바꾼다. 저장하고, 대시보드와 맞추라고 백그라운드에 알린다. */
async function hnwEditAreas(change) {
  const areas = await hnwWriteAreas(change(await hnwReadAreas()), new Date().toISOString());
  chrome.runtime.sendMessage({ type: 'sync-areas' }).catch(() => {});
  return areas;
}

const hnwRadiusText = (m) => (m >= 1000 ? `${m / 1000}km` : `${m}m`);
const HNW_RADII = [300, 500, 800, 1000, 1500, 2000, 3000];

/** 두 좌표 사이 거리(m). */
function hnwDistanceM(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}
