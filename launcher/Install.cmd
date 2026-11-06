@echo off
rem One-click setup for the self-updating copy of AimTrainer.
rem Makes an AimTrainer shortcut on your desktop, then starts the game.
setlocal
where git >nul 2>nul
if errorlevel 1 goto missing
where node >nul 2>nul
if errorlevel 1 goto missing

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
exit /b 0

:missing
echo.
echo Install Node.js LTS from nodejs.org (and Git from git-scm.com), then try again.
echo After installing, close this window and open a new one.
echo.
pause
exit /b 1
