<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  hasHomeListings, inGus, nearReason, noticeSection, noticeSourcesOf, SOURCE_LABEL,
  type AppState, type Area, type AuctionResultSummary, type AuctionResultView, type CourtRegionStat, type DealType, type ExplainRow, type HouseTradeSummary, type ListingView,
  type NoticeSourceId, type NoticeSourceStatus, type NoticeView, type SourceId, type Verdict,
} from '../../shared/types';
import { api } from './api';
import { DEFAULT_FILTERS, dealOptions, FILTER_DEALS, loadFilters, passes, saveFilters, type Filters } from './filters';
import { dateTime, distanceM, radiusText } from './format';
import AlertsTab from './components/AlertsTab.vue';
import AreaSettings from './components/AreaSettings.vue';
import AuctionView from './components/AuctionView.vue';
import FilterPanel from './components/FilterPanel.vue';
import ListingCard from './components/ListingCard.vue';
import ListingDetail from './components/ListingDetail.vue';
import NoticesView from './components/NoticesView.vue';
import Overview from './components/Overview.vue';
import RoomsView from './components/RoomsView.vue';
import RunHistory from './components/RunHistory.vue';
import SitesTab from './components/SitesTab.vue';
import SubscriptionsView from './components/SubscriptionsView.vue';
import SupportView from './components/SupportView.vue';
import { loadCatalog, setAreaEnabled, toggleStationArea, type CatalogStation } from './areaActions';
import { auctionKindOf, inAuctionKind, isAuction, originalUrl, sortAuctions, type AuctionKind } from './auction';
import { kindOf } from './kinds';
import { MODULAR_LINKS } from './modular';
import { isPastNotice } from './notices';
import { isRoomStay, sortRooms } from './rooms';
import { siteLinks } from './siteLinks';

type Tab = 'overview' | 'star' | 'hidden' | 'auction' | 'plot' | 'subs' | 'rooms' | 'notices' | 'support' | 'sites' | 'runs' | 'areas' | 'alerts';
const TABS: Tab[] = ['overview', 'star', 'hidden', 'auction', 'plot', 'subs', 'rooms', 'notices', 'support', 'sites', 'runs', 'areas', 'alerts'];

/** 머리 줄 높이(px). 필터 칸이 그 아래에 붙어 따라 내려온다(--app-header-height). */
const headerEl = ref<HTMLElement | null>(null);
const headerHeight = ref(80);
let headerObserver: ResizeObserver | undefined;

// 마지막으로 연 탭을 다음에 열어도 그대로 보여 준다. 주소에 ?tab=이 있으면(조회 알림을 눌러 열었을 때) 그 탭을 먼저 연다.
// ?tab=news(매매와 전월세 새 소식 알림)는 매물 탭을 열고 맨 위 '새 소식' 줄을 펼친다.
const savedTab = localStorage.getItem('hnw-tab') as Tab | null;
const urlParam = new URLSearchParams(location.search).get('tab');
const openNewsRow = urlParam === 'news';
const urlTab = (openNewsRow ? 'overview' : urlParam) as Tab | null;
const tab = ref<Tab>(urlTab && TABS.includes(urlTab) ? urlTab : savedTab && TABS.includes(savedTab) ? savedTab : 'overview');
if (urlParam) history.replaceState(null, '', location.pathname);
const state = ref<AppState | null>(null);
const listings = ref<ListingView[]>([]);
const filters = ref(loadFilters());
const error = ref<string | null>(null);
/** 대시보드 서버와 연결이 끊겼을 때만 보이고, 다시 연결되면 사라진다. */
const connectionError = ref<string | null>(null);
const selected = ref(0);
const sourceOf = ref<ListingView | null>(null);
const rawOf = ref<{ listing: ListingView; explain: ExplainRow[]; raw: unknown } | null>(null);

async function showRaw(l: ListingView) {
  try {
    const data = await api.raw(l.id);
    rawOf.value = { listing: l, ...data };
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
const runsKey = ref(0);
const showLog = ref(false);

const visibleMode = ref(localStorage.getItem('hnw-visible') !== 'false');
watch(visibleMode, (v) => {
  localStorage.setItem('hnw-visible', String(v));
  // 자동 확인도 같은 방식(창 띄우기/조용히)으로 돈다.
  void api.setAutoCheck({ visible: v }).catch(() => {});
});

/** 자동 확인 시각 고르기: 06:00 ~ 23:30, 30분 간격(법원경매는 01~06시 쉼). 저장된 시각이 목록에 없으면 끼워 넣는다. */
const AUTO_TIMES = Array.from({ length: 36 }, (_, i) => `${String(6 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const autoTimes = computed(() => {
  const a = state.value?.autoCheck;
  const extra = [a?.time, a?.noticeTime].filter((t): t is string => !!t && !AUTO_TIMES.includes(t));
  return extra.length ? [...new Set([...AUTO_TIMES, ...extra])].sort() : AUTO_TIMES;
});
/** 자동 확인 시각('off'면 끄기)이나 요일(null이면 매일), 공고 확인 시각('off'면 끄기)을 바꾼다. */
async function setAutoCheck(body: { time?: string; day?: number | null; noticeTime?: string }) {
  error.value = null;
  const off = (v: string) => (v === 'off' ? null : v);
  try {
    await api.setAutoCheck(
      body.noticeTime !== undefined ? { noticeTime: off(body.noticeTime) } : body.time === undefined ? { day: body.day } : { time: off(body.time) },
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
  await refreshState().catch(() => {});
}
/** 머리 줄의 자동 확인 글자: '자동 확인 매주 토요일 10:00, 공고 매일 22:30', '자동 확인 매일 22:30', '자동 확인 끔' */
const autoCheckText = computed(() => {
  const a = state.value?.autoCheck;
  const full = a?.time ? `자동 확인 ${a.day === null ? '매일' : `매주 ${'일월화수목금토'[a.day]}요일`} ${a.time}` : '자동 확인 끔';
  return a?.noticeTime ? `${full}, 공고 매일 ${a.noticeTime}` : full;
});watch(filters, (f) => saveFilters(f), { deep: true });

/** 켜진 지역. 10초마다 상태를 새로 받아도 내용이 같으면 전과 같은 배열을 돌려준다(목록과 지도가 괜히 다시 계산되지 않게). */
let areasCache: Area[] = [];
const areas = computed(() => {
  const next = state.value?.areas.filter((a) => a.enabled) ?? [];
  if (JSON.stringify(next) === JSON.stringify(areasCache)) return areasCache;
  areasCache = next;
  return next;
});
const running = computed(() => state.value?.running ?? null);

// 사이트 바로 가기. 지도 사이트는 고른 지역 가운데로 연다(고른 지역은 다음에 열어도 유지).
const linkAreaId = ref(Number(localStorage.getItem('hnw-link-area')) || null);
watch(linkAreaId, (id) => localStorage.setItem('hnw-link-area', String(id ?? '')));
const linkArea = computed(() => areas.value.find((a) => a.id === linkAreaId.value) ?? areas.value[0] ?? null);
const links = computed(() => siteLinks(linkArea.value, state.value?.stations ?? []));

// 사이트 탭. 'all'은 모든 사이트를 한 목록으로 본다. 고른 사이트는 다음에 열어도 유지한다.
// 법원경매와 온비드는 경매 탭, 코리빙 사이트는 고시원과 쉐어 탭에서 본다(고방은 원룸과 투룸만 여기에).
type Site = SourceId | 'all';
const SITES = (Object.keys(SOURCE_LABEL) as SourceId[]).filter(hasHomeListings);
const savedSite = localStorage.getItem('hnw-site');
const site = ref<Site>(savedSite && (savedSite === 'all' || (SITES as string[]).includes(savedSite)) ? (savedSite as Site) : 'all');
watch(site, (s) => {
  localStorage.setItem('hnw-site', s);
  selected.value = 0;
});
const inSite = (l: ListingView) => site.value === 'all' || l.source === site.value;
/** 사이트 칸으로 고르는 목록 탭(관심, 숨김함). 매물 탭은 가격대 안에서 사이트를 고른다. */
const usesSiteTabs = computed(() => tab.value === 'star' || tab.value === 'hidden');

const current = computed(() => listings.value.filter((l) => l.status === 'active' && l.verdict !== 'discard'));
/** 매물이 보이는 곳: 매매와 전월세(매물 탭), 경매 탭, 고시원과 쉐어 탭. 관심과 숨김함에는 모두 보인다. */
type Section = 'home' | 'auction' | 'room';
const sectionOf = (l: ListingView): Section => (isAuction(l) ? 'auction' : isRoomStay(l) ? 'room' : 'home');
const homes = computed(() => current.value.filter((l) => sectionOf(l) === 'home'));
/** 필터 거래 유형 칸: 단기는 단기 매물이 있을 때(지역 반경 밖 포함, 거래 유형 필터는 빼고)나 골라 둔 때만 보인다. */
const dealChoices = computed<DealType[]>(() => {
  const loose = { ...filters.value, deals: [], insideAreas: false };
  const short = filters.value.deals.includes('short') || homes.value.some((l) => dealOptions(l, 'short', loose, areas.value).length > 0);
  return FILTER_DEALS.filter((d) => d !== 'short' || short);
});
const byNewest = (a: ListingView, b: ListingView) => b.firstSeenAt.localeCompare(a.firstSeenAt);
const hasNews = (l: ListingView) => l.isNew || !!l.priceChange;
/** 매물 탭 이름 옆 빨간 점: 거래 유형을 빼고 필터를 통과한 매매와 전월세 중 새 소식이 있는 수 */
const homeNews = computed(() => homes.value.filter((l) => hasNews(l) && passes(l, { ...filters.value, deals: [] }, areas.value)).length);
const starred = computed(() => listings.value.filter((l) => l.verdict === 'star' && inSite(l)).sort(byNewest));
const hidden = computed(() => listings.value.filter((l) => l.verdict === 'discard' && inSite(l)).sort(byNewest));

/** 관심, 숨김함 탭의 사이트 칸: 사이트마다 그 탭 매물 수와 새 소식 수. */
const siteTabs = computed(() => {
  const base = listings.value.filter((l) => l.verdict === (tab.value === 'hidden' ? 'discard' : 'star'));
  const count = (s: Site) => {
    const list = s === 'all' ? base : base.filter((l) => l.source === s);
    return { total: list.length, news: list.filter(hasNews).length };
  };
  return [
    { id: 'all' as Site, label: '모든 사이트', ...count('all') },
    ...SITES.map((s) => ({ id: s as Site, label: SOURCE_LABEL[s], ...count(s) })),
  ];
});

/** '지역 반경 안만' 때문에 가린 수(shown: 필터를 통과한 수) */
function outsideCount(all: ListingView[], f: Filters, shown: number) {
  if (!f.insideAreas) return 0;
  const loose = { ...f, insideAreas: false };
  return all.filter((l) => passes(l, loose, areas.value)).length - shown;
}

// ---------- 경매 ----------
/** 경매 탭은 거래 유형과 무옵션 필터를 보지 않는다(나머지 필터는 같이 쓴다). 상가와 토지는 지역 칸과 검색어만 본다(나머지는 집 찾는 조건이라서). */
const auctionFilters = computed(() => ({ ...filters.value, deals: [], noOptionsOnly: false }));
const shopFilters = computed<Filters>(() => ({
  ...DEFAULT_FILTERS,
  areaIds: filters.value.areaIds,
  insideAreas: filters.value.insideAreas,
  distanceMax: filters.value.distanceMax,
  text: filters.value.text,
}));
const auctionFilterOf = (l: ListingView) => (auctionKindOf(l) === 'home' ? auctionFilters.value : shopFilters.value);
const auctionsAll = computed(() => current.value.filter((l) => sectionOf(l) === 'auction'));
/** 경매 탭에서 고른 종류(주거, 상가). 다음에 열어도 유지한다. 단독과 토지는 집터 탭에서 본다. */
const AUCTION_KINDS: AuctionKind[] = ['home', 'shop'];
const savedKind = localStorage.getItem('hnw-auction-kind') as AuctionKind | null;
const auctionKind = ref<AuctionKind>(savedKind && AUCTION_KINDS.includes(savedKind) ? savedKind : 'home');
watch(auctionKind, (k) => localStorage.setItem('hnw-auction-kind', k));
const ofAuctionKind = (l: ListingView) => inAuctionKind(l, auctionKind.value);
/** 매각기일 묶음 안 순서(기본 또는 평당 낮은 순). 다음에 열어도 유지한다. */
const auctionSort = ref<'default' | 'pyeong'>(localStorage.getItem('hnw-auction-sort') === 'pyeong' ? 'pyeong' : 'default');
watch(auctionSort, (s) => localStorage.setItem('hnw-auction-sort', s));
/** 필터를 통과한 경매(주거, 상가, 토지 모두, 탭 숫자에 씀) */
const auctionsBoth = computed(() =>
  sortAuctions(auctionsAll.value.filter((l) => passes(l, auctionFilterOf(l), areas.value)), auctionSort.value === 'pyeong'),
);
/** 경매 탭 목록: 고른 종류만(키보드 이동도 이 순서) */
const auctions = computed(() => auctionsBoth.value.filter(ofAuctionKind));
/** 경매 탭에 드는 경매(주거와 상가, 탭 숫자에 씀). 땅만 파는 물건은 집터 탭에 있다. */
const auctionsOfTab = computed(() => auctionsBoth.value.filter((l) => auctionKindOf(l) !== 'land'));
const auctionKinds = computed(() => {
  const count = (kind: AuctionKind) => {
    const list = auctionsBoth.value.filter((l) => inAuctionKind(l, kind));
    return { count: list.length, news: list.filter(hasNews).length + lhByKind.value[kind].filter((n) => n.isNew).length };
  };
  return { home: count('home'), house: count('house'), shop: count('shop'), land: count('land') };
});
/** 경매 탭 단독 칸 맨 위 오래된 단독주택 실거래 요약. age는 지은 지 몇 년 넘은 집을 볼지(다음에 열어도 유지). */
const houseAge = ref(Number(localStorage.getItem('hnw-house-age')) || 50);
watch(houseAge, (a) => {
  localStorage.setItem('hnw-house-age', String(a));
  void loadHouseTrades();
});
const houseTrades = ref<HouseTradeSummary | null>(null);
const houseFetching = ref(false);
const houseError = ref<string | null>(null);
async function loadHouseTrades() {
  try {
    houseTrades.value = await api.houseTrades(houseAge.value);
  } catch {
    /* 연결이 끊긴 것은 연결 안내가 알린다 */
  }
}
/** 국토부 실거래를 지금 받는다(단독 칸의 '받기') */
async function fetchHouseTrades() {
  houseFetching.value = true;
  houseError.value = null;
  try {
    houseTrades.value = await api.fetchHouseTrades(houseAge.value);
  } catch (e) {
    houseError.value = e instanceof Error ? e.message : String(e);
  } finally {
    houseFetching.value = false;
  }
}
/** 켜 둔 지역 근처 구의 법원경매 매각 결과, 그 구들과 서울 전체의 지역별 매각통계와 결과 요약(경매 탭 맨 위 '매각 결과' 칸). 근처 구가 바뀌면 다시 받는다. */
const auctionResults = ref<{ results: AuctionResultView[]; stats: CourtRegionStat[]; compare: AuctionResultSummary[] }>({ results: [], stats: [], compare: [] });
async function loadAuctionResults() {
  try {
    auctionResults.value = await api.auctionResults();
  } catch {
    /* 연결이 끊긴 것은 연결 안내가 알린다 */
  }
}
watch(
  () => (state.value?.gus ?? []).join(','),
  (now, before) => {
    if (before && now !== before) void Promise.all([loadAuctionResults(), loadHouseTrades()]);
  },
);
/** '지역 반경 안만' 때문에 가린 경매 수(고른 종류) */
function auctionsOutsideOf(kind: AuctionKind, shown: number) {
  if (!filters.value.insideAreas) return 0;
  const all = auctionsAll.value.filter((l) => inAuctionKind(l, kind));
  return all.filter((l) => passes(l, { ...auctionFilterOf(l), insideAreas: false }, areas.value)).length - shown;
}
const auctionsOutside = computed(() => auctionsOutsideOf(auctionKind.value, auctions.value.length));

// ---------- 집터 ----------
/** 집터 탭: 집을 지을 땅이나 헐고 지을 헌 집. 경매의 단독과 토지, 매매 매물 중 단독주택과 토지. 고른 칸은 다음에 열어도 유지한다. */
const PLOT_KINDS: AuctionKind[] = ['house', 'land'];
const savedPlotKind = localStorage.getItem('hnw-plot-kind') as AuctionKind | null;
const plotKind = ref<AuctionKind>(
  savedPlotKind && PLOT_KINDS.includes(savedPlotKind) ? savedPlotKind : savedKind && PLOT_KINDS.includes(savedKind) ? savedKind : 'house',
);
watch(plotKind, (k) => localStorage.setItem('hnw-plot-kind', k));
/** 매매 매물 중 집터 칸에 맞는 것(단독은 거래 유형을 뺀 필터, 토지는 지역 칸과 검색어만). 새 소식 먼저, 그다음 매매가 낮은 순. */
function plotSalesOf(kind: AuctionKind) {
  const f = kind === 'land' ? shopFilters.value : auctionFilters.value;
  const want = kind === 'land' ? 'land' : 'house';
  const price = (l: ListingView) => Math.min(...dealOptions(l, 'sale', f, areas.value).map((p) => p.price ?? Infinity));
  return homes.value
    .filter((l) => kindOf(l) === want && dealOptions(l, 'sale', f, areas.value).length > 0)
    .sort((a, b) => Number(hasNews(b)) - Number(hasNews(a)) || price(a) - price(b));
}
const plotAuctions = computed(() => auctionsBoth.value.filter((l) => inAuctionKind(l, plotKind.value)));
const plotSales = computed(() => plotSalesOf(plotKind.value));
/** 집터 탭 목록(화면 순서: 경매 다음 매매 매물). 키보드 이동에 쓴다. */
const plotList = computed(() => [...plotAuctions.value, ...plotSales.value]);
const plotOutside = computed(() => auctionsOutsideOf(plotKind.value, plotAuctions.value.length));
const plotKinds = computed(() => {
  const count = (kind: AuctionKind) => {
    const list = [...auctionsBoth.value.filter((l) => inAuctionKind(l, kind)), ...plotSalesOf(kind)];
    return { count: list.length, news: list.filter(hasNews).length + lhByKind.value[kind].filter((n) => n.isNew).length };
  };
  return { ...auctionKinds.value, house: count('house'), land: count('land') };
});

// ---------- 고시원과 쉐어 ----------
/** 고시원과 쉐어 탭은 거래 유형, 매물 유형, 무옵션 필터를 보지 않는다(모두 월세이고, 종류는 탭 안 종류 칸으로 고름). */
const roomFilters = computed(() => ({ ...filters.value, deals: [], kinds: [], noOptionsOnly: false }));
const roomsAll = computed(() => current.value.filter((l) => sectionOf(l) === 'room'));
const rooms = computed(() => sortRooms(roomsAll.value.filter((l) => passes(l, roomFilters.value, areas.value))));
const roomsOutside = computed(() => outsideCount(roomsAll.value, roomFilters.value, rooms.value.length));
/** 고시원과 쉐어 탭에서 고른 종류의 매물(화면 순서). 키보드 이동에 쓴다. */
const roomsVisible = ref<ListingView[]>([]);
const roomsView = ref<InstanceType<typeof RoomsView> | null>(null);

// ---------- 공고 ----------
// 임대 공고(SH, LH, 고방, 청약홈 민간임대)는 임대 공고 탭, 신탁 공매 공고는 경매 탭, 청약(분양) 공고는 청약 탭에 보인다.
const notices = ref<NoticeView[]>([]);
const noticeStatus = ref<Partial<Record<NoticeSourceId, NoticeSourceStatus>>>({});
async function loadNotices() {
  try {
    const data = await api.notices();
    notices.value = data.notices;
    noticeStatus.value = data.sources;
  } catch {
    /* 연결이 끊긴 것은 연결 안내가 알린다 */
  }
}
// 다른 창에서 공고를 확인했거나 새 공고가 들어오면 다시 받는다.
watch(
  () => state.value?.newNotices,
  (n, before) => {
    if (before !== undefined && n !== before) void loadNotices();
  },
);
const rentNotices = computed(() => notices.value.filter((n) => noticeSection(n) === 'rent'));
const trustNotices = computed(() => notices.value.filter((n) => noticeSection(n) === 'trust'));
const subNotices = computed(() => notices.value.filter((n) => noticeSection(n) === 'subscription'));
/** '지역 반경 안만'이면 켜진 지역 근처 구의 공고만(구를 모르는 공고는 늘 보임) */
const nearOnly = (list: NoticeView[]) => (filters.value.insideAreas ? list.filter((n) => inGus(n.regions, state.value?.gus ?? [])) : list);
/** 임대 공고 탭에 보이는 것 */
const rentShown = computed(() => nearOnly(rentNotices.value));
/** 경매 탭 상가와 토지 칸 위의 LH 공고(상가 공고, 토지 공고, 선착순 계약) */
const lhAll = computed(() => ({
  shop: notices.value.filter((n) => noticeSection(n) === 'shop'),
  land: notices.value.filter((n) => noticeSection(n) === 'land'),
}));
const lhByKind = computed<Record<AuctionKind, NoticeView[]>>(() => ({ home: [], house: [], shop: nearOnly(lhAll.value.shop), land: nearOnly(lhAll.value.land) }));

async function ackNotices(ids: number[]) {
  error.value = null;
  try {
    await api.ackNotices(ids);
    await Promise.all([loadNotices(), refreshState()]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** 매물 탭에서 지금 펼쳐져 보이는 매물(화면 순서). 키보드 이동에 쓴다. */
const overviewVisible = ref<ListingView[]>([]);
const overview = ref<InstanceType<typeof Overview> | null>(null);

const lists: Partial<Record<Tab, { readonly value: ListingView[] }>> = { overview: overviewVisible, star: starred, hidden, auction: auctions, plot: plotList, rooms: roomsVisible };
const currentList = computed(() => lists[tab.value]?.value ?? []);
const selectedId = computed(() => currentList.value[selected.value]?.id ?? null);
const selectedListing = computed(() => currentList.value[selected.value] ?? null);
watch(tab, (t) => {
  localStorage.setItem('hnw-tab', t);
  selected.value = 0;
});

/** 가격대를 펼치거나 접어도(고시원과 쉐어는 종류를 바꿔도) 고른 매물은 그대로 둔다. */
function setVisible(target: { value: ListingView[] }, owner: Tab, list: ListingView[]) {
  const id = tab.value === owner ? selectedId.value : null;
  target.value = list;
  const i = id ? list.findIndex((l) => l.id === id) : -1;
  if (i >= 0) selected.value = i;
}
const setOverviewVisible = (list: ListingView[]) => setVisible(overviewVisible, 'overview', list);
const setRoomsVisible = (list: ListingView[]) => setVisible(roomsVisible, 'rooms', list);

function selectListing(l: ListingView) {
  const i = currentList.value.findIndex((x) => x.id === l.id);
  if (i >= 0) selected.value = i;
}

/** 필터로 가려진 매물 수. 매물 탭은 매매와 전월세 모든 사이트를, 경매 탭과 집터 탭(경매만)과 고시원과 쉐어 탭은 그 탭 매물을 센다(관심과 숨김함은 필터를 안 씀). */
const hiddenCount = computed(() =>
  tab.value === 'overview'
    ? homes.value.filter((l) => !passes(l, filters.value, areas.value)).length
    : tab.value === 'auction'
      ? auctionsAll.value.filter(ofAuctionKind).length - auctions.value.length
      : tab.value === 'plot'
        ? auctionsAll.value.filter((l) => inAuctionKind(l, plotKind.value)).length - plotAuctions.value.length
        : tab.value === 'rooms'
          ? roomsAll.value.length - rooms.value.length
          : 0,
);

async function refreshState() {
  state.value = await api.state();
}
async function refreshListings() {
  listings.value = await api.listings();
}

let timer: number | undefined;
function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(poll, running.value ? 1000 : 10000);
}
async function poll() {
  const wasRunning = !!running.value;
  const naverBefore = state.value?.naverCapture.total;
  try {
    await refreshState();
    // 조회가 끝났을 때, 서버가 다시 켜진 뒤 처음 연결될 때, 크롬 확장이 네이버 화면 데이터를 새로 보냈을 때 목록도 새로 받는다.
    const naverChanged = naverBefore != null && state.value?.naverCapture.total !== naverBefore;
    if ((wasRunning && !running.value) || connectionError.value || naverChanged) {
      await Promise.all([refreshListings(), loadNotices(), loadAuctionResults(), loadHouseTrades()]);
      runsKey.value += 1;
    }
    connectionError.value = null;
  } catch {
    connectionError.value = '대시보드 프로그램에 연결할 수 없습니다. 프로그램이 켜져 있는지 확인해 주세요. 연결되면 이 문구는 사라집니다.';
  }
  schedule();
}

/** sources를 주면 그 사이트만 조회한다(경매 탭의 '경매 조회하기'). */
async function startRun(sources?: SourceId[]) {
  error.value = null;
  try {
    await api.startRun(visibleMode.value, sources);
    await refreshState();
    showLog.value = false;
    schedule();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function stopRun() {
  try {
    await api.stopRun();
    await refreshState();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function setVerdict(l: ListingView, verdict: Verdict | null) {
  l.verdict = verdict;
  l.isNew = false;
  l.priceChange = null;
  try {
    await api.setVerdict(l.id, verdict);
  } finally {
    await refreshListings();
    await refreshState();
  }
}

/** 법원경매 창을 여는 중과 결과 알림(화면 아래에 잠깐 뜸) */
const courtNote = ref<{ text: string; ok: boolean } | null>(null);
let courtNoteTimer: number | undefined;

/** 법원경매는 물건을 주소로 열 수 없어서, 프로그램이 띄운 크롬 창에서 법원과 사건번호로 찾아 상세를 연다. */
async function openCourt(l: ListingView) {
  window.clearTimeout(courtNoteTimer);
  courtNote.value = { text: '법원경매 창에서 여는 중…', ok: true };
  try {
    await api.openCourt(l.id);
    courtNote.value = { text: '법원경매 창에 열었습니다', ok: true };
    courtNoteTimer = window.setTimeout(() => (courtNote.value = null), 4000);
  } catch (e) {
    courtNote.value = { text: e instanceof Error ? e.message : String(e), ok: false };
    courtNoteTimer = window.setTimeout(() => (courtNote.value = null), 12000);
  }
}

async function openOriginal(l: ListingView) {
  if (l.source === 'courtauction') void openCourt(l);
  else window.open(originalUrl(l), '_blank', 'noopener');
  if (hasNews(l)) {
    await api.ack(l.id);
    await refreshListings();
    await refreshState();
  }
}

/** 지도에서 역을 누르면 그 역 지역을 켜고 끈다(없는 역이면 1km로 만들어 켬). */
async function toggleStation(s: CatalogStation) {
  if (!state.value) return;
  error.value = null;
  try {
    await toggleStationArea(state.value.areas, s);
    await refreshState();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** 지도에서 찍은 곳을 가운데로 1km 지역을 만든다. 이름은 1km 안의 가장 가까운 역을 따서 'OO역 근처', 없으면 '찍은 곳'. */
async function addPickedArea(p: { lat: number; lng: number }) {
  if (!state.value) return;
  error.value = null;
  try {
    const catalog = await loadCatalog().catch(() => []);
    const near = catalog
      .map((s) => ({ s, d: distanceM(p.lat, p.lng, s.lat, s.lng) }))
      .filter((x) => x.d <= 1000)
      .sort((a, b) => a.d - b.d)[0];
    const base = near ? `${near.s.name} 근처` : '찍은 곳';
    const taken = new Set(state.value.areas.map((a) => a.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
    await api.createArea({ name, lat: p.lat, lng: p.lng, radiusM: 1000, enabled: true });
    await refreshState();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** 지도에서 찍은 지역의 가운데 표시를 누르면 그 지역을 끈다. */
async function turnOffArea(a: Area) {
  if (!state.value) return;
  error.value = null;
  try {
    await setAreaEnabled(state.value.areas, a, false);
    await refreshState();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** 왼쪽 필터 칸 전체를 숨긴다(지도와 목록을 넓게). 숨긴 상태는 다음에 열어도 그대로. */
const filtersHidden = ref(localStorage.getItem('hnw-filters-hidden') === 'true');
watch(filtersHidden, (v) => localStorage.setItem('hnw-filters-hidden', String(v)));

/** 크롬 확장이 쓰는 사이트 번호의 이름 */
const SITE_NAMES: Record<string, string> = {
  naver: '네이버', dabang: '다방', zigbang: '직방', kbland: 'KB부동산', hogangnono: '호갱노노', daangn: '당근부동산', peterpanz: '피터팬', ziptoss: '집토스', gobang: '고방', courtauction: '법원경매',
};

// ---------- 한 번에 열기 ----------
// 웹 페이지는 창을 여러 개 한꺼번에 열 수 없어서(팝업 차단), 크롬 확장이 대시보드 안에 넣는 작은 스크립트(extension/dashboard.js)에 부탁한다.
// 확장은 확장에서 켜 둔 사이트만 새 창 하나에 연다. 피터팬, 집토스, 법원경매는 '조회하기'가 모으므로 기본으로 빠진다.
const ext = ref<{ version: string; sites: string[] } | null>(null);
const openNote = ref<{ text: string; ok: boolean } | null>(null);
let openNoteTimer: number | undefined;
let openWait: number | undefined;
const AUTO_SITES = ['peterpanz', 'ziptoss', 'gobang', 'courtauction'];
const openAllTitle = computed(() => {
  if (!ext.value) return '크롬 확장이 있어야 한 번에 열 수 있습니다';
  const skipped = AUTO_SITES.filter((id) => !ext.value!.sites.includes(id)).map((id) => SITE_NAMES[id]);
  return [
    `크롬 확장에서 켜 둔 사이트를 새 창 하나에 엽니다: ${ext.value.sites.map((id) => SITE_NAMES[id] ?? id).join(', ')}`,
    skipped.length ? `안 열어도 되는 곳: ${skipped.join(', ')} ('조회하기'가 모음)` : '',
  ].filter(Boolean).join('\n');
});

function showOpenNote(text: string, ok: boolean) {
  openNote.value = { text, ok };
  window.clearTimeout(openNoteTimer);
  openNoteTimer = window.setTimeout(() => (openNote.value = null), ok ? 6000 : 15000);
}

function onExtMessage(e: MessageEvent) {
  if (e.source !== window || e.data?.source !== 'hnw-extension') return;
  if (e.data.type === 'hello') ext.value = { version: String(e.data.version), sites: Array.isArray(e.data.sites) ? e.data.sites : [] };
  if (e.data.type === 'opened') {
    window.clearTimeout(openWait);
    showOpenNote(e.data.ok ? `새 창에 ${e.data.names.length}곳을 열었습니다.` : String(e.data.error), !!e.data.ok);
  }
}

function openAll(e?: MouseEvent) {
  // 누른 뒤 Enter로 매물을 열 때 이 버튼이 다시 눌리지 않게
  (e?.currentTarget as HTMLElement | undefined)?.blur();
  if (!ext.value) {
    showOpenNote('크롬 확장과 연결되지 않아 한 번에 열 수 없습니다. 확장(0.7.0 이상)이 깔린 크롬에서 이 페이지를 새로고침해 주세요.', false);
    return;
  }
  const a = linkArea.value;
  window.postMessage({ source: 'hnw-dashboard', type: 'open-sites', area: a ? { name: a.name, lat: a.lat, lng: a.lng, radiusM: a.radiusM } : null }, location.origin);
  window.clearTimeout(openWait);
  openWait = window.setTimeout(() => showOpenNote('크롬 확장이 답하지 않습니다. 이 페이지를 새로고침한 뒤 다시 눌러 주세요.', false), 4000);
}

/** '한 번에 열기' 옆 ▾ 메뉴: 열 지역 고르기와 사이트 하나만 열기. 바깥을 누르거나 Esc로 닫는다. */
const openMenu = ref(false);
const openMenuEl = ref<HTMLElement | null>(null);
const moreMenu = ref(false);
const moreMenuEl = ref<HTMLElement | null>(null);
watch(tab, () => { moreMenu.value = false; openMenu.value = false; });
function onDocClick(e: MouseEvent) {
  if (openMenu.value && openMenuEl.value && !openMenuEl.value.contains(e.target as Node)) openMenu.value = false;
  if (moreMenu.value && moreMenuEl.value && !moreMenuEl.value.contains(e.target as Node)) moreMenu.value = false;
}

/** 마지막 조회에서 실패한 사이트(사용자가 중단한 것은 빼고) */
const failedSources = computed(() => (state.value?.lastRun?.summary?.sources ?? []).filter((s) => s.status !== 'ok' && s.error !== '중단함'));
const failedTitle = computed(() =>
  [state.value?.lastRun?.status === 'error' ? state.value.lastRun.error : null, ...failedSources.value.map((s) => `${SOURCE_LABEL[s.source]}: ${s.error ?? '실패'}`)]
    .filter(Boolean)
    .join('\n'),
);

function scrollToSelected() {
  void nextTick(() => document.querySelector('.card.selected')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (e.key === 'Escape' && moreMenu.value) {
    moreMenu.value = false;
    moreMenuEl.value?.querySelector('button')?.focus();
    return;
  }
  if (e.key === 'Escape' && openMenu.value) {
    openMenu.value = false;
    return;
  }
  if (moreMenu.value || openMenu.value) return;
  const isRadio = tag === 'INPUT' && (e.target as HTMLInputElement).type === 'radio';
  if (isRadio && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Enter', 'Home', 'End'].includes(e.key)) return;
  if ((tag === 'INPUT' && !isRadio) || tag === 'SELECT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
  if ((tag === 'BUTTON' || tag === 'A') && (e.key === 'Enter' || e.key === ' ')) return;
  if (e.key === 'f') {
    filtersHidden.value = !filtersHidden.value;
    e.preventDefault();
    return;
  }
  // 숫자 키: 매물 탭에서는 거래 유형(1 월세, 2 전세 …), 고시원과 쉐어 탭에서는 종류, 목록 탭에서는 사이트(1 모든 사이트, 2 네이버 …).
  if (/^[1-9]$/.test(e.key)) {
    if (tab.value === 'overview') overview.value?.pickDeal(Number(e.key) - 1);
    else if (tab.value === 'rooms') roomsView.value?.pickType(Number(e.key) - 1);
    else if (usesSiteTabs.value) {
      const siteTab = siteTabs.value[Number(e.key) - 1];
      if (siteTab) site.value = siteTab.id;
    }
    e.preventDefault();
    return;
  }
  const list = currentList.value;
  if (!list.length) return;
  selected.value = Math.min(selected.value, list.length - 1);
  const item = list[selected.value];
  if (e.key === 'ArrowDown' || e.key === 'j') {
    selected.value = Math.min(selected.value + 1, list.length - 1);
    scrollToSelected();
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    selected.value = Math.max(selected.value - 1, 0);
    scrollToSelected();
  } else if (e.key === 'x') {
    void setVerdict(item, item.verdict === 'discard' ? null : 'discard');
  } else if (e.key === 's') {
    void setVerdict(item, item.verdict === 'star' ? null : 'star');
  } else if (e.key === 'Enter' || e.key === 'o') {
    void openOriginal(item);
  } else return;
  e.preventDefault();
}

onMounted(async () => {
  if (headerEl.value) {
    headerObserver = new ResizeObserver(() => {
      headerHeight.value = Math.ceil(headerEl.value?.getBoundingClientRect().height ?? 80);
    });
    headerObserver.observe(headerEl.value);
  }
  try {
    await Promise.all([refreshState(), refreshListings(), loadNotices(), loadAuctionResults(), loadHouseTrades()]);
    if (state.value && state.value.autoCheck.visible !== visibleMode.value) void api.setAutoCheck({ visible: visibleMode.value }).catch(() => {});
    if (openNewsRow) {
      await nextTick();
      overview.value?.openNews();
    }
  } catch {
    connectionError.value = '대시보드 프로그램에 연결할 수 없습니다. 프로그램이 켜져 있는지 확인해 주세요. 연결되면 이 문구는 사라집니다.';
  }
  schedule();
  window.addEventListener('keydown', onKey);
  window.addEventListener('message', onExtMessage);
  document.addEventListener('click', onDocClick);
  window.postMessage({ source: 'hnw-dashboard', type: 'ping' }, location.origin);
});
onBeforeUnmount(() => {
  headerObserver?.disconnect();
  document.removeEventListener('click', onDocClick);
  window.removeEventListener('message', onExtMessage);
  window.clearTimeout(timer);
  window.removeEventListener('keydown', onKey);
});

/** 보기 탭. count는 탭 옆 숫자, news는 '신규 N' 표시. main은 앞쪽 큰 탭, 나머지는 오른쪽 작은 탭. */
const tabs = computed<{ id: Tab; label: string; count: number | null; news?: number; near?: number; title?: string; main?: boolean }[]>(() => [
  { id: 'overview', label: '매물', count: null, news: homeNews.value, title: '매매와 전월세', main: true },
  { id: 'star', label: '관심', count: starred.value.length, main: true },
  {
    id: 'auction', label: '경매', count: auctionsOfTab.value.length,
    news: auctionsOfTab.value.filter(hasNews).length + [...trustNotices.value, ...lhByKind.value.shop].filter((n) => n.isNew).length,
    title: '법원경매와 온비드의 주거와 상가, 신탁 공매 공고', main: true,
  },
  {
    id: 'plot', label: '집터', count: plotKinds.value.house.count + plotKinds.value.land.count,
    news: plotKinds.value.house.news + plotKinds.value.land.news,
    title: '집을 지을 땅이나 헐고 지을 헌 집: 단독주택과 토지의 경매, 매매 매물, 실거래, LH 토지 공고', main: true,
  },
  {
    id: 'subs', label: '청약', count: subNotices.value.filter((n) => !isPastNotice(n)).length, news: subNotices.value.filter((n) => n.isNew).length,
    title: '서울 청약(분양) 공고: 접수 예정과 접수중', main: true,
  },
  {
    id: 'rooms', label: '고시원과 쉐어', count: rooms.value.length, news: rooms.value.filter(hasNews).length,
    title: '고방의 고시원, 원룸텔, 쉐어하우스, 코리빙과 기업형 코리빙', main: true,
  },
  {
    id: 'notices', label: '임대 공고', count: rentShown.value.filter((n) => n.current).length, news: rentShown.value.filter((n) => n.isNew).length,
    near: rentShown.value.filter((n) => n.current && nearReason(n, state.value?.gus ?? [], state.value?.nearNames ?? [])).length,
    title: 'SH, LH, 고방 등의 청년과 공공 임대 모집 공고', main: true,
  },
  { id: 'support', label: '지원 제도', count: null, title: '전세 대출, 전세보증금 반환보증, 월세 지원 같은 국가와 서울시 제도', main: true },
  { id: 'hidden', label: '숨김함', count: hidden.value.length },
  { id: 'runs', label: '조회 기록', count: null },
  { id: 'sites', label: '사이트', count: null, title: '수집처 체크리스트' },
  { id: 'areas', label: '지역', count: null },
  { id: 'alerts', label: '설정', count: null, title: '조회 방식과 조회가 끝나면 띄울 알림' },
]);
const mainTabs = computed(() => tabs.value.filter((t) => t.main));
const moreTabs = computed(() => tabs.value.filter((t) => !t.main));

/**
 * 탭마다 필터 칸에서 안 쓰는 칸(흐리게 보임). 'all'은 필터를 안 쓰는 탭이라 모든 칸이 흐리다(칸은 그 자리에 그대로 있다).
 * 경매 탭은 거래 유형을 안 보고, 상가는 지역과 검색어만 본다. 집터 탭은 단독이면 경매 탭 주거와 같고 토지는 상가와 같다.
 * 고시원과 쉐어는 거래 유형과 매물 유형, 임대 공고는 '지역 반경 안만'만 본다.
 */
const filterUse = computed<string[] | 'all'>(() => {
  switch (tab.value) {
    case 'star':
    case 'hidden':
    case 'subs':
    case 'support':
    case 'runs':
    case 'sites':
    case 'areas':
    case 'alerts':
      return 'all';
    case 'auction':
      return auctionKind.value === 'home' ? ['deal'] : ['deal', 'kind', 'price', 'home'];
    case 'plot':
      return plotKind.value === 'house' ? ['deal'] : ['deal', 'kind', 'price', 'home'];
    case 'rooms':
      return ['deal', 'kind'];
    case 'notices':
      return ['deal', 'kind', 'price', 'home', 'text'];
    default:
      return [];
  }
});

const emptyText: Partial<Record<Tab, string>> = {
  star: '관심 표시한 매물이 없습니다. 매물에서 ★ 관심(S)을 누르세요.',
  hidden: '버린 매물이 없습니다.',
};
</script>

<template>
  <div class="app-frame" :style="{ '--app-header-height': `${headerHeight}px` }">
  <header ref="headerEl" class="top">
    <div class="brand">
      <h1>회사근처 내집마련</h1>
      <span class="muted areas-line">{{ areas.map((a) => `${a.name} ${radiusText(a.radiusM)}`).join(', ') || '켜진 지역 없음' }}</span>
    </div>
    <nav class="tabs" aria-label="주요 메뉴">
      <button
        v-for="t in mainTabs" :key="t.id" class="tab" :class="{ on: tab === t.id }"
        :aria-current="tab === t.id ? 'page' : undefined"
        :title="[t.title, t.news ? `신규 ${t.news}건` : '', t.near ? `근처 공고 ${t.near}건` : ''].filter(Boolean).join('\n')"
        @click="tab = t.id"
      >
        {{ t.label }}<span v-if="t.count !== null" class="count num">{{ t.count }}</span>
        <span v-if="t.news" class="nav-dot" :aria-label="`신규 ${t.news}건`"></span>
      </button>
    </nav>
    <div class="controls">
      <button v-if="filtersHidden" class="show-filters" title="필터 칸 열기 (F)" @click="filtersHidden = false">필터 열기</button>
      <button
        v-if="state?.autoCheck.missed && !running" class="btn btn-sm missed"
        title="마지막 자동 확인 시각에 대시보드가 꺼져 있었고 그 뒤로 조회하지 않았습니다" @click="startRun()"
      >자동 확인 놓침, 지금 확인</button>
      <div ref="openMenuEl" class="openall">
        <button class="open-main" :title="openAllTitle" @click="openAll">
          한 번에 열기<span v-if="ext" class="open-count">{{ ext.sites.length }}곳</span>
        </button>
        <button
          class="open-more" :aria-expanded="openMenu" aria-haspopup="true" aria-label="열 지역 고르기, 사이트 하나만 열기"
          title="열 지역 고르기, 사이트 하나만 열기" @click="openMenu = !openMenu"
        >▾</button>
        <div v-if="openMenu" class="open-menu">
          <template v-if="areas.length > 1">
            <span class="menu-label">열 지역</span>
            <div class="menu-areas">
              <button
                v-for="a in areas" :key="a.id" class="menu-area" :class="{ on: linkArea?.id === a.id }" :aria-pressed="linkArea?.id === a.id"
                @click="linkAreaId = a.id"
              >{{ a.name }} {{ radiusText(a.radiusM) }}</button>
            </div>
          </template>
          <span class="menu-label">하나만 열기</span>
          <a
            v-for="l in links" :key="l.id" class="menu-link" :href="l.url" target="_blank" rel="noopener" :title="l.where"
            @click="openMenu = false"
          >{{ l.name }} ↗</a>
        </div>
      </div>
      <button class="btn btn-primary run" :disabled="!!running" @click="startRun()">
        {{ running ? '조회 중…' : '조회하기' }}
      </button>
      <div ref="moreMenuEl" class="more-menu">
        <button class="more-trigger" :class="{ on: moreTabs.some((t) => t.id === tab) }" :aria-expanded="moreMenu" aria-controls="management-menu" @click="moreMenu = !moreMenu">
          {{ moreTabs.find((t) => t.id === tab)?.label ?? '더보기' }}
          <span v-if="failedSources.length || state?.lastRun?.status === 'error'" class="issue-dot" aria-label="조회 오류 있음"></span>
          <span aria-hidden="true">▾</span>
        </button>
        <div v-if="moreMenu" id="management-menu" class="management-menu">
          <nav aria-label="관리 메뉴">
            <button v-for="t in moreTabs" :key="t.id" :aria-current="tab === t.id ? 'page' : undefined" :title="t.title" @click="tab = t.id; moreMenu = false">
              {{ t.label }}<span v-if="t.count" class="muted num">{{ t.count }}</span>
            </button>
          </nav>
          <div v-if="state" class="when">
            <span v-if="state.lastRun && !running">
              마지막 조회 {{ dateTime(state.lastRun.finishedAt ?? state.lastRun.startedAt) }}<template v-if="state.lastRun.status === 'stopped'"> 중단</template>
              <button v-if="failedSources.length || state.lastRun.status === 'error'" class="linkish err" :title="failedTitle" @click="tab = 'sites'; moreMenu = false">실패 {{ failedSources.length || '' }}곳</button>
            </span>
            <button class="linkish" title="자동 확인 요일과 시각, 창 띄우기는 설정에서 바꿉니다" @click="tab = 'alerts'; moreMenu = false">{{ autoCheckText }}</button>
          </div>
        </div>
      </div>
    </div>
  </header>

  <div v-if="running" class="progress">
    <div class="spinner" aria-hidden="true"></div>
    <div class="progress-body">
      <strong>{{ running.message }}</strong>
      <div class="muted small">{{ running.log.slice(-1)[0] ?? '' }}</div>
    </div>
    <button class="btn btn-ghost btn-sm" @click="showLog = !showLog">{{ showLog ? '기록 접기' : '기록 보기' }}</button>
    <button class="btn btn-sm stop" :disabled="running.stopping" title="지금 보던 사이트에서 멈춥니다. 다 모은 사이트 결과는 남습니다" @click="stopRun">
      {{ running.stopping ? '멈추는 중…' : '중단' }}
    </button>
  </div>
  <pre v-if="running && showLog" class="livelog">{{ running.log.join('\n') }}</pre>

  <p v-if="connectionError" class="error">{{ connectionError }}</p>
  <p v-if="error" class="error">{{ error }}</p>

  <div class="layout" :class="{ 'no-side': filtersHidden, idle: filterUse === 'all' }">
    <FilterPanel
      v-show="!filtersHidden" v-model="filters" :hidden-count="filterUse === 'all' ? 0 : hiddenCount" :all-areas="state?.areas ?? []" :unused="filterUse"
      :deal-choices="dealChoices" :single-deal="tab === 'overview'"
      class="side" @manage-areas="tab = 'areas'" @hide="filtersHidden = true"
    />

    <main class="main">
      <template v-if="usesSiteTabs">
        <section class="feed-controls" :aria-label="`${tab === 'star' ? '관심' : '숨김함'} 목록 조건`">
          <div class="feed-heading">
            <h2>
              {{ tab === 'star' ? '관심' : '숨김함' }}
              <span class="num">{{ currentList.length }}</span>
            </h2>
          </div>
          <fieldset class="source-filter">
            <legend class="sr-only">사이트 선택</legend>
            <span class="filter-label" aria-hidden="true">사이트</span>
            <label v-for="(s, i) in siteTabs" :key="s.id" class="source-choice" :class="{ on: site === s.id }" :title="`${s.total}건, 새 소식 ${s.news}건\n${i + 1}번 키로 선택`">
              <input v-model="site" type="radio" name="listing-site" :value="s.id" />
              {{ s.id === 'all' ? '전체' : s.label }}
              <span class="source-count num" :aria-label="`매물 ${s.total}건`">{{ s.total }}</span>
            </label>
          </fieldset>
        </section>
      </template>

      <template v-if="tab === 'overview'">
        <Overview
          ref="overview" :listings="homes" :filters="filters" :areas="areas" :selected-id="selectedId"
          @visible="setOverviewVisible" @select="(l) => (selectListing(l), scrollToSelected())" @open="openOriginal" @verdict="setVerdict"
          @source="(l) => (sourceOf = l)" @raw="showRaw" @areas="(ids) => (filters.areaIds = ids)" @deals="(d) => (filters.deals = d)" @station="toggleStation"
          @pick="addPickedArea" @area="turnOffArea"
        />
      </template>

      <template v-else-if="tab === 'star' || tab === 'hidden'">
        <div class="listing-layout"><div class="listing-feed">
        <div class="list">
          <ListingCard
            v-for="(l, i) in currentList" :key="l.id" :listing="l" :areas="areas" :selected="i === selected"
            @select="selected = i" @open="openOriginal(l)" @verdict="(v) => setVerdict(l, v)" @source="sourceOf = l" @raw="showRaw(l)"
          />
          <p v-if="!currentList.length" class="empty muted">
            <template v-if="site === 'naver' && !listings.some((l) => l.source === 'naver')">
              네이버 매물은 크롬 확장으로 받습니다. 네이버 부동산 지도에서 동그라미를 눌러 목록을 보시면 여기에 모입니다.<br />
              지금까지 받은 화면 데이터 {{ state?.naverCapture.total ?? 0 }}건
            </template>
            <template v-else>{{ emptyText[tab] }}</template>
          </p>
        </div>
        </div><aside class="listing-side">
          <ListingDetail
            :listing="selectedListing" :areas="areas" @open="selectedListing && openOriginal(selectedListing)"
            @verdict="(v) => selectedListing && setVerdict(selectedListing, v)" @source="sourceOf = selectedListing"
            @raw="selectedListing && showRaw(selectedListing)"
          />
        </aside></div>
      </template>

      <template v-else-if="tab === 'auction'">
        <AuctionView
          title="경매" :kind-ids="AUCTION_KINDS"
          :listings="auctions" :outside="auctionsOutside" :areas="areas" :selected-id="selectedId" :running="!!running"
          :kind="auctionKind" :kinds="auctionKinds" @kind="(k) => (auctionKind = k, selected = 0)"
          :sort="auctionSort" @sort="(v) => (auctionSort = v, selected = 0)"
          :notices="trustNotices" :lh-notices="lhByKind[auctionKind]" :lh-outside="auctionKind === 'shop' ? lhAll.shop.length - lhByKind.shop.length : 0"
          :notice-status="noticeStatus" :results="auctionResults.results" :region-stats="auctionResults.stats" :compare="auctionResults.compare" :gus="state?.gus ?? []"
          :house-trades="houseTrades" :house-age="houseAge" :house-fetching="houseFetching" :house-error="houseError"
          @house-age="(a) => (houseAge = a)" @house-fetch="fetchHouseTrades"
          @select="(l) => (selectListing(l), scrollToSelected())" @open="openOriginal" @verdict="setVerdict"
          @source="(l) => (sourceOf = l)" @raw="showRaw" @station="toggleStation" @pick="addPickedArea" @area="turnOffArea"
          @ack-notices="ackNotices" @run="startRun(['courtauction', 'onbid'])"
        />
      </template>
      <template v-else-if="tab === 'plot'">
        <AuctionView
          title="집터" :kind-ids="PLOT_KINDS" :sales="plotSales" :trust="false" :links="MODULAR_LINKS"
          :listings="plotAuctions" :outside="plotOutside" :areas="areas" :selected-id="selectedId" :running="!!running"
          :kind="plotKind" :kinds="plotKinds" @kind="(k) => (plotKind = k, selected = 0)"
          :sort="auctionSort" @sort="(v) => (auctionSort = v, selected = 0)"
          :notices="[]" :lh-notices="lhByKind[plotKind]" :lh-outside="plotKind === 'land' ? lhAll.land.length - lhByKind.land.length : 0"
          :notice-status="noticeStatus" :results="auctionResults.results" :region-stats="auctionResults.stats" :compare="auctionResults.compare" :gus="state?.gus ?? []"
          :house-trades="houseTrades" :house-age="houseAge" :house-fetching="houseFetching" :house-error="houseError"
          @house-age="(a) => (houseAge = a)" @house-fetch="fetchHouseTrades"
          @select="(l) => (selectListing(l), scrollToSelected())" @open="openOriginal" @verdict="setVerdict"
          @source="(l) => (sourceOf = l)" @raw="showRaw" @station="toggleStation" @pick="addPickedArea" @area="turnOffArea"
          @ack-notices="ackNotices" @run="startRun(['courtauction', 'onbid'])"
        />
      </template>
      <template v-else-if="tab === 'rooms'">
        <RoomsView
          ref="roomsView" :listings="rooms" :outside="roomsOutside" :areas="areas" :selected-id="selectedId"
          @visible="setRoomsVisible" @select="(l) => (selectListing(l), scrollToSelected())" @open="openOriginal"
          @verdict="setVerdict" @source="(l) => (sourceOf = l)" @raw="showRaw" @station="toggleStation" @pick="addPickedArea" @area="turnOffArea"
        />
      </template>
      <SubscriptionsView v-else-if="tab === 'subs'" :notices="subNotices" :sources="noticeSourcesOf('subscription')" :status="noticeStatus" @ack="ackNotices" />
      <NoticesView
        v-else-if="tab === 'notices'" :notices="rentNotices" :sources="noticeSourcesOf('rent')" :status="noticeStatus"
        :gus="state?.gus ?? []" :names="state?.nearNames ?? []" :inside="filters.insideAreas" @ack="ackNotices"
      />
      <SupportView v-else-if="tab === 'support'" @notices="tab = 'notices'" />
      <RunHistory v-else-if="tab === 'runs'" :refresh-key="runsKey" />
      <SitesTab
        v-else-if="tab === 'sites' && state" :state="state" :links="links" :ext-ready="!!ext" :notices="notices" :notice-status="noticeStatus"
        @open-all="openAll()"
      />
      <AreaSettings v-else-if="tab === 'areas' && state" :areas="state.areas" @changed="refreshState" />
      <AlertsTab
        v-else-if="tab === 'alerts' && state" :settings="state.alerts" :visible="visibleMode" :auto-time="state.autoCheck.time" :auto-day="state.autoCheck.day" :notice-time="state.autoCheck.noticeTime"
        :auto-times="autoTimes" :running="!!running" @changed="refreshState" @visible="(v) => (visibleMode = v)"
        @auto-time="(time) => setAutoCheck({ time })" @auto-day="(day) => setAutoCheck({ day })" @notice-time="(noticeTime) => setAutoCheck({ noticeTime })"
      />
    </main>
  </div>

  <div v-if="openNote || courtNote" class="toasts">
    <div v-if="openNote" class="toast" :class="{ err: !openNote.ok }" role="status">{{ openNote.text }}</div>
    <div v-if="courtNote" class="toast" :class="{ err: !courtNote.ok }" role="status">{{ courtNote.text }}</div>
  </div>

  <div v-if="sourceOf?.seenRef" class="overlay" @click.self="sourceOf = null">
    <div class="dialog">
      <div class="dialog-head">
        <h3>이 매물을 모은 화면</h3>
        <button class="btn btn-sm" @click="sourceOf = null">닫기</button>
      </div>
      <p class="muted small">
        조회 #{{ sourceOf.seenRef.runId }}, {{ SOURCE_LABEL[sourceOf.source] }},
        <a v-if="sourceOf.seenRef.pageUrl" :href="sourceOf.seenRef.pageUrl" target="_blank" rel="noopener">그때 연 페이지</a>
      </p>
      <img v-if="sourceOf.seenRef.screenshot" :src="sourceOf.seenRef.screenshot" alt="조회 당시 화면" class="shot" />
    </div>
  </div>

  <div v-if="rawOf" class="overlay" @click.self="rawOf = null">
    <div class="dialog">
      <div class="dialog-head">
        <h3>원본 데이터: {{ SOURCE_LABEL[rawOf.listing.source] }} {{ rawOf.listing.sourceId }}</h3>
        <button class="btn btn-sm" @click="rawOf = null">닫기</button>
      </div>
      <p class="muted small">사이트가 준 원래 값을 도구가 어떻게 바꿔 저장했는지입니다. 추정한 값은 설명에 적혀 있습니다.</p>
      <table class="explain">
        <thead><tr><th>항목</th><th>사이트가 준 값</th><th>저장한 값</th><th>설명</th></tr></thead>
        <tbody>
          <tr v-for="row in rawOf.explain" :key="row.label">
            <td><strong>{{ row.label }}</strong></td>
            <td class="mono">{{ row.raw }}</td>
            <td>{{ row.value }}</td>
            <td class="muted">{{ row.note ?? '' }}</td>
          </tr>
          <tr v-if="!rawOf.explain.length"><td colspan="4" class="muted">이 매물은 설명표가 없습니다. 다음 조회 때 채워집니다.</td></tr>
        </tbody>
      </table>
      <details>
        <summary>사이트 데이터 전체 보기</summary>
        <pre class="rawjson">{{ rawOf.raw ? JSON.stringify(rawOf.raw, null, 2) : '저장된 원본이 없습니다. 다음 조회 때 채워집니다.' }}</pre>
      </details>
    </div>
  </div>
  </div>
</template>

<style scoped>
.top {
  position: sticky; top: 0; z-index: 20;
  display: grid; grid-template-columns: minmax(160px, 1fr) auto minmax(240px, 1fr); align-items: center; gap: 16px;
  padding: 12px 24px; background: var(--surface); border-bottom: 1px solid var(--line);
}
.brand { display: grid; gap: 2px; min-width: 0; }
h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.areas-line { font-size: 12px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.controls { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; min-width: 0; }
.run { min-height: 38px; padding: 0 14px; font-size: 13px; }
.missed { border-color: var(--new); color: var(--new); }
.more-menu { position: relative; }
.more-trigger { display: flex; align-items: center; gap: 7px; min-height: 38px; padding: 0 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--ink-2); font-size: 13px; font-weight: 600; }
.more-trigger.on { color: var(--accent); background: var(--accent-soft); border-color: var(--line-strong); }
.management-menu { position: absolute; right: 0; top: calc(100% + 8px); width: min(300px, calc(100vw - 32px)); padding: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); box-shadow: 0 10px 30px #16202e21; }
.management-menu nav { display: grid; }
.management-menu nav button { display: flex; align-items: center; justify-content: space-between; min-height: 40px; padding: 8px 12px; border: 0; border-radius: 6px; background: transparent; text-align: left; font: inherit; color: var(--ink-2); }
.management-menu nav button:hover, .management-menu nav button[aria-current='page'] { background: var(--surface-2); color: var(--ink); }
.when { display: grid; gap: 8px; padding: 12px; margin-top: 6px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.when .linkish { text-align: left; }
.issue-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--new); }
.linkish {
  padding: 0; border: 0; background: none; font: inherit; color: var(--muted); cursor: pointer;
  text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px;
}
.linkish:hover { color: var(--ink); }
.linkish.err { margin-left: 6px; color: var(--new); font-weight: 700; text-decoration: none; }
/* 한 번에 열기 + ▾ 메뉴(열 지역, 사이트 하나만 열기) */
.openall { position: relative; display: flex; }
.open-main, .open-more {
  min-height: 38px; border: 1px solid var(--line-strong); background: var(--surface);
  font-family: inherit; font-weight: 700; color: var(--ink-2); cursor: pointer;
}
.open-main { display: inline-flex; align-items: center; gap: 8px; padding: 0 12px; border-radius: 10px 0 0 10px; font-size: 13px; }
.open-more { width: 30px; margin-left: -1px; border-radius: 0 10px 10px 0; font-size: 13px; }
.open-main:hover, .open-more:hover, .open-more[aria-expanded='true'] { border-color: var(--ink-2); color: var(--ink); position: relative; }
.open-count { padding: 1px 8px; border-radius: 999px; background: var(--surface-2); font-size: 13px; font-weight: 600; color: var(--muted); }
.open-menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; display: grid; gap: 4px; min-width: 260px; padding: 12px;
  background: var(--surface); border: 1px solid var(--line-strong); border-radius: 12px; box-shadow: 0 10px 30px rgba(22, 32, 46, .18);
}
.menu-label { margin-top: 2px; font-size: 12px; font-weight: 700; color: var(--muted); }
.menu-areas { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.menu-area { min-height: 36px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); font-size: 14px; font-weight: 700; }
.menu-area.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.menu-link { display: flex; align-items: center; min-height: 40px; padding: 0 10px; border-radius: 8px; font-size: 15px; font-weight: 600; color: var(--ink-2); text-decoration: none; }
.menu-link:hover { background: var(--surface-2); color: var(--ink); }

.progress {
  display: flex; align-items: center; gap: 14px; padding: 12px 24px;
  background: #eef3fb; border-bottom: 1px solid var(--line);
}
.progress-body { flex: 1; display: grid; }
.progress .stop { border-color: var(--new); color: var(--new); }
.spinner { width: 22px; height: 22px; border-radius: 50%; border: 3px solid #c8d6ee; border-top-color: var(--accent); animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
.livelog { margin: 0; padding: 12px 24px; background: var(--ink); color: #e8edf3; font-size: 13px; max-height: 240px; overflow: auto; white-space: pre-wrap; }
.err, .error { color: var(--new); font-weight: 600; }
.error { margin: 8px 24px 0; }
.small { font-size: 13px; }

.layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); grid-template-areas: 'filters content'; gap: 24px; padding: 22px 28px 60px; align-items: start; }
.layout.no-side { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'content'; }
.show-filters {
  align-self: center; min-height: 40px; margin-right: 8px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: 10px;
  background: var(--surface); font-size: 14px; font-weight: 700; color: var(--ink-2);
}
.side {
  grid-area: filters; position: sticky; top: calc(var(--app-header-height) + 16px); max-height: calc(100dvh - var(--app-header-height) - 32px);
  overflow: auto; padding-right: 4px;
}
.main { grid-area: content; display: grid; gap: 20px; min-width: 0; }
/* 새 소식, 관심, 숨김함: 목록(왼쪽)과 고른 매물 상세(오른쪽, 따라 내려옴). 좁으면 상세가 목록 아래로 간다. */
.listing-layout { display: grid; grid-template-columns: minmax(0, 1fr) 270px; gap: 22px; align-items: start; }
.listing-feed { display: grid; gap: 16px; min-width: 0; }
.listing-side { position: sticky; top: calc(var(--app-header-height) + 16px); min-width: 0; }
.tabs { min-width: 0; display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 3px; }
.tab {
  position: relative; display: inline-flex; align-items: center; min-height: 42px; padding: 0 12px;
  border: 0; border-radius: 7px; background: transparent; white-space: nowrap;
  font-size: 14px; font-weight: 650; color: var(--ink-2);
}
.tab:hover { color: var(--ink); background: var(--surface-2); }
.tab.on { color: var(--workspace-selected-ink); background: var(--workspace-selected); }
.count { margin-left: 5px; font-size: 12px; font-weight: 500; color: var(--muted); }
.tab.on .count { color: #cfdef1; }
.nav-dot { width: 5px; height: 5px; margin-left: 5px; align-self: flex-start; margin-top: 10px; border-radius: 50%; background: var(--new); }
.tab.on .nav-dot { background: #ffd2dd; }
.feed-controls { display: grid; gap: 10px; }
.feed-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; }
.feed-heading h2 { margin: 0; font-size: 22px; font-weight: 700; }
.feed-heading h2 .num { margin-left: 4px; }
.source-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 18px; min-width: 0; margin: 0; padding: 4px 0 12px; border: 0; border-bottom: 1px solid var(--line); }
.filter-label { color: var(--muted); font-size: 12px; }
.source-choice { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; font-size: 13px; color: var(--ink-2); cursor: pointer; }
.source-choice.on { color: var(--ink); font-weight: 650; }
.source-choice input { margin: 0; width: 14px; height: 14px; }
.source-count { font-size: 12px; color: var(--muted); font-weight: 400; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.list { display: grid; gap: 8px; container-type: inline-size; }
.empty { padding: 40px 0; text-align: center; }

.toasts {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 80;
  display: grid; gap: 8px; justify-items: center; width: max-content; max-width: min(640px, calc(100vw - 32px));
}
.toast {
  padding: 12px 18px; border-radius: 10px; background: var(--ink); color: #fff; font-size: 14px; font-weight: 600; box-shadow: 0 8px 24px rgba(22, 32, 46, .3);
}
.toast.err { background: var(--new); }
.overlay { position: fixed; inset: 0; background: rgba(22, 32, 46, .45); display: grid; place-items: center; padding: 24px; z-index: 50; }
.dialog { background: var(--surface); border-radius: 12px; width: min(1100px, 100%); max-height: 90vh; overflow: auto; padding: 20px; display: grid; gap: 10px; }
.dialog-head { display: flex; align-items: center; justify-content: space-between; }
.dialog h3 { margin: 0; }
.shot { width: 100%; border: 1px solid var(--line); border-radius: 8px; }
.explain { width: 100%; border-collapse: collapse; font-size: 14px; }
.explain th, .explain td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
.explain th { background: var(--surface-2); font-size: 13px; color: var(--ink-2); }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
.rawjson { margin: 8px 0 0; padding: 12px; background: var(--ink); color: #e8edf3; border-radius: 8px; font-size: 12px; max-height: 420px; overflow: auto; }
summary { cursor: pointer; font-weight: 600; }

@media (max-width: 1460px) {
  .top { grid-template-columns: minmax(0, 1fr) auto; gap: 10px 16px; }
  .tabs { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; }
}
@media (max-width: 1250px) {
  .listing-layout { grid-template-columns: minmax(0, 1fr); }
  .listing-side { position: static; }
}
/* 좁으면 헤더는 따라 내려오지 않고, 필터 칸은 본문 위로 간다. */
@media (max-width: 900px) {
  .top { position: static; padding: 14px 16px; }
  .layout { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'filters' 'content'; padding: 20px 16px 40px; }
  .layout.no-side, .layout.idle { grid-template-areas: 'content'; padding: 20px 16px 40px; }
  .layout.idle > .side { display: none; }
  .side { position: static; max-height: none; }
}
@media (max-width: 520px) {
  .top { display: flex; flex-wrap: wrap; gap: 12px; }
  .brand, .controls { width: 100%; }
  .controls { position: relative; justify-content: flex-start; }
  .tabs { width: 100%; order: 3; gap: 2px; }
  .tab { min-height: 42px; padding-inline: 9px; font-size: 13px; }
  .more-menu, .openall { position: static; }
  .management-menu { right: 0; }
  .open-menu { right: 0; min-width: 0; width: min(320px, 100%); }
  .source-filter { gap: 4px 14px; }
  .layout, .layout.no-side, .layout.idle { padding: 18px 12px 36px; }
}
</style>
