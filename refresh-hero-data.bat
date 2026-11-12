@echo off
REM Regenerates the site's three hero files (data\hero-info.json,
REM data\talent-names.json, data\talent-descriptions.json), the per-hero images
REM under img\hero\, and data\gamedata\: the structured heroes, units and maps
REM for the channel, plus the version list.
REM
REM HeroesDataParser downloads the game build straight from Blizzard's CDN, so
REM no HotS install is needed. The parser is a self-contained build: it needs no
REM .NET runtime and is downloaded into .scratch\hdp\ on first run after a y/N
REM prompt. Pillow is installed the same way.
REM
REM -release (default) reads the live build, -ptr the Public Test build. A PTR
REM run writes the full PTR game data to data\gamedata\ but adds only heroes
REM the live build does not have yet to the three hero files.
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
