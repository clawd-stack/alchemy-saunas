@echo off
setlocal enabledelayedexpansion

echo.
echo ============================================================
echo   Alchemy Saunas -- Merge dev to main
echo ============================================================
echo.

set "REPO=%~dp0"
set "PAGES_URL=https://clawd-stack.github.io/alchemy-saunas/"

:: ── Confirm dev branch name ───────────────────────────────────────────────
set /p DEV_BRANCH="Dev branch to merge (default: dev): "
if "!DEV_BRANCH!"=="" set "DEV_BRANCH=dev"

:: ── Check the dev branch exists ───────────────────────────────────────────
cd /d "%REPO%"
git rev-parse --verify "!DEV_BRANCH!" >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo ERROR: Branch "!DEV_BRANCH!" does not exist.
  exit /b 1
)

echo.
echo [1/5] Switching to main...
git checkout main
if %ERRORLEVEL% neq 0 (
  echo ERROR: Could not switch to main. Stash or commit your changes first.
  exit /b 1
)

:: ── Merge dev ─────────────────────────────────────────────────────────────
echo.
echo [2/5] Merging !DEV_BRANCH! into main...
git merge --no-ff "!DEV_BRANCH!" -m "Merge !DEV_BRANCH! into main"
if %ERRORLEVEL% neq 0 (
  echo.
  echo ERROR: Merge failed (conflict?). Resolve conflicts then run deploy.bat.
  exit /b 1
)
echo Merge successful.

:: ── Pre-push validation ───────────────────────────────────────────────────
echo.
echo [3/5] Running pre-push checks on merged result...
node "%REPO%pre-push-check.js"
if %ERRORLEVEL% neq 0 (
  echo.
  echo MERGE ABORTED -- checks failed. Resetting merge...
  git reset --merge
  echo Merge reset. Fix the issues on !DEV_BRANCH! and try again.
  exit /b 1
)

:: ── Push to origin main ───────────────────────────────────────────────────
echo.
echo [4/5] Pushing to origin main...
git push origin main
if %ERRORLEVEL% neq 0 (
  echo ERROR: git push failed.
  exit /b 1
)

:: ── Summary and open ─────────────────────────────────────────────────────
echo.
echo [5/5] Merge + deploy summary:
echo   Merged : !DEV_BRANCH! -^> main
echo   Commit :
git log -1 --pretty="  %%h %%s"
echo   URL    : %PAGES_URL%
echo.
echo Opening GitHub Pages for visual verification...
start "" "%PAGES_URL%"

echo.
echo ============================================================
echo   Merge + deploy complete!
echo ============================================================
echo.
