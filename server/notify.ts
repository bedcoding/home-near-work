import { execFile } from 'node:child_process';
import path from 'node:path';
import notifier from 'node-notifier';
import open from 'open';
import { DASHBOARD_URL, ROOT } from './config.js';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
/** 윈도우 알림을 보내는 앱 번호(AppUserModelID). 알림 위에 보일 이름과 아이콘은 registerWindowsApp이 등록한다. */
const APP_ID = 'HomeNearWork.Dashboard';
const APP_NAME = '회사근처 내집마련';
/** 윈도우 알림의 앱 아이콘과 본문 그림 */
const ICON = path.join(ROOT, 'launcher', 'icon.png');
let registering: Promise<void> | null = null;

/**
 * 윈도우 알림 위에 이 앱 이름과 집 아이콘이 보이게 HKCU\Software\Classes\AppUserModelId\<APP_ID>에
 * DisplayName과 IconUri(ICON)를 적는다(서버를 켠 뒤 처음 알림 때 한 번). 실패해도 알림은 띄운다.
 */
function registerWindowsApp(): Promise<void> {
  registering ??= (async () => {
    const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`;
    const values: [string, string][] = [
      ['DisplayName', APP_NAME],
      ['IconUri', ICON],
    ];
    for (const [name, value] of values) {
      await new Promise<void>((resolve) => {
        execFile('reg', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true }, (error) => {
          if (error) console.warn('알림 이름을 등록하지 못했습니다:', error.message);
          resolve();
        });
      });
    }
  })();
  return registering;
}

/**
 * 알림을 띄운다. url: 알림을 누르면 열 주소. 알림마다 제 주소를 연다(여러 개를 한꺼번에 띄워도).
 * 맥은 open 옵션으로, 윈도우는 알림을 누르면 콜백이 'activate'를 받아서 연다.
 */
export function notify(title: string, message: string, url = DASHBOARD_URL) {
  const options: Record<string, unknown> = { title, message, wait: true, sound: false };
  if (isMac) options.open = url;
  if (isWin) Object.assign(options, { appID: APP_ID, icon: ICON });
  const show = () => {
    try {
      notifier.notify(options as notifier.Notification, (_error, response) => {
        if (!isMac && response === 'activate') void open(url);
      });
    } catch (error) {
      console.warn('알림을 띄우지 못했습니다:', error);
    }
  };
  if (isWin) void registerWindowsApp().then(show);
  else show();
}
