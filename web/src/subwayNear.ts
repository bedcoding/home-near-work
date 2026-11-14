import { distanceM } from '../../shared/geo';

// 지하철 노선 중 거리 핀 가까이에 역이 있는 노선 고르기(subwayLines.ts가 그 노선을 굵게 그린다). 지도 없이 시험하려고 따로 둔다.

/** 거리 핀에서 이만큼(m, 곧은 거리) 안에 역이 있는 노선을 강조한다. 걸어서 15분쯤이다. */
export const NEAR_M = 1000;

/** 노선을 강조한 까닭: 가장 가까운 거리 핀과 그 핀에서 NEAR_M 안의 역 */
export interface NearInfo {
  pin: string;
  station: string;
  m: number;
}

/** 거리 핀마다 NEAR_M 안의 역을 보고, 역 목록의 노선 이름 → 가장 가까운 핀과 역. */
export function nearLines(
  pins: readonly { name: string; lat: number; lng: number }[],
  stations: readonly { name: string; lines: string[]; lat: number; lng: number }[],
): Map<string, NearInfo> {
  const out = new Map<string, NearInfo>();
  for (const p of pins) {
    for (const s of stations) {
      const m = distanceM(p.lat, p.lng, s.lat, s.lng);
      if (m > NEAR_M) continue;
      for (const l of s.lines) {
        const old = out.get(l);
        if (!old || m < old.m) out.set(l, { pin: p.name, station: s.name, m });
      }
    }
  }
  return out;
}
