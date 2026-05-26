@echo off
REM Runs the replay processing pipeline with selectable workflows.
REM
REM Main workflows:
REM   1. Incremental update    -- process new replays + regenerate dashboard data
REM   2. Force full reprocess  -- reprocess every replay + regenerate dashboard data
REM
REM Optional sub-steps (asked per run):
REM   - Collect new replays from %USERPROFILE% before the pipeline (refresh-replays.bat)
REM   - Refresh static hero data after the pipeline (refresh-hero-data.bat)
REM
REM First-run prerequisites:
REM   - .NET 8.0 SDK installed (same SDK as refresh-hero-data.bat uses):
REM     https://dotnet.microsoft.com/download/dotnet/8.0  (pick "SDK", x64)
REM   - The pipeline checks for the heroes-replay-parser-cs global tool at
REM     startup. If missing, it prompts y/N to build the nupkg (dotnet pack)
REM     and install the tool automatically. Declining aborts the run.
REM
REM Usage:
REM   run-pipeline.bat                       (uses default hero-data game path)
REM   run-pipeline.bat "D:\Path\To\HotS"     (forwarded to refresh-hero-data.bat)

setlocal
cd /d "%~dp0"

set "GAME_PATH=%~1"

where py >nul 2>nul
if %errorlevel%==0 (
    set "PYTHON=py -3"
) else (
    set "PYTHON=python"
)

:workflow
echo.
echo === Pipeline workflow ===
echo   1. Incremental update    (process new replays + regenerate dashboard)
echo   2. Force full reprocess  (reprocess every replay + regenerate dashboard)
echo   Q. Quit
echo.
choice /c 12Q /n /m "Select [1, 2, Q]: "
if errorlevel 3 goto quit
if errorlevel 2 (
    set "PIPELINE_FLAGS=--reprocess --generate"
    goto sub_collect
)
if errorlevel 1 (
    set "PIPELINE_FLAGS=--generate"
    goto sub_collect
)

:sub_collect
echo.
choice /c YN /n /m "Collect new replays from %%USERPROFILE%% first? [Y/N]: "
if errorlevel 2 set "RUN_COLLECT=0"
if errorlevel 1 if not errorlevel 2 set "RUN_COLLECT=1"
goto sub_herodata

:sub_herodata
echo.
choice /c YN /n /m "Refresh static hero data after pipeline? [Y/N]: "
if errorlevel 2 set "RUN_HERODATA=0"
if errorlevel 1 if not errorlevel 2 set "RUN_HERODATA=1"
goto run

:run
echo.
echo === Plan ===
if "%RUN_COLLECT%"=="1"  echo   [1] Collect new replays
echo   [*] Pipeline: %PIPELINE_FLAGS%
if "%RUN_HERODATA%"=="1" echo   [2] Refresh hero data
echo.

if "%RUN_COLLECT%"=="1" (
    echo [Sub-step] Collecting replays...
    %PYTHON% collect_replays.py
    if errorlevel 1 (
        echo.
        echo Replay collection failed. See output above.
        pause
        exit /b 1
    )
    echo.
)

echo [Main] Running pipeline: %PIPELINE_FLAGS%
%PYTHON% -m pipeline.batch %PIPELINE_FLAGS%
if errorlevel 1 (
    echo.
    echo Pipeline failed. See output above.
    pause
    exit /b 1
)

if "%RUN_HERODATA%"=="1" (
    echo.
    echo [Sub-step] Refreshing hero data...
    if "%GAME_PATH%"=="" (
        call refresh-hero-data.bat
    ) else (
        call refresh-hero-data.bat "%GAME_PATH%"
    )
    if errorlevel 1 (
        echo.
        echo Hero data refresh failed. See output above.
        pause
        exit /b 1
    )
)

echo.
echo Done.
pause
goto end

:quit
echo Canceled.

:end
endlocal
