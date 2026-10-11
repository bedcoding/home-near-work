import { gusFor } from './gus.js';
import { BlockedError, toNumber, type Collector, type CollectedItem } from './types.js';
import { priceText } from '../../shared/format.js';
import { LAND_PREFIX, SHOP_PREFIX, type NormalizedListing } from '../../shared/types.js';

// 온비드(한국자산관리공사) 공매 중 서울 주거용, 가게(상가), 토지 매각 물건. 지도검색 화면을 조작하고, 화면이 받는 검색 응답(위경도 포함)을 읽는다.
// 지도검색은 오늘부터 석 달 안에 입찰이 진행되는 물건만 보여 준다(화면 안내). 구 이름으로 검색하므로 구 전체를 매번 다시 본다.

const HOME = 'https://www.onbid.co.kr/';
const MAP_URL = 'https://www.onbid.co.kr/op/cltrpbancinf/cltr/cltrmapsrch/CltrMapSrchController/mvmnCltrMapSrchClg.do';
const DETAIL_URL = 'https://www.onbid.co.kr/op/cltrpbancinf/cltrdtl/CltrDtlController/mvmnCltrDtl.do';
const SEARCH_API = '/CltrMapSrchController/srchCltrMap.do';

/**
 * 고를 용도: 주거용건물(아파트, 빌라, 단독, 다가구, 다세대, 도시형생활주택, 연립), 용도복합용건물의 오피스텔,
 * 상가용및업무용건물의 가게 쪽(근린생활시설, 판매시설, 기타상가용및업무용, 기타근린생활시설, 구매시설, 상업용빌딩, 시장), 토지 일부
 */
const USES = [
  { first: '10200', second: ['10201', '10203', '10204', '10205', '10206', '10208', '10209'] },
  { first: '10500', second: ['10503'] },
  { first: '10300', second: ['10301', '10304', '10323', '10326', '10337', '10339', '10340'] },
  // 토지 중 집을 지을 수 있거나 지목을 바꿔 지을 수 있는 쪽: 대지, 주택부지, 잡종지, 전, 답, 임야, 토지, 기타토지
  { first: '10100', second: ['10101', '31253', '10106', '10103', '10104', '10102', '31254', '10129'] },
];
/** 사이트가 1281px 이상에서만 PC 검색 칸을 보여 준다. */
const VIEWPORT = { width: 1400, height: 860 };

/** 검색 응답의 물건 한 건(쓰는 칸만). 금액은 원. */
interface OnbidRow {
  onbidCltrno?: string | number;
  scrnIndctCltrMngNo?: string;
  onbidCltrNm?: string;
  sidoSgkEmd?: string;
  emdNm?: string;
  ctgrNm?: string;
  ctgrFullNm?: string;
  bldSqms?: number | string;
  landSqms?: number | string;
  cltrApslEvlAvgAmt?: number | string;
  lowstBidPrc?: number | string;
  lowstBidPrcHideDivCd?: string;
  feeRate?: string;
  uscbdCnt?: string | number;
  pbctBegnDtm?: string;
  pbctDdlnDt?: string;
  pbctExctDt?: string;
  pbctCltrStatNm?: string;
  scrnPrptDvsnNm?: string;
  dspsMthodNm?: string;
  alcYn?: string;
  lat?: string | number;
  lng?: string | number;
  cltrScrnGrpCd?: string;
  cltrPrptDivCd?: string;
  onbidPbancNo?: string | number;
  pbctNo?: string | number;
  pbctCdtnNo?: string | number;
}

/** 물건 상세 주소(화면이 POST로 넘기는 여섯 값을 GET으로 붙이면 세션 없이 열린다). */
function detailUrl(r: OnbidRow): string {
  const q = new URLSearchParams({
    cltrScrnGrpCd: String(r.cltrScrnGrpCd ?? ''),
    cltrPrptDivCd: String(r.cltrPrptDivCd ?? ''),
    onbidCltrno: String(r.onbidCltrno ?? ''),
    onbidPbancNo: String(r.onbidPbancNo ?? ''),
    pbctNo: String(r.pbctNo ?? ''),
    pbctCdtnNo: String(r.pbctCdtnNo ?? ''),
  });
  return `${DETAIL_URL}?${q}`;
}

const won = (v: unknown) => {
  const n = toNumber(v);
  return n && n > 0 ? Math.round(n / 10000) : null;
};

/** 물건 이름의 층: '제3층' → 3, '제지하층'과 '지하1층' → 지하 */
function floorOf(name: string): { floor: number | null; basement: boolean | null } {
  if (/제?\s*지하\s*\d*\s*층|지층/.test(name)) return { floor: null, basement: true };
  const m = /제?\s*(\d+)\s*층/.exec(name);
  return { floor: m ? Number(m[1]) : null, basement: m ? false : null };
}

function normalize(r: OnbidRow): NormalizedListing | null {
  const id = r.onbidCltrno != null ? String(r.onbidCltrno) : '';
  const name = String(r.onbidCltrNm ?? '').replace(/\s+/g, ' ').trim();
  if (!id || !name) return null;
  const price = r.lowstBidPrcHideDivCd === '0001' ? won(r.lowstBidPrc) : null;
  const opening = /^\d{4}-\d{2}-\d{2}/.exec(r.pbctExctDt ?? '')?.[0] ?? null;
  const { floor, basement } = floorOf(name);
  /** 토지 용도(10100 아래)면 면적은 토지 면적 */
  const land = /토지/.test(r.ctgrFullNm ?? '');
  const address = name.replace(/^서울특별시\s*/, '');
  const listing: NormalizedListing = {
    source: 'onbid',
    sourceId: id,
    url: detailUrl(r),
    title: address,
    thumbnail: null,
    lat: toNumber(r.lat),
    lng: toNumber(r.lng),
    address,
    dong: r.emdNm ?? null,
    buildingKey: null,
    buildingType: land ? `${LAND_PREFIX}${r.ctgrNm ?? '토지'}` : /상가용및업무용/.test(r.ctgrFullNm ?? '') ? `${SHOP_PREFIX}${r.ctgrNm ?? '상가'}` : (r.ctgrNm ?? null),
    roomLabel: null,
    rooms: null,
    areaM2: toNumber(land ? r.landSqms : r.bldSqms),
    floor,
    totalFloors: null,
    basement,
    rooftop: null,
    builtYear: null,
    maintenance: null,
    elevator: null,
    parking: null,
    availableFrom: null,
    // 경매 탭은 updatedAt을 매각기일로 쓴다(온비드는 개찰일).
    updatedAt: opening,
    prices: [{ deal: 'auction', deposit: null, monthly: null, price }],
  };
  listing.explain = [
    { label: '최저입찰가', raw: `lowstBidPrc=${r.lowstBidPrc ?? '없음'}, lowstBidPrcHideDivCd=${r.lowstBidPrcHideDivCd ?? ''} (원)`, value: listing.prices.map(priceText).join(', '), note: '공개(0001)일 때만 씀. 감정가 대비 feeRate ' + (r.feeRate ?? '?') + '%' },
    { label: '감정가', raw: `cltrApslEvlAvgAmt=${r.cltrApslEvlAvgAmt ?? '없음'} (원)`, value: won(r.cltrApslEvlAvgAmt) != null ? `${won(r.cltrApslEvlAvgAmt)}만원` : '모름' },
    { label: '개찰일', raw: `pbctExctDt="${r.pbctExctDt ?? ''}", 입찰 ${r.pbctBegnDtm ?? '?'} ~ ${r.pbctDdlnDt ?? '?'}`, value: opening ?? '모름', note: '경매 탭에서 매각기일 자리에 씀' },
    { label: '유찰', raw: `uscbdCnt=${r.uscbdCnt ?? ''}`, value: `${toNumber(r.uscbdCnt) ?? 0}회` },
    { label: '용도와 면적', raw: `ctgrFullNm="${r.ctgrFullNm ?? ''}", bldSqms=${r.bldSqms ?? ''}, landSqms=${r.landSqms ?? ''}`, value: `${listing.buildingType ?? '모름'}, ${land ? '토지' : '건물'} ${listing.areaM2 ?? '?'}㎡` },
    { label: '재산 유형과 상태', raw: `scrnPrptDvsnNm="${r.scrnPrptDvsnNm ?? ''}", dspsMthodNm="${r.dspsMthodNm ?? ''}", pbctCltrStatNm="${r.pbctCltrStatNm ?? ''}", alcYn=${r.alcYn ?? ''}`, value: `${r.scrnPrptDvsnNm ?? ''} ${r.pbctCltrStatNm ?? ''}`.trim() },
    { label: '위치', raw: `lat=${r.lat ?? ''}, lng=${r.lng ?? ''}`, value: listing.lat != null ? `${listing.lat}, ${listing.lng}` : '모름' },
  ];
  return listing;
}

export const onbid: Collector = {
  id: 'onbid',
  label: '온비드',
  wholeDistrict: true,
  emptyOk: true,
  async collect(ctx) {
    const gus = gusFor(ctx.areas);
    if (!gus.length) {
      ctx.log('온비드: 켜진 지역이 서울 구에 닿지 않아 건너뜁니다');
      return [];
    }
    const { session } = ctx;
    const page = session.page;
    const before = page.viewportSize();
    await page.setViewportSize(VIEWPORT);
    try {
      ctx.progress('온비드: 첫 화면을 여는 중');
      const home = await session.goto('onbid', HOME);
      if (home && (home.status() === 403 || home.status() === 429)) throw new BlockedError(`HTTP ${home.status()}`);
      // 첫 화면은 접속 대기열을 거쳐 메인으로 넘어간다(기다리기만 한다).
      await page.waitForURL(/main\.do/, { timeout: 90000 }).catch(() => {});

      ctx.progress('온비드: 지도검색 화면을 여는 중');
      const res = await session.goto('onbid', MAP_URL);
      if (res && (res.status() === 403 || res.status() === 429)) throw new BlockedError(`HTTP ${res.status()}`);
      await page.locator('#srchMapSwd').waitFor({ state: 'visible', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

      /** 화면이 검색하는 동안 덮는 '불러오는 중' 막이 걷힐 때까지 기다린다(막 위를 누르면 아무 일도 안 일어남). */
      const idle = () => page.locator('.loading_wrap .dimmed').first().waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
      /** 조건 칸(처분방식, 용도)을 눌러 펼친다. 안 펼쳐지면 몇 번 더 누른다. */
      const openTab = async (tab: string, inside: string) => {
        const shown = page.locator(inside).first();
        for (let i = 0; i < 4 && !(await shown.isVisible()); i++) {
          await idle();
          await session.click(page.locator(`a[data-tab="${tab}"]`).first());
          await shown.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
        }
        if (!(await shown.isVisible())) throw new Error('검색 조건 칸을 열지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
      };
      /** 확인을 누르면 화면이 그 조건으로 다시 검색한다. 끝날 때까지 기다린다. */
      const confirm = async (panel: string) => {
        const searched = page.waitForResponse((r) => r.url().includes(SEARCH_API), { timeout: 20000 }).catch(() => null);
        await session.click(page.locator(`#${panel} .sh_bottom button.primary`));
        await searched;
        await idle();
        await session.pause(600);
      };

      ctx.progress('온비드: 처분방식 매각, 주거용 고르기');
      await openTab('scrh_dsps', '#scrh_dsps label[for="srchDspsMthod_pc_2"]');
      await session.click(page.locator('#scrh_dsps label[for="srchDspsMthod_pc_2"]'));
      await confirm('scrh_dsps');
      await openTab('scrh_usg', `#scrh_usg #firstCtgrList button[value="${USES[0].first}"]`);
      for (const use of USES) {
        await session.click(page.locator(`#scrh_usg #firstCtgrList button[value="${use.first}"]`));
        await page.locator(`#scrh_usg #secondCtgrList label[for="secondCtgrId_${use.second[0]}"]`).waitFor({ state: 'visible', timeout: 5000 });
        for (const id of use.second) await session.click(page.locator(`#scrh_usg #secondCtgrList label[for="secondCtgrId_${id}"]`));
      }
      await confirm('scrh_usg');

      const out: CollectedItem[] = [];
      for (const gu of gus) {
        ctx.progress(`온비드: '${gu}' 검색`);
        await idle();
        const input = page.locator('#srchMapSwd');
        await session.click(input);
        await input.fill('');
        await session.type(gu);
        const wait = page
          .waitForResponse(
            (r) => {
              if (!r.url().includes(SEARCH_API)) return false;
              const q = new URLSearchParams(r.request().postData() ?? '');
              return q.get('pageType') === 'N' && q.get('srchMapCltrNmRegion') === gu;
            },
            { timeout: 30000 },
          )
          .catch(() => null);
        await idle();
        await session.click(page.locator('.ico_btn_search[data-windowtype="pc"]').first());
        const r = await wait;
        if (!r) throw new Error(`'${gu}' 검색 결과를 받지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.`);
        session.record('onbid', 'data', r.url(), r.status(), `지도검색 ${gu}`);
        if (r.status() === 403 || r.status() === 429) throw new BlockedError(`HTTP ${r.status()}`);
        // 응답 형식 표시는 text/html이지만 내용은 JSON이다.
        const data = JSON.parse(await r.text()) as { cltrClgVOList?: OnbidRow[]; cltrSrchVO?: Record<string, unknown> };
        const vo = data.cltrSrchVO ?? {};
        // 고른 조건(매각, 주거용)이 빠진 채 검색되면 전국 물건이 오므로 멈춘다.
        if (vo.srchDspsMthod !== '0001' || !String(vo.srchArrayCtgrId ?? '').includes('10201')) {
          throw new Error('검색 조건(매각, 주거용)이 적용되지 않았습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
        }
        if (!Array.isArray(data.cltrClgVOList)) throw new Error('검색 결과를 읽지 못했습니다. 사이트 화면 구조가 바뀌었을 수 있습니다.');
        const rows = data.cltrClgVOList.filter((row) => (row.sidoSgkEmd ?? '').startsWith(`서울특별시 ${gu}`));
        ctx.log(`온비드: ${gu} ${rows.length}건 (응답 ${data.cltrClgVOList.length}건)`);
        const screenshot = await session.screenshot('onbid', `지도검색 ${gu}`);
        for (const row of rows) {
          const listing = normalize(row);
          if (listing) out.push({ listing, raw: row, pageUrl: MAP_URL, screenshot });
        }
        await session.pause(800);
      }
      return out;
    } finally {
      if (before) await page.setViewportSize(before).catch(() => {});
    }
  },
};
