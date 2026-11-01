// icons/logo.png에서 크롬 확장 아이콘을 만든다: node extension/make-icons.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icons');
const source = await fs.readFile(path.join(dir, 'logo.png'));
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());

try {
  const page = await browser.newPage();
  const images = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();

    return [16, 32, 48, 128].map((size) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, size, size);
      return { size, data: canvas.toDataURL('image/png').split(',')[1] };
    });
  }, source.toString('base64'));

  for (const { size, data } of images) {
    await fs.writeFile(path.join(dir, `icon-${size}.png`), Buffer.from(data, 'base64'));
  }
} finally {
  await browser.close();
}

console.log('extension/icons에 16, 32, 48, 128px 아이콘을 만들었습니다.');
