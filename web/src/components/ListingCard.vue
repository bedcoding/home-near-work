<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { hasRegions, regionRelation, selectedArea } from '../../../shared/regions';
import { DEAL_LABEL, SOURCE_LABEL, type Area, type ListingView, type PriceOption, type TradeRef, type Verdict } from '../../../shared/types';
import { ago, dateTime, distanceText, manwon, money, nearest, perPyeong, priceAmount, priceText, pyeong, pyeongExact } from '../format';
import { auctionSiteLinks, claimsChip, isAuction, saleDateOf, saleDay, type ExpectedPrice } from '../auction';
import { isNoOption } from '../filters';
import { KIND_LABEL, kindOf } from '../kinds';
import { isRoomStay, roomRange as rangeOf, roomTypesText } from '../rooms';
import { naverCenter } from '../siteLinks';
import { redevChip } from '../zones';
import { loanView } from '../loans';
import { cannotGet, profile } from '../profile';
import { walkTimes } from '../walk';
import { WALK_KMH } from '../../../shared/walk';
import { convertedRent, loanMonthly } from '../rentRate';
import { ledgerChips } from '../ledger';
import CountTooltip from './CountTooltip.vue';
import { dabangAddressBusy, dabangAddressErrors, dabangAddresses, loadDabangAddress } from '../dabangAddress';
import { looksSeen, markSeen, marksVersion, NOTE_MAX, saveNote, setContacted } from '../marks';

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
/** 내가 남긴 표시('봤음', '📞 문의함'). 매물은 깊이 감시하지 않아서 marksVersion으로 표시가 바뀐 것을 알고 다시 그린다. */
const marks = computed(() => (marksVersion.value, {
  seen: looksSeen(props.listing), contactedAt: props.listing.contactedAt ?? null, note: props.listing.note ?? null,
}));

/** 메모 고치는 중인지와 고치는 글 */
const editingNote = ref(false);
const noteDraft = ref('');
const noteInput = ref<HTMLInputElement | null>(null);
async function startNote() {
  noteDraft.value = props.listing.note ?? '';
  editingNote.value = true;
  await nextTick();
  noteInput.value?.focus();
}
function commitNote() {
  saveNote(props.listing, noteDraft.value);
  editingNote.value = false;
}
// 다방은 목록에 주소가 없다. '주소 보기'를 누르면 그 방 하나의 지번 주소만 받아 온다.
const addressText = computed(() => l.value.address ?? dabangAddresses.get(l.value.id) ?? '주소 모름');
const canLoadAddress = computed(() => l.value.source === 'dabang' && !l.value.address && !dabangAddresses.has(l.value.id));
const near = computed(() => nearest(props.listing, props.areas));
const regionMode = computed(() => hasRegions(props.areas));
const relation = computed(() => regionRelation(props.listing, props.areas));
const scopeLabel = computed(() => selectedArea(props.listing, props.areas)?.name ?? (relation.value === 'unknown' ? '지역 모름' : '주변'));
const kind = computed(() => kindOf(props.listing));
/** 정비사업 구역 안이면 물딱지 표시(지금 사면 조합원이 못 되는지와 판 사람 조건) */
const redev = computed(() => redevChip(props.listing, kind.value === 'land'));
/** 사는 매물이면 대출 신호등(디딤돌, 신생아 특례, 보금자리론, 내 소득으로 못 받는 것은 뺌)과 일반 주택담보대출 한도 */
const loan = computed(() => loanView(props.listing, cannotGet));
const claims = computed(() => claimsChip(props.listing));
/** 건축물대장 표시(근린생활시설 용도, 위반건축물) */
const ledger = computed(() => ledgerChips(props.listing));
const eokText = (manwon: number) => `${manwon / 10000}억`;
/** 경매(법원경매, 온비드)는 사진을 받지 않아 사진 칸을 두지 않는다. */
const noThumb = computed(() => isAuction(l.value));
/** 고시원과 쉐어: 면적, 관리비, 층을 주지 않는 곳이라 그 칸을 두지 않고, 유형은 종류 칩 하나로 보인다. */
const room = computed(() => isRoomStay(props.listing));
/** 고시원과 쉐어의 가격 둘(가장 싼 방, 비싼 방)을 한 줄로 이은 것 */
const roomRange = computed(() => rangeOf(props.listing));
/** 월세 보증금이나 전세금을 월세로 바꾼 값(보증금이 다른 집이나 전세와 월세를 견줄 때) */
const converted = computed(() => (room.value ? null : convertedRent(props.listing)));
/** 보증금을 전세대출로 낼 때 매달 나가는 돈(월세 + 이자) */
const loanCost = computed(() => (room.value ? null : loanMonthly(props.listing)));
/** 지도에 꽂은 핀마다 걸어서 몇 분(핀이 없거나 이 매물까지 못 쟀으면 빈 목록) */
const walks = computed(() => walkTimes(props.listing.id));
/** 걷는 시간 칸의 설명: 핀마다 길을 따라 잰 거리와 시간, 잰 방법 */
const walkTip = computed(() =>
  [
    ...walks.value.map((w) => `${w.pin.name}까지 길을 따라 ${distanceText(w.meters)}, 걸어서 ${w.minutes}분`),
    `걷는 속도 시속 ${profile.value.walkKmh ?? WALK_KMH}km(설정 탭 내 조건에서 바꿈). 오픈스트리트맵 길로 잰 값이라 신호 대기, 오르막, 단지 출입문은 안 셉니다.`,
    '다방처럼 좌표를 흐리게 주는 사이트는 조금 다를 수 있습니다.',
  ].join('\n'),
);
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

/** 매물 값(경매는 최저가)이 같은 단지, 전용면적 실거래 중간값보다 이만큼(%) 넘게 낮으면 초록으로 보인다(거래가 2건 이상일 때) */
const BELOW_PCT = 5;
/** 단지를 맞춘 방법 */
const TRADE_BASIS: Record<TradeRef['basis'], string> = {
  jibun: '주소 지번이 실거래 번지와 같음',
  name: '같은 법정동에서 단지 이름이 같음',
  parcel: '네이버 단지 좌표로 찾은 필지 번지가 실거래 번지와 같음',
};
/** 아파트 경매와 공매와 네이버 매매의 실거래 비교(같은 단지, 같은 전용면적): 많이 낮으면 초록 이름표, 아니면 흐린 기준 값 */
const tradeChip = computed(() => {
  const t = l.value.trade;
  if (!t) return null;
  const pct = `${t.diffPct > 0 ? '+' : ''}${t.diffPct.toFixed(1)}%`;
  const auction = isAuction(l.value);
  const area = t.areaMin === t.areaMax ? `${t.areaMin}㎡` : `${t.areaMin}~${t.areaMax}㎡`;
  const title = [
    `국토부 실거래 ${t.complex}(${t.jibun}) 전용 ${area}, 최근 ${t.months}개월 ${t.count}건: 중간값 ${manwon(t.median)}(${manwon(t.min)} ~ ${manwon(t.max)})`,
    `가장 최근 거래: ${t.latest.date.replace(/-/g, '.')} ${manwon(t.latest.price)}, ${t.latest.areaM2}㎡${t.latest.floor != null ? `, ${t.latest.floor}층` : ''}`,
    `단지 맞춘 방법: ${TRADE_BASIS[t.basis]}. 전용면적은 0.5㎡ 안으로 같은 거래만 봤습니다.`,
    `이 ${auction ? '물건 최저가' : '매물 값'}는 중간값보다 ${pct}입니다. ${BELOW_PCT}% 넘게 낮고 거래가 2건 이상이면 초록으로 보입니다.`,
    auction ? '최저가는 입찰 시작 값이라 낙찰가는 보통 이보다 높습니다.' : '매물 값은 부르는 값(호가)입니다.',
    '층, 향, 수리 상태는 따지지 않았고, 최근 한두 달 거래는 신고 기한(30일) 안이라 덜 들어왔을 수 있습니다.',
  ].join('\n');
  if (t.count >= 2 && t.diffPct <= -BELOW_PCT) return { text: `${auction ? '최저가 ' : ''}실거래보다 ${Math.round(-t.diffPct)}% 낮음`, tone: 'chip-down', title };
  return { text: `실거래 중간 ${manwon(t.median)}`, tone: 'chip-muted', title };
});

/** 가격 칸의 작은 거래 이름. 경매 금액은 최저가다. */
const dealName = (p: PriceOption) => (p.deal === 'auction' ? '최저가' : DEAL_LABEL[p.deal]);

/** 경매 최저가가 감정가의 몇 %인지. */
const appraisal = computed(() => {
  const a = l.value.auction;
  const price = l.value.prices[0]?.price;
  if (!a?.appraisal || !price) return null;
  return { rate: Math.round((price / a.appraisal) * 100), amount: money(a.appraisal), title: `감정가 ${money(a.appraisal)}, 최저가는 그 ${Math.round((price / a.appraisal) * 100)}%` };
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

/**
 * 네이버 매물은 크롬 확장으로 목록을 볼 때 들어오므로, 마지막으로 목록에 뜬 시각을 '네이버에서 N일 전 봄'으로 보여 준다.
 * 대시보드에서 눌러 본 '봤음'(seenAt)과는 따로다.
 */
const seenNaver = computed(() => (l.value.source === 'naver' ? l.value.lastSeenAt : null));
</script>

<template>
  <article
    class="card" :class="{ selected, discarded: l.verdict === 'discard', meh: l.verdict === 'meh', gone: l.status === 'gone', 'no-thumb': noThumb }"
    @click="emit('select'), markSeen([l])"
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
          <small v-if="appraisal" :title="appraisal.title">감정가 {{ appraisal.amount }}의 {{ appraisal.rate }}%</small>
          <CountTooltip v-if="converted" :text="converted.tip" :max-width="520"><small class="converted">환산 월 {{ converted.text }}</small></CountTooltip>
          <CountTooltip v-if="loanCost" :text="loanCost.tip" :max-width="520"><small class="converted">대출 시 월 {{ loanCost.text }}</small></CountTooltip>
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
          <b>{{ regionMode ? scopeLabel : near ? distanceText(near.distance) : '?' }}</b>
          <small :title="near?.area.name">{{ regionMode ? (relation === 'selected' ? '선택한 지역' : '기본 목록 밖') : near ? near.area.name : '위치 모름' }}</small>
        </div>
        <CountTooltip v-if="walks.length" :text="walkTip" :max-width="460">
          <div v-if="walks.length === 1" class="stat walk">
            <b>{{ walks[0].minutes }}분</b>
            <small>{{ walks[0].pin.name }}까지</small>
          </div>
          <div v-else class="stat walk many">
            <span v-for="w in walks" :key="w.pin.id"><b>{{ w.minutes }}분</b><small>{{ w.pin.name }}</small></span>
          </div>
        </CountTooltip>
        <div v-if="expect?.length" class="expect">
          <div v-for="(e, i) in expect" :key="e.label" class="stat" :class="{ first: i === 0 }" :title="e.title">
            <b><span v-if="i === 0" class="deal">예상가</span>{{ manwon(e.price) }}</b>
            <small>{{ e.label }} {{ Math.round(e.rate) }}%{{ e.belowMin ? ', 최저가 아래' : '' }}</small>
          </div>
        </div>
      </div>

      <div class="tags">
        <slot name="banner" />
        <CountTooltip v-if="redev" :text="redev.tip" :max-width="480"><span class="chip redev-chip" :class="`chip-${redev.tone}`">{{ redev.label }}</span></CountTooltip>
        <CountTooltip v-for="c in ledger" :key="c.label" :text="c.tip" :max-width="520"><span class="chip" :class="`chip-${c.tone}`">{{ c.label }}</span></CountTooltip>
        <CountTooltip v-if="loan" :text="loan.tip" :max-width="500">
          <span class="chip loan-chip"><span v-for="x in loan.lights" :key="x.id" class="loan" :class="x.state"><i class="ld" />{{ x.name }}</span><span v-if="loan.cap" class="loan-cap">주담대 {{ eokText(loan.cap) }}</span></span>
        </CountTooltip>
        <span v-if="selected" class="selection-label">✓ 선택됨</span>
        <span v-if="l.isNew" class="chip chip-new">신규</span>
        <span v-if="marks.contactedAt" class="chip chip-contact" :title="`${dateTime(marks.contactedAt)}에 문의함으로 표시`">📞 문의함</span>
        <span v-else-if="marks.seen" class="chip chip-viewed" :title="`이 대시보드에서 ${dateTime(l.seenAt!)}에 눌러 봄`">봤음</span>
        <template v-if="changeText">
          <span class="chip" :class="changeText.tone">{{ changeText.label }}</span>
          <span class="change num">{{ changeText.detail }}</span>
        </template>
        <span v-if="tradeChip" class="chip trade-chip" :class="tradeChip.tone" :title="tradeChip.title">{{ tradeChip.text }}</span>
        <span v-if="l.verdict === 'star'" class="chip chip-star">★ 관심</span>
        <span v-else-if="l.verdict === 'meh'" class="chip chip-muted">별로</span>
        <span v-if="l.relistedOf" class="chip chip-muted" :title="`원래 매물: ${l.relistedOf}`">재등록이라 숨김</span>
        <span v-else-if="l.verdict === 'discard'" class="chip chip-muted">버림</span>
        <span v-if="l.similarToDiscarded" class="chip chip-warn">버림한 매물과 비슷</span>
        <span v-if="l.status === 'gone'" class="chip chip-muted">최근 조회에서 안 보임</span>
        <span
          v-if="seenNaver" class="chip chip-seen"
          :title="`네이버 지도에서 이 매물이 든 동그라미를 눌러 목록을 본 마지막 시각: ${dateTime(seenNaver)} (크롬 확장이 기록)`"
        >네이버에서 {{ ago(seenNaver) }} 봄</span>
        <span v-if="!room" class="chip chip-kind" :class="kind" :title="l.buildingType ?? undefined">{{ KIND_LABEL[kind] }}</span>
        <span v-if="roomChip" class="chip chip-room">{{ roomChip }}</span>
        <span v-if="isNoOption(l)" class="chip chip-seen" title="사이트가 준 옵션 목록이 비어 있거나 글에 '무옵션'이라고 적힌 집">무옵션</span>
        <span v-if="l.auction?.failed != null" class="chip chip-room">유찰 {{ l.auction.failed }}회</span>
        <span v-if="l.auction && l.auction.lots > 1" class="chip chip-room" title="같은 사건과 물건번호의 목록(토지, 호실)을 한 번에 매각">{{ l.auction.lots }}개 일괄매각</span>
        <span v-if="l.auction?.share" class="chip chip-warn" title="지분 매각: 집이나 땅 전체가 아니라 일부 지분만 팝니다(다른 공유자가 있음). 땅만 파는 물건의 면적은 지분만큼입니다.">지분</span>
        <CountTooltip v-if="claims" :text="claims.tip" :max-width="520"><span class="chip" :class="`chip-${claims.tone}`">{{ claims.label }}</span></CountTooltip>
        <span v-if="l.auction?.mgmt" class="chip chip-warn" :title="`물건 비고: ${l.auction.mgmt.text}`">{{ l.auction.mgmt.label }}</span>
        <slot name="tags" />
        <span v-if="titleText" class="title" :title="l.title || undefined">{{ titleText }}</span>
        <span class="source muted">{{ SOURCE_LABEL[l.source] }}</span>
      </div>

      <div class="meta muted">
        <!-- 내 메모: 주소 줄 위에 한 줄로 보이고 누르면 고친다. 비우고 저장하면 지운다. -->
        <form v-if="editingNote" class="memo-edit" @click.stop @submit.prevent="commitNote">
          <input
            ref="noteInput" v-model="noteDraft" :maxlength="NOTE_MAX" aria-label="매물 메모" placeholder="예: 집주인 직접, 토요일 방문 예약"
            title="Enter로 저장, Esc로 취소, 비우고 저장하면 메모를 지웁니다" @keydown.esc.prevent="editingNote = false"
          />
          <button class="btn btn-sm btn-primary" type="submit">저장</button>
          <button class="btn btn-sm" type="button" @click="editingNote = false">취소</button>
        </form>
        <p v-else-if="marks.note" class="memo" :title="`${dateTime(l.noteAt ?? null)}에 남긴 메모, 누르면 고칩니다`" @click.stop="startNote">📝 {{ marks.note }}</p>
        <span class="addr">{{ addressText }}</span>
        <button
          v-if="canLoadAddress" type="button" class="btn btn-ghost btn-sm addr-load" :disabled="dabangAddressBusy.has(l.id)"
          :title="dabangAddressErrors.get(l.id) ?? '다방에서 이 방의 지번 주소를 받아 옵니다(한 번 받으면 저장됩니다)'"
          @click.stop="loadDabangAddress(l.id)"
        >{{ dabangAddressBusy.has(l.id) ? '받는 중' : dabangAddressErrors.has(l.id) ? '다시 받기' : '주소 보기' }}</button>
        <span v-if="dabangAddressErrors.has(l.id)" class="addr-error">{{ dabangAddressErrors.get(l.id) }}</span>
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
      <button
        class="btn btn-sm contact" :class="{ on: !!marks.contactedAt }" title="사이트에서 중개사에게 문의했으면 누르세요. 다시 누르면 풉니다."
        @click="setContacted(l, !marks.contactedAt)"
      >
        {{ marks.contactedAt ? '문의함 해제' : '📞 문의함' }}
      </button>
      <button class="btn btn-sm" :class="{ memoed: !!marks.note }" title="이 매물에 짧은 메모를 남깁니다" @click="startNote">📝 메모</button>
      <button class="btn btn-sm" :class="{ on: l.verdict === 'star' }" title="관심 (S)" @click="emit('verdict', l.verdict === 'star' ? null : 'star')">
        {{ l.verdict === 'star' ? '관심 해제' : '★ 관심' }}
      </button>
      <button
        class="btn btn-sm" :class="{ on: l.verdict === 'meh' }" title="별로: 목록에 남기되 흐리게 맨 뒤로 (B)"
        @click="emit('verdict', l.verdict === 'meh' ? null : 'meh')"
      >
        {{ l.verdict === 'meh' ? '별로 해제' : '별로' }}
      </button>
      <button class="btn btn-sm" title="버림: 없어진 매물, 목록에서 숨김 (X)" @click="emit('verdict', l.verdict === 'discard' ? null : 'discard')">
        {{ l.verdict === 'discard' ? '되돌리기' : '✕ 버림' }}
      </button>
    </div>
  </article>
</template>

<style scoped>
.selection-label { display: none; }
/* 넓으면 버튼을 오른쪽 위에 한 줄로 두고 그 아래 작은 버튼들. 좁으면(지도 옆 목록) 버튼을 주소 줄 아래 맨 밑에 한 줄로 둔다. */
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
.card.meh:not(.selected) { opacity: .55; }
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
.stat small.converted { color: var(--ink-2); font-weight: 700; }
.stat.floor { min-width: 52px; }
.stat.dist { width: 80px; }
.stat.floor b, .stat.dist b { font-weight: 700; color: var(--ink-2); }
.stat.walk { min-width: 56px; cursor: help; }
.stat.walk b { color: #5235b5; }
/* 핀이 여럿이면 핀마다 한 줄('27분 회사')로 쌓는다 */
.stat.walk.many span { display: flex; align-items: baseline; gap: 4px; }
.stat.walk.many b { font-size: 15px; }
/* 경매 탭 예상 낙찰가: 숫자 줄 아래 같은 모양(큰 숫자, 아래 작은 설명)의 둘째 줄. 첫 칸은 가격 칸과 같은 너비라 설명이 길면 칸 안에서 줄을 바꾼다. */
.expect { flex: 1 0 100%; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px 16px; }
.expect .stat.first { width: 160px; }
.expect .stat b { font-size: 17px; color: var(--ink-2); }
.expect .stat small { white-space: normal; overflow: visible; }

.tags { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.trade-chip { cursor: help; }
/* 대출 신호등: 초록 가격과 집 조건 맞음, 노랑 확인 필요, 빨강 안 됨 */
.loan-chip { gap: 8px; background: var(--surface-2); color: var(--ink-2); font-weight: 600; }
.loan { display: inline-flex; align-items: center; gap: 4px; }
.ld { width: 8px; height: 8px; border-radius: 50%; background: #adb5bd; }
.loan.ok .ld { background: #2f9e44; }
.loan.maybe .ld { background: #f59f00; }
.loan.no .ld { background: #e03131; }
.loan.no { color: var(--muted); }
.loan-cap { color: var(--ink-2); }
.chip-room { background: var(--surface-2); color: var(--ink-2); }
.change { font-size: 13px; color: var(--ink-2); }
.title { flex: 1 1 0; min-width: 6em; margin-left: 4px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.source { margin-left: auto; font-size: 13px; font-weight: 600; }
.meta { display: flex; flex-wrap: wrap; gap: 0 14px; font-size: 13px; }
.meta .addr-load { min-height: 0; padding: 0 6px; margin-left: -10px; font-size: 12px; line-height: 1.6; }
.meta .addr-error { color: var(--new); }

.more { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px; }
.more .btn { min-height: 30px; padding: 0 8px; font-size: 13px; color: var(--muted); font-weight: 600; }
.more .site-link { margin-right: 4px; padding: 0 10px; color: var(--accent); font-weight: 700; }
.actions { display: flex; justify-content: flex-end; gap: 6px; }
.actions .on { background: var(--star-soft); border-color: var(--star); }
.actions .contact.on { background: var(--contact-soft); border-color: var(--contact); }
.actions .memoed { border-color: var(--star); }
/* 내 메모: 주소 줄 칸 맨 위에 한 줄(칸 너비를 다 쓴다) */
.memo {
  flex: 1 0 100%; margin: 0 0 2px; padding: 3px 10px; border-left: 3px solid var(--star); border-radius: 4px;
  background: var(--star-soft); color: var(--ink-2); font-size: 13px; cursor: text; overflow-wrap: anywhere;
}
.memo-edit { flex: 1 0 100%; display: flex; gap: 6px; align-items: center; margin-bottom: 2px; }
.memo-edit input {
  flex: 1; min-width: 0; min-height: 34px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px;
  background: var(--surface); color: var(--ink); font: inherit; font-size: 14px;
}
/*
 * 목록 칸 너비에 맞춘다(매물 탭과 경매 탭은 지도 옆이라 좁다). 버튼을 세로로 쌓으면 카드가 버튼 높이만큼 길어져서,
 * 버튼은 주소 줄 아래 맨 밑에 한 줄로 두고(넘치면 다음 줄), 작은 버튼들은 넓을 때처럼 주소 줄 오른쪽에 둔다.
 */
@container (max-width: 1060px) {
  .card {
    grid-template-columns: 112px minmax(0, 1fr) auto;
    grid-template-areas:
      'thumb stats   stats'
      'thumb tags    tags'
      'thumb meta    more'
      'thumb actions actions';
  }
  .card.no-thumb {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'stats   stats'
      'tags    tags'
      'meta    more'
      'actions actions';
  }
  .actions { flex-wrap: wrap; justify-content: flex-start; }
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
  .more { justify-content: flex-start; margin-left: -8px; }
}
@container (max-width: 480px) {
  .card { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'thumb' 'stats' 'tags' 'meta' 'actions' 'more'; }
  .thumb { width: 100%; height: 160px; }
}
</style>
