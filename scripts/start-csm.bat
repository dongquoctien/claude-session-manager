@echo off
REM ============================================================
REM  Start the Claude Session Manager web UI.
REM  Double-click from Desktop (or anywhere) to launch.
REM
REM  This wrapper:
REM    1. cd's into the repo root regardless of where the .bat
REM       is invoked from (works even when shortcut'd to Desktop).
REM    2. Runs `npm run web` (= node packages/agent/bin/csm-web.js).
REM    3. The agent picks a free port, prints its token URL, and
REM       opens it in the default browser by itself.
REM    4. Keeps the window open so you can read logs / Ctrl+C.
REM ============================================================

REM -- Jump to repo root (parent of scripts/) --
set "REPO_ROOT=%~dp0.."
pushd "%REPO_ROOT%" || (
    echo ERROR: Cannot cd into repo root: %REPO_ROOT%
    pause
    exit /b 1
)

echo ============================================================
echo Starting Claude Session Manager web UI in: %CD%
echo The browser opens automatically with a one-time token URL.
echo Press Ctrl+C in this window to stop the server.
echo ============================================================
echo.

REM -- Run the server in the foreground (blocks until Ctrl+C).
REM    csm-web auto-opens the token URL in the default browser. --
call npm run web

popd
echo.
echo ============================================================
echo csm web UI stopped. Press any key to close this window.
echo ============================================================
pause >nul
