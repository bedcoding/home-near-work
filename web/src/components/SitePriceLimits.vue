<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { COLLECTION_AMOUNT_LABELS, collectionPriceSummary } from '../../../shared/collection-price-limits';
import type { CollectionPriceLimits, CollectionPriceLimitsState, SourceId } from '../../../shared/types';
import { api } from '../api';

const props = defineProps<{ source: SourceId; canRun: boolean; running: boolean }>();
const emit = defineEmits<{ run: [] }>();
type PriceField = keyof typeof COLLECTION_AMOUNT_LABELS;
const fields = Object.keys(COLLECTION_AMOUNT_LABELS) as PriceField[];
const settings = ref<CollectionPriceLimitsState | null>(null);
const saved = computed(() => settings.value?.limits[props.source] ?? null);
const supported = computed(() => settings.value?.upstreamSites.includes(props.source));
const inputs = ref<Record<PriceField, string>>({ saleMax: '', jeonseMax: '', monthlyDepositMax: '', monthlyMax: '' });
const excludeSale = ref(false);
const loading = ref(true);
const saving = ref(false);
const loadError = ref(false);
const message = ref('');
const failed = ref(false);

function setDraft(limits: CollectionPriceLimits | null) {
  for (const key of fields) inputs.value[key] = String(limits?.[key] ?? '');
  excludeSale.value = limits?.excludeSale ?? false;
}

async function load() {
  loading.value = true;
  loadError.value = false;
  try {
    settings.value = await api.collectionPriceLimits();
    setDraft(saved.value);
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(() => { void load(); });
watch(() => props.source, () => {
  setDraft(saved.value);
  message.value = '';
  failed.value = false;
});

const parsed = computed<CollectionPriceLimits | null>(() => {
  const limits: CollectionPriceLimits = { saleMax: null, jeonseMax: null, monthlyDepositMax: null, monthlyMax: null, excludeSale: excludeSale.value };
  for (const key of fields) {
    if (!inputs.value[key]) continue;
    const value = Number(inputs.value[key]);
    if (!Number.isSafeInteger(value) || value < 0) {
      if (key === 'saleMax' && excludeSale.value) continue;
      return null;
    }
    limits[key] = value;
  }
  return limits;
});
const dirty = computed(() => excludeSale.value !== (saved.value?.excludeSale ?? false)
  || fields.some(key => inputs.value[key] !== String(saved.value?.[key] ?? '')));

async function save(limits: CollectionPriceLimits | null) {
  if (saving.value) return;
  const source = props.source;
  message.value = '';
  failed.value = false;
  saving.value = true;
  try {
    settings.value = await api.setCollectionPriceLimits(source, limits);
    if (props.source === source) {
      setDraft(saved.value);
      message.value = saved.value ? '다음 조회에 적용할 조건을 저장했습니다.' : '가격 제한을 해제했습니다.';
    }
  } catch (error) {
    if (props.source === source) {
      failed.value = true;
      message.value = error instanceof Error ? error.message : '가격 조건을 저장하지 못했습니다.';
    }
  } finally {
    saving.value = false;
  }
}

function saveDraft() {
  if (parsed.value) void save(parsed.value);
}

function setAmount(key: PriceField, event: Event) {
  inputs.value[key] = (event.target as HTMLInputElement).value;
  message.value = '';
}
</script>

<template>
  <section class="site-price" aria-label="수집 가격 조건">
    <h3>수집 가격 조건</h3>
    <p v-if="source === 'naver'">네이버에서 가격 필터를 적용한 뒤, 확장 프로그램에서 그 탭의 조건을 읽어 수집에 사용합니다.</p>
    <p v-else-if="loading">저장한 가격 조건을 불러오는 중입니다.</p>
    <div v-else-if="loadError" class="price-actions">
      <p role="alert">가격 조건을 불러오지 못했습니다.</p>
      <button type="button" class="btn btn-sm" @click="load">다시 불러오기</button>
    </div>
    <template v-else-if="supported">
      <div class="price-saved">
        <span>다음 서버 조회에 적용</span>
        <strong>{{ saved ? collectionPriceSummary(saved) : '가격 제한 없음' }}</strong>
      </div>
      <p>대시보드의 조회하기와 서버 자동 확인에 사용합니다.</p>
      <form class="price-form" @submit.prevent="saveDraft">
        <fieldset :disabled="saving" aria-label="가격 상한">
          <div class="price-fields">
            <label v-for="key in fields" :key="key">
              <span>{{ COLLECTION_AMOUNT_LABELS[key] }} 상한 <small>(만원)</small></span>
              <input type="number" min="0" step="1" placeholder="제한 없음"
                :disabled="key === 'saleMax' && excludeSale" :value="inputs[key]"
                @input="setAmount(key, $event)" />
            </label>
          </div>
          <label class="price-checkbox">
            <input v-model="excludeSale" type="checkbox" @change="message = ''" />
            매매 제외
          </label>
        </fieldset>
        <p v-if="dirty" class="price-preview" aria-live="polite">
          {{ parsed ? `저장할 조건은 ${collectionPriceSummary(parsed)}입니다.` : '금액은 0 이상 정수로 입력해 주세요.' }}
        </p>
        <div class="price-actions">
          <button type="submit" class="btn btn-primary btn-sm" :disabled="saving || !dirty || !parsed">조건 저장</button>
          <button v-if="saved" type="button" class="btn btn-sm" :disabled="saving" @click="save(null)">가격 제한 해제</button>
          <button v-if="canRun" type="button" class="btn btn-sm" :disabled="saving || dirty || running" @click="emit('run')">이 사이트만 조회</button>
        </div>
        <p v-if="message" :class="{ 'price-error': failed }" :role="failed ? 'alert' : 'status'">{{ message }}</p>
      </form>
    </template>
    <p v-else>이 사이트는 수집 요청에 가격 조건을 적용하는 기능이 아직 연결되지 않았습니다.</p>
  </section>
</template>

<style scoped>
.site-price { display: grid; gap: 10px; min-width: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.site-price h3, .site-price p { margin: 0; }
.site-price p { font-size: 13px; line-height: 1.5; color: var(--muted); }
.price-saved { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 10px; border-radius: 8px; background: var(--surface-2); padding: 8px 10px; font-size: 13px; }
.price-saved span { color: var(--ink-2); }
.price-form { display: grid; gap: 9px; }
.price-form fieldset { display: grid; gap: 9px; min-width: 0; border: 0; padding: 0; margin: 0; }
.price-fields { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.price-fields label { display: grid; gap: 4px; font-size: 13px; font-weight: 600; }
.price-fields small { font-size: 12px; font-weight: 400; color: var(--muted); }
.price-fields input { width: 100%; padding: 7px 8px; border: 1px solid var(--line-strong); border-radius: 6px; color: var(--ink); background: var(--surface); font: inherit; font-weight: 500; }
.price-fields input:disabled { background: var(--surface-2); color: var(--muted); }
.price-checkbox { display: flex; align-items: center; gap: 7px; justify-self: start; font-size: 13px; }
.price-checkbox input { margin: 0; }
.price-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.price-actions button:disabled { opacity: .5; cursor: default; }
.price-preview { overflow-wrap: anywhere; }
.site-price .price-error { color: var(--new); }
@media (max-width: 620px) { .price-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
