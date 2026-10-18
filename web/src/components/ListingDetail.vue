<script setup lang="ts">
import { computed } from 'vue';
import { DEAL_LABEL, SOURCE_LABEL, type Area, type ListingView, type Verdict } from '../../../shared/types';
import { distanceText, floorText, manwon, nearest, priceAmount, pyeong } from '../format';
import { KIND_LABEL, kindOf } from '../kinds';
import { roomRange } from '../rooms';
import ZoneBanner from './ZoneBanner.vue';

const props = defineProps<{ listing: ListingView | null; areas: Area[] }>();
const emit = defineEmits<{ open: []; verdict: [Verdict | null]; source: []; raw: [] }>();

const near = computed(() => props.listing ? nearest(props.listing, props.areas) : null);
const range = computed(() => props.listing ? roomRange(props.listing) : null);
const kind = computed(() => props.listing ? kindOf(props.listing) : 'unknown');
const heading = computed(() => {
  const l = props.listing;
  if (!l) return '';
  if (l.auction) return `${l.auction.caseNo}${l.auction.itemNo !== '1' ? ` (${l.auction.itemNo})` : ''}`;
  return l.title || l.roomLabel || (kind.value === 'unknown' ? '선택한 매물' : KIND_LABEL[kind.value]);
});
</script>

<template>
  <section class="listing-detail" aria-label="선택한 매물 상세">
    <div class="detail-heading"><span class="detail-eyebrow">선택한 매물</span><span v-if="listing?.isNew" class="detail-new">신규</span></div>
    <template v-if="listing">
      <p class="detail-source">{{ SOURCE_LABEL[listing.source] }}</p>
      <h2>{{ heading }}</h2>
      <div class="detail-prices num">
        <div v-if="range" class="detail-price"><span>월세</span><strong>{{ range }}</strong></div>
        <template v-else>
          <div v-for="(price, i) in listing.prices" :key="i" class="detail-price">
            <span>{{ price.deal === 'auction' ? '최저가' : DEAL_LABEL[price.deal] }}</span>
            <strong>{{ priceAmount(price) }}</strong>
          </div>
          <p v-if="!listing.prices.length" class="detail-unknown">가격 정보 없음</p>
        </template>
      </div>
      <p class="detail-address">{{ listing.address || '주소 정보 없음' }}</p>
      <ZoneBanner v-if="listing.zone" part="banner" :listing="listing" :key-set="false" />
      <dl class="detail-facts">
        <div v-if="listing.buildingType || kind !== 'unknown'"><dt>유형</dt><dd>{{ listing.buildingType || KIND_LABEL[kind] }}</dd></div>
        <div v-if="listing.roomLabel"><dt>방 구조</dt><dd>{{ listing.roomLabel }}</dd></div>
        <div v-if="listing.areaM2 != null"><dt>{{ kind === 'land' ? '토지 면적' : '전용 면적' }}</dt><dd>{{ listing.areaM2 }}㎡ <span>({{ pyeong(listing.areaM2) }}평)</span></dd></div>
        <div v-if="kind !== 'land' && (listing.floor != null || listing.basement || listing.rooftop)"><dt>층수</dt><dd>{{ floorText(listing) }}</dd></div>
        <div v-if="listing.maintenance != null"><dt>관리비</dt><dd>{{ listing.maintenance === 0 ? '0원' : `${manwon(listing.maintenance)}원` }}</dd></div>
        <div v-if="listing.availableFrom"><dt>입주</dt><dd>{{ listing.availableFrom }}</dd></div>
        <div v-if="near" class="detail-distance"><dt>가까운 지역</dt><dd>{{ near.area.name }}<span>직선 {{ distanceText(near.distance) }}</span></dd></div>
      </dl>
      <div class="detail-actions">
        <button type="button" class="detail-open" @click="emit('open')">원본 열기 <span aria-hidden="true">↗</span></button>
        <div class="detail-decisions">
          <button type="button" :class="{ active: listing.verdict === 'star' }" :aria-pressed="listing.verdict === 'star'" @click="emit('verdict', listing.verdict === 'star' ? null : 'star')">{{ listing.verdict === 'star' ? '★ 관심 해제' : '☆ 관심' }}</button>
          <button type="button" :aria-pressed="listing.verdict === 'discard'" @click="emit('verdict', listing.verdict === 'discard' ? null : 'discard')">{{ listing.verdict === 'discard' ? '되돌리기' : '버림' }}</button>
        </div>
      </div>
      <div class="detail-tools">
        <button v-if="listing.seenRef?.screenshot" type="button" @click="emit('source')">출처 보기</button>
        <button type="button" @click="emit('raw')">원본 데이터</button>
      </div>
    </template>
    <p v-else class="detail-empty">고른 매물 없음</p>
  </section>
</template>

<style scoped>
.listing-detail { min-width: 0; padding: 23px 20px 17px; border: 1px solid #e0e5eb; border-radius: 18px; background: #fff; color: #203247; }
.detail-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 22px; }
.detail-eyebrow { color: #687788; font-size: 12px; font-weight: 650; }
.detail-new { padding: 3px 7px; border-radius: 5px; background: #eaf5ef; color: #246748; font-size: 11px; font-weight: 700; }
.detail-source { margin: 0 0 7px; color: #637286; font-size: 12px; }
h2 { margin: 0; font-size: 19px; font-weight: 700; line-height: 1.45; letter-spacing: -.035em; overflow-wrap: anywhere; }
.detail-prices { display: grid; gap: 8px; margin: 21px 0 15px; }
.detail-price { display: grid; gap: 3px; }
.detail-price > span { color: #637286; font-size: 12px; font-weight: 600; }
.detail-price strong { font-size: 26px; font-weight: 750; letter-spacing: -.055em; line-height: 1.25; overflow-wrap: anywhere; }
.detail-unknown { margin: 0; color: #637286; font-size: 14px; }
.detail-address { margin: 0 0 20px; color: #5b697a; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.detail-facts { display: grid; gap: 13px; margin: 0; padding: 19px 0; border-top: 1px solid #edf0f3; }
.detail-facts > div { display: grid; grid-template-columns: 66px minmax(0, 1fr); gap: 8px; font-size: 12px; line-height: 1.55; }
dt { color: #6b7888; }
dd { margin: 0; text-align: right; font-weight: 600; overflow-wrap: anywhere; }
dd span { color: #6b7888; font-weight: 400; }
.detail-distance dd span { display: block; margin-top: 2px; font-size: 11px; }
.detail-actions { display: grid; gap: 8px; margin-top: 5px; }
button { min-height: 38px; padding: 7px 10px; border: 1px solid #dce2e9; border-radius: 9px; background: #fff; color: #304359; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
button:hover { border-color: #a9b6c5; background: #f4f7fa; }
button:focus-visible { outline: 2px solid #4270a0; outline-offset: 3px; }
.detail-open { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 42px; border-color: #203b58; background: #203b58; color: #fff; }
.detail-open:hover { border-color: #2c4d70; background: #2c4d70; }
.detail-decisions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.detail-decisions .active { border-color: #d9c48f; background: #fff8e7; color: #76590d; }
.detail-tools { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 12px; margin-top: 12px; }
.detail-tools button { min-height: 32px; padding: 4px 0; border-color: transparent; border-radius: 3px; background: transparent; color: #687788; font-size: 11px; font-weight: 500; text-decoration: underline; text-underline-offset: 3px; }
.detail-tools button:hover { color: #203b58; }
.detail-empty { margin: 0; padding: 8px 0 14px; color: #6b7888; font-size: 13px; text-align: center; }
@media (max-width: 520px) { .listing-detail { padding: 20px 18px 16px; } }
</style>
