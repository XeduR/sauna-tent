@echo off
REM Regenerates data\hero-info.json, data\talent-names.json,
REM data\talent-descriptions.json, and the per-hero images under img\hero\.
REM
REM HeroesDataParser downloads the game build straight from Blizzard's CDN, so
REM no HotS install is needed. The parser is a self-contained build: it needs no
REM .NET runtime and is downloaded into .scratch\hdp\ on first run after a y/N
REM prompt. Pillow is installed the same way.
REM
REM -release (default) reads the live build, -ptr the Public Test build. A PTR
REM run only adds heroes the live build does not have yet.
REM
REM Usage:
REM   refresh-hero-data.bat        (live build)
REM   refresh-hero-data.bat -ptr   (Public Test build)

setlocal
cd /d "%~dp0"

set "CHANNEL=-release"
if /i "%~1"=="-ptr" set "CHANNEL=-ptr"

where py >nul 2>nul
if %errorlevel%==0 (
    set "PYTHON=py -3"
) else (
    set "PYTHON=python"
)

echo Channel: %CHANNEL%
echo.

%PYTHON% generate_hero_data.py %CHANNEL%
if errorlevel 1 (
    echo.
    echo Hero data refresh failed. See output above.
    pause
    exit /b 1
)

echo.
pause
endlocal
