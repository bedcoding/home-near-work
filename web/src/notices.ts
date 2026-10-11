import { NOTICE_SHORT, type NoticeSourceId, type NoticeSourceStatus, type NoticeView } from '../../shared/types';
import { ago } from './format';

export { NOTICE_SHORT };

/** 공고 목록 화면(원문 주소가 없는 공고와 사이트 탭 '열기'가 연다) */
export const NOTICE_HOME: Record<NoticeSourceId, string> = {
  sh: 'https://housing.seoul.go.kr/site/main/sh/publicLease/list',
  lh: 'https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do?mi=1026',
  gobang: 'https://gobang.kr/youth/notices',
  myhome: 'https://www.myhome.go.kr/hws/portal/sch/selectRsdtRcritNtcView.do',
  hugjeonse: 'https://www.khug.or.kr/jeonse/web/s07/s070102.jsp',
  hugtrust: 'https://www.khug.or.kr/jeonse/web/s07/s070406.jsp',
  kbtrust: 'https://kbret.co.kr/auction',
  koreit: 'https://www.koreit.co.kr/land-trust/sale/short-notice',
  reitpia: 'https://www.reitpia.com/info/02.php',
  ktrust: 'https://www.ktrust.co.kr/?pages=thing&subs=thing02',
  hanatrust: 'https://www.hanatrust.com/ko/publicSale/goodsForPublicSale',
  shinhantrust: 'https://www.shinhantrust.kr/biz-information/auction-properties',
  mghat: 'http://www.mghat.com/auction/disposal/list.do',
  shinyoung: 'http://www.shinyoungret.com/index.asp?pages=public&subs=sub01',
  wooriat: 'https://www.wooriat.com/item/vendue/list',
  daishin: 'https://trust.daishin.com/thing_1',
  kyobotrust: 'https://www.kyobotrust.co.kr/front/bbsList.do?bbsId=BBS_0005',
  koramco: 'https://www.koramco.com/ko/pubsaleList',
  applyhome: 'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancListView.do',
  shsale: 'https://housing.seoul.go.kr/site/main/sh/publicSale/01/list',
  lhsale: 'https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do?mi=1027',
  lhshop: 'https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do?mi=1069',
  lhland: 'https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do?mi=1062',
  lhfirst: 'https://apply.lh.or.kr/lhapply/apply/bor_ctrt_psb_dst/1/lfn_getTabChange.do?mi=201526',
};

/** 마지막 수집이 실패한 곳: text '고방 실패, 어제', title 오류 문구 */
export function failedNoticeSources(sources: NoticeSourceId[], status: Partial<Record<NoticeSourceId, NoticeSourceStatus>>) {
  return sources.flatMap((s) => {
    const st = status[s];
    return st && !st.ok ? [{ id: s, text: `${NOTICE_SHORT[s]} 실패, ${ago(st.at)}`, title: st.error ?? undefined }] : [];
  });
}

/** 오늘(이 컴퓨터 시각) YYYY-MM-DD */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 두 날짜(YYYY-MM-DD) 사이 날 수(b - a) */
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86400000);
}

/** '2026-10-06' → '10.06' */
export const monthDay = (iso: string) => `${iso.slice(5, 7)}.${iso.slice(8, 10)}`;

/** 접수 기간 글자: '10.06~10.08', 하루면 '10.06' */
export const periodText = (p: { start: string; end: string }) => (p.start === p.end ? monthDay(p.start) : `${monthDay(p.start)}~${monthDay(p.end)}`);

/**
 * 접수 기간으로 본 오늘 상태. 접수 예정이면 when은 시작까지 남은 날('3일 뒤'), 접수중이면 마감까지('오늘 마감').
 * 기간을 모르면 null.
 */
export function periodState(p: { start: string; end: string } | null, today = todayIso()) {
  if (!p) return null;
  if (today < p.start) {
    const d = daysBetween(today, p.start);
    return { word: '접수 예정', tone: 'soon' as const, when: d === 1 ? '내일 시작' : `${d}일 뒤` };
  }
  if (today <= p.end) {
    const d = daysBetween(today, p.end);
    return { word: '접수중', tone: 'open' as const, when: d === 0 ? '오늘 마감' : d === 1 ? '내일 마감' : `${d}일 남음` };
  }
  return { word: '마감', tone: 'closed' as const, when: '' };
}

/** 이미 끝난 공고: 접수 기간이 지났거나, 기간을 모르면 당첨 발표일이 지났거나 상태가 마감. */
export function isPastNotice(n: NoticeView, today = todayIso()): boolean {
  if (n.period) return n.period.end < today;
  if (n.detail?.winnersAt) return n.detail.winnersAt < today;
  return /마감|종료|완료/.test(n.status ?? '') || !n.current;
}
