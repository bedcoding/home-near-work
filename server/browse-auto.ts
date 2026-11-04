import { randomUUID } from 'node:crypto';
import * as store from './db.js';
import type { Area } from '../shared/types.js';
import { BROWSE_SCOPES_KEY, readBrowseScopes } from './browse-settings.js';
import { sameDabangRegionScope, type DabangRegionScope } from './browse-scope.js';
import { withLinkHints } from './link-hints.js';
import { knownStations } from './station-catalog.js';
import { distanceM } from './geo.js';
import { naverAreaJob, naverPresetState } from './naver-preset.js';
import naverLedger from './naver-ledger.js';

const KEY = 'browse_auto_state';
const QUEUED_TTL = 24 * 60 * 60 * 1000;
const SIGNAL_TTL = 3 * 60 * 1000;
const UNRESOLVED = new Set(['queued', 'running', 'paused']);
const TERMINAL = new Set(['complete', 'partial', 'failed', 'expired']);
type Status = 'queued' | 'running' | 'paused' | 'complete' | 'partial' | 'failed' | 'expired';
type AutoSite = 'dabang' | 'zigbang' | 'naver';
const SITES: AutoSite[] = ['dabang', 'zigbang', 'naver'];
interface ZigbangStation { stationId: string; radiusKm: 1; url: string }
type TourArea = Pick<Area, 'id' | 'name' | 'lat' | 'lng' | 'radiusM' | 'region' | 'purpose'> & { dabangRegions?: DabangRegionScope[]; zigbangStation?: ZigbangStation; naver?: ReturnType<typeof naverAreaJob> };
interface AutoConfig { enabled: boolean; areaIds: number[]; sites: AutoSite[]; enabledAt: number }
interface AutoRun {
  id: string; trigger: 'scheduled' | 'manual'; slot: number | null; status: Status;
  createdAt: number; updatedAt: number; clientId?: string; runId?: string;
  totalJobs: number; completeJobs: number; partialJobs: number; failedJobs: number;
  message: string; areas: TourArea[]; sites: AutoSite[]; areaIds?: number[]; oneOff?: boolean;
}
interface SavedState { config: AutoConfig; last: AutoRun | null; lastScheduledSlot: number }
const inputError = (message = '자동 순회 요청이 올바르지 않습니다.', statusCode = 400) => Object.assign(new Error(message), { statusCode });
const conflict = (message: string): never => { throw inputError(message, 409); };
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const ident = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(v);
const newState = (): SavedState => ({ config: { enabled: false, areaIds: [], sites: ['dabang'], enabledAt: 0 }, last: null, lastScheduledSlot: 0 });

function normalizedSites(input: unknown): AutoSite[] {
  if (!Array.isArray(input) || input.length > 100 || !input.every((site) => SITES.includes(site))) throw inputError();
  return SITES.filter((site) => input.includes(site));
}
function normalizedAreaIds(input: unknown): number[] {
  if (!Array.isArray(input) || input.length > 100 || !input.every((id) => count(id) && id > 0)) throw inputError();
  return [...new Set(input)] as number[];
}

function read(): SavedState {
  const raw = store.getSetting(KEY);
  if (!raw) return newState();
  try {
    const value = JSON.parse(raw) as SavedState;
    if (!value || typeof value.config?.enabled !== 'boolean' || !Array.isArray(value.config.areaIds)
      || !value.config.areaIds.every((id) => count(id) && id > 0) || !count(value.config.enabledAt)
      || !count(value.lastScheduledSlot) || (value.last && (!ident(value.last.id) || !Array.isArray(value.last.areas)
      || ![...UNRESOLVED, ...TERMINAL].includes(value.last.status)))) throw new Error('invalid');
    value.config.sites = value.config.sites === undefined ? ['dabang'] : normalizedSites(value.config.sites);
    if (value.config.enabled && !value.config.sites.length) throw new Error('invalid');
    if (value.last) {
      value.last.sites = value.last.sites === undefined ? ['dabang'] : normalizedSites(value.last.sites);
      if (!value.last.sites.length) throw new Error('invalid');
      if (value.last.areaIds !== undefined) value.last.areaIds = normalizedAreaIds(value.last.areaIds);
      if (value.last.oneOff && !value.last.areaIds?.length) throw new Error('invalid');
    }
    return value;
  } catch { throw inputError('자동 순회 설정을 읽지 못했습니다. 설정을 다시 저장해 주세요.', 409); }
}
function save(value: SavedState) { store.setSetting(KEY, JSON.stringify(value)); }
function expired(value: SavedState) {
  const run = value.last;
  if (run?.status === 'queued' && !run.clientId && Date.now() - run.createdAt >= QUEUED_TTL) {
    run.status = 'expired'; run.updatedAt = Date.now();
    run.message = '24시간 동안 확장 연결을 확인하지 못해 실행하지 않았습니다.';
    save(value);
  }
  return value;
}
function schedule() {
  const rawTime = store.getSetting('auto_check_time');
  const rawDay = store.getSetting('auto_check_day');
  return {
    time: rawTime === 'off' ? null : rawTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(rawTime) ? rawTime : '22:30',
    day: rawDay && /^[0-6]$/.test(rawDay) ? Number(rawDay) : null,
  };
}
function stationFor(area: Pick<Area, 'lat' | 'lng'>, stations: ReturnType<typeof withLinkHints>): ZigbangStation | null {
  const nearest = stations.map((station) => ({ station, distance: distanceM(area.lat, area.lng, station.lat, station.lng) }))
    .filter(({ distance }) => distance <= 2000).sort((a, b) => a.distance - b.distance)[0]?.station;
  if (!nearest?.zigbangId || !/^[1-9]\d{0,19}$/.test(nearest.zigbangId)) return null;
  const stationId = nearest.zigbangId;
  return { stationId, radiusKm: 1, url: `https://www.zigbang.com/home/oneroom/subways/${stationId}/items` };
}
function stationHints() {
  try { return withLinkHints(knownStations()); }
  catch { return []; }
}
type PlannedJob = { site: 'dabang'; scope: DabangRegionScope } | { site: 'zigbang'; station: ZigbangStation } | {site:'naver';scope:ReturnType<typeof naverAreaJob>['scope']};
function plannedJobs(areas: TourArea[], sites: AutoSite[]): PlannedJob[] {
  const jobs: PlannedJob[] = [];
  for (const area of areas) for (const site of sites) {
    if(area.region) { if(site==='naver' && area.naver)jobs.push({site,scope:area.naver.scope});continue; }
    if (site === 'dabang') for (const scope of area.dabangRegions ?? []) jobs.push({ site, scope });
    else if (site==='zigbang' && area.zigbangStation) jobs.push({ site, station: area.zigbangStation });
  }
  return jobs;
}
function plan(areaIds: number[], sites: AutoSite[]): TourArea[] {
  if (!areaIds.length || !sites.length) throw inputError('조회할 지역과 사이트를 하나 이상 선택해 주세요.', 409);
  const all = store.listAreas();
  let scopes: Record<string, DabangRegionScope[]> = {};
  try { if (sites.includes('dabang')) scopes = readBrowseScopes(store.getSetting(BROWSE_SCOPES_KEY), all); }
  catch { throw inputError('지역 설정이 바뀌었습니다. 저장된 동별 범위를 확인해 주세요.', 409); }
  const stations = sites.includes('zigbang') ? stationHints() : [];
  const unique = new Map<string, TourArea>();
  for (const id of areaIds) {
    // Legacy source-query routes remain usable when their station alert is switched off.
    const area = all.find((a) => a.id === id && (a.enabled || a.purpose === 'alert'));
    if (!area || !Number.isFinite(area.lat) || !Number.isFinite(area.lng) || Math.abs(area.lat)>90 || Math.abs(area.lng)>180
      || !Number.isFinite(area.radiusM) || area.radiusM<=0 || area.radiusM>50000)throw inputError('선택한 지역의 위치와 반경을 확인할 수 없습니다.',409);
    if (area?.region) {
      if(!sites.includes('naver') || !area.enabled || area.purpose==='alert')throw inputError('구나 동 예약 조회에는 네이버와 켜진 수집 지역을 선택해 주세요.',409);
      const naver=naverAreaJob(area);
      unique.set(`naver:${naver.scope.code}`,{id:area.id,name:area.name,lat:area.lat,lng:area.lng,radiusM:area.radiusM,region:area.region,purpose:area.purpose,naver});
      continue;
    }
    if(sites.every(site=>site==='naver'))throw inputError('네이버 예약에는 구나 동 수집 지역을 선택해 주세요.',409);
    if (!area || !Number.isFinite(area.lat) || !Number.isFinite(area.lng) || Math.abs(area.lat) > 90 || Math.abs(area.lng) > 180
      || !Number.isFinite(area.radiusM) || area.radiusM <= 0 || area.radiusM > 50000) throw inputError('선택한 지역이 꺼져 있거나 위치와 반경을 확인할 수 없습니다. 자동 순회를 시작하지 않았습니다.', 409);
    if (sites.includes('dabang') && !scopes[id]?.length) throw inputError('선택한 지역의 다방 동별 범위가 없습니다. 자동 순회를 시작하지 않았습니다.', 409);
    const dabangRegions = sites.includes('dabang') ? [...new Map(scopes[id].map((s) => [new URL(s.url).searchParams.get('search_id'), s])).values()] : undefined;
    const zigbangStation = sites.includes('zigbang') ? stationFor(area, stations) : null;
    if (sites.includes('zigbang') && !zigbangStation) throw inputError('선택한 지역의 직방 역 바로가기 정보를 확인할 수 없습니다. 2km 이내 역 정보를 먼저 확인해 주세요.', 409);
    const { name, lat, lng, radiusM } = area;
    unique.set(`${lat}|${lng}|${radiusM}|${JSON.stringify(dabangRegions ?? [])}|${JSON.stringify(zigbangStation)}`,
      { id, name, lat, lng, radiusM, ...(dabangRegions ? { dabangRegions } : {}), ...(zigbangStation ? { zigbangStation } : {}) });
  }
  const result = [...unique.values()];
  if(sites.includes('naver') && !result.some(area=>area.naver))throw inputError('네이버 예약에 사용할 구나 동 수집 지역을 하나 이상 선택해 주세요.',409);
  if(sites.some(site=>!plannedJobs(result,sites).some(job=>job.site===site)))throw inputError('선택한 각 사이트에 사용할 지역을 하나 이상 선택해 주세요.',409);
  // 회차 전체의 완료 증거가 서버의 2,048개 보관 한도 안에 있어야 한다.
  if (plannedJobs(result, sites).length > 2000) throw inputError('조회 항목은 2,000개 이하로 선택해 주세요.');
  return result;
}
function publicState(value: SavedState) {
  let configuredJobs = 0, configError: string | null = null;
  try { configuredJobs = plannedJobs(plan(value.config.areaIds, value.config.sites), value.config.sites).length; }
  catch (error) { configError = error instanceof Error ? error.message : '조회 범위 확인이 필요합니다.'; }
  const r = value.last;
  const stale = !!r?.clientId && UNRESOLVED.has(r.status) && Date.now() - r.updatedAt >= SIGNAL_TTL;
  const stations = stationHints();
  const zigbangAreaIds = store.listAreas().filter((area) => area.enabled && !area.region && Number.isFinite(area.lat) && Number.isFinite(area.lng)
    && Math.abs(area.lat) <= 90 && Math.abs(area.lng) <= 180 && Number.isFinite(area.radiusM) && area.radiusM > 0 && area.radiusM <= 50000
    && stationFor(area, stations)).map((area) => area.id);
  let naverPreset:ReturnType<typeof naverPresetState>=null,naverError:string|null=null;
  try {naverPreset=naverPresetState();}catch(error){naverError=error instanceof Error ? error.message : '네이버 필터를 확인해 주세요.';}
  const naverAreaIds=store.listAreas().filter(area=>area.enabled && area.purpose!=='alert' && ['gu','dong'].includes(area.region?.kind || '')).map(area=>area.id);
  return { enabled: value.config.enabled, areaIds: value.config.areaIds, sites: value.config.sites, zigbangAreaIds, naverAreaIds,naverPreset,naverError,configuredJobs, configError, schedule: schedule(),
    last: r ? { id: r.id, trigger: r.trigger, slot: r.slot, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt,
      ...(r.runId ? { runId: r.runId } : {}), totalJobs: r.totalJobs, completeJobs: r.completeJobs, partialJobs: r.partialJobs,
      failedJobs: r.failedJobs, stale, message: stale ? '확장 실행 신호가 늦습니다. 기존 조회 상태를 확인해 주세요. 중복 실행하지 않고 기다립니다.' : r.message } : null };
}
export function browseAutoState() { return publicState(expired(read())); }

/** GU collection now runs with the normal scheduler. Avoid repeating the old two-room tour too. */
export function migrateDabangSchedule(): boolean {
  if (!store.listAreas().some(area => area.enabled && area.purpose !== 'alert' && area.region?.kind === 'gu')
    || !store.getSetting(KEY)) return false;
  const value = expired(read());
  if (!value.config.sites.includes('dabang') || value.last && UNRESOLVED.has(value.last.status)) return false;
  store.setSetting('browse_auto_before_dabang_gu', JSON.stringify(value.config));
  value.config.sites = value.config.sites.filter(site => site !== 'dabang');
  if (!value.config.sites.length) { value.config.enabled = false; value.config.areaIds = []; }
  save(value);
  return true;
}

export function setBrowseAuto(input: { enabled?: unknown; areaIds?: unknown; sites?: unknown }) {
  if (!input || typeof input !== 'object' || typeof input.enabled !== 'boolean' || !Array.isArray(input.areaIds)
    || input.areaIds.length > 100 || !input.areaIds.every((id) => count(id) && id > 0)) throw inputError();
  const areaIds = normalizedAreaIds(input.areaIds);
  const value = expired(read());
  const sites = input.sites === undefined ? value.config.sites : normalizedSites(input.sites);
  if (input.enabled) plan(areaIds, sites);
  const changed = value.config.enabled !== input.enabled || JSON.stringify(value.config.areaIds) !== JSON.stringify(areaIds)
    || JSON.stringify(value.config.sites) !== JSON.stringify(sites);
  if (changed) {
    value.config = { enabled: input.enabled, areaIds, sites, enabledAt: Date.now() };
    if (value.last?.status === 'queued' && !value.last.clientId) {
      value.last.status = 'expired'; value.last.updatedAt = Date.now();
      value.last.message = '설정이 바뀌어 아직 시작하지 않은 요청을 취소했습니다.';
    }
    save(value);
  }
  return publicState(value);
}
/** A changed schedule starts from its next slot, never immediately catches up an old slot. */
export function resetBrowseAutoSchedule() {
  const value = read();
  value.config.enabledAt = Date.now();
  if (value.last?.trigger === 'scheduled' && value.last.status === 'queued' && !value.last.clientId) {
    value.last.status = 'expired'; value.last.updatedAt = Date.now();
    value.last.message = '예약 시각이 바뀌어 아직 시작하지 않은 요청을 취소했습니다.';
  }
  save(value);
}
function enqueue(value: SavedState, trigger: AutoRun['trigger'], slot: number | null, selection?: { areaIds: number[]; sites: AutoSite[] }) {
  if (value.last && UNRESOLVED.has(value.last.status)) return conflict('아직 끝나지 않은 자동 순회가 있습니다. 최근 결과에서 기존 조회 상태를 확인해 주세요.');
  const sites = [...(selection?.sites ?? value.config.sites)];
  const areaIds = [...(selection?.areaIds ?? value.config.areaIds)];
  const areas = plan(areaIds, sites);
  const now = Date.now();
  value.last = { id: randomUUID(), trigger, slot, status: 'queued', createdAt: now, updatedAt: now,
    totalJobs: plannedJobs(areas, sites).length, completeJobs: 0, partialJobs: 0, failedJobs: 0,
    message: '크롬 확장 연결을 기다립니다. 다른 순회가 실행·중단 상태이면 먼저 마쳐 주세요.', areas, sites, areaIds,
    ...(selection ? { oneOff: true } : {}) };
  if (slot !== null) value.lastScheduledSlot = slot;
  save(value);
  return publicState(value);
}
export function runBrowseAutoNow(input?: { areaIds?: unknown; sites?: unknown }) {
  if (input !== undefined && (!input || typeof input !== 'object')) throw inputError();
  if (input?.areaIds === undefined && input?.sites === undefined) return enqueue(expired(read()), 'manual', null);
  if (input?.areaIds === undefined || input?.sites === undefined) throw inputError('한 번만 조회할 지역과 사이트를 함께 지정해 주세요.');
  return enqueue(expired(read()), 'manual', null, { areaIds: normalizedAreaIds(input.areaIds), sites: normalizedSites(input.sites) });
}
/** Independent of regular collectors' recent-run suppression and full-run busy state. */
export function enqueueScheduledBrowse(slot: number): boolean {
  migrateDabangSchedule();
  const value = expired(read());
  if (!count(slot) || !value.config.enabled || !schedule().time || slot <= value.config.enabledAt
    || slot <= value.lastScheduledSlot || value.last && UNRESOLVED.has(value.last.status)) return false;
  try { enqueue(value, 'scheduled', slot); return true; }
  catch (error) {
    if (!(error instanceof Error) || !('statusCode' in error)) throw error;
    const now = Date.now();
    value.lastScheduledSlot = slot;
    value.last = { id: randomUUID(), trigger: 'scheduled', slot, status: 'failed', createdAt: now, updatedAt: now,
      totalJobs: 0, completeJobs: 0, partialJobs: 0, failedJobs: 0, areas: [], sites: [...value.config.sites], message: error.message };
    save(value);
    return false;
  }
}
function validateClient(input: { clientId?: unknown; version?: unknown }) {
  if (!input || !ident(input.clientId)) throw inputError();
  return input.clientId;
}
export function pollBrowseAuto(input: { clientId?: unknown; version?: unknown }) {
  const clientId = validateClient(input);
  if (typeof input.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(input.version)) throw inputError();
  const value = expired(read());
  const run = value.last;
  if (!run || !UNRESOLVED.has(run.status) || run.clientId && run.clientId !== clientId) return { request: null };
  const [major, minor, patch] = input.version.split('.').map(Number);
  const minimumPatch = run.sites.includes('naver') ? 21 : run.sites.includes('zigbang') ? 9 : 5;
  if (!(major > 0 || minor > 8 || minor === 8 && patch >= minimumPatch)) return { request: null };
  if (!run.clientId) {
    try {
      const selection = run.oneOff ? { areaIds: run.areaIds!, sites: run.sites } : value.config;
      if (JSON.stringify(selection.sites) !== JSON.stringify(run.sites)) throw new Error('changed');
      const current = plan(selection.areaIds, selection.sites);
      if (JSON.stringify(current) !== JSON.stringify(run.areas)) throw new Error('changed');
    } catch {
      run.status = 'failed'; run.updatedAt = Date.now(); run.message = '예약 후 지역 범위나 저장한 필터가 바뀌어 실행하지 않았습니다. 조건을 다시 저장해 주세요.';
      save(value); return { request: null };
    }
    run.clientId = clientId; run.updatedAt = Date.now();
    run.message = '확장에 시작 요청을 전달했습니다. 실행 확인을 기다립니다.';
    save(value);
  }
  return { request: { id: run.id, areas: run.areas, sites: run.sites } };
}
function verifiedJobs(run: AutoRun): number {
  // The request ID is also the tour ID. Evidence must match each immutable scope,
  // and must have been stored after this request was created.
  let entries: unknown;
  try { entries = JSON.parse(store.getSetting('browse_receipts') ?? '[]'); } catch { return 0; }
  if (!Array.isArray(entries)) return 0;
  return plannedJobs(run.areas, run.sites).filter((job, index) => {
    const entry = entries.find((e) => e?.jobId === `${run.id}:${index}`);
    if (!entry || !count(entry.at) || entry.at < run.createdAt) return false;
    if(job.site==='naver') {
      const ledger=entry.naverLedger,coverage=entry.receipt?.naverCoverage;
      return ledger?.scope?.code===job.scope.code && ledger.scope.sort===job.scope.sort && naverLedger.matchesFilter(job.scope,ledger.scope.filter)
        && coverage?.complete===true && coverage.reason==='complete' && coverage.code===job.scope.code
        && ['pages','total','received','stored'].every(key=>count(coverage[key])) && coverage.pages>0
        && Array.isArray(ledger.ids) && ledger.pages===coverage.pages && ledger.total===coverage.total && ledger.ids.length===coverage.received
        && coverage.total===coverage.received && coverage.received===coverage.stored
        && naverLedger.coverage(ledger,coverage.stored).complete;
    }
    if (job.site === 'dabang') return sameDabangRegionScope(entry.scope, job.scope) && entry.receipt?.coverage?.complete === true;
    const coverage = entry.receipt?.zigbangCoverage;
    return !entry.scope && coverage?.stationId === job.station!.stationId && coverage.radiusKm === 1 && coverage.complete === true && coverage.reason === 'complete'
      && ['total', 'received', 'stored', 'excluded', 'missing', 'unreadable'].every((key) => count(coverage[key]))
      && coverage.total === coverage.received && coverage.stored + coverage.excluded === coverage.total && coverage.missing === 0 && coverage.unreadable === 0
      && entry.receipt.uniqueListings === coverage.stored && entry.receipt.excludedOutside === coverage.excluded
      && count(entry.receipt.responses) && entry.receipt.responses > 0;
  }).length;
}
export function reportBrowseAuto(input: {
  clientId?: unknown; requestId?: unknown; runId?: unknown; status?: unknown; totalJobs?: unknown;
  completeJobs?: unknown; partialJobs?: unknown; failedJobs?: unknown; message?: unknown;
}) {
  const clientId = validateClient(input);
  if (!ident(input.requestId) || !ident(input.runId) || !['running', 'paused', 'done', 'failed'].includes(String(input.status))
    || ![input.totalJobs, input.completeJobs, input.partialJobs, input.failedJobs].every(count)) throw inputError();
  const value = expired(read()), run = value.last;
  if (!run || run.id !== input.requestId || run.clientId !== clientId || input.runId !== run.id) return conflict('현재 자동 순회와 실행 응답이 다릅니다.');
  const total = input.totalJobs as number, complete = input.completeJobs as number, partial = input.partialJobs as number, failed = input.failedJobs as number;
  const preparing = total === 0 && complete + partial + failed === 0 && input.status !== 'done';
  if (!preparing && total !== run.totalJobs || complete + partial + failed > total) throw inputError('자동 순회 항목 수가 맞지 않습니다.');
  if (TERMINAL.has(run.status)) return { ok: true, ignored: true };
  const verified = Math.min(complete, verifiedJobs(run));
  run.runId = run.id; run.completeJobs = verified; run.partialJobs = partial; run.failedJobs = failed;
  run.updatedAt = Date.now();
  if (input.status === 'done') {
    run.status = verified === total && total > 0 ? 'complete' : failed === total ? 'failed' : 'partial';
    run.partialJobs = Math.max(partial, total - verified - failed);
    run.message = run.status === 'complete' ? '선택한 범위의 모든 목록과 서버 저장 또는 제외 판정을 확인했습니다.'
      : '전체 저장을 확인하지 못한 항목이 남아 있습니다. 최근 조회 결과를 확인해 주세요.';
  } else if (input.status === 'failed') {
    run.status = 'failed'; run.message = '자동 순회를 시작하거나 진행하지 못했습니다. 확장 연결과 최근 조회 결과를 확인해 주세요.';
  } else {
    run.status = input.status as 'running' | 'paused';
    run.message = run.status === 'running' ? '전용 탭에서 선택한 지역과 사이트를 순서대로 조회하고 있습니다.' : '조회가 중단됐습니다. 지역 순차 조회에서 상태를 확인하고 이어갈 수 있습니다.';
  }
  // Do not persist arbitrary client messages, which could contain private page contents.
  save(value);
  return { ok: true };
}
