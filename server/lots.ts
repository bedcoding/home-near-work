import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 경매·공매 주소의 지번 키('lot:강남구 대치동 316')와 서울 법정동 코드. 건축물대장(세대수)과 토지이용계획(재개발 구역)이 같이 쓰고, 시세 통계가 구 코드를 쓴다.
// 법정동 코드는 seoul-bjdong.json: 행정안전부 법정동코드 전체자료 중 서울의 '존재' 행(구 25곳, 법정동 467곳)을
// building-register-mcp 저장소(Apache-2.0)의 사본에서 뽑았다(2026-10-18).

const BJDONG = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'seoul-bjdong.json'), 'utf8')) as Record<
  string,
  { code: string; dongs: Record<string, string> }
>;

export type Lot = { gu: string; dong: string; san: boolean; bun: string; ji: string };

/** 'lot:강남구 대치동 316', 'lot:송파구 가락동 산12-3' → 구, 법정동, 산 여부, 본번, 부번(없으면 '0'). 모양이 다르면 null. */
export function parseLot(key: string): Lot | null {
  const m = /^lot:(\S+) (\S+) (산)?(\d+)(?:-(\d+))?$/.exec(key);
  return m ? { gu: m[1], dong: m[2], san: !!m[3], bun: m[4], ji: m[5] ?? '0' } : null;
}

/** 서울 구의 시군구 코드 5자리('강동구' → '11740'). 모르면 null. */
export const guCode = (gu: string): string | null => BJDONG[gu]?.code ?? null;

/** 구와 법정동의 코드(시군구 5자리, 법정동 5자리). 모르면 null. */
export function legalDongCode(gu: string, dong: string): { sigungu: string; bjdong: string } | null {
  const g = BJDONG[gu];
  const d = g?.dongs[dong];
  return g && d ? { sigungu: g.code, bjdong: d } : null;
}

/** 필지 번호(PNU 19자리): 시군구 5 + 법정동 5 + 필지 구분 1(일반 1, 산 2) + 본번 4 + 부번 4. 법정동 코드를 모르면 null. */
export function pnuOf(lot: Lot): string | null {
  const code = legalDongCode(lot.gu, lot.dong);
  return code ? `${code.sigungu}${code.bjdong}${lot.san ? '2' : '1'}${lot.bun.padStart(4, '0')}${lot.ji.padStart(4, '0')}` : null;
}
