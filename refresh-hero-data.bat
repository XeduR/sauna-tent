@echo off
REM Runs HeroesDataParser against the local HotS install and regenerates
REM data\hero-info.json, data\talent-names.json, data\talent-descriptions.json,
REM and the per-hero images under img\hero\.
REM
REM Prerequisites (one-time):
REM   1. Install .NET 8.0 (SDK or Runtime): https://dotnet.microsoft.com/download/dotnet/8.0
REM   2. dotnet tool install --global HeroesDataParser
REM
REM Usage:
REM   refresh-hero-data.bat                       (uses default game path below)
REM   refresh-hero-data.bat "D:\Path\To\HotS"     (override game install path)

setlocal
cd /d "%~dp0"

set "GAME_PATH=%~1"
if "%GAME_PATH%"=="" set "GAME_PATH=C:\Games\Heroes of the Storm"

if not exist "%GAME_PATH%\HeroesData" (
    echo HotS install not found at: %GAME_PATH%
    echo Expected a HeroesData\ subfolder. Pass the correct path as the first argument.
    pause
    exit /b 1
)

where dotnet >nul 2>nul
if not %errorlevel%==0 (
    echo dotnet not found on PATH.
    echo Install .NET 8.0 from https://dotnet.microsoft.com/download/dotnet/8.0
    echo Then run: dotnet tool install --global HeroesDataParser
    pause
    exit /b 1
)

where py >nul 2>nul
if %errorlevel%==0 (
    set "PYTHON=py -3"
) else (
    set "PYTHON=python"
)

echo Game path: %GAME_PATH%
echo.

%PYTHON% generate_hero_data.py --game-path "%GAME_PATH%"
if errorlevel 1 (
    echo.
    echo Hero data refresh failed. See output above.
    pause
    exit /b 1
)

echo.
pause
endlocal
