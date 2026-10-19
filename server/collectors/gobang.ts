import type { Response } from 'playwright';
import type { BrowserSession } from '../browser.js';
import { PAGE_DELAY_MS } from '../config.js';
import { gusFor } from './gus.js';
import { BlockedError, toNumber, type Collector, type CollectedItem } from './types.js';
import { priceText } from '../../shared/format.js';
import type { ExplainRow, NormalizedListing, PriceOption } from '../../shared/types.js';

// 고방(1인 가구 주거)은 종류별 목록 화면에서 구를 누르고 목록을 끝까지 내려, 그때 화면이 스스로 불러오는 목록 응답을 같이 읽는다.
// 목록 응답 주소(api.gobang.kr)에는 직접 요청하지 않는다.
// 한 건은 방 하나가 아니라 지점(원룸텔, 고시원, 쉐어하우스) 또는 중개사 매물(원·투룸)이고, 월세는 그 지점 방들의 가장 싼 값~비싼 값이다.

const CATEGORIES = [
  { path: 'gosi', label: '원룸텔과 고시원' },
  { path: 'share', label: '쉐어하우스' },
  { path: 'coliving', label: '코리빙' },
  { path: 'one-two', label: '원·투룸' },
] as const;

const TYPE_LABEL: Record<string, string> = {
  GOSIWON: '고시원',
  ONE_ROOM_TEL: '원룸텔',
  SHARE_HOUSE: '쉐어하우스',
  CO_LIVING_HOUSE: '코리빙',
  ONE_TWO_ROOM: '원·투룸',
  OFFICETEL: '오피스텔',
};

const LIST_API = 'api.gobang.kr/v2/houses?';
const SIGUNGU_API = 'api.gobang.kr/v2/house-sigungus?';
/** 한 구 목록을 내리는 최대 횟수(한 번에 휠 5번, 쪽마다 40곳). */
const MAX_ROUNDS = 30;

/** 목록 응답 주소의 조건(구 코드, 쪽 번호). */
function listQuery(url: string): { code: string | null; pageNo: number } {
  const q = new URL(url).searchParams;
  return { code: q.get('dongliCode'), pageNo: Number(q.get('pageNo') ?? '1') };
}

/** 월세가 0이고 보증금만 있으면 전세로 본다(중개사 매물). */
function priceOption(monthly: number, deposit: number | null): PriceOption {
  return monthly === 0 && deposit ? { deal: 'jeonse', deposit, monthly: null, price: null } : { deal: 'monthly', deposit, monthly, price: null };
}

function normalize(h: any, thumbnail: string | null): NormalizedListing | null {
  if (!h?.no) return null;
  const types = ((h.houseTypes ?? []) as string[]).map((t) => TYPE_LABEL[t] ?? t);
  const rawTags = (h.tags ?? []) as { name?: string; type?: string }[];
  const tags = rawTags.map((t) => String(t?.name ?? ''));
  const has = (re: RegExp) => (tags.some((t) => re.test(t)) ? true : null);
  /** 중개사 매물의 방 구조('쓰리룸 이상' 등) */
  const roomTag = rawTags.find((t) => t?.type === 'ROOM_TYPE' && t.name)?.name ?? null;
  const minPrice = toNumber(h.minPrice);
  const maxPrice = toNumber(h.maxPrice);
  const minDeposit = toNumber(h.minDeposit);
  const maxDeposit = toNumber(h.maxDeposit);
  const prices: PriceOption[] = [];
  if (minPrice != null) prices.push(priceOption(minPrice, minDeposit));
  if (maxPrice != null && maxPrice !== minPrice) prices.push(priceOption(maxPrice, maxDeposit ?? minDeposit));
  const subways = ((h.nearSubways ?? []) as { name?: string; distance?: number }[])
    .map((s) => `${s.name} ${s.distance != null ? `${Math.round(s.distance * 1000)}m` : ''}`.trim())
    .join(', ');
  const listing: NormalizedListing = {
    source: 'gobang',
    sourceId: String(h.no),
    url: `https://gobang.kr/place/${h.no}`,
    title: String(h.name ?? '').trim(),
    thumbnail,
    lat: toNumber(h.latitude),
    lng: toNumber(h.longitude),
    address: h.eupmyeondongFullName ?? null,
    dong: h.eupmyeondongName ?? null,
    buildingKey: `gb-${h.no}`,
    buildingType: types.join(', ') || null,
    roomLabel: roomTag ?? types[0] ?? null,
    rooms: null,
    areaM2: null,
    floor: null,
    totalFloors: null,
    basement: null,
    rooftop: null,
    builtYear: null,
    maintenance: null,
    elevator: has(/엘리베이터/),
    parking: has(/주차/),
    availableFrom: null,
    updatedAt: null,
    prices,
  };
  const explain: ExplainRow[] = [
    {
      label: '월세',
      raw: `minPrice=${h.minPrice ?? '없음'}, maxPrice=${h.maxPrice ?? '없음'}, minDeposit=${h.minDeposit ?? '없음'}, maxDeposit=${h.maxDeposit ?? '없음'} (만원)`,
      value: prices.map(priceText).join(' ~ ') || '없음',
      note: '지점 방들의 가장 싼 값과 비싼 값. 방마다 따로는 상세 화면에 있음. 월세가 0이고 보증금만 있으면 전세로 봄',
    },
    { label: '종류', raw: `houseTypes=${JSON.stringify(h.houseTypes ?? [])}, service="${h.service ?? ''}"`, value: listing.buildingType ?? '모름', note: 'UCEO는 운영자 지점, UAGENT는 중개사 매물' },
    { label: '위치', raw: `latitude=${h.latitude}, longitude=${h.longitude}, eupmyeondongFullName="${h.eupmyeondongFullName ?? ''}"`, value: `${listing.lat}, ${listing.lng}` },
    { label: '가까운 역', raw: 'nearSubways', value: subways || '없음', note: 'distance(km)를 m로 바꿈' },
    { label: '특징', raw: 'tags', value: tags.join(', ') || '없음', note: '엘리베이터와 주차는 여기 있으면 있음으로 봄' },
  ];
  listing.explain = explain;
  return listing;
}

/** 화면의 지점 카드에 표시용 번호를 달고, 카드 사진 주소를 지점 번호별로 돌려준다(사진 주소에 지점 번호가 들어 있음). */
async function tagCards(session: BrowserSession): Promise<Record<string, string>> {
  return session.page
    .evaluate(() => {
      const out: Record<string, string> = {};
      for (const img of Array.from(document.images)) {
        const src = img.currentSrc || img.src;
        const m = /(?:ceo|agent)-house\/(\d+)\//.exec(src);
        if (!m) continue;
        const card = img.closest('li') as HTMLElement | null;
        if (card && !card.dataset.hnwGobang) card.dataset.hnwGobang = m[1];
        if (!out[m[1]]) out[m[1]] = src;
      }
      return out;
    })
    .catch(() => ({}) as Record<string, string>);
}

/** 구 이름으로 시작하는 칸을 누른다. 커서로 누르고, 목록이 안 바뀌면 화면 코드로 한 번 더 누른다. */
async function pickGu(session: BrowserSession, name: string, code: string): Promise<boolean> {
  const page = session.page;
  const marked = await page.evaluate((gu) => {
    document.querySelectorAll('[data-hnw-gu]').forEach((e) => e.removeAttribute('data-hnw-gu'));
    const leaf = Array.from(document.querySelectorAll('span, button, li, div')).find((e) => e.childElementCount === 0 && (e.textContent ?? '').trim().startsWith(gu));
    if (!leaf) return false;
    ((leaf.closest('button, li, a, [role=button]') as HTMLElement | null) ?? (leaf as HTMLElement)).setAttribute('data-hnw-gu', '1');
    return true;
  }, name);
  if (!marked) return false;
  const isFirstPage = (r: Response) => {
    if (!r.url().includes(LIST_API)) return false;
    const q = listQuery(r.url());
    return q.code === code && q.pageNo === 1;
  };
  const target = page.locator('[data-hnw-gu]').first();
  let loaded = page.waitForResponse(isFirstPage, { timeout: 8000 }).catch(() => null);
  await session.click(target).catch(() => {});
  if (await loaded) return true;
  loaded = page.waitForResponse(isFirstPage, { timeout: 8000 }).catch(() => null);
  await target.evaluate((e) => (e as HTMLElement).click()).catch(() => {});
  return !!(await loaded);
}

export const gobang: Collector = {
  id: 'gobang',
  label: '고방',
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    const items: CollectedItem[] = [];
    const gus = gusFor(ctx.areas);
    if (gus.length === 0) {
      ctx.log('고방: 켜진 지역이 서울 구에 닿지 않아 건너뜁니다');
      return items;
    }
    ctx.log(`고방: ${gus.join(', ')}의 ${CATEGORIES.map((c) => c.label).join(', ')} 목록을 봅니다`);

    // 화면이 스스로 불러오는 목록 응답을 옆에서 같이 읽는다.
    let sigungus: { sigunguCode: string; sigunguName: string; houseCount: number }[] = [];
    let wantCode: string | null = null;
    let current = new Map<string, any>();
    /** 화면에 떠 있는 목록(마지막으로 받은 1쪽)의 구 코드와 그 1쪽. 사이트가 종류마다 지난번에 고른 구를 기억해 처음부터 띄워 둘 때가 있다. */
    let shown: { code: string | null; list: any[] } = { code: null, list: [] };
    let blocked: number | null = null;
    const pending: Promise<void>[] = [];
    const onResponse = (r: Response) => {
      const url = r.url();
      if (!url.includes(LIST_API) && !url.includes(SIGUNGU_API)) return;
      pending.push(
        (async () => {
          const status = r.status();
          if (status === 403 || status === 429) {
            blocked = status;
            session.record('gobang', 'data', url, status, '차단 응답');
            return;
          }
          const data: any = await r.json().catch(() => null);
          const list = Array.isArray(data?.result) ? (data.result as any[]) : null;
          if (url.includes(SIGUNGU_API)) {
            if (list) sigungus = list;
            return;
          }
          const q = listQuery(url);
          if (list && q.pageNo === 1) shown = { code: q.code, list };
          if (!list || q.code !== wantCode) {
            session.record('gobang', 'data', url, status, `고르기 전 목록${list ? ` ${list.length}건` : ''}, 저장 안 함`);
            return;
          }
          for (const h of list) if (h?.no) current.set(String(h.no), h);
          session.record('gobang', 'data', url, status, `목록 ${q.pageNo}쪽 ${list.length}건`);
        })(),
      );
    };
    const settle = async () => {
      await Promise.allSettled(pending.splice(0));
      if (blocked) throw new BlockedError(`고방이 목록 요청을 막았습니다(HTTP ${blocked}). 우회하지 않고 멈춥니다.`);
    };

    page.on('response', onResponse);
    try {
      for (const cat of CATEGORIES) {
        sigungus = [];
        wantCode = null;
        shown = { code: null, list: [] };
        ctx.progress(`고방, ${cat.label} 목록 여는 중`);
        const response = await session.goto('gobang', `https://gobang.kr/${cat.path}`);
        const status = response?.status() ?? 0;
        if (status === 403 || status === 429) throw new BlockedError(`고방이 요청을 막았습니다(HTTP ${status}). 우회하지 않고 멈춥니다.`);
        await page.waitForResponse((r) => r.url().includes(SIGUNGU_API), { timeout: 15000 }).catch(() => null);
        await session.pause(1200);
        await settle();

        for (const [gi, gu] of gus.entries()) {
          if (gi > 0) await session.rest();
          const sigungu = sigungus.find((s) => s.sigunguName === gu);
          if (!sigungu) {
            ctx.log(`고방: ${cat.label} ${gu} 칸이 없습니다(0곳)`);
            continue;
          }
          current = new Map();
          wantCode = String(sigungu.sigunguCode);
          ctx.progress(`고방, ${cat.label}, ${gu} (${sigungu.houseCount}곳)`);
          // 이미 그 구 목록이 떠 있으면 누르지 않고 그 1쪽부터 쓴다(골라진 칸을 다시 누르면 목록을 다시 불러오지 않음).
          const already = shown.code === wantCode;
          if (already) for (const h of shown.list) if (h?.no) current.set(String(h.no), h);
          const picked = already || (await pickGu(session, gu, wantCode));
          await session.pause(1000);
          await settle();
          if (!picked) {
            ctx.log(`고방: ${cat.label} ${gu} 칸을 눌렀는데 목록이 바뀌지 않았습니다`);
            continue;
          }
          session.record('gobang', 'action', page.url(), null, `${cat.label}, ${gu} ${already ? '이미 골라져 있음' : '고르기'}`);

          // 목록을 내려 다음 쪽을 불러오게 한다(쪽마다 40곳).
          let stalls = 0;
          let lastCount = current.size;
          for (let round = 0; current.size < sigungu.houseCount && stalls < 3 && round < MAX_ROUNDS; round++) {
            ctx.progress(`고방, ${cat.label}, ${gu}, ${current.size}/${sigungu.houseCount}곳 읽음`);
            for (let i = 0; i < 5; i++) {
              await session.wheel(640, 520, 1400);
              await session.pause(250);
            }
            await session.pause(1000);
            await settle();
            if (current.size > lastCount) {
              stalls = 0;
              lastCount = current.size;
            } else stalls += 1;
          }
          if (current.size < sigungu.houseCount) ctx.log(`고방: ${cat.label} ${gu} ${sigungu.houseCount}곳 중 ${current.size}곳까지 불러와졌습니다`);

          const thumbs = await tagCards(session);
          const listings = [...current.values()].map((h) => normalize(h, thumbs[String(h.no)] ?? null)).filter((x): x is NormalizedListing => !!x);
          const tones = ctx.classify(listings);
          await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
          await session.badges(listings.map((l) => ({ selector: `li[data-hnw-gobang="${l.sourceId}"]`, tone: tones.get(l.sourceId) ?? 'new' })), 30);
          const shot = await session.screenshot('gobang', `${cat.label}-${gu}`);
          ctx.log(`고방: ${cat.label} ${gu} ${listings.length}곳 읽음`);
          for (const listing of listings) items.push({ listing, raw: current.get(listing.sourceId), pageUrl: page.url(), screenshot: shot });
          wantCode = null;
          await session.pause(PAGE_DELAY_MS);
        }
      }
    } finally {
      page.off('response', onResponse);
    }
    return items;
  },
};
