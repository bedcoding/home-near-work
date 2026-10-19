<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  noticeSourcesOf, type AppState, type Area, type AuctionResultSummary, type AuctionResultView, type CourtRegionStat, type HouseTradeSummary, type ListingView,
  type NoticeSourceId, type NoticeSourceStatus, type NoticeView, type Verdict,
} from '../../../shared/types';
import type { CatalogStation } from '../areaActions';
import { expectedPrices, saleDateOf, saleDay, type AuctionKind } from '../auction';
import { failedNoticeSources } from '../notices';
import AuctionResults from './AuctionResults.vue';
import CountTooltip from './CountTooltip.vue';
import HouseTrades from './HouseTrades.vue';
import ListingCard from './ListingCard.vue';
import NoticeList from './NoticeList.vue';
import OverviewMap from './OverviewMap.vue';
import ZoneBanner from './ZoneBanner.vue';

// 경매 탭(주거, 상가)과 집터 탭(단독, 토지)이 같이 쓴다: 목록 위의 보조정보(단독주택 실거래, 매각 결과, 상가와 토지 칸의 LH 공고,
// 신탁 공매 공고), 그 아래 매각기일별 목록과 매매 매물(왼쪽), 지도(오른쪽).
// 목록 순서는 받은 그대로 쓴다(App의 키보드 이동과 같은 순서: 경매 다음 매매 매물).

type Point = { lat: number; lng: number };
const props = defineProps<{
  /** 탭 제목(경매, 집터)과 고를 수 있는 종류 */
  title: string;
  kindIds: AuctionKind[];
  /** 필터를 통과한 경매(sortAuctions 순서) */
  listings: ListingView[];
  /** 경매 아래에 따로 보이는 매매 매물(집터 탭) */
  sales?: ListingView[];
  /** 신탁 공매 공고 칸을 보일지(경매 탭만) */
  trust?: boolean;
  /** 제목 줄 옆 바깥 사이트 링크(집터 탭의 모듈러 주택 회사) */
  links?: { label: string; url: string; title: string }[];
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
  /** 집터 탭: 재개발 구역 확인 상태(키, 마지막 결과)와 지금 확인하는 중, 난 오류. 있으면 제목 줄에 '재개발 구역 확인'과 매매 매물의 구역 표시가 보인다. */
  zone?: AppState['zoneCheck'] & { checking: boolean; error: string | null };
  /** 집터 탭: 뺀 지분 매각 수(주인이 여럿) */
  plotShareHidden?: number;
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
  /** 집터 경매·공매의 재개발 구역을 지금 확인 */
  zoneCheck: [];
}>();

const KIND_NAMES: { id: AuctionKind; name: string; title: string }[] = [
  { id: 'home', name: '주거', title: '주거용 건물 경매' },
  { id: 'house', name: '단독', title: '단독주택, 다가구주택, 다중주택 경매와 매매 매물. 맨 위에 서울의 오래된 단독주택 실거래 표' },
  { id: 'shop', name: '상가', title: '상가 경매(법원경매 상업용 건물, 온비드 근린생활시설과 판매시설 등). 필터는 지역 칸과 검색어만 봅니다' },
  { id: 'land', name: '토지', title: '땅만 파는 경매(건물 없이 토지 목록만 있는 물건, 지분과 도로 포함)와 토지 매매 매물. 면적은 지분이면 지분만큼. 필터는 지역 칸과 검색어만 봅니다' },
];

const EMPTY_TEXT: Record<AuctionKind, string> = {
  home: '경매 물건이 없습니다.',
  house: '단독주택 경매와 매매 매물이 없습니다.',
  shop: '상가 경매 물건이 없습니다.',
  land: '토지 경매와 매매 매물이 없습니다.',
};

const kindNames = computed(() => KIND_NAMES.filter((k) => props.kindIds.includes(k.id)));
/** 지도에 진하게 보일 펼친 목록(이 탭들은 없음). 같은 배열을 써서 다시 그릴 일을 줄인다. */
const none: ListingView[] = [];
const sales = computed(() => props.sales ?? []);
/** 목록에 보이는 것 전부(경매 다음 매매 매물). 지도와 숫자에 쓴다. */
const all = computed(() => (sales.value.length ? [...props.listings, ...sales.value] : props.listings));
const news = computed(() => all.value.filter((l) => l.isNew).length);
const changed = computed(() => all.value.filter((l) => !!l.priceChange).length);

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

/** 재개발 구역 확인 결과를 보인 시각 */
const zoneDay = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
/** 경매 목록 중 재개발 쪽 구역 안(경계에 붙은 것 빼고)인 물건 수 */
const zoneInside = computed(() => props.listings.filter((l) => l.zone?.check?.zones.some((z) => z.overlap !== '접함')).length);

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
    <div class="auction-heading">
      <h2 class="auction-title">{{ title }} <CountTooltip class="current-count" :text="`신규 ${news}건\n가격 변동 ${changed}건\n반경 밖 ${outside}건`"><b class="num">{{ all.length }}</b>건</CountTooltip></h2>
      <nav v-if="links?.length" class="links" aria-label="모듈러 주택 회사">
        <span class="links-label">모듈러 주택</span>
        <a v-for="x in links" :key="x.url" :href="x.url" target="_blank" rel="noopener" :title="x.title">{{ x.label }} ↗</a>
      </nav>
      <div class="auction-actions">
        <div v-if="zone" class="zone-row">
          <span v-if="zone.error" class="zone-msg err" role="alert">{{ zone.error }}</span>
          <span v-else-if="!zone.key" class="zone-msg muted">브이월드 키가 없어 재개발 구역을 못 봅니다(README 참고)</span>
          <span v-else-if="zone.last" class="zone-msg" :class="zone.last.ok ? 'muted' : 'err'">{{ zoneDay(zone.last.at) }} {{ zone.last.text }}</span>
          <span v-if="zoneInside" class="chip chip-new" title="이 칸 경매·공매 중 토지이용계획에 정비구역, 재개발·재정비촉진, 모아타운, 건축허가 제한이 걸린 물건">구역 안 {{ zoneInside }}건</span>
          <button
            type="button" class="btn run" :disabled="!zone.key || zone.checking || running"
            :title="zone.key
              ? '이 탭 경매·공매(단독, 토지)의 지번으로 브이월드 토지이용계획을 읽어 정비구역, 재개발·재정비촉진, 모아타운, 건축허가 제한이 걸렸는지 봅니다. 경매 조회 때도 알아서 봅니다.'
              : '브이월드 인증키가 있어야 합니다. config/local.json에 vworldKey를 넣어 주세요(README의 집터 탭).'"
            @click="emit('zoneCheck')"
          >{{ zone.checking ? '확인 중…' : '재개발 구역 확인' }}</button>
        </div>
        <button class="btn run" :disabled="running" title="법원경매와 온비드, 신탁 공매 공고만 조회합니다(매매와 전월세 사이트, 임대 공고는 건너뜀)" @click="emit('run')">
          {{ running ? '조회 중…' : '경매 조회하기' }}
        </button>
      </div>
    </div>

    <div class="split">
      <div class="days">
        <div class="auction-options">
          <div class="auction-toolbar">
            <fieldset class="auction-kinds">
              <legend class="sr-only">경매 종류</legend>
              <label v-for="k in kindNames" :key="k.id" class="kind-option" :title="`${k.title}${kinds[k.id].news ? `\n새 소식 ${kinds[k.id].news}건` : ''}`">
                <input
                  type="radio" name="auction-kind" :value="k.id" :checked="kind === k.id"
                  :aria-label="`${k.name} ${kinds[k.id].count}건${kinds[k.id].news ? `, 새 소식 ${kinds[k.id].news}건` : ''}`"
                  @change="emit('kind', k.id)"
                >
                <span>{{ k.name }}</span><span class="kind-count num">{{ kinds[k.id].count }}</span>
              </label>
            </fieldset>
            <label class="auction-sort" title="같은 매각기일 안에서의 정렬 순서입니다.">
              <span>정렬</span>
              <select :value="sort" @change="emit('sort', ($event.target as HTMLSelectElement).value as 'default' | 'pyeong')">
                <option value="default">새 소식, 최저가 순</option>
                <option value="pyeong">평당 낮은 순</option>
              </select>
            </label>
          </div>
          <p v-if="plotShareHidden" class="plot-hidden" title="집이나 땅 전체가 아니라 일부 지분만 파는 물건입니다. 다른 공유자가 있어 헐고 새로 짓기 어려워 이 탭에서 뺐습니다(경매 탭에는 '지분' 표시로 나옴).">
            지분 매각 {{ plotShareHidden }}건 뺌
          </p>
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
            <details v-if="trust !== false && (notices.length || saleFailed.length)" class="fold" :open="sale.open.value" @toggle="sale.onToggle">
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
            >
              <template v-if="l.zone" #banner><ZoneBanner part="banner" :listing="l" :key-set="zone?.key ?? false" /></template>
              <template v-if="l.zone && zone" #tags><ZoneBanner part="chip" :listing="l" :key-set="zone.key" /></template>
            </ListingCard>
          </div>
        </section>
        <section v-if="sales.length" class="day sales">
          <h3 class="day-head" title="매매 매물 중 이 칸 종류(단독주택이나 토지). 새 소식 먼저, 그다음 매매가 낮은 순">
            <span class="day-name">매매 매물</span>
            <span class="muted num day-count">{{ sales.length }}건</span>
          </h3>
          <div class="list">
            <ListingCard
              v-for="l in sales" :key="l.id" :listing="l" :areas="areas" :selected="l.id === selectedId"
              @select="emit('select', l)" @open="emit('open', l)" @verdict="(v) => emit('verdict', l, v)"
              @source="emit('source', l)" @raw="emit('raw', l)"
            >
              <template v-if="zone" #tags><ZoneBanner part="chip" :listing="l" :key-set="zone.key" sale /></template>
            </ListingCard>
          </div>
        </section>
        <p v-if="!all.length" class="empty muted">{{ EMPTY_TEXT[kind] }}</p>
      </div>
      <aside class="map">
        <OverviewMap
          :listings="none" :background="all" :areas="areas" :selected-id="selectedId" :fit-key="kind"
          @select="(l) => emit('select', l)" @reveal="(ls) => emit('select', ls[0])" @open="(l) => emit('open', l)" @pick="(p) => emit('pick', p)" @area="(a) => emit('area', a)"
          @station="(s) => emit('station', s)"
        />
      </aside>
    </div>
  </section>
</template>

<style scoped>
.auction { display: grid; gap: 14px; }
.auction-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 24px; min-width: 0; }
.auction-options { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; min-width: 0; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.auction-toolbar { display: contents; }
.auction-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin: 0; font-size: 21px; font-weight: 700; }
.current-count { font-size: 14px; font-weight: 500; color: var(--muted); cursor: help; }
.current-count b { color: var(--ink-2); }
.auction-kinds { display: flex; flex-wrap: wrap; gap: 4px 16px; min-width: 0; margin: 0; padding: 0; border: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.kind-option { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; cursor: pointer; color: var(--ink-2); font-size: 14px; }
.kind-option input { width: 15px; height: 15px; margin: 0 2px 0 0; accent-color: var(--accent); }
.kind-option:has(input:checked) > span:first-of-type { font-weight: 700; color: var(--ink); }
.kind-count { color: var(--muted); font-size: 12px; }
.auction-sort { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--muted); font-size: 13px; }
.auction-sort select { width: auto; min-width: 0; max-width: 100%; min-height: 34px; padding: 0 28px 0 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink-2); font-size: 13px; }
.auction-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-left: auto; }
.links { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; min-width: 0; font-size: 13px; }
.links-label { font-size: 12px; color: var(--muted); }
.links a { color: var(--ink-2); text-decoration: none; white-space: nowrap; }
.links a:hover { text-decoration: underline; text-underline-offset: 3px; }
.auction-actions .run { min-height: 34px; padding: 0 12px; font-size: 13px; }
.plot-hidden { margin: 0; font-size: 13px; color: var(--ink-2); cursor: help; }
.zone-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 10px; min-width: 0; }
.zone-msg { font-size: 12px; }
.zone-msg.err { color: var(--new); font-weight: 600; }
.outside { font-size: 13px; font-weight: 600; color: var(--muted); }

/* 목록(왼쪽)과 지도(오른쪽, 따라 내려옴). 좁으면 지도가 위로 간다. 매물 탭과 같은 배치. */
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 45%); gap: 16px; align-items: start; }
.days { display: grid; gap: 18px; min-width: 0; }
.day { display: grid; gap: 8px; }
.day-head { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; font-size: 17px; font-weight: 800; }
.when { font-size: 14px; font-weight: 700; color: var(--accent); }
.day-count { font-size: 14px; font-weight: 600; }
.day.past .day-name, .day.past .when { color: var(--muted); }
/* 닫힌 보조정보는 짧은 펼침 링크로, 펼친 내용은 목록 칼럼 전체 너비로 읽는다. */
.panels { display: contents; }
.panels > :deep(.fold) { flex: 0 1 auto; min-width: 0; max-width: 100%; border: 0; border-radius: 0; background: transparent; }
.panels > :deep(.fold:first-child:not([open])) { margin-left: auto; }
.panels > :deep(.fold[open]) { flex-basis: 100%; }
.panels > :deep(.fold > summary) { min-height: 32px; align-items: center; gap: 4px 7px; padding: 4px 0; border: 0; border-radius: 0; }
.panels > :deep(.fold > summary::after) { margin-left: 0; padding-left: 1px; font-size: 11px; }
.panels > :deep(.fold > summary:hover .fold-name) { text-decoration: underline; text-underline-offset: 3px; }
.panels > :deep(.fold > summary .fold-name) { font-size: 13px; font-weight: 600; color: var(--ink-2); }
.panels > :deep(.fold > summary .fold-count) { font-size: 12px; }
.panels > :deep(.fold > .fold-body) { min-width: 0; margin: 5px 0 8px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.failed { font-size: 13px; font-weight: 700; color: var(--new); }
.list { display: grid; gap: 8px; container-type: inline-size; }
.map { position: sticky; top: calc(var(--app-header-height, 76px) + 16px); height: calc(100dvh - var(--app-header-height, 76px) - 32px); min-height: 420px; }
/* 크게 보기일 때는 위쪽 머리 줄(z-index 20)보다 위에 오게 한다. */
.map:has(.ovmap.big) { z-index: 70; }
.empty { padding: 32px 0; text-align: center; }
@media (max-width: 1280px) {
  .split { grid-template-columns: 1fr; }
  .days, .auction-options { display: contents; }
  .auction-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; min-width: 0; }
  .map { position: static; order: 1; height: auto; min-height: 0; }
  .panels { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 2px 20px; min-width: 0; order: 2; }
  .panels > :deep(.fold:first-child:not([open])) { margin-left: 0; }
  .day, .empty { order: 3; }
}
@media (max-width: 600px) {
  .auction-heading { gap: 8px 16px; }
  .auction-toolbar { gap: 8px 16px; }
  .auction-kinds { gap: 4px 14px; }
  .auction-actions { margin-left: 0; }
}
</style>
