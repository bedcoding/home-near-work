#!/bin/bash
# 회사근처 내집마련 대시보드를 켜고, 크롬 새 창 하나에 부동산 사이트와 대시보드를 연다(맥). Finder에서 두 번 누르거나, Dock에 끌어다 두고 누른다.
# 윈도우에서 복사해 온 파일은 실행 권한이 없어 처음 한 번은 터미널에서 sh로 실행해야 할 수 있다. 그 뒤로는 두 번 누르면 열린다.
cd "$(dirname "$0")" || exit 1
chmod +x "$0" 2>/dev/null
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 없습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 눌러 주세요."
  read -r -p "Enter를 누르면 닫힙니다. "
  exit 1
fi
if ! node launcher/start.mjs; then
  read -r -p "문제가 있어 멈췄습니다. 위 내용을 확인한 뒤 Enter를 누르면 닫힙니다. "
fi
