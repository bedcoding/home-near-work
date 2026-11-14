import { DEAL_LABEL, type DealType, type ListingView, type PriceOption } from '../../shared/types';
import { manwon, priceAmount } from './format';

const fieldsByDeal: Record<DealType, Array<[key: 'deposit' | 'monthly' | 'price', label: string]>> = {
  monthly: [['deposit', '보증금'], ['monthly', '월세']],
  short: [['deposit', '단기 보증금'], ['monthly', '단기 월세']],
  jeonse: [['deposit', '전세금']],
  sale: [['price', '매매가']],
  auction: [['price', '최저가']],
};

const amount = (value: number | null) => value === null ? '금액 모름' : value === 0 ? '0원' : `${manwon(value)}원`;

export function mapPriceChangeLines(change: ListingView['priceChange']): string[] {
  if (!change) return [];
  const lines: string[] = [];
  const deals = new Set([...change.before, ...change.after].map(option => option.deal));
  for (const deal of deals) {
    const before = change.before.filter(option => option.deal === deal);
    const after = change.after.filter(option => option.deal === deal);
    if (before.length === 1 && after.length === 1) {
      for (const [field, label] of fieldsByDeal[deal]) {
        const oldValue = before[0][field] ?? null;
        const newValue = after[0][field] ?? null;
        if (oldValue !== newValue) lines.push(`${label} ${amount(oldValue)} → ${amount(newValue)}`);
      }
    } else {
      const optionAmounts = (options: PriceOption[]) => options.map(priceAmount).sort().join(' 또는 ') || '없음';
      const beforeText = optionAmounts(before);
      const afterText = optionAmounts(after);
      if (beforeText !== afterText) lines.push(`${DEAL_LABEL[deal]} 조건 ${beforeText} → ${afterText}`);
    }
  }
  return lines.length ? lines : ['가격 정보가 바뀌었습니다.'];
}
