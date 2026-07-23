@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs-lts\node-v24.16.0-win-x64\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo Starting AI-SMILE Node server.
echo Keep this window open while students use the app.
echo.
echo Student URL:
echo   http://localhost:3000/student-index.html
echo.
echo Morning student URL:
echo   http://localhost:3000/morning/student
echo.
echo Morning admin URL:
echo   http://localhost:3000/morning/admin
echo.

"%NODE_EXE%" server.js

pause
