@echo off
set "APP_DIR=%~sdp0"
set "PYTHON_EXE=C:\Users\user\AppData\Local\Programs\Python\Python312\python.exe"

echo Starting social-emotional app server.
echo Keep this window open while students use the app.
echo.

if exist "%PYTHON_EXE%" (
  "%PYTHON_EXE%" "%APP_DIR%python_social_server.py"
) else (
  python "%APP_DIR%python_social_server.py"
)

pause
