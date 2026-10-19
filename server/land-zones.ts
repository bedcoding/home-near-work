import fs from 'node:fs';
import { LOCAL_CONFIG_PATH } from './config.js';
import * as store from './db.js';
import { toNumber } from './collectors/types.js';
import { buildListingViews } from './views.js';
import type { AppState, LandZone, LandZoneCheck } from '../shared/types.js';

// 경매와 공매(단독주택 갈래, 토지, 아파트, 빌라)와 네이버 서울 아파트 매매가 재개발 쪽 구역 안인지 브이월드 국가중점데이터 API의
// 토지이용계획(getLandUseAttr)으로 본다. 경매와 공매는 주소의 지번으로 만든 필지 번호(PNU, lots.ts)로, 네이버 아파트는 지번이 없어
// 단지 좌표가 든 필지를 브이월드 2D 데이터 API의 연속지적도(LP_PA_CBND_BUBUN, geomFilter POINT)로 먼저 찾아 그 필지 번호로 부른다.
// 토지이용계획 응답(landUses.field)의 용도지역지구명(prposAreaDstrcCodeNm) 중
// 정비구역, 재개발구역, 재정비촉진지구, 소규모주택정비 관리지역, 건축허가와 착공제한지역 같은 것만 남긴다(zoneKind).
// 인증키는 config/local.json의 vworldKey. 키를 받을 때 적은 서비스 URL(vworldDomain, 없으면 http://localhost)을 domain 값과
// Referer 머리글로 같이 보낸다(Referer가 없으면 INCORRECT_KEY가 온다). 키는 요청 기록이나 오류 글자에 남기지 않는다.
// 연속지적도 응답: response.status(OK, NOT_FOUND, ERROR), result.featureCollection.features[].properties의 pnu와 addr.

/** 요청 주소 앞부분. HNW_VWORLD_BASE, HNW_VWORLD_DATA_BASE로 바꿀 수 있다(시험용 가짜 서버). */
const BASE = process.env.HNW_VWORLD_BASE ?? 'https://api.vworld.kr/ned/data';
const DATA_BASE = process.env.HNW_VWORLD_DATA_BASE ?? 'https://api.vworld.kr/req/data';
/** 요청 기록에 남길 곳 이름(조회 기록의 요청 표에 그대로 보인다) */
export const ZONE_SOURCE = '토지이용계획';
const TIMEOUT_MS = 20000;
/** 확인한 필지를 다시 보는 간격(일). 구역 지정은 바뀌므로 한 달마다 다시 본다. 실패한 것은 매번 다시 본다. */
const RECHECK_DAYS = 30;
/** 한 번에 보는 필지 수(나머지는 다음에). 필지 하나에 요청 한 번이다. 좌표로 필지를 찾는 단지 수도 같다. */
const MAX_LOTS = 150;
/** 요청 사이 쉬는 시간(ms) */
const PAUSE_MS = 300;
/** 같은 필지를 다시 부르면 풀리는 잠깐 오류(응답 기록: 열 번 부르면 두세 번 이 코드로 떨어짐)와 다시 부르는 횟수 */
const TRANSIENT = ['URL_TYPE'];
const RETRIES = 3;
/** 필지마다 실패가 이만큼 이어지면 멈춘다(서비스 쪽 문제로 보고 남은 필지를 부르지 않음). */
const MAX_STREAK = 5;
/** 마지막으로 확인한 결과(설정) */
const LAST_KEY = 'zone_check_last';

/** 요청 하나를 기록하는 함수(키를 뺀 주소, HTTP 상태, 설명) */
type RecordRequest = (url: string, status: number | null, note: string) => void;

function localConfig(): { vworldKey?: unknown; vworldDomain?: unknown } {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** 브이월드 인증키: HNW_VWORLD_KEY(시험용), 없으면 config/local.json의 vworldKey. 부를 때마다 파일을 다시 읽어 대시보드를 다시 켜지 않아도 된다. */
export function vworldKey(): string | null {
  const env = process.env.HNW_VWORLD_KEY?.trim();
  if (env) return env;
  const value = localConfig().vworldKey;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 키를 받을 때 적은 서비스 URL: HNW_VWORLD_DOMAIN(시험용), config/local.json의 vworldDomain, 없으면 http://localhost */
function vworldDomain(): string {
  const value = process.env.HNW_VWORLD_DOMAIN?.trim() || localConfig().vworldDomain;
  return typeof value === 'string' && value.trim() ? value.trim() : 'http://localhost';
}

/** 화면에 보일 구역 확인 상태(키를 넣었는지, 마지막 결과) */
export function zoneCheckState(): AppState['zoneCheck'] {
  let last: AppState['zoneCheck']['last'] = null;
  try {
    last = JSON.parse(store.getSetting(LAST_KEY) ?? 'null');
  } catch {
    /* 못 읽으면 없는 것으로 */
  }
  return { key: !!vworldKey(), last };
}

/**
 * 남길 구역의 갈래(이름 글자로 가른다). 응답 기록에서 본 이름: 정비구역(UDT100), 재개발구역(UDR100), 재정비촉진지구(UDA100),
 * 소규모주택정비 관리지역(UDK200), 건축허가와 착공제한지역(UDX100). 시장정비구역은 전통시장 쪽이라 뺀다.
 */
export function zoneKind(name: string): LandZone['kind'] | null {
  if (/시장정비/.test(name)) return null;
  if (/소규모주택정비|가로주택정비|모아타운/.test(name)) return 'small';
  if (/정비구역|정비예정구역|재개발|재건축|재정비촉진|주거환경개선/.test(name)) return 'redev';
  if (/건축허가|착공제한|개발행위허가제한/.test(name)) return 'limit';
  return null;
}

/** 관리번호 앞 7자리 기관 코드 중 아는 것(응답 기록과 고시 원문으로 맞춰 본 것만) */
const ORGS: Record<string, string> = { '6110000': '서울특별시', '1613000': '국토교통부' };

/** 관리번호(기관 7 + 시군구 5 + 고시나 공고 번호 8(YYYYNNNN) + 구역 코드 6 + 일련번호 7)에서 고시 번호('2024-448')와 기관. 모양이 다르면 null. */
export function noticeOf(manageNo: unknown): { notice: string | null; org: string | null } {
  const m = /^(\d{7})\d{5}((?:19|20)\d{2})(\d{4})/.exec(String(manageNo ?? ''));
  return m ? { notice: `${m[2]}-${Number(m[3])}`, org: ORGS[m[1]] ?? null } : { notice: null, org: null };
}

/** 저촉 여부 코드(cnflcAt) → 이름(이름 칸 cnflcAtNm이 없을 때) */
const OVERLAP: Record<string, string> = { '1': '포함', '2': '저촉', '3': '접함' };
const KIND_ORDER: LandZone['kind'][] = ['redev', 'small', 'limit'];
const OVERLAP_ORDER = ['포함', '저촉', '접함'];
const rank = (list: string[], v: string) => (list.includes(v) ? list.indexOf(v) : list.length);

/** 조회 오류. fatal이면 키나 서비스 문제라 남은 필지도 안 되므로 멈춘다. */
class ZoneError extends Error {
  constructor(message: string, readonly fatal: boolean) {
    super(message);
  }
}

/** 글자에서 키(그대로와 인코딩한 것)를 가린다. */
const hide = (text: string, key: string) => text.split(key).join('***').split(encodeURIComponent(key)).join('***');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 오류 응답이면 코드와 설명. { response: { status: 'ERROR', error: { code, text } } }와 결과 코드(resultCode)를 둘 다 본다
 * (결과 코드가 비었거나 '00', 'NORMAL_SERVICE'면 정상).
 */
function errorOf(data: unknown): { code: string; text: string } | null {
  const d = (data ?? {}) as {
    response?: { status?: unknown; error?: { code?: unknown; text?: unknown }; resultCode?: unknown; resultMsg?: unknown };
    error?: { code?: unknown; text?: unknown };
    landUses?: { resultCode?: unknown; resultMsg?: unknown };
  };
  const e = d.response?.error ?? d.error;
  if (d.response?.status === 'ERROR' || e?.code) return { code: String(e?.code ?? 'ERROR'), text: String(e?.text ?? '').trim() };
  const body = d.landUses ?? d.response;
  const code = String(body?.resultCode ?? '').trim();
  return code && code !== '00' && code !== 'NORMAL_SERVICE' ? { code, text: String(body?.resultMsg ?? '').trim() } : null;
}

/** 필지 하나의 토지이용계획 행(landUses.field, 하나면 객체로도 옴). 응답이 비면 빈 배열. 잠깐 오류는 RETRIES번까지 다시 부른다. */
async function landUseRows(pnu: string, key: string, record: RecordRequest): Promise<Record<string, unknown>[]> {
  const domain = vworldDomain();
  const query = new URLSearchParams({ pnu, format: 'json', numOfRows: '1000', pageNo: '1', domain }).toString();
  const shown = `${BASE}/getLandUseAttr?${query}`;
  const url = `${BASE}/getLandUseAttr?key=${encodeURIComponent(key)}&${query}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Referer: domain }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      record(shown, null, '연결 실패');
      throw new ZoneError(`브이월드에 연결하지 못했습니다(${hide(errText(e), key)})`, true);
    }
    const text = hide(await res.text(), key);
    if (res.status >= 500 && attempt < RETRIES) {
      record(shown, res.status, '잠깐 오류, 다시 부름');
      await wait(500 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      record(shown, res.status, '오류');
      throw new ZoneError(`브이월드 응답 오류(HTTP ${res.status}: ${text.slice(0, 120)})`, true);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      record(shown, res.status, '읽지 못함');
      throw new ZoneError(`브이월드 응답을 읽지 못했습니다(${text.slice(0, 120)})`, true);
    }
    const err = errorOf(data);
    if (err && TRANSIENT.includes(err.code) && attempt < RETRIES) {
      record(shown, res.status, `잠깐 오류 ${err.code}, 다시 부름`);
      await wait(500 * (attempt + 1));
      continue;
    }
    if (err) {
      record(shown, res.status, `오류 ${err.code} ${err.text}`.trim());
      const detail = `${err.code}${err.text ? `: ${err.text}` : ''}`;
      if (/KEY|LIMIT|AUTH|DOMAIN|DENIED/i.test(err.code)) {
        throw new ZoneError(`브이월드가 조회를 거절했습니다(${detail}). 인증키, 국가중점 API 활용 신청, 서비스 URL(vworldDomain)을 확인해 주세요.`, true);
      }
      throw new ZoneError(`토지이용계획 조회 오류(${detail})`, false);
    }
    const body = ((data as { landUses?: unknown }).landUses ?? {}) as { field?: unknown; totalCount?: unknown };
    const rows = (Array.isArray(body.field) ? body.field : body.field && typeof body.field === 'object' ? [body.field] : []) as Record<string, unknown>[];
    const total = toNumber(body.totalCount) ?? rows.length;
    record(shown, res.status, `${rows.length}건${total > rows.length ? `(전체 ${total}건 중)` : ''}`);
    return rows;
  }
}

/**
 * 좌표(WGS84)가 든 필지를 연속지적도에서 찾는다. 찾으면 status ok와 필지 번호, 주소, 그 자리에 필지가 없으면(NOT_FOUND) none.
 * 키, 권한 문제(2D 데이터 API를 고르지 않은 키 등)나 연결 실패는 fatal ZoneError, 그 밖의 오류는 ZoneError.
 */
export async function parcelAt(point: { lat: number; lng: number }, key: string, record: RecordRequest = () => {}): Promise<store.PointParcel> {
  const domain = vworldDomain();
  const query = new URLSearchParams({
    service: 'data', version: '2.0', request: 'GetFeature', data: 'LP_PA_CBND_BUBUN', geomFilter: `POINT(${point.lng} ${point.lat})`,
    crs: 'EPSG:4326', format: 'json', size: '10', page: '1', domain,
  }).toString();
  const shown = `${DATA_BASE}?${query}`;
  const url = `${DATA_BASE}?key=${encodeURIComponent(key)}&${query}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Referer: domain }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    record(shown, null, '연결 실패');
    throw new ZoneError(`브이월드에 연결하지 못했습니다(${hide(errText(e), key)})`, true);
  }
  const text = hide(await res.text(), key);
  if (!res.ok) {
    record(shown, res.status, '오류');
    throw new ZoneError(`브이월드 연속지적도 응답 오류(HTTP ${res.status}: ${text.slice(0, 120)})`, res.status >= 500);
  }
  let data: { response?: { status?: unknown; result?: { featureCollection?: { features?: unknown } } } };
  try {
    data = JSON.parse(text);
  } catch {
    record(shown, res.status, '읽지 못함');
    throw new ZoneError(`브이월드 연속지적도 응답을 읽지 못했습니다(${text.slice(0, 120)})`, true);
  }
  const checkedAt = new Date().toISOString();
  if (data.response?.status === 'NOT_FOUND') {
    record(shown, res.status, '그 자리에 필지 없음');
    return { status: 'none', pnu: null, addr: null, error: null, checkedAt };
  }
  const err = errorOf(data);
  if (err || data.response?.status !== 'OK') {
    const detail = err ? `${err.code}${err.text ? `: ${err.text}` : ''}` : `상태 ${String(data.response?.status ?? '없음')}`;
    record(shown, res.status, `오류 ${detail}`);
    if (err && /KEY|LIMIT|AUTH|DOMAIN|DENIED|SERVICE/i.test(err.code)) {
      throw new ZoneError(`브이월드가 연속지적도 조회를 거절했습니다(${detail}). 인증키에 2D 데이터 API를 함께 신청했는지 확인해 주세요.`, true);
    }
    throw new ZoneError(`연속지적도 조회 오류(${detail})`, false);
  }
  const features = data.response.result?.featureCollection?.features;
  const list = (Array.isArray(features) ? features : []) as { properties?: { pnu?: unknown; addr?: unknown } }[];
  const hit = list.find((f) => /^\d{19}$/.test(String(f.properties?.pnu ?? '')));
  if (!hit) {
    record(shown, res.status, `필지 번호 없음(${list.length}건)`);
    return { status: 'none', pnu: null, addr: null, error: null, checkedAt };
  }
  const pnu = String(hit.properties!.pnu);
  const addr = typeof hit.properties?.addr === 'string' && hit.properties.addr.trim() ? hit.properties.addr.trim() : null;
  record(shown, res.status, `필지 ${addr ?? pnu}`);
  return { status: 'ok', pnu, addr, error: null, checkedAt };
}

/** 필지 번호 하나의 토지이용계획을 읽어 재개발 쪽 구역만 남긴다(구역 안, 정비 구역 먼저). 응답이 비면 status empty. */
export async function lookupZones(pnu: string, key: string, record: RecordRequest = () => {}): Promise<LandZoneCheck> {
  const rows = await landUseRows(pnu, key, record);
  const checkedAt = new Date().toISOString();
  if (!rows.length) return { status: 'empty', zones: [], checkedAt, error: null };
  const zones: LandZone[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const name = String(r.prposAreaDstrcCodeNm ?? '').trim();
    const kind = zoneKind(name);
    if (!kind) continue;
    // 저촉 여부를 모르면 안에 있는 것으로 본다(경고를 빼먹지 않게).
    const overlap = String(r.cnflcAtNm ?? '').trim() || OVERLAP[String(r.cnflcAt ?? '')] || '포함';
    const { notice, org } = noticeOf(r.manageNo);
    const id = `${name}|${overlap}|${notice}`;
    if (seen.has(id)) continue;
    seen.add(id);
    zones.push({ kind, name, overlap, notice, org });
  }
  zones.sort((a, b) => rank(OVERLAP_ORDER, a.overlap) - rank(OVERLAP_ORDER, b.overlap) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return { status: 'ok', zones, checkedAt, error: null };
}

let running: Promise<string> | null = null;

/**
 * 아직 구역을 안 본(또는 RECHECK_DAYS가 지났거나 실패한) 필지의 토지이용계획을 읽어 저장한다. 그 전에 필지를 아직 못 찾은 네이버 아파트 단지는
 * 단지 좌표로 필지부터 찾는다(찾은 것은 다시 찾지 않고 실패한 것만 다시). 둘 다 한 번에 MAX_LOTS곳까지.
 * 결과 한 줄을 돌려주고 마지막 결과로 남긴다. 키가 없거나 토지이용계획 쪽 키, 서비스 문제면 오류를 던진다
 * (좌표 필지 찾기만 거절되면 그 단지들은 건너뛰고 결과 줄에 까닭을 붙인다). 이미 확인하는 중이면 그 결과를 기다린다.
 */
export function checkZones(record: RecordRequest = () => {}): Promise<string> {
  running ??= check(record).finally(() => {
    running = null;
  });
  return running;
}

function setLast(ok: boolean, text: string) {
  store.setSetting(LAST_KEY, JSON.stringify({ at: new Date().toISOString(), ok, text }));
}

async function check(record: RecordRequest): Promise<string> {
  const key = vworldKey();
  if (!key) throw new Error('브이월드 인증키가 없습니다. config/local.json에 vworldKey를 넣어 주세요(README의 집터 탭 참고).');
  const known = store.zoneChecks();
  const found = store.pointParcels();
  const since = Date.now() - RECHECK_DAYS * 86400000;
  const lots = new Map<string, string>();
  /** 단지 좌표로 필지를 찾을 네이버 아파트(단지 키 → 좌표) */
  const points = new Map<string, { lat: number; lng: number }>();
  const due = (lot: string) => {
    const c = known.get(lot);
    return !c || c.status === 'error' || Date.parse(c.checkedAt) < since;
  };
  for (const l of buildListingViews()) {
    const z = l.zone;
    if (l.status !== 'active' || !z?.lot) continue;
    if (z.pnu) {
      if (due(z.lot)) lots.set(z.lot, z.pnu);
    } else if (z.basis === 'point' && z.point && (!found.has(z.lot) || found.get(z.lot)!.status === 'error')) {
      points.set(z.lot, z.point);
    }
  }
  const pointCount = { ok: 0, none: 0, failed: 0 };
  let pointStop: string | null = null;
  const pointBatch = [...points].slice(0, MAX_LOTS);
  for (const [lot, point] of pointBatch) {
    try {
      const p = await parcelAt(point, key, record);
      store.savePointParcel(lot, point, p);
      if (p.status === 'ok' && p.pnu) {
        pointCount.ok++;
        if (due(lot)) lots.set(lot, p.pnu);
      } else pointCount.none++;
    } catch (e) {
      const message = errText(e);
      if (e instanceof ZoneError && e.fatal) {
        pointStop = message;
        break;
      }
      pointCount.failed++;
      store.savePointParcel(lot, point, { status: 'error', pnu: null, addr: null, error: message, checkedAt: new Date().toISOString() });
    }
    await wait(PAUSE_MS);
  }
  const batch = [...lots].slice(0, MAX_LOTS);
  // 같은 필지(경매 물건과 네이버 단지가 같은 필지일 때)는 한 번만 부르고 결과를 키마다 저장한다.
  const byPnu = new Map<string, string[]>();
  for (const [lot, pnu] of batch) byPnu.set(pnu, [...(byPnu.get(pnu) ?? []), lot]);
  const count = { inside: 0, edge: 0, clear: 0, empty: 0, failed: 0 };
  let streak = 0;
  for (const [pnu, keys] of byPnu) {
    try {
      const c = await lookupZones(pnu, key, record);
      for (const lot of keys) store.saveZoneCheck(lot, pnu, c);
      streak = 0;
      const n = keys.length;
      if (c.status === 'empty') count.empty += n;
      else if (c.zones.some((z) => z.overlap !== '접함')) count.inside += n;
      else if (c.zones.length) count.edge += n;
      else count.clear += n;
    } catch (e) {
      const message = errText(e);
      const done = count.inside + count.edge + count.clear + count.empty;
      if ((e instanceof ZoneError && e.fatal) || streak + 1 >= MAX_STREAK) {
        const text = `${message}${streak + 1 >= MAX_STREAK ? ` (실패가 ${MAX_STREAK}번 이어져 멈춤)` : ''}${done ? ` (그 전까지 ${done}곳 확인)` : ''}`;
        setLast(false, text);
        throw new Error(text);
      }
      streak++;
      count.failed += keys.length;
      for (const lot of keys) store.saveZoneCheck(lot, pnu, { status: 'error', zones: [], checkedAt: new Date().toISOString(), error: message });
    }
    await wait(PAUSE_MS);
  }
  const rest = lots.size - batch.length;
  const parts = [
    count.inside ? `구역 안 ${count.inside}곳` : '',
    count.edge ? `경계에 붙음 ${count.edge}곳` : '',
    count.clear ? `없음 ${count.clear}곳` : '',
    count.empty ? `응답 없음 ${count.empty}곳` : '',
    count.failed ? `실패 ${count.failed}곳` : '',
  ].filter(Boolean);
  const pointParts = [
    pointCount.ok ? `찾음 ${pointCount.ok}곳` : '',
    pointCount.none ? `필지 없음 ${pointCount.none}곳` : '',
    pointCount.failed ? `실패 ${pointCount.failed}곳` : '',
    points.size > pointBatch.length && !pointStop ? `남은 ${points.size - pointBatch.length}곳은 다음에` : '',
  ].filter(Boolean);
  const text = [
    batch.length ? `구역 확인 ${batch.length}곳: ${parts.join(', ')}${rest > 0 ? `, 남은 ${rest}곳은 다음에` : ''}` : '새로 볼 필지가 없습니다',
    pointParts.length ? `네이버 단지 좌표로 필지 찾기: ${pointParts.join(', ')}` : '',
    pointStop ? `네이버 단지 좌표로 필지 찾기 멈춤: ${pointStop}` : '',
  ].filter(Boolean).join(' / ');
  setLast(!pointStop, text);
  return text;
}
