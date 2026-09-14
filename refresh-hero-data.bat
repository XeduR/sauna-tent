@echo off
REM Runs HeroesDataParser against the local HotS install and regenerates
REM data\hero-info.json, data\talent-names.json, data\talent-descriptions.json,
REM and the per-hero images under img\hero\.
REM
REM Prerequisites (one-time):
REM   1. Install the .NET 8.0 SDK manually (this script does NOT auto-install it):
REM      https://dotnet.microsoft.com/download/dotnet/8.0  (pick "SDK", x64)
REM      The Runtime alone is not enough; the SDK is required for global tools.
REM   2. HeroesDataParser will be installed automatically on first run after a y/N prompt.
REM
REM -release (default) reads the live install, -ptr the Public Test install. A PTR
REM run only adds heroes the live build does not have yet.
REM
REM Usage:
REM   refresh-hero-data.bat                            (live install, default path)
REM   refresh-hero-data.bat -ptr                       (PTR install, default path)
REM   refresh-hero-data.bat -ptr "D:\Path\To\HotS PTR" (override game install path)

setlocal
cd /d "%~dp0"

set "CHANNEL=-release"
set "GAME_PATH=%~1"

if /i "%~1"=="-ptr" (
    set "CHANNEL=-ptr"
    set "GAME_PATH=%~2"
) else if /i "%~1"=="-release" (
    set "GAME_PATH=%~2"
)

if "%GAME_PATH%"=="" (
    if /i "%CHANNEL%"=="-ptr" (
        set "GAME_PATH=C:\Games\Heroes of the Storm Public Test"
    ) else (
        set "GAME_PATH=C:\Games\Heroes of the Storm"
    )
)

if not exist "%GAME_PATH%\HeroesData" (
    echo HotS install not found at: %GAME_PATH%
    echo Expected a HeroesData\ subfolder. Pass the correct path as an argument.
    pause
    exit /b 1
)

where dotnet >nul 2>nul
if not %errorlevel%==0 (
    echo dotnet was not found on PATH.
    echo Install the .NET 8.0 SDK manually from:
    echo   https://dotnet.microsoft.com/download/dotnet/8.0
    echo Pick "SDK" ^(not "Runtime"^), x64 installer. Then open a new terminal and rerun.
    pause
    exit /b 1
)

where py >nul 2>nul
if %errorlevel%==0 (
    set "PYTHON=py -3"
) else (
    set "PYTHON=python"
)

echo Channel:   %CHANNEL%
echo Game path: %GAME_PATH%
echo.

%PYTHON% generate_hero_data.py %CHANNEL% --game-path "%GAME_PATH%"
if errorlevel 1 (
    echo.
    echo Hero data refresh failed. See output above.
    pause
    exit /b 1
)

echo.
pause
endlocal
