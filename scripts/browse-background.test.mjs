import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// 실제 백그라운드와 importScripts 파일을 함께 실행한다.
// Chrome 저장소와 네트워크만 합성하며 개인 설정이나 데이터베이스는 읽지 않는다.
const source = (name) => fs.readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
const dashboard = { frameId: 0, url: 'http://localhost:8787/' };

function worker({ storageFails = false } = {}) {
  const listeners = [];
  const imported = [];
  const event = { addListener() {} };
  const chrome = {
    storage: {
      local: {
        get: async () => {
          if (storageFails) throw new Error('synthetic storage failure');
          return {};
        },
      },
      onChanged: event,
    },
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      onInstalled: event,
      onStartup: event,
      getManifest: () => ({ version: 'synthetic-test' }),
    },
    downloads: { onChanged: event },
    alarms: { onAlarm: event },
  };
  const context = vm.createContext({
    chrome, URL, AbortSignal, setTimeout,
    fetch: async (url) => {
      assert.equal(url, 'http://127.0.0.1:8787/api/extension/version?v=synthetic-test');
      return { json: async () => ({ version: 'synthetic-test' }) };
    },
  });
  context.importScripts = (...names) => {
    for (const name of names) {
      imported.push(name);
      vm.runInContext(source(name), context, { filename: name });
    }
  };
  vm.runInContext(source('background.js'), context, { filename: 'background.js' });
  assert.deepEqual(imported, ['sites.js', 'areas.js', 'browse-queue.js']);
  assert.equal(listeners.length, 1);
  return (sender = dashboard) => new Promise((resolve, reject) => {
    try {
      const keepsChannel = listeners[0]({ type: 'browse-status' }, sender, (response) => resolve(JSON.parse(JSON.stringify(response))));
      assert.equal(keepsChannel, true, '비동기 상태 응답을 보낼 때 Chrome 메시지 채널을 유지한다');
    } catch (error) { reject(error); }
  });
}

test('실제 백그라운드와 순회 모듈이 최초 상태 요청에 명시적인 빈 상태를 반환한다', async () => {
  assert.deepEqual(await worker()(), { state: null });
});

test('실제 백그라운드가 대시보드 외 발신자의 상태 요청에 오류를 반환한다', async () => {
  const response = await worker()({ frameId: 0, url: 'https://example.invalid/' });
  assert.deepEqual(response, { error: '대시보드에서만 지역 순회를 조작할 수 있습니다.' });
});

test('실제 백그라운드가 저장소 읽기 실패를 응답 없는 상태로 삼키지 않는다', async () => {
  assert.deepEqual(await worker({ storageFails: true })(), { error: 'synthetic storage failure' });
});
