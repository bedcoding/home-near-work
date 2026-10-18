import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 이 컴퓨터에만 두는 설정(config/local.json, 저장소에 넣지 않음). 없거나 못 읽으면 빈 설정.
 * defaultAreas: 처음 실행할 때 만드는 지역(역 이름, 반경 m, 켜기).
 * knownStations: 지역과 상관없이 늘 아는 역 이름(집토스 역 페이지, 법원경매 구, 근처 이름에 씀).
 * celibBranches: 모을 셀립 지점(이름, 지점 화면 주소의 slug, 입주 신청 화면 번호 p).
 * dataGoKrKey: 공공데이터포털 인증키.
 * vworldKey: 브이월드 오픈API 인증키(국가중점 API), vworldDomain: 그 키를 받을 때 적은 서비스 URL(없으면 http://localhost).
 */
export interface LocalConfig {
  defaultAreas?: { station: string; radiusM: number; enabled: boolean }[];
  knownStations?: string[];
  celibBranches?: { name: string; slug: string; p: number }[];
  dataGoKrKey?: string;
  vworldKey?: string;
  vworldDomain?: string;
}
export const LOCAL_CONFIG_PATH = path.join(ROOT, 'config', 'local.json');
export const LOCAL: LocalConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8')) as LocalConfig;
  } catch {
    return {};
  }
})();
/** 데이터 폴더. HNW_DATA_DIR로 바꿀 수 있다. */
export const DATA_DIR = process.env.HNW_DATA_DIR ? path.resolve(process.env.HNW_DATA_DIR) : path.join(ROOT, 'data');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const DB_PATH = path.join(DATA_DIR, 'app.db');
/** 조회용 브라우저 프로필. 평소 쓰는 크롬 프로필과 분리한다. */
export const BROWSER_PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
export const WEB_DIST = path.join(ROOT, 'web', 'dist');

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 8787);
export const DASHBOARD_URL = `http://localhost:${PORT}`;

/** 설정한 반경 밖이라도 이만큼은 넉넉하게 저장해 둔다(화면도 같은 값으로 서울 아파트 탭에만 보일 매물을 가른다). */
export { COLLECT_MARGIN_M } from '../shared/types.js';
/** 페이지 사이 대기 시간(ms). */
export const PAGE_DELAY_MS = 2000;
