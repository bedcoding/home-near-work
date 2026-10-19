import type { Frame, Response } from 'playwright';
import type { BrowserSession } from '../browser.js';
import { PAGE_DELAY_MS } from '../config.js';
import * as store from '../db.js';
import type { NoticeInput } from '../db.js';
import type { NoticeFacts, NoticeSourceId, SubscriptionDetail } from '../../shared/types.js';
import { readTrustDocs } from './trust-docs.js';
import { TRUST_COLLECTORS } from './trusts.js';
import { BlockedError, type CollectContext } from './types.js';

// 공고 수집기: 공매, 임대, 청약 공고를 제목, 상태, 날짜, 링크로 모은다.
// 임대 공고는 '임대 공고' 탭, 신탁 공매 공고는 '경매' 탭, 청약(분양) 공고는 '청약' 탭에 보인다(shared/types의 noticeSection).

export interface NoticeCollector {
  id: NoticeSourceId;
  label: string;
  /** gus: 켜진 지역 근처 서울 구 이름(공고를 지역으로 거를 때 쓴다) */
  collect(ctx: CollectContext, gus: string[]): Promise<NoticeInput[]>;
}

const blocked = (status: number | null | undefined) => status === 403 || status === 429;

// ---------- KB부동산신탁 공매 ----------

interface KbItem {
  buildingIdx: number;
  buildingProgress?: string | null;
  buildingType?: string | null;
  buildingName?: string | null;
  buildingLocal?: string | null;
  buildingProcess?: string | null;
  createdDate?: string | null;
}

/** 공매물건 화면에서 구 이름으로 검색하고, 화면이 받는 목록 데이터를 읽는다. 가격은 공고 PDF에 있어서 링크는 공고 PDF로 건다. */
export const kbtrust: NoticeCollector = {
  id: 'kbtrust',
  label: 'KB부동산신탁 공매',
  async collect(ctx, gus) {
    if (!gus.length) {
      ctx.log('KB부동산신탁 공매: 켜진 지역 근처에 서울 역이 없어 건너뜁니다');
      return [];
    }
    const { session } = ctx;
    const page = session.page;
    ctx.progress('KB부동산신탁 공매: 공매물건 화면을 여는 중');
    const res = await session.goto('kbtrust', 'https://kbret.co.kr/auction');
    if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
    const input = page.locator('input[name=searchValue4]');
    await input.waitFor({ timeout: 20000 });
    // 처음 열 때 받는 전체 목록을 검색 결과로 잘못 잡지 않게, 다 받은 뒤 검색하고 검색어가 든 응답만 기다린다.
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const out = new Map<string, NoticeInput>();
    for (const gu of gus) {
      ctx.progress(`KB부동산신탁 공매: '${gu}' 검색`);
      const wait = page
        .waitForResponse((r) => r.url().includes('/api/sale/building/list') && r.url().includes(`searchValue4=${encodeURIComponent(gu)}`), { timeout: 20000 })
        .catch(() => null);
      await session.click(input);
      await input.fill('');
      await session.type(gu);
      await session.click(page.locator('button:has-text("검색")').last());
      const r = await wait;
      if (!r) throw new Error(`'${gu}' 검색 결과를 받지 못했습니다.`);
      session.record('kbtrust', 'data', r.url(), r.status(), `검색어 ${gu}`);
      if (blocked(r.status())) throw new BlockedError(`HTTP ${r.status()}`);
      const data = (await r.json()) as { list?: KbItem[]; totalItems?: number };
      if (!Array.isArray(data.list)) throw new Error('공매물건 목록을 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
      for (const b of data.list) {
        const place = b.buildingLocal ?? '';
        if (!`${place} ${b.buildingName ?? ''}`.includes(gu)) continue;
        out.set(String(b.buildingIdx), {
          sourceId: String(b.buildingIdx),
          title: b.buildingName ?? place,
          url: b.buildingProcess ? `https://kbret.co.kr${encodeURI(b.buildingProcess)}` : 'https://kbret.co.kr/auction',
          status: b.buildingProgress ?? null,
          kind: b.buildingType ?? null,
          place: place || null,
          postedAt: (b.createdDate ?? '').slice(0, 10) || null,
        });
      }
      if ((data.totalItems ?? 0) > data.list.length) ctx.log(`KB부동산신탁 공매: '${gu}' ${data.totalItems}건 중 첫 쪽 ${data.list.length}건만 읽었습니다`);
      await session.pause(600);
    }
    const items = [...out.values()];
    await readTrustDocs(ctx, 'kbtrust', items, true);
    return items;
  },
};

// ---------- 한국토지신탁 공매공고 ----------

interface KoreitRow {
  Seq: number;
  Title?: string | null;
  CodeName?: string | null;
  CreateDate?: string | null;
}

/** 공매공고 게시판 첫 쪽(15건)을 화면이 받는 목록 데이터로 읽고, 제목(소재지)에 구 이름이 든 공고만 남긴다. */
export const koreit: NoticeCollector = {
  id: 'koreit',
  label: '한국토지신탁 공매',
  async collect(ctx, gus) {
    const { session } = ctx;
    const page = session.page;
    ctx.progress('한국토지신탁 공매: 공매공고 목록을 여는 중');
    const wait = page
      .waitForResponse((r) => r.url().includes('/api/anonymousbizservice/execute') && (r.request().postData() ?? '').includes('GetKRTBoardContentList'), {
        timeout: 30000,
      })
      .catch(() => null);
    const res = await session.goto('koreit', 'https://www.koreit.co.kr/land-trust/sale/short-notice');
    if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
    const r = await wait;
    if (!r) throw new Error('공매공고 목록을 받지 못했습니다.');
    session.record('koreit', 'data', r.url(), r.status(), '공매공고 목록');
    if (blocked(r.status())) throw new BlockedError(`HTTP ${r.status()}`);
    const rows = ((await r.json()) as { result?: { value?: { Table?: { rows?: KoreitRow[] } } } }).result?.value?.Table?.rows;
    if (!Array.isArray(rows) || !rows.length) throw new Error('공매공고 목록을 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
    return rows
      .filter((row) => gus.some((gu) => (row.Title ?? '').includes(gu)))
      .map((row) => ({
        sourceId: String(row.Seq),
        title: row.Title ?? '',
        url: `https://www.koreit.co.kr/land-trust/sale/short-notice-detail?Seq=${row.Seq}&num=1`,
        status: row.CodeName ?? null,
        kind: null,
        place: null,
        postedAt: row.CreateDate ?? null,
      }));
  },
};

// ---------- 서울주거포털 SH, LH 임대 공고 ----------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 공고 목록 표 첫 쪽을 읽는다. 줄마다 칸 글자와 '바로가기' 링크(바깥 사이트 주소가 있으면 그것, 없으면 첫 링크를 절대 주소로). */
async function readLeaseTable(ctx: CollectContext, source: NoticeSourceId, url: string) {
  const { session } = ctx;
  const res = await session.goto(source, url);
  if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
  await session.page.waitForSelector('table tbody tr', { timeout: 20000 });
  const rows = await session.page.$$eval('table tbody tr', (trs) =>
    trs.map((tr) => ({
      // 좁은 화면에서 숨기는 칸도 읽게 textContent를 쓴다.
      cells: Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()),
      hrefs: Array.from(tr.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? ''),
    })),
  );
  if (!rows.length || !rows.some((r) => r.cells.some((c) => DATE.test(c)))) {
    throw new Error('공고 목록 표를 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
  }
  return rows.map((r) => {
    const href = r.hrefs.find((h) => /^https?:/.test(h)) ?? r.hrefs.find((h) => h && !h.startsWith('#') && !h.startsWith('javascript'));
    let absolute: string | null = null;
    try {
      absolute = href ? new URL(href, 'https://housing.seoul.go.kr').href : null;
    } catch {
      absolute = null;
    }
    return { cells: r.cells, href: absolute };
  });
}

const param = (href: string | null, name: string) => {
  try {
    return href ? new URL(href, 'https://housing.seoul.go.kr').searchParams.get(name) : null;
  } catch {
    return null;
  }
};

/** SH 목록에서 더 넘겨 보는 최대 쪽 수(한 쪽 10건) */
const SH_MAX_PAGES = 5;

/**
 * SH 임대 공고(서울): 번호, 유형, 공고명, 게시일, 발표일, 모집상태, 담당, 바로가기.
 * 모집중인 공고가 첫 쪽에서 밀려나도 계속 보이게, 모집중 공고가 없는 쪽이 나올 때까지 넘겨 본다.
 */
export const sh: NoticeCollector = {
  id: 'sh',
  label: 'SH 임대 공고',
  async collect(ctx) {
    const out = new Map<string, NoticeInput>();
    for (let page = 1; page <= SH_MAX_PAGES; page++) {
      ctx.progress(`서울주거포털: SH 임대 공고 ${page}쪽을 여는 중`);
      const url = `https://housing.seoul.go.kr/site/main/sh/publicLease/list${page > 1 ? `?cp=${page}&supplyType=publicLease` : ''}`;
      const rows = (await readLeaseTable(ctx, 'sh', url)).filter((r) => r.cells.length >= 6);
      for (const r of rows) {
        const sourceId = param(r.href, 'seq') ?? r.cells[0];
        out.set(sourceId, {
          sourceId,
          title: r.cells[2],
          url: r.href,
          status: r.cells[5] || null,
          kind: r.cells[1] || null,
          place: '서울',
          postedAt: DATE.test(r.cells[3]) ? r.cells[3] : null,
        });
      }
      if (!rows.some((r) => /모집중/.test(r.cells[5] ?? ''))) break;
      await ctx.session.pause(600);
    }
    return [...out.values()];
  },
};

// ---------- LH 청약플러스(서울) ----------

const LH_LIST = 'https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do';
const LH_DETAIL = 'https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancInfo.do';

/** '2026.10.01' → '2026-10-01' */
const dotDate = (s: string | undefined) => (/^\d{4}\.\d{2}\.\d{2}$/.test(s ?? '') ? s!.replace(/\./g, '-') : null);

/**
 * LH 청약플러스 공고문 목록(mi: 1026 임대주택, 1027 분양주택)에서 지역을 서울특별시, 상태를 전체로 골라 검색하고 표를 읽는다(최근 두 달, 100건까지).
 * 칸: 번호, 유형, 공고명, 지역, 첨부, 게시일, 마감일, 상태, 조회수. 상세는 행 링크의 data-id1~4(공고 번호, 시스템, 상위 유형, 유형)로 주소를 만든다.
 * 서울 공고가 없으면 빈 목록을 돌려준다.
 */
async function readLhList(ctx: CollectContext, source: NoticeSourceId, mi: string, name: string): Promise<NoticeInput[]> {
  const { session } = ctx;
  const page = session.page;
  ctx.progress(`LH 청약플러스: ${name} 공고문 목록을 여는 중`);
  const res = await session.goto(source, `${LH_LIST}?mi=${mi}`);
  if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
  await page.waitForSelector('#cnpCd', { timeout: 30000 });
  await choose(session, '#cnpCd', '11');
  await choose(session, '#panSs', '');
  if (await page.locator('#listWt option[value="100"]').count()) await choose(session, '#listWt', '100');
  const searched = page.waitForNavigation({ timeout: 30000 }).catch(() => null);
  await session.click(page.locator('#btnSah'));
  await searched;
  await page.waitForSelector('table tbody tr', { timeout: 30000 });
  const rows = await page.$$eval('table tbody tr', (trs) =>
    trs.map((tr) => {
      const link = tr.querySelector('a[data-id1]');
      return {
        cells: Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()),
        ids: link ? [1, 2, 3, 4].map((i) => link.getAttribute(`data-id${i}`) ?? '') : null,
      };
    }),
  );
  session.record(source, 'data', page.url(), null, `${name}, 서울, ${rows.filter((r) => r.ids).length}건`);
  const heads = await page.$$eval('table thead th', (ths) => ths.map((th) => (th.textContent ?? '').trim()));
  if (!heads.some((h) => h.includes('공고명'))) throw new Error('공고문 목록 표를 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
  return rows
    .filter((r) => r.ids?.[0] && r.cells.length >= 8)
    .map((r) => {
      const [panId, sys, upper, type] = r.ids!;
      const posted = dotDate(r.cells[5]);
      const deadline = dotDate(r.cells[6]);
      const status = r.cells[7] || null;
      return {
        sourceId: panId,
        // 공고명 뒤에 붙는 '1일전', 'NEW' 표시는 뺀다.
        title: r.cells[2].replace(/\s*(\d+일전|NEW|new)\s*$/, '').trim(),
        url: `${LH_DETAIL}?panId=${panId}&ccrCnntSysDsCd=${sys}&uppAisTpCd=${upper}&aisTpCd=${type}&mi=${mi}`,
        status: status && posted && deadline ? `${status} ${monthDay(posted)}~${monthDay(deadline)}` : status,
        kind: r.cells[1] || null,
        place: '서울',
        postedAt: posted,
      };
    });
}

/** LH 임대 공고(서울): 행복주택, 국민임대, 통합공공임대, 매입임대(든든전세 포함), 전세임대, 신혼희망 행복주택 등 */
export const lh: NoticeCollector = {
  id: 'lh',
  label: 'LH 임대 공고(서울)',
  collect: (ctx) => readLhList(ctx, 'lh', '1026', '임대주택'),
};

/** 상세를 읽은 LH 공고에 넣는 빈 숫자(읽었다는 표시) */
const NO_FACTS: NoticeFacts = { amount: null, areaM2: null, note: null };
/** '1,234.5' → 1234.5, 숫자가 아니면 null */
const num = (s: string | undefined): number | null => {
  const t = (s ?? '').replace(/,/g, '').trim();
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

/**
 * LH 공고 상세 화면에서 단지나 필지의 서울 구와 줄에 보일 숫자를 읽는다.
 * 구는 '단지내 주택 정보'와 공급필지 표의 소재지에서 읽고, 신청과 계약 장소 주소는 그 단지 관리사무소일 때만 쓴다(LH 사무실 주소는 뺌).
 * 상가: 상가동호 표의 가장 낮은 임대보증금(원)과 월임대료(원), 전용면적(0원은 뺌). 토지: 공급필지 표의 가장 낮은 예정가격이나 공급가격(원), 면적, 공급용도와 필지 수.
 * 표 칸에는 좁은 화면용 칸 이름(em.mTit)이 숨어 있어 값은 칸 안 div에서 읽고, 줄 첫 칸이 머리글 칸(th)인 표도 있어 th와 td를 함께 센다.
 */
async function readLhDetail(session: BrowserSession, url: string, source: NoticeSourceId): Promise<{ regions: string[]; facts: NoticeFacts }> {
  const res = await session.goto(source, url);
  if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
  await session.page.waitForLoadState('domcontentloaded');
  await session.pause(800);
  return session.page.evaluate(() => {
    const text = (e: Element | null | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const cellText = (c: Element) => text(c.querySelector(':scope > div') ?? c);
    const toNum = (s: string) => {
      const v = Number(s.split('~')[0].replace(/[^\d.]/g, ''));
      return /\d/.test(s) && Number.isFinite(v) ? v : null;
    };
    const regions: string[] = [];
    const addGu = (s: string) => {
      const gu = /서울(?:특별시)?\s+(\S+구)/.exec(s)?.[1];
      if (gu && !regions.includes(gu)) regions.push(gu);
    };
    const lines = (document.body.innerText ?? '').split('\n');
    lines.forEach((line, i) => {
      if (!/소재지\s*:\s*서울/.test(line)) return;
      const place = /장소/.test(lines.slice(Math.max(0, i - 2), i).join(' '));
      if (!place || /관리사무소|관리소/.test(line)) addGu(line);
    });

    const shop: { deposit: number | null; rent: number | null; area: number | null }[] = [];
    const land: { price: number | null; area: number | null; use: string }[] = [];
    for (const table of Array.from(document.querySelectorAll('table'))) {
      const heads = Array.from(table.querySelectorAll('thead th')).map((th) => text(th));
      const col = (re: RegExp) => heads.findIndex((h) => re.test(h));
      const rows = Array.from(table.querySelectorAll('tbody tr'))
        .map((tr) => Array.from(tr.children).map((c) => cellText(c)))
        .filter((r) => r.length > 1 && !r.some((c) => /조회된 데이터가 없습니다|결과가 없습니다/.test(c)));
      const at = (r: string[], i: number) => (i < 0 ? null : toNum(r[i] ?? ''));
      if (col(/임대보증금/) >= 0) {
        for (const r of rows) shop.push({ deposit: at(r, col(/임대보증금/)), rent: at(r, col(/월임대료/)), area: at(r, col(/전용면적/)) });
      } else if (col(/지번/) >= 0 && col(/소재지/) >= 0) {
        for (const r of rows) {
          addGu(r[col(/소재지/)] ?? '');
          land.push({ price: at(r, col(/예정가격|공급가격|공급금액/)), area: at(r, col(/면적/)), use: r[col(/공급용도/)] ?? '' });
        }
      }
    }
    const least = (vs: (number | null)[]) => {
      const ok = vs.filter((v): v is number => v != null && v > 0);
      return ok.length ? Math.min(...ok) : null;
    };
    let amount: { label: string; value: number } | null = null;
    let areaM2: number | null = null;
    let note: string | null = null;
    if (shop.length) {
      const deposit = least(shop.map((x) => x.deposit));
      const rent = least(shop.map((x) => x.rent));
      if (deposit) amount = { label: '보증금', value: Math.round(deposit / 10000) };
      if (rent) note = `월 ${Math.round(rent / 10000).toLocaleString('ko-KR')}만`;
      areaM2 = least(shop.map((x) => x.area));
    } else if (land.length) {
      const price = least(land.map((x) => x.price));
      if (price) amount = { label: '예정가격', value: Math.round(price / 10000) };
      areaM2 = least(land.map((x) => x.area));
      const use = land.find((x) => x.use)?.use;
      if (use) note = land.length > 1 ? `${use} 외 ${land.length - 1}필지` : use;
    }
    return { regions, facts: { amount, areaM2, note } };
  });
}

/** LH 공고문 목록을 읽고, 처음 보는 공고는 상세 화면에서 구와 숫자를 읽는다(이미 읽은 공고는 다시 열지 않음). */
async function readLhListWithDetail(ctx: CollectContext, source: NoticeSourceId, mi: string, name: string): Promise<NoticeInput[]> {
  const items = await readLhList(ctx, source, mi, name);
  const known = store.noticeIdsRead(source);
  for (const item of items) {
    if (known.has(item.sourceId) || !item.url) continue;
    ctx.progress(`LH 청약플러스: ${name} 공고 상세 보는 중 (${item.title.slice(0, 30)})`);
    try {
      const read = await readLhDetail(ctx.session, item.url, source);
      item.regions = read.regions;
      item.facts = read.facts;
    } catch (e) {
      if (e instanceof BlockedError) throw e;
      ctx.log(`LH ${name}: ${item.title} 상세를 읽지 못했습니다(다음 조회 때 다시 봄)`);
    }
    await ctx.session.pause(PAGE_DELAY_MS);
  }
  return items;
}

/** LH 상가 공고(서울): 영구임대상가와 희망상가 입점자 모집(추첨, 입찰, 공모), 분양상가 입찰 */
export const lhShop: NoticeCollector = {
  id: 'lhshop',
  label: 'LH 상가 공고(서울)',
  collect: (ctx) => readLhListWithDetail(ctx, 'lhshop', '1069', '상가'),
};

/** LH 토지 공고(서울): 택지와 용지 공급(추첨, 입찰, 수의계약) */
export const lhLand: NoticeCollector = {
  id: 'lhland',
  label: 'LH 토지 공고(서울)',
  collect: (ctx) => readLhListWithDetail(ctx, 'lhland', '1062', '토지'),
};

/** LH 선착순(수의)계약 화면 여섯 곳. 번호는 주소의 탭 번호, kind는 줄 종류(noticeSection이 이것으로 탭을 나눔). */
const LH_FIRST_TABS = [
  { no: 0, mi: '201527', kind: '선착순 토지' },
  { no: 1, mi: '201526', kind: '선착순 분양주택' },
  { no: 2, mi: '201529', kind: '선착순 분양전환임대' },
  { no: 3, mi: '201528', kind: '선착순 상가' },
  { no: 4, mi: '31381', kind: '선착순 임대상가' },
  { no: 5, mi: '1201802', kind: '선착순 임대주택' },
] as const;
const lhFirstUrl = (t: (typeof LH_FIRST_TABS)[number]) => `https://apply.lh.or.kr/lhapply/apply/bor_ctrt_psb_dst/${t.no}/lfn_getTabChange.do?mi=${t.mi}`;

/** 화면의 첫 표를 머리글 이름 → 칸 글자로 읽는다. 여러 줄에 걸친 칸(rowspan)은 아래 줄에도 채운다. 문의처 칸은 읽지 않는다. */
async function readSpanTable(session: BrowserSession): Promise<Record<string, string>[]> {
  return session.page.evaluate(() => {
    const text = (e: Element | null | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const table = Array.from(document.querySelectorAll('table')).find((t) => (t as HTMLElement).offsetParent);
    if (!table) return [];
    const heads = Array.from(table.querySelectorAll('thead th')).map((th) => text(th));
    const carry: { value: string; left: number }[] = [];
    const out: Record<string, string>[] = [];
    for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
      const cells = Array.from(tr.querySelectorAll('td'));
      if (cells.length === 1 && cells[0].colSpan > 1) continue;
      const row: string[] = [];
      let c = 0;
      for (let col = 0; col < heads.length; col++) {
        if (carry[col]?.left > 0) {
          row[col] = carry[col].value;
          carry[col].left -= 1;
          continue;
        }
        const td = cells[c++];
        if (!td) break;
        row[col] = text(td);
        if (td.rowSpan > 1) carry[col] = { value: row[col], left: td.rowSpan - 1 };
      }
      const record: Record<string, string> = {};
      heads.forEach((h, i) => {
        if (!/문의처/.test(h)) record[h] = row[i] ?? '';
      });
      out.push(record);
    }
    return out;
  });
}

/**
 * LH 선착순(수의)계약 화면 여섯 곳(토지, 분양주택, 분양전환임대, 상가, 임대상가, 임대주택)에서 지역을 서울특별시로 골라 검색하고 표를 읽는다.
 * 한 줄이 한 건(남은 집, 상가 호, 필지)이고, 금액과 면적은 줄 숫자 칸에 넣는다. 원문 주소는 그 화면(전국으로 열림)이다.
 */
export const lhFirst: NoticeCollector = {
  id: 'lhfirst',
  label: 'LH 선착순 계약(서울)',
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    const out: NoticeInput[] = [];
    for (const tab of LH_FIRST_TABS) {
      ctx.progress(`LH 청약플러스: ${tab.kind} 서울 검색`);
      const res = await session.goto('lhfirst', lhFirstUrl(tab));
      if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
      await page.waitForSelector('#srchCnpCd', { timeout: 30000 });
      await choose(session, '#srchCnpCd', '11');
      const searched = page.waitForNavigation({ timeout: 30000 }).catch(() => null);
      await session.click(page.locator('#btnSah'));
      await searched;
      await page.waitForSelector('table tbody tr', { timeout: 30000 });
      const rows = await readSpanTable(session);
      session.record('lhfirst', 'data', page.url(), null, `${tab.kind}, 서울, ${rows.length}줄`);
      if (!rows.length) {
        const none = await page.evaluate(() => /검색결과\s*0\s*건|결과가 없습니다/.test(document.body.innerText)).catch(() => false);
        if (!none) throw new Error(`${tab.kind} 표를 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.`);
      }
      for (const r of rows) {
        const get = (re: RegExp) => Object.entries(r).find(([k]) => re.test(k))?.[1] ?? '';
        const district = get(/지구|사업지구/);
        const block = get(/^블록/);
        const area = num(get(/^전용면적/).split('~')[0]) ?? num(get(/^면적\(㎡\)/));
        const left = num(get(/미분양/));
        let facts: NoticeFacts = NO_FACTS;
        let detail: SubscriptionDetail | null = null;
        let title = [district, block].filter(Boolean).join(' ');
        let place: string | null = '서울';
        if (tab.no === 0) {
          const price = num(get(/공급금액/));
          title = [district, get(/소재지/), get(/확정지번/) || get(/예정지번/)].filter(Boolean).join(' ');
          place = get(/^공급용도$/) || null;
          facts = { amount: price ? { label: '공급가', value: Math.round(price / 10000) } : null, areaM2: area, note: get(/용도지역/) || null };
        } else if (tab.no === 1) {
          const price = num(get(/주택가격/));
          const man = price ? Math.round(price / 10) : null;
          place = [area ? `전용 ${area}㎡` : '', left != null ? `남은 ${left}호` : ''].filter(Boolean).join(', ') || null;
          detail = { address: null, households: null, priceMin: man, priceMax: man, moveIn: null, winnersAt: null, builder: null };
          facts = { amount: man ? { label: '분양가', value: man } : null, areaM2: area, note: left != null ? `남은 ${left}호` : null };
        } else if (tab.no === 2) {
          const deposit = num(get(/보증금/));
          const rent = num(get(/임대료/));
          facts = {
            amount: deposit ? { label: '보증금', value: Math.round(deposit / 10) } : null,
            areaM2: area,
            note: [rent ? `월 ${Math.round(rent / 10)}만` : '', left != null ? `남은 ${left}호` : ''].filter(Boolean).join(', ') || null,
          };
        } else if (tab.no === 3) {
          const price = num(get(/분양가격/).split('~')[0]);
          facts = { amount: price ? { label: '분양가', value: Math.round(price / 10) } : null, areaM2: area, note: left != null ? `남은 ${left}호` : null };
        } else if (tab.no === 4) {
          const deposit = num(get(/임대보증금/));
          const rent = num(get(/^임대료/));
          title = [district, block, get(/^동$/), get(/^호$/) ? `${get(/^호$/)}호` : ''].filter(Boolean).join(' ');
          facts = { amount: deposit ? { label: '보증금', value: Math.round(deposit / 10000) } : null, areaM2: area, note: rent ? `월 ${Math.round(rent / 10000).toLocaleString('ko-KR')}만` : null };
        } else {
          title = [district, block, get(/^동$/), get(/^호$/) ? `${get(/^호$/)}호` : ''].filter(Boolean).join(' ');
          facts = { amount: null, areaM2: area, note: get(/공급유형/) || null };
        }
        if (!title) continue;
        out.push({
          sourceId: `${tab.no}:${title}:${area ?? ''}`,
          title,
          url: lhFirstUrl(tab),
          status: '선착순',
          kind: tab.kind,
          place,
          postedAt: null,
          facts,
          ...(detail ? { detail } : {}),
        });
      }
      await session.pause(PAGE_DELAY_MS);
    }
    return out;
  },
};

// ---------- 마이홈포털(서울, LH 외) ----------

interface MyhomeNotice {
  pblancId?: string | null;
  pblancNm?: string | null;
  suplyInsttNm?: string | null;
  suplyTyNm?: string | null;
  houseTyNm?: string | null;
  rcritPblancDe?: string | null;
  przwnerPresnatnDe?: string | null;
  prgrStts?: string | null;
}
const MYHOME_LIST = 'selectRsdtRcritNtcList.do';
/** 마이홈 목록을 넘겨 보는 최대 쪽 수(한 쪽 5건 남짓) */
const MYHOME_MAX_PAGES = 12;
/** '20261001' → '2026-10-01' */
const ymd = (s: string | null | undefined) => (/^\d{8}$/.test(s ?? '') ? `${s!.slice(0, 4)}-${s!.slice(4, 6)}-${s!.slice(6, 8)}` : null);

/**
 * 마이홈포털 임대주택 입주자 모집공고(최근 여섯 달)에서 지역을 서울특별시로 골라 검색하고, 화면이 받는 목록 데이터를 쪽마다 읽는다.
 * LH 공고는 LH 청약플러스에서 따로 모으므로 빼고, 다른 공급기관(한국사학진흥재단, 한국자산관리공사 등) 공고만 남긴다.
 * 상세는 https://www.myhome.go.kr/hws/portal/sch/selectRsdtRcritNtcDetailView.do?pblancId=번호.
 */
export const myhome: NoticeCollector = {
  id: 'myhome',
  label: '마이홈 공공임대(서울, LH 외)',
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    const found = new Map<string, MyhomeNotice>();
    let total: number | null = null;
    const readList = async (r: Response | null, note: string) => {
      if (!r) throw new Error(`${note} 목록을 받지 못했습니다.`);
      session.record('myhome', 'data', r.url(), r.status(), note);
      if (blocked(r.status())) throw new BlockedError(`HTTP ${r.status()}`);
      const data = (await r.json().catch(() => null)) as { resultCnt?: number; resultList?: MyhomeNotice[] } | null;
      if (!Array.isArray(data?.resultList)) throw new Error('모집공고 목록을 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
      total = data!.resultCnt ?? total;
      for (const n of data!.resultList) if (n.pblancId) found.set(n.pblancId, n);
    };
    const waitList = () =>
      page.waitForResponse((r) => r.url().includes(MYHOME_LIST) && r.request().method() === 'POST' && (r.request().postData() ?? '').includes('srchbrtcCode=11'), { timeout: 30000 }).catch(() => null);

    ctx.progress('마이홈: 임대주택 모집공고 화면을 여는 중');
    const res = await session.goto('myhome', 'https://www.myhome.go.kr/hws/portal/sch/selectRsdtRcritNtcView.do');
    if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
    // 검색 조건 칸('지역 전체')을 눌러야 지역 고르기가 보인다(누를 때마다 열리고 닫힘).
    const regionChip = page.locator('li.result-list:has(span.list-type:text-is("지역"))').first();
    await regionChip.waitFor({ timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const region = page.locator('#srchbrtcCode');
    for (let i = 0; i < 3 && !(await region.isVisible()); i++) {
      await session.click(regionChip);
      await region.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
    }
    if (!(await region.isVisible())) throw new Error('지역 고르기 칸을 열지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
    await choose(session, '#srchbrtcCode', '11');
    ctx.progress('마이홈: 서울특별시 모집공고 검색');
    const first = waitList();
    await session.click(page.locator('button:has-text("검색")').last());
    await readList(await first, '서울 1쪽');
    for (let p = 2; p <= MYHOME_MAX_PAGES && total != null && found.size < total; p++) {
      const link = page.locator(`a[href*="fnSearch('${p}')"], [onclick*="fnSearch('${p}')"]`).first();
      if (!(await link.count())) break;
      const next = waitList();
      await session.click(link);
      await readList(await next, `서울 ${p}쪽`);
      await session.pause(500);
    }
    ctx.log(`마이홈: 서울 모집공고 ${found.size}건${total != null ? ` (화면 표시 ${total}건)` : ''}`);
    return [...found.values()]
      .filter((n) => (n.suplyInsttNm ?? '').trim() !== 'LH')
      .map((n) => ({
        sourceId: n.pblancId!,
        title: (n.pblancNm ?? '').trim(),
        url: `https://www.myhome.go.kr/hws/portal/sch/selectRsdtRcritNtcDetailView.do?pblancId=${n.pblancId}`,
        status: n.prgrStts ?? null,
        kind: n.suplyTyNm ?? n.houseTyNm ?? null,
        place: n.suplyInsttNm ?? null,
        postedAt: ymd(n.rcritPblancDe),
      }));
  },
};

// ---------- HUG 든든전세주택(서울) ----------

const HUG_LIST = 'https://www.khug.or.kr/jeonse/web/s07/s070102.jsp';
/** 구 하나에서 넘겨 보는 최대 쪽 수(한 쪽 10집) */
const HUG_MAX_PAGES = 10;

/** 지금 화면(조회 결과 한 쪽)의 집 줄 */
async function readHugPage(session: BrowserSession) {
  // 결과가 없으면 표 몸통이 비어 있어 보이지 않으므로 붙어 있기만 기다린다.
  await session.page.waitForSelector('table', { state: 'attached', timeout: 30000 });
  return session.page.$$eval('table tbody tr', (trs) =>
    trs.map((tr) => ({
      cells: Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()),
      href: tr.querySelector('a[href*="s070103.jsp"]')?.getAttribute('href') ?? null,
    })),
  );
}

/**
 * HUG 든든전세주택 '모집공고 및 입주신청' 집 목록에서 서울특별시와 켜진 지역 근처 구를 골라 조회하고 쪽마다 읽는다(서울 전체는 400곳이 넘어 구마다 본다).
 * 칸: 번호, 공고일자, 청약 접수기간, 시도, 시군구, 주소, 주택유형, 매입유형, 전용면적, 임대보증금액(원), 신청자수.
 * 집 하나가 공고 한 건이다(상세 s070103.jsp?dt=공고일자&no=번호, 접수가 끝나면 상세는 닫힌다). 구는 regions에 담는다.
 */
export const hugJeonse: NoticeCollector = {
  id: 'hugjeonse',
  label: 'HUG 든든전세주택',
  async collect(ctx, gus) {
    if (!gus.length) {
      ctx.log('HUG 든든전세: 켜진 지역 근처에 서울 역이 없어 건너뜁니다');
      return [];
    }
    const { session } = ctx;
    const page = session.page;
    const out = new Map<string, NoticeInput>();
    for (const gu of gus) {
      ctx.progress(`HUG: 든든전세주택 '${gu}' 조회`);
      const res = await session.goto('hugjeonse', HUG_LIST);
      if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
      await page.waitForSelector('#CMB_SIDO', { timeout: 30000 });
      // 화면을 열 때마다 안내 창이 덮을 때가 있다.
      const popup = page.locator('a.close_pop:visible').first();
      if (await popup.count()) {
        await session.click(popup);
        await session.pause(400);
      }
      await choose(session, '#CMB_SIDO', '01');
      // 시군구 칸은 시도를 고르면 채워진다('서울 강남구').
      const option = page.locator('#sbGugun option').filter({ hasText: new RegExp(`${gu}$`) }).first();
      await option.waitFor({ state: 'attached', timeout: 15000 });
      const code = await option.getAttribute('value');
      if (!code) throw new Error(`시군구 '${gu}'를 고르지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.`);
      await choose(session, '#sbGugun', code);
      const searched = page.waitForNavigation({ timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await session.click(page.locator('#btnSer'));
      await searched;

      let previous = '';
      for (let p = 1; p <= HUG_MAX_PAGES; p++) {
        if (p > 1) {
          // 쪽 번호는 조건이 든 보통 링크라 그 주소를 연다(누르면 다시 뜬 안내 창에 가릴 수 있음).
          const href = await page.locator(`a[href*="cur_page=${p}"]`).first().getAttribute('href').catch(() => null);
          if (!href) break;
          const moved = await session.goto('hugjeonse', new URL(href, HUG_LIST).href);
          if (blocked(moved?.status())) throw new BlockedError(`HTTP ${moved?.status()}`);
        }
        const rows = await readHugPage(session);
        const houses = rows.filter((r) => r.href && r.cells.length >= 11);
        session.record('hugjeonse', 'data', page.url(), null, `${gu} ${p}쪽 ${houses.length}집`);
        // 쪽이 넘어가지 않았으면(같은 집들) 멈춘다.
        const signature = houses.map((r) => r.href).join();
        if (signature && signature === previous) break;
        previous = signature;
        for (const r of houses) {
          const q = new URL(r.href!, HUG_LIST).searchParams;
          const dt = q.get('dt') ?? '';
          const no = q.get('no') ?? '';
          if (!no) continue;
          const [, posted, period, , gugun, address, type, , area, deposit, applicants] = r.cells;
          const dates = (period.match(/\d{4}\.\s?\d{2}\.\s?\d{2}/g) ?? []).map((d) => d.replace(/\.\s?/g, '-').slice(0, 10));
          const rowGu = /(\S+구)$/.exec(gugun)?.[1] ?? gu;
          const won = Number(deposit.replace(/[^\d]/g, ''));
          out.set(`${dt}-${no}`, {
            sourceId: `${dt}-${no}`,
            title: address.replace(/^서울(특별시)?\s*/, ''),
            url: `https://www.khug.or.kr/jeonse/web/s07/s070103.jsp?dt=${dt}&no=${no}`,
            status: null,
            kind: type || null,
            place: null,
            postedAt: ymd(posted),
            regions: [rowGu],
            period: dates.length >= 2 ? { start: dates[0]!, end: dates[dates.length - 1]! } : null,
            facts: {
              amount: won ? { label: '전세', value: Math.round(won / 10000) } : null,
              areaM2: Number(area) || null,
              note: /^\d+$/.test(applicants) ? `신청 ${applicants}명` : null,
            },
          });
        }
        if (houses.length === 0) {
          const none = await page.evaluate(() => /총\s*0\s*건|없습니다/.test(document.body.innerText)).catch(() => false);
          if (p === 1 && !none) throw new Error('든든전세주택 목록을 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
          break;
        }
        await session.pause(500);
      }
    }
    ctx.log(`HUG 든든전세: ${gus.join(', ')} ${out.size}집`);
    return [...out.values()];
  },
};

// ---------- HUG 전월세 안심신탁 매물(서울) ----------

const HUG_TRUST_LIST = 'https://www.khug.or.kr/jeonse/web/s07/s070406.jsp';

/** HTML 조각의 글자(태그를 빼고 공백을 하나로) */
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * HUG 전월세 안심신탁 매물 안내에서 시도를 서울특별시로 골라 조회한다. 조회는 사이트의 웹 필터 화면을 거쳐 같은 화면으로 돌아오므로,
 * 돌아온 화면(POST 응답)의 표를 읽는다. 칸: 번호, 주소, 주택유형, 전용면적, 임대차유형, 임대보증금(원), 월세, 입대가능 시작일, 종료일.
 * 상세 창은 열지 않고 링크는 목록 화면으로 건다. 칸을 못 읽어도 '총 N 건'이 0보다 크면 한 건으로 알린다.
 */
export const hugTrust: NoticeCollector = {
  id: 'hugtrust',
  label: 'HUG 전월세 안심신탁 매물',
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    ctx.progress('HUG: 전월세 안심신탁 매물 화면을 여는 중');
    const res = await session.goto('hugtrust', HUG_TRUST_LIST);
    if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
    await page.waitForSelector('#CMB_SIDO', { timeout: 30000 });
    const popup = page.locator('a.close_pop:visible').first();
    if (await popup.count()) {
      await session.click(popup);
      await session.pause(400);
    }
    await choose(session, '#CMB_SIDO', '01');
    const result = page
      .waitForResponse((r) => r.url().startsWith(HUG_TRUST_LIST) && r.request().method() === 'POST', { timeout: 60000 })
      .catch(() => null);
    await session.click(page.locator('#btnSer'));
    const r = await result;
    if (!r) throw new Error('조회 결과를 받지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
    session.record('hugtrust', 'data', r.url(), r.status(), '서울 조회 결과');
    if (blocked(r.status())) throw new BlockedError(`HTTP ${r.status()}`);
    const html = await r.text();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const { total, items } = parseHugTrust(html);
    if (total == null) throw new Error('조회 결과 수를 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
    if (total > items.length && items.length) ctx.log(`HUG 안심신탁: ${total}건 중 첫 쪽 ${items.length}건만 읽었습니다`);
    ctx.log(`HUG 안심신탁: 서울 ${total}건`);
    return items;
  },
};

/** 안심신탁 매물 조회 결과 화면(HTML)에서 '총 N 건'과 매물 표를 읽는다. 표 칸을 못 읽었는데 N이 0보다 크면 'N건' 한 건을 돌려준다. */
export function parseHugTrust(html: string): { total: number | null; items: NoticeInput[] } {
  const totalText = /총\s*([\d,]+)\s*건/.exec(plain(html))?.[1];
  const total = totalText ? Number(totalText.replace(/,/g, '')) : null;
  // 매물 표: 머리글에 '입대가능'이나 '임대보증금'이 든 표(화면 안 창의 다른 표와 섞이지 않게)
  const table = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)].map((m) => m[1]).find((t) => /입대가능|임대보증금/.test(plain(t)));
  const heads = table ? [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => plain(m[1])) : [];
  const col = (name: string) => heads.findIndex((h) => h.startsWith(name));
  const at = { address: col('주소'), type: col('주택유형'), area: col('전용면적'), lease: col('임대차유형'), deposit: col('임대보증금'), monthly: col('월세'), from: col('입대가능 시작'), to: col('입대가능 종료') };
  const rows = [...(table ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => plain(c[1])))
    .filter((cells) => cells.length >= 5);
  const md = (s: string) => (/^\d{4}[.-]\d{2}[.-]\d{2}/.test(s) ? `${s.slice(5, 7)}.${s.slice(8, 10)}` : '');
  const items: NoticeInput[] = rows.map((cells) => {
    const get = (i: number) => (i >= 0 ? cells[i] ?? '' : '');
    const address = get(at.address) || cells.join(' ');
    const from = get(at.from);
    const to = get(at.to);
    const won = Number(get(at.deposit).replace(/[^\d]/g, ''));
    const rent = Number(get(at.monthly).replace(/[^\d]/g, ''));
    const gu = /서울\S*\s+(\S+구)/.exec(address)?.[1] ?? null;
    return {
      sourceId: `${address}|${from}`,
      title: address.replace(/^서울(특별시)?\s*/, ''),
      url: HUG_TRUST_LIST,
      status: from || to ? `입주 가능 ${[md(from), md(to)].filter(Boolean).join('~')}`.trim() : null,
      kind: get(at.type) || null,
      place: null,
      postedAt: null,
      regions: gu ? [gu] : [],
      facts: {
        amount: won ? { label: /전세/.test(get(at.lease)) ? '전세' : '보증금', value: Math.round(won / 10000) } : null,
        areaM2: Number(get(at.area).replace(/[^\d.]/g, '')) || null,
        note: rent ? `월세 ${Math.round(rent / 10000)}만` : null,
      },
    };
  });
  if (total && total > 0 && items.length === 0) {
    items.push({ sourceId: `total-${total}`, title: `서울 안심신탁 매물 ${total}건`, url: HUG_TRUST_LIST, status: null, kind: null, place: '서울', postedAt: null });
  }
  return { total, items };
}

// ---------- 고방 청년, 공공 임대 공고 ----------

interface GobangNotice {
  no: number;
  title?: string | null;
  supplyType?: string | null;
  noticeStartDate?: string | null;
  noticeEndDate?: string | null;
  noticeStatus?: string | null;
  createdAt?: string | null;
  dongNameList?: string | null;
}

const GOBANG_SUPPLY: Record<string, string> = {
  SAFETY_HOUSING: '안심주택',
  PURCHASE_RENTAL: '매입임대',
  PURCHASE_RENTAL_RESERVE: '매입임대(예비)',
  JEONSE_RENTAL: '전세임대',
  NATIONAL_RENTAL: '국민임대',
  SOCIAL_HOUSING: '사회주택',
  HAPPY_HOUSING: '행복주택',
};
const GOBANG_STATUS: Record<string, string> = { RECRUIT: '접수중', WAIT: '접수 예정' };
const GOBANG_NOTICES = 'api.gobang.kr/v2/youth-notices';

/** '2026-10-02T09:00:00' → '10.02' */
const monthDay = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(5, 7)}.${iso.slice(8, 10)}` : '');

/**
 * 고방 '모집공고' 화면(서울, 접수중, 접수 예정)이 받는 공고 목록을 읽는다(목록 데이터 주소는 직접 요청하지 않음). 상세는 https://gobang.kr/notices/<번호>.
 * 모집 지역의 구는 regions에 담는다(서울 전체, 전국 공고는 비움). 켜진 지역 근처 구만 보이게 거르는 것은 화면이 한다.
 * 상태 칸에는 접수 기간을 붙인다(안심주택 추가모집은 접수가 2~3일이라).
 */
export const gobangNotices: NoticeCollector = {
  id: 'gobang',
  label: '고방 청년과 공공 임대 공고',
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    const lists: GobangNotice[][] = [];
    let total: number | null = null;
    let blockedStatus: number | null = null;
    const pending: Promise<void>[] = [];
    const onResponse = (r: Response) => {
      const url = r.url();
      if (!url.includes(GOBANG_NOTICES)) return;
      const q = new URL(url).searchParams;
      // 서울 목록만 읽고, 위쪽 인기 공고 칸(최근 30일)은 뺀다.
      if (q.getAll('dongLiCodes').join() !== '11' || q.get('recentDays')) return;
      pending.push(
        (async () => {
          if (blocked(r.status())) {
            blockedStatus = r.status();
            return;
          }
          const data: any = await r.json().catch(() => null);
          if (url.includes('/youth-notices/count')) {
            if (typeof data?.result === 'number') total = data.result;
            return;
          }
          if (!Array.isArray(data?.result)) return;
          lists.push(data.result);
          session.record('gobang', 'data', url, r.status(), `공고 ${q.get('pageNo') ?? '1'}쪽 ${data.result.length}건`);
        })(),
      );
    };
    const settle = async () => {
      await Promise.allSettled(pending.splice(0));
      if (blockedStatus) throw new BlockedError(`HTTP ${blockedStatus}`);
    };
    const count = () => new Set(lists.flat().map((n) => n.no)).size;

    page.on('response', onResponse);
    try {
      ctx.progress('고방: 청년과 공공 임대 모집공고 화면을 여는 중');
      const res = await session.goto('gobang', 'https://gobang.kr/youth/notices');
      if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
      await page.waitForResponse((r) => r.url().includes(`${GOBANG_NOTICES}?`), { timeout: 20000 }).catch(() => null);
      await session.pause(1500);
      await settle();
      // 한 쪽에 20건이라 더 있으면 내려서 다음 쪽을 불러오게 한다.
      for (let round = 0; total != null && count() < total && round < 10; round++) {
        const before = count();
        for (let i = 0; i < 5; i++) {
          await session.wheel(640, 600, 1400);
          await session.pause(250);
        }
        await session.pause(1000);
        await settle();
        if (count() === before) break;
      }
    } finally {
      page.off('response', onResponse);
    }
    if (!lists.length) throw new Error('서울 공고 목록을 받지 못했습니다. 사이트 화면 구조가 바뀌었거나 지역이 서울이 아닐 수 있습니다.');
    ctx.log(`고방 공고: 서울 접수중과 접수 예정 ${count()}건${total != null ? ` (화면 표시 ${total}건)` : ''}`);

    const out = new Map<string, NoticeInput>();
    for (const n of lists.flat()) {
      if (!n?.no) continue;
      const places = (n.dongNameList ?? '').split(',').map((p) => p.trim()).filter(Boolean);
      const regions = places.includes('서울') ? [] : places.map((p) => /^서울\s+(\S+구)$/.exec(p)?.[1]).filter((g): g is string => !!g);
      const start = (n.noticeStartDate ?? '').slice(0, 10);
      const end = (n.noticeEndDate ?? '').slice(0, 10);
      const status = GOBANG_STATUS[n.noticeStatus ?? ''] ?? n.noticeStatus ?? null;
      const period = [monthDay(n.noticeStartDate), monthDay(n.noticeEndDate)].filter(Boolean).join('~');
      out.set(String(n.no), {
        sourceId: String(n.no),
        title: (n.title ?? '').trim(),
        url: `https://gobang.kr/notices/${n.no}`,
        status: [status, period].filter(Boolean).join(' ') || null,
        kind: GOBANG_SUPPLY[n.supplyType ?? ''] ?? n.supplyType ?? null,
        place: places.length > 3 ? `${places[0]} 외 ${places.length - 1}곳` : places.join(', ') || null,
        postedAt: (n.createdAt ?? '').slice(0, 10) || null,
        regions,
        period: DATE.test(start) && DATE.test(end) ? { start, end } : null,
      });
    }
    return [...out.values()];
  },
};

// ---------- SH, LH 공공분양(서울주거포털) ----------

const EMPTY_DETAIL: SubscriptionDetail = { address: null, households: null, priceMin: null, priceMax: null, moveIn: null, winnersAt: null, builder: null };

/** SH 공공분양: 번호, 청약유형, 공고명, 공고게시일, 발표일, 담당, 바로가기 */
export const shSale: NoticeCollector = {
  id: 'shsale',
  label: 'SH 공공분양',
  async collect(ctx) {
    ctx.progress('서울주거포털: SH 공공분양 공고 목록을 여는 중');
    const rows = await readLeaseTable(ctx, 'shsale', 'https://housing.seoul.go.kr/site/main/sh/publicSale/01/list');
    return rows
      .filter((r) => r.cells.length >= 5)
      .map((r) => ({
        sourceId: param(r.href, 'seq') ?? r.cells[0],
        title: r.cells[2],
        url: r.href,
        status: null,
        kind: r.cells[1] || null,
        place: '서울',
        postedAt: DATE.test(r.cells[3]) ? r.cells[3] : null,
        detail: { ...EMPTY_DETAIL, winnersAt: DATE.test(r.cells[4]) ? r.cells[4] : null },
      }));
  },
};

/** LH 공공분양(서울): 분양주택, 신혼희망타운 공공분양, 이익공유형. 서울 공고는 드물어서 보통 빈 목록이다. */
export const lhSale: NoticeCollector = {
  id: 'lhsale',
  label: 'LH 공공분양(서울)',
  collect: (ctx) => readLhList(ctx, 'lhsale', '1027', '분양주택'),
};

// ---------- 청약홈(서울 청약) ----------

const APPLYHOME = 'https://www.applyhome.co.kr';
/** 분양정보 목록 화면 세 곳. 공급지역을 서울로 골라 조회하고, 행을 누르면 화면 안 창(iframe)에 상세가 열린다. */
const APPLYHOME_LISTS = [
  { name: 'APT 분양', path: '/ai/aia/selectAPTLttotPblancListView.do' },
  { name: '무순위와 잔여세대', path: '/ai/aia/selectAPTRemndrLttotPblancListView.do' },
  { name: '오피스텔, 도시형, 민간임대', path: '/ai/aia/selectOtherLttotPblancListView.do' },
];
/** 목록을 넘겨 보는 최대 쪽 수(한 쪽 10건) */
const APPLYHOME_MAX_PAGES = 5;
const APPLYHOME_DETAIL = /Detail(View)?\.do/;

/** 선택 상자 위로 커서를 옮긴 뒤 값을 고른다. */
async function choose(session: BrowserSession, selector: string, value: string) {
  const locator = session.page.locator(selector);
  await session.hover(locator);
  await locator.selectOption(value);
  await session.pause(700);
}

/** 지난달 'YYYYMM'(목록 조회 시작 달) */
function lastMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 목록 표의 행: 머리글 이름 → 칸 글자, 공고 번호(data-pbno). */
async function readApplyhomeRows(session: BrowserSession) {
  return session.page.evaluate(() => {
    const text = (e: Element | null | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const heads = Array.from(document.querySelectorAll('table thead th')).map((th) => text(th));
    return Array.from(document.querySelectorAll('table tbody tr[data-pbno]')).map((tr) => {
      const cells: Record<string, string> = {};
      Array.from(tr.children).forEach((td, i) => {
        if (heads[i]) cells[heads[i]] = text(td);
      });
      return { pbno: tr.getAttribute('data-pbno') ?? '', name: tr.getAttribute('data-honm') ?? '', cells };
    });
  });
}

/** 상세 창(iframe)에서 공급위치, 공급규모, 공급금액 범위, 입주예정월, 모집공고문 주소를 읽는다. */
async function readApplyhomeDetail(frame: Frame) {
  await frame.waitForLoadState('domcontentloaded').catch(() => {});
  await frame.waitForSelector('table', { timeout: 10000 }).catch(() => {});
  return frame
    .evaluate(() => {
      const text = (e: Element | null | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const cells = Array.from(document.querySelectorAll('th, td'));
      const valueOf = (label: string) => {
        const cell = cells.find((c) => text(c) === label);
        return cell?.nextElementSibling ? text(cell.nextElementSibling) : null;
      };
      // 공급금액 표의 각 행에서 처음 나오는 '12,345' 꼴 숫자(주택형 다음 칸)
      const prices: number[] = [];
      for (const table of Array.from(document.querySelectorAll('table'))) {
        if (!/공급금액/.test(text(table.querySelector('thead')) + text(table.querySelector('caption')))) continue;
        for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
          const value = Array.from(tr.children).map((c) => text(c)).find((s) => /^\d{1,3}(,\d{3})+$/.test(s));
          if (value) prices.push(Number(value.replace(/,/g, '')));
        }
      }
      const moveIn = /입주예정월[\s\S]{0,300}?(\d{4}\.\d{2})(?!\d)/.exec(text(document.body))?.[1] ?? null;
      const notice = Array.from(document.querySelectorAll('a')).find((a) => /getAtchmnfl/.test(a.href))?.href ?? null;
      return {
        address: valueOf('공급위치'),
        households: Number((valueOf('공급규모') ?? '').replace(/[^\d]/g, '')) || null,
        priceMin: prices.length ? Math.min(...prices) : null,
        priceMax: prices.length ? Math.max(...prices) : null,
        moveIn,
        notice,
      };
    })
    .catch(() => null);
}

/** '서울특별시 강남구 역삼동 123-45번지 일원' → { gu: '강남구', place: '강남구 역삼동' } */
function seoulPlace(address: string | null): { gu: string | null; place: string | null } {
  const m = /서울(?:특별시|시)?\s+(\S+구)(?:\s+(\S+))?/.exec(address ?? '');
  if (!m) return { gu: null, place: address ? address.split(/\s+/).slice(0, 3).join(' ') : null };
  return { gu: m[1], place: [m[1], m[2]].filter(Boolean).join(' ') };
}

/**
 * 청약홈 분양정보 목록(APT 분양, 무순위와 잔여세대, 오피스텔, 도시형, 민간임대)에서 공급지역 서울, 지난달부터의 공고를 읽는다.
 * 새 공고는 행을 눌러 화면이 여는 상세 창에서 공급위치(구), 세대수, 공급금액, 입주예정월, 모집공고문 주소를 읽는다(이미 읽은 공고는 다시 열지 않음).
 * 종류에 '임대'가 든 공고(민간임대 등)는 임대 공고 탭, 나머지는 청약 탭에 보인다.
 */
export const applyhome: NoticeCollector = {
  id: 'applyhome',
  label: '청약홈 청약(서울)',
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    const known = store.noticeIdsWithDetail('applyhome');
    const out = new Map<string, NoticeInput>();
    for (const list of APPLYHOME_LISTS) {
      ctx.progress(`청약홈: ${list.name} 목록을 여는 중`);
      const res = await session.goto('applyhome', `${APPLYHOME}${list.path}`);
      if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
      await page.waitForSelector('#cate02', { timeout: 30000 });
      await choose(session, '#cate02', '서울');
      const start = lastMonth();
      if (await page.locator(`#start_year option[value="${start}"]`).count()) await choose(session, '#start_year', start);
      const searched = page.waitForNavigation({ timeout: 30000 }).catch(() => null);
      await session.click(page.locator('button:has-text("조회")').first());
      await searched;
      await page.waitForSelector('table tbody tr', { timeout: 30000 });
      session.record('applyhome', 'action', page.url(), null, `${list.name}, 서울, ${start}부터 조회`);

      for (let pageNo = 1; pageNo <= APPLYHOME_MAX_PAGES; pageNo++) {
        if (pageNo > 1) {
          const link = page.locator(`a[onclick*="fn_link_page(${pageNo})"]`).first();
          if (!(await link.count())) break;
          const moved = page.waitForNavigation({ timeout: 30000 }).catch(() => null);
          await session.click(link);
          await moved;
          await page.waitForSelector('table tbody tr', { timeout: 30000 });
        }
        const rows = await readApplyhomeRows(session);
        session.record('applyhome', 'data', page.url(), null, `${list.name} ${pageNo}쪽 ${rows.length}건`);
        for (const row of rows) {
          if (!row.pbno || out.has(row.pbno)) continue;
          const c = row.cells;
          const cell = (prefix: string) => Object.entries(c).find(([k]) => k.startsWith(prefix))?.[1] ?? '';
          const dates: string[] = cell('청약기간').match(/\d{4}-\d{2}-\d{2}/g) ?? [];
          const winnersAt = /\d{4}-\d{2}-\d{2}/.exec(cell('당첨자발표'))?.[0] ?? null;
          const builder = cell('시공사') || cell('시행사') || null;
          const kindBase = cell('주택구분') || cell('구분');
          const kind = `${kindBase}${cell('분양/임대') === '임대주택' ? ' 임대' : ''}` || null;
          const item: NoticeInput = {
            sourceId: row.pbno,
            title: row.name || cell('주택명'),
            url: null,
            status: null,
            kind,
            place: null,
            postedAt: /\d{4}-\d{2}-\d{2}/.exec(cell('모집공고일'))?.[0] ?? null,
            period: dates.length ? { start: dates[0]!, end: dates[dates.length - 1]! } : null,
          };
          if (!known.has(row.pbno)) {
            ctx.progress(`청약홈: ${item.title} 상세 보는 중`);
            // 상세는 화면 안 창(iframe)이 새 주소로 넘어간 뒤에 읽는다(응답만 오고 창이 아직 바뀌기 전일 수 있음).
            const opened = page
              .waitForEvent('framenavigated', { predicate: (f) => f !== page.mainFrame() && APPLYHOME_DETAIL.test(f.url()), timeout: 15000 })
              .catch(() => null);
            await session.click(page.locator(`tr[data-pbno="${row.pbno}"] a`).first());
            const frame = await opened;
            const detail = frame ? await readApplyhomeDetail(frame) : null;
            if (detail) {
              session.record('applyhome', 'data', frame!.url(), null, `상세 ${item.title}`);
              const where = seoulPlace(detail.address);
              item.url = detail.notice;
              item.place = where.place;
              item.regions = where.gu ? [where.gu] : [];
              item.detail = { address: detail.address, households: detail.households, priceMin: detail.priceMin, priceMax: detail.priceMax, moveIn: detail.moveIn, winnersAt, builder };
            } else ctx.log(`청약홈: ${item.title} 상세를 읽지 못했습니다(다음 조회 때 다시 봄)`);
            await page.keyboard.press('Escape').catch(() => {});
            await session.pause(700);
          }
          out.set(row.pbno, item);
        }
      }
      await session.pause(600);
    }
    ctx.log(`청약홈: 서울 ${out.size}건 (상세 새로 읽음 ${[...out.values()].filter((n) => n.detail).length}건)`);
    return [...out.values()];
  },
};

/** 조회 순서대로. */
export const NOTICE_COLLECTORS: NoticeCollector[] = [
  sh, lh, myhome, hugJeonse, hugTrust, gobangNotices, applyhome, shSale, lhSale, lhShop, lhLand, lhFirst, kbtrust, koreit, ...TRUST_COLLECTORS,
];
