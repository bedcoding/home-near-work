// 매물 유형은 서버 알림도 같이 쓰도록 shared/kinds.ts에 둔다.
import { kindOf as judgeKind, type Kind } from '../../shared/kinds';
import type { NormalizedListing } from '../../shared/types';

export { KINDS, KIND_LABEL, type Kind } from '../../shared/kinds';

/** 유형 글자(buildingType)마다 판정한 매물 유형. 화면은 매물 수만 건마다 부르는데 유형 글자는 몇십 가지뿐이다. */
const kinds = new Map<string, Kind>();

/** 매물 유형(shared/kinds.ts의 kindOf와 같은 결과). 같은 유형 글자는 한 번만 판정한다. */
export function kindOf(l: Pick<NormalizedListing, 'buildingType'>): Kind {
  const t = l.buildingType ?? '';
  let k = kinds.get(t);
  if (k === undefined) kinds.set(t, (k = judgeKind(l)));
  return k;
}
