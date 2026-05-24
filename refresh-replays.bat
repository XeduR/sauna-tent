@echo off
REM Copies new .StormReplay files from %USERPROFILE%\Documents\Heroes of the Storm\Accounts
REM into the project replays\ folder, then prints a summary.
REM
REM Run from Windows by double-clicking this file or invoking it in cmd.

setlocal
cd /d "%~dp0"

REM Prefer the py launcher; fall back to python on PATH.
where py >nul 2>nul
if %errorlevel%==0 (
    set "PYTHON=py -3"
) else (
    set "PYTHON=python"
)

%PYTHON% collect_replays.py
if errorlevel 1 (
    echo.
    echo Failed to collect replays. See output above.
    pause
    exit /b 1
)

echo.
pause
endlocal
