import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR, PAGE_DELAY_MS } from '../config.js';
import { DABANG_CATEGORIES, DABANG_HEADERS, dabangListUrl, DabangPagination, dabangPriceScopes, dabangPricesMatch, dabangTargets } from '../dabang-client.js';
import type { CollectionCoverage } from '../../shared/types.js';
import type { CollectedItem, Collector } from './types.js';

export const dabang: Collector = {
  id: 'dabang', label: '다방', emptyOk: true, retainMissing: true,
  async collect(ctx) {
    const items = new Map<string, CollectedItem>();
    const verifiedPriceIds = new Set<string>();
    const { targets, skipped, unreadable } = dabangTargets(ctx.areas);
    for (const { area, by } of skipped) ctx.log(`다방 ${area.name}: ${by} 구 범위 안이라 따로 조회하지 않습니다`);
    for (const area of unreadable) ctx.partial(`${area.name}: 다방 조회 범위를 만들 수 없습니다`, false);
    const limits = ctx.priceLimits;
    const hasLimits = limits && (limits.excludeSale || limits.saleMax !== null || limits.jeonseMax !== null
      || limits.monthlyDepositMax !== null || limits.monthlyMax !== null);
    const scopes = DABANG_CATEGORIES.flatMap(category => dabangPriceScopes(category.id, limits).map(scope => ({
      category, scope, key: category.id + scope.suffix,
      label: scope.label ? `${category.label} ${scope.label}` : hasLimits ? `${category.label} 가격 조건` : category.label,
    })));
    const dir = path.join(RUNS_DIR, String(ctx.runId), 'dabang');
    fs.mkdirSync(dir, { recursive: true });
    for (const { area } of targets) for (const { key, label } of scopes) {
      ctx.coverage?.({ areaId: area.id, areaName: area.name, category: key, label,
        pages: 0, totalPages: null, total: null, received: 0, stored: 0, complete: false, reason: '조회 대기' }, []);
    }
    let blocked = false;
    for (const { area, bounds } of targets) {
      let openedCategory: string | null = null;
      for (const { category, scope, key, label } of scopes) {
        if (ctx.stopped?.() || blocked) break;
        const pagination = new DabangPagination();
        const ids = new Set<string>();
        const unverified = new Set<string>();
        let failure = '';
        if (openedCategory !== category.id) {
          const url = `https://www.dabangapp.com/map/${category.path}?${new URLSearchParams({
            m_lat: String((bounds.sw.lat + bounds.ne.lat) / 2), m_lng: String((bounds.sw.lng + bounds.ne.lng) / 2), m_zoom: '13',
          })}`;
          // The website provides the visual reference. Data requests use the full GU bounds.
          await ctx.session.goto('dabang', url).catch(() => ctx.log(`다방 ${area.name} ${label}: 지도 화면을 열지 못해 공개 목록으로 확인합니다`));
          openedCategory = category.id;
        }
        let screenshot: string | null = null;
        const publish = (): CollectionCoverage => {
          const result = pagination.result();
          const priceProblem = unverified.size ? `일반 매물 ${unverified.size}건이 조회한 가격 또는 거래 조건과 일치하는지 확인하지 못함` : '';
          const reason = [failure || result.reason, priceProblem].filter(Boolean).join(', ');
          const row: CollectionCoverage = { areaId: area.id, areaName: area.name, category: key, label,
            ...result, stored: 0, complete: !failure && !unverified.size && result.complete, reason };
          ctx.coverage?.(row, [...ids]);
          return row;
        };
        // result() is final-only: do not call it while pages are still being read.
        try {
          for (let page = 1; page <= 2000; page++) {
            if (ctx.stopped?.()) { failure = '중단함'; break; }
            ctx.progress(`다방, ${area.name}, ${label}, ${page}페이지 읽는 중 (고유 ${ids.size}건)`);
            const requestUrl = dabangListUrl(category.id, bounds, page, scope);
            let response: Response;
            try { response = await fetch(requestUrl, { headers: DABANG_HEADERS, signal: AbortSignal.timeout(20000) }); }
            catch { ctx.session.record('dabang', 'data', requestUrl, null, '목록 응답 시간 초과 또는 연결 실패'); throw new Error('목록 응답을 받지 못했습니다'); }
            ctx.session.record('dabang', 'data', requestUrl, response.status, `${area.name}, ${label}, ${page}페이지`);
            if (response.status === 403 || response.status === 429) { blocked = true; throw new Error(`사이트 응답 ${response.status}: 잠시 후 다시 확인해 주세요`); }
            if (!response.ok) throw new Error(`목록 응답 오류 ${response.status}`);
            const body = await response.text();
            fs.writeFileSync(path.join(dir, `${area.id}-${key}-${page}.json`), body);
            const { parsed, more, totalPages } = pagination.accept(body, page, category.id);
            const regularIds = hasLimits ? new Set(parsed.regularIds) : null;
            for (const item of parsed.items) {
              const { sourceId, prices } = item.listing;
              if (limits && regularIds) {
                const regular = regularIds.delete(sourceId);
                const verified = regular && dabangPricesMatch(prices, limits, scope);
                if (regular && !verified) unverified.add(sourceId);
                if (!dabangPricesMatch(prices, limits)) continue;
                const prior = items.get(sourceId);
                // One ID has one trade in the source row. Keep earlier verified data if scopes disagree.
                if (prior && verifiedPriceIds.has(sourceId) && (!verified || prior.listing.prices[0]?.deal !== prices[0]?.deal)) {
                  if (verified) unverified.add(sourceId);
                  ids.add(sourceId);
                  continue;
                }
                if (verified) verifiedPriceIds.add(sourceId);
              }
              ids.add(sourceId);
              items.set(sourceId, { ...item, pageUrl: requestUrl, screenshot });
            }
            ctx.log(`다방 ${area.name} ${label}: ${page}/${totalPages}페이지, 일반 ${parsed.regularCount}건, 누적 고유 ${pagination.ids.size}/${parsed.total}건`);
            ctx.coverage?.({ areaId: area.id, areaName: area.name, category: key, label,
              pages: page, totalPages, total: parsed.total, received: pagination.ids.size, stored: 0, complete: false, reason: '목록 조회 중, 수집 후 서버 저장 확인' }, [...ids]);
            if (!more) break;
            await ctx.session.page.waitForTimeout(PAGE_DELAY_MS);
          }
          screenshot = await ctx.session.screenshot('dabang', `${area.id}-${key}`);
          for (const id of ids) { const item = items.get(id); if (item) item.screenshot = screenshot; }
        } catch (error) { failure = error instanceof Error ? error.message.split('\n')[0] : '목록 확인 실패'; }
        const row = publish();
        fs.writeFileSync(path.join(dir, `${area.id}-${key}-coverage.json`), JSON.stringify({ ...row, bounds, regularIds: [...pagination.ids], savedIds: [...ids] }));
        if (!row.complete) ctx.partial(`${area.name} ${label}: ${row.reason}`, !blocked);
        ctx.log(`다방 ${area.name} ${label}: ${row.complete ? '목록 끝까지 확인' : '일부 확인'}, ${row.reason}`);
        await ctx.session.rest().catch(() => {});
      }
      if (blocked || ctx.stopped?.()) break;
    }
    return [...items.values()];
  },
};
