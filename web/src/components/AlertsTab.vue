<script setup lang="ts">
import { computed, ref } from 'vue';
import { REST_CHOICES, type AlertSettings, type Area } from '../../../shared/types';
import { filterSummary, rangeText } from '../../../shared/filters';
import { manwon } from '../../../shared/format';
import { api } from '../api';
import { profile } from '../profile';
import { M2_PER_PYEONG } from '../format';
import { LOAN_RATE, LOAN_RATIO } from '../rentRate';

// 설정 탭: 조회 방식(창 띄우기, 자동 확인 요일과 시각)과 조회가 끝나면 띄울 알림. 바꾸면 바로 저장한다. 금액은 만원, 빈칸은 제한 없음.
// 전월세 줄과 매매 목적 줄은 알림이 따로 뜬다. 조회 방식은 App이 저장한다(visible, autoTime, autoDay 이벤트).
// 월세, 전세, 단기, 매매 줄은 서버가 매물 탭 필터를 받았으면(settings.homeFilter) 켜기만 고르고 조건은 그 필터를 보여 준다.
const props = defineProps<{
  settings: AlertSettings;
  /** 지역 전체(필터에서 고른 지역 이름을 찾는 데 씀) */
  areas: Area[];
  /** 브라우저 창 띄워서 보면서 조회 */
  visible: boolean;
  /** 자동 확인 시각('HH:MM', 끔이면 null)과 고를 수 있는 시각 */
  autoTime: string | null;
  autoTimes: string[];
  /** 자동 확인 요일(0 일요일 ~ 6 토요일, 매일이면 null) */
  autoDay: number | null;
  /** 공고 확인 시각(매일, 끔이면 null) */
  noticeTime: string | null;
  /** 조회 중이면 창 띄우기를 못 바꾼다 */
  running: boolean;
  /** 조회할 때 역, 지역, 구 사이에 쉬는 시간(초) */
  restSeconds: number;
}>();
const emit = defineEmits<{ changed: []; visible: [boolean]; autoTime: [string]; autoDay: [number | null]; noticeTime: [string] }>();

/** 요일 고르기 순서(월요일부터): 값과 이름 */
const AUTO_DAYS = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: d, name: `매주 ${'일월화수목금토'[d]}요일` }));

const error = ref<string | null>(null);

async function setRest(event: Event) {
  error.value = null;
  try {
    await api.setRestSeconds(Number((event.target as HTMLSelectElement).value));
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

type AmountRow = 'monthly' | 'jeonse' | 'short' | 'sale' | 'rooms' | 'auction' | 'aptAuction' | 'shopAuction' | 'landAuction';
type Flag = 'rentNotices' | 'trustNotices' | 'subscriptions' | 'shopNotices' | 'landNotices' | 'priceChanges' | 'failures' | 'insideAreas' | 'captureSites';
type Group = 'rent' | 'buy' | 'common';

/** 매물 줄: 켜기와 상한 칸(key는 그 줄 설정의 값 이름). unit '평'은 평으로 넣고 보이지만 설정에는 ㎡로 저장한다. 없으면 만원. */
const AMOUNT_ROWS: { row: AmountRow; name: string; group: Group; title?: string; fields: { key: string; label: string; step: number; unit?: '평' }[] }[] = [
  { row: 'monthly', name: '월세', group: 'rent', fields: [{ key: 'monthlyMax', label: '월세', step: 5 }, { key: 'depositMax', label: '보증금', step: 100 }] },
  { row: 'jeonse', name: '전세', group: 'rent', fields: [{ key: 'depositMax', label: '전세금', step: 1000 }] },
  { row: 'short', name: '단기', group: 'rent', fields: [{ key: 'monthlyMax', label: '월세', step: 5 }] },
  { row: 'rooms', name: '고시원과 쉐어', group: 'rent', fields: [{ key: 'monthlyMax', label: '가장 싼 방 월세', step: 5 }] },
  { row: 'sale', name: '매매', group: 'buy', fields: [{ key: 'priceMax', label: '매매가', step: 1000 }] },
  { row: 'auction', name: '경매', group: 'buy', fields: [{ key: 'priceMax', label: '최저가', step: 1000 }] },
  {
    row: 'aptAuction', name: '서울 아파트 경매', group: 'buy', title: '서울 아파트 탭에서 고른 구의 아파트 경매와 공매. 지역 반경과 상관없이 셉니다',
    fields: [{ key: 'priceMax', label: '최저가', step: 1000 }],
  },
  {
    row: 'shopAuction', name: '상가 경매', group: 'buy',
    fields: [{ key: 'priceMax', label: '최저가', step: 1000 }, { key: 'areaMax', label: '면적', step: 1, unit: '평' }],
  },
  {
    row: 'landAuction', name: '토지 경매', group: 'buy',
    fields: [{ key: 'priceMax', label: '최저가', step: 1000 }, { key: 'areaMax', label: '면적', step: 1, unit: '평' }],
  },
];

/** 켜기만 있는 줄 */
const FLAGS: { key: Flag; name: string; group: Group; title?: string }[] = [
  { key: 'rentNotices', name: '임대 공고', group: 'rent', title: '켜 둔 지역 근처 구의 공고만 셉니다' },
  { key: 'trustNotices', name: '공매 공고', group: 'buy' },
  { key: 'subscriptions', name: '청약', group: 'buy' },
  { key: 'shopNotices', name: '상가 공고', group: 'buy', title: 'LH 상가 공고와 선착순 상가 중 켜 둔 지역 근처 구의 것만 셉니다(구를 모르면 셈)' },
  { key: 'landNotices', name: '토지 공고', group: 'buy', title: 'LH 토지 공고와 선착순 토지 중 켜 둔 지역 근처 구의 것만 셉니다(구를 모르면 셈)' },
  { key: 'priceChanges', name: '가격 변동', group: 'common', title: '바뀐 가격이 위에서 켠 조건에 맞는 매물만 셉니다' },
  { key: 'failures', name: '수집 실패', group: 'common' },
  { key: 'insideAreas', name: '경매와 고시원은 반경 안만', group: 'common', title: '경매, 고시원과 쉐어는 켜 둔 지역 반경 안만 셉니다. 월세, 전세, 단기, 매매는 매물 탭 필터의 지역 조건을 씁니다' },
  {
    key: 'captureSites', name: '직접 보는 사이트', group: 'common',
    title: '바탕 화면 아이콘이나 한 번에 열기로 연 사이트에서 다방 새 방(위 매물 조건에 맞는 것), 직방 새 방, KB와 네이버의 늘어난 매물 수를 알림 하나로 띄웁니다',
  },
];

const GROUPS: { id: Group; name: string; title: string }[] = [
  { id: 'rent', name: '전월세', title: '여기 줄은 알림 하나로 묶어 띄웁니다' },
  { id: 'buy', name: '매매 목적', title: '여기 줄은 따로 알림 하나로 띄웁니다' },
  { id: 'common', name: '공통', title: '두 알림 모두에 씁니다' },
];

/** 매물 탭 필터로 고르는 줄 */
const HOME_ROWS: AmountRow[] = ['monthly', 'jeonse', 'short', 'sale'];
const byFilter = (row: AmountRow) => !!props.settings.homeFilter && HOME_ROWS.includes(row);

/** 매물 조건 줄에 보일 필터 조건(금액 칸은 줄마다 따로 보임) */
const filterText = computed(() => {
  const f = props.settings.homeFilter;
  if (!f) return '아직 못 받음';
  return filterSummary(f, props.areas, false).join(', ') || '금액 말고는 조건 없음';
});

/** 거래 유형 줄에 보일 필터 금액 조건 */
function filterAmountText(row: AmountRow): string {
  const f = props.settings.homeFilter!;
  const parts =
    row === 'jeonse'
      ? [rangeText('전세금', f.depositMin, f.depositMax, manwon)]
      : row === 'sale'
        ? [rangeText('매매가', f.priceMin, f.priceMax, manwon)]
        : [rangeText('보증금', f.depositMin, f.depositMax, manwon), rangeText('월세', f.monthlyMin, f.monthlyMax, manwon)];
  return parts.filter(Boolean).join(', ') || '금액 제한 없음';
}

const amountOf = (row: AmountRow, key: string) => (props.settings[row] as unknown as Record<string, number | null>)[key];
/** 1억 이상이면 읽기 쉬운 금액('2억 5,000만') */
const hint = (v: number | null) => (v != null && v >= 10000 ? manwon(v) : '');

/** 내 조건의 연소득(만원). 빈칸이면 거르지 않고, 잘못된 값이면 칸을 되돌린다. */
function setIncome(event: Event) {
  const input = event.target as HTMLInputElement;
  const text = input.value.trim();
  const v = text === '' ? null : Number(text);
  if (v != null && !(Number.isFinite(v) && v > 0)) {
    input.value = profile.value.income == null ? '' : String(profile.value.income);
    return;
  }
  profile.value.income = v == null ? null : Math.round(v);
}

/** 내 조건의 전세대출 금리(연 %)나 대출 비율(%). 빈칸이면 기본값, 0 이하나 max를 넘으면 칸을 되돌린다. */
function setLoan(key: 'loanRate' | 'loanRatio', max: number, event: Event) {
  const input = event.target as HTMLInputElement;
  const text = input.value.trim();
  const v = text === '' ? null : Number(text);
  if (v != null && !(Number.isFinite(v) && v > 0 && v <= max)) {
    input.value = profile.value[key] == null ? '' : String(profile.value[key]);
    return;
  }
  profile.value[key] = v == null ? null : Math.round(v * 100) / 100;
}

async function save(patch: Partial<AlertSettings>): Promise<boolean> {
  error.value = null;
  try {
    await api.setAlerts(patch);
    emit('changed');
    return true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    return false;
  }
}

async function toggleRow(row: AmountRow, event: Event) {
  const input = event.target as HTMLInputElement;
  if (!(await save({ [row]: { ...props.settings[row], on: input.checked } }))) input.checked = props.settings[row].on;
}

/** 칸에 보일 값: 평 칸은 저장된 ㎡를 평으로(소수 한 자리) */
const shownAmount = (row: AmountRow, key: string, unit?: '평') => {
  const v = amountOf(row, key);
  return v == null ? '' : unit === '평' ? String(Math.round((v / M2_PER_PYEONG) * 10) / 10) : String(v);
};

async function setAmount(row: AmountRow, key: string, event: Event, unit?: '평') {
  const input = event.target as HTMLInputElement;
  const raw = input.value.trim();
  const value = raw === '' ? null : unit === '평' ? Math.round(Number(raw) * M2_PER_PYEONG * 100) / 100 : Number(raw);
  if (!(await save({ [row]: { ...props.settings[row], [key]: value } }))) input.value = shownAmount(row, key, unit);
}

async function toggleFlag(key: Flag, event: Event) {
  const input = event.target as HTMLInputElement;
  if (!(await save({ [key]: input.checked }))) input.checked = props.settings[key];
}
</script>

<template>
  <section class="alerts">
    <h2>설정</h2>
    <p v-if="error" class="error">{{ error }}</p>

    <div class="group">
      <h3>조회</h3>
      <ul class="list">
        <li class="row wide" :class="{ off: !visible }" title="끄면 창 없이 조용히 조회합니다. 자동 확인도 같은 방식으로 돕니다">
          <label class="check toggle">
            <input type="checkbox" :checked="visible" :disabled="running" @change="emit('visible', ($event.target as HTMLInputElement).checked)" />
            <strong>브라우저 창 띄워서 보면서 조회</strong>
          </label>
        </li>
        <li
          class="row"
          title="집토스는 역 페이지 하나, 피터팬은 지역 하나, 고방, 법원경매, 온비드는 구 하나를 다 본 뒤 이만큼 쉬고 다음으로 넘어갑니다. 사이트와 이 컴퓨터에 요청이 한꺼번에 몰리지 않게 하는 것이고, 길게 할수록 조회가 오래 걸립니다."
        >
          <strong class="name">역, 지역, 구 사이 쉬기</strong>
          <span class="fields">
            <select class="time" :value="restSeconds" aria-label="역, 지역, 구 사이 쉬는 시간" @change="setRest">
              <option v-for="s in REST_CHOICES" :key="s" :value="s">{{ s ? `${s}초` : '안 쉼' }}</option>
            </select>
          </span>
        </li>
        <li
          class="row" :class="{ off: !autoTime }"
          title="이 요일과 시각에 알아서 조회합니다. 그때 대시보드나 컴퓨터가 꺼져 있었으면 다음에 컴퓨터를 켤 때 대시보드를 켜고 조회합니다(윈도우 작업 스케줄러). 매일이면 새 소식이 있을 때만, 요일을 고르면 새 소식이 없어도 결과 알림을 띄웁니다."
        >
          <strong class="name">자동 확인</strong>
          <span class="fields">
            <select
              class="time" :value="autoDay ?? 'daily'" :disabled="!autoTime" aria-label="자동 확인 요일"
              @change="emit('autoDay', ($event.target as HTMLSelectElement).value === 'daily' ? null : Number(($event.target as HTMLSelectElement).value))"
            >
              <option value="daily">매일</option>
              <option v-for="d in AUTO_DAYS" :key="d.value" :value="d.value">{{ d.name }}</option>
            </select>
            <select class="time" :value="autoTime ?? 'off'" aria-label="자동 확인 시각" @change="emit('autoTime', ($event.target as HTMLSelectElement).value)">
              <option value="off">끔</option>
              <option v-for="t in autoTimes" :key="t" :value="t">{{ t }}</option>
            </select>
          </span>
        </li>
        <li
          class="row" :class="{ off: !noticeTime }"
          title="매일 이 시각에 매물 사이트는 빼고 공고만 창 없이 확인합니다. 켜 둔 지역 바로 근처일 가능성이 높은 새 임대 공고만 바로 알리고, 나머지 새 공고는 다음 알림에 함께 넣습니다. 그때 컴퓨터가 꺼져 있었으면 다음에 켤 때 합니다."
        >
          <strong class="name">공고 확인</strong>
          <span class="fields">
            <select class="time" :value="noticeTime ?? 'off'" aria-label="공고 확인 시각" @change="emit('noticeTime', ($event.target as HTMLSelectElement).value)">
              <option value="off">끔</option>
              <option v-for="t in autoTimes" :key="t" :value="t">매일 {{ t }}</option>
            </select>
          </span>
        </li>
      </ul>
    </div>

    <div v-for="g in GROUPS" :key="g.id" class="group">
      <h3 :title="g.title">{{ g.name }} 알림</h3>
      <ul class="list">
        <li
          v-if="g.id === 'rent'" class="row"
          title="월세, 전세, 단기, 매매 알림은 매물 탭 왼쪽 필터와 같은 조건(금액, 평, 매물 유형, 층, 무옵션, 지역)으로 셉니다. 필터를 바꾸면 알림 조건도 같이 바뀝니다. 거래 유형은 아래 줄 켜기로 고릅니다."
        >
          <strong class="name">매물 조건</strong>
          <span class="muted filter-text">매물 탭 필터: {{ filterText }}</span>
        </li>
        <li v-for="r in AMOUNT_ROWS.filter((x) => x.group === g.id)" :key="r.row" class="row" :class="{ off: !settings[r.row].on }" :title="r.title">
          <label class="check toggle">
            <input type="checkbox" :checked="settings[r.row].on" @change="toggleRow(r.row, $event)" />
            <strong>{{ r.name }}</strong>
          </label>
          <span v-if="byFilter(r.row)" class="muted filter-text" title="매물 탭 필터의 금액입니다. 필터에서 바꿉니다">{{ filterAmountText(r.row) }}</span>
          <span v-else class="fields">
            <label v-for="f in r.fields" :key="f.key" class="field">
              {{ f.label }}
              <input
                type="number" min="1" :step="f.step" placeholder="제한 없음" :value="shownAmount(r.row, f.key, f.unit)"
                @change="setAmount(r.row, f.key, $event, f.unit)"
              />
              {{ f.unit ?? '만' }} 이하<span v-if="!f.unit && hint(amountOf(r.row, f.key))" class="muted hint">{{ hint(amountOf(r.row, f.key)) }}</span>
            </label>
          </span>
        </li>
        <li v-for="f in FLAGS.filter((x) => x.group === g.id)" :key="f.key" class="row" :class="{ off: !settings[f.key] }" :title="f.title">
          <label class="check toggle">
            <input type="checkbox" :checked="settings[f.key]" @change="toggleFlag(f.key, $event)" />
            <strong>{{ f.name }}</strong>
          </label>
        </li>
      </ul>
    </div>

    <div class="group">
      <h3 title="연소득을 넣으면 소득 기준을 넘어 받을 수 없는 정책대출과 지원을 지원 제도 탭과 매물 카드 대출 표시에서 뺍니다. 전세대출 금리와 비율은 매물 카드의 '대출 시 월'에 씁니다. 이 브라우저에만 저장합니다.">내 조건</h3>
      <ul class="list">
        <li class="row" :class="{ off: profile.income == null }" title="세전 연소득, 결혼했으면 부부 합산. 비우면 거르지 않습니다.">
          <strong class="name">연소득</strong>
          <span class="fields">
            <label class="field">
              <input type="number" min="1" step="100" placeholder="안 넣음" :value="profile.income ?? ''" aria-label="연소득(만원)" @change="setIncome" />
              만<span v-if="hint(profile.income)" class="muted hint">{{ hint(profile.income) }}</span>
            </label>
          </span>
        </li>
        <li class="row" title="신혼, 출산, 자녀 수에 따라 소득 기준이 달라지는 대출이 있습니다.">
          <strong class="name">가구</strong>
          <span class="fields">
            <label class="check"><input v-model="profile.newlywed" type="checkbox" /> 신혼(혼인 7년 안)이나 결혼 예정</label>
            <label class="check"><input v-model="profile.newborn" type="checkbox" /> 2년 안에 출산</label>
            <label class="field">
              자녀
              <select v-model.number="profile.kids" class="time" aria-label="미성년 자녀 수">
                <option :value="0">없음</option>
                <option :value="1">1명</option>
                <option :value="2">2명 이상</option>
              </select>
            </label>
          </span>
        </li>
        <li class="row" :title="`매물 카드의 '대출 시 월'(월세 + 대출 이자)에 씁니다. 비우면 금리 ${LOAN_RATE.rate}%(${LOAN_RATE.basis}), 대출 비율 ${LOAN_RATIO}%.`">
          <strong class="name">전세대출</strong>
          <span class="fields">
            <label class="field">
              금리
              <input type="number" min="0.1" step="0.1" :placeholder="String(LOAN_RATE.rate)" :value="profile.loanRate ?? ''" aria-label="전세대출 금리(연 %)" @change="setLoan('loanRate', 30, $event)" />
              %
            </label>
            <label class="field">
              대출 비율
              <input type="number" min="1" step="5" :placeholder="String(LOAN_RATIO)" :value="profile.loanRatio ?? ''" aria-label="보증금 중 대출로 낼 몫(%)" @change="setLoan('loanRatio', 100, $event)" />
              %
            </label>
          </span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.alerts { display: grid; gap: 14px; max-width: 760px; }
h2 { margin: 0; font-size: 18px; }
h3 { margin: 0 0 6px; font-size: 15px; }
p { margin: 0; }
.error { color: var(--new); font-weight: 600; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.row {
  display: grid; grid-template-columns: 200px 1fr; align-items: center; gap: 12px;
  min-height: 52px; padding: 6px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
}
.row.wide { grid-template-columns: 1fr; }
.row.off { opacity: .6; }
.fields { display: flex; flex-wrap: wrap; gap: 8px 18px; }
.field { display: flex; align-items: center; gap: 6px; font-size: 14px; white-space: nowrap; }
.name { padding-left: 2px; }
.time { min-height: 40px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); font-size: 15px; font-weight: 600; }
.field input { width: 110px; min-height: 36px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); font-size: 15px; font-weight: 600; }
.hint { font-size: 13px; }
.filter-text { font-size: 14px; overflow-wrap: anywhere; }
@media (max-width: 720px) { .row { grid-template-columns: 1fr; } }
</style>
