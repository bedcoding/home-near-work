import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildInputs, buildIsCurrent, rememberBuild } from '../launcher/build-stamp.mjs';

// 대시보드를 켤 때 화면 빌드를 건너뛰는 조건: 화면 소스와 빌드 결과가 지난 빌드 때 그대로일 때만 건너뛴다.
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-build-stamp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('web/index.html', '<div id="app"></div>');
  write('web/src/main.ts', 'export const a = 1;');
  write('shared/format.ts', 'export const b = 2;');
  write('package.json', '{}');
  write('web/dist/index.html', '<script src="/assets/index-a.js"></script>');
  write('web/dist/assets/index-a.js', 'built');
  fs.mkdirSync(path.join(root, 'node_modules'));
  return { root, write };
}

test('기록이 없으면 빌드하고, 빌드 뒤 소스와 결과가 그대로면 건너뛴다', (t) => {
  const { root, write } = project(t);
  const inputs = buildInputs(root);
  assert.equal(buildIsCurrent(root, inputs), false, '처음에는 기록이 없다');
  rememberBuild(root, inputs);
  assert.equal(buildIsCurrent(root, buildInputs(root)), true);
  // 빌드 결과 폴더 안의 다른 파일은 입력이 아니다.
  write('web/dist/assets/extra.js', 'x');
  assert.equal(buildIsCurrent(root, buildInputs(root)), true);
});

test('화면 소스나 공용 코드, 패키지 목록이 바뀌거나 빌드 결과가 달라지면 다시 빌드한다', (t) => {
  const { root, write } = project(t);
  const remember = () => rememberBuild(root, buildInputs(root));
  const changed = (what) => assert.equal(buildIsCurrent(root, buildInputs(root)), false, what);

  remember();
  write('web/src/main.ts', 'export const a = 22;');
  changed('화면 소스 내용');
  remember();
  const at = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(root, 'shared/format.ts'), at, at);
  changed('공용 코드의 고친 시각');
  remember();
  write('web/src/components/New.vue', '<template></template>');
  changed('새 파일');
  remember();
  fs.rmSync(path.join(root, 'web/src/components/New.vue'));
  changed('지운 파일');
  remember();
  write('package-lock.json', '{}');
  changed('패키지 목록');
  remember();
  // 다른 곳에서 npm run build로 결과를 바꿨다.
  write('web/dist/index.html', '<script src="/assets/index-b.js"></script>');
  changed('빌드 결과');
  remember();
  fs.rmSync(path.join(root, 'web/dist'), { recursive: true });
  changed('빌드 결과가 없음');
});
