<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  noticeSourcesOf, type Area, type AuctionResultSummary, type AuctionResultView, type CourtRegionStat, type HouseTradeSummary, type ListingView, type NoticeSourceId,
  type NoticeSourceStatus, type NoticeView, type Verdict,
} from '../../../shared/types';
import type { CatalogStation } from '../areaActions';
import { expectedPrices, saleDateOf, saleDay, type AuctionKind } from '../auction';
import { failedNoticeSources } from '../notices';
import AuctionResults from './AuctionResults.vue';
import HouseTrades from './HouseTrades.vue';
import ListingCard from './ListingCard.vue';
import NoticeList from './NoticeList.vue';
import OverviewMap from './OverviewMap.vue';

// 경매 탭: 맨 위 접는 카드들(단독 칸의 오래된 단독주택 실거래, 매각 결과, 상가와 토지 칸의 LH 공고, 신탁 공매 공고),
// 그 아래 매각기일별 목록(왼쪽)과 경매만 그린 지도(오른쪽).
// 목록 순서는 받은 그대로 쓴다(App의 키보드 이동과 같은 순서).

type Point = { lat: number; lng: number };
const props = defineProps<{
  /** 필터를 통과한 경매(sortAuctions 순서) */
  listings: ListingView[];
  /** '지역 반경 안만' 때문에 가린 경매 수 */
  outside: number;
  areas: Area[];
  selectedId: string | null;
  /** 조회 중(무엇이든)이면 '경매 조회하기'를 막는다 */
  running: boolean;
  /** 신탁 공매 공고(새 공고 먼저, 게시일 최신 순) */
  notices: NoticeView[];
  /** 고른 종류(상가, 토지)의 LH 공고와 선착순 계약(지역 필터를 거친 것, 주거면 빈 배열) */
  lhNotices: NoticeView[];
  /** 지역 밖이라 가린 LH 공고 수 */
  lhOutside: number;
  /** 공고 곳별 마지막 수집 결과 */
  noticeStatus: Partial<Record<NoticeSourceId, NoticeSourceStatus>>;
  /** 보고 있는 종류(주거, 상가)와 종류마다 필터를 통과한 수, 새 소식 수 */
  kind: AuctionKind;
  kinds: Record<AuctionKind, { count: number; news: number }>;
  /** 매각기일 묶음 안 순서: default 새 소식 먼저 최저가 낮은 순, pyeong 평당 낮은 순 */
  sort: 'default' | 'pyeong';
  /** 법원경매 매각 결과(모든 종류), 구와 서울 전체의 지역별 매각통계, 최근 1년 결과 요약 */
  results: AuctionResultView[];
  regionStats: CourtRegionStat[];
  compare: AuctionResultSummary[];
  /** 켜 둔 지역 근처 구 */
  gus: string[];
  /** 단독 칸 맨 위 오래된 단독주택 실거래 요약(아직 못 받았으면 null), 지은 지 몇 년 넘은 집을 볼지, 지금 받는 중, 받다가 난 오류 */
  houseTrades: HouseTradeSummary | null;
  houseAge: number;
  houseFetching: boolean;
  houseError: string | null;
}>();
const emit = defineEmits<{
  select: [ListingView];
  open: [ListingView];
  verdict: [ListingView, Verdict | null];
  source: [ListingView];
  raw: [ListingView];
  pick: [Point];
  area: [Area];
  station: [CatalogStation];
  /** 경매의 신규와 가격 변동 표시, 새 공매 공고와 LH 공고의 신규 표시를 모두 지움(모두 읽음) */
  ack: [];
  /** 공매 공고 몇 건만 확인(원문을 열 때) */
  ackNotices: [ids: number[]];
  /** 법원경매와 공매 공고만 조회 */
  run: [];
  /** 보는 종류 바꾸기 */
  kind: [AuctionKind];
  sort: ['default' | 'pyeong'];
  /** 실거래 요약의 지은 지 몇 년 넘은 집 바꾸기 */
  houseAge: [number];
  /** 국토부 실거래를 지금 받기 */
  houseFetch: [];
}>();

const KIND_NAMES: { id: AuctionKind; name: string; title: string }[] = [
  { id: 'home', name: '주거', title: '주거용 건물 경매' },
  { id: 'house', name: '단독', title: '주거 중 단독주택, 다가구주택, 다중주택 경매. 맨 위에 서울의 오래된 단독주택 실거래 표' },
  { id: 'shop', name: '상가', title: '상가 경매(법원경매 상업용 건물, 온비드 근린생활시설과 판매시설 등). 필터는 지역 칸과 검색어만 봅니다' },
  { id: 'land', name: '토지', title: '땅만 파는 경매(건물 없이 토지 목록만 있는 물건, 지분과 도로 포함). 면적은 지분이면 지분만큼. 필터는 지역 칸과 검색어만 봅니다' },
];

const EMPTY_TEXT: Record<AuctionKind, string> = {
  home: '경매 물건이 없습니다.',
  house: '단독주택 경매 물건이 없습니다.',
  shop: '상가 경매 물건이 없습니다.',
  land: '토지 경매 물건이 없습니다.',
};

/** 지도에 진하게 보일 펼친 목록(경매 탭은 없음). 같은 배열을 써서 다시 그릴 일을 줄인다. */
const none: ListingView[] = [];
const news = computed(() => props.listings.filter((l) => l.isNew).length);
const changed = computed(() => props.listings.filter((l) => !!l.priceChange).length);

const saleNew = computed(() => props.notices.filter((n) => n.isNew).length);
const saleCurrent = computed(() => props.notices.filter((n) => n.current).length);
/** 마지막 수집이 실패한 공매 공고 곳 */
const saleFailed = computed(() => failedNoticeSources(noticeSourcesOf('trust'), props.noticeStatus));
/**
 * 접는 공고 칸: 사용자가 펼치거나 접으면 그대로 기억하고(다음에 열어도), 고른 적이 없으면 새 공고가 있을 때만 펼친다.
 * toggle은 화면이 펼침을 바꿀 때도 오므로, 지금 정해진 값과 다를 때(사용자가 누름)만 기억한다.
 */
function foldState(key: string, hasNew: () => boolean) {
  const stored = localStorage.getItem(key);
  const choice = ref<boolean | null>(stored === 'true' ? true : stored === 'false' ? false : null);
  const open = computed(() => choice.value ?? hasNew());
  const onToggle = (e: Event) => {
    const now = (e.target as HTMLDetailsElement).open;
    if (now === open.value) return;
    choice.value = now;
    localStorage.setItem(key, String(now));
  };
  return { open, onToggle };
}
const sale = foldState('hnw-sale-notices-open', () => saleNew.value > 0);

const lhNew = computed(() => props.lhNotices.filter((n) => n.isNew).length);
const lhCurrent = computed(() => props.lhNotices.filter((n) => n.current).length);
const lhFailed = computed(() => failedNoticeSources(props.kind === 'land' ? ['lhland', 'lhfirst'] : ['lhshop', 'lhfirst'], props.noticeStatus));
const lh = foldState('hnw-lh-notices-open', () => lhNew.value > 0);

/** 이어지는 같은 매각기일끼리 묶는다. */
const days = computed(() => {
  const out: { key: string; day: string; when: string; past: boolean; items: ListingView[] }[] = [];
  for (const l of props.listings) {
    const date = saleDateOf(l);
    const key = date ?? 'unknown';
    const last = out[out.length - 1];
    if (last?.key === key) last.items.push(l);
    else out.push({ key, ...saleDay(date), items: [l] });
  }
  return out;
});
</script>

<template>
  <section class="auction">
    <div class="head">
      <div class="kinds" role="group" aria-label="경매 종류">
        <button
          v-for="k in KIND_NAMES" :key="k.id" class="kind-btn" :class="{ on: kind === k.id }" :title="k.title" :aria-pressed="kind === k.id"
          @click="emit('kind', k.id)"
        >
          {{ k.name }} <span class="num">{{ kinds[k.id].count }}</span><span v-if="kinds[k.id].news" class="chip chip-new">신규 {{ kinds[k.id].news }}</span>
        </button>
      </div>
      <button
        class="sort-btn" :class="{ on: sort === 'pyeong' }" :aria-pressed="sort === 'pyeong'"
        title="같은 매각기일 안에서 평당(최저가 ÷ 전용 평)이 낮은 물건부터. 다시 누르면 새 소식 먼저, 최저가 낮은 순"
        @click="emit('sort', sort === 'pyeong' ? 'default' : 'pyeong')"
      >평당 낮은 순</button>
      <span v-if="outside" class="outside" title="지역 반경 밖이라 가린 경매입니다. 왼쪽 필터에서 '지역 반경 안만'을 끄면 보입니다.">반경 밖 {{ outside }}건</span>
      <button v-if="news || changed || saleNew || lhNew" class="link-btn" title="경매의 '신규'와 가격 변동 표시, 새 공매 공고와 LH 공고의 '신규' 표시를 모두 지웁니다. 물건과 공고는 그대로 남습니다" @click="emit('ack')">모두 읽음</button>
      <button class="btn btn-primary run" :disabled="running" title="법원경매와 온비드, 신탁 공매 공고만 조회합니다(매매와 전월세 사이트, 임대 공고는 건너뜀)" @click="emit('run')">
        {{ running ? '조회 중…' : '경매 조회하기' }}
      </button>
    </div>

    <div class="split">
      <div class="days">
        <div class="panels">
          <HouseTrades
            v-if="kind === 'house'" :summary="houseTrades" :age="houseAge" :fetching="houseFetching" :error="houseError"
            @age="(a) => emit('houseAge', a)" @fetch="emit('houseFetch')"
          />
          <AuctionResults :results="results" :stats="regionStats" :compare="compare" :kind="kind" :gus="gus" />
          <details v-if="(kind === 'shop' || kind === 'land') && (lhNotices.length || lhOutside || lhFailed.length)" class="fold" :open="lh.open.value" @toggle="lh.onToggle">
            <summary :title="kind === 'land' ? 'LH 토지 공고와 선착순 토지(서울)' : 'LH 상가 공고와 선착순 상가, 임대상가(서울)'">
              <span class="fold-name">{{ kind === 'land' ? 'LH 토지' : 'LH 상가' }}</span>
              <span class="muted num fold-count">{{ lhCurrent }}건</span>
              <span v-if="lhNew" class="chip chip-new">신규 {{ lhNew }}</span>
              <span v-if="lhOutside" class="outside" title="켜 둔 지역 근처 구가 아닌 공고입니다. 왼쪽 필터에서 '지역 반경 안만'을 끄면 보입니다.">지역 밖 {{ lhOutside }}건</span>
              <span v-for="f in lhFailed" :key="f.id" class="failed" :title="f.title">{{ f.text }}</span>
            </summary>
            <div class="fold-body">
              <NoticeList bare :notices="lhNotices" @ack="(ids) => emit('ackNotices', ids)" />
            </div>
          </details>
          <details v-if="notices.length || saleFailed.length" class="fold" :open="sale.open.value" @toggle="sale.onToggle">
            <summary title="부동산신탁사 공매 공고(켜 둔 지역 근처 구)">
              <span class="fold-name">공매 공고</span>
              <span class="muted num fold-count">{{ saleCurrent }}건</span>
              <span v-if="saleNew" class="chip chip-new">신규 {{ saleNew }}</span>
              <span v-for="f in saleFailed" :key="f.id" class="failed" :title="f.title">{{ f.text }}</span>
            </summary>
            <div class="fold-body">
              <NoticeList bare :notices="notices" @ack="(ids) => emit('ackNotices', ids)" />
            </div>
          </details>
        </div>
        <section v-for="g in days" :key="g.key" class="day" :class="{ past: g.past }">
          <h3 class="day-head">
            <span class="day-name">{{ g.day }}</span>
            <span v-if="g.when" class="when">{{ g.when }}</span>
            <span class="muted num day-count">{{ g.items.length }}건</span>
          </h3>
          <div class="list">
            <ListingCard
              v-for="l in g.items" :key="l.id" :listing="l" :areas="areas" :selected="l.id === selectedId" hide-sale-date
              :expect="expectedPrices(l, regionStats)"
              @select="emit('select', l)" @open="emit('open', l)" @verdict="(v) => emit('verdict', l, v)"
              @source="emit('source', l)" @raw="emit('raw', l)"
            />
          </div>
        </section>
        <p v-if="!listings.length" class="empty muted">{{ EMPTY_TEXT[kind] }}</p>
      </div>
      <aside class="map">
        <OverviewMap
          :listings="none" :background="listings" :areas="areas" :selected-id="selectedId" :fit-key="kind"
          @select="(l) => emit('select', l)" @reveal="(ls) => emit('select', ls[0])" @open="(l) => emit('open', l)" @pick="(p) => emit('pick', p)" @area="(a) => emit('area', a)"
          @station="(s) => emit('station', s)"
        />
      </aside>
    </div>
  </section>
</template>

<style scoped>
.auction { display: grid; gap: 14px; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 40px; }
.kinds { display: flex; gap: 6px; margin-right: 4px; }
.kind-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); font-size: 16px; font-weight: 800; }
.kind-btn.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.sort-btn { min-height: 40px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); font-size: 14px; font-weight: 700; color: var(--ink-2); }
.sort-btn.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.outside { font-size: 13px; font-weight: 600; color: var(--muted); }
.head .run { margin-left: auto; min-height: 44px; padding: 0 20px; font-size: 15px; }

/* 목록(왼쪽)과 지도(오른쪽, 따라 내려옴). 좁으면 지도가 위로 간다. 한눈에 탭과 같은 배치. */
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 45%); gap: 16px; align-items: start; }
.days { display: grid; gap: 18px; min-width: 0; }
.day { display: grid; gap: 8px; }
.day-head { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; font-size: 17px; font-weight: 800; }
.when { font-size: 14px; font-weight: 700; color: var(--accent); }
.day-count { font-size: 14px; font-weight: 600; }
.day.past .day-name, .day.past .when { color: var(--muted); }
/* 매각 결과, 실거래, 공고 카드 묶음. 아래 매각기일 목록과 사이를 조금 더 띄운다. */
.panels { display: grid; gap: 8px; margin-bottom: 6px; }
.failed { font-size: 13px; font-weight: 700; color: var(--new); }
.list { display: grid; gap: 8px; container-type: inline-size; }
.map { position: sticky; top: 92px; height: calc(100vh - 108px); min-height: 420px; }
/* 크게 보기일 때는 위쪽 머리 줄(z-index 20)보다 위에 오게 한다. */
.map:has(.ovmap.big) { z-index: 70; }
.empty { padding: 32px 0; text-align: center; }
@media (max-width: 1280px) {
  .split { grid-template-columns: 1fr; }
  .map { position: static; order: -1; height: auto; min-height: 0; }
}
</style>
