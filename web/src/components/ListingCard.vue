<script setup lang="ts">
import { computed } from 'vue';
import { DEAL_LABEL, SOURCE_LABEL, type Area, type ListingView, type PriceOption, type Verdict } from '../../../shared/types';
import { ago, dateTime, distanceText, manwon, money, nearest, perPyeong, priceAmount, priceText, pyeong, pyeongExact } from '../format';
import { auctionSiteLinks, isAuction, saleDateOf, saleDay, type ExpectedPrice } from '../auction';
import { isNoOption } from '../filters';
import { KIND_LABEL, kindOf } from '../kinds';
import { isRoomStay, roomRange as rangeOf, roomTypesText } from '../rooms';
import { naverCenter } from '../siteLinks';

const props = defineProps<{
  listing: ListingView;
  areas: Area[];
  selected: boolean;
  /** 매각기일별로 묶어 보이는 곳(경매 탭)에서는 카드에 매각기일을 쓰지 않는다. */
  hideSaleDate?: boolean;
  /** 경매 탭: 감정가 × 지역 매각가율로 낸 예상 낙찰가(동이나 구 평균, 서울 평균) */
  expect?: ExpectedPrice[];
}>();
const emit = defineEmits<{ open: []; verdict: [Verdict | null]; source: []; raw: []; select: [] }>();

const l = computed(() => props.listing);
const near = computed(() => nearest(props.listing, props.areas));
const kind = computed(() => kindOf(props.listing));
/** 경매(법원경매, 온비드)는 사진을 받지 않아 사진 칸을 두지 않는다. */
const noThumb = computed(() => isAuction(l.value));
/** 고시원과 쉐어: 면적, 관리비, 층을 주지 않는 곳이라 그 칸을 두지 않고, 유형은 종류 칩 하나로 보인다. */
const room = computed(() => isRoomStay(props.listing));
/** 고시원과 쉐어의 가격 둘(가장 싼 방, 비싼 방)을 한 줄로 이은 것 */
const roomRange = computed(() => rangeOf(props.listing));
/** 매물 위치를 가운데로 여는 네이버 부동산 지도(그 자리 단지와 실거래가 확인용). */
const naverMapUrl = computed(() =>
  l.value.lat != null && l.value.lng != null ? `https://fin.land.naver.com/map?center=${naverCenter(l.value.lat, l.value.lng)}&zoom=16` : null,
);
/** 경매 물건을 다른 경매 사이트에서 여는 주소 */
const siteLinks = computed(() => auctionSiteLinks(props.listing));

const changeText = computed(() => {
  const c = l.value.priceChange;
  if (!c) return null;
  const label = c.type === 'price_down' ? '가격 인하' : c.type === 'price_up' ? '가격 인상' : '가격 변동';
  const before = c.before.map(priceText).join(', ');
  const after = c.after.map(priceText).join(', ');
  return { label, detail: `${before} → ${after}`, tone: c.type === 'price_down' ? 'chip-down' : c.type === 'price_up' ? 'chip-up' : 'chip-muted' };
});

/** 가격 칸의 작은 거래 이름. 경매 금액은 최저가다. */
const dealName = (p: PriceOption) => (p.deal === 'auction' ? '최저가' : DEAL_LABEL[p.deal]);

/** 경매 최저가가 감정가의 몇 %인지. */
const appraisal = computed(() => {
  const a = l.value.auction;
  const price = l.value.prices[0]?.price;
  if (!a?.appraisal || !price) return null;
  return { rate: Math.round((price / a.appraisal) * 100), title: `감정가 ${money(a.appraisal)}` };
});

/** 첫 가격이 월세나 단기면 셋째 칸에 관리비, 아니면 전용 평당 가격을 둔다. */
const monthlyFirst = computed(() => {
  const deal = l.value.prices[0]?.deal;
  return deal === 'monthly' || deal === 'short';
});
const third = computed(() => {
  const x = l.value;
  if (monthlyFirst.value) return { value: x.maintenance == null ? '?' : manwon(x.maintenance), label: '관리비', title: undefined };
  const v = perPyeong(x);
  const p = x.prices[0];
  return {
    value: v == null ? '?' : manwon(v),
    label: '평당',
    title: v == null || x.areaM2 == null ? undefined : `${dealName(p)} ${priceAmount(p)} ÷ 전용 ${pyeongExact(x.areaM2)}평`,
  };
});

const floor = computed(() => {
  const x = l.value;
  return {
    value: x.basement ? '반지하' : x.rooftop ? '옥탑' : x.floor != null ? `${x.floor}층` : '?',
    sub: x.totalFloors ? `총 ${x.totalFloors}층` : '',
  };
});

/** 제목 칸. 경매는 사건번호(물건번호). 집토스 제목은 방 구조, 동, 건물 용도를 이은 것이라 칩과 주소에 겹쳐서 쓰지 않는다. */
const titleText = computed(() => {
  const x = l.value;
  if (x.auction) return `${x.auction.caseNo}${x.auction.itemNo !== '1' ? `(${x.auction.itemNo})` : ''}`;
  if (x.source === 'ziptoss') return null;
  return x.title || null;
});

/** 방 구조 칩(원룸, 투룸 등. 고시원과 쉐어는 '고시원과 원룸텔' 같은 종류). 경매는 방 구조를 주지 않는다. */
const roomChip = computed(() => (room.value ? roomTypesText(l.value) : isAuction(l.value) ? null : l.value.roomLabel));

/** 사이트가 준 건물 유형이 유형 칩이나 방 구조 칩과 다를 때만 보인다(예: 제2종근린생활시설(고시원)). */
const rawType = computed(() => {
  const t = l.value.buildingType?.trim();
  const plain = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');
  return t && plain(t) !== plain(KIND_LABEL[kind.value]) && plain(t) !== plain(roomChip.value ?? '') ? t : null;
});

/** 주소 뒤에 붙는 나머지 정보. */
const extras = computed(() => {
  const x = l.value;
  const out: string[] = [];
  if (rawType.value) out.push(rawType.value);
  if (!monthlyFirst.value && x.maintenance != null) out.push(`관리비 ${manwon(x.maintenance)}`);
  if (x.elevator != null) out.push(x.elevator ? '엘리베이터 있음' : '엘리베이터 없음');
  if (x.builtYear) out.push(`${x.builtYear}년 준공`);
  if (x.availableFrom) out.push(`입주 ${x.availableFrom}`);
  // 옵션: 사이트가 준 목록이 있으면 앞의 넷, 없으면 풀옵션 표시
  const list = x.options?.list ?? [];
  if (list.length) out.push(`옵션 ${list.slice(0, 4).join(', ')}${list.length > 4 ? ` 외 ${list.length - 4}` : ''}`);
  else if (x.options?.full) out.push('풀옵션');
  const sale = saleDateOf(x);
  if (sale && !props.hideSaleDate) out.push(`매각기일 ${saleDay(sale).day}`);
  out.push(`처음 본 날 ${ago(x.firstSeenAt)}`);
  return out;
});

/** 네이버 매물은 크롬 확장으로 목록을 볼 때 들어오므로, 마지막으로 목록에 뜬 시각을 '봤음'으로 보여 준다. */
const seenNaver = computed(() => (l.value.source === 'naver' ? l.value.lastSeenAt : null));
</script>

<template>
  <article
    class="card" :class="{ selected, discarded: l.verdict === 'discard', gone: l.status === 'gone', 'no-thumb': noThumb }"
    @click="emit('select')"
  >
    <div v-if="!noThumb" class="thumb" :style="l.thumbnail ? { backgroundImage: `url(${JSON.stringify(l.thumbnail)})` } : undefined">
      <span v-if="!l.thumbnail" class="muted">사진 없음</span>
    </div>

    <div class="body">
      <div class="stats num">
        <div class="stat price" :title="roomRange ? '이 곳 방 중 가장 싼 방 ~ 가장 비싼 방(보증금/월세)' : undefined">
          <b v-if="roomRange"><span class="deal">월세</span>{{ roomRange }}</b>
          <template v-else>
            <b v-for="(p, i) in l.prices" :key="i"><span class="deal">{{ dealName(p) }}</span>{{ priceAmount(p) }}</b>
            <b v-if="!l.prices.length" class="muted">가격 모름</b>
          </template>
          <small v-if="appraisal" :title="appraisal.title">감정가의 {{ appraisal.rate }}%</small>
        </div>
        <template v-if="!room">
          <div class="stat">
            <b>{{ l.areaM2 != null ? `${pyeong(l.areaM2)}평` : '?' }}</b>
            <small>{{ l.areaM2 != null ? `${kind === 'land' ? '토지' : '전용'} ${l.areaM2}㎡` : '면적 모름' }}</small>
          </div>
          <div class="stat" :title="third.title">
            <b>{{ third.value }}</b>
            <small>{{ third.label }}</small>
          </div>
          <div class="stat floor">
            <b>{{ kind === 'land' ? '' : floor.value }}</b>
            <small>{{ kind === 'land' ? '' : floor.sub }}</small>
          </div>
        </template>
        <div class="stat dist">
          <b>{{ near ? distanceText(near.distance) : '?' }}</b>
          <small :title="near?.area.name">{{ near ? near.area.name : '위치 모름' }}</small>
        </div>
        <div v-if="expect?.length" class="expect">
          <div v-for="(e, i) in expect" :key="e.label" class="stat" :class="{ first: i === 0 }" :title="e.title">
            <b><span v-if="i === 0" class="deal">예상가</span>{{ manwon(e.price) }}</b>
            <small>{{ e.label }} {{ Math.round(e.rate) }}%{{ e.belowMin ? ', 최저가 아래' : '' }}</small>
          </div>
        </div>
      </div>

      <div class="tags">
        <span v-if="l.isNew" class="chip chip-new">신규</span>
        <template v-if="changeText">
          <span class="chip" :class="changeText.tone">{{ changeText.label }}</span>
          <span class="change num">{{ changeText.detail }}</span>
        </template>
        <span v-if="l.verdict === 'star'" class="chip chip-star">★ 관심</span>
        <span v-if="l.relistedOf" class="chip chip-muted" :title="`원래 매물: ${l.relistedOf}`">재등록이라 숨김</span>
        <span v-else-if="l.verdict === 'discard'" class="chip chip-muted">버림</span>
        <span v-if="l.similarToDiscarded" class="chip chip-warn">버림한 매물과 비슷</span>
        <span v-if="l.status === 'gone'" class="chip chip-muted">최근 조회에서 안 보임</span>
        <span
          v-if="seenNaver" class="chip chip-seen"
          :title="`네이버 지도에서 이 매물이 든 동그라미를 눌러 목록을 본 마지막 시각: ${dateTime(seenNaver)} (크롬 확장이 기록)`"
        >{{ ago(seenNaver) }} 봤음</span>
        <span v-if="!room" class="chip chip-kind" :class="kind" :title="l.buildingType ?? undefined">{{ KIND_LABEL[kind] }}</span>
        <span v-if="roomChip" class="chip chip-room">{{ roomChip }}</span>
        <span v-if="isNoOption(l)" class="chip chip-seen" title="사이트가 준 옵션 목록이 비어 있거나 글에 '무옵션'이라고 적힌 집">무옵션</span>
        <span v-if="l.auction?.failed != null" class="chip chip-room">유찰 {{ l.auction.failed }}회</span>
        <span v-if="l.auction && l.auction.lots > 1" class="chip chip-room" title="같은 사건과 물건번호의 목록(토지, 호실)을 한 번에 매각">{{ l.auction.lots }}개 일괄매각</span>
        <span v-if="l.auction?.share" class="chip chip-warn" title="지분 매각: 땅 전체가 아니라 일부 지분만 판다. 면적은 지분만큼">지분</span>
        <span v-if="l.auction?.mgmt" class="chip chip-warn" :title="`물건 비고: ${l.auction.mgmt.text}`">{{ l.auction.mgmt.label }}</span>
        <span v-if="titleText" class="title" :title="l.title || undefined">{{ titleText }}</span>
        <span class="source muted">{{ SOURCE_LABEL[l.source] }}</span>
      </div>

      <div class="meta muted">
        <span class="addr">{{ l.address ?? '주소 모름' }}</span>
        <span v-for="x in extras" :key="x">{{ x }}</span>
      </div>

      <div class="more" @click.stop>
        <a
          v-for="s in siteLinks" :key="s.name" class="btn btn-sm site-link" :href="s.url" target="_blank" rel="noopener"
          :title="`${s.name}에서 이 물건 보기`"
        >{{ s.name }} ↗</a>
        <button v-if="l.seenRef?.screenshot" class="btn btn-ghost btn-sm" title="이 매물을 어디서 어떻게 모았는지" @click="emit('source')">출처 보기</button>
        <button class="btn btn-ghost btn-sm" title="사이트가 준 원래 값과 저장한 값 비교" @click="emit('raw')">원본 데이터</button>
        <a v-if="naverMapUrl" class="btn btn-ghost btn-sm" :href="naverMapUrl" target="_blank" rel="noopener" title="매물 위치를 네이버 부동산 지도로 엽니다(그 자리 단지와 실거래가 확인)">네이버 지도 ↗</a>
      </div>
    </div>

    <div class="actions" @click.stop>
      <button class="btn btn-primary btn-sm" title="원본 사이트에서 보기 (Enter)" @click="emit('open')">원본 열기</button>
      <button class="btn btn-sm" :class="{ on: l.verdict === 'star' }" title="관심 (S)" @click="emit('verdict', l.verdict === 'star' ? null : 'star')">
        {{ l.verdict === 'star' ? '관심 해제' : '★ 관심' }}
      </button>
      <button class="btn btn-sm" title="버림 (X)" @click="emit('verdict', l.verdict === 'discard' ? null : 'discard')">
        {{ l.verdict === 'discard' ? '되돌리기' : '✕ 버림' }}
      </button>
    </div>
  </article>
</template>

<style scoped>
/* 넓으면 버튼을 한 줄로 두고 그 아래 작은 버튼들, 좁으면(지도 옆 목록) 버튼을 세로로 쌓고 작은 버튼들은 왼쪽 맨 아래로. */
.card {
  display: grid; gap: 6px 16px; align-items: start;
  grid-template-columns: 112px minmax(0, 1fr) auto;
  grid-template-areas:
    'thumb stats actions'
    'thumb tags  actions'
    'thumb meta  more';
  padding: 12px 14px; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.card.no-thumb {
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'stats actions'
    'tags  actions'
    'meta  more';
}
.card:hover { border-color: var(--line-strong); }
.card.selected { border-color: var(--ink); box-shadow: 0 0 0 2px var(--ink) inset; }
.card.discarded, .card.gone { opacity: .72; }
.thumb {
  grid-area: thumb;
  width: 112px; height: 84px; border-radius: 8px; background: var(--surface-2) center/cover no-repeat;
  display: grid; place-items: center; font-size: 12px;
}
.body { display: contents; }
.stats { grid-area: stats; }
.tags { grid-area: tags; }
.meta { grid-area: meta; }
.more { grid-area: more; }
/* 작은 버튼 줄(다른 사이트, 출처, 원본 데이터, 지도)은 마우스를 올리거나 고른 카드에서만 보인다. 자리는 그대로 둔다. */
.card:not(:hover):not(:focus-within):not(.selected) .more { visibility: hidden; }
.actions { grid-area: actions; }

/* 숫자 줄: 칸 너비를 정해 두어 카드끼리 같은 자리에 같은 값이 온다(값이 길면 그 칸만 늘어남). */
.stats { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px 16px; }
.stat { display: grid; grid-template-columns: minmax(0, 1fr); flex: none; min-width: 72px; line-height: 1.3; }
.stat b { font-size: 18px; font-weight: 800; letter-spacing: -0.01em; white-space: nowrap; }
.stat small { min-height: 1.3em; max-width: 100%; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat.price { min-width: 160px; }
.stat.price b { font-size: 20px; }
.deal { margin-right: 5px; font-size: 13px; font-weight: 700; color: var(--muted); }
.stat.floor { min-width: 52px; }
.stat.dist { width: 80px; }
.stat.floor b, .stat.dist b { font-weight: 700; color: var(--ink-2); }
/* 경매 탭 예상 낙찰가: 숫자 줄 아래 같은 모양(큰 숫자, 아래 작은 설명)의 둘째 줄. 첫 칸은 가격 칸과 같은 너비라 설명이 길면 칸 안에서 줄을 바꾼다. */
.expect { flex: 1 0 100%; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px 16px; }
.expect .stat.first { width: 160px; }
.expect .stat b { font-size: 17px; color: var(--ink-2); }
.expect .stat small { white-space: normal; overflow: visible; }

.tags { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.chip-room { background: var(--surface-2); color: var(--ink-2); }
.change { font-size: 13px; color: var(--ink-2); }
.title { flex: 1 1 0; min-width: 6em; margin-left: 4px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.source { margin-left: auto; font-size: 13px; font-weight: 600; }
.meta { display: flex; flex-wrap: wrap; gap: 0 14px; font-size: 13px; }

.more { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px; }
.more .btn { min-height: 30px; padding: 0 8px; font-size: 13px; color: var(--muted); font-weight: 600; }
.more .site-link { margin-right: 4px; padding: 0 10px; color: var(--accent); font-weight: 700; }
.actions { display: flex; justify-content: flex-end; gap: 6px; }
.actions .on { background: var(--star-soft); border-color: var(--star); }
/* 목록 칸 너비에 맞춘다(한눈에와 경매 탭은 지도 옆이라 좁다). */
@container (max-width: 1060px) {
  .card {
    grid-template-columns: 112px minmax(0, 1fr) 104px;
    grid-template-areas:
      'thumb stats actions'
      'thumb tags  actions'
      'thumb meta  actions'
      'thumb more  actions';
  }
  .card.no-thumb {
    grid-template-columns: minmax(0, 1fr) 104px;
    grid-template-areas:
      'stats actions'
      'tags  actions'
      'meta  actions'
      'more  actions';
  }
  .actions { display: grid; }
  .more { justify-content: flex-start; margin-left: -8px; }
}
/* 더 좁으면 사진은 숫자 줄 옆에만 두고, 주소와 버튼은 카드 너비를 다 쓴다. 숫자 칸도 조금 좁힌다. */
@container (max-width: 780px) {
  .card {
    grid-template-columns: 88px minmax(0, 1fr);
    grid-template-areas: 'thumb stats' 'thumb tags' 'meta meta' 'actions actions' 'more more';
  }
  .card.no-thumb { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'stats' 'tags' 'meta' 'actions' 'more'; }
  .thumb { width: 88px; height: 66px; }
  .stats { column-gap: 14px; }
  .stat { min-width: 64px; }
  .stat.price { min-width: 136px; }
  .stat.floor { min-width: 44px; }
  .stat.dist { width: 72px; }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-start; }
}
@container (max-width: 480px) {
  .card { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'thumb' 'stats' 'tags' 'meta' 'actions' 'more'; }
  .thumb { width: 100%; height: 160px; }
}
</style>
