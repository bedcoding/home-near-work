import type { LedgerHit, ListingView } from '../../shared/types';

// 건축물대장 이름표(ListingCard, 지도 정보 창): 근린생활시설 용도와 위반건축물.
// 설명은 체크리스트 탭 건축물대장 항목, 위반건축물 흔적 칸과 지원 제도 탭 보증보험 칸에 근거와 함께 적힌 내용을 줄인 것이다.

export interface LedgerChip {
  /** danger 건축물대장 용도나 법원 비고로 확인, warn 섞인 건물이나 글 언급 */
  tone: 'danger' | 'warn';
  label: string;
  tip: string;
}

type Deals = Pick<ListingView, 'ledger' | 'prices' | 'source'>;

const NEIGH_LABEL: Record<LedgerHit['level'], string> = { sure: '근생', mixed: '근생 섞인 건물', said: '근생 언급' };
const NEIGH_HEAD: Record<LedgerHit['level'], string> = {
  sure: '건축물대장 용도가 근린생활시설(가게, 사무소 같은 용도)이고 주택 용도가 없는 건물입니다.',
  mixed: '건물 용도에 근린생활시설과 주택이 함께 있습니다. 이 집이 어느 쪽인지는 모릅니다.',
  said: '글에 근린생활시설(근생)이라고 적혀 있습니다.',
};
const VIOLATION_HEAD: Record<LedgerHit['level'], string> = {
  sure: '건축물대장에 위반건축물로 올라 있습니다.',
  mixed: '건축물대장에 위반건축물로 올라 있습니다.',
  said: '글에 위반건축물이나 불법 건축 이야기가 있습니다(무슨 뜻인지는 원문으로 확인).',
};

/** 사는 매물(매매, 경매, 공매)인지와 빌리는 매물(월세, 전세)인지 */
function dealsOf(l: Deals) {
  return {
    buy: l.source === 'courtauction' || l.source === 'onbid' || l.prices.some((p) => p.deal === 'sale' || p.deal === 'auction'),
    rent: l.prices.some((p) => p.deal === 'monthly' || p.deal === 'jeonse'),
  };
}

function neighTip(hit: LedgerHit, deals: { buy: boolean; rent: boolean }): string {
  const lines = [NEIGH_HEAD[hit.level], `${hit.from}: ${hit.text}`, ''];
  if (deals.rent) {
    lines.push(
      '근린생활시설은 HUG 전세보증금반환보증 대상 주택이 아니고, HF 전세자금보증은 등기상 주택이나 오피스텔이어야 해서 은행 전세대출이 막힙니다.',
      '전입신고는 받아 주고(건물 용도는 거부할 까닭이 아님), 주택임대차보호법도 서류가 아니라 실제로 주거로 쓰는지로 보지만, 실제 주거용인지 다툼이 생길 수 있습니다.',
    );
  }
  if (deals.buy) lines.push('디딤돌과 보금자리론은 공부상 주택이어야 하고, 주택과 다른 용도가 섞인 건물은 주택 면적이 절반 이상이어야 합니다(보금자리론 기준).');
  if (hit.level === 'mixed') lines.push('다세대와 오피스텔은 그 호의 전유부, 다가구와 단독은 층별 용도에서 이 집이 주택인지 봅니다.');
  if (hit.level !== 'said') lines.push('근생 층을 허가 없이 집으로 꾸몄으면 위반건축물이기도 합니다.');
  const basis = [
    ...(deals.rent ? ['HUG 전세보증금반환보증 상품 안내', 'HF 일반전세자금보증', '대법원 2008두10997, 94다52522'] : []),
    ...(deals.buy ? ['디딤돌과 보금자리론 상품 안내'] : []),
    ...(hit.level !== 'said' ? ['생활법령 흔한 위반건축물'] : []),
  ];
  lines.push('', '확인: 정부24나 세움터에서 건축물대장을 떼서 용도를 봅니다(집합건물은 표제부와 그 호의 전유부).');
  if (basis.length) lines.push(`근거: ${basis.join(', ')}(체크리스트 탭 건축물대장 항목).`);
  return lines.join('\n');
}

function violationTip(hit: LedgerHit, deals: { buy: boolean; rent: boolean }): string {
  const lines = [VIOLATION_HEAD[hit.level], `${hit.from}: ${hit.text}`];
  if (/표제부|전유부/.test(hit.text)) lines.push('표제부는 건물 전체, 전유부는 그 호의 대장입니다.');
  lines.push('');
  if (deals.rent) {
    lines.push(
      '대장에 위반건축물로 오른 집은 HUG 전세보증금반환보증(아파트는 예외), HUG 전세금안심대출보증, HF 전세지킴보증에 못 들어 반환보증과 전세대출이 막힙니다.',
      '세입자도 점유자로 시정명령 대상에 듭니다(건축법 제79조).',
    );
  }
  if (deals.buy || !deals.rent) {
    lines.push(
      '산 사람도 소유자로 시정명령을 받고, 고치지 않으면 이행강제금이 1년에 2번까지 되풀이해 나옵니다. 위반을 만들지 않았어도 소유자면 대상입니다(건축법 제79조, 제80조, 대법원 2012두20137). 전 주인에게 나온 이행강제금 자체는 넘어오지 않습니다(대법원 2006마470).',
    );
  }
  lines.push(
    '',
    '확인: 정부24나 세움터에서 건축물대장을 떼서 첫 장 위쪽의 위반건축물 표시와 변동사항을 봅니다(집합건물은 표제부와 그 호의 전유부). 단속된 적 없는 불법 증축은 대장에 없어 현장을 봐야 합니다.',
    `근거: ${deals.rent ? 'HUG 전세보증금반환보증 자주하는 질문, HUG 전세금안심대출보증, HF 전세지킴보증, ' : ''}건축법 제79조와 제80조, 건축물대장 규칙 제8조(체크리스트 탭 건축물대장 항목).`,
  );
  return lines.join('\n');
}

/** 근생과 위반건축물 이름표(있는 것만, 근생 먼저). 서버가 ledger를 아직 안 보내면 빈 배열. */
export function ledgerChips(l: Deals): LedgerChip[] {
  const out: LedgerChip[] = [];
  const deals = dealsOf(l);
  const n = l.ledger?.neigh;
  const v = l.ledger?.violation;
  if (n) out.push({ tone: n.level === 'sure' ? 'danger' : 'warn', label: NEIGH_LABEL[n.level], tip: neighTip(n, deals) });
  if (v) out.push({ tone: v.level === 'said' ? 'warn' : 'danger', label: v.level === 'said' ? '위반건축물 언급' : '위반건축물', tip: violationTip(v, deals) });
  return out;
}

/** '대출 시 월' 설명 맨 위에 붙일 한 줄(근생이나 위반건축물 표시가 있으면). 없으면 null. */
export function ledgerLoanWarning(l: Pick<ListingView, 'ledger'>): string | null {
  const n = l.ledger?.neigh;
  const v = l.ledger?.violation;
  if (!n && !v) return null;
  const what = [n ? '근린생활시설' : '', v ? '위반건축물' : ''].filter(Boolean).join('이나 ');
  const sure = n?.level === 'sure' || (!!v && v.level !== 'said');
  const lead = sure ? `건축물대장에서 ${what}로 확인된 집이라` : `${what} 표시가 있어, 건축물대장에서 그렇게 확인되면`;
  return `${lead} 전세대출 보증이 안 돼 대출이 막힙니다. 아래는 대출이 된다고 친 값입니다.`;
}

/**
 * 대출 신호등(loans.ts)에 쓸 근생 판단: 확인된 근생이면 공부상 주택이 아니라 안 됨, 섞인 건물이나 글 언급이면 확인 필요. 근생 표시가 없으면 null.
 */
export function ledgerHouseCheck(l: Pick<ListingView, 'ledger'>): { state: 'no' | 'maybe'; why: string } | null {
  const n = l.ledger?.neigh;
  if (!n) return null;
  if (n.level === 'sure') return { state: 'no', why: '건축물대장 용도가 근린생활시설이라 공부상 주택이 아님' };
  if (n.level === 'mixed') return { state: 'maybe', why: '건물에 근린생활시설이 섞여 있음(이 집이 주택 부분인지, 섞인 건물은 주택 면적이 절반 이상인지 확인)' };
  return { state: 'maybe', why: '글에 근린생활시설이라고 적혀 있음(공부상 주택이 아니면 안 됨)' };
}
