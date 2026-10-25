<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NOTICE_SOURCE_LABEL, type AppState, type ListingView, type NoticeSourceId, type NoticeSourceStatus, type NoticeView, type SiteReport, type SourceId } from '../../../shared/types';
import { priceText } from '../../../shared/format';
import { api } from '../api';
import { ago, dateTime, distanceM, pyeong } from '../format';
import { KIND_LABEL, kindOf } from '../kinds';
import { NOTICE_HOME } from '../notices';
import type { SiteLink } from '../siteLinks';
import CountTooltip from './CountTooltip.vue';

// 사이트별 탭: 사이트를 하나 고르면 모은 매물 수, 마지막으로 받은 때, 사이트 화면이 센 수와 받은 수, 조회 기록, 받은 매물(또는 공고)을 보인다.
const props = defineProps<{
  state: AppState;
  links: SiteLink[];
  extReady: boolean;
  /** 모든 매물(사라진 것 포함) */
  listings: ListingView[];
  /** 모든 공고와 곳별 마지막 수집 결과 */
  notices: NoticeView[];
  noticeStatus: Partial<Record<NoticeSourceId, NoticeSourceStatus>>;
}>();
const emit = defineEmits<{ openAll: [] }>();

type Way = 'browse' | 'auto' | 'notice';
/** source: 이 사이트 매물의 소스(매물로 읽지 않는 곳과 공고는 null). home: 바로 가기 줄에 없는 곳을 누르면 여는 주소 */
interface Site {
  id: string;
  name: string;
  way: Way;
  source: SourceId | null;
  home?: string;
}

const BROWSE: Site[] = [
  { id: 'naver', name: '네이버 부동산', way: 'browse', source: 'naver' },
  { id: 'dabang', name: '다방', way: 'browse', source: 'dabang' },
  { id: 'zigbang', name: '직방', way: 'browse', source: 'zigbang' },
  { id: 'kbland', name: 'KB부동산', way: 'browse', source: null },
  { id: 'hogangnono', name: '호갱노노', way: 'browse', source: null },
  { id: 'daangn', name: '당근부동산', way: 'browse', source: null },
];
const AUTO: Site[] = [
  { id: 'peterpanz', name: '피터팬', way: 'auto', source: 'peterpanz' },
  { id: 'ziptoss', name: '집토스', way: 'auto', source: 'ziptoss' },
  { id: 'gobang', name: '고방', way: 'auto', source: 'gobang', home: 'https://gobang.kr/gosi' },
  { id: 'betterliving', name: '에피소드(코리빙)', way: 'auto', source: 'betterliving', home: 'https://betterliving.kr/find' },
  { id: 'mangrove', name: '맹그로브(코리빙)', way: 'auto', source: 'mangrove', home: 'https://mangrove.city' },
  { id: 'celib', name: '셀립(코리빙)', way: 'auto', source: 'celib', home: 'https://celib.kr' },
  { id: 'courtauction', name: '법원경매', way: 'auto', source: 'courtauction' },
  { id: 'onbid', name: '온비드 공매', way: 'auto', source: 'onbid', home: 'https://www.onbid.co.kr/op/cltrpbancinf/cltr/cltrmapsrch/CltrMapSrchController/mvmnCltrMapSrchClg.do' },
];
const NOTICE_SOURCES: NoticeSourceId[] = [
  'applyhome', 'shsale', 'lhsale', 'lhshop', 'lhland', 'lhfirst', 'sh', 'lh', 'myhome', 'hugjeonse', 'hugtrust', 'gobang',
  'kbtrust', 'koreit', 'reitpia', 'ktrust', 'hanatrust', 'shinhantrust', 'mghat', 'shinyoung', 'wooriat', 'daishin', 'kyobotrust', 'koramco',
];
/** 공고 곳 id는 매물 사이트(고방)와 겹칠 수 있어 앞에 'notice:'를 붙인다. */
const NOTICES: Site[] = NOTICE_SOURCES.map((id) => ({ id: `notice:${id}`, name: NOTICE_SOURCE_LABEL[id], way: 'notice', source: null, home: NOTICE_HOME[id] }));
const GROUPS: { way: Way; name: string; sites: Site[] }[] = [
  { way: 'browse', name: '직접 볼 때 받음', sites: BROWSE },
  { way: 'auto', name: '조회하기로 모음', sites: AUTO },
  { way: 'notice', name: '공고', sites: NOTICES },
];
const ALL = GROUPS.flatMap((g) => g.sites);
const WAY_TIP: Record<Way, string> = {
  browse: '크롬 확장을 켠 채 이 사이트를 직접 볼 때 그 화면이 받은 데이터만 들어옵니다. 프로그램이 이 사이트를 스스로 열거나 누르지 않습니다.',
  auto: "'조회하기'와 자동 확인이 이 사이트를 열어 켜 둔 지역 근처 매물을 모읍니다.",
  notice: "'조회하기', 자동 확인, 매일 공고 확인이 이 곳의 공고 목록을 모읍니다.",
};

const n = (v: number) => v.toLocaleString('ko-KR');
/** '2026-10-21' → '10.21' */
const dayText = (day: string) => day.slice(5).replace('-', '.');
const noticeId = (s: Site) => s.id.replace(/^notice:/, '') as NoticeSourceId;

const PICK_KEY = 'hnw-site-picked';
function readPick(): string {
  try {
    const v = localStorage.getItem(PICK_KEY);
    if (v && ALL.some((s) => s.id === v)) return v;
  } catch {
    // 저장소를 못 쓰면 처음 값
  }
  return 'naver';
}
const picked = ref(readPick());
const site = computed(() => ALL.find((s) => s.id === picked.value) ?? ALL[0]);
watch(picked, (v) => {
  try {
    localStorage.setItem(PICK_KEY, v);
  } catch {
    // 저장소를 못 쓰면 기억하지 않는다
  }
});

const report = ref<SiteReport | null>(null);
const reportError = ref<string | null>(null);
async function loadReport() {
  try {
    report.value = await api.siteReport();
    reportError.value = null;
  } catch (e) {
    const message = (e as Error).message;
    // 화면만 새로 빌드하고 서버는 예전 것이면 이 주소가 없다(404).
    reportError.value = message.includes('(404)') ? '대시보드를 다시 켜면 보입니다' : message;
  }
}
let timer = 0;
onMounted(() => {
  void loadReport();
  timer = window.setInterval(() => void loadReport(), 20000);
});
onBeforeUnmount(() => window.clearInterval(timer));

const WEEK = 7 * 86400000;
const areas = computed(() => props.state.areas.filter((a) => a.enabled));
/** 좌표가 켜 둔 지역 중 하나의 반경 안. 좌표를 모르면 null. */
const insideOf = (l: ListingView) =>
  l.lat == null || l.lng == null ? null : areas.value.some((a) => distanceM(a.lat, a.lng, l.lat!, l.lng!) <= a.radiusM);

interface Stats {
  active: number;
  inside: number;
  fresh: number;
  gone: number;
  lastSeen: string | null;
}
/** 소스마다 지금 있는 매물, 그중 반경 안, 7일 안에 처음 본 것, 사라진 것, 마지막으로 받은 때 */
const stats = computed(() => {
  const out = new Map<string, Stats>();
  const now = Date.now();
  for (const l of props.listings) {
    let s = out.get(l.source);
    if (!s) out.set(l.source, (s = { active: 0, inside: 0, fresh: 0, gone: 0, lastSeen: null }));
    if (l.status === 'active') {
      s.active++;
      if (insideOf(l)) s.inside++;
      if (now - new Date(l.firstSeenAt).getTime() < WEEK) s.fresh++;
    } else s.gone++;
    if (!s.lastSeen || l.lastSeenAt > s.lastSeen) s.lastSeen = l.lastSeenAt;
  }
  return out;
});
const EMPTY: Stats = { active: 0, inside: 0, fresh: 0, gone: 0, lastSeen: null };

interface RowInfo {
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  count: string;
  when: string;
  title: string;
}
const OLD_DAYS = 8;
const daysSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 86400000;
/** 조회 결과 글자와 색: 일부만 읽은 것('일부를 보지 못함: …')은 실패와 따로 주황으로 */
const partial = (error: string | null) => !!error?.startsWith('일부를 보지 못함');
const resultText = (status: string, error: string | null) =>
  status === 'ok' ? '성공' : error === '중단함' ? '중단' : partial(error) ? '일부 빠짐' : '실패';
const resultTone = (status: string, error: string | null): RowInfo['tone'] =>
  status === 'ok' ? 'ok' : error === '중단함' ? 'muted' : partial(error) ? 'warn' : 'bad';

/** 왼쪽 목록 한 줄: 상태 점(받은 지 오래됐으면 주황, 실패면 빨강), 매물이나 공고 수, 마지막으로 받은 때 */
function rowInfo(s: Site): RowInfo {
  if (s.way === 'notice') {
    const st = props.noticeStatus[noticeId(s)];
    if (!st) return { tone: 'muted', count: '', when: '안 함', title: '아직 모은 적 없음' };
    if (!st.ok) return { tone: 'bad', count: '실패', when: ago(st.at), title: st.error ?? '실패' };
    return { tone: daysSince(st.at) > OLD_DAYS ? 'warn' : 'ok', count: n(st.count), when: ago(st.at), title: `마지막으로 모은 때 ${dateTime(st.at)}` };
  }
  const count = s.source ? n(stats.value.get(s.source)?.active ?? 0) : '';
  if (s.way === 'browse') {
    const c = props.state.captureSites.find((x) => x.site === s.id);
    if (!c?.lastAt) return { tone: 'muted', count, when: '안 봄', title: '크롬 확장이 이 사이트 데이터를 아직 받지 않음' };
    return { tone: daysSince(c.lastAt) > 3 ? 'warn' : 'ok', count, when: ago(c.lastAt), title: `크롬 확장이 마지막으로 받은 때 ${dateTime(c.lastAt)}` };
  }
  const r = props.state.lastBySource[s.source!];
  if (!r) return { tone: 'muted', count, when: '안 함', title: '아직 조회 안 함' };
  if (r.status !== 'ok') return { tone: resultTone(r.status, r.error), count, when: ago(r.at), title: r.error ?? '실패' };
  return { tone: daysSince(r.at) > OLD_DAYS ? 'warn' : 'ok', count, when: ago(r.at), title: `마지막 조회 ${dateTime(r.at)}, 지역 안 매물 ${n(r.kept)}건` };
}
const rows = computed(() => new Map(ALL.map((s) => [s.id, rowInfo(s)])));

const WAY_NAME: Record<Way, string> = { browse: '직접 볼 때 받음', auto: '조회하기로 모음', notice: '공고' };
const siteUrl = computed(() => {
  const s = site.value;
  if (s.way === 'notice') return s.home ?? null;
  return props.links.find((l) => l.id === s.id)?.url ?? s.home ?? null;
});
const st = computed(() => (site.value.source ? stats.value.get(site.value.source) ?? EMPTY : EMPTY));
const capture = computed(() => report.value?.captures[site.value.id] ?? null);
const runs = computed(() => (site.value.source ? report.value?.history[site.value.source] ?? [] : []));

// 받은 매물 표: 지금 있는 것부터 마지막으로 받은 때 최신 순, 60줄씩
const showGone = ref(false);
const PAGE = 60;
const limit = ref(PAGE);
watch(picked, () => {
  limit.value = PAGE;
  showGone.value = false;
});
const listRows = computed(() => {
  const source = site.value.source;
  if (!source) return [];
  return props.listings
    .filter((l) => l.source === source && (showGone.value || l.status === 'active'))
    .sort((a, b) => (a.status === b.status ? b.lastSeenAt.localeCompare(a.lastSeenAt) : a.status === 'active' ? -1 : 1));
});
const priceCell = (l: ListingView) => l.prices.slice(0, 2).map(priceText).join(', ') + (l.prices.length > 2 ? ` 외 ${l.prices.length - 2}` : '');
const insideCell = (l: ListingView) => {
  const v = insideOf(l);
  return v == null ? '' : v ? '안' : '밖';
};

// 공고 곳: 지금 올라온 것, 새 공고, 모은 공고와 목록(지금 올라온 것부터 게시일 최신 순)
const siteNotices = computed(() => {
  if (site.value.way !== 'notice') return [];
  const id = noticeId(site.value);
  return props.notices
    .filter((x) => x.source === id)
    .sort((a, b) => (a.current === b.current ? (b.postedAt ?? b.firstSeenAt).localeCompare(a.postedAt ?? a.firstSeenAt) : a.current ? -1 : 1));
});
const noticeStat = computed(() => (site.value.way === 'notice' ? props.noticeStatus[noticeId(site.value)] ?? null : null));
</script>

<template>
  <section class="sites-tab">
    <nav class="site-list" aria-label="사이트">
      <div v-for="g in GROUPS" :key="g.way" class="group">
        <div class="group-head">
          <h3><CountTooltip :text="WAY_TIP[g.way]" :max-width="360"><span>{{ g.name }}</span></CountTooltip></h3>
          <button
            v-if="g.way === 'browse'" class="btn btn-sm" :disabled="!extReady"
            :title="extReady ? '켜 둔 사이트를 새 창 하나에 엽니다' : '크롬 확장이 있어야 합니다'" @click="emit('openAll')"
          >
            한 번에 열기
          </button>
        </div>
        <button
          v-for="s in g.sites" :key="s.id" type="button" class="site" :class="{ on: s.id === picked }" :aria-pressed="s.id === picked"
          :title="rows.get(s.id)?.title" @click="picked = s.id"
        >
          <span class="dot" :class="rows.get(s.id)?.tone" aria-hidden="true"></span>
          <span class="name">{{ s.name }}</span>
          <span class="count">{{ rows.get(s.id)?.count }}</span>
          <span class="when" :class="rows.get(s.id)?.tone">{{ rows.get(s.id)?.when }}</span>
        </button>
      </div>
    </nav>

    <div class="site-detail">
      <header class="detail-head">
        <h2>{{ site.name }}</h2>
        <CountTooltip :text="WAY_TIP[site.way]" :max-width="360"><span class="way">{{ WAY_NAME[site.way] }}</span></CountTooltip>
        <a v-if="siteUrl" class="btn btn-sm" :href="siteUrl" target="_blank" rel="noopener">열기 ↗</a>
      </header>

      <div v-if="site.source" class="stats">
        <div class="stat"><b>{{ n(st.active) }}</b><small>지금 있는 매물</small></div>
        <div class="stat"><b>{{ n(st.inside) }}</b><small>지역 반경 안</small></div>
        <div class="stat"><b>{{ n(st.fresh) }}</b><small>7일 안에 처음 봄</small></div>
        <div class="stat"><b>{{ n(st.gone) }}</b><small>사라짐</small></div>
        <div class="stat"><b>{{ st.lastSeen ? ago(st.lastSeen) : '-' }}</b><small>마지막으로 받음</small></div>
      </div>
      <div v-else-if="site.way === 'notice'" class="stats">
        <div class="stat"><b>{{ n(siteNotices.filter((x) => x.current).length) }}</b><small>지금 올라온 공고</small></div>
        <div class="stat"><b>{{ n(siteNotices.filter((x) => x.isNew).length) }}</b><small>새 공고</small></div>
        <div class="stat"><b>{{ n(siteNotices.length) }}</b><small>모은 공고</small></div>
        <div class="stat">
          <b :class="{ bad: noticeStat && !noticeStat.ok }" :title="noticeStat?.error ?? undefined">{{ noticeStat ? (noticeStat.ok ? ago(noticeStat.at) : '실패') : '-' }}</b>
          <small>마지막으로 모음</small>
        </div>
      </div>

      <div v-if="site.way === 'browse'" class="block">
        <h3>사이트 화면</h3>
        <p v-if="reportError" class="bad">{{ reportError }}</p>
        <ul v-else-if="capture" class="lines">
          <li v-for="line in capture.lines" :key="line.label">
            <CountTooltip :text="line.tip" :max-width="440"><span class="label">{{ line.label }}</span></CountTooltip>
            <b class="value" :class="{ short: line.short }">{{ line.value }}</b>
            <span class="at">{{ line.at ? dateTime(line.at) : '' }}</span>
          </li>
        </ul>
        <div v-if="capture?.days.length" class="days">
          <CountTooltip text="그날 크롬 확장이 이 사이트에서 받은 응답 수(모든 사이트를 합쳐 최근 3,000개까지 남김)" :max-width="360">
            <span class="days-label">받은 날</span>
          </CountTooltip>
          <span v-for="d in capture.days" :key="d.day" class="day">{{ dayText(d.day) }} <small>{{ n(d.responses) }}</small></span>
        </div>
      </div>

      <div v-if="runs.length" class="block">
        <h3>
          <CountTooltip
            :text="site.way === 'browse' ? '크롬 확장이 받은 매물을 하루에 한 줄로 묶은 기록. 받음: 그날 받은 매물, 지역 안: 그중 켜 둔 지역 근처에 남긴 매물' : '받음: 사이트에서 받은 매물, 지역 안: 그중 켜 둔 지역 근처에 남긴 매물'"
            :max-width="380"
          >
            <span>조회 기록</span>
          </CountTooltip>
        </h3>
        <div class="table-wrap">
          <table class="runs">
            <thead>
              <tr><th>시각</th><th>결과</th><th class="num">받음</th><th class="num">지역 안</th><th class="num">신규</th><th class="num">가격 변동</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in runs" :key="r.runId">
                <td class="nowrap">{{ dateTime(r.at) }}<span v-if="r.auto" class="muted"> 자동</span></td>
                <td :class="resultTone(r.status, r.error)" :title="r.error ?? undefined">{{ resultText(r.status, r.error) }}</td>
                <td class="num">{{ n(r.fetched) }}</td>
                <td class="num">{{ n(r.kept) }}</td>
                <td class="num">{{ r.newCount ? n(r.newCount) : '' }}</td>
                <td class="num">{{ r.priceChanged ? n(r.priceChanged) : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="site.source" class="block">
        <div class="block-head">
          <h3>받은 매물 <small>{{ n(listRows.length) }}건</small></h3>
          <label class="check"><input v-model="showGone" type="checkbox" /> 사라진 것도</label>
        </div>
        <p v-if="!listRows.length" class="muted">없음</p>
        <div v-else class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>가격</th><th class="num">평</th><th>유형</th><th>위치</th>
                <th><CountTooltip text="켜 둔 지역 중 하나의 반경 안이면 '안'" :max-width="280"><span>반경</span></CountTooltip></th>
                <th>처음 봄</th><th>마지막</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in listRows.slice(0, limit)" :key="l.id" :class="{ gone: l.status === 'gone' }">
                <td>
                  <span v-if="l.isNew" class="chip chip-new">신규</span>
                  <span v-else-if="l.status === 'gone'" class="chip chip-muted">사라짐</span>
                  {{ priceCell(l) }}
                </td>
                <td class="num">{{ l.areaM2 ? pyeong(l.areaM2) : '' }}</td>
                <td class="nowrap" :title="l.buildingType ?? undefined">{{ KIND_LABEL[kindOf(l)] }}</td>
                <td class="place" :title="l.address ?? undefined">{{ l.dong ?? l.address ?? '' }}</td>
                <td>{{ insideCell(l) }}</td>
                <td class="nowrap" :title="dateTime(l.firstSeenAt)">{{ ago(l.firstSeenAt) }}</td>
                <td class="nowrap" :title="dateTime(l.lastSeenAt)">{{ ago(l.lastSeenAt) }}</td>
                <td><a v-if="l.url" :href="l.url" target="_blank" rel="noopener">원본 ↗</a></td>
              </tr>
            </tbody>
          </table>
        </div>
        <button v-if="listRows.length > limit" class="btn btn-sm more" @click="limit += PAGE">더 보기</button>
      </div>

      <div v-if="site.way === 'notice'" class="block">
        <h3>모은 공고</h3>
        <p v-if="!siteNotices.length" class="muted">없음</p>
        <ul v-else class="notice-rows">
          <li v-for="x in siteNotices.slice(0, limit)" :key="x.id" :class="{ past: !x.current }">
            <span v-if="x.isNew" class="chip chip-new">신규</span>
            <a v-if="x.url" :href="x.url" target="_blank" rel="noopener">{{ x.title }}</a><span v-else>{{ x.title }}</span>
            <span class="muted">{{ [x.status, x.postedAt].filter(Boolean).join(', ') }}</span>
          </li>
        </ul>
        <button v-if="siteNotices.length > limit" class="btn btn-sm more" @click="limit += PAGE">더 보기</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sites-tab { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 14px; align-items: start; }
.site-list { display: grid; gap: 12px; position: sticky; top: 12px; max-height: calc(100vh - 140px); overflow-y: auto; }
.group { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 8px; display: grid; gap: 2px; }
.group-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 6px 6px; }
h3 { margin: 0; font-size: 15px; display: flex; align-items: baseline; gap: 8px; }
h3 small { font-size: 13px; font-weight: 500; color: var(--muted); }
.site { display: grid; grid-template-columns: 10px minmax(0, 1fr) 52px 54px; align-items: center; gap: 8px; min-height: 36px; padding: 0 8px; border: 0; border-radius: 8px; background: none; color: var(--ink); text-align: left; font: inherit; font-size: 14px; cursor: pointer; }
.site:hover { background: var(--surface-2); }
.site.on { background: var(--surface-2); font-weight: 700; }
.site .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site .count { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-2); }
.site .when { text-align: right; font-size: 12px; color: var(--muted); white-space: nowrap; }
.site .when.warn { color: var(--up); font-weight: 700; }
.site .when.bad { color: var(--new); font-weight: 700; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line-strong); }
.dot.ok { background: var(--down); }
.dot.warn { background: var(--up); }
.dot.bad { background: var(--new); }

.site-detail { display: grid; gap: 12px; min-width: 0; }
.detail-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.detail-head h2 { margin: 0; font-size: 20px; }
.detail-head .way { font-size: 13px; color: var(--muted); }
.detail-head .btn { margin-left: auto; }
.stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.stat { display: grid; gap: 2px; padding: 10px 14px; border-left: 1px solid var(--line); }
.stat:first-child { border-left: 0; }
.stat b { font-size: 20px; font-variant-numeric: tabular-nums; }
.stat small { font-size: 12px; color: var(--muted); }
.block { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 12px 14px; display: grid; gap: 10px; min-width: 0; }
.block-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.lines { list-style: none; margin: 0; padding: 0; display: grid; }
.lines li { display: grid; grid-template-columns: 140px minmax(0, 1fr) auto; align-items: baseline; gap: 12px; min-height: 34px; border-top: 1px solid var(--line); padding-top: 6px; }
.lines li:first-child { border-top: 0; padding-top: 0; }
.lines .label { color: var(--ink-2); }
.lines .value { font-size: 16px; font-variant-numeric: tabular-nums; }
.lines .value.short { color: var(--up); }
.lines .at { font-size: 12px; color: var(--muted); white-space: nowrap; }
.days { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; }
.days-label { color: var(--muted); margin-right: 4px; }
.day { padding: 2px 8px; border-radius: 999px; background: var(--surface-2); white-space: nowrap; }
.day small { color: var(--muted); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 600; color: var(--muted); padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.nowrap { white-space: nowrap; }
.place { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
tr.gone td { color: var(--muted); }
.chip { margin-right: 4px; }
.check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-2); cursor: pointer; }
.more { justify-self: start; }
.notice-rows { list-style: none; margin: 0; padding: 0; display: grid; }
.notice-rows li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; padding: 6px 0; border-top: 1px solid var(--line); font-size: 14px; }
.notice-rows li:first-child { border-top: 0; }
.notice-rows li.past { color: var(--muted); }
.notice-rows .muted, .muted { color: var(--muted); font-size: 13px; }
.bad { color: var(--new); font-weight: 700; }
.warn { color: var(--up); font-weight: 700; }
@media (max-width: 960px) {
  .sites-tab { grid-template-columns: 1fr; }
  .site-list { position: static; max-height: none; }
  .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .stat:nth-child(4) { border-left: 0; }
  .stat:nth-child(n + 4) { border-top: 1px solid var(--line); }
}
@media (max-width: 520px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat:nth-child(odd) { border-left: 0; }
  .stat:nth-child(4) { border-left: 1px solid var(--line); }
  .stat:nth-child(n + 3) { border-top: 1px solid var(--line); }
  .lines li { grid-template-columns: 110px minmax(0, 1fr); }
  .lines .at { grid-column: 2; }
}
</style>
