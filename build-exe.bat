@echo off
chcp 65001 >nul
title Barq - build
cd /d "%~dp0"
echo ==========================================
echo   Barq Download Manager - Windows build
echo ==========================================
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed. Opening https://nodejs.org  - install the LTS version, then run this file again.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)
echo [1/4] Installing packages (Electron + Realm)...
call npm install --no-audit --no-fund
if errorlevel 1 goto :err
echo [2/4] Checking Realm...
node -e "require('realm'); console.log('    Realm OK: ' + require('realm/package.json').version)"
if errorlevel 1 echo     [!] Realm native module failed to load - the app will use its built-in fallback store.
echo [3/4] Running tests...
call npm test
if errorlevel 1 echo     [!] Some tests failed - see above.
echo [4/4] Building installer + portable exe...
call npm run dist:win
if errorlevel 1 goto :err
echo.
echo Done. Files are in the "release" folder.
start "" "%~dp0release"
pause
exit /b 0
:err
echo.
echo [X] Build failed - see the messages above.
pause
exit /b 1
