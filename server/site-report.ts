import { manwon } from '../shared/format.js';
import type { SiteCaptureLine, SiteCaptureReport, SiteReport } from '../shared/types.js';
import { kbAreaCount, naverClusterCounts } from './capture-news.js';
import { parseDabangRoomList } from './dabang-parse.js';
import * as store from './db.js';
import { zigbangStationName } from './link-hints.js';
import { parseNaverList } from './naver-parse.js';
import { parseZigbangStationIds } from './zigbang-parse.js';

// 사이트별 탭의 요약(GET /api/site-report): 소스마다 최근 조회 기록, 크롬 확장 사이트마다 사이트 화면이 센 수와 매물 내용까지 받은 수.

/** 크롬 확장으로 받는 사이트 */
const BROWSE_SITES = ['naver', 'dabang', 'zigbang', 'kbland', 'hogangnono', 'daangn'];
/** 받은 날을 셀 기간(일) */
const DAYS = 14;
/** 소스마다 보일 조회 기록 수 */
const HISTORY_MAX = 12;
/** 조회 기록을 찾을 범위(최근 조회 수) */
const RUNS_LOOKBACK = 200;

/** ISO 시각의 한국 날짜('2026-10-21') */
const kstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
/** 한국 날짜가 시작하는 시각(ISO) */
const dayStart = (day: string) => new Date(`${day}T00:00:00+09:00`).toISOString();
/** '10.21' */
const dayText = (day: string) => day.slice(5).replace('-', '.');
const n = (v: number) => v.toLocaleString('ko-KR');
const json = (text: string | null | undefined): any => {
  try {
    return JSON.parse(text ?? 'null');
  } catch {
    return null;
  }
};

export function siteReport(): SiteReport {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  const captures: SiteReport['captures'] = {};
  for (const site of BROWSE_SITES) captures[site] = captureReport(site, since);
  return { history: history(), captures };
}

/** 소스마다 그 소스가 들어간 조회(새것부터). 조회 중인 것은 뺀다. */
function history(): SiteReport['history'] {
  const out: SiteReport['history'] = {};
  for (const r of store.listRuns(RUNS_LOOKBACK)) {
    if (r.status === 'running' || !r.summary) continue;
    for (const s of r.summary.sources) {
      const rows = (out[s.source] ??= []);
      if (rows.length >= HISTORY_MAX) continue;
      rows.push({
        runId: r.id,
        at: r.finishedAt ?? r.startedAt,
        auto: r.auto,
        status: s.status,
        fetched: s.fetched,
        kept: s.kept,
        newCount: s.newCount,
        priceChanged: s.priceChanged,
        error: s.error ?? null,
      });
    }
  }
  return out;
}

function captureReport(site: string, since: string): SiteCaptureReport {
  const times = store.captureTimes(site, since);
  const byDay = new Map<string, number>();
  for (const at of times) byDay.set(kstDay(at), (byDay.get(kstDay(at)) ?? 0) + 1);
  const days = [...byDay].sort((a, b) => b[0].localeCompare(a[0])).map(([day, responses]) => ({ day, responses }));
  const lastAt = store.captureCountsBySite().find((c) => c.site === site)?.lastAt ?? null;
  const lines =
    site === 'naver' ? naverLines()
    : site === 'dabang' ? dabangLines()
    : site === 'zigbang' ? zigbangLines()
    : site === 'kbland' ? kbLines()
    : site === 'hogangnono' ? hogangnonoLines()
    : site === 'daangn' ? daangnLines()
    : [];
  return { lastAt, days, lines };
}

const NAVER_TRADES: Record<string, string> = { A1: '매매', B1: '전세', B2: '월세', B3: '단기' };
/** 네이버 매물 목록 순서(articleSortType) 이름. 모르는 값은 그대로 보인다. */
const NAVER_SORTS: Record<string, string> = { RANKING_DESC: '랭킹순' };

/** 원 단위 범위 → '보증금 3억 이하' 같은 글자. 제한이 없으면 null. */
function wonRange(name: string, range: unknown): string | null {
  const { min, max } = (range ?? {}) as { min?: unknown; max?: unknown };
  const lo = typeof min === 'number' && min > 0 ? manwon(Math.round(min / 10000)) : null;
  const hi = typeof max === 'number' && max > 0 && max < 9e11 ? manwon(Math.round(max / 10000)) : null;
  if (lo && hi) return `${name} ${lo}~${hi}`;
  if (hi) return `${name} ${hi} 이하`;
  if (lo) return `${name} ${lo} 이상`;
  return null;
}

/** 네이버 요청의 filter → '월세, 전세, 보증금 3억 이하, 월세 50만 이하, 매물 종류 15가지' */
function naverFilterText(filter: any): string {
  const parts: string[] = [];
  const trades: string[] = Array.isArray(filter?.tradeTypes) ? filter.tradeTypes.map((t: string) => NAVER_TRADES[t] ?? t) : [];
  if (trades.length) parts.push(trades.join(', '));
  for (const [key, name] of [['dealPrice', '매매가'], ['warrantyPrice', '보증금'], ['rentPrice', '월세']] as const) {
    const text = wonRange(name, filter?.[key]);
    if (text) parts.push(text);
  }
  if (Array.isArray(filter?.realEstateTypes) && filter.realEstateTypes.length) parts.push(`매물 종류 ${filter.realEstateTypes.length}가지`);
  return parts.join(', ') || '조건 없음';
}

/** 네이버: 지도 안 매물 수(boundedArticlesCount), 동그라미(articleClusters), 동그라미를 눌러 받은 목록(clusteredArticles, 마지막으로 누른 날) */
function naverLines(): SiteCaptureLine[] {
  const lines: SiteCaptureLine[] = [];
  const bounded = store.latestCapture('naver', '%/article/boundedArticlesCount%');
  const total = json(bounded?.body)?.result?.totalCount;
  if (bounded && typeof total === 'number') {
    lines.push({
      label: '지도 안 매물',
      value: `${n(total)}건`,
      at: bounded.at,
      tip: `마지막으로 연 네이버 지도 화면 안에 네이버가 센 매물 수. 고른 조건: ${naverFilterText(json(bounded.requestBody)?.filter)}. 지도를 열기만 해도 이 수는 오지만 매물 하나하나(가격, 면적)는 동그라미를 눌러 목록이 떠야 옵니다.`,
    });
  }
  const clustersAt = store.latestCapture('naver', '%/article/map/articleClusters%');
  const clusters = clustersAt ? naverClusterCounts(clustersAt.requestBody, clustersAt.body) : null;
  if (clustersAt && clusters) {
    const sum = clusters.clusters.reduce((a, c) => a + c.count, 0);
    lines.push({
      label: '동그라미',
      value: `${n(clusters.clusters.length)}개, 매물 ${n(sum)}건`,
      at: clustersAt.at,
      tip: "지도를 열면 동그라미마다 매물 수만 옵니다. 전에 본 수보다 늘어난 만큼을 새 매물로 세어 알림(네이버 +N)과 동그라미 위 빨간 '새 N'으로 보입니다. 늘어난 매물의 내용은 그 동그라미를 눌러야 들어옵니다.",
    });
  }
  // 지도 아래 '매물 N' 목록(boundedArticles). 끝에 %를 붙이면 boundedArticlesCount도 걸린다.
  const lastBounded = store.latestCapture('naver', '%/article/boundedArticles');
  if (lastBounded) {
    const day = kstDay(lastBounded.at);
    const ids = new Set<string>();
    let pages = 0;
    for (const r of store.capturesSince('naver', '%/article/boundedArticles', dayStart(day))) {
      const list = parseNaverList(r.body);
      if (!list) continue;
      pages++;
      for (const item of list.items) ids.add(item.listing.sourceId);
    }
    const listTotal = parseNaverList(lastBounded.body)?.totalCount ?? null;
    const sort = json(lastBounded.requestBody)?.articlePagingRequest?.articleSortType;
    const sortName = typeof sort === 'string' ? (NAVER_SORTS[sort] ?? sort) : '모름';
    lines.push({
      label: '목록에서 받은 매물',
      value: `${n(ids.size)}건`,
      at: lastBounded.at,
      tip: `${dayText(day)}에 지도 아래 '매물 N' 목록에서 받은 매물(${pages}쪽${listTotal != null ? `, 마지막 목록 전체 ${n(listTotal)}건` : ''}, 순서 ${sortName}). 목록은 30개씩 오고 내릴 때마다 다음 30개가 옵니다. 최신순으로 두면 새로 올라온 매물이 먼저 옵니다.`,
      short: listTotal != null && ids.size < listTotal,
    });
  }
  const lastList = store.latestCapture('naver', '%/article/clusteredArticles%');
  if (!lastList) {
    lines.push({ label: '눌러서 받은 매물', value: '없음', at: '', tip: '동그라미를 눌러 받은 매물 목록이 아직(최근 응답 안에) 없습니다.', short: true });
    return lines;
  }
  const day = kstDay(lastList.at);
  const ids = new Set<string>();
  const totals = new Map<string, number>();
  for (const r of store.capturesSince('naver', '%/article/clusteredArticles%', dayStart(day))) {
    const list = parseNaverList(r.body);
    if (!list) continue;
    for (const item of list.items) ids.add(item.listing.sourceId);
    const clusterId = json(r.requestBody)?.clusterId;
    if (typeof clusterId === 'string' && list.totalCount != null) totals.set(clusterId, Math.max(totals.get(clusterId) ?? 0, list.totalCount));
  }
  const inClusters = [...totals.values()].reduce((a, b) => a + b, 0);
  lines.push({
    label: '눌러서 받은 매물',
    value: `${n(ids.size)}건`,
    at: lastList.at,
    tip: `${dayText(day)}에 동그라미 ${totals.size}곳을 눌러 받은 매물(그 동그라미들에 있던 매물 ${n(inClusters)}건). 동그라미를 누르면 30개씩 오고, 목록을 끝까지 내려야 나머지가 옵니다. 받은 매물만 대시보드에 들어옵니다.`,
    short: ids.size < inClusters,
  });
  return lines;
}

const DABANG_SELL: Record<string, string> = { MONTHLY_RENT: '월세', LEASE: '전세', SELL: '매매' };
const DABANG_ROOM: Record<string, string> = { ONE_ROOM: '원룸', TWO_ROOM: '투룸', THREE_ROOM: '쓰리룸', OFFICETEL: '오피스텔', APT: '아파트' };

/** 다방 주소의 filters → '월세, 전세, 원룸, 투룸, 보증금 5,000만 이하' */
function dabangFilterText(url: string): string {
  let f: any = null;
  try {
    f = JSON.parse(new URL(url).searchParams.get('filters') ?? 'null');
  } catch {
    return '조건 모름';
  }
  const parts: string[] = [];
  const list = (v: unknown, names: Record<string, string>) => (Array.isArray(v) ? v.map((x: string) => names[x] ?? x).join(', ') : '');
  const sells = list(f?.sellingTypeList, DABANG_SELL);
  const rooms = list(f?.roomTypeList, DABANG_ROOM);
  if (sells) parts.push(sells);
  if (rooms) parts.push(rooms);
  for (const [key, name] of [['depositRange', '보증금'], ['priceRange', '월세']] as const) {
    const max = f?.[key]?.max;
    if (typeof max === 'number' && max > 0 && max < 999999) parts.push(`${name} ${manwon(max)} 이하`);
  }
  return parts.join(', ') || '조건 없음';
}

/** 다방: 마지막 화면의 지도 범위 방 수와 그날 받은 방 수(목록은 한 번에 24개, 내리면 다음 쪽) */
function dabangLines(): SiteCaptureLine[] {
  const last = store.latestCapture('dabang', '%/room-list/%');
  const parsed = last ? parseDabangRoomList(last.body) : null;
  if (!last || !parsed) return [{ label: '방 목록', value: '없음', at: '', tip: '다방 화면이 받은 방 목록이 아직(최근 응답 안에) 없습니다.', short: true }];
  const day = kstDay(last.at);
  const seqs = new Set<string>();
  for (const r of store.capturesSince('dabang', '%/room-list/%', dayStart(day))) {
    for (const item of parseDabangRoomList(r.body)?.items ?? []) seqs.add(item.listing.sourceId);
  }
  const more = json(last.body)?.result?.hasMore === true;
  const lines: SiteCaptureLine[] = [];
  if (parsed.total != null) {
    lines.push({
      label: '지도 범위 방',
      value: `${n(parsed.total)}개`,
      at: last.at,
      tip: `마지막으로 본 다방 지도 범위의 방 수(다방이 셈). 고른 조건: ${dabangFilterText(last.url)}.`,
    });
  }
  lines.push({
    label: '받은 방',
    value: `${n(seqs.size)}개`,
    at: last.at,
    tip: `${dayText(day)}에 다방 화면이 받은 방 목록. 목록은 한 번에 24개씩 오고 목록을 내려야 다음 24개가 옵니다${more ? '(마지막 화면은 뒤에 더 있었음)' : ''}. 받은 방만 대시보드에 들어옵니다.`,
    short: more,
  });
  return lines;
}

/** 직방: 역 1km 안 방 번호(새 방 수는 이것으로 셈)와 그중 내용까지 받은 방 수 */
function zigbangLines(): SiteCaptureLine[] {
  const last = store.latestCapture('zigbang', '%/items/subways/%/onerooms%');
  const station = last ? parseZigbangStationIds(last.url, last.body) : null;
  if (!last || !station) return [{ label: '역 방 번호', value: '없음', at: '', tip: '직방 원룸 역 화면이 받은 방 번호가 아직(최근 응답 안에) 없습니다.', short: true }];
  const name = zigbangStationName(station.subwayId) ?? `역 번호 ${station.subwayId}`;
  const known = store.sourceIdsOf('zigbang');
  const have = station.ids.filter((id) => known.has(String(id))).length;
  return [
    {
      label: '역 1km 방',
      value: `${n(station.ids.length)}개`,
      at: last.at,
      tip: `${name} 원룸 화면이 받은 역 1km 안 방 번호(직방이 줌). 번호는 다 와서 새 방 수는 빠짐없이 셉니다.`,
    },
    {
      label: '내용 받은 방',
      value: `${n(have)}개`,
      at: last.at,
      tip: `그 번호 중 가격과 면적까지 받은 방. 내용은 화면 목록에 보인 방만 오고(한 번에 15개쯤), 목록을 내려야 더 옵니다. 내용을 받은 방만 대시보드에 들어옵니다.`,
      short: have < station.ids.length,
    },
  ];
}

/** KB: 마지막으로 본 날의 법정동 매물 수(매물 목록은 받지 않음) */
function kbLines(): SiteCaptureLine[] {
  const last = store.latestCapture('kbland', '%/propList/stutCdFilter/count%');
  if (!last) return [{ label: '동 매물 수', value: '없음', at: '', tip: 'KB부동산 화면이 받은 동 매물 수가 아직(최근 응답 안에) 없습니다.' }];
  const byDong = new Map<string, number>();
  for (const r of store.capturesSince('kbland', '%/propList/stutCdFilter/count%', dayStart(kstDay(last.at)))) {
    const c = kbAreaCount(r.requestBody, r.body);
    if (c) byDong.set(c.dong, c.count);
  }
  const dongs = [...byDong].map(([dong, count]) => `${dong} ${n(count)}`);
  return [
    {
      label: '동 매물 수',
      value: dongs.slice(0, 3).join(', ') + (dongs.length > 3 ? ` 외 ${dongs.length - 3}곳` : ''),
      at: last.at,
      tip: `KB부동산 화면이 받은 법정동 매물 수(KB가 셈)${dongs.length > 3 ? `: ${dongs.join(', ')}` : ''}. 매물 목록은 받지 않아 대시보드에 매물로 들어오지 않고, 수가 늘면 새 매물 알림만 갑니다.`,
    },
  ];
}

/** 호갱노노: 아파트 단지 화면이라 매물 목록이 없다 */
function hogangnonoLines(): SiteCaptureLine[] {
  const last = store.latestCapture('hogangnono', '%/api/apt/bounding%');
  const apts = json(last?.body)?.data;
  return [
    {
      label: '받은 것',
      value: Array.isArray(apts) ? `아파트 단지 ${n(apts.length)}곳` : '없음',
      at: last?.at ?? '',
      tip: '호갱노노는 아파트 단지와 시세 화면이라 전월세 매물 목록이 오지 않습니다. 바로 가기와 단지 번호를 배우는 데만 씁니다.',
    },
  ];
}

/** 당근: 지도 매물 수와 역 근처 매물 목록(아직 매물로 읽지 않음) */
function daangnLines(): SiteCaptureLine[] {
  const lines: SiteCaptureLine[] = [];
  const rows = store.capturesSince('daangn', '%graphql%', new Date(Date.now() - DAYS * 86400000).toISOString()).reverse();
  for (const r of rows) {
    const total = json(r.body)?.data?.count;
    if (typeof total !== 'number') continue;
    lines.push({ label: '지도 매물 수', value: `${n(total)}건`, at: r.at, tip: '당근 부동산 지도 화면이 받은 매물 수(당근이 셈).' });
    break;
  }
  for (const r of rows) {
    const conn = json(r.body)?.data?.subwayStationArticleConnection;
    if (!Array.isArray(conn?.edges)) continue;
    lines.push({
      label: '받은 매물',
      value: `${n(conn.edges.length)}건, 매물로 안 읽음`,
      at: r.at,
      tip: '역 근처 매물 목록이 10개씩 오는데, 상가와 사무실이 섞여 있어 아직 대시보드 매물로 읽지 않습니다.',
      short: true,
    });
    break;
  }
  if (!lines.length) lines.push({ label: '받은 것', value: '없음', at: '', tip: '당근 부동산 화면이 받은 매물 데이터가 아직(최근 응답 안에) 없습니다.' });
  return lines;
}
