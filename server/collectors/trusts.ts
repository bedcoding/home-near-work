import type { NoticeInput } from '../db.js';
import type { NoticeSourceId } from '../../shared/types.js';
import type { NoticeCollector } from './notices.js';
import { readTrustDocs } from './trust-docs.js';
import { BlockedError, type CollectContext } from './types.js';

// 부동산신탁사 공매 공고(경매 탭 '공매 공고'). 회사마다 공매 게시판을 켜진 지역 근처 구 이름으로 검색해 제목(소재지), 상태, 날짜, 링크를 모은다.
// 검색어는 구 이름에서 '구'를 뺀 것('강남')이고, 제목에 구 이름이 있거나 '서울'과 검색어가 함께 있는 공고만 남긴다('서울 노원 상계동'처럼 '구'를 빼고 쓴 제목이 있어서).

const blocked = (status: number | null | undefined) => status === 403 || status === 429;

/** 게시판 한 줄에서 읽는 칸(줄 안의 선택자. 빈 글자면 줄 자체). */
interface RowFields {
  /** 상세로 가는 링크(href와 onclick을 읽는다) */
  link: string;
  /** 제목(소재지). 없으면 링크 글자 */
  title?: string;
  status?: string;
  date?: string;
  /** 날짜를 글자 대신 이 속성에서 읽는다 */
  dateAttr?: string;
  /** 용도 */
  kind?: string;
}

interface BoardSpec {
  id: NoticeSourceId;
  label: string;
  /** GET 검색 주소 */
  searchUrl?: (keyword: string) => string;
  /** 검색이 POST 양식인 곳: 목록 주소와 검색 칸, 검색 버튼 */
  form?: { url: string; input: string; button: string };
  /** 게시판 한 줄 */
  row: string;
  fields: RowFields;
  /** 링크(href와 onclick 글자)에서 고정 번호를 꺼낸다 */
  idPattern: RegExp;
  detailUrl: (id: string) => string;
  /** 상세 화면 첨부에서 공고문을 받아 읽는다(readTrustDocs) */
  docs?: boolean;
}

/** 오늘부터 이만큼 지난 공고는 버린다(검색이 몇 년 치를 다 돌려주는 곳이 많아서). */
const KEEP_DAYS = 365;

/** '2026-10-01 10:14', '2026.10.02', '2026. 10. 02' → '2026-10-01' */
function isoDate(text: string | null | undefined): string | null {
  const m = /(\d{4})\s*[.-]\s*(\d{1,2})\s*[.-]\s*(\d{1,2})/.exec(text ?? '');
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

function cutoffDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - KEEP_DAYS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 제목이 그 구의 공고인지: 구 이름이 있거나, '서울'과 '구'를 뺀 이름이 함께 있다. */
export function inGu(title: string, gu: string): boolean {
  const short = gu.replace(/구$/, '');
  return title.includes(gu) || (/서울/.test(title) && title.includes(short));
}

/** 게시판 화면의 줄들을 읽는다. 일부 사이트 스크립트가 Playwright의 $$eval을 깨뜨려서 page.evaluate와 기본 DOM 함수만 쓴다. */
async function readBoard(ctx: CollectContext, spec: BoardSpec) {
  return ctx.session.page.evaluate(
    ({ row, f }) => {
      const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const pick = (root: Element, sel?: string) => (sel ? root.querySelector(sel) : root);
      return Array.prototype.map.call(document.querySelectorAll(row), (r: Element) => {
        const link = pick(r, f.link);
        const date = pick(r, f.date);
        return {
          href: `${link?.getAttribute('href') ?? ''} ${link?.getAttribute('onclick') ?? ''}`,
          title: f.title ? text(r.querySelector(f.title)) : text(link),
          status: f.status ? text(r.querySelector(f.status)) : '',
          date: f.dateAttr ? (date?.getAttribute(f.dateAttr) ?? '') : f.date ? text(date) : '',
          kind: f.kind ? text(r.querySelector(f.kind)) : '',
        };
      }) as { href: string; title: string; status: string; date: string; kind: string }[];
    },
    { row: spec.row, f: spec.fields },
  );
}

/** 공매 게시판 하나를 구마다 검색해 읽는 수집기를 만든다. */
function boardCollector(spec: BoardSpec): NoticeCollector {
  return {
    id: spec.id,
    label: spec.label,
    async collect(ctx, gus) {
      if (!gus.length) {
        ctx.log(`${spec.label}: 켜진 지역 근처에 서울 역이 없어 건너뜁니다`);
        return [];
      }
      const { session } = ctx;
      const page = session.page;
      const cutoff = cutoffDate();
      const out = new Map<string, NoticeInput>();
      for (const gu of gus) {
        const keyword = gu.replace(/구$/, '');
        ctx.progress(`${spec.label}: '${keyword}' 검색`);
        if (spec.searchUrl) {
          const res = await session.goto(spec.id, spec.searchUrl(keyword));
          if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
        } else if (spec.form) {
          const res = await session.goto(spec.id, spec.form.url);
          if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
          const input = page.locator(spec.form.input).first();
          await input.waitFor({ timeout: 20000 });
          await session.click(input);
          await input.fill('');
          await session.type(keyword);
          const searched = page.waitForNavigation({ timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => null);
          await session.click(page.locator(spec.form.button).first());
          await searched;
          session.record(spec.id, 'action', page.url(), null, `검색어 ${keyword}`);
        }
        await page.waitForSelector(spec.row, { timeout: 15000 }).catch(() => null);
        const rows = await readBoard(ctx, spec);
        const found = rows
          .map((r) => ({ ...r, id: spec.idPattern.exec(r.href)?.[1] ?? null }))
          .filter((r): r is typeof r & { id: string } => !!r.id);
        if (!found.length) {
          const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
          if (!/없습니다|없어요|0\s*건|검색\s*결과/.test(body)) throw new Error('공매 목록을 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
        }
        session.record(spec.id, 'data', page.url(), null, `'${keyword}' ${found.length}건`);
        for (const r of found) {
          const title = r.title.replace(/\s+N$/, '').trim();
          const postedAt = isoDate(r.date);
          if (!inGu(title, gu) || (postedAt && postedAt < cutoff)) continue;
          out.set(r.id, {
            sourceId: r.id,
            title,
            url: spec.detailUrl(r.id),
            status: r.status || null,
            kind: r.kind || null,
            place: null,
            postedAt,
          });
        }
        await session.pause(600);
      }
      const items = [...out.values()];
      if (spec.docs) await readTrustDocs(ctx, spec.id, items);
      return items;
    },
  };
}

export const reitpia = boardCollector({
  id: 'reitpia',
  label: '대한토지신탁 공매',
  searchUrl: (q) => `https://www.reitpia.com/info/02.php?make=title&search=${encodeURIComponent(q)}`,
  row: 'ul.notice_list > li',
  fields: { link: 'a', title: 'div.txt_t', status: 'div.cate', date: 'div.date' },
  idPattern: /[?&]no=(\d+)/,
  detailUrl: (id) => `https://www.reitpia.com/info/02.php?admin_mode=read&no=${id}`,
  docs: true,
});

export const ktrust = boardCollector({
  id: 'ktrust',
  label: '코리아신탁 공매',
  form: { url: 'https://www.ktrust.co.kr/?pages=thing&subs=thing02', input: '#search_txt', button: '.searchbtn' },
  row: 'table tbody tr',
  fields: { link: 'a[href*="m=view&idx="]', status: 'td.state span', date: 'td.date' },
  idPattern: /[?&]idx=(\d+)/,
  detailUrl: (id) => `https://www.ktrust.co.kr/?pages=thing&subs=thing02&m=view&idx=${id}`,
  docs: true,
});

export const hanatrust = boardCollector({
  id: 'hanatrust',
  label: '하나자산신탁 공매',
  searchUrl: (q) => `https://www.hanatrust.com/ko/publicSale/goodsForPublicSale?search_type=title&search_text=${encodeURIComponent(q)}`,
  row: 'ul.auction-sale__list > li.auction-sale__item',
  fields: { link: 'a.auction-sale__link', title: '.auction-sale__position', status: '.auction-sale__status', date: '.auction-sale__date', kind: '.auction-sale__purpose' },
  idPattern: /[?&]seq=(\d+)/,
  detailUrl: (id) => `https://www.hanatrust.com/ko/publicSale/goodsForPublicSale/view?seq=${id}`,
  docs: true,
});

// 무궁화신탁과 신영부동산신탁은 https 인증서가 다른 이름의 것이라 http로 연다(사이트가 http로 정상 운영됨).
export const mghat = boardCollector({
  id: 'mghat',
  label: '무궁화신탁 공매',
  searchUrl: (q) => `http://www.mghat.com/auction/disposal/list.do?type=&field=title&keyword=${encodeURIComponent(q)}&page=1`,
  row: 'table tbody tr',
  fields: { link: 'td.tit a', status: 'td.conditions span', date: 'td:nth-child(5)' },
  idPattern: /\/auction\/disposal\/(\d+)\/show\.do/,
  detailUrl: (id) => `http://www.mghat.com/auction/disposal/${id}/show.do`,
  docs: true,
});

export const shinyoung = boardCollector({
  id: 'shinyoung',
  label: '신영부동산신탁 공매',
  form: { url: 'http://www.shinyoungret.com/index.asp?pages=public&subs=sub01', input: '#searchform input[name=q]', button: '#searchform .search_btn button' },
  row: 'table.bbs_tbl tbody tr',
  fields: { link: 'td.subject2 a', status: 'td.file button', date: 'td.date' },
  idPattern: /[?&]idx=(\d+)/,
  detailUrl: (id) => `http://www.shinyoungret.com/index.asp?pages=public&subs=sub01&m=view&idx=${id}`,
  docs: true,
});

export const wooriat = boardCollector({
  id: 'wooriat',
  label: '우리자산신탁 공매',
  searchUrl: (q) => `https://www.wooriat.com/item/vendue/list?page=1&sortStatus=&searchWord=${encodeURIComponent(q)}`,
  row: '.board_list_type1 table tbody tr',
  fields: { link: 'td.tit3 a', status: 'td.state span', date: 'td:nth-child(5)' },
  idPattern: /\/item\/vendue\/detail\/(\d+)/,
  detailUrl: (id) => `https://www.wooriat.com/item/vendue/detail/${id}`,
  docs: true,
});

export const daishin = boardCollector({
  id: 'daishin',
  label: '대신자산신탁 공매',
  searchUrl: (q) => `https://trust.daishin.com/thing_1/?keyword_type=all&keyword=${encodeURIComponent(q)}`,
  row: 'ul.li_body',
  fields: { link: 'a.list_text_title', status: 'li.category em', date: 'li.time', dateAttr: 'title' },
  idPattern: /[?&]idx=(\d+)/,
  detailUrl: (id) => `https://trust.daishin.com/thing_1/?bmode=view&idx=${id}&t=board`,
});

export const kyobotrust = boardCollector({
  id: 'kyobotrust',
  label: '교보자산신탁 공매',
  searchUrl: (q) => `https://www.kyobotrust.co.kr/front/bbsList.do?bbsId=BBS_0005&pageIndex=1&searchOp6=&searchCnd=1&searchWrd=${encodeURIComponent(q)}`,
  row: '.boardThumb > a',
  fields: { link: '', title: 'p.title', status: '.tag', date: 'p.date' },
  idPattern: /fnViewArticle\('(\d+)'/,
  detailUrl: (id) => `https://www.kyobotrust.co.kr/front/viewAritcle.do?bbsId=BBS_0005&nttId=${id}`,
  docs: true,
});

export const koramco = boardCollector({
  id: 'koramco',
  label: '코람코자산신탁 공매',
  searchUrl: (q) => `https://www.koramco.com/ko/pubsaleList?page=1&etc_cd1=&keyword=${encodeURIComponent(q)}`,
  row: '.article ul.list > li',
  fields: { link: 'a', title: 'div.subject', status: 'p.category span', date: 'p.date' },
  idPattern: /post_id=(\d+)/,
  detailUrl: (id) => `https://www.koramco.com/ko/pubsaleView?post_id=${id}`,
  docs: true,
});

// ---------- 신한자산신탁(화면이 받는 목록 데이터) ----------

interface ShinhanItem {
  id: number;
  title?: string | null;
  status?: string | null;
  category?: string | null;
  soldAt?: string | null;
  createdAt?: string | null;
}
const SHINHAN_STATUS: Record<string, string> = {
  IN_PROGRESS: '진행중',
  CONTRACT_AVAILABLE: '수의계약가능',
  CONTRACT_IN_PROGRESS: '계약진행중',
  TERMINATED: '종결',
  CANCELED: '취소',
  COMPLETED: '완료',
  STOPED: '중지',
};
const SHINHAN_CATEGORY: Record<string, string> = {
  APARTMENT: '아파트',
  OFFICETEL: '오피스텔',
  NEIGHBORHOOD_FACILITY: '근린생활시설',
  LAND: '토지',
};

/** 매각 및 공매물건 화면을 검색어와 함께 열고, 화면이 받는 목록 데이터(/api/disposal-auction)를 읽는다. 공고일(soldAt)이 없으면 등록일. */
export const shinhantrust: NoticeCollector = {
  id: 'shinhantrust',
  label: '신한자산신탁 공매',
  async collect(ctx, gus) {
    if (!gus.length) return [];
    const { session } = ctx;
    const page = session.page;
    const cutoff = cutoffDate();
    const out = new Map<string, NoticeInput>();
    for (const gu of gus) {
      const keyword = gu.replace(/구$/, '');
      ctx.progress(`신한자산신탁 공매: '${keyword}' 검색`);
      const wait = page
        .waitForResponse((r) => r.url().includes('/api/disposal-auction?') && new URL(r.url()).searchParams.get('title') === keyword, { timeout: 30000 })
        .catch(() => null);
      const res = await session.goto(
        'shinhantrust',
        `https://www.shinhantrust.kr/biz-information/auction-properties?category=all&keyword=${encodeURIComponent(keyword)}&a_category=&region=&page=0`,
      );
      if (blocked(res?.status())) throw new BlockedError(`HTTP ${res?.status()}`);
      const r = await wait;
      if (!r) throw new Error(`'${keyword}' 검색 결과를 받지 못했습니다.`);
      session.record('shinhantrust', 'data', r.url(), r.status(), `검색어 ${keyword}`);
      if (blocked(r.status())) throw new BlockedError(`HTTP ${r.status()}`);
      const data = (await r.json().catch(() => null)) as { results?: ShinhanItem[]; totalElements?: number } | null;
      if (!Array.isArray(data?.results)) throw new Error('공매 목록을 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
      for (const item of data!.results) {
        const title = (item.title ?? '').trim();
        const postedAt = isoDate(item.soldAt) ?? isoDate(item.createdAt);
        if (!inGu(title, gu) || (postedAt && postedAt < cutoff)) continue;
        out.set(String(item.id), {
          sourceId: String(item.id),
          title,
          url: `https://www.shinhantrust.kr/biz-information/auction-properties-detail/${item.id}`,
          status: SHINHAN_STATUS[item.status ?? ''] ?? item.status ?? null,
          kind: SHINHAN_CATEGORY[item.category ?? ''] ?? null,
          place: null,
          postedAt,
        });
      }
      if ((data!.totalElements ?? 0) > data!.results.length) ctx.log(`신한자산신탁 공매: '${keyword}' ${data!.totalElements}건 중 첫 쪽 ${data!.results.length}건만 읽었습니다`);
      await session.pause(600);
    }
    return [...out.values()];
  },
};

/** 조회 순서대로. */
export const TRUST_COLLECTORS: NoticeCollector[] = [reitpia, ktrust, hanatrust, shinhantrust, mghat, shinyoung, wooriat, daishin, kyobotrust, koramco];
