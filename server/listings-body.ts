import { Worker } from 'node:worker_threads';

/**
 * 매물 목록 응답(GET /api/listings의 JSON)을 만들어 두고 내준다.
 * 목록은 수만 건(수십 MB)이라 만드는 데 2초쯤 걸리고, 본 스레드에서 만들면 그동안 서버 전체(상태 폴링, 크롬 확장 자료 저장, 버림 저장)가 기다린다.
 * 그래서 워커(listings-worker.ts)에서 만들고, 워커를 못 띄우거나 워커가 죽으면 그때만 예전처럼 본 스레드에서 만든다.
 */

/** 워커가 돌려주는 것: 목록 JSON의 UTF-8 바이트(복사 없이 넘어온다), 또는 만들지 못한 까닭. */
export type ListingsWorkerReply = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

export interface ListingsBodyOptions {
  /** 자료 버전(DB에 무엇이든 쓰면 바뀐다). 같은 버전이면 만들어 둔 것을 다시 쓴다. */
  revision: () => string;
  /** 본 스레드에서 목록 JSON을 만든다. 워커를 쓰지 못할 때만 부른다. */
  buildHere: () => string;
  /** 워커를 띄운다(시험에서 바꿔 끼운다). */
  startWorker?: () => Worker;
  /** 만들어 둔 것을 쓰는 시간. 날짜에 따라 달라지는 표시가 오래 묵지 않게 둔다. */
  cacheMs?: number;
  /** 워커가 이 시간 안에 못 만들면 끄고 본 스레드에서 만든다. */
  timeoutMs?: number;
  /**
   * 워커가 이만큼 일이 없으면 끈다. 살아 있는 워커는 만들고 난 메모리(실제 자료에서 수백 MB)를 쥐고 있다.
   * 크롬 확장이 순회하며 몇 초마다 자료를 바꿀 때는 그대로 다시 쓰고, 조용해지면 끈 뒤 다음 만들기에서 다시 띄운다(0.5초쯤 더 든다).
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

export function createListingsBody(options: ListingsBodyOptions) {
  const {
    revision, buildHere, startWorker = startListingsWorker, cacheMs = 10 * 60_000, timeoutMs = 60_000, idleMs = 60_000, log = console.error,
  } = options;
  type Built = { revision: string; at: number; body: Buffer };
  let cache: Built | null = null;
  /** 지금 만드는 것과 만들기 전에 기억한 자료 버전 */
  let running: { revision: string; done: Promise<Built> } | null = null;
  /** 앞선 버전을 만드는 중에 들어온 요청이 같이 기다리는, 그다음 만들기 */
  let next: Promise<Built> | null = null;
  let worker: Worker | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let failures = 0;

  function spawn(): Worker {
    const w = startWorker();
    // 'error'를 듣는 곳이 없으면 본 스레드까지 죽는다. 만드는 중이 아닐 때 난 오류는 다음 만들기에서 새 워커로 다시 한다.
    w.on('error', () => {});
    w.on('exit', () => { if (worker === w) worker = null; });
    return w;
  }

  function retire(w: Worker) {
    if (worker === w) worker = null;
    void w.terminate();
  }

  function buildInWorker(): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      const w = (worker ??= spawn());
      const finish = (error: Error | null, body?: Buffer) => {
        clearTimeout(timer);
        w.off('message', onMessage).off('error', onError).off('exit', onExit);
        if (error) {
          retire(w);
          reject(error);
          return;
        }
        // 만드는 중에만 워커가 서버 프로세스를 붙잡는다.
        w.unref();
        idleTimer = setTimeout(() => retire(w), idleMs);
        idleTimer.unref();
        resolve(body!);
      };
      const onMessage = (reply: ListingsWorkerReply) =>
        reply.ok ? finish(null, Buffer.from(reply.bytes.buffer, reply.bytes.byteOffset, reply.bytes.byteLength)) : finish(new Error(reply.error));
      const onError = (e: Error) => finish(e);
      const onExit = (code: number) => finish(new Error(`워커가 끝났습니다(종료 코드 ${code}).`));
      const timer = setTimeout(() => finish(new Error(`${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`)), timeoutMs);
      w.on('message', onMessage).on('error', onError).on('exit', onExit);
      w.ref();
      w.postMessage('build');
    });
  }

  async function build(): Promise<Buffer> {
    if (failures < MAX_WORKER_FAILURES) {
      try {
        const body = await buildInWorker();
        failures = 0;
        return body;
      } catch (e) {
        failures++;
        log(`매물 목록을 워커에서 만들지 못해 본 스레드에서 만듭니다: ${messageOf(e)}`);
        if (failures === MAX_WORKER_FAILURES) log(`워커가 ${MAX_WORKER_FAILURES}번 연달아 실패해 서버를 다시 켤 때까지 매물 목록은 본 스레드에서 만듭니다.`);
      }
    }
    return Buffer.from(buildHere());
  }

  function start(): Promise<Built> {
    // 자료 버전은 만들기 전에 기억한다. 만드는 중에 쓴 것은 버전이 달라져 다음 요청에서 다시 만든다.
    const at = revision();
    const done = build().then((body) => (cache = { revision: at, at: Date.now(), body }));
    const current = { revision: at, done };
    running = current;
    done.then(() => {}, () => {}).then(() => { if (running === current) running = null; });
    return done;
  }

  /** 지금 자료 버전의 목록 JSON(UTF-8). 버전이 같고 cacheMs가 안 지났으면 만들어 둔 것을 그대로 준다. */
  async function body(): Promise<Buffer> {
    const now = revision();
    if (cache?.revision === now && Date.now() - cache.at < cacheMs) return cache.body;
    if (running?.revision === now) return (await running.done).body;
    if (!running) return (await start()).body;
    // 앞선 버전을 만드는 중이면 끝난 뒤 한 번 더 만든다. 그사이 들어온 요청은 버전이 달라도 그것을 같이 기다린다(그 만들기가 더 나중에 읽으므로 모두 담긴다).
    next ??= running.done.then(() => {}, () => {}).then(() => {
      next = null;
      return start();
    });
    return (await next).body;
  }

  /** 워커를 끈다(시험이 끝날 때). */
  async function close() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const w = worker;
    worker = null;
    if (w) await w.terminate();
  }

  return { body, close };
}
