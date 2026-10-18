<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { SEOUL_GUS, type AppState, type Area, type CourtRegionStat, type ListingView, type Verdict } from '../../../shared/types';
import type { CatalogStation } from '../areaActions';
import {
  APT_CHECKED, APT_KINDS, APT_RULES, APT_STATUS_TEXT, APT_SUMMARY, aptKindOf, aptPrice, HOUSEHOLD_NOTE, HOUSEHOLD_SOURCES, HOUSEHOLD_STEPS, liveChip,
  type AptKind,
} from '../apt';
import { expectedPrices, sortAuctions } from '../auction';
import { manwon } from '../format';
import CountTooltip from './CountTooltip.vue';
import HouseholdsChip from './HouseholdsChip.vue';
import ListingCard from './ListingCard.vue';
import OverviewMap from './OverviewMap.vue';
import ZoneBanner from './ZoneBanner.vue';

// 서울 아파트 탭: 회사와 멀어도 고른 서울 구의 아파트를 경매(법원경매), 공매(온비드), 매매(네이버)로 나눠 본다.
// 맨 위에 모을 구 고르기와 살 때 붙는 조건(실거주·대출·양도세), 그 아래 이 탭만의 필터(종류, 구, 세대수, 가격)와 목록(왼쪽), 지도(오른쪽).
// 왼쪽 필터 칸(회사 근처 집 찾는 조건)은 쓰지 않는다. 필터와 접은 칸은 이 브라우저에 기억한다.

type Point = { lat: number; lng: number };
const props = defineProps<{
  /** 서울 아파트(경매·공매·매매 매물, 버림과 사라짐 뺀 것) */
  listings: ListingView[];
  areas: Area[];
  selectedId: string | null;
  /** 조회 중(무엇이든)이면 '경매 조회하기'를 막는다 */
  running: boolean;
  /** 고른 구(법원경매·온비드가 반경 밖이어도 아파트를 모으는 구) */
  aptGus: string[];
  /** 켜진 지역 근처 구(원래 모으는 구) */
  nearGus: string[];
  /** 법원 지역별 매각통계(예상 낙찰가) */
  regionStats: CourtRegionStat[];
  /** 건축물대장 세대수 채우기 상태(키를 넣었는지, 마지막 결과), 지금 채우는 중, 채우다 난 오류 */
  fill: AppState['householdsFill'];
  filling: boolean;
  fillError: string | null;
  /** 재개발 구역 확인 상태(브이월드 키, 마지막 결과, 확인 중, 오류) */
  zone: AppState['zoneCheck'] & { checking: boolean; error: string | null };
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
  /** 법원경매와 공매 공고만 조회 */
  run: [];
  /** 고른 구 바꾸기(통째로) */
  gus: [string[]];
  /** 단지 세대수 넣기(null이면 지움) */
  households: [key: string, name: string, households: number | null];
  /** 건축물대장에서 세대수 채우기 */
  fill: [];
  /** 재개발 구역 확인(브이월드) */
  zoneCheck: [];
  /** 지금 보이는 목록(화면 순서, 키보드 이동에 씀) */
  visible: [ListingView[]];
}>();

/** 브라우저 저장소를 못 쓰면(사생활 보호 창 등) 기억만 안 한다. */
const load = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 기억 못 해도 화면은 그대로 */
  }
};

// ---------- 필터 ----------
interface AptFilters {
  kind: AptKind | 'all';
  /** 빈 글자면 모든 구 */
  gu: string;
  /** 세대수 최소(0이면 없음)와 최대(null이면 없음) */
  minHouseholds: number;
  maxHouseholds: number | null;
  /** 세대수를 모르는 것도 보이기 */
  unknown: boolean;
  /** 최저가·매매가 상한(만원), null이면 제한 없음 */
  priceMax: number | null;
}
const FILTER_KEY = 'hnw-apt-filters';
function loadFilters(): AptFilters {
  const d: AptFilters = { kind: 'all', gu: '', minHouseholds: 250, maxHouseholds: null, unknown: true, priceMax: null };
  try {
    const o = JSON.parse(load(FILTER_KEY) ?? '{}') as Partial<AptFilters>;
    return {
      kind: o.kind === 'all' || APT_KINDS.some((k) => k.id === o.kind) ? (o.kind as AptFilters['kind']) : d.kind,
      gu: typeof o.gu === 'string' && (o.gu === '' || SEOUL_GUS.includes(o.gu)) ? o.gu : d.gu,
      minHouseholds: o.minHouseholds === 0 || HOUSEHOLD_STEPS.includes(o.minHouseholds as number) ? (o.minHouseholds as number) : d.minHouseholds,
      maxHouseholds: HOUSEHOLD_STEPS.includes(o.maxHouseholds as number) ? (o.maxHouseholds as number) : null,
      unknown: typeof o.unknown === 'boolean' ? o.unknown : d.unknown,
      priceMax: typeof o.priceMax === 'number' && o.priceMax > 0 ? o.priceMax : null,
    };
  } catch {
    return d;
  }
}
const f = reactive(loadFilters());
if (f.maxHouseholds != null && f.maxHouseholds < f.minHouseholds) f.maxHouseholds = null;
watch(f, (v) => store(FILTER_KEY, JSON.stringify(v)), { deep: true });
/** 가격 상한 칸(빈칸이나 0 이하는 제한 없음) */
const priceInput = computed({
  get: () => f.priceMax,
  set: (v: number | string | null) => {
    const n = typeof v === 'number' ? v : Number(v);
    f.priceMax = v === '' || v == null || !Number.isFinite(n) || n <= 0 ? null : Math.round(n);
  },
});

/** 세대수 최소·최대 중 하나라도 정했는지 */
const householdsSet = computed(() => f.minHouseholds > 0 || f.maxHouseholds != null);
const householdsOk = (l: ListingView) => {
  if (!householdsSet.value) return true;
  const n = l.apt?.households;
  return n == null ? f.unknown : n >= f.minHouseholds && (f.maxHouseholds == null || n <= f.maxHouseholds);
};
const priceOk = (l: ListingView) => {
  const p = aptPrice(l);
  return f.priceMax == null || p == null || p <= f.priceMax;
};
const inGu = (l: ListingView) => !f.gu || l.apt?.gu === f.gu;
/** 종류를 빼고 나머지 조건을 통과한 것(종류 칸 숫자에 씀) */
const base = computed(() => props.listings.filter((l) => inGu(l) && priceOk(l) && householdsOk(l)));
const ofKind = (l: ListingView) => f.kind === 'all' || aptKindOf(l) === f.kind;
const kindCounts = computed(() => {
  const out: Record<AptKind | 'all', number> = { all: base.value.length, court: 0, onbid: 0, sale: 0 };
  for (const l of base.value) {
    const k = aptKindOf(l);
    if (k) out[k]++;
  }
  return out;
});

const hasNews = (l: ListingView) => l.isNew || !!l.priceChange;
/** 경매·공매: 매각기일 순(경매 탭과 같음) */
const auctions = computed(() => sortAuctions(base.value.filter((l) => aptKindOf(l) !== 'sale' && ofKind(l))));
/** 매매: 새 소식 먼저, 그다음 매매가 낮은 순 */
const sales = computed(() =>
  base.value
    .filter((l) => aptKindOf(l) === 'sale' && ofKind(l))
    .sort((a, b) => Number(hasNews(b)) - Number(hasNews(a)) || (aptPrice(a) ?? Infinity) - (aptPrice(b) ?? Infinity)),
);
const shown = computed(() => [...auctions.value, ...sales.value]);
watch(shown, (list) => emit('visible', list), { immediate: true });

/** 세대수 조건 때문에 가린 수(종류, 구, 가격 조건은 통과한 것 중) */
const hiddenByHouseholds = computed(() => props.listings.filter((l) => inGu(l) && priceOk(l) && ofKind(l) && !householdsOk(l)).length);
const unknownShown = computed(() => shown.value.filter((l) => l.apt?.households == null).length);
const news = computed(() => shown.value.filter((l) => l.isNew).length);
const changed = computed(() => shown.value.filter((l) => !!l.priceChange).length);

/** 구 고르기 칸의 구: 매물이 있는 구는 그 수도 보인다 */
const guCounts = computed(() => {
  const m = new Map<string, number>();
  for (const l of props.listings) if (l.apt) m.set(l.apt.gu, (m.get(l.apt.gu) ?? 0) + 1);
  return m;
});
/** 구 필터에 고를 수 있는 구: 매물이 있는 구와 고른 구(서울 구 순서) */
const filterGus = computed(() => SEOUL_GUS.filter((gu) => guCounts.value.has(gu) || props.aptGus.includes(gu) || gu === f.gu));

/** 카드마다 토지거래허가·실거주 표시 */
const chips = computed(() => new Map(shown.value.map((l) => [l.id, liveChip(l)])));
const TONE: Record<'ok' | 'warn' | 'muted', string> = { ok: 'chip-down', warn: 'chip-up', muted: 'chip-muted' };

// ---------- 모을 구 ----------
const GUS_OPEN_KEY = 'hnw-apt-gus-open';
const gusChoice = ref<boolean | null>(load(GUS_OPEN_KEY) === 'true' ? true : load(GUS_OPEN_KEY) === 'false' ? false : null);
/** 고른 적 없으면 고른 구가 없을 때만 펼친다 */
const gusOpen = computed(() => gusChoice.value ?? props.aptGus.length === 0);
function onGusToggle(e: Event) {
  const now = (e.target as HTMLDetailsElement).open;
  if (now === gusOpen.value) return;
  gusChoice.value = now;
  store(GUS_OPEN_KEY, String(now));
}
const toggleGu = (gu: string) => emit('gus', props.aptGus.includes(gu) ? props.aptGus.filter((g) => g !== gu) : [...props.aptGus, gu]);
const gusText = computed(() => {
  const list = props.aptGus;
  if (!list.length) return '고른 구 없음';
  if (list.length === SEOUL_GUS.length) return '서울 전체';
  return list.length > 4 ? `${list.slice(0, 4).join(', ')} 외 ${list.length - 4}곳` : list.join(', ');
});

// ---------- 살 때 붙는 조건 ----------
const RULES_OPEN_KEY = 'hnw-apt-rules-open';
const rulesOpen = ref(load(RULES_OPEN_KEY) !== 'false');
function onRulesToggle(e: Event) {
  rulesOpen.value = (e.target as HTMLDetailsElement).open;
  store(RULES_OPEN_KEY, String(rulesOpen.value));
}
const dot = (date: string) => date.replace(/-/g, '.');

/** 세대수 채운 때, 구역 확인한 때('10월 18일 21:05') */
const fillDay = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
/** 보이는 아파트 중 재개발 쪽 구역 안(접함은 뺌)인 것 */
const zoneInside = computed(() => shown.value.filter((l) => l.zone?.check?.zones.some((z) => z.overlap !== '접함' && z.kind !== 'limit')).length);

/** 지도를 다시 맞추는 기준(필터가 바뀔 때만) */
const fitKey = computed(() => [f.kind, f.gu, f.minHouseholds, f.maxHouseholds, f.unknown, f.priceMax].join('|'));
/** 지도에 진하게 보일 펼친 목록(이 탭은 없음) */
const none: ListingView[] = [];
</script>

<template>
  <section class="apt">
    <div class="apt-heading">
      <h2 class="apt-title">
        서울 아파트
        <CountTooltip class="current-count" :text="`신규 ${news}건\n가격 변동 ${changed}건\n세대수 모름 ${unknownShown}건`"><b class="num">{{ shown.length }}</b>건</CountTooltip>
      </h2>
      <div class="apt-actions">
        <button class="btn run" :disabled="running" title="법원경매와 온비드, 신탁 공매 공고만 조회합니다(고른 구의 아파트 포함)" @click="emit('run')">
          {{ running ? '조회 중…' : '경매 조회하기' }}
        </button>
      </div>
    </div>

    <div class="panels">
      <details class="fold gus" :open="gusOpen" @toggle="onGusToggle">
        <summary title="법원경매와 온비드가 회사와 멀어도 아파트를 모으는 구">
          <span class="fold-name">모을 구</span>
          <span class="muted fold-count">{{ gusText }}</span>
        </summary>
        <div class="fold-body">
          <p class="hint">
            고른 구는 '경매 조회하기'와 '조회하기'에서 법원경매와 온비드의 아파트를 회사와 멀어도 모읍니다. 구마다 법원경매 검색이 두 번 늘어 조회가 길어집니다.
            매매는 네이버 부동산에서 그 구 단지 매물을 보면 크롬 확장이 모읍니다.
          </p>
          <div class="gu-grid" role="group" aria-label="모을 구">
            <button
              v-for="gu in SEOUL_GUS" :key="gu" type="button" class="gu" :class="{ on: aptGus.includes(gu) }" :aria-pressed="aptGus.includes(gu)"
              :title="nearGus.includes(gu) ? '켜진 지역 근처라 원래 모으는 구입니다. 고르면 반경 밖 아파트도 모읍니다.' : undefined"
              @click="toggleGu(gu)"
            >
              {{ gu }}<span v-if="nearGus.includes(gu)" class="near">근처</span><span v-if="guCounts.get(gu)" class="gu-count num">{{ guCounts.get(gu) }}</span>
            </button>
          </div>
          <div class="gu-actions">
            <button type="button" class="btn btn-sm" :disabled="aptGus.length === SEOUL_GUS.length" @click="emit('gus', [...SEOUL_GUS])">서울 전체</button>
            <button type="button" class="btn btn-sm" :disabled="!aptGus.length" @click="emit('gus', [])">모두 빼기</button>
          </div>
        </div>
      </details>

      <details class="fold rules" :open="rulesOpen" @toggle="onRulesToggle">
        <summary title="토지거래허가, 대출 전입, 양도세 비과세 조건(조사한 날 기준)">
          <span class="fold-name">살 때 붙는 조건</span>
          <span class="muted fold-count">실거주, 대출, 양도세 · {{ dot(APT_CHECKED) }} 조사</span>
        </summary>
        <div class="fold-body">
          <p class="summary-line">{{ APT_SUMMARY }}</p>
          <div class="rule-list">
            <article v-for="r in APT_RULES" :key="r.id" class="rule">
              <div class="rule-head">
                <strong>{{ r.name }}</strong>
                <span class="live">{{ r.live }}</span>
                <span class="chip" :class="r.status === 'ok' ? 'chip-down' : r.status === 'news' ? 'chip-seen' : 'chip-warn'">{{ APT_STATUS_TEXT[r.status] }}</span>
              </div>
              <p>{{ r.text }}</p>
              <ul v-if="r.notes.length" class="notes">
                <li v-for="n in r.notes" :key="n">{{ n }}</li>
              </ul>
              <div class="sources">
                <span class="src-label">근거</span>
                <a v-for="s in r.sources" :key="s.url + s.title" :href="s.url" target="_blank" rel="noopener">{{ s.title }}<span v-if="s.date" class="src-date">{{ dot(s.date) }}</span> ↗</a>
              </div>
            </article>
          </div>
          <p class="muted fine">조사한 날 기준이고 법이나 대책이 바뀌면 달라집니다. 계약이나 입찰 전에는 구청, 은행, 세무서에 확인하세요.</p>
        </div>
      </details>
    </div>

    <div class="split">
      <div class="col">
        <div class="filters" role="group" aria-label="서울 아파트 필터">
          <fieldset class="kinds">
            <legend class="sr-only">종류</legend>
            <label class="kind-option" title="경매, 공매, 매매 모두">
              <input v-model="f.kind" type="radio" name="apt-kind" value="all" /><span>전체</span><span class="kind-count num">{{ kindCounts.all }}</span>
            </label>
            <label v-for="k in APT_KINDS" :key="k.id" class="kind-option" :title="k.title">
              <input v-model="f.kind" type="radio" name="apt-kind" :value="k.id" /><span>{{ k.name }}</span><span class="kind-count num">{{ kindCounts[k.id] }}</span>
            </label>
          </fieldset>
          <label class="pick">
            <span>구</span>
            <select v-model="f.gu">
              <option value="">모든 구</option>
              <option v-for="gu in filterGus" :key="gu" :value="gu">{{ gu }}{{ guCounts.get(gu) ? ` ${guCounts.get(gu)}` : '' }}</option>
            </select>
          </label>
          <span class="pick" role="group" aria-label="세대수 최소와 최대">
            <span>세대수</span>
            <select v-model="f.minHouseholds" aria-label="최소 세대수">
              <option :value="0">최소 없음</option>
              <option v-for="n in HOUSEHOLD_STEPS" :key="n" :value="n" :disabled="f.maxHouseholds != null && n > f.maxHouseholds">{{ n.toLocaleString('ko-KR') }}세대</option>
            </select>
            <span aria-hidden="true">~</span>
            <select v-model="f.maxHouseholds" aria-label="최대 세대수">
              <option :value="null">최대 없음</option>
              <option v-for="n in HOUSEHOLD_STEPS" :key="n" :value="n" :disabled="n < f.minHouseholds">{{ n.toLocaleString('ko-KR') }}세대</option>
            </select>
          </span>
          <label v-if="householdsSet" class="check unknown">
            <input v-model="f.unknown" type="checkbox" /> 세대수 모르는 것도
          </label>
          <label class="pick price" title="경매·공매는 최저가, 매매는 매매가. 빈칸이면 제한 없음">
            <span>가격</span>
            <input v-model.number="priceInput" type="number" min="0" step="1000" inputmode="numeric" placeholder="만원" />
            <span class="muted">{{ f.priceMax ? `${manwon(f.priceMax)} 이하` : '이하' }}</span>
          </label>
        </div>
        <p class="hh-note muted">
          {{ HOUSEHOLD_NOTE }}
          <a v-for="s in HOUSEHOLD_SOURCES" :key="s.url" :href="s.url" target="_blank" rel="noopener" class="hh-src" :title="s.title">{{ s.short }} ↗</a>
          <span v-if="hiddenByHouseholds" class="hidden-count">세대수 조건으로 가린 {{ hiddenByHouseholds }}건</span>
        </p>
        <div class="fill-row">
          <button
            type="button" class="btn btn-sm" :disabled="!fill.key || filling"
            :title="fill.key
              ? '경매·공매 아파트 중 세대수를 모르는 단지를 건축물대장(공공데이터포털)에서 찾아 채웁니다. 법원경매나 온비드를 조회할 때도 알아서 채웁니다.'
              : '공공데이터포털 인증키가 있어야 합니다. config/local.json에 dataGoKrKey를 넣어 주세요(README의 서울 아파트 탭).'"
            @click="emit('fill')"
          >{{ filling ? '채우는 중…' : '건축물대장에서 세대수 채우기' }}</button>
          <span v-if="fillError" class="fill-msg err" role="alert">{{ fillError }}</span>
          <span v-else-if="!fill.key" class="fill-msg muted">공공데이터포털 키가 없어 못 채웁니다(README 참고)</span>
          <span v-else-if="fill.last" class="fill-msg" :class="fill.last.ok ? 'muted' : 'err'">{{ fillDay(fill.last.at) }} {{ fill.last.text }}</span>
        </div>
        <div class="fill-row">
          <button
            type="button" class="btn btn-sm" :disabled="!zone.key || zone.checking || running"
            :title="zone.key
              ? '경매·공매 아파트는 주소의 지번으로, 네이버 매매는 단지 좌표로 필지를 찾아 브이월드 토지이용계획에 정비구역, 재개발·재정비촉진, 모아타운이 걸렸는지 봅니다. 경매 조회 때도 알아서 봅니다.'
              : '브이월드 인증키가 있어야 합니다. config/local.json에 vworldKey를 넣어 주세요(README의 집터 탭).'"
            @click="emit('zoneCheck')"
          >{{ zone.checking ? '확인 중…' : '재개발 구역 확인' }}</button>
          <span v-if="zoneInside" class="chip chip-new" title="보이는 아파트 중 토지이용계획에 정비구역, 재개발·재정비촉진, 모아타운이 걸린 것">구역 안 {{ zoneInside }}건</span>
          <span v-if="zone.error" class="fill-msg err" role="alert">{{ zone.error }}</span>
          <span v-else-if="!zone.key" class="fill-msg muted">브이월드 키가 없어 재개발·재건축 구역을 못 봅니다(README 참고)</span>
          <span v-else-if="zone.last" class="fill-msg" :class="zone.last.ok ? 'muted' : 'err'">{{ fillDay(zone.last.at) }} {{ zone.last.text }}</span>
        </div>

        <section v-if="auctions.length" class="group">
          <h3 class="group-head">
            <span>경매·공매</span><span class="muted num group-count">{{ auctions.length }}건</span>
            <span class="muted group-sub">매각기일(공매는 개찰일) 가까운 순</span>
          </h3>
          <div class="list">
            <ListingCard
              v-for="l in auctions" :key="l.id" :listing="l" :areas="areas" :selected="l.id === selectedId"
              :expect="expectedPrices(l, regionStats)"
              @select="emit('select', l)" @open="emit('open', l)" @verdict="(v) => emit('verdict', l, v)" @source="emit('source', l)" @raw="emit('raw', l)"
            >
              <template v-if="l.zone" #banner><ZoneBanner part="banner" :listing="l" :key-set="zone.key" /></template>
              <template #tags>
                <HouseholdsChip :listing="l" @save="(k, n, h) => emit('households', k, n, h)" />
                <span v-if="chips.get(l.id)" class="chip" :class="TONE[chips.get(l.id)!.tone]" :title="chips.get(l.id)!.title">{{ chips.get(l.id)!.text }}</span>
              </template>
            </ListingCard>
          </div>
        </section>
        <section v-if="sales.length" class="group">
          <h3 class="group-head">
            <span>매매</span><span class="muted num group-count">{{ sales.length }}건</span>
            <span class="muted group-sub">새 소식 먼저, 그다음 매매가 낮은 순</span>
          </h3>
          <div class="list">
            <ListingCard
              v-for="l in sales" :key="l.id" :listing="l" :areas="areas" :selected="l.id === selectedId"
              @select="emit('select', l)" @open="emit('open', l)" @verdict="(v) => emit('verdict', l, v)" @source="emit('source', l)" @raw="emit('raw', l)"
            >
              <template v-if="l.zone" #banner><ZoneBanner part="banner" :listing="l" :key-set="zone.key" /></template>
              <template #tags>
                <HouseholdsChip :listing="l" @save="(k, n, h) => emit('households', k, n, h)" />
                <span v-if="chips.get(l.id)" class="chip" :class="TONE[chips.get(l.id)!.tone]" :title="chips.get(l.id)!.title">{{ chips.get(l.id)!.text }}</span>
              </template>
            </ListingCard>
          </div>
        </section>
        <p v-if="!shown.length" class="empty muted">
          <template v-if="!listings.length && !aptGus.length">위 '모을 구'에서 구를 고르고 '경매 조회하기'를 누르면 그 구의 아파트 경매와 공매가 여기 모입니다.</template>
          <template v-else-if="!listings.length">아직 모은 아파트가 없습니다. '경매 조회하기'를 누르면 고른 구의 아파트 경매와 공매를 모읍니다.</template>
          <template v-else>조건에 맞는 아파트가 없습니다.{{ hiddenByHouseholds ? ` 세대수 조건으로 가린 ${hiddenByHouseholds}건이 있습니다.` : '' }}</template>
        </p>
      </div>
      <aside class="map">
        <OverviewMap
          :listings="none" :background="shown" :areas="areas" :selected-id="selectedId" :fit-key="fitKey"
          @select="(l) => emit('select', l)" @reveal="(ls) => emit('select', ls[0])" @open="(l) => emit('open', l)" @pick="(p) => emit('pick', p)"
          @area="(a) => emit('area', a)" @station="(s) => emit('station', s)"
        />
      </aside>
    </div>
  </section>
</template>

<style scoped>
.apt { display: grid; gap: 14px; }
.apt-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 24px; min-width: 0; }
.apt-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin: 0; font-size: 21px; font-weight: 700; }
.current-count { font-size: 14px; font-weight: 500; color: var(--muted); cursor: help; }
.current-count b { color: var(--ink-2); }
.apt-actions { display: flex; align-items: center; gap: 14px; margin-left: auto; }
.apt-actions .run { min-height: 34px; padding: 0 12px; font-size: 13px; }

/* 모을 구와 살 때 붙는 조건: 닫히면 한 줄, 펼치면 칸 전체 */
.panels { display: grid; gap: 8px; }
.panels .fold > summary { padding: 10px 14px; }
.panels .fold-name { font-size: 14px; }
.panels .fold-count { font-size: 13px; font-weight: 500; }
.hint { margin: 0 0 10px; font-size: 13px; line-height: 1.6; color: var(--ink-2); }
.gu-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 6px; }
.gu {
  display: inline-flex; align-items: center; gap: 5px; min-height: 36px; padding: 0 10px;
  border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); font-size: 13px; font-weight: 600; color: var(--ink-2);
}
.gu:hover { border-color: var(--ink-2); }
.gu.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.near { font-size: 11px; font-weight: 700; color: var(--accent); }
.gu.on .near { color: #cfdef1; }
.gu-count { margin-left: auto; font-size: 12px; font-weight: 500; color: var(--muted); }
.gu.on .gu-count { color: #cfdef1; }
.gu-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.gu-actions .btn { min-height: 32px; font-size: 13px; }

.summary-line { margin: 0 0 12px; font-size: 14px; font-weight: 700; line-height: 1.6; }
.rule-list { display: grid; gap: 12px; }
.rule { display: grid; gap: 4px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.rule:last-child { padding-bottom: 0; border-bottom: 0; }
.rule-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.rule-head strong { font-size: 14px; }
.live { font-size: 13px; font-weight: 700; color: var(--accent); }
.rule-head .chip { font-size: 11px; padding: 1px 7px; }
.rule p { margin: 0; font-size: 13px; line-height: 1.65; color: var(--ink-2); }
.notes { margin: 2px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.6; color: var(--muted); }
.sources { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin-top: 2px; font-size: 12px; }
.src-label { color: var(--muted); }
.sources a { color: var(--accent); text-decoration: none; }
.sources a:hover { text-decoration: underline; text-underline-offset: 3px; }
.src-date { margin-left: 5px; color: var(--muted); }
.fine { margin: 12px 0 0; font-size: 12px; }

/* 목록(왼쪽)과 지도(오른쪽, 따라 내려옴). 좁으면 지도가 위로 간다. 경매 탭과 같은 배치. */
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 45%); gap: 16px; align-items: start; }
.col { display: grid; gap: 14px; min-width: 0; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.kinds { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; border: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.kind-option { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; cursor: pointer; color: var(--ink-2); font-size: 14px; }
.kind-option input { width: 15px; height: 15px; margin: 0 2px 0 0; accent-color: var(--accent); }
.kind-option:has(input:checked) > span:first-of-type { font-weight: 700; color: var(--ink); }
.kind-count { color: var(--muted); font-size: 12px; }
.pick { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
.pick select, .pick input {
  min-height: 34px; padding: 0 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink-2); font-size: 13px;
}
.pick select { padding-right: 26px; }
.pick input { width: 110px; }
.unknown { min-height: 34px; font-size: 13px; color: var(--ink-2); }
.unknown input { width: 15px; height: 15px; }
.hh-note { margin: -4px 0 0; font-size: 12px; line-height: 1.6; }
.hh-src { margin-left: 8px; color: var(--accent); text-decoration: none; white-space: nowrap; }
.hh-src:hover { text-decoration: underline; text-underline-offset: 3px; }
.hidden-count { margin-left: 8px; font-weight: 700; color: var(--ink-2); }
.fill-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: -6px; }
.fill-row .btn { min-height: 32px; font-size: 13px; }
.fill-msg { font-size: 12px; }
.fill-msg.err { font-weight: 700; color: var(--new); }
.group { display: grid; gap: 8px; }
.group-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 0; font-size: 17px; font-weight: 800; }
.group-count { font-size: 14px; font-weight: 600; }
.group-sub { font-size: 12px; font-weight: 500; }
.list { display: grid; gap: 8px; container-type: inline-size; }
.empty { padding: 32px 0; text-align: center; }
.map { position: sticky; top: calc(var(--app-header-height, 76px) + 16px); height: calc(100dvh - var(--app-header-height, 76px) - 32px); min-height: 420px; }
.map:has(.ovmap.big) { z-index: 70; }
@media (max-width: 1280px) {
  .split { grid-template-columns: 1fr; }
  .col { display: contents; }
  .map { position: static; order: 1; height: auto; min-height: 0; }
  .filters { order: 0; }
  .hh-note { order: 0; margin: 0; }
  .fill-row { order: 0; margin: 0; }
  .group, .empty { order: 2; }
}
@media (max-width: 600px) {
  .apt-actions { margin-left: 0; }
  .gu-grid { grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); }
  .pick input { width: 96px; }
}
</style>
