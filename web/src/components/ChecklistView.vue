<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import CountTooltip from './CountTooltip.vue';
import GuaranteeCalc from './GuaranteeCalc.vue';
import {
  CHECK_DEALS, CHECK_ITEMS, CHECK_KINDS, CHECK_LISTS, CHECK_PLACES, CHECKLIST_CHECKED,
  type CheckDeal, type CheckGoto, type CheckItem, type CheckKind, type CheckList,
} from '../checklist';

// 체크리스트 탭: 집을 볼 때 확인할 것(집 하자)과 계약금을 넣기 전에 확인할 것(계약 전)을 거래 유형(전체, 전세, 월세, 매매, 경매)마다
// 칸으로 나눠 보인다. 항목을 누르면 체크되고, 체크는 목록과 거래 유형마다 이 브라우저에 기억한다.
// 전체로 보면 모든 항목이 보이고 항목마다 해당 거래 유형 라벨이 붙는다(라벨을 누르면 그 유형으로 바뀐다).
// 집 종류를 고르면 다른 종류에만 해당하는 항목을 뺀다. 전세와 전체의 계약 전 목록에는 전세가율과 보증보험 계산기를 같이 보인다.
// 'PDF로 저장'은 지금 거래 유형의 두 목록을 인쇄 창으로 보낸다(머리 줄과 필터 칸은 빠진다).

const emit = defineEmits<{ goto: [tab: CheckGoto] }>();

const KEY = { list: 'hnw-checklist-list', deal: 'hnw-checklist-deal', kind: 'hnw-checklist-kind', checks: 'hnw-checklist-checks' };
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 기억만 못 함 */
  }
}
/** 저장된 값이 고를 수 있는 것 중 하나면 그 값, 아니면 처음 것 */
function saved<T extends string>(key: string, choices: readonly { id: T }[]): T {
  const v = read(key);
  return choices.find((c) => c.id === v)?.id ?? choices[0].id;
}
/** 목록과 거래 유형마다 체크한 항목 id('house:jeonse' → ['pressure', …]) */
function loadChecks(): Record<string, string[]> {
  try {
    const v = JSON.parse(read(KEY.checks) ?? '{}') as unknown;
    if (!v || typeof v !== 'object') return {};
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, ids]) => Array.isArray(ids))
        .map(([k, ids]) => [k, (ids as unknown[]).filter((x): x is string => typeof x === 'string')]),
    );
  } catch {
    return {};
  }
}

/** 거래 유형 고르기: 전체(모든 항목, 항목마다 거래 유형 라벨)와 CHECK_DEALS */
type DealPick = CheckDeal | 'all';
const DEAL_PICKS: { id: DealPick; name: string; title: string }[] = [
  { id: 'all', name: '전체', title: '모든 거래 유형의 항목을 보이고, 항목마다 해당 거래 유형 라벨을 붙입니다' },
  ...CHECK_DEALS,
];

const list = ref<CheckList>(saved(KEY.list, CHECK_LISTS));
const deal = ref<DealPick>(saved(KEY.deal, DEAL_PICKS));
const savedKind = read(KEY.kind);
const kind = ref<CheckKind | 'all'>(CHECK_KINDS.some((k) => k.id === savedKind) ? (savedKind as CheckKind) : 'all');
const checks = ref(loadChecks());
watch(list, (v) => write(KEY.list, v));
watch(deal, (v) => write(KEY.deal, v));
watch(kind, (v) => write(KEY.kind, v));
watch(checks, (v) => write(KEY.checks, JSON.stringify(v)), { deep: true });

const LIST_OF = new Map(CHECK_PLACES.map((p) => [p.id, p.list]));
const KIND_NAME = new Map(CHECK_KINDS.map((k) => [k.id, k.name]));
const inKind = (it: CheckItem) => kind.value === 'all' || !it.kinds || it.kinds.includes(kind.value);
const itemsOf = (l: CheckList, d: DealPick) =>
  CHECK_ITEMS.filter((it) => LIST_OF.get(it.place) === l && (d === 'all' || it.deals.includes(d)) && inKind(it));

const items = computed(() => itemsOf(list.value, deal.value));
/** 목록의 칸마다 지금 거래 유형과 집 종류에 보일 항목(빈 칸은 뺌). no는 목록 맨 위부터 이어지는 번호(1부터). */
const placesOf = (l: CheckList) => {
  const its = itemsOf(l, deal.value);
  let no = 0;
  return CHECK_PLACES.filter((p) => p.list === l)
    .map((p) => ({ ...p, items: its.filter((it) => it.place === p.id).map((it) => ({ ...it, no: ++no })) }))
    .filter((p) => p.items.length);
};
const places = computed(() => placesOf(list.value));
const checkKey = computed(() => `${list.value}:${deal.value}`);
const done = computed(() => new Set(checks.value[checkKey.value] ?? []));
const doneIn = (l: CheckList) => new Set(checks.value[`${l}:${deal.value}`] ?? []);
const doneOf = (its: CheckItem[]) => its.filter((it) => done.value.has(it.id)).length;
const doneCount = computed(() => doneOf(items.value));

function toggle(id: string) {
  const now = new Set(done.value);
  if (now.has(id)) now.delete(id);
  else now.add(id);
  checks.value = { ...checks.value, [checkKey.value]: [...now] };
}
function clearChecks() {
  checks.value = Object.fromEntries(Object.entries(checks.value).filter(([k]) => k !== checkKey.value));
}

/** 항목 이름 옆 이름표: 집 종류를 '모든 집'으로 볼 때의 종류, 층이나 자리 조건 */
const chipsOf = (it: CheckItem) => [
  ...(kind.value === 'all' && it.kinds ? it.kinds.map((k) => KIND_NAME.get(k) ?? k) : []),
  ...(it.tag ? [it.tag] : []),
];
/** 전체로 볼 때 항목 이름 옆에 붙는 거래 유형 라벨(CHECK_DEALS 순서) */
const dealsOf = (it: CheckItem) => (deal.value === 'all' ? CHECK_DEALS.filter((d) => it.deals.includes(d.id)) : []);
const dealName = computed(() => DEAL_PICKS.find((d) => d.id === deal.value)?.name ?? '');
const kindName = computed(() => (kind.value === 'all' ? '' : KIND_NAME.get(kind.value) ?? ''));
const showCalc = computed(() => list.value === 'contract' && (deal.value === 'jeonse' || deal.value === 'all'));
const dot = (iso: string) => iso.replace(/-/g, '.');

/** 특약 문구 복사(key는 '항목 id-순번'). 클립보드를 못 쓰면 문구를 선택해 두어 Ctrl+C로 복사하게 한다. */
const copied = ref<{ key: string; ok: boolean } | null>(null);
let copiedTimer: number | undefined;
async function copyClause(key: string, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = { key, ok: true };
  } catch {
    const el = document.getElementById(`clause-${key}`);
    if (el) window.getSelection()?.selectAllChildren(el);
    copied.value = { key, ok: false };
  }
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => (copied.value = null), 2500);
}
const copyLabel = (key: string, idle = '복사') => (copied.value?.key !== key ? idle : copied.value.ok ? '복사함' : '선택함, Ctrl+C');
/** '전부 복사' 문장: 문구마다 1., 2. 번호를 붙여 줄을 바꾼다 */
const allClauses = (it: CheckItem) => (it.clauses ?? []).map((c, i) => `${i + 1}. ${c.text}`).join('\n');
onBeforeUnmount(() => window.clearTimeout(copiedTimer));

/** 지금 거래 유형의 두 목록을 인쇄 창으로 보낸다. 창 제목이 PDF 파일 이름이 되도록 잠깐 바꾼다. */
function savePdf() {
  const before = document.title;
  document.title = ['체크리스트', dealName.value, kindName.value].filter(Boolean).join(' ');
  const restore = () => {
    document.title = before;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}
</script>

<template>
  <section class="checklist">
    <div class="check-head">
      <h2 class="check-title">체크리스트</h2>
      <span class="muted checked" title="법과 제도가 든 항목은 법령, 공공기관 안내, 판례를 이날 기준으로 확인해 손으로 정리했습니다. 계약 판단은 원문과 전문가로 확인하세요.">{{ dot(CHECKLIST_CHECKED) }} 확인</span>
      <span class="tally num no-print" :class="{ full: doneCount === items.length && items.length }">체크 {{ doneCount }}/{{ items.length }}</span>
      <button v-if="doneCount" type="button" class="linkish no-print" title="지금 목록과 거래 유형의 체크만 지웁니다" @click="clearChecks">체크 지우기</button>
      <button
        type="button" class="btn btn-sm no-print save-pdf"
        :title="`${deal === 'all' ? '모든 거래 유형' : dealName}의 집 하자와 계약 전 목록을 한 파일로 뽑습니다(설명 포함, 체크한 것은 ☑). 인쇄 창의 대상에서 'PDF로 저장'을 고르면 PDF가 되고, 그 파일을 휴대폰으로 옮겨 집을 보면서 씁니다.`"
        @click="savePdf"
      >PDF로 저장</button>
      <p class="print-only print-line">{{ dealName }}<template v-if="kindName">, {{ kindName }}</template></p>
    </div>

    <div class="lists no-print" role="group" aria-label="목록">
      <button
        v-for="l in CHECK_LISTS" :key="l.id" type="button" class="list-pick" :aria-pressed="list === l.id" :title="l.title"
        @click="list = l.id"
      >{{ l.name }} <span class="num">{{ itemsOf(l.id, deal).length }}</span></button>
    </div>
    <div class="bar no-print">
      <div class="picks" role="group" aria-label="거래 유형">
        <button v-for="d in DEAL_PICKS" :key="d.id" type="button" :aria-pressed="deal === d.id" :title="d.title" @click="deal = d.id">
          {{ d.name }} <span class="num">{{ itemsOf(list, d.id).length }}</span>
        </button>
      </div>
      <div class="kinds" role="group" aria-label="집 종류">
        <button type="button" :aria-pressed="kind === 'all'" title="모든 집의 항목을 보이고, 한 종류에만 해당하는 항목에는 그 종류 이름표를 붙입니다" @click="kind = 'all'">모든 집</button>
        <button v-for="k in CHECK_KINDS" :key="k.id" type="button" :aria-pressed="kind === k.id" :title="k.title" @click="kind = k.id">{{ k.name }}</button>
      </div>
    </div>
    <div class="places no-print">
      <template v-for="p in places" :key="p.id">
      <section class="place">
        <h3 class="place-name">{{ p.name }} <span class="muted num">{{ doneOf(p.items) }}/{{ p.items.length }}</span></h3>
        <ol class="items">
          <li v-for="it in p.items" :key="it.id" class="item" :class="{ done: done.has(it.id) }">
            <label class="item-main">
              <span class="no num">{{ it.no }}</span>
              <input type="checkbox" :checked="done.has(it.id)" @change="toggle(it.id)" />
              <span class="item-text">
                <span class="item-name">
                  <CountTooltip v-if="it.why" :text="it.why" :max-width="400" :focusable="false"><span class="has-why">{{ it.name }}</span></CountTooltip>
                  <template v-else>{{ it.name }}</template>
                  <button
                    v-for="d in dealsOf(it)" :key="d.id" type="button" class="deal-tag" :class="d.id"
                    :title="`${d.title}. 누르면 ${d.name}만 보기`" @click.prevent="deal = d.id"
                  >{{ d.name }}</button>
                  <span v-for="c in chipsOf(it)" :key="c" class="chip chip-muted item-chip">{{ c }}</span>
                </span>
                <span class="item-how">{{ it.how }}</span>
              </span>
            </label>
            <div v-if="it.steps?.length" class="item-block">
              <p class="block-title">{{ it.stepsTitle ?? '순서' }}</p>
              <ol class="item-steps">
                <li v-for="(s, i) in it.steps" :key="i">
                  <span class="step-body">{{ s.text }}<template v-for="l in s.links ?? []" :key="l.url">{{ ' ' }}<a class="step-link" :href="l.url" target="_blank" rel="noopener">{{ l.label }} ↗</a></template></span>
                </li>
              </ol>
            </div>
            <div v-if="it.clauses?.length" class="item-block">
              <div class="block-head">
                <p class="block-title" title="공식 예문이 아니라 이 항목 내용을 계약서 문장으로 정리한 예시입니다. 옮겨 쓸 때 날짜와 금액을 계약에 맞춥니다.">특약 문구 예</p>
                <button v-if="it.clauses.length > 1" type="button" class="btn btn-sm" :aria-label="`${it.name} 특약 문구 전부 복사`" title="문구마다 번호를 붙여 한 번에 복사합니다" @click="copyClause(`${it.id}-all`, allClauses(it))">{{ copyLabel(`${it.id}-all`, '전부 복사') }}</button>
              </div>
              <ul :id="`clause-${it.id}-all`" class="clauses">
                <li v-for="(c, i) in it.clauses" :key="c.name" class="clause">
                  <div class="clause-head">
                    <span class="clause-name">{{ c.name }}</span>
                    <button type="button" class="btn btn-sm" :aria-label="`${c.name} 특약 문구 복사`" @click="copyClause(`${it.id}-${i}`, c.text)">{{ copyLabel(`${it.id}-${i}`) }}</button>
                  </div>
                  <p :id="`clause-${it.id}-${i}`" class="clause-text">{{ c.text }}</p>
                </li>
              </ul>
            </div>
            <div v-if="it.providers?.length" class="item-block">
              <p class="block-title">상품 예시</p>
              <div class="providers">
                <article v-for="pv in it.providers" :key="pv.name" class="provider">
                  <h4 class="provider-name">{{ pv.name }}</h4>
                  <dl class="provider-facts">
                    <template v-for="[k, v] in pv.facts" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
                  </dl>
                  <p v-if="pv.note" class="provider-note">{{ pv.note }}</p>
                  <div v-if="pv.links?.length" class="provider-links">
                    <a v-for="l in pv.links" :key="l.url" :href="l.url" target="_blank" rel="noopener">{{ l.label }} ↗</a>
                  </div>
                </article>
              </div>
            </div>
            <div v-if="it.goto || it.sources?.length" class="item-links no-print">
              <button v-if="it.goto" type="button" class="linkish" @click="emit('goto', it.goto.tab)">{{ it.goto.label }}</button>
              <details v-if="it.sources?.length" class="srcs">
                <summary>근거 {{ it.sources.length }}</summary>
                <span class="src-list">
                  <a v-for="s in it.sources" :key="s.url + s.title" :href="s.url" target="_blank" rel="noopener">{{ s.title }}<span v-if="s.date" class="src-date">{{ dot(s.date) }}</span> ↗</a>
                </span>
              </details>
            </div>
          </li>
        </ol>
      </section>
      <div v-if="showCalc && p.id === 'money'" class="calc-wrap"><GuaranteeCalc /></div>
      </template>
    </div>

    <div class="print-only print-all">
      <section v-for="l in CHECK_LISTS" :key="l.id" class="print-list">
        <h3 class="print-list-name">{{ l.name }}</h3>
        <div v-for="p in placesOf(l.id)" :key="p.id" class="print-place">
          <h4>{{ p.name }}</h4>
          <ul>
            <li v-for="it in p.items" :key="it.id">
              <span class="box">{{ doneIn(l.id).has(it.id) ? '☑' : '☐' }}</span>
              <span class="print-text">
                <b>{{ it.no }}. {{ it.name }}</b><template v-if="dealsOf(it).length"> [{{ dealsOf(it).map((d) => d.name).join(', ') }}]</template><template v-for="c in chipsOf(it)" :key="c"> ({{ c }})</template> {{ it.how }}
                <template v-if="it.steps?.length">
                  <span class="print-sub">{{ it.stepsTitle ?? '순서' }}</span>
                  <ol class="print-steps">
                    <li v-for="(s, i) in it.steps" :key="i">{{ s.text }}<a v-for="l in s.links ?? []" :key="l.url" :href="l.url"> {{ l.label }}</a></li>
                  </ol>
                </template>
                <template v-if="it.clauses?.length">
                  <span class="print-sub">특약 문구 예</span>
                  <ul class="print-steps">
                    <li v-for="c in it.clauses" :key="c.name"><b>{{ c.name }}:</b> {{ c.text }}</li>
                  </ul>
                </template>
                <template v-if="it.providers?.length">
                  <span class="print-sub">상품 예시</span>
                  <ul class="print-steps">
                    <li v-for="pv in it.providers" :key="pv.name">
                      <b>{{ pv.name }}</b><template v-for="[k, v] in pv.facts" :key="k"> {{ k }}: {{ v }}.</template><template v-if="pv.note"> {{ pv.note }}</template><a v-for="l in pv.links ?? []" :key="l.url" :href="l.url"> {{ l.label }}</a>
                    </li>
                  </ul>
                </template>
                <span v-if="it.why" class="print-why">{{ it.why }}</span>
              </span>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.checklist { display: grid; gap: 12px; min-width: 0; }
.check-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
.check-title { margin: 0; font-size: 21px; font-weight: 700; }
.checked { font-size: 13px; cursor: help; }
.tally { font-size: 14px; font-weight: 700; color: var(--ink-2); }
.tally.full { color: var(--down); }
.save-pdf { margin-left: auto; }
.linkish {
  padding: 0; border: 0; background: none; font: inherit; font-size: 13px; color: var(--muted); cursor: pointer;
  text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px;
}
.linkish:hover { color: var(--ink); }

.lists { display: flex; gap: 0; border-bottom: 1px solid var(--line); }
.list-pick {
  min-height: 40px; margin-bottom: -1px; padding: 0 18px; border: 1px solid transparent; border-radius: 8px 8px 0 0;
  background: none; font-size: 15px; font-weight: 700; color: var(--muted);
}
.list-pick:hover { background: var(--surface-2); color: var(--ink-2); }
.list-pick[aria-pressed='true'] { border-color: var(--line); border-bottom-color: var(--paper); background: var(--paper); color: var(--ink); }
.list-pick .num { margin-left: 2px; font-weight: 500; color: var(--muted); }

.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.picks, .kinds { display: flex; flex-wrap: wrap; gap: 4px; }
.picks button, .kinds button {
  min-height: 34px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface);
  font-size: 13px; font-weight: 700; color: var(--ink-2);
}
.picks button .num { margin-left: 2px; font-weight: 500; color: var(--muted); }
.picks button[aria-pressed='true'] { background: var(--ink); border-color: var(--ink); color: #fff; }
.picks button[aria-pressed='true'] .num { color: #cfdef1; }
.kinds button { min-height: 30px; padding: 0 10px; border-color: var(--line); font-weight: 600; color: var(--muted); }
.kinds button[aria-pressed='true'] { border-color: var(--ink-2); background: var(--surface-2); color: var(--ink); }
.print-only { display: none; }

.places {
  display: grid; max-width: 920px; min-width: 0; padding: 0 18px 10px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
}
.place { min-width: 0; }
.place-name {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  margin: 18px 0 0; padding-bottom: 6px; border-bottom: 1px solid var(--line-strong); font-size: 15px;
}
.place:first-child .place-name { margin-top: 12px; }
.place-name .num { font-size: 12px; font-weight: 500; }
.items { display: grid; margin: 0; padding: 0; list-style: none; }
.item { display: grid; gap: 2px; padding: 8px 0; border-top: 1px solid var(--line); }
.item:first-child { border-top: 0; }
.item-main { display: grid; grid-template-columns: 26px 20px minmax(0, 1fr); align-items: start; gap: 2px 6px; cursor: pointer; }
.no { padding-top: 1px; font-size: 13px; font-weight: 700; color: var(--muted); text-align: right; }
.item-main input { width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--down); cursor: pointer; }
.item-text { display: grid; gap: 1px; min-width: 0; }
.item-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; font-size: 14px; font-weight: 700; color: var(--ink); }
.has-why { text-decoration: underline dotted var(--muted); text-underline-offset: 4px; }
.item-chip { font-size: 11px; padding: 0 6px; font-weight: 600; }
.deal-tag {
  min-height: 20px; padding: 0 7px; border: 0; border-radius: 5px;
  font-size: 11px; font-weight: 700; line-height: 20px; cursor: pointer;
}
.deal-tag:hover { text-decoration: underline; text-underline-offset: 3px; }
.deal-tag.jeonse { background: #e1f2ef; color: #0f7a6c; }
.deal-tag.monthly { background: #ece8fa; color: #5b3cc4; }
.deal-tag.buy { background: #e8f0fb; color: #1f5fbf; }
.deal-tag.auction { background: #fbece2; color: #b3541e; }
.item-how { font-size: 13px; line-height: 1.55; color: var(--ink-2); }
.item.done .item-name, .item.done .item-how { color: var(--muted); }
.item.done .item-name > :first-child { text-decoration: line-through; text-decoration-color: var(--line-strong); }
.item-block { display: grid; gap: 4px; margin: 6px 0 2px 58px; }
.block-title { margin: 0; font-size: 12px; font-weight: 700; color: var(--muted); }
.item-steps {
  display: grid; gap: 5px; margin: 0; padding: 8px 12px 8px 4px; border-radius: 8px; background: var(--surface-2);
  list-style: none; counter-reset: step; font-size: 13px; line-height: 1.55; color: var(--ink-2);
}
.item-steps li { display: flex; gap: 6px; counter-increment: step; }
.item-steps li::before { flex: 0 0 22px; content: counter(step) ')'; font-weight: 700; color: var(--muted); text-align: right; }
.step-body { flex: 1; min-width: 0; }
.step-link { margin-left: 4px; color: var(--accent); text-decoration: none; white-space: nowrap; }
.step-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.block-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.clauses { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.clause { padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.clause-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.clause-name { font-size: 13px; font-weight: 700; color: var(--ink-2); }
.clause-text { margin: 6px 0 0; padding-left: 10px; border-left: 3px solid var(--accent-soft); font-size: 13px; line-height: 1.6; color: var(--ink); }
.providers { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr)); }
.provider { display: grid; align-content: start; gap: 6px; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.provider-name { margin: 0; font-size: 13.5px; }
.provider-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 10px; margin: 0; font-size: 12.5px; line-height: 1.5; }
.provider-facts dt { color: var(--muted); white-space: nowrap; }
.provider-facts dd { margin: 0; color: var(--ink-2); }
.provider-note { margin: 0; font-size: 12px; color: var(--muted); }
.provider-links { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 12px; }
.provider-links a { color: var(--accent); text-decoration: none; }
.provider-links a:hover { text-decoration: underline; text-underline-offset: 3px; }
.item-links { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; padding-left: 58px; font-size: 12px; }
@media (max-width: 560px) {
  .places { padding: 0 12px 8px; }
  .item-block { margin-left: 0; }
  .item-links { padding-left: 32px; }
}
.item-links .linkish { font-size: 12px; color: var(--accent); text-decoration-color: currentColor; }
.srcs summary { color: var(--muted); cursor: pointer; list-style: none; }
.srcs summary::-webkit-details-marker { display: none; }
.srcs summary::after { content: ' ▸'; }
.srcs[open] summary::after { content: ' ▾'; }
.srcs summary:hover { color: var(--ink); }
.src-list { display: grid; gap: 1px; padding: 3px 0 2px; }
.src-list a { color: var(--accent); text-decoration: none; }
.src-list a:hover { text-decoration: underline; text-underline-offset: 3px; }
.src-date { margin-left: 5px; color: var(--muted); }
.calc-wrap { min-width: 0; margin: 12px 0 2px; }
.calc-wrap :deep(.calc) { margin-top: 0; border-radius: var(--radius); }
</style>

<style>
/*
 * 인쇄(PDF로 저장): 체크리스트 탭을 열어 둔 채 인쇄하면 머리 줄, 필터 칸, 알림 같은 화면 틀과 화면용 목록을 빼고,
 * 지금 거래 유형의 두 목록(print-all)을 설명까지 붙여 뽑는다. 계약 전 목록은 새 쪽에서 시작한다.
 */
@media print {
  @page { margin: 12mm; }
  body:has(.checklist) .top,
  body:has(.checklist) .side,
  body:has(.checklist) .browse-queue,
  body:has(.checklist) .progress,
  body:has(.checklist) .livelog,
  body:has(.checklist) .toasts,
  body:has(.checklist) .error,
  body:has(.checklist) .no-print { display: none !important; }
  body:has(.checklist) .layout { display: block; padding: 0; }
  body:has(.checklist) { background: #fff; }
  .checklist .print-only { display: block !important; }
  .checklist .print-line { margin: 0; font-size: 15px; font-weight: 700; }
  .checklist .print-list + .print-list { break-before: page; }
  .checklist .print-list-name { margin: 6px 0 2px; font-size: 18px; }
  .checklist .print-place { break-inside: avoid; margin: 0 0 6px; }
  .checklist .print-place h4 { margin: 10px 0 2px; padding-bottom: 2px; border-bottom: 1px solid #888; font-size: 14px; }
  .checklist .print-place ul { margin: 0; padding: 0; list-style: none; }
  .checklist .print-place li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 4px; padding: 3px 0; font-size: 11.5px; line-height: 1.5; break-inside: avoid; }
  .checklist .print-place .box { font-size: 13px; line-height: 1.3; }
  .checklist .print-why { display: block; color: #555; font-size: 10.5px; white-space: pre-line; }
  .checklist .print-sub { display: block; margin-top: 2px; font-size: 10.5px; font-weight: 700; color: #555; }
  .checklist .print-steps { margin: 2px 0; padding-left: 18px; }
  .checklist .print-steps li { display: list-item; padding: 0; font-size: 11px; }
  .checklist .print-steps a { color: #1f5fbf; }
}
</style>
