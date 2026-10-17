<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { manwon } from '../format';
import { GUARANTEE_RULE, guaranteeCheck } from '../support';

// 보증보험 칸의 반환보증 보증한도 계산기. HUG 기준(GUARANTEE_RULE)으로 대략 계산하고, 실제 가입은 심사에서 정해진다.
// 넣은 값은 이 브라우저에 남겨 다음에 열어도 그대로 둔다(금액은 만원).

const KEY = 'hnw-guarantee-calc';
type Basis = 'market' | 'official';
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
})();
/** 빈칸이나 잘못 넣은 값은 null(계산하지 않음) */
const amount = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const form = reactive({
  basis: (saved.basis === 'official' ? 'official' : 'market') as Basis,
  price: amount(saved.price) as number | null,
  senior: amount(saved.senior) as number | null,
  deposit: amount(saved.deposit) as number | null,
  capital: saved.capital !== false,
});
watch(form, (f) => localStorage.setItem(KEY, JSON.stringify(f)), { deep: true });

const price = computed(() => amount(form.price));
const senior = computed(() => amount(form.senior) ?? 0);
const deposit = computed(() => amount(form.deposit));
const result = computed(() =>
  price.value && deposit.value
    ? guaranteeCheck({ basis: form.basis, price: price.value, senior: senior.value, deposit: deposit.value, capital: form.capital })
    : null,
);
const officialPercent = `${Math.round(GUARANTEE_RULE.officialRate * 100)}%`;
const ratioPercent = `${Math.round(GUARANTEE_RULE.ratio * 100)}%`;
const seniorPercent = `${Math.round(GUARANTEE_RULE.seniorMax * 100)}%`;
</script>

<template>
  <div class="calc">
    <div class="calc-head">
      <strong>보증한도 계산기</strong>
      <span class="muted">HUG 반환보증 기준으로 대략 계산합니다. 실제 가입은 심사에서 정해집니다.</span>
    </div>

    <fieldset class="basis">
      <legend class="sr-only">집값 기준</legend>
      <label class="choice">
        <input v-model="form.basis" type="radio" name="guarantee-basis" value="market" />
        <span>시세</span><span class="hint">아파트·오피스텔</span>
      </label>
      <label class="choice">
        <input v-model="form.basis" type="radio" name="guarantee-basis" value="official" />
        <span>공시가격</span><span class="hint">빌라·단독·다가구, × {{ officialPercent }}</span>
      </label>
    </fieldset>

    <div class="fields">
      <label class="field">
        <span>{{ form.basis === 'official' ? '공시가격' : '시세' }}(만원)</span>
        <input v-model.number="form.price" type="number" min="0" step="100" inputmode="numeric" :placeholder="form.basis === 'official' ? '예: 20000' : '예: 40000'" />
      </label>
      <label class="field" title="등기부 을구 근저당의 채권최고액 합계. 단독·다가구·다중주택은 나보다 먼저 들어온 다른 세대 보증금도 더합니다.">
        <span>선순위 채권(만원)</span>
        <input v-model.number="form.senior" type="number" min="0" step="100" inputmode="numeric" placeholder="없으면 0" />
      </label>
      <label class="field">
        <span>내 보증금(만원)</span>
        <input v-model.number="form.deposit" type="number" min="0" step="100" inputmode="numeric" placeholder="예: 25000" />
      </label>
      <label class="field">
        <span>지역</span>
        <select v-model="form.capital">
          <option :value="true">수도권(서울)</option>
          <option :value="false">그 밖</option>
        </select>
      </label>
    </div>
    <p class="hint-line muted">선순위 채권은 등기부 을구 근저당의 채권최고액 합계입니다. 단독·다가구·다중주택은 나보다 먼저 들어온 다른 세대 보증금도 더합니다.</p>

    <template v-if="result">
      <dl class="numbers">
        <div>
          <dt>집값으로 보는 금액</dt>
          <dd class="num">{{ manwon(result.house) }}<span v-if="form.basis === 'official'" class="muted"> (공시가격 × {{ officialPercent }})</span></dd>
        </div>
        <div>
          <dt>보증한도</dt>
          <dd class="num">{{ result.limit > 0 ? manwon(result.limit) : '없음' }}<span class="muted"> (집값 × {{ ratioPercent }} − 선순위 {{ manwon(senior) }})</span></dd>
        </div>
        <div>
          <dt>이 집에서 들 수 있는 보증금</dt>
          <dd class="num"><b>{{ result.maxDeposit > 0 ? `${manwon(result.maxDeposit)}까지` : '없음' }}</b></dd>
        </div>
      </dl>
      <ul class="checks">
        <li :class="result.depositOk ? 'ok' : 'bad'">
          내 보증금 {{ manwon(deposit ?? 0) }}:
          {{ result.depositOk ? '보증한도 안' : result.limit > 0 ? `보증한도보다 ${manwon((deposit ?? 0) - result.limit)} 많음` : '보증한도가 없음' }}
        </li>
        <li :class="result.seniorOk ? 'ok' : 'bad'">선순위 채권: {{ result.seniorOk ? `집값의 ${seniorPercent} 이내` : `집값의 ${seniorPercent}를 넘음` }}</li>
        <li :class="result.capOk ? 'ok' : 'bad'">보증금 상한({{ form.capital ? '수도권' : '그 밖' }} {{ manwon(result.cap) }}): {{ result.capOk ? '넘지 않음' : '넘음' }}</li>
      </ul>
      <p class="verdict" :class="result.ok ? 'ok' : 'bad'">
        {{ result.ok ? '계산상 기준 안입니다. 집 종류, 위반건축물, 집주인 같은 나머지는 심사에서 봅니다.' : '계산상 기준 밖이라 가입이 안 될 가능성이 큽니다.' }}
      </p>
    </template>
    <p v-else class="muted empty">{{ form.basis === 'official' ? '공시가격' : '시세' }}과 내 보증금을 넣으면 계산합니다.</p>
  </div>
</template>

<style scoped>
.calc { display: grid; gap: 10px; margin-top: 16px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }
.calc-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; font-size: 13px; }
.calc-head .muted { font-size: 12px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.basis { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 0; padding: 0; border: 0; }
.choice { display: inline-flex; align-items: center; gap: 5px; min-height: 34px; font-size: 13px; color: var(--ink-2); cursor: pointer; }
.choice input { width: 15px; height: 15px; margin: 0 2px 0 0; accent-color: var(--accent); }
.choice:has(input:checked) > span:first-of-type { font-weight: 700; color: var(--ink); }
.hint { font-size: 12px; color: var(--muted); }
.fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.hint-line { margin: 0; font-size: 12px; }
.numbers { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 16px; margin: 4px 0 0; }
.numbers div { display: grid; gap: 2px; }
.numbers dt { font-size: 12px; color: var(--muted); }
.numbers dd { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); }
.numbers dd .muted { font-size: 12px; font-weight: 400; }
.numbers dd b { font-size: 16px; }
.checks { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
.checks li::before { display: inline-block; width: 16px; font-weight: 700; }
.checks li.ok::before { content: '✓'; color: var(--down); }
.checks li.bad::before { content: '✕'; color: var(--new); }
.verdict { margin: 0; padding: 8px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; }
.verdict.ok { background: var(--down-soft); color: var(--down); }
.verdict.bad { background: var(--new-soft); color: var(--new); }
.empty { margin: 0; font-size: 12px; }
</style>
