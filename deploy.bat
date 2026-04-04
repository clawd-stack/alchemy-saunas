@echo off
setlocal enabledelayedexpansion

echo.
echo ============================================================
echo   Alchemy Saunas -- Deploy to GitHub Pages
echo ============================================================
echo.

set "REPO=%~dp0"
set "PAGES_URL=https://clawd-stack.github.io/alchemy-saunas/"

:: ── Pre-deploy checks ────────────────────────────────────────────────────
echo [1/5] Running pre-deploy checks...
node "%REPO%pre-push-check.js"
if %ERRORLEVEL% neq 0 (
  echo.
  echo DEPLOY ABORTED -- pre-deploy checks failed. Fix the issues above.
  exit /b 1
)

:: ── Check for uncommitted changes ────────────────────────────────────────
echo.
echo [2/5] Checking git status...
cd /d "%REPO%"
git status --short
echo.

git diff --quiet --cached
set "STAGED=%ERRORLEVEL%"
git diff --quiet
set "UNSTAGED=%ERRORLEVEL%"

if %STAGED% equ 0 if %UNSTAGED% equ 0 (
  echo No uncommitted changes -- nothing to commit.
) else (
  echo Uncommitted changes detected.
  set /p COMMIT_MSG="Enter commit message (or press Enter to skip commit): "
  if not "!COMMIT_MSG!"=="" (
    git add -A
    git commit -m "!COMMIT_MSG!"
    if %ERRORLEVEL% neq 0 (
      echo.
      echo ERROR: git commit failed.
      exit /b 1
    )
    echo Commit created.
  ) else (
    echo Skipping commit -- pushing current HEAD.
  )
)

:: ── Push to origin main ───────────────────────────────────────────────────
echo.
echo [3/5] Pushing to origin main...
git push origin main
if %ERRORLEVEL% neq 0 (
  echo.
  echo ERROR: git push failed.
  exit /b 1
)
echo Push successful.

:: ── Summarise what was deployed ───────────────────────────────────────────
echo.
echo [4/5] Deploy summary:
echo   Branch : main
echo   Commit :
git log -1 --pretty="  %%h %%s"
echo   URL    : %PAGES_URL%
echo.

:: ── Open GitHub Pages in browser for visual verification ──────────────────
echo [5/5] Opening GitHub Pages for visual verification...
start "" "%PAGES_URL%"

echo.
echo ============================================================
echo   Deploy complete!
echo ============================================================
echo.
