import type { Area, CollectionCoverage } from '../shared/types.js';
import type { CollectContext, CollectedItem, Collector } from './collectors/types.js';
import { parseZigbangStationIds } from './zigbang-parse.js';
import {
  ZIGBANG_DETAILS_URL, ZIGBANG_HEADERS, ZIGBANG_SUBWAYS_URL, ZigbangStationLedger, zigbangDetailChunks, zigbangStationListUrl,
  zigbangPriceScopes, zigbangPricesMatch, zigbangStationPage, zigbangStationsFor, type ZigbangPriceScope, type ZigbangStationPlace,
} from './zigbang-client.js';

export interface ZigbangCollectDeps {
  fetch: typeof fetch;
  /** 배운 수도권 역 목록 */
  stations(): ZigbangStationPlace[];
  /** 역 목록 응답에서 배운다. 배웠으면 true. */
  learnStations(url: string, body: string): boolean;
  /** 번호 목록에 아직 있는 방은 상세를 못 받았어도 본 것으로 친다. */
  touch(sourceIds: string[], at: string): void;
  readSeen(): Record<string, number[]>;
  writeSeen(value: Record<string, number[]>): void;
  /** 받은 응답 원본을 조회 기록 폴더에 남긴다. */
  save(runId: number, name: string, body: string): void;
  delayMs: number;
  now?: () => string;
}

interface StationJob { area: Area; station: ZigbangStationPlace }
type StationPriceJob = StationJob & { scope: ZigbangPriceScope | null };

/**
 * 직방 역 1km 원룸을 공개 웹 클라이언트와 같은 요청으로 받는다. 역 번호 목록을 먼저 받고, 그 번호 전부의 상세를 15개씩 받는다.
 * 번호 목록의 모든 번호가 읽을 수 있는 상세로 돌아와야 그 역은 완료다. 구 전체가 아니라 고른 역들의 1km 범위다.
 */
export function createZigbangCollector(deps: ZigbangCollectDeps): Collector {
  return {
    id: 'zigbang', label: '직방', emptyOk: true, retainMissing: true, noTab: true,
    async collect(ctx: CollectContext) {
      const items = new Map<string, CollectedItem>();
      const limits = ctx.priceLimits;
      const scopes = zigbangPriceScopes(limits, ctx.rentalOnly);
      const verified = new Set<string>();
      let requested = false;
      let blocked = false;
      const pace = async () => {
        if (requested && deps.delayMs > 0) await ctx.session.page.waitForTimeout(deps.delayMs);
        requested = true;
      };
      const request = async (url: string, note: string, init?: RequestInit) => {
        await pace();
        if (ctx.stopped?.()) throw new Error('중단함');
        let response: Response;
        try { response = await deps.fetch(url, { ...init, headers: { ...ZIGBANG_HEADERS, ...init?.headers }, signal: AbortSignal.timeout(20000) }); }
        catch { ctx.session.record('zigbang', 'data', url, null, `${note}: 응답 시간 초과 또는 연결 실패`); throw new Error(`${note} 응답을 받지 못했습니다`); }
        ctx.session.record('zigbang', 'data', url, response.status, note);
        if (response.status === 403 || response.status === 429) { blocked = true; throw new Error(`사이트 응답 ${response.status}: 잠시 후 다시 확인해 주세요`); }
        if (!response.ok) throw new Error(`${note} 응답 오류 ${response.status}`);
        return response.text();
      };

      let stations = deps.stations();
      if (!stations.length) {
        try {
          const body = await request(ZIGBANG_SUBWAYS_URL, '수도권 역 목록');
          if (deps.learnStations(ZIGBANG_SUBWAYS_URL, body)) stations = deps.stations();
        } catch (error) { ctx.log(`직방 역 목록: ${error instanceof Error ? error.message : '받지 못함'}`); }
      }
      if (!stations.length) { ctx.partial('직방 역 목록을 받지 못해 역별 수집을 하지 못했습니다', !blocked); return []; }

      const jobs = new Map<string, StationJob>();
      for (const area of ctx.areas) {
        const plan = zigbangStationsFor(area, stations);
        if (!plan.stations.length) ctx.partial(`${area.name}: 범위 안 직방 역을 찾지 못했습니다`, false);
        if (plan.skipped) ctx.partial(`${area.name}: 직방 역 ${plan.skipped}곳은 역 수 한도로 건너뜀`, false);
        if (plan.stations.length && area.region) {
          ctx.log(`직방 ${area.name}: ${area.region.kind === 'gu' ? '구' : '동'} 전체가 아니라 ${area.region.kind === 'gu' ? '구 안' : '근처'} 역 ${plan.stations.length}곳의 1km 원룸을 봅니다`);
        }
        // 여러 지역에 걸친 역은 한 번만 받는다(먼저 고른 지역에 표시).
        for (const station of plan.stations) if (!jobs.has(station.id)) jobs.set(station.id, { area, station });
      }
      const planned = [...jobs.values()].flatMap(job => scopes.map(scope => ({ ...job, scope })));
      const labelOf = (job: StationPriceJob) => `${job.station.name} 1km 원룸${job.scope ? ` (${job.scope.label})` : ''}`;
      const rowOf = (job: StationPriceJob, ledger: ZigbangStationLedger | null, reason?: string): CollectionCoverage => {
        const r = ledger?.result();
        return { areaId: job.area.id, areaName: job.area.name, category: `zigbang-${job.station.id}${job.scope?.suffix ?? ''}`, label: labelOf(job),
          pages: r?.pages ?? 0, totalPages: r?.totalPages ?? null, total: r?.total ?? null, received: r?.received ?? 0, stored: 0,
          complete: !reason && !!r?.complete, reason: reason ?? r?.reason ?? '조회 대기' };
      };
      for (const job of planned) ctx.coverage?.(rowOf(job, null), []);
      ctx.log(`직방: 역 ${jobs.size}곳의 1km 원룸을 확인합니다 (${[...jobs.values()].map((j) => j.station.name).join(', ')})`);

      const seenUpdates: Record<string, number[]> = {};
      for (const [jobIndex, job] of planned.entries()) {
        if (ctx.stopped?.() || blocked) break;
        const { station, area, scope } = job;
        const label = labelOf(job);
        const artifact = station.id + (scope?.suffix ?? '');
        const ledger = new ZigbangStationLedger();
        const ids = new Set<string>();
        const mismatches = new Set<string>();
        const pageUrl = zigbangStationPage(station.id);
        let baseline: ReturnType<typeof parseZigbangStationIds> = null;
        let failure = '';
        try {
          ctx.progress(`직방 ${label} 번호 목록 받는 중`);
          const listUrl = zigbangStationListUrl(station.id, scope);
          const listBody = await request(listUrl, `${label} 번호 목록`);
          deps.save(ctx.runId, `${artifact}-list.json`, listBody);
          const expected = ledger.acceptList(listBody);
          if (!expected) throw new Error('번호 목록을 읽지 못했습니다');
          baseline = parseZigbangStationIds(listUrl, listBody);
          if (!scope) {
            if (baseline) seenUpdates[baseline.key] = baseline.ids;
            deps.touch(expected.map(String), deps.now?.() ?? new Date().toISOString());
          }
          const chunks = zigbangDetailChunks(expected);
          for (const [index, chunk] of chunks.entries()) {
            if (ctx.stopped?.()) { failure = '중단함'; break; }
            ctx.progress(`직방 ${label} 상세 ${index + 1}/${chunks.length} 받는 중 (받은 방 ${ids.size}/${expected.length})`);
            const body = await request(ZIGBANG_DETAILS_URL, `${label} 상세 ${index + 1}/${chunks.length}`,
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemIds: chunk }) });
            deps.save(ctx.runId, `${artifact}-details-${index + 1}.json`, body);
            const requestedIds = scope ? new Set(chunk.map(String)) : null;
            for (const item of ledger.acceptDetails(body, chunk)) {
              const { sourceId, prices } = item.listing;
              if (scope) {
                const inScope = zigbangPricesMatch(prices, limits, scope, ctx.rentalOnly);
                const expectedId = requestedIds?.has(sourceId) ?? false;
                if (expectedId && !inScope) mismatches.add(sourceId);
                if (!zigbangPricesMatch(prices, limits, undefined, ctx.rentalOnly)) continue;
                const previous = items.get(sourceId);
                if (previous && verified.has(sourceId) && (!expectedId || !inScope || previous.listing.prices[0]?.deal !== prices[0]?.deal)) {
                  if (expectedId && inScope) mismatches.add(sourceId);
                  ids.add(sourceId);
                  continue;
                }
                if (expectedId && inScope) verified.add(sourceId);
              }
              ids.add(sourceId);
              items.set(sourceId, { ...item, pageUrl, screenshot: null });
            }
            ctx.coverage?.(rowOf(job, ledger, `상세 받는 중 (${ids.size}/${expected.length})`), [...ids]);
          }
        } catch (error) {
          failure = error instanceof Error ? error.message.split('\n')[0] : '역 목록 확인 실패';
        }
        if (failure) ledger.fail(failure);
        if (mismatches.size) ledger.fail(`상세 ${mismatches.size}건이 요청한 가격 또는 거래 조건과 일치하지 않음`);
        const row = rowOf(job, ledger);
        if (scope && row.complete && baseline) seenUpdates[baseline.key] = baseline.ids;
        ctx.coverage?.(row, [...ids]);
        deps.save(ctx.runId, `${artifact}-coverage.json`, JSON.stringify({ ...row, stationId: station.id, savedIds: [...ids] }));
        if (!row.complete) ctx.partial(`${label}: ${row.reason}`, !blocked);
        ctx.log(`직방 ${area.name}, ${label}: 번호 ${row.total ?? '?'}건, 상세 ${row.received}건, ${row.complete ? '전체 확인' : `일부 확인 (${row.reason})`}`);
        if (planned[jobIndex + 1]?.station.id !== station.id) await ctx.session.rest().catch(() => {});
      }
      if (Object.keys(seenUpdates).length) deps.writeSeen({ ...deps.readSeen(), ...seenUpdates });
      return [...items.values()];
    },
  };
}
