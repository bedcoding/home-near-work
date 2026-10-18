import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_CONFIG_PATH } from './config.js';
import * as store from './db.js';
import { toNumber } from './collectors/types.js';
import { buildListingViews } from './views.js';
import type { AppState, AptRegistry } from '../shared/types.js';

// 서울 아파트 탭의 세대수를 국토교통부 건축HUB 건축물대장정보 서비스(공공데이터포털 15134735)로 채운다.
// 경매·공매 물건 주소에서 뽑은 구·법정동·지번(AptInfo.complexKey 'lot:강남구 대치동 316')으로 표제부(getBrTitleInfo, 동마다 한 줄)를 읽어
// 세대수(hhldCnt) 합, 세대가 있는 동 수, 가장 높은 지상층수(grndFlrCnt)를 남기고, 동이 여럿이면 총괄표제부(getBrRecapTitleInfo)의 세대수를 쓴다.
// 인증키는 config/local.json의 dataGoKrKey(일반 인증키, 인코딩된 것도 디코딩된 것도 됨). 키는 요청 기록이나 오류 글자에 남기지 않는다.
// 법정동 코드는 seoul-bjdong.json: 행정안전부 법정동코드 전체자료 중 서울의 '존재' 행(구 25곳, 법정동 467곳)을
// building-register-mcp 저장소(Apache-2.0)의 사본에서 뽑았다(2026-10-18).
// 이 프로그램을 만든 작업 환경에서는 공공데이터포털에 닿지 않아 실제 응답으로 확인하지 못했다. 주소, 입력값, 응답 칸 이름은 이 API를 쓰는 공개 코드로 확인했다.

/** 요청 주소 앞부분. HNW_REGISTER_BASE로 바꿀 수 있다(시험용 가짜 서버). */
const BASE = process.env.HNW_REGISTER_BASE ?? 'https://apis.data.go.kr/1613000/BldRgstHubService';
/** 요청 기록에 남길 곳 이름(조회 기록의 요청 표에 그대로 보인다) */
export const REGISTRY_SOURCE = '건축물대장';
const TIMEOUT_MS = 20000;
/** 대장에서 읽은 단지(세대수를 찾았거나 못 찾은 것)를 다시 보는 간격(일). 실패한 것은 매번 다시 본다. */
const RECHECK_DAYS = 180;
/** 한 번에 보는 단지 수(나머지는 다음에). 단지 하나에 요청 한두 번이다. */
const MAX_LOTS = 200;
/** 요청 사이 쉬는 시간(ms) */
const PAUSE_MS = 150;
/** 마지막으로 채운 결과(설정) */
const LAST_KEY = 'households_fill_last';

const BJDONG = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'seoul-bjdong.json'), 'utf8')) as Record<
  string,
  { code: string; dongs: Record<string, string> }
>;

/** 요청 하나를 기록하는 함수(키를 뺀 주소, HTTP 상태, 설명) */
type RecordRequest = (url: string, status: number | null, note: string) => void;

/** 공공데이터포털 인증키: HNW_DATA_GO_KR_KEY(시험용), 없으면 config/local.json의 dataGoKrKey. 부를 때마다 파일을 다시 읽어 대시보드를 다시 켜지 않아도 된다. */
export function registryKey(): string | null {
  const env = process.env.HNW_DATA_GO_KR_KEY?.trim();
  if (env) return env;
  try {
    const value = (JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8')) as { dataGoKrKey?: unknown }).dataGoKrKey;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** 화면에 보일 세대수 채우기 상태(키를 넣었는지, 마지막 결과) */
export function householdsFillState(): AppState['householdsFill'] {
  let last: AppState['householdsFill']['last'] = null;
  try {
    last = JSON.parse(store.getSetting(LAST_KEY) ?? 'null');
  } catch {
    /* 못 읽으면 없는 것으로 */
  }
  return { key: !!registryKey(), last };
}

/** 'lot:강남구 대치동 316', 'lot:송파구 가락동 산12-3' → 구, 법정동, 산 여부, 본번, 부번(없으면 '0'). 모양이 다르면 null. */
export function parseLot(key: string): { gu: string; dong: string; san: boolean; bun: string; ji: string } | null {
  const m = /^lot:(\S+) (\S+) (산)?(\d+)(?:-(\d+))?$/.exec(key);
  return m ? { gu: m[1], dong: m[2], san: !!m[3], bun: m[4], ji: m[5] ?? '0' } : null;
}

/** 조회 오류. fatal이면 키나 서비스 문제라 남은 단지도 안 되므로 멈춘다. */
class RegistryError extends Error {
  constructor(message: string, readonly fatal: boolean) {
    super(message);
  }
}

/** 공공데이터포털 공통 결과 코드: 03 데이터 없음, 10·11 요청 값 문제(그 단지만 실패). 나머지는 키·이용량·서비스 문제로 본다. */
const NO_DATA = '03';
const BAD_PARAMS = ['10', '11'];

/** 글자에서 키(그대로와 인코딩한 것)를 가린다. */
const hide = (text: string, key: string) => text.split(key).join('***').split(encodeURIComponent(key)).join('***');

/** API 한 번 부르기. 응답 items.item(하나면 객체, 여럿이면 배열, 없으면 빈 글자)을 배열로 돌려준다. */
async function call(op: string, params: Record<string, string>, key: string, record: RecordRequest): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const query = new URLSearchParams({ _type: 'json', ...params }).toString();
  const shown = `${BASE}/${op}?${query}`;
  // 포털이 주는 키 두 가지 중 인코딩된 것(%가 든 것)은 그대로, 디코딩된 것은 인코딩해서 붙인다.
  const url = `${BASE}/${op}?serviceKey=${key.includes('%') ? key : encodeURIComponent(key)}&${query}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    record(shown, null, '연결 실패');
    throw new RegistryError(`건축물대장에 연결하지 못했습니다(${hide(e instanceof Error ? e.message : String(e), key)})`, true);
  }
  const text = hide(await res.text(), key);
  if (text.trimStart().startsWith('<')) {
    // 키가 없거나 등록되지 않았을 때 등은 JSON이 아니라 XML로 온다.
    const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1]?.trim();
    const reason = tag('returnAuthMsg') ?? tag('resultMsg') ?? tag('errMsg') ?? `HTTP ${res.status}`;
    record(shown, res.status, `오류 ${reason}`);
    throw new RegistryError(`건축물대장 조회가 거절됐습니다(${reason}). 공공데이터포털에서 건축HUB 건축물대장정보 서비스 활용신청과 키를 확인해 주세요.`, true);
  }
  if (!res.ok) {
    record(shown, res.status, '오류');
    throw new RegistryError(`건축물대장 응답 오류(HTTP ${res.status}: ${text.slice(0, 120)})`, true);
  }
  let data: { response?: { header?: { resultCode?: unknown; resultMsg?: unknown }; body?: { items?: unknown; totalCount?: unknown } } };
  try {
    data = JSON.parse(text);
  } catch {
    record(shown, res.status, '읽지 못함');
    throw new RegistryError(`건축물대장 응답을 읽지 못했습니다(${text.slice(0, 120)})`, true);
  }
  const code = String(data.response?.header?.resultCode ?? '00');
  if (code === NO_DATA) {
    record(shown, res.status, '데이터 없음');
    return { items: [], total: 0 };
  }
  if (code !== '00') {
    const msg = String(data.response?.header?.resultMsg ?? '');
    record(shown, res.status, `오류 ${code} ${msg}`);
    throw new RegistryError(`건축물대장 조회 오류(${code} ${msg})`, !BAD_PARAMS.includes(code));
  }
  const body = data.response?.body ?? {};
  const raw = (body.items as { item?: unknown } | undefined)?.item;
  const items = (Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []) as Record<string, unknown>[];
  const total = toNumber(body.totalCount) ?? items.length;
  record(shown, res.status, `${items.length}건(전체 ${total}건)`);
  return { items, total };
}

/** 여러 쪽에 걸친 결과를 모은다(쪽마다 100건, 많아야 maxPages쪽). */
async function rows(op: string, params: Record<string, string>, key: string, record: RecordRequest, maxPages = 3) {
  const out: Record<string, unknown>[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { items, total } = await call(op, { ...params, pageNo: String(page), numOfRows: '100' }, key, record);
    out.push(...items);
    if (out.length >= total || items.length < 100) break;
    await pause();
  }
  return out;
}

const pause = () => new Promise((r) => setTimeout(r, PAUSE_MS));
const num = (v: unknown) => toNumber(v) ?? 0;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * 지번 하나의 건축물대장을 읽어 단지 정보를 만든다.
 * 세대가 있는 동(세대수가 있거나, 주용도가 주택이고 호수가 있는 동)만 센다. 세대수는 동마다 합(모두 비었으면 호수 합),
 * 동이 여럿이면 총괄표제부 세대수가 있으면 그것을 쓴다.
 */
export async function lookupLot(lot: NonNullable<ReturnType<typeof parseLot>>, key: string, record: RecordRequest = () => {}): Promise<AptRegistry> {
  const checkedAt = new Date().toISOString();
  const empty = { households: null, buildings: null, floors: null, name: null, purpose: null, basis: null, checkedAt };
  const gu = BJDONG[lot.gu];
  const dongCode = gu?.dongs[lot.dong];
  if (!gu || !dongCode) return { status: 'none', ...empty, error: `법정동 코드를 모름(${lot.gu} ${lot.dong})` };
  const params = { sigunguCd: gu.code, bjdongCd: dongCode, platGbCd: lot.san ? '1' : '0', bun: lot.bun.padStart(4, '0'), ji: lot.ji.padStart(4, '0') };
  const title = await rows('getBrTitleInfo', params, key, record);
  const homes = title.filter((r) => num(r.hhldCnt) > 0 || (num(r.hoCnt) > 0 && /주택/.test(String(r.mainPurpsCdNm ?? ''))));
  if (!homes.length) {
    return { status: 'none', ...empty, error: title.length ? '그 지번 대장에 세대수가 있는 동이 없음' : '그 지번에 건축물대장이 없음(지번이 다를 수 있음)' };
  }
  let households = homes.reduce((n, r) => n + num(r.hhldCnt), 0);
  let basis: AptRegistry['basis'] = 'title';
  if (!households) {
    households = homes.reduce((n, r) => n + num(r.hoCnt), 0);
    basis = 'ho';
  }
  if (homes.length > 1) {
    await pause();
    const recap = await rows('getBrRecapTitleInfo', params, key, record, 1);
    const total = Math.max(0, ...recap.map((r) => num(r.hhldCnt)));
    if (total > 0) {
      households = total;
      basis = 'recap';
    }
  }
  const first = homes[0];
  const floors = Math.max(...homes.map((r) => num(r.grndFlrCnt)));
  const purpose = [str(first.mainPurpsCdNm), str(first.etcPurps)].filter(Boolean).join(', ').slice(0, 60) || null;
  return { status: 'ok', households, buildings: homes.length, floors: floors > 0 ? floors : null, name: str(first.bldNm), purpose, basis, checkedAt, error: null };
}

let running: Promise<string> | null = null;

/**
 * 경매·공매 아파트 단지(지번 키) 중 세대수를 직접 넣지 않았고 아직 대장을 안 본(또는 RECHECK_DAYS가 지났거나 실패한) 곳의 건축물대장을 읽어 저장한다.
 * 한 번에 MAX_LOTS곳까지. 결과 한 줄을 돌려주고 마지막 결과로 남긴다. 키가 없거나 키·서비스 문제면 오류를 던진다. 이미 채우는 중이면 그 결과를 기다린다.
 */
export function fillHouseholds(record: RecordRequest = () => {}): Promise<string> {
  running ??= fill(record).finally(() => {
    running = null;
  });
  return running;
}

function setLast(ok: boolean, text: string) {
  store.setSetting(LAST_KEY, JSON.stringify({ at: new Date().toISOString(), ok, text }));
}

async function fill(record: RecordRequest): Promise<string> {
  const key = registryKey();
  if (!key) throw new Error('공공데이터포털 인증키가 없습니다. config/local.json에 dataGoKrKey를 넣어 주세요(README의 서울 아파트 탭 참고).');
  const manual = store.complexHouseholds();
  const known = store.registryRows();
  const since = Date.now() - RECHECK_DAYS * 86400000;
  const lots = new Map<string, string>();
  for (const l of buildListingViews()) {
    const a = l.apt;
    if (l.status !== 'active' || !a || !a.complexKey.startsWith('lot:') || manual.has(a.complexKey)) continue;
    const r = known.get(a.complexKey);
    if (r && r.status !== 'error' && Date.parse(r.checkedAt) >= since) continue;
    lots.set(a.complexKey, a.complexName);
  }
  const batch = [...lots.keys()].slice(0, MAX_LOTS);
  let ok = 0;
  let none = 0;
  let failed = 0;
  for (const complexKey of batch) {
    const lot = parseLot(complexKey);
    if (!lot) continue;
    try {
      const r = await lookupLot(lot, key, record);
      store.saveRegistry(complexKey, r);
      if (r.status === 'ok') ok++;
      else none++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof RegistryError && e.fatal) {
        const text = `${message}${ok + none ? ` (그 전까지 채움 ${ok}곳, 대장에서 못 찾음 ${none}곳)` : ''}`;
        setLast(false, text);
        throw new Error(text);
      }
      failed++;
      store.saveRegistry(complexKey, {
        status: 'error', households: null, buildings: null, floors: null, name: null, purpose: null, basis: null, checkedAt: new Date().toISOString(), error: message,
      });
    }
    await pause();
  }
  const rest = lots.size - batch.length;
  const text = batch.length
    ? [`세대수 채움 ${ok}곳`, none ? `대장에서 못 찾음 ${none}곳` : '', failed ? `실패 ${failed}곳` : '', rest > 0 ? `남은 ${rest}곳은 다음에` : '']
        .filter(Boolean)
        .join(', ')
    : '새로 볼 단지가 없습니다';
  setLast(true, text);
  return text;
}
