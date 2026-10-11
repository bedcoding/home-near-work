// '대시보드 켜기' 아이콘을 만든다: launcher/icon.ico(윈도우 바탕 화면 바로 가기), launcher/icon.png(맥 .command 파일).
// 모양을 바꿀 때만 다시 돌린다: node launcher/make-icons.mjs  (Playwright의 Chromium으로 SVG를 그려 PNG로 찍는다)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// 대시보드 강조색(#1f5fbf) 바탕에 흰 집
const SHAPES = `
  <rect x="16" y="16" width="224" height="224" rx="52" fill="#1f5fbf"/>
  <path d="M128 58 L210 128 H186 V198 H70 V128 H46 Z" fill="#fff" stroke="#fff" stroke-width="8" stroke-linejoin="round"/>
  <rect x="113" y="146" width="30" height="56" rx="4" fill="#1f5fbf"/>`;

// 조회용 브라우저(server/browser.ts)처럼 설치된 크롬을 먼저 쓴다.
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage();

/** size px PNG. viewBox를 넓히면 둘레에 여백이 생긴다(맥 아이콘은 여백이 조금 더 있다). */
async function png(size, viewBox = '0 0 256 256') {
  const view = Math.max(size, 256);
  await page.setViewportSize({ width: view, height: view });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" style="display:block">${SHAPES}</svg></body></html>`,
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** PNG 여러 장을 .ico 하나로 묶는다(윈도우 비스타 이후는 .ico 안의 PNG를 읽는다). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.data)]);
}

const images = [];
for (const size of [16, 24, 32, 48, 64, 128, 256]) images.push({ size, data: await png(size) });
fs.writeFileSync(path.join(DIR, 'icon.ico'), ico(images));
fs.writeFileSync(path.join(DIR, 'icon.png'), await png(1024, '-11 -11 278 278'));
await browser.close();
console.log('launcher/icon.ico, launcher/icon.png를 만들었습니다.');
