<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import {
  GUARD_CHECK_SOURCES, GUARD_CHECK_STEPS, LOAN_CLAUSES, LOAN_DEPOSIT_NOTES, LOAN_HOWTO_SOURCES, LOAN_STEPS, POLICY_LOANS,
  SUPPORT_CHECKED, SUPPORT_LINKS, SUPPORT_PROGRAMS, SUPPORT_SECTIONS, SUPPORT_STEPS, SUPPORT_TOOLS,
  type SupportProgram, type SupportSectionId, type Unless,
} from '../support';
import { manwon } from '../format';
import { cannotGet, profile } from '../profile';
import CountTooltip from './CountTooltip.vue';
import GuaranteeCalc from './GuaranteeCalc.vue';
import SupportSteps from './SupportSteps.vue';

// 지원 제도 탭: 전세 대출, 전세보증금 반환보증(보증보험), 월세 지원 같은 국가, 서울시 제도와 계약 전 확인 도구를 칸별로 정리해 보인다.
// 모으는 데이터가 아니라 조사한 날(SUPPORT_CHECKED) 기준으로 손으로 정리한 표다(web/src/support.ts). 그래서 조사한 날과 근거를 같이 보인다.

const emit = defineEmits<{ notices: [] }>();

/** 고른 칸은 다음에 열어도 그대로 */
const saved = localStorage.getItem('hnw-support-section') as SupportSectionId | null;
const section = ref<SupportSectionId>(saved && SUPPORT_SECTIONS.some((s) => s.id === saved) ? saved : 'loan');
watch(section, (s) => localStorage.setItem('hnw-support-section', s));
const current = computed(() => SUPPORT_SECTIONS.find((s) => s.id === section.value) ?? SUPPORT_SECTIONS[0]);

/** 내 조건(설정 탭의 연소득과 가구)으로 받을 수 없는 제도는 표와 카드에서 뺀다. */
const hidden = computed(() => SUPPORT_PROGRAMS.filter((p) => cannotGet(p.id)));
const shown = computed(() => SUPPORT_PROGRAMS.filter((p) => !cannotGet(p.id)));
const hiddenTip = computed(() =>
  [
    `연소득 ${manwon(profile.value.income ?? 0)} 기준으로 받을 수 없는 제도를 뺐습니다: ${hidden.value.map((p) => p.name).join(', ')}`,
    '설정 탭 내 조건에서 바꿉니다.',
  ].join('\n'),
);
/** unless의 제도를 모두 못 받으면 그 대신 보일 글(빈 글이면 그 글을 뺌) */
const pick = <T extends { text: string; unless?: Unless }>(x: T): T =>
  x.unless && x.unless.ids.every((id) => cannotGet(id))
    ? { ...x, text: x.unless.text, ...(x.unless.title ? { title: x.unless.title } : {}), ...(x.unless.links ? { links: x.unless.links } : {}) }
    : x;
const steps = computed(() => SUPPORT_STEPS.map(pick));
const loanSteps = computed(() => LOAN_STEPS.map(pick));
const depositNotes = computed(() => LOAN_DEPOSIT_NOTES.map(pick).filter((n) => n.text));
const intro = computed(() => pick({ text: current.value.intro, unless: current.value.unless }).text);
/** 정책 전세대출을 모두 못 받으면 '대출 받는 순서'는 은행 전세대출 기준 */
const noPolicy = computed(() => POLICY_LOANS.every((id) => cannotGet(id)));

const programs = computed(() => shown.value.filter((p) => p.section === section.value));
const countOf = (id: SupportSectionId) => (id === 'check' ? SUPPORT_TOOLS.length : shown.value.filter((p) => p.section === id).length);
/** 비교 표 칸(이 칸에서 쓰는 것만) */
const columns = computed(() => current.value.columns ?? []);

/** '2026-10-16' → '2026.10.16' */
const dot = (iso: string) => iso.replace(/^(\d{4})-0?(\d{1,2})-0?(\d{1,2})$/, '$1.$2.$3');

/** 펼친 제도 카드. 비교 표에서 이름을 누르면 그 카드를 펼치고 그리로 간다. */
const opened = ref(new Set<string>());
function onToggle(id: string, e: Event) {
  const next = new Set(opened.value);
  if ((e.target as HTMLDetailsElement).open) next.add(id);
  else next.delete(id);
  opened.value = next;
}
async function reveal(p: SupportProgram) {
  opened.value = new Set(opened.value).add(p.id);
  await nextTick();
  document.getElementById(`support-${p.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
async function pickSection(id: SupportSectionId) {
  section.value = id;
  await nextTick();
  document.getElementById('support-sections')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

const STATUS_CLASS: Record<SupportProgram['status'], string> = { open: '', now: 'chip-near', period: 'chip-muted', closed: 'chip-muted', check: 'chip-warn' };

/** 칸 맨 위 순서 블록의 열림 상태. 처음에는 펼쳐 두고, 접으면 다음에도 접힌 채로 연다. */
function foldMemory(key: string) {
  const open = ref(localStorage.getItem(key) !== 'closed');
  const onToggle = (e: Event) => {
    open.value = (e.target as HTMLDetailsElement).open;
    localStorage.setItem(key, open.value ? 'open' : 'closed');
  };
  return { open, onToggle };
}
/** 전세 대출 칸의 '대출 받는 순서' */
const loanHowto = foldMemory('hnw-support-howto');
/** 보증보험 칸의 '보험 되는지 먼저 확인하는 순서' */
const guardHowto = foldMemory('hnw-support-guard-check');

/** 특약 문구 복사. 클립보드를 못 쓰면 문구를 선택해 두어 Ctrl+C로 복사하게 한다. */
const copied = ref<{ id: string; ok: boolean } | null>(null);
let copiedTimer: number | undefined;
async function copyClause(id: string, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = { id, ok: true };
  } catch {
    const el = document.getElementById(`clause-${id}`);
    if (el) window.getSelection()?.selectAllChildren(el);
    copied.value = { id, ok: false };
  }
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => (copied.value = null), 2500);
}
const copyLabel = (id: string) => (copied.value?.id !== id ? '복사' : copied.value.ok ? '복사함' : '선택함, Ctrl+C');
onBeforeUnmount(() => window.clearTimeout(copiedTimer));
</script>

<template>
  <section class="support">
    <div class="head">
      <strong class="total">지원 제도</strong>
      <span class="checked" title="조사한 날 기준입니다. 금리, 한도, 소득 기준은 해마다(때로는 몇 달 만에) 바뀌니 신청 전에 공식 안내에서 다시 확인하세요.">{{ dot(SUPPORT_CHECKED) }} 조사</span>
      <CountTooltip v-if="hidden.length" :text="hiddenTip" :max-width="460"><span class="checked">소득 기준으로 {{ hidden.length }}개 뺌</span></CountTooltip>
    </div>

    <nav class="links" aria-label="공식 안내">
      <span class="links-label">공식 안내</span>
      <a v-for="x in SUPPORT_LINKS" :key="x.url" :href="x.url" target="_blank" rel="noopener" :title="x.title">{{ x.label }} ↗</a>
    </nav>

    <ol class="steps" aria-label="전세를 구할 때 볼 순서">
      <li v-for="(s, i) in steps" :key="s.text">
        <span class="step-no num">{{ i + 1 }}</span>
        <span class="step-text">{{ s.text }}</span>
        <button v-if="s.section" class="linkish" @click="pickSection(s.section)">{{ SUPPORT_SECTIONS.find((x) => x.id === s.section)?.name }} 칸</button>
      </li>
    </ol>

    <fieldset id="support-sections" class="sections">
      <legend class="sr-only">제도 종류</legend>
      <label v-for="s in SUPPORT_SECTIONS" :key="s.id" class="kind-option" :title="s.title">
        <input v-model="section" type="radio" name="support-section" :value="s.id" />
        <span>{{ s.name }}</span><span class="kind-count num">{{ countOf(s.id) }}</span>
      </label>
    </fieldset>

    <p class="intro">{{ intro }}</p>

    <details v-if="section === 'guard'" class="fold howto" :open="guardHowto.open.value" @toggle="guardHowto.onToggle">
      <summary>
        <span class="fold-name">보험 되는지 먼저 확인하는 순서</span>
        <span class="howto-sub muted" title="집 보러 다닐 때부터 정식 가입까지 순서대로">HUG 반환보증 기준</span>
      </summary>
      <div class="fold-body">
        <SupportSteps :steps="GUARD_CHECK_STEPS" @section="pickSection" />
        <GuaranteeCalc />
        <div class="foot">
          <span class="sources">
            <span class="sources-label">근거</span>
            <a v-for="s in GUARD_CHECK_SOURCES" :key="s.url" :href="s.url" target="_blank" rel="noopener">{{ s.title }}<span v-if="s.date" class="src-date num">{{ dot(s.date) }}</span></a>
          </span>
        </div>
      </div>
    </details>

    <details v-if="section === 'loan'" class="fold howto" :open="loanHowto.open.value" @toggle="loanHowto.onToggle">
      <summary>
        <span class="fold-name">대출 받는 순서</span>
        <span class="howto-sub muted" title="계약 전에 확인할 것부터 잔금 뒤까지 순서대로">{{ noPolicy ? '은행 전세대출 기준' : '버팀목 기준' }}</span>
      </summary>
      <div class="fold-body">
        <SupportSteps :steps="loanSteps" @section="pickSection" />

        <div class="clauses">
          <div class="clauses-head">
            <strong title="예시 문구입니다. 계약 상황에 맞게 중개사와 고쳐 넣으세요.">계약서에 넣을 특약</strong>
          </div>
          <ul>
            <li v-for="c in LOAN_CLAUSES" :key="c.id" class="clause">
              <div class="clause-head">
                <span class="clause-name">{{ c.name }}</span>
                <button class="btn btn-sm" :aria-label="`${c.name} 특약 문구 복사`" @click="copyClause(c.id, c.text)">{{ copyLabel(c.id) }}</button>
              </div>
              <p :id="`clause-${c.id}`" class="clause-text">{{ c.text }}</p>
              <p class="clause-why">
                {{ c.why }}
                <a v-if="c.source" :href="c.source.url" target="_blank" rel="noopener">근거: {{ c.source.title }}<span v-if="c.source.date" class="src-date num">{{ dot(c.source.date) }}</span></a>
              </p>
            </li>
          </ul>
        </div>

        <div class="notes">
          <strong>대출이 거절되면 계약금은?</strong>
          <ul>
            <li v-for="n in depositNotes" :key="n.text">{{ n.text }}</li>
          </ul>
        </div>

        <div class="foot">
          <span class="sources">
            <span class="sources-label">근거</span>
            <a v-for="s in LOAN_HOWTO_SOURCES" :key="s.url" :href="s.url" target="_blank" rel="noopener">{{ s.title }}<span v-if="s.date" class="src-date num">{{ dot(s.date) }}</span></a>
          </span>
        </div>
      </div>
    </details>

    <template v-if="section !== 'check'">
      <div class="compare-wrap">
        <table class="compare">
          <thead>
            <tr>
              <th scope="col">제도</th>
              <th v-for="c in columns" :key="c.key" scope="col">{{ c.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in programs" :key="p.id" :class="{ off: p.status === 'closed' }">
              <th scope="row">
                <button class="name-btn" :title="`${p.name} 자세히`" @click="reveal(p)">{{ p.name }}</button>
                <span v-if="p.statusText" class="chip" :class="STATUS_CLASS[p.status]">{{ p.statusText }}</span>
              </th>
              <td v-for="c in columns" :key="c.key" :data-label="c.label" :class="{ blank: !p[c.key] || p[c.key] === '-' }">{{ p[c.key] ?? '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="cards">
        <details
          v-for="p in programs" :id="`support-${p.id}`" :key="p.id" class="fold program" :class="{ off: p.status === 'closed' }"
          :open="opened.has(p.id)" @toggle="onToggle(p.id, $event)"
        >
          <summary>
            <span class="fold-name">{{ p.name }}</span>
            <span v-if="p.statusText" class="chip" :class="STATUS_CLASS[p.status]">{{ p.statusText }}</span>
            <span class="operator muted">{{ p.operator }}</span>
            <span class="one-line">{{ p.oneLine }}</span>
          </summary>
          <div class="fold-body">
            <dl class="facts">
              <template v-for="[k, v] in p.rows" :key="k">
                <dt>{{ k }}</dt>
                <dd>{{ v }}</dd>
              </template>
            </dl>
            <div v-if="p.notes.length" class="notes">
              <strong>바뀐 것과 주의할 것</strong>
              <ul>
                <li v-for="n in p.notes" :key="n">{{ n }}</li>
              </ul>
            </div>
            <div class="foot">
              <a class="btn btn-sm" :href="p.apply.url" target="_blank" rel="noopener">{{ p.apply.label }} ↗</a>
              <span class="sources">
                <span class="sources-label">근거</span>
                <a v-for="s in p.sources" :key="s.url" :href="s.url" target="_blank" rel="noopener">{{ s.title }}<span v-if="s.date" class="src-date num">{{ dot(s.date) }}</span></a>
              </span>
            </div>
          </div>
        </details>
      </div>
    </template>

    <ul v-else class="tools">
      <li v-for="t in SUPPORT_TOOLS" :key="t.name" class="tool">
        <span class="tool-name">{{ t.name }}<span class="tool-when">{{ t.when }}</span></span>
        <span class="tool-what">
          {{ t.what }}
          <a v-if="t.source" class="tool-source" :href="t.source.url" target="_blank" rel="noopener">근거: {{ t.source.title }}<span v-if="t.source.date" class="src-date num">{{ dot(t.source.date) }}</span></a>
          <button v-if="t.toSection" class="linkish tool-more" @click="pickSection(t.toSection)">확인하는 순서와 계산기: {{ SUPPORT_SECTIONS.find((x) => x.id === t.toSection)?.name }} 칸</button>
        </span>
        <span class="tool-links">
          <a class="btn btn-sm" :href="t.url" target="_blank" rel="noopener">{{ t.urlLabel }} ↗</a>
          <a v-if="t.more" class="btn btn-sm" :href="t.more.url" target="_blank" rel="noopener">{{ t.more.label }} ↗</a>
        </span>
      </li>
    </ul>

    <p class="cross muted">
      <button class="linkish" title="HUG 든든전세, LH 전세임대, SH 장기전세처럼 공공이 직접 빌려주는 전세와 임대 주택의 모집 공고" @click="emit('notices')">공공 전세와 임대 공고: 임대 공고 탭</button>
    </p>
  </section>
</template>

<style scoped>
.support { display: grid; gap: 14px; max-width: 1180px; }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; min-height: 40px; }
.total { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; }
.checked { font-size: 13px; font-weight: 600; color: var(--muted); cursor: help; }
.links { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; min-width: 0; font-size: 13px; }
.links-label { font-size: 12px; color: var(--muted); }
.links a { color: var(--ink-2); text-decoration: none; white-space: nowrap; }
.links a:hover { text-decoration: underline; text-underline-offset: 3px; }

.steps {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px;
  margin: 0; padding: 0; list-style: none;
}
.steps li {
  display: grid; grid-template-columns: auto 1fr; align-content: start; gap: 4px 10px;
  padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); font-size: 13px;
}
.step-no {
  display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%;
  background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 700;
}
.step-text { color: var(--ink-2); line-height: 1.5; }
.steps .linkish { grid-column: 2; justify-self: start; font-size: 12px; }
.linkish {
  padding: 0; border: 0; background: none; font: inherit; color: var(--muted); cursor: pointer;
  text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px;
}
.linkish:hover { color: var(--ink); }

.sections {
  display: flex; flex-wrap: wrap; gap: 4px 16px; min-width: 0; margin: 0; padding: 4px 0 12px; border: 0; border-bottom: 1px solid var(--line);
  scroll-margin-top: calc(var(--app-header-height, 80px) + 16px);
}
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.kind-option { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; cursor: pointer; color: var(--ink-2); font-size: 14px; }
.kind-option input { width: 15px; height: 15px; margin: 0 2px 0 0; accent-color: var(--accent); }
.kind-option:has(input:checked) > span:first-of-type { font-weight: 700; color: var(--ink); }
.kind-count { color: var(--muted); font-size: 12px; }
.intro { margin: 0; font-size: 14px; color: var(--ink-2); max-width: 860px; }

/* 비교 표: 좁으면 표 안에서만 옆으로 민다(페이지는 옆으로 밀리지 않게). */
.compare-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.compare { width: 100%; min-width: 760px; border-collapse: collapse; font-size: 13px; }
.compare th, .compare td { padding: 10px 12px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; line-height: 1.5; }
.compare thead th { border-top: 0; font-size: 12px; font-weight: 600; color: var(--muted); white-space: nowrap; }
.compare tbody th { min-width: 170px; font-weight: 700; }
.compare tbody th .chip { margin-top: 4px; }
.compare td { color: var(--ink-2); }
.compare tr.off th, .compare tr.off td { color: var(--muted); }
.name-btn {
  display: block; padding: 0; border: 0; background: none; font: inherit; font-weight: 700; color: var(--ink); text-align: left; cursor: pointer;
  text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px;
}
.name-btn:hover { color: var(--accent); text-decoration-color: currentColor; }

.cards { display: grid; gap: 8px; }
.program { scroll-margin-top: calc(var(--app-header-height, 80px) + 16px); }
.program > summary { align-items: center; }
.program.off .fold-name { color: var(--muted); }
.operator { font-size: 12px; }
/* 한 줄 설명은 다음 줄로 내리고, 펼침 표시(▸)는 제목 줄 오른쪽에 남긴다. */
.one-line { order: 1; flex-basis: 100%; font-size: 13px; color: var(--ink-2); }
.facts { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 0; margin: 0; font-size: 13px; }
.facts dt, .facts dd { padding: 8px 0; border-top: 1px solid var(--line); }
.facts dt:first-of-type, .facts dd:first-of-type { border-top: 0; padding-top: 0; }
.facts dt { font-weight: 700; color: var(--ink-2); padding-right: 12px; }
.facts dd { margin: 0; color: var(--ink); white-space: pre-line; }
.notes { margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: var(--surface-2); font-size: 13px; }
.notes strong { font-size: 12px; color: var(--ink-2); }
.notes ul { margin: 4px 0 0; padding-left: 18px; color: var(--ink-2); }
.notes li + li { margin-top: 2px; }
.foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-top: 12px; }
.sources { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; min-width: 0; font-size: 12px; }
.sources-label { color: var(--muted); }
.src-date { margin-left: 5px; color: var(--muted); }
.sources a { color: var(--ink-2); text-decoration: none; overflow-wrap: anywhere; }
.sources a:hover { text-decoration: underline; text-underline-offset: 3px; }

/* 전세 대출 칸의 '대출 받는 순서': 단계, 특약 문구(복사), 계약금 안내 */
.howto { scroll-margin-top: calc(var(--app-header-height, 80px) + 16px); }
.howto > summary { align-items: baseline; }
.howto-sub { font-size: 13px; }
.clauses { display: grid; gap: 8px; margin-top: 16px; }
.clauses-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; font-size: 13px; }
.clauses-head .muted { font-size: 12px; }
.clauses ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.clause { padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.clause-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.clause-name { font-size: 13px; font-weight: 700; }
.clause-text { margin: 6px 0 0; padding-left: 10px; border-left: 3px solid var(--accent-soft); font-size: 13px; line-height: 1.6; color: var(--ink); }
.clause-why { margin: 6px 0 0; font-size: 12px; color: var(--muted); }
.clause-why a { color: var(--muted); text-decoration: none; overflow-wrap: anywhere; }
.clause-why a:hover { color: var(--ink-2); text-decoration: underline; text-underline-offset: 3px; }

.tools { list-style: none; margin: 0; padding: 4px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.tool { display: grid; grid-template-columns: 210px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 52px; padding: 8px 0; border-top: 1px solid var(--line); }
.tool:first-child { border-top: 0; }
.tool-name { display: grid; gap: 2px; font-weight: 700; font-size: 13px; }
.tool-when { font-size: 12px; font-weight: 600; color: var(--accent); }
.tool-what { font-size: 13px; color: var(--ink-2); }
.tool-source { display: block; margin-top: 4px; font-size: 12px; color: var(--muted); text-decoration: none; overflow-wrap: anywhere; }
.tool-source:hover { color: var(--ink-2); text-decoration: underline; text-underline-offset: 3px; }
.tool-links { display: grid; gap: 6px; }
.tool-more { display: block; margin-top: 4px; font-size: 12px; text-align: left; }
.cross { margin: 4px 0 0; font-size: 13px; }

@media (max-width: 720px) {
  /* 좁으면 비교 표를 제도마다 한 덩어리로 쌓는다(칸 이름은 값 앞에). */
  .compare { min-width: 0; }
  .compare thead { display: none; }
  .compare tbody, .compare tr, .compare th, .compare td { display: block; }
  .compare tr { padding: 10px 12px; border-top: 1px solid var(--line); }
  .compare tr:first-child { border-top: 0; }
  .compare tbody th, .compare td { padding: 2px 0; border-top: 0; }
  .compare tbody th { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; padding-bottom: 4px; }
  .compare tbody th .chip { margin-top: 0; }
  .compare td { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; }
  .compare td.blank { display: none; }
  .compare td::before { content: attr(data-label); font-size: 12px; font-weight: 600; color: var(--muted); }
  .facts { grid-template-columns: minmax(0, 1fr); }
  .facts dt { padding-bottom: 0; }
  .facts dd { border-top: 0; padding-top: 2px; }
  .facts dd:first-of-type { padding-top: 2px; }
  .howto-sub { order: 1; flex-basis: 100%; }
  .tool { grid-template-columns: minmax(0, 1fr) auto; }
  .tool-what { grid-column: 1 / -1; grid-row: 2; }
}
</style>
