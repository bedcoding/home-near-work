import proj4 from 'proj4';
import type { Response } from 'playwright';
import type { BrowserSession } from '../browser.js';
import { PAGE_DELAY_MS } from '../config.js';
import { gusFor } from './gus.js';
import { BlockedError, toNumber, type Collector, type CollectedItem } from './types.js';
import { floorText, money } from '../../shared/format.js';
import { isApartmentType, LAND_PREFIX, SHOP_PREFIX, type ExplainRow, type NormalizedListing } from '../../shared/types.js';

// 법원경매정보(매일 01:00~06:00 서비스 중단).
// 검색 화면에서 소재지(지번주소) → 서울특별시 → 구 → 용도(건물 > 주거용건물, 건물 > 상업용및업무용, 토지)를 차례로 고르고 검색한다.
// 데이터는 그때 화면이 불러오는 검색 응답을 같이 읽는다.
// 매각기일 기간은 화면마다 정해져 있다: 물건상세검색은 오늘부터 14일, 매각예정물건은 15일 뒤부터 60일 뒤까지(기본값이 그 범위).
// 그래서 구마다 두 화면을 차례로 본다. 두 화면의 결과 화면·검색 응답은 같다.
// 켜진 지역 근처 구는 세 용도를 다 보고, 서울 아파트 탭에서 고른 구 중 근처가 아닌 구는 주거용 건물만 검색해 아파트만 남긴다.

export const FORM_URL = 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml';
/** 매각예정물건(15일 뒤부터 60일 뒤까지 매각기일) 검색 화면 */
export const SCHEDULE_URL = 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ157M00.xml';
export const SEARCH_API = 'searchControllerMain.on';
export const ID = {
  courtRadio: 'label[for="mf_wfm_mainFrame_rad_rletSrchBtn_input_0"]',
  court: '#mf_wfm_mainFrame_sbx_rletCortOfc',
  caseYear: '#mf_wfm_mainFrame_sbx_rletCsYear',
  caseNo: '#mf_wfm_mainFrame_ibx_rletCsNo',
  locationRadio: 'label[for="mf_wfm_mainFrame_rad_rletSrchBtn_input_1"]',
  sido: '#mf_wfm_mainFrame_sbx_rletAdongSdS',
  sigungu: '#mf_wfm_mainFrame_sbx_rletAdongSggS',
  usageL: '#mf_wfm_mainFrame_sbx_rletLclLst',
  usageM: '#mf_wfm_mainFrame_sbx_rletMclLst',
  periodFrom: '#mf_wfm_mainFrame_cal_rletPerdStr_input',
  periodTo: '#mf_wfm_mainFrame_cal_rletPerdEnd_input',
  search: '#mf_wfm_mainFrame_btn_gdsDtlSrch',
  pageSize: '#mf_wfm_mainFrame_sbx_pageSize',
  pageLink: (n: number) => `#mf_wfm_mainFrame_pgl_gdsDtlSrchPage_page_${n}`,
};

/** 소재지·용도로 찾는 검색 화면 두 곳(이 순서로 본다). */
const SCREENS = [
  {
    name: '물건상세검색',
    url: FORM_URL,
    locationRadio: ID.locationRadio,
    sido: ID.sido,
    sigungu: ID.sigungu,
    usageL: ID.usageL,
    usageM: ID.usageM,
    periodFrom: ID.periodFrom,
    periodTo: ID.periodTo,
    search: ID.search,
  },
  {
    name: '매각예정물건',
    url: SCHEDULE_URL,
    locationRadio: 'label[for="mf_wfm_mainFrame_rad_dspslSchdGdsSrchSt_input_1"]',
    sido: '#mf_wfm_mainFrame_sbx_dspslSchdGdsAdongSdS',
    sigungu: '#mf_wfm_mainFrame_sbx_dspslSchdGdsAdongSggS',
    usageL: '#mf_wfm_mainFrame_sbx_dspslSchdGdsLclLst',
    usageM: '#mf_wfm_mainFrame_sbx_dspslSchdGdsMclLst',
    periodFrom: '#mf_wfm_mainFrame_cal_dspslSchdGdsPerdStr_input',
    periodTo: '#mf_wfm_mainFrame_cal_dspslSchdGdsPerdEnd_input',
    search: '#mf_wfm_mainFrame_btn_dspslSchdGdsSrch',
  },
];
type Screen = (typeof SCREENS)[number];

/** 검색하는 용도: 건물 아래 중분류(집과 상가)와 토지(중분류를 고르지 않아 지목 전부) */
const SEARCHES = [
  { kind: 'home', large: '건물', middle: '주거용건물' },
  { kind: 'shop', large: '건물', middle: '상업용및업무용' },
  { kind: 'land', large: '토지', middle: null },
] as const;
type Search = (typeof SEARCHES)[number];
const searchName = (s: Search) => s.middle ?? s.large;

// 검색 응답의 xCordi/yCordi는 KATEC(TM128) 좌표다.
const KATEC = '+proj=tmerc +lat_0=38 +lon_0=128 +k=0.9999 +x_0=400000 +y_0=600000 +ellps=bessel +towgs84=-146.43,507.89,681.46 +units=m +no_defs';

/** 법원 날짜 글자(YYYYMMDD)를 YYYY-MM-DD로. 모양이 다르면 null. */
export const ymd = (s: unknown) => {
  const v = String(s ?? '');
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null;
};

/**
 * 목록 면적 글자('철근콘크리트구조 29.49㎡', '1층 137.39㎡ 2층 138.64㎡ 지층 137.39㎡')의 ㎡ 값을 모두 더한다.
 * ㎡ 없이 평만 적혀 있으면('건평 4평') 평을 ㎡로 바꿔 더한다. 없으면 null.
 */
function areaOf(text: string): number | null {
  const m2 = [...text.matchAll(/(\d+(?:\.\d+)?)\s*㎡/g)].map((m) => Number(m[1]));
  const values = m2.length ? m2 : [...text.matchAll(/(\d+(?:\.\d+)?)\s*평/g)].map((m) => Number(m[1]) * 3.3058);
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100 : null;
}

/** 목록 한 줄의 면적 글자: areaList, 비었으면 pjbBuldList, convAddr('[집합건물 철근콘크리트구조 20.665㎡]') 순서. */
const areaText = (row: any): string =>
  [row.areaList, row.pjbBuldList, row.convAddr].map((v) => String(v ?? '').trim()).find((v) => /㎡|\d\s*평/.test(v)) ?? '';

const isLand = (row: any) => String(row.convAddr ?? '').startsWith('[토지');

/** 목록 글자의 지분('공유자 지분 112분의 3', '공유자지분 중 4분의 1')을 비율로. 지분이 없으면 1. */
function shareOf(row: any): number {
  const m = /(\d[\d,.]*)\s*분의\s*(\d[\d,.]*)/.exec(String(row.convAddr ?? ''));
  if (!m) return 1;
  const whole = Number(m[1].replace(/,/g, ''));
  const part = Number(m[2].replace(/,/g, ''));
  return whole > 0 && part > 0 && part <= whole ? part / whole : 1;
}

/** 검색 결과 행을 물건(같은 법원·사건·물건번호)별로 묶는다. 한 물건의 목록(토지, 건물 호실 등)은 한 줄씩 온다. 묶음 안은 목록 번호 순서. */
export function lotsOf(rows: any[]): any[][] {
  const lots = new Map<string, any[]>();
  for (const r of rows) {
    if (!r?.docid) continue;
    const key = `${r.boCd}-${r.saNo}-${r.maemulSer}`;
    lots.set(key, [...(lots.get(key) ?? []), r]);
  }
  return [...lots.values()].map((lot) => lot.sort((a, b) => Number(a.mokmulSer) - Number(b.mokmulSer)));
}

/**
 * 물건 하나(lotsOf의 묶음)를 매물로 바꾼다. 번호, 주소, 가격은 첫 목록에서 읽는다.
 * 면적은 건물 목록 면적(areaText)의 합(건물 목록이 없으면 토지 면적, 지분이면 지분만큼), 층은 건물 목록이 하나일 때 호실 글자('2층201호', '지하1층')에서 읽는다.
 */
export function normalizeLot(rows: any[]): NormalizedListing {
  const row = rows[0];
  const buildings = rows.filter((r) => !isLand(r));
  const areaRows = buildings.length ? buildings : rows;
  const shares = buildings.length ? [] : rows.map(shareOf);
  const areas = areaRows.map((r, i) => {
    const a = areaOf(areaText(r));
    return a == null ? null : a * (shares[i] ?? 1);
  });
  const areaM2 = areas.every((a) => a != null) ? Math.round(areas.reduce((s, a) => s + a!, 0) * 100) / 100 : null;
  const unit = buildings.length === 1 ? String(buildings[0].buldList ?? '') : '';
  const floorMatch = /(\d+)층/.exec(unit);
  const basement = /지하|지층/.test(unit) ? true : floorMatch ? false : null;
  const appraisal = toNumber(row.gamevalAmt);
  const notified = toNumber(row.notifyMinmaePrice1);
  const minPrice = notified && notified > 0 ? notified : toNumber(row.minmaePrice);
  const rate = appraisal && minPrice ? Math.round((minPrice / appraisal) * 100) : null;
  const x = toNumber(row.xCordi);
  const y = toNumber(row.yCordi);
  let lat: number | null = null;
  let lng: number | null = null;
  if (x && y) {
    const [lon, la] = proj4(KATEC, 'EPSG:4326', [x, y]);
    lat = Number(la.toFixed(6));
    lng = Number(lon.toFixed(6));
  }
  const saleDate = ymd(row.maeGiil);
  const failed = toNumber(row.yuchalCnt) ?? 0;
  const listing: NormalizedListing = {
    source: 'courtauction',
    sourceId: String(row.docid),
    url: FORM_URL,
    title: [
      `${row.srnSaNo ?? ''}${row.maemulSer && row.maemulSer !== '1' ? `(${row.maemulSer})` : ''}`,
      row.dspslUsgNm ?? '',
      `유찰 ${failed}회`,
      rows.length > 1 ? `${rows.length}개 일괄매각` : null,
      shares.some((x) => x < 1) ? '지분' : null,
      `매각기일 ${saleDate ?? '?'}`,
    ]
      .filter(Boolean)
      .join(', '),
    thumbnail: null,
    lat,
    lng,
    address: String(row.printSt ?? '').trim() || null,
    dong: row.hjguDong ?? null,
    buildingKey: `ca-${row.boCd}-${row.saNo}-${row.maemulSer}`,
    buildingType: row.dspslUsgNm ?? null,
    roomLabel: '경매',
    rooms: null,
    areaM2,
    floor: floorMatch && !basement ? Number(floorMatch[1]) : null,
    totalFloors: null,
    basement,
    rooftop: null,
    builtYear: null,
    maintenance: null,
    elevator: null,
    parking: null,
    availableFrom: null,
    updatedAt: saleDate,
    prices: minPrice ? [{ deal: 'auction', deposit: null, monthly: null, price: Math.round(minPrice / 10000) }] : [],
  };
  const explain: ExplainRow[] = [
    { label: '사건', raw: `srnSaNo="${row.srnSaNo}", maemulSer=${row.maemulSer}`, value: `${row.srnSaNo} 물건 ${row.maemulSer}`, note: '법원경매정보에서 사건번호로 검색하면 상세가 나옴' },
    { label: '법원·담당', raw: `jiwonNm="${row.jiwonNm}", jpDeptNm="${row.jpDeptNm}", tel="${row.tel ?? ''}"`, value: `${row.jiwonNm} ${row.jpDeptNm}` },
    { label: '감정가', raw: `gamevalAmt=${row.gamevalAmt}원`, value: appraisal ? `${money(Math.round(appraisal / 10000))}만` : '모름', note: '원 → 만원' },
    {
      label: '최저매각가격',
      raw: `notifyMinmaePrice1=${row.notifyMinmaePrice1}원, minmaePrice=${row.minmaePrice}원`,
      value: minPrice ? `${money(Math.round(minPrice / 10000))}만 (감정가의 ${rate ?? '?'}%)` : '모름',
      note: '이번 매각기일의 최저가(notifyMinmaePrice1)를 쓰고, 없으면 minmaePrice. 유찰되면 내려가서 가격 인하로 잡힘',
    },
    { label: '유찰 횟수', raw: `yuchalCnt=${row.yuchalCnt}`, value: `${failed}회` },
    { label: '매각기일', raw: `maeGiil=${row.maeGiil}, maeHh1=${row.maeHh1}, maePlace="${row.maePlace ?? ''}"`, value: `${saleDate ?? '?'} ${row.maeHh1 ? `${String(row.maeHh1).slice(0, 2)}:${String(row.maeHh1).slice(2)}` : ''} ${row.maePlace ?? ''}` },
    { label: '소재지', raw: `printSt="${String(row.printSt ?? '').trim()}"`, value: listing.address ?? '모름' },
    ...(rows.length > 1
      ? [{ label: '목록', raw: `mokmulSer ${rows.map((r) => r.mokmulSer).join(', ')}`, value: `${rows.length}개를 매물 하나로 합침`, note: '같은 사건·물건번호의 목록(토지·호실)은 함께 매각됨' }]
      : []),
    {
      label: '용도·면적',
      raw: `dspslUsgNm="${row.dspslUsgNm}", ${areaRows.map((r) => `"${areaText(r)}"`).join(', ').slice(0, 400)}`,
      value: `${row.dspslUsgNm}, ${listing.areaM2 ?? '?'}㎡`,
      note: [
        areaRows.length > 1 ? (buildings.length ? '건물 목록 면적의 합(토지 제외)' : '토지 목록 면적의 합') : null,
        shares.some((x) => x < 1) ? `지분 매각이라 지분만큼(${shares.map((x) => Math.round(x * 10000) / 100).join(', ')}%)` : null,
      ].filter(Boolean).join(', ') || undefined,
    },
    ...(unit ? [{ label: '층', raw: `buldList="${unit}"`, value: basement ? '지하' : floorText(listing) }] : []),
    { label: '위치', raw: `xCordi=${row.xCordi}, yCordi=${row.yCordi} (KATEC)`, value: `${lat}, ${lng}`, note: 'KATEC 좌표를 위경도로 변환' },
    { label: '비고', raw: String(row.mulBigo ?? '').slice(0, 300) || '없음', value: '(원문 그대로)' },
  ];
  listing.explain = explain;
  return listing;
}


/** 화면을 열면 뜨는 안내 창을 닫는다(닫기 버튼이 보이는 동안 세 번까지). */
export async function closeNotices(session: BrowserSession) {
  for (let i = 0; i < 3; i++) {
    const button = session.page.locator('button:visible', { hasText: /^(닫기|창닫기)$/ }).first();
    if (!(await button.isVisible().catch(() => false))) break;
    await session.click(button).catch(() => {});
    await session.pause(500);
  }
}

/** 선택 상자 위로 커서를 옮긴 뒤 값을 고른다(누르면 펼쳐지는 목록이 남지 않게 값만 바꾼다). */
export async function choose(session: BrowserSession, selector: string, value: string) {
  const locator = session.page.locator(selector);
  await session.hover(locator);
  await locator.selectOption(value);
  await session.pause(900);
}

export const courtauction: Collector = {
  id: 'courtauction',
  label: '법원경매',
  wholeDistrict: true,
  async collect(ctx) {
    const { session } = ctx;
    const page = session.page;
    const items: CollectedItem[] = [];
    const near = gusFor(ctx.areas);
    const aptGus = new Set(ctx.aptGus);
    /** 고른 구 중 근처가 아닌 구: 주거용 건물만 검색해 아파트만 남긴다 */
    const aptOnly = ctx.aptGus.filter((gu) => !near.includes(gu));
    const plan = [
      ...near.map((gu) => ({ gu, searches: [...SEARCHES], onlyApt: false })),
      ...aptOnly.map((gu) => ({ gu, searches: [SEARCHES[0]], onlyApt: true })),
    ];
    ctx.log(
      [
        near.length
          ? `법원경매: 소재지 ${near.join(', ')}의 주거용 건물, 상업용 건물, 토지를 검색합니다`
          : `법원경매: 켜진 지역 근처에 서울 역이 없어 근처 구를 정하지 못했습니다(검색은 서울특별시만 합니다)${aptOnly.length ? '' : '. 건너뜁니다'}`,
        aptOnly.length ? `서울 아파트 탭에서 고른 ${aptOnly.join(', ')}는 주거용 건물을 검색해 아파트만 남깁니다` : '',
      ]
        .filter(Boolean)
        .join('. '),
    );

    const readRows = async (response: Response | null) => {
      if (!response) return null;
      const data: any = await response.json().catch(() => null);
      session.record('courtauction', 'data', response.url(), response.status(), data ? `검색 결과 ${data.data?.dlt_srchResult?.length ?? 0}건 (전체 ${data.data?.dma_pageInfo?.totalCnt ?? '?'}건)` : '응답을 읽지 못함');
      if (!data) return null;
      return { rows: (data.data?.dlt_srchResult ?? []) as any[], total: Number(data.data?.dma_pageInfo?.totalCnt ?? 0) };
    };

    /**
     * 한 검색 화면에서 소재지 서울특별시 gu, 용도(건물 > 주거용건물이나 상업용및업무용, 또는 토지)로 검색해 결과를 모두 읽는다
     * (40건씩 보고, 남으면 쪽을 넘긴다). 매각기일은 그 화면의 기본 기간 그대로 둔다. 검색 응답이 없으면 null.
     */
    const searchScreen = async (screen: Screen, gu: string, step: string, search: Search): Promise<Map<string, any> | null> => {
      const usage = searchName(search);
      ctx.progress(`법원경매, ${gu} ${step}, ${screen.name} 여는 중`);
      const response = await session.goto('courtauction', screen.url);
      const status = response?.status() ?? 0;
      if (status === 403 || status === 429) throw new BlockedError(`법원경매정보가 요청을 막았습니다(HTTP ${status}). 우회하지 않고 멈춥니다.`);
      await page.waitForSelector(screen.search, { timeout: 25000 }).catch(() => {
        throw new Error('검색 화면이 열리지 않았습니다. 서비스 점검 시간(매일 01~06시, 연휴 공사 등)일 수 있습니다.');
      });
      await session.pause(1000);
      await closeNotices(session);

      ctx.progress(`법원경매, ${gu}, ${screen.name}, ${usage}, 소재지와 용도 고르는 중`);
      await session.click(page.locator(screen.locationRadio));
      await session.pause(700);
      await choose(session, screen.sido, '서울특별시');
      await choose(session, screen.sigungu, gu);
      await choose(session, screen.usageL, search.large);
      if (search.middle) await choose(session, screen.usageM, search.middle);
      const period = await page.evaluate(({ from, to }) => [
        (document.querySelector(from) as HTMLInputElement | null)?.value,
        (document.querySelector(to) as HTMLInputElement | null)?.value,
      ], { from: screen.periodFrom, to: screen.periodTo });
      const label = `${period[0]} ~ ${period[1]}`;
      session.record('courtauction', 'action', page.url(), null, `${screen.name}, 소재지 서울특별시 ${gu}, 용도 ${search.middle ? `${search.large}>${search.middle}` : search.large}, 매각기일 ${label}`);

      ctx.progress(`법원경매, ${gu}, ${screen.name}, ${usage}, 매각기일 ${label} 검색`);
      const first = page.waitForResponse((r) => r.url().includes(SEARCH_API), { timeout: 25000 }).catch(() => null);
      await session.click(page.locator(screen.search));
      let result = await readRows(await first);
      if (!result) return null;
      const found = new Map<string, any>();
      for (const r of result.rows) found.set(String(r.docid), r);
      const total = result.total;
      await session.pause(1200);
      if (total > found.size && (await page.locator(ID.pageSize).inputValue().catch(() => '')) !== '40') {
        const bigger = page.waitForResponse((r) => r.url().includes(SEARCH_API), { timeout: 15000 }).catch(() => null);
        await choose(session, ID.pageSize, '40');
        result = await readRows(await bigger);
        for (const r of result?.rows ?? []) found.set(String(r.docid), r);
      }
      for (let pageNo = 2; found.size < total && pageNo <= 10; pageNo++) {
        const link = page.locator(ID.pageLink(pageNo));
        if (!(await link.count())) break;
        ctx.progress(`법원경매, ${gu}, ${screen.name}, ${usage}, 결과 ${pageNo}쪽`);
        const next = page.waitForResponse((r) => r.url().includes(SEARCH_API), { timeout: 15000 }).catch(() => null);
        await session.click(link);
        const more = await readRows(await next);
        for (const r of more?.rows ?? []) found.set(String(r.docid), r);
        await session.pause(1200);
      }
      ctx.log(`법원경매: ${gu} ${usage} ${total}건 중 ${found.size}건 읽음 (${screen.name}, 매각기일 ${label})`);
      return found;
    };

    for (const [i, { gu, searches, onlyApt }] of plan.entries()) {
      const rows = new Map<string, any>();
      /** 목록 행 번호(docid) → 그 행을 읽은 화면 주소와 스크린샷 */
      const seenOn = new Map<string, { url: string; shot: string | null }>();
      /** 검색 종류(주거, 상가, 토지)마다 찾은 목록 행 번호 */
      const idsOf = { home: new Set<string>(), shop: new Set<string>(), land: new Set<string>() };
      for (const screen of SCREENS) {
        for (const search of searches) {
          const usage = searchName(search);
          let found: Map<string, any> | null = null;
          try {
            found = await searchScreen(screen, gu, `(${i + 1}/${plan.length})`, search);
          } catch (e) {
            // 근처 구는 첫 화면 검색이 안 되면 이 소스를 멈추고, 매각예정물건만 안 되면 앞 화면 결과로 계속한다.
            // 고른 구(아파트만)는 그 화면만 건너뛰고 계속한다(다 돈 것으로 보지 않아 그 구 물건이 '사라짐'이 되지 않는다).
            if (e instanceof BlockedError || (screen === SCREENS[0] && !onlyApt)) throw e;
            ctx.log(`법원경매: ${gu} ${screen.name} ${usage}를 보지 못했습니다(${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
            if (onlyApt) ctx.partial(`법원경매 ${gu} ${screen.name}`);
          }
          if (!found) {
            ctx.log(`법원경매: ${gu} ${screen.name} ${usage} 검색 응답을 받지 못했습니다`);
            if (onlyApt) ctx.partial(`법원경매 ${gu} ${screen.name}`);
            continue;
          }
          const shot = await session.screenshot('courtauction', `${gu} ${screen.name} ${usage}`);
          for (const [docid, row] of found) {
            rows.set(docid, row);
            if (!seenOn.has(docid)) seenOn.set(docid, { url: screen.url, shot });
            idsOf[search.kind].add(docid);
          }
          await session.pause(PAGE_DELAY_MS);
        }
      }
      for (const lot of lotsOf([...rows.values()])) {
        const ids = lot.map((r) => String(r.docid));
        const inHome = ids.some((id) => idsOf.home.has(id));
        const inShop = ids.some((id) => idsOf.shop.has(id));
        // 토지 검색에는 집과 함께 파는 땅 목록도 나온다. 토지 검색에만 나온 물건은 목록이 모두 토지인 것(땅만 파는 것)만 남긴다.
        const landOnly = !inHome && !inShop && lot.every(isLand);
        if (!inHome && !inShop && !landOnly) continue;
        const at = seenOn.get(String(lot[0].docid));
        const listing = normalizeLot(lot);
        // 상업용 검색에만 나온 물건은 경매 탭 상가 칸에, 땅만 파는 물건은 토지 칸에 보이도록 용도 앞에 표시를 붙인다(주거용 검색에도 나오면 주거).
        if (landOnly) listing.buildingType = `${LAND_PREFIX}${listing.buildingType ?? '토지'}`;
        else if (inShop && !inHome) listing.buildingType = `${SHOP_PREFIX}${listing.buildingType ?? '상가'}`;
        // 고른 구의 아파트는 반경 밖이어도 저장한다(서울 아파트 탭). 근처가 아닌 고른 구에서는 아파트만 남긴다.
        const apt = inHome && aptGus.has(gu) && isApartmentType(listing.buildingType);
        if (onlyApt && !apt) continue;
        items.push({ listing, raw: lot.length === 1 ? lot[0] : lot, pageUrl: at?.url ?? FORM_URL, screenshot: at?.shot ?? null, aptGu: apt ? gu : undefined });
      }
    }
    return items;
  },
};
