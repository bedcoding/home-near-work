<script setup lang="ts">
import { computed } from 'vue';
import { NOTICE_SOURCE_LABEL, type AppState, type NoticeSourceId, type NoticeSourceStatus, type NoticeView, type SourceId } from '../../../shared/types';
import { ago } from '../format';
import { NOTICE_HOME } from '../notices';
import type { SiteLink } from '../siteLinks';

// 사이트 체크리스트: 자동으로 모으는 곳(마지막 조회 결과), 직접 보는 곳(크롬 확장이 마지막으로 받은 때), 키가 필요한 곳.
// 공고 목록은 '임대 공고' 탭(임대)과 '경매' 탭(공매)에 있다.
const props = defineProps<{
  state: AppState;
  links: SiteLink[];
  extReady: boolean;
  /** 모든 공고(곳별 새 공고 수를 셀 때 쓴다)와 곳별 마지막 수집 결과 */
  notices: NoticeView[];
  noticeStatus: Partial<Record<NoticeSourceId, NoticeSourceStatus>>;
}>();
const emit = defineEmits<{ openAll: [] }>();

const linkOf = (id: string) => props.links.find((l) => l.id === id)?.url ?? null;

/** home: 바로 가기 줄에 없는 곳을 누르면 여는 주소 */
const AUTO: { id: SourceId; name: string; home?: string }[] = [
  { id: 'peterpanz', name: '피터팬' },
  { id: 'ziptoss', name: '집토스' },
  { id: 'gobang', name: '고방', home: 'https://gobang.kr/gosi' },
  { id: 'betterliving', name: '에피소드(코리빙)', home: 'https://betterliving.kr/find' },
  { id: 'mangrove', name: '맹그로브(코리빙)', home: 'https://mangrove.city' },
  { id: 'celib', name: '셀립(코리빙)', home: 'https://celib.kr' },
  { id: 'courtauction', name: '법원경매' },
  { id: 'onbid', name: '온비드 공매', home: 'https://www.onbid.co.kr/op/cltrpbancinf/cltr/cltrmapsrch/CltrMapSrchController/mvmnCltrMapSrchClg.do' },
];
const NOTICE_SOURCES: NoticeSourceId[] = [
  'applyhome', 'shsale', 'lhsale', 'lhshop', 'lhland', 'lhfirst', 'sh', 'lh', 'myhome', 'hugjeonse', 'hugtrust', 'gobang',
  'kbtrust', 'koreit', 'reitpia', 'ktrust', 'hanatrust', 'shinhantrust', 'mghat', 'shinyoung', 'wooriat', 'daishin', 'kyobotrust', 'koramco',
];
const BROWSE: { id: string; name: string }[] = [
  { id: 'naver', name: '네이버 부동산' },
  { id: 'dabang', name: '다방' },
  { id: 'zigbang', name: '직방' },
  { id: 'kbland', name: 'KB부동산' },
  { id: 'hogangnono', name: '호갱노노' },
  { id: 'daangn', name: '당근부동산' },
];

interface Row {
  key: string;
  name: string;
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  title?: string;
  newCount?: number;
  url: string | null;
  /** 직접 보는 곳의 마지막 확인 결과(새 방, 늘어난 매물 수) */
  news?: string;
  newsHot?: boolean;
}

/** 자동으로 모으는 곳: 매물 사이트는 그 사이트가 들어간 마지막 조회 결과, 공고는 곳별 마지막 수집 결과 */
const autoRows = computed<Row[]>(() => {
  const rows: Row[] = AUTO.map((s) => {
    const r = props.state.lastBySource[s.id];
    const url = linkOf(s.id) ?? s.home ?? null;
    if (!r) return { key: s.id, name: s.name, text: '아직 조회 안 함', tone: 'muted', url };
    const when = ago(r.at);
    if (r.status === 'ok') return { key: s.id, name: s.name, text: `${r.kept}건, ${when}`, tone: 'ok', url };
    if (r.error === '중단함') return { key: s.id, name: s.name, text: `중단, ${when}`, tone: 'muted', url };
    return { key: s.id, name: s.name, text: `실패, ${when}`, tone: 'bad', title: r.error ?? undefined, url };
  });
  for (const id of NOTICE_SOURCES) {
    const st = props.noticeStatus[id];
    const newCount = props.notices.filter((n) => n.source === id && n.isNew).length;
    if (!st) rows.push({ key: id, name: NOTICE_SOURCE_LABEL[id], text: '아직 조회 안 함', tone: 'muted', url: NOTICE_HOME[id] });
    else if (st.ok) rows.push({ key: id, name: NOTICE_SOURCE_LABEL[id], text: `${st.count}건, ${ago(st.at)}`, tone: 'ok', newCount, url: NOTICE_HOME[id] });
    else rows.push({ key: id, name: NOTICE_SOURCE_LABEL[id], text: `실패, ${ago(st.at)}`, tone: 'bad', title: st.error ?? undefined, url: NOTICE_HOME[id] });
  }
  return rows;
});

/** 직접 보는 곳: 크롬 확장이 그 사이트 데이터를 마지막으로 받은 때(= 마지막으로 본 때). 사흘 넘게 안 봤으면 눈에 띄게 한다. */
const browseRows = computed<Row[]>(() =>
  BROWSE.map((s) => {
    const c = props.state.captureSites.find((x) => x.site === s.id);
    if (!c?.lastAt) return { key: s.id, name: s.name, text: '아직 안 봄', tone: 'warn', url: linkOf(s.id) };
    const days = (Date.now() - new Date(c.lastAt).getTime()) / 86400000;
    const news = props.state.captureNews[s.id];
    return { key: s.id, name: s.name, text: `${ago(c.lastAt)} 봄`, tone: days > 3 ? 'warn' : 'ok', url: linkOf(s.id), news: news?.text, newsHot: news?.hot };
  }),
);
</script>

<template>
  <section class="sites-tab">
    <div class="block">
      <div class="block-head">
        <h3>자동 <span class="muted">'조회하기'로 모음</span></h3>
      </div>
      <ul class="rows">
        <li v-for="r in autoRows" :key="r.key" class="row">
          <span class="name">{{ r.name }}</span>
          <span class="state" :class="r.tone" :title="r.title">{{ r.text }}<span v-if="r.newCount" class="chip chip-new">새 공고 {{ r.newCount }}</span></span>
          <a v-if="r.url" class="btn btn-sm" :href="r.url" target="_blank" rel="noopener">열기 ↗</a>
        </li>
      </ul>
    </div>

    <div class="block">
      <div class="block-head">
        <h3>직접 보기 <span class="muted">크롬 확장이 켜진 채 보면 받음</span></h3>
        <button class="btn btn-primary btn-sm" :disabled="!extReady" :title="extReady ? '켜 둔 사이트를 새 창 하나에 엽니다' : '크롬 확장이 있어야 합니다'" @click="emit('openAll')">
          한 번에 열기
        </button>
      </div>
      <ul class="rows">
        <li v-for="r in browseRows" :key="r.key" class="row">
          <span class="name">{{ r.name }}</span>
          <span class="state" :class="r.tone">{{ r.text }}<span v-if="r.news" class="chip" :class="{ 'chip-new': r.newsHot }">{{ r.news }}</span></span>
          <a v-if="r.url" class="btn btn-sm" :href="r.url" target="_blank" rel="noopener">열기 ↗</a>
        </li>
      </ul>
    </div>

    <div class="block">
      <div class="block-head">
        <h3>키 필요 <span class="muted">공공데이터포털(무료)</span></h3>
      </div>
      <ul class="rows">
        <li class="row" title="공공데이터포털에서 활용신청 후 받은 인증키를 config/local.json의 dataGoKrKey에 넣으면 붙입니다">
          <span class="name">실거래가</span>
          <span class="state muted">키가 아직 없음</span>
          <a class="btn btn-sm" href="https://www.data.go.kr" target="_blank" rel="noopener">키 받는 곳 ↗</a>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.sites-tab { display: grid; gap: 14px; max-width: 900px; }
.block { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 12px 14px; display: grid; gap: 8px; }
.block-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
h3 { margin: 0; font-size: 15px; display: flex; align-items: baseline; gap: 8px; }
h3 .muted { font-size: 13px; font-weight: 500; }
.rows { list-style: none; margin: 0; padding: 0; display: grid; }
.row { display: grid; grid-template-columns: 200px 1fr auto; align-items: center; gap: 12px; min-height: 44px; border-top: 1px solid var(--line); }
.row:first-child { border-top: 0; }
.name { font-weight: 700; }
.state { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 14px; }
.state.ok { color: var(--ink-2); }
.state.warn { color: var(--up); font-weight: 700; }
.state.bad { color: var(--new); font-weight: 700; }
.state.muted { color: var(--muted); }
@media (max-width: 720px) { .row { grid-template-columns: 1fr auto; } .row .state { grid-column: 1 / -1; } }
</style>
