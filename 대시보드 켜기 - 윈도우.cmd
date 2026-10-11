@echo off
chcp 65001 >nul
rem 회사근처 내집마련 대시보드를 켜고, 크롬 새 창 하나에 부동산 사이트와 대시보드를 연다(윈도우). 바탕 화면의 '회사근처 내집마련 대시보드' 아이콘이 이 파일을 부른다.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 없습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 눌러 주세요.
  pause
  exit /b 1
)
node launcher\start.mjs %*
if errorlevel 1 pause
