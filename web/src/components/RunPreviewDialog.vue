<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { collectionPriceSummary } from '../../../shared/collection-price-limits';
import { SOURCE_LABEL, type CollectionPriceLimits, type RunPreview, type SourceId } from '../../../shared/types';
import { commonPricesForRun } from '../commonCollectionPrices';

type PreviewSite = RunPreview['sites'][number];
const commonFields = [
  { key: 'monthlyDepositMax', label: '보증금과 전세금' },
  { key: 'monthlyMax', label: '월세' },
  { key: 'saleMax', label: '매매가' },
] as const;
type PriceField = typeof commonFields[number]['key'];
type PriceDraft = Record<PriceField, string> & { excludeSale: boolean };
const props = defineProps<{
  title: string;
  sites: RunPreview['sites'];
  selectedSources: readonly SourceId[];
  includeNotices: boolean;
  commonLimits: CollectionPriceLimits | null;
  commonPriceSites: readonly SourceId[];
  noticeCount: number;
  rentalOnly: boolean;
  loading: boolean;
  starting: boolean;
  error: string | null;
}>();
const emit = defineEmits<{
  close: [];
  retry: [];
  start: [];
  toggleSource: [source: SourceId, selected: boolean];
  toggleNotices: [selected: boolean];
  commonChange: [limits: CollectionPriceLimits | null];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const headingId = useId();
const commonDraft = ref(draftFrom(props.commonLimits));
const commonSaleExcluded = computed(() => props.rentalOnly || commonDraft.value.excludeSale);
const activeCommon = computed(() => commonPricesForRun(props.commonLimits, props.rentalOnly));
const invalidCommon = computed(() => props.commonPriceSites.length > 0 && commonFields.some(({ key }) =>
  !(key === 'saleMax' && commonSaleExcluded.value) && invalidAmount(commonDraft.value[key])));
const hasSelection = computed(() => props.selectedSources.length > 0 || (props.includeNotices && props.noticeCount > 0));

onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => dialog.value?.close());

function close() {
  if (!props.starting) emit('close');
}

function draftFrom(limits: CollectionPriceLimits | null): PriceDraft {
  return {
    saleMax: String(limits?.saleMax ?? ''),
    monthlyDepositMax: String(limits?.monthlyDepositMax ?? ''),
    monthlyMax: String(limits?.monthlyMax ?? ''),
    excludeSale: limits?.excludeSale ?? false,
  };
}

const invalidAmount = (value: string) => value !== '' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)));

function applyCommonDraft() {
  if (invalidCommon.value) return;
  const draft = commonDraft.value;
  const amount = (key: PriceField) => draft[key] !== '' && !invalidAmount(draft[key]) ? Number(draft[key]) : null;
  const deposit = amount('monthlyDepositMax');
  const limits = { saleMax: amount('saleMax'), jeonseMax: deposit, monthlyDepositMax: deposit,
    monthlyMax: amount('monthlyMax'), excludeSale: draft.excludeSale };
  const hasCondition = limits.excludeSale || commonFields.some(({ key }) => limits[key] !== null);
  emit('commonChange', hasCondition ? limits : null);
}

function changeCommonAmount(field: PriceField, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  commonDraft.value[field] = value;
  applyCommonDraft();
}

function changeCommonSale(event: Event) {
  if (props.rentalOnly) return;
  commonDraft.value.excludeSale = (event.target as HTMLInputElement).checked;
  applyCommonDraft();
}

function clearCommon() {
  commonDraft.value = draftFrom(null);
  emit('commonChange', null);
}

function sitePriceText(site: PreviewSite): string {
  if (!props.selectedSources.includes(site.source)) return '이번 조회에서 제외';
  if (site.supportsPriceLimits) {
    if (activeCommon.value) return '공통 조건으로 요청';
    return props.rentalOnly ? '매매 제외, 가격 상한 없음' : '가격 제한 없음';
  }
  return props.rentalOnly ? '받은 매물에서 전세와 월세만 저장' : '기존 방식으로 조회 및 저장';
}
</script>

<template>
  <dialog ref="dialog" class="run-preview" :aria-labelledby="headingId" @cancel.prevent="close" @click.self="close">
    <div class="preview-box">
      <header class="preview-head">
        <h2 :id="headingId">조회 조건 확인</h2>
        <p>{{ title }}</p>
      </header>
      <div class="preview-body" :aria-busy="loading">
        <p v-if="loading" class="preview-status" role="status">조회 조건을 불러오는 중입니다.</p>
        <div v-if="error" class="preview-error" role="alert">
          <p>{{ error }}</p>
          <button type="button" class="btn btn-sm" :disabled="loading || starting" @click="emit('retry')">다시 확인</button>
        </div>
        <template v-if="!loading && (sites.length || noticeCount)">
          <fieldset v-if="commonPriceSites.length" class="preview-common" :disabled="starting">
            <legend>공통 가격 조건</legend>
            <p>가격 조건을 보낼 수 있는 사이트에 함께 적용합니다. 빈칸은 제한 없음입니다. 조회를 시작하면 이 브라우저에 조건을 기억합니다.</p>
            <div class="preview-price-fields">
              <label v-for="{ key, label } in commonFields" :key="key">
                <span>{{ label }} 상한 (만원)</span>
                <input type="text" inputmode="numeric" placeholder="제한 없음" :value="commonDraft[key]"
                  :disabled="key === 'saleMax' && commonSaleExcluded"
                  :aria-invalid="invalidAmount(commonDraft[key]) && !(key === 'saleMax' && commonSaleExcluded)"
                  @input="changeCommonAmount(key, $event)" />
              </label>
            </div>
            <div class="preview-price-options">
              <label><input type="checkbox" :checked="commonSaleExcluded" :disabled="rentalOnly" @change="changeCommonSale" /> 매매 제외</label>
              <button v-if="commonLimits || invalidCommon" type="button" class="btn btn-sm" @click="clearCommon">공통 조건 해제</button>
            </div>
            <p v-if="invalidCommon" class="preview-invalid" role="alert">가격은 만원 단위의 0 이상 정수로 입력해 주세요.</p>
            <p v-else-if="activeCommon" class="preview-common-summary">{{ collectionPriceSummary(activeCommon) }}</p>
            <p>가격 조건을 보낼 수 없는 사이트는 기존 조회 기준으로 저장합니다. 네이버는 확장 프로그램의 필터를 사용합니다.</p>
          </fieldset>
          <fieldset class="preview-sites" :disabled="starting">
            <legend>조회 대상</legend>
            <label v-for="site in sites" :key="site.source" class="preview-site">
              <span class="preview-site-name"><input type="checkbox" :aria-label="SOURCE_LABEL[site.source]" :checked="selectedSources.includes(site.source)"
                @change="emit('toggleSource', site.source, ($event.target as HTMLInputElement).checked)" />{{ SOURCE_LABEL[site.source] }}</span>
              <span class="preview-muted">{{ sitePriceText(site) }}</span>
            </label>
            <label v-if="noticeCount" class="preview-site">
              <span class="preview-site-name"><input type="checkbox" :aria-label="`공고 ${noticeCount}곳`" :checked="includeNotices"
                @change="emit('toggleNotices', ($event.target as HTMLInputElement).checked)" />공고 {{ noticeCount }}곳</span>
              <span class="preview-muted">{{ includeNotices ? '공고 조회' : '이번 조회에서 제외' }}</span>
            </label>
          </fieldset>
          <p v-if="rentalOnly" class="preview-notices">전세와 월세 매물만 저장합니다.</p>
          <p v-if="!hasSelection" class="preview-notices">조회 대상을 하나 이상 선택해 주세요.</p>
        </template>
      </div>
      <footer class="preview-actions">
        <button type="button" class="btn" autofocus :disabled="starting" @click="close">취소</button>
        <button type="button" class="btn btn-primary" :disabled="loading || starting || !!error || invalidCommon || !hasSelection" @click="emit('start')">
          {{ starting ? '조회 시작 중' : '조회 시작' }}
        </button>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.run-preview {
  width: min(590px, calc(100vw - 28px)); max-width: none; max-height: calc(100dvh - 28px);
  padding: 0; border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
  color: var(--ink); background: var(--surface); box-shadow: 0 16px 48px rgba(22, 32, 46, .3);
}
.run-preview::backdrop { background: rgba(22, 32, 46, .48); }
.preview-box { display: flex; flex-direction: column; max-height: calc(100dvh - 30px); }
.preview-head, .preview-body, .preview-actions { padding: 16px 20px; }
.preview-head { border-bottom: 1px solid var(--line); }
.preview-head h2 { margin: 0; font-size: 20px; }
.preview-head p { margin: 2px 0 0; color: var(--ink-2); }
.preview-body { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.preview-common {
  display: grid; gap: 8px; min-width: 0; padding: 10px 12px 12px; margin: 0 0 16px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2);
}
.preview-common legend { padding: 0 5px; font-weight: 700; }
.preview-common p { margin: 0; font-size: 13px; }
.preview-common p:not(.preview-invalid, .preview-common-summary) { color: var(--ink-2); }
.preview-common-summary { font-weight: 600; overflow-wrap: anywhere; }
.preview-sites { border: 0; padding: 0; margin: 0; min-width: 0; }
.preview-sites legend { padding: 0 0 4px; font-weight: 700; }
.preview-site {
  display: grid; grid-template-columns: minmax(98px, 1fr) minmax(0, 3fr); align-items: baseline; gap: 2px 14px;
  padding: 9px 0; border-bottom: 1px solid var(--line);
}
.preview-site:last-child { padding-bottom: 0; border-bottom: 0; }
.preview-site-name { display: inline-flex; align-items: baseline; gap: 7px; font-weight: 600; }
.preview-site-name input { margin: 0; }
.preview-price-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.preview-price-fields label { display: grid; gap: 3px; font-size: 13px; }
.preview-price-fields input {
  min-width: 0; width: 100%; padding: 6px 7px; border: 1px solid var(--line-strong); border-radius: 6px;
  background: var(--surface); color: var(--ink); font: inherit;
}
.preview-price-fields input:disabled { background: var(--surface-2); color: var(--ink-2); }
.preview-price-fields input[aria-invalid=true] { border-color: var(--new); }
.preview-price-options { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 13px; }
.preview-price-options label { display: inline-flex; align-items: center; gap: 5px; }
.preview-invalid { color: var(--new); }
.preview-muted, .preview-status, .preview-notices { color: var(--ink-2); }
.preview-status, .preview-error p, .preview-notices { margin: 0; }
.preview-sites + .preview-notices { margin-top: 14px; }
.preview-error {
  display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-radius: 8px; color: var(--ink); background: var(--up-soft);
}
.preview-error + .preview-common, .preview-error + .preview-sites, .preview-error + .preview-notices { margin-top: 14px; }
.preview-actions { display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--line); }
@media (max-width: 420px) {
  .preview-head, .preview-body, .preview-actions { padding: 13px 14px; }
  .preview-site { grid-template-columns: minmax(90px, 1fr) minmax(0, 2fr); }
}
</style>
