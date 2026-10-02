@echo off
REM Registers Heroes Lounge series from one match page or a team page, then
REM regenerates the dashboard when anything changed.
REM
REM Run from Windows by double-clicking this file or invoking it in cmd.

setlocal DisableDelayedExpansion
cd /d "%~dp0"

REM Prefer the py launcher; fall back to python on PATH.
where py >nul 2>nul
if %errorlevel%==0 (
    set "PYTHON=py -3"
) else (
    set "PYTHON=python"
)

:mode
echo.
echo Select mode:
echo   1: Download one series
echo   2: Download all series by a team
set "MODE="
set /p "MODE=Mode (1 or 2): "
if "%MODE%"=="1" goto series
if "%MODE%"=="2" goto team
goto mode

REM URLs are quoted so &, %% and ! in a team slug reach Python unchanged.
:series
set "URL="
set /p "URL=Series URL (https://heroeslounge.gg/match/view/<id>): "
if not defined URL goto series
%PYTHON% -m pipeline.batch lounge --mode series "%URL%" --generate
goto checked

:team
set "URL="
set /p "URL=Team URL (blank = configured team page): "
if not defined URL goto configuredteam
%PYTHON% -m pipeline.batch lounge --mode team "%URL%" --generate
goto checked

:configuredteam
%PYTHON% -m pipeline.batch lounge --mode team --generate

:checked
REM Exit code 2 is invalid input with nothing done, so offer the prompt again.
if errorlevel 2 (
    echo.
    echo Invalid input; nothing was done. See the message above.
    pause
    goto mode
)
if errorlevel 1 (
    echo.
    echo Heroes Lounge intake failed. See output above.
    pause
    exit /b 1
)

echo.
pause
endlocal
