import { Worker } from 'node:worker_threads';
import { joinListings, type ListingsJson } from './listings-cache.js';

/**
 * 매물 목록 응답(GET /api/listings의 JSON)을 만들어 두고 내준다.
 * 목록은 수만 건(수십 MB)이라 한 번에 만들면 2~3초 걸리고, 본 스레드에서 만들면 그동안 서버 전체(상태 폴링, 크롬 확장 자료 저장, 버림 저장)가 기다린다.
 * 그래서 워커(listings-worker.ts)에서 만들고, 워커를 못 띄우거나 워커가 죽으면 그때만 예전처럼 본 스레드에서 만든다.
 * 워커를 여럿 쓰게 하면(workers) 매물 행 번호 구간을 나눠 동시에 만들고 이어 붙인다. 대시보드를 처음 열 때 기다리는 시간이 그만큼 준다.
 * 만든 목록은 매물 id 순서와 매물마다 경계를 같이 둔다(encodeListings). 변화분 응답(listings-cache.ts)이 바뀐 매물만 잘라 보낸다.
 */

/** 워커에 보내는 부탁: 행 번호 구간 [from, to)의 매물 목록을 만든다(null이면 그쪽 끝이 없다). */
export interface ListingsWorkerRequest {
  type: 'build';
  from: number | null;
  to: number | null;
}

/**
 * 워커가 돌려주는 것: 읽기 시점을 정했다는 알림(started), 목록 JSON의 UTF-8 바이트와 매물 id 순서와 매물마다 경계
 * (바이트와 경계는 복사 없이 넘어온다), 또는 만들지 못한 까닭.
 */
export type ListingsWorkerReply =
  | { started: true }
  | { ok: true; body: Uint8Array; ids: string[]; offsets: Uint32Array }
  | { ok: false; error: string };

export interface ListingsBodyOptions {
  /** 자료 버전(DB에 무엇이든 쓰면 바뀐다). 같은 버전이면 만들어 둔 것을 다시 쓴다. */
  revision: () => string;
  /** 본 스레드에서 목록 JSON을 만든다(encodeListings). 워커를 쓰지 못할 때만 부른다. */
  buildHere: () => ListingsJson;
  /** 워커를 띄운다(시험에서 바꿔 끼운다). */
  startWorker?: () => Worker;
  /** 목록을 나눠 만들 워커 수(기본 1). 둘 이상이면 split이 준 행 번호 경계로 구간을 나눠 구간마다 워커 하나가 만든다. */
  workers?: number;
  /** 워커 parts개가 나눠 만들 행 번호 경계(오름차순, parts - 1개까지). 빈 배열이면 워커 하나가 다 만든다. */
  split?: (parts: number) => number[];
  /** 만들어 둔 것을 쓰는 시간. 날짜에 따라 달라지는 표시가 오래 묵지 않게 둔다. */
  cacheMs?: number;
  /** 워커가 이 시간 안에 못 만들면 끄고 본 스레드에서 만든다. */
  timeoutMs?: number;
  /**
   * 워커가 이만큼 일이 없으면 끈다. 살아 있는 워커는 만들고 난 메모리(실제 자료에서 수백 MB)를 쥐고 있다.
   * 크롬 확장이 순회하며 몇 초마다 자료를 바꿀 때는 그대로 다시 쓰고, 조용해지면 끈 뒤 다음 만들기에서 다시 띄운다(0.3초쯤 더 든다).
   */
  idleMs?: number;
  log?: (message: string) => void;
}

/** 워커가 이만큼 연달아 실패하면 서버를 다시 켤 때까지 본 스레드에서만 만든다. */
const MAX_WORKER_FAILURES = 3;

const WORKER_FILE = new URL('./listings-worker.ts', import.meta.url);

/**
 * 목록 워커를 띄운다. 서버는 tsx로 켜서 .ts를 그대로 읽지만, tsx(4.23)는 노드 22.17에서 본 스레드에만 걸려 워커는 .ts를 못 읽는다.
 * 그래서 워커 안에서 tsx의 tsImport로 워커 파일을 불러온다. execArgv를 비워 노드 버전에 따라 tsx가 두 번 걸리는 일이 없게 한다.
 */
export function startListingsWorker(file: URL = WORKER_FILE): Worker {
  const tsx = import.meta.resolve('tsx/esm/api');
  const code = `import(${JSON.stringify(tsx)}).then((tsx) => tsx.tsImport(${JSON.stringify(file.href)}, ${JSON.stringify(file.href)}));`;
  return new Worker(code, { eval: true, execArgv: [] });
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

type RowRange = { from: number | null; to: number | null };
const ALL: RowRange = { from: null, to: null };

/** 경계로 나눈 구간들(앞 구간의 끝이 다음 구간의 시작). 경계가 오름차순이 아니면 나누지 않는다. */
function rangesOf(cuts: number[]): RowRange[] {
  if (!cuts.length || cuts.some((c, i) => !Number.isFinite(c) || (i > 0 && c <= cuts[i - 1]))) return [ALL];
  return [...cuts, null].map((to, i) => ({ from: i ? cuts[i - 1] : null, to }));
}

export function createListingsBody(options: ListingsBodyOptions) {
  const {
    revision, buildHere, startWorker = startListingsWorker, workers: size = 1, split = () => [],
    cacheMs = 10 * 60_000, timeoutMs = 60_000, idleMs = 60_000, log = console.error,
  } = options;
  type Built = { revision: string; at: number; json: ListingsJson };
  let cache: Built | null = null;
  /** 지금 만드는 것과 만들기 전에 기억한 자료 버전 */
  let running: { revision: string; done: Promise<Built> } | null = null;
  /** 앞선 버전을 만드는 중에 들어온 요청이 같이 기다리는, 그다음 만들기 */
  let next: Promise<Built> | null = null;
  /** 띄워 둔 워커(구간 자리마다 하나, 없으면 null) */
  const pool: (Worker | null)[] = [];
  let idleTimer: NodeJS.Timeout | null = null;
  let failures = 0;

  function spawn(slot: number): Worker {
    const w = startWorker();
    // 'error'를 듣는 곳이 없으면 본 스레드까지 죽는다. 만드는 중이 아닐 때 난 오류는 다음 만들기에서 새 워커로 다시 한다.
    w.on('error', () => {});
    w.on('exit', () => { if (pool[slot] === w) pool[slot] = null; });
    return w;
  }

  function retireAll() {
    for (let i = 0; i < pool.length; i++) {
      const w = pool[i];
      pool[i] = null;
      if (w) void w.terminate();
    }
  }

  /**
   * 구간마다 워커 하나에 맡겨 만든다. 구간이 여럿이면 워커마다 따로 DB를 읽으므로, 부탁하기 직전과 모든 워커가 읽기 시점을 정한 뒤의
   * 자료 버전이 같아야(그 사이에 아무도 쓰지 않아야) 모두 같은 시점을 읽은 것이다. 다르면 null(나눠 만든 것을 쓰지 않는다).
   */
  function buildInWorkers(ranges: RowRange[]): Promise<ListingsJson[] | null> {
    return new Promise<ListingsJson[] | null>((resolve, reject) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      const parts: ListingsJson[] = [];
      const started = ranges.map(() => false);
      const cleanups: (() => void)[] = [];
      let left = ranges.length;
      let settled = false;
      let torn = false;
      const before = ranges.length > 1 ? revision() : '';
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const off of cleanups) off();
        if (error) {
          retireAll();
          reject(error);
          return;
        }
        // 만드는 중에만 워커가 서버 프로세스를 붙잡는다.
        for (const w of pool) w?.unref();
        idleTimer = setTimeout(retireAll, idleMs);
        idleTimer.unref();
        resolve(torn ? null : parts);
      };
      const markStarted = (i: number) => {
        if (started[i]) return;
        started[i] = true;
        if (ranges.length > 1 && started.every(Boolean)) torn = revision() !== before;
      };
      const timer = setTimeout(() => finish(new Error(`${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`)), timeoutMs);
      ranges.forEach((range, i) => {
        if (settled) return;
        let w: Worker;
        try {
          w = pool[i] ??= spawn(i);
        } catch (e) {
          finish(e instanceof Error ? e : new Error(messageOf(e)));
          return;
        }
        const onMessage = (reply: ListingsWorkerReply) => {
          // 시점 알림 없이 결과가 오면 결과를 받은 때를 시점으로 본다(실제보다 늦게 보므로 같은 시점이 아닌 것을 놓치지 않는다).
          markStarted(i);
          if ('started' in reply) return;
          if (!reply.ok) {
            finish(new Error(reply.error));
            return;
          }
          parts[i] = { body: Buffer.from(reply.body.buffer, reply.body.byteOffset, reply.body.byteLength), ids: reply.ids, offsets: reply.offsets };
          if (--left === 0) finish(null);
        };
        const onError = (e: Error) => finish(e);
        const onExit = (code: number) => finish(new Error(`워커가 끝났습니다(종료 코드 ${code}).`));
        w.on('message', onMessage).on('error', onError).on('exit', onExit);
        cleanups.push(() => w.off('message', onMessage).off('error', onError).off('exit', onExit));
        w.ref();
        w.postMessage({ type: 'build', from: range.from, to: range.to } satisfies ListingsWorkerRequest);
      });
    });
  }

  async function buildByWorkers(): Promise<ListingsJson> {
    let cuts: number[] = [];
    if (size > 1) {
      try {
        cuts = split(size);
      } catch (e) {
        log(`매물 목록을 나눌 경계를 읽지 못해 워커 하나로 만듭니다: ${messageOf(e)}`);
      }
    }
    const ranges = rangesOf(cuts);
    if (ranges.length > 1) {
      const parts = await buildInWorkers(ranges);
      if (parts) return joinListings(parts);
      // 나눠 읽는 사이에 자료가 바뀌어 워커마다 본 시점이 다를 수 있다. 워커 하나가 한 시점에서 다시 만든다.
    }
    return (await buildInWorkers([ALL]))![0];
  }

  async function build(): Promise<ListingsJson> {
    if (failures < MAX_WORKER_FAILURES) {
      try {
        const json = await buildByWorkers();
        failures = 0;
        return json;
      } catch (e) {
        failures++;
        log(`매물 목록을 워커에서 만들지 못해 본 스레드에서 만듭니다: ${messageOf(e)}`);
        if (failures === MAX_WORKER_FAILURES) log(`워커가 ${MAX_WORKER_FAILURES}번 연달아 실패해 서버를 다시 켤 때까지 매물 목록은 본 스레드에서 만듭니다.`);
      }
    }
    return buildHere();
  }

  function start(): Promise<Built> {
    // 자료 버전은 만들기 전에 기억한다. 만드는 중에 쓴 것은 버전이 달라져 다음 요청에서 다시 만든다.
    const at = revision();
    const done = build().then((json) => (cache = { revision: at, at: Date.now(), json }));
    const current = { revision: at, done };
    running = current;
    done.then(() => {}, () => {}).then(() => { if (running === current) running = null; });
    return done;
  }

  /**
   * 지금 자료 버전의 목록 JSON(본문, 매물 id 순서, 매물마다 경계). 버전이 같고 cacheMs가 안 지났으면 만들어 둔 것을 그대로 준다.
   * 같은 것을 다시 줄 때는 같은 객체다.
   */
  async function json(): Promise<ListingsJson> {
    const now = revision();
    if (cache?.revision === now && Date.now() - cache.at < cacheMs) return cache.json;
    if (running?.revision === now) return (await running.done).json;
    if (!running) return (await start()).json;
    // 앞선 버전을 만드는 중이면 끝난 뒤 한 번 더 만든다. 그사이 들어온 요청은 버전이 달라도 그것을 같이 기다린다(그 만들기가 더 나중에 읽으므로 모두 담긴다).
    next ??= running.done.then(() => {}, () => {}).then(() => {
      next = null;
      return start();
    });
    return (await next).json;
  }

  /** 지금 자료 버전의 목록 JSON(UTF-8) */
  const body = async (): Promise<Buffer> => (await json()).body;

  /**
   * 워커를 미리 띄워 둔다(서버를 켤 때). 워커가 모듈을 불러오고 DB를 여는 0.3초쯤을 서버가 켜지는 동안의 다른 일과 겹치게 한다.
   * 만들기는 json()이 부탁할 때 시작하고, 아무도 부탁하지 않으면 idleMs 뒤 끈다.
   */
  function warm() {
    if (failures >= MAX_WORKER_FAILURES) return;
    try {
      for (let i = 0; i < Math.max(1, size); i++) pool[i] ??= spawn(i);
    } catch (e) {
      // 못 띄우면 만들 때 다시 띄워 보고, 그래도 안 되면 본 스레드에서 만든다.
      log(`매물 목록 워커를 미리 띄우지 못했습니다: ${messageOf(e)}`);
    }
    // 만드는 중이면 그 만들기가 끝날 때 끄는 시각을 정한다.
    if (running) return;
    for (const w of pool) w?.unref();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(retireAll, idleMs);
    idleTimer.unref();
  }

  /** 워커를 끈다(시험이 끝날 때). */
  async function close() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const all = pool.splice(0).filter((w): w is Worker => !!w);
    await Promise.all(all.map((w) => w.terminate()));
  }

  return { body, json, warm, close };
}
