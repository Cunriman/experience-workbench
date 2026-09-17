@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 经历工作台

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [x] 没有找到 Node.js。
  echo       请先到 https://nodejs.org 下载安装 LTS 版本，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动经历工作台...
echo   浏览器会自动打开；如果没有自动打开，请手动访问 http://127.0.0.1:8777
echo.

start "" http://127.0.0.1:8777
"%NODE_EXE%" server.js

echo.
echo   服务已停止。
pause
