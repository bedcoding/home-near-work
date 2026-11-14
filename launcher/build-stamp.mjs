// 대시보드를 켤 때 화면 빌드를 건너뛰어도 되는지 본다(start.mjs). 켤 때마다 화면을 다시 빌드하면 1~2초(하드디스크에서는 더) 늦게 켜진다.
// 화면 빌드에 들어가는 파일(web의 소스, shared, 빌드 설정, 패키지 목록)의 크기와 고친 시각이 지난 빌드 때와 같고,
// 빌드 결과(web/dist/index.html)도 그때 만든 그대로면 다시 빌드하지 않는다. 하나라도 다르거나 기록이 없으면 빌드한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 빌드 입력: 폴더(빌드 결과 web/dist는 뺀다)와 파일 */
const INPUT_DIRS = ['web', 'shared'];
const INPUT_FILES = ['vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'];
/** 지난 빌드 기록. 서버가 web/dist를 그대로 내주므로 거기 말고 node_modules에 둔다(설치 기록 .hnw-installed와 같은 곳). */
export const BUILD_STAMP = path.join('node_modules', '.hnw-build');
const INDEX = path.join('web', 'dist', 'index.html');

const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');

/** root 아래 빌드 입력 파일마다 경로, 크기, 고친 시각을 모은 지문 */
export function buildInputs(root) {
  const lines = [];
  const add = (rel) => {
    const stat = fs.statSync(path.join(root, rel), { throwIfNoEntry: false });
    lines.push(stat ? `${rel}\t${stat.size}\t${stat.mtimeMs}` : `${rel}\t-`);
  };
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (child === 'web/dist' || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) walk(child);
      else add(child);
    }
  };
  for (const dir of INPUT_DIRS) if (fs.existsSync(path.join(root, dir))) walk(dir);
  for (const file of INPUT_FILES) add(file);
  return sha1(lines.sort().join('\n'));
}

/** 빌드 결과의 지문(없으면 null) */
function builtIndex(root) {
  try {
    return sha1(fs.readFileSync(path.join(root, INDEX)));
  } catch {
    return null;
  }
}

/** 지난 빌드 뒤로 입력과 결과가 그대로인지 */
export function buildIsCurrent(root, inputs) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(root, BUILD_STAMP), 'utf8'));
    const index = builtIndex(root);
    return !!index && saved?.inputs === inputs && saved?.index === index;
  } catch {
    return false;
  }
}

/** 빌드가 끝나면 남긴다. inputs는 빌드 전에 잰 지문이다(빌드하는 동안 고친 파일이 있으면 다음에 다시 빌드하게). */
export function rememberBuild(root, inputs) {
  const index = builtIndex(root);
  if (!index) return;
  try {
    fs.writeFileSync(path.join(root, BUILD_STAMP), JSON.stringify({ inputs, index }));
  } catch {
    // 못 남기면 다음에 다시 빌드한다.
  }
}
