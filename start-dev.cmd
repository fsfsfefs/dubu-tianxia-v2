@echo off
setlocal
set "PROJECT_ROOT=%~dp0"

start "Reader Next API" /D "%PROJECT_ROOT%apps\api" cmd /k ".venv\Scripts\python.exe -m uvicorn reader_next_api.main:app --host 127.0.0.1 --port 8790"
start "Reader Next Web" /D "%PROJECT_ROOT%apps\web" cmd /k "npm run dev"

timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:5174/"
