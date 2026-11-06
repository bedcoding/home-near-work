import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR, PAGE_DELAY_MS } from '../config.js';
import { DABANG_CATEGORIES, DABANG_HEADERS, dabangListUrl, DabangPagination, dabangTargets } from '../dabang-client.js';
import type { CollectionCoverage } from '../../shared/types.js';
import type { CollectedItem, Collector } from './types.js';

export const dabang: Collector = {
  id: 'dabang', label: '다방', emptyOk: true, retainMissing: true,
  async collect(ctx) {
    const items = new Map<string, CollectedItem>();
    const { targets, skipped, unreadable } = dabangTargets(ctx.areas);
    for (const { area, by } of skipped) ctx.log(`다방 ${area.name}: ${by} 구 범위 안이라 따로 조회하지 않습니다`);
    for (const area of unreadable) ctx.partial(`${area.name}: 다방 조회 범위를 만들 수 없습니다`, false);
    const boundsOf = new Map(targets.map(t => [t.area.id, t.bounds]));
    const areas = targets.map(t => t.area);
    const dabangBounds = (area: (typeof areas)[number]) => boundsOf.get(area.id) ?? null;
    const dir = path.join(RUNS_DIR, String(ctx.runId), 'dabang');
    fs.mkdirSync(dir, { recursive: true });
    for (const area of areas) if (dabangBounds(area)) for (const category of DABANG_CATEGORIES) {
      ctx.coverage?.({ areaId: area.id, areaName: area.name, category: category.id, label: category.label,
        pages: 0, totalPages: null, total: null, received: 0, stored: 0, complete: false, reason: '조회 대기' }, []);
    }
    let blocked = false;
    for (const area of areas) {
      const bounds = dabangBounds(area);
      if (!bounds) continue;
      for (const category of DABANG_CATEGORIES) {
        if (ctx.stopped?.() || blocked) break;
        const pagination = new DabangPagination();
        const ids = new Set<string>();
        let failure = '';
        const url = `https://www.dabangapp.com/map/${category.path}?${new URLSearchParams({
          m_lat: String((bounds.sw.lat + bounds.ne.lat) / 2), m_lng: String((bounds.sw.lng + bounds.ne.lng) / 2), m_zoom: '13',
        })}`;
        // The website provides the visual reference; data requests use the full GU bounds, not its current viewport.
        await ctx.session.goto('dabang', url).catch(() => ctx.log(`다방 ${area.name} ${category.label}: 지도 화면을 열지 못해 공개 목록으로 확인합니다`));
        let screenshot: string | null = null;
        const publish = (): CollectionCoverage => {
          const result = pagination.result();
          const row: CollectionCoverage = { areaId: area.id, areaName: area.name, category: category.id, label: category.label,
            ...result, stored: 0, complete: !failure && result.complete, reason: failure || result.reason };
          ctx.coverage?.(row, [...ids]);
          return row;
        };
        // result() is final-only: do not call it while pages are still being read.
        try {
          for (let page = 1; page <= 2000; page++) {
            if (ctx.stopped?.()) { failure = '중단함'; break; }
            ctx.progress(`다방, ${area.name}, ${category.label}, ${page}페이지 읽는 중 (고유 ${ids.size}건)`);
            const requestUrl = dabangListUrl(category.id, bounds, page);
            let response: Response;
            try { response = await fetch(requestUrl, { headers: DABANG_HEADERS, signal: AbortSignal.timeout(20000) }); }
            catch { ctx.session.record('dabang', 'data', requestUrl, null, '목록 응답 시간 초과 또는 연결 실패'); throw new Error('목록 응답을 받지 못했습니다'); }
            ctx.session.record('dabang', 'data', requestUrl, response.status, `${area.name}, ${category.label}, ${page}페이지`);
            if (response.status === 403 || response.status === 429) { blocked = true; throw new Error(`사이트 응답 ${response.status}: 잠시 후 다시 확인해 주세요`); }
            if (!response.ok) throw new Error(`목록 응답 오류 ${response.status}`);
            const body = await response.text();
            fs.writeFileSync(path.join(dir, `${area.id}-${category.id}-${page}.json`), body);
            const { parsed, more, totalPages } = pagination.accept(body, page, category.id);
            for (const item of parsed.items) {
              ids.add(item.listing.sourceId);
              items.set(item.listing.sourceId, { ...item, pageUrl: requestUrl, screenshot });
            }
            ctx.log(`다방 ${area.name} ${category.label}: ${page}/${totalPages}페이지, 일반 ${parsed.regularCount}건, 누적 고유 ${pagination.ids.size}/${parsed.total}건`);
            ctx.coverage?.({ areaId: area.id, areaName: area.name, category: category.id, label: category.label,
              pages: page, totalPages, total: parsed.total, received: pagination.ids.size, stored: 0, complete: false, reason: '목록 조회 중, 수집 후 서버 저장 확인' }, [...ids]);
            if (!more) break;
            await ctx.session.page.waitForTimeout(PAGE_DELAY_MS);
          }
          screenshot = await ctx.session.screenshot('dabang', `${area.id}-${category.id}`);
          for (const id of ids) { const item = items.get(id); if (item) item.screenshot = screenshot; }
        } catch (error) { failure = error instanceof Error ? error.message.split('\n')[0] : '목록 확인 실패'; }
        const row = publish();
        fs.writeFileSync(path.join(dir, `${area.id}-${category.id}-coverage.json`), JSON.stringify({ ...row, bounds, regularIds: [...pagination.ids], savedIds: [...ids] }));
        if (!row.complete) ctx.partial(`${area.name} ${category.label}: ${row.reason}`, !blocked);
        ctx.log(`다방 ${area.name} ${category.label}: ${row.complete ? '전체 목록 확인' : '일부 확인'}, ${row.reason}`);
        await ctx.session.rest().catch(() => {});
      }
      if (blocked || ctx.stopped?.()) break;
    }
    return [...items.values()];
  },
};
