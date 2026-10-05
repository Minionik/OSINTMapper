@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missingnode
node -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)"
if errorlevel 1 goto missingnode
if not exist "dist\launch.js" (
  if not exist "node_modules\tsx\dist\cli.mjs" (
    call npm ci
    if errorlevel 1 goto failed
  )
  call npm run build
  if errorlevel 1 goto failed
)
node "dist\launch.js"
if errorlevel 1 goto failed
exit /b 0
:missingnode
echo OSINT Mapper needs Node.js 24 or newer on PATH. Python is no longer required.
echo Install Node.js, then open this launcher again.
pause
exit /b 1
:failed
echo The workspace could not start. Read the message above or data\launcher.log.
pause
exit /b 1
