// 윈도우 콘솔 창은 안을 한 번 누르면 '선택' 모드가 되어(창 제목 앞에 '선택'이 붙음) 글자 출력이 멈춘다.
// 그동안 로그를 쓰려던 대시보드 서버도 통째로 멈춰서 조회도 화면도 서 버리고, Esc를 눌러야 풀린다.
// 그래서 대시보드를 띄운 창의 빠른 편집을 꺼서, 실수로 눌러도 멈추지 않게 한다.
// 창의 글자를 복사하려면 제목줄을 오른쪽 단추로 눌러 편집 > 표시를 쓴다(그동안은 전처럼 멈추니 다 쓰면 Esc).
import { spawn } from 'node:child_process';

// 이 창의 입력 버퍼(CONIN$)를 열어 빠른 편집(0x40)만 끄고 나머지 모드는 그대로 둔다.
// 빠른 편집을 바꾸려면 확장 플래그(0x80)를 같이 켜야 한다.
const SCRIPT = `
Add-Type -Namespace Hnw -Name ConsoleMode -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
[DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
[DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr handle, uint mode);
[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
public static bool NoQuickEdit() {
  IntPtr input = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
  if (input == new IntPtr(-1)) return false;
  uint mode;
  bool ok = GetConsoleMode(input, out mode) && SetConsoleMode(input, (mode & ~0x40u) | 0x80u);
  CloseHandle(input);
  return ok;
}
'@
if (-not [Hnw.ConsoleMode]::NoQuickEdit()) { exit 1 }
`;

/**
 * 지금 창(콘솔)의 빠른 편집을 끈다. 윈도우가 아니거나 못 끄면 아무것도 바꾸지 않는다.
 * PowerShell을 같은 창에 붙여 띄우므로 끄는 데 1~2초 걸린다. 기다리지 않아도 되고, 끝나면 껐는지(true) 알려 준다.
 * @returns {Promise<boolean>}
 */
export function disableQuickEdit() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    // windowsHide를 켜지 않아야 PowerShell이 새 창을 만들지 않고 이 창에 붙는다.
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { stdio: 'ignore' });
    ps.on('error', () => resolve(false));
    ps.on('exit', (code) => resolve(code === 0));
  });
}
