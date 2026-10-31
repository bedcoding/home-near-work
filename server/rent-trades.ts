import * as store from './db.js';
import { guCode } from './lots.js';
import { stationsByGu } from './market.js';
import { cells, csvHead, downloadSeoulCsv, num, orNull, yearRange, ymd, type RecordRequest, type RtThing } from './rt-csv.js';
import { RENT_KINDS, RENT_SIZES, type RentJeonseStat, type RentMonthlyStat, type RentPlace, type RentView } from '../shared/types.js';

// 국토부 실거래가 공개시스템 자료제공(rt.molit.go.kr)의 전월세 실거래(켜 둔 지역 근처 구, 계약일 최근 1년)를 구마다 주택 종류별 CSV로 받아
// 저장하고(받는 방법은 rt-csv), 시세 통계 탭 동별 전월세 요약을 만든다. 받은 1년 범위는 구와 종류마다 받을 때마다 통째로 바꾸고,
// 그보다 오래된 계약은 남겨 둔다.

/** 마지막으로 받은 시각(ISO)과 마지막 시도 결과(JSON)를 두는 설정 키 */
const FETCHED_KEY = 'rent_trades_fetched_at';
const STATUS_KEY = 'rent_trades_status';
/** 받은 지 이만큼 지나면 조회할 때 다시 받는다 */
const MAX_AGE_MS = 7 * 86400000;
/** CSV 하나를 받은 뒤 다음 요청까지 쉬는 시간 */
const PAUSE_MS = 2000;
/** 환산 전환율(연 %)을 못 받았을 때 쓰는 값 */
const DEFAULT_RATE = 6;

/** 요청 기록에 남길 곳 이름(조회 기록의 요청 표에 그대로 보인다) */
export const RENT_TRADES_SOURCE = '국토부 전월세 실거래';

/** 자료제공 화면의 실거래 구분과 저장할 종류 이름 */
const THINGS: [RtThing, string][] = [
  ['A', '아파트'],
  ['B', '연립다세대'],
  ['C', '단독다가구'],
  ['D', '오피스텔'],
];

/** 받을 때가 됐는지: gus가 있고, 받은 적이 없거나 받은 지 MAX_AGE_MS가 지났거나 gus 중 받아 둔 계약이 없는 구가 있으면 true */
export function rentTradesDue(gus: string[]): boolean {
  if (!gus.length) return false;
  const at = store.getSetting(FETCHED_KEY);
  if (!at || Date.now() - Date.parse(at) >= MAX_AGE_MS) return true;
  const have = new Set(store.rentTradeGus());
  return gus.some((gu) => !have.has(gu));
}

/** 요청에 실린 전환율(연 %)을 숫자로. 없거나 0 이하, 20 넘으면 DEFAULT_RATE. */
export function rateOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 20 ? n : DEFAULT_RATE;
}

/**
 * 받은 CSV 글자를 저장할 계약으로 바꾼다(kind는 저장할 종류 이름). rows는 머리글 아래 빈 줄을 뺀 줄 수(받다 잘렸는지 볼 때 쓴다).
 * 종류마다 이름 칸(단지명, 건물명)과 면적 칸(전용면적, 단독다가구는 계약면적)이 다르고, 단독다가구에는 층이 없다.
 * 면적이나 보증금을 못 읽은 줄은 건너뛴다. 머리글 줄이나 꼭 있어야 할 칸이 없으면 오류.
 */
export function parseRentCsv(text: string, kind: string): { rows: number; trades: store.RentTradeInput[] } {
  const lines = text.split(/\r?\n/);
  const { at: headAt, head } = csvHead(lines);
  const find = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const at = {
    sgg: find('시군구'),
    jibun: find('번지'),
    name: find('단지명', '건물명'),
    area: find('전용면적(㎡)', '계약면적(㎡)'),
    ym: find('계약년월'),
    day: find('계약일'),
    deposit: find('보증금(만원)'),
    rent: find('월세금(만원)'),
    floor: find('층'),
    year: find('건축년도'),
    type: find('계약구분'),
  };
  const need = { 시군구: at.sgg, 면적: at.area, 계약년월: at.ym, 계약일: at.day, 보증금: at.deposit, 월세금: at.rent };
  const missing = Object.entries(need).filter(([, i]) => i < 0).map(([name]) => name);
  if (missing.length) throw new Error(`전월세 CSV에 없는 칸: ${missing.join(', ')}`);
  const trades: store.RentTradeInput[] = [];
  let rows = 0;
  for (const line of lines.slice(headAt + 1)) {
    if (!line.trim()) continue;
    rows++;
    const c = cells(line);
    const get = (i: number) => (i < 0 ? '' : (c[i] ?? ''));
    const [, gu = '', ...dong] = get(at.sgg).split(' ');
    const ym = get(at.ym);
    const day = get(at.day);
    const area = num(get(at.area));
    const deposit = num(get(at.deposit));
    if (!gu || !dong.length || !/^\d{6}$/.test(ym) || !/^\d{1,2}$/.test(day) || area == null || area <= 0 || deposit == null) continue;
    const year = num(get(at.year));
    const type = get(at.type);
    const trade = {
      gu,
      dong: dong.join(' '),
      kind,
      name: orNull(get(at.name)),
      areaM2: area,
      contractDate: `${ym.slice(0, 4)}-${ym.slice(4)}-${day.padStart(2, '0')}`,
      deposit,
      rent: num(get(at.rent)) ?? 0,
      contractType: type === '신규' || type === '갱신' ? type : null,
      builtYear: year != null && year > 1900 ? year : null,
      floor: num(get(at.floor)),
    };
    const key = [trade.gu, trade.dong, kind, get(at.jibun), trade.name, area, trade.contractDate, deposit, trade.rent, trade.floor, trade.contractType].join('|');
    trades.push({ key, ...trade });
  }
  return { rows, trades };
}

let running: Promise<string> | null = null;

/**
 * gus 구마다 전월세(계약일 최근 1년, 아파트, 연립다세대, 단독다가구, 오피스텔)를 받아 저장하고 결과 한 줄을 돌려준다.
 * 이미 받는 중이면 그 결과를 기다린다. 하나라도 실패하면 마지막 시도 결과에 오류를 남기고 오류를 던진다
 * (그 앞에 받은 구와 종류는 저장된 채로 남고, 마지막으로 받은 시각은 그대로).
 */
export function collectRentTrades(gus: string[], record: RecordRequest = () => {}): Promise<string> {
  running ??= fetchAndSave(gus, record).finally(() => {
    running = null;
  });
  return running;
}

async function fetchAndSave(gus: string[], record: RecordRequest): Promise<string> {
  const { from, to } = yearRange();
  try {
    const parts: string[] = [];
    let first = true;
    for (const gu of gus) {
      const code = guCode(gu);
      if (!code) continue;
      let total = 0;
      for (const [thing, kind] of THINGS) {
        if (!first) await new Promise((r) => setTimeout(r, PAUSE_MS));
        first = false;
        const { text, count, url, status } = await downloadSeoulCsv(thing, ymd(from), ymd(to), record, undefined, { deal: '2', sgg: { name: gu, code } });
        const { rows, trades } = parseRentCsv(text, kind);
        record(url, status, `${gu} ${kind} CSV ${trades.length}건`);
        if (count != null && rows < count) throw new Error(`${gu} ${kind} CSV ${rows}줄이 건수 ${count}건보다 적습니다.`);
        store.replaceRentTrades(gu, kind, ymd(from), ymd(to), trades);
        total += trades.length;
      }
      parts.push(`${gu} ${total.toLocaleString('ko-KR')}건`);
    }
    const at = new Date().toISOString();
    store.setSetting(FETCHED_KEY, at);
    store.setSetting(STATUS_KEY, JSON.stringify({ at, ok: true, gus }));
    return `${parts.length ? parts.join(', ') : '받을 구 없음'}(계약일 ${ymd(from)} ~ ${ymd(to)})`;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    store.setSetting(STATUS_KEY, JSON.stringify({ at: new Date().toISOString(), ok: false, error: message }));
    throw e;
  }
}

/** 중간값(빈 배열이면 null) */
function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** 월세 계약(rent > 0) 요약. 환산 월세는 월세 + 보증금 × rate ÷ 100 ÷ 12, 4분의 1 경계는 작은 순 n × 0.25번째와 n × 0.75번째. */
function monthlyStat(list: store.RentTradeRow[], rate: number): RentMonthlyStat | null {
  if (!list.length) return null;
  const conv = list.map((r) => r.rent + (r.deposit * rate) / 100 / 12).sort((a, b) => a - b);
  return {
    count: list.length,
    conv: round1(median(conv)!),
    convLow: round1(conv[Math.floor(conv.length * 0.25)]),
    convHigh: round1(conv[Math.floor(conv.length * 0.75)]),
    deposit: Math.round(median(list.map((r) => r.deposit))!),
    rent: round1(median(list.map((r) => r.rent))!),
  };
}

/** 전세 계약(rent 0) 요약 */
function jeonseStat(list: store.RentTradeRow[]): RentJeonseStat | null {
  if (!list.length) return null;
  const s = list.map((r) => r.deposit).sort((a, b) => a - b);
  return { count: s.length, median: Math.round(median(s)!), low: s[Math.floor(s.length * 0.25)], high: s[Math.floor(s.length * 0.75)] };
}

/** 계약들의 종류와 면적 칸마다 월세와 전세 요약(계약이 없는 칸은 뺀다) */
function cellsOf(list: store.RentTradeRow[], rate: number): RentPlace['cells'] {
  const out: RentPlace['cells'] = {};
  for (const k of RENT_KINDS) {
    const kinds: readonly string[] = k.kinds;
    const ofKind = list.filter((r) => kinds.includes(r.kind));
    for (const s of RENT_SIZES) {
      const inSize = ofKind.filter((r) => r.area_m2 > s.min && r.area_m2 <= s.max);
      if (!inSize.length) continue;
      out[`${k.id}:${s.id}`] = { monthly: monthlyStat(inSize.filter((r) => r.rent > 0), rate), jeonse: jeonseStat(inSize.filter((r) => r.rent === 0)) };
    }
  }
  return out;
}

/**
 * gus 구(켜 둔 지역 근처 구)의 계약일 최근 1년 신규 전월세 계약을 구 전체와 동마다 종류와 면적 칸별로 요약한다(갱신과 계약 구분을
 * 모르는 계약은 뺀다). 동마다 그 동에 맞춘 역(stationsByGu)을 붙인다. 계약이 하나도 없는 구는 뺀다.
 */
export function buildRentView(gus: string[], rate: number): RentView {
  const { from, to } = yearRange();
  const rows = store.rentTradeRows(ymd(from), gus).filter((r) => r.contract_type === '신규');
  const stations = stationsByGu();
  const status = JSON.parse(store.getSetting(STATUS_KEY) ?? 'null') as { ok: boolean; error?: string } | null;
  return {
    fetchedAt: store.getSetting(FETCHED_KEY),
    error: status && !status.ok ? (status.error ?? '받지 못했습니다.') : null,
    from: ymd(from),
    to: ymd(to),
    rate,
    gus: gus
      .map((gu) => {
        const ofGu = rows.filter((r) => r.gu === gu);
        const byDong = new Map<string, store.RentTradeRow[]>();
        for (const r of ofGu) {
          const list = byDong.get(r.dong);
          if (list) list.push(r);
          else byDong.set(r.dong, [r]);
        }
        return {
          name: gu,
          cells: cellsOf(ofGu, rate),
          dongs: [...byDong]
            .sort((a, b) => a[0].localeCompare(b[0], 'ko'))
            .map(([dong, list]) => ({ name: dong, cells: cellsOf(list, rate), stations: (stations.get(gu) ?? []).filter((s) => s.dongs.includes(dong)) })),
        };
      })
      .filter((g) => g.dongs.length),
  };
}
