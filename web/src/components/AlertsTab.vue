<script setup lang="ts">
import { ref } from 'vue';
import { REST_CHOICES, type AlertSettings } from '../../../shared/types';
import { manwon } from '../../../shared/format';
import { api } from '../api';

// 설정 탭: 조회 방식(창 띄우기, 자동 확인 요일과 시각)과 조회가 끝나면 띄울 알림. 바꾸면 바로 저장한다. 금액은 만원, 빈칸은 제한 없음.
// 전월세 줄과 매매 목적 줄은 알림이 따로 뜬다. 조회 방식은 App이 저장한다(visible, autoTime, autoDay 이벤트).
const props = defineProps<{
  settings: AlertSettings;
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
  /** 조회할 때 역·지역·구 사이에 쉬는 시간(초) */
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

/** 매물 줄: 켜기와 상한 칸(key는 그 줄 설정의 값 이름, unit 없으면 만원) */
const AMOUNT_ROWS: { row: AmountRow; name: string; group: Group; title?: string; fields: { key: string; label: string; step: number; unit?: '㎡' }[] }[] = [
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
    fields: [{ key: 'priceMax', label: '최저가', step: 1000 }, { key: 'areaMax', label: '면적', step: 0.1, unit: '㎡' }],
  },
  {
    row: 'landAuction', name: '토지 경매', group: 'buy',
    fields: [{ key: 'priceMax', label: '최저가', step: 1000 }, { key: 'areaMax', label: '면적', step: 0.1, unit: '㎡' }],
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
  { key: 'insideAreas', name: '매물은 지역 반경 안만', group: 'common' },
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

const amountOf = (row: AmountRow, key: string) => (props.settings[row] as unknown as Record<string, number | null>)[key];
/** 1억 이상이면 읽기 쉬운 금액('2억 5,000만') */
const hint = (v: number | null) => (v != null && v >= 10000 ? manwon(v) : '');

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

async function setAmount(row: AmountRow, key: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const raw = input.value.trim();
  if (!(await save({ [row]: { ...props.settings[row], [key]: raw === '' ? null : Number(raw) } }))) input.value = String(amountOf(row, key) ?? '');
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
          title="집토스는 역 페이지 하나, 피터팬은 지역 하나, 고방·법원경매·온비드는 구 하나를 다 본 뒤 이만큼 쉬고 다음으로 넘어갑니다. 사이트와 이 컴퓨터에 요청이 한꺼번에 몰리지 않게 하는 것이고, 길게 할수록 조회가 오래 걸립니다."
        >
          <strong class="name">역·지역·구 사이 쉬기</strong>
          <span class="fields">
            <select class="time" :value="restSeconds" aria-label="역·지역·구 사이 쉬는 시간" @change="setRest">
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
        <li v-for="r in AMOUNT_ROWS.filter((x) => x.group === g.id)" :key="r.row" class="row" :class="{ off: !settings[r.row].on }" :title="r.title">
          <label class="check toggle">
            <input type="checkbox" :checked="settings[r.row].on" @change="toggleRow(r.row, $event)" />
            <strong>{{ r.name }}</strong>
          </label>
          <span class="fields">
            <label v-for="f in r.fields" :key="f.key" class="field">
              {{ f.label }}
              <input
                type="number" min="1" :step="f.step" placeholder="제한 없음" :value="amountOf(r.row, f.key) ?? ''"
                @change="setAmount(r.row, f.key, $event)"
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
@media (max-width: 720px) { .row { grid-template-columns: 1fr; } }
</style>
