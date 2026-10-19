import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL } from './config.js';
import type { Station } from '../shared/types.js';

export interface StationInfo extends Station {
  /** 역이 있는 자치구(서울 밖은 시, 군). 법원경매 소재지 검색에 쓴다. */
  gu: string;
}

// stations-kric.json: 수도권 전철역 목록(이름, 노선, 좌표, 시도, 구).

export interface CatalogStation {
  name: string;
  label: string;
  lines: string[];
  lat: number;
  lng: number;
  /** 서울과 경기, 인천, 충남, 강원 */
  sido: string;
  /** 서울은 구, 그 밖은 시, 군 */
  gu: string | null;
}

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stations-kric.json');
const catalog = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { source: string; baseDate: string; stations: CatalogStation[] };

export function stationCatalog() {
  return catalog;
}

/** 역 목록에서 이름이 같은 역('서울역'). 없으면 null. */
export function findStation(name: string): CatalogStation | null {
  return catalog.stations.find((s) => s.name === name) ?? null;
}

/** 처음 실행할 때 만드는 기본 지역(config/local.json의 defaultAreas). 없으면 만들지 않는다(지역 탭에서 고름). */
export const DEFAULT_AREAS = LOCAL.defaultAreas ?? [];
