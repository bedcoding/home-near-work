import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page, type Response } from 'playwright';
import { BROWSER_PROFILE_DIR, RUNS_DIR } from './config.js';
import { addRequest, addScreenshot, getSetting } from './db.js';
import { REST_CHOICES, REST_DEFAULT } from '../shared/types.js';

/** 조회 중 사이트 카드에 붙이는 배지. seen은 이 프로그램이 전에 모은 매물('기존')이다. */
export type BadgeTone = 'new' | 'seen' | 'discard' | 'star';

// 조회용 창에 보이는 커서. Playwright의 마우스는 창 안에서만 움직이고(실제 마우스는 그대로),
// 원래는 화면에 안 보이므로 움직임을 따라가는 화살표와 클릭 표시를 그려 준다.
// tsx(esbuild)가 넣는 __name 도우미도 여기서 정의한다(page.evaluate 안의 함수가 깨지지 않게).
const INIT_SCRIPT = `
(() => {
  window.__name = window.__name || ((fn) => fn);
  if (window.__hnwCursorInstalled) return;
  window.__hnwCursorInstalled = true;
  const install = () => {
    if (document.getElementById('__hnw_cursor')) return;
    const c = document.createElement('div');
    c.id = '__hnw_cursor';
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2l16 10-7 1.6L9.4 21z" fill="#e5484d" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    c.style.cssText = 'position:fixed;left:-50px;top:-50px;z-index:2147483647;pointer-events:none;transform:translate(-4px,-3px);';
    document.documentElement.appendChild(c);
    document.addEventListener('mousemove', (e) => {
      c.style.left = e.clientX + 'px';
      c.style.top = e.clientY + 'px';
      // 진행 띠가 커서가 가려는 곳(검색창 등)을 가리지 않게, 커서가 다가오면 위아래로 비켜 준다.
      const b = document.getElementById('__hnw_banner');
      if (!b) return;
      const r = b.getBoundingClientRect();
      if (e.clientX > r.left - 60 && e.clientX < r.right + 60 && e.clientY > r.top - 90 && e.clientY < r.bottom + 90) {
        const toTop = b.dataset.edge !== 'top';
        b.dataset.edge = toTop ? 'top' : 'bottom';
        b.style.top = toTop ? '10px' : 'auto';
        b.style.bottom = toTop ? 'auto' : '14px';
      }
    }, true);
    document.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + (e.clientX - 16) + 'px;top:' + (e.clientY - 16) + 'px;width:32px;height:32px;border-radius:50%;border:3px solid #e5484d;z-index:2147483646;pointer-events:none;transition:transform .5s ease-out,opacity .5s ease-out;';
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.9)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
`;

/** 조회할 때 역, 지역, 구 사이에 쉬는 시간(초, 설정 rest_seconds, 처음 3초) */
export function restSeconds(): number {
  const v = Number(getSetting('rest_seconds') ?? REST_DEFAULT);
  return REST_CHOICES.includes(v) ? v : REST_DEFAULT;
}

/** 조회용 브라우저 창. 평소 쓰는 크롬과 별개의 프로필로 띄운다. */
export class BrowserSession {
  private shotCount = 0;
  private pointer = { x: 640, y: 430 };

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly visible: boolean,
    readonly runId: number,
  ) {}

  static async open(runId: number, visible: boolean): Promise<BrowserSession> {
    fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
    const options = {
      headless: !visible,
      viewport: { width: 1280, height: 860 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    };
    let context: BrowserContext;
    try {
      // 설치된 크롬을 쓰면 브라우저를 따로 내려받지 않아도 된다.
      // 샌드박스는 켜 둔다(Playwright 기본값은 꺼짐이라 크롬이 --no-sandbox 보안 경고 띠를 띄운다).
      context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, { ...options, channel: 'chrome', chromiumSandbox: true });
    } catch {
      context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, options);
    }
    await context.addInitScript({ content: INIT_SCRIPT });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.evaluate(INIT_SCRIPT).catch(() => {});
    return new BrowserSession(context, page, visible, runId);
  }

  /** 역, 지역, 구 하나를 다 보고 다음으로 넘어가기 전에 쉰다(restSeconds초, 창 없이 돌 때도 줄이지 않음). */
  async rest() {
    const s = restSeconds();
    if (s > 0) await this.page.waitForTimeout(s * 1000);
  }

  /** ms만큼 쉰다. 창 없이 돌 때는 최대 0.8초. */
  async pause(ms: number) {
    await this.page.waitForTimeout(this.visible ? ms : Math.min(ms, 800));
  }

  /** 페이지를 열고 요청 기록에 남긴다. */
  async goto(source: string, url: string): Promise<Response | null> {
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    addRequest(this.runId, source, 'page', url, response?.status() ?? null, '페이지 열기');
    return response;
  }

  /** 데이터 응답이나 화면 조작을 요청 기록에 남긴다. */
  record(source: string, kind: 'data' | 'action', url: string, status: number | null, note: string | null = null) {
    addRequest(this.runId, source, kind, url, status, note);
  }

  // ---------- 보이는 마우스 조작 ----------

  async moveTo(x: number, y: number) {
    const distance = Math.hypot(x - this.pointer.x, y - this.pointer.y);
    const steps = this.visible ? Math.max(8, Math.round(distance / 22)) : 2;
    await this.page.mouse.move(x, y, { steps });
    this.pointer = { x, y };
  }

  async clickAt(x: number, y: number) {
    await this.moveTo(x, y);
    await this.pause(250);
    await this.page.mouse.down();
    await this.page.mouse.up();
  }

  /** 요소 가운데로 커서를 옮겨 클릭한다. 화면 밖이면 먼저 스크롤하고, 위치를 못 구하면 그냥 클릭한다. */
  async click(locator: Locator) {
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await locator.boundingBox().catch(() => null);
    if (!box) {
      await locator.click({ timeout: 5000 });
      return;
    }
    await this.clickAt(box.x + box.width / 2, box.y + box.height / 2);
  }

  /** 요소 위로 커서만 옮긴다(선택 상자처럼 누르면 목록이 펼쳐지는 경우). */
  async hover(locator: Locator) {
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await locator.boundingBox().catch(() => null);
    if (box) await this.moveTo(box.x + box.width / 2, box.y + box.height / 2);
  }

  async type(text: string) {
    await this.page.keyboard.type(text, { delay: this.visible ? 140 : 25 });
  }

  /** 한 점에서 다른 점으로 끌어서 놓는다(지도 옮기기). */
  async drag(fromX: number, fromY: number, toX: number, toY: number) {
    await this.moveTo(fromX, fromY);
    await this.page.mouse.down();
    await this.page.mouse.move(toX, toY, { steps: this.visible ? 30 : 15 });
    // 끌자마자 놓으면 지도가 관성으로 더 밀려가므로, 멈춘 뒤에 놓는다.
    await this.page.waitForTimeout(400);
    this.pointer = { x: toX, y: toY };
    await this.page.mouse.up();
  }

  /** 그 자리에서 휠을 굴린다. */
  async wheel(x: number, y: number, deltaY: number) {
    await this.moveTo(x, y);
    await this.page.mouse.wheel(0, deltaY);
  }

  // ---------- 화면 위 표시 ----------

  /**
   * 페이지 아래쪽에 진행 상황 띠를 띄운다. 사이트 검색창 같은 게 주로 위쪽에 있어서 아래에 두고,
   * 커서가 다가오면 반대쪽으로 비킨다(INIT_SCRIPT). 페이지를 옮기면 사라지므로 이동할 때마다 다시 부른다.
   */
  async banner(text: string) {
    await this.page
      .evaluate((message) => {
        const id = '__hnw_banner';
        let el = document.getElementById(id);
        if (!el) {
          el = document.createElement('div');
          el.id = id;
          el.dataset.edge = 'bottom';
          el.setAttribute(
            'style',
            [
              'position:fixed', 'bottom:14px', 'top:auto', 'left:50%', 'transform:translateX(-50%)', 'z-index:2147483645',
              'max-width:min(720px, calc(100vw - 40px))', 'padding:8px 16px', 'border-radius:14px',
              'background:rgba(22,32,46,.92)', 'color:#fff', 'text-align:center',
              'font:600 14px/1.45 "Apple SD Gothic Neo","Malgun Gothic",sans-serif',
              'box-shadow:0 6px 24px rgba(0,0,0,.35)', 'pointer-events:none',
            ].join(';'),
          );
          document.documentElement.appendChild(el);
        }
        el.textContent = `🏠 회사근처 내집마련, ${message}`;
      }, text)
      .catch(() => {});
  }

  /**
   * 읽은 매물 카드에 테두리와 배지를 붙인다. stagger를 주면 하나씩 차례로 칠해서 '읽는 중'이 보이게 한다.
   * 카드 찾는 방법(선택자)은 수집기가 넘긴다.
   */
  async badges(items: { selector: string; tone: BadgeTone }[], staggerMs = 0) {
    await this.page
      .evaluate(
        ({ list, stagger }) => {
          const colors: Record<string, [string, string]> = {
            new: ['#e5484d', '#fff'],
            seen: ['#16202e', '#fff'],
            discard: ['#8b8d98', '#fff'],
            star: ['#f5a524', '#16202e'],
          };
          const labels: Record<string, string> = { new: '신규', seen: '기존', discard: '버림', star: '관심' };
          const titles: Record<string, string> = {
            new: '지난 조회까지 없던 매물',
            seen: '지난 조회에서 이미 모은 매물',
            discard: '버린 매물',
            star: '관심 표시한 매물',
          };
          list.forEach(({ selector, tone }, index) => {
            const apply = () => {
              const card = document.querySelector(selector) as HTMLElement | null;
              if (!card) return;
              card.querySelector(':scope > .__hnw_badge')?.remove();
              if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
              const [bg, fg] = colors[tone];
              card.style.outline = `3px solid ${bg}`;
              card.style.outlineOffset = '2px';
              const badge = document.createElement('span');
              badge.className = '__hnw_badge';
              badge.textContent = labels[tone];
              badge.title = titles[tone];
              badge.setAttribute('style', `position:absolute;top:8px;left:8px;z-index:30;padding:3px 9px;border-radius:6px;font:700 13px/1.3 sans-serif;background:${bg};color:${fg}`);
              card.appendChild(badge);
              if (tone === 'discard') card.style.opacity = '0.45';
            };
            if (stagger > 0) setTimeout(apply, index * stagger);
            else apply();
          });
        },
        { list: items, stagger: this.visible ? staggerMs : 0 },
      )
      .catch(() => {});
    if (this.visible && staggerMs > 0) await this.page.waitForTimeout(Math.min(items.length * staggerMs, 4000));
  }

  /** 지금 화면을 저장하고 대시보드에서 볼 수 있는 경로를 돌려준다. */
  async screenshot(source: string, label: string): Promise<string | null> {
    try {
      const dir = path.join(RUNS_DIR, String(this.runId));
      fs.mkdirSync(dir, { recursive: true });
      this.shotCount += 1;
      const safe = label.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
      const file = `${String(this.shotCount).padStart(2, '0')}-${source}-${safe}.jpg`;
      await this.page.screenshot({ path: path.join(dir, file), type: 'jpeg', quality: 60 });
      const url = `/runs/${this.runId}/${encodeURIComponent(file)}`;
      addScreenshot(this.runId, source, label, url);
      return url;
    } catch {
      return null;
    }
  }

  async close() {
    await this.context.close().catch(() => {});
  }
}
