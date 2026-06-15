@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting PowerShell with temporary bypass to run npm start...
powershell -NoProfile -ExecutionPolicy Bypass -Command "cd '%CD%'; npm start"
