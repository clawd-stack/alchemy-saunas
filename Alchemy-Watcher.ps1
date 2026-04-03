# ============================================================
# Alchemy Saunas — Cowork Task Watcher
# ============================================================
# Double-click to run. Watches the cowork-tasks folder and
# instantly processes delegated tasks using Claude CLI (Max plan).
# Press Ctrl+C to stop.
# ============================================================

$Host.UI.RawUI.WindowTitle = "Alchemy Saunas - Cowork Watcher"

# --- UTF-8 Encoding Fix ---
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONUTF8 = "1"

# --- Paths ---
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$tasksDir    = Join-Path $scriptDir "cowork-tasks"
$resultsDir  = Join-Path $scriptDir "cowork-results"

# Ensure folders exist
if (!(Test-Path $tasksDir))   { New-Item -ItemType Directory -Path $tasksDir   | Out-Null }
if (!(Test-Path $resultsDir)) { New-Item -ItemType Directory -Path $resultsDir | Out-Null }

# --- Check Claude CLI ---
$claudePath = Get-Command "claude" -ErrorAction SilentlyContinue
if (-not $claudePath) {
    Write-Host ""
    Write-Host "  ERROR: 'claude' CLI not found." -ForegroundColor Red
    Write-Host "  Install Claude Code first: https://docs.claude.com" -ForegroundColor Yellow
    Write-Host "  Then re-run this script." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

# --- Process a single task file ---
function Process-Task {
    param([string]$FilePath)

    $fileName = Split-Path -Leaf $FilePath
    Write-Host ""
    Write-Host "  New task detected: $fileName" -ForegroundColor Cyan

    try {
        Start-Sleep -Milliseconds 500  # Brief pause to ensure file write is complete

        $raw = Get-Content -Path $FilePath -Raw -ErrorAction Stop
        $task = $raw | ConvertFrom-Json

        if ($task.status -ne "pending") {
            Write-Host "  Skipping (status: $($task.status))" -ForegroundColor Yellow
            return
        }

        $agentName = $task.agentName
        Write-Host "  Agent: $agentName" -ForegroundColor Magenta
        Write-Host "  Processing via Claude CLI (Max plan)..." -ForegroundColor Yellow

        # Build the prompt for Claude CLI
        $conversationHistory = ""
        foreach ($msg in $task.messages) {
            $role = $msg.role
            $content = $msg.content
            if ($role -eq "user") {
                $conversationHistory += "User: $content`n`n"
            } else {
                $conversationHistory += "Assistant: $content`n`n"
            }
        }

        $cliPrompt = @"
You are playing the role of an AI agent in a Slack-style workspace. Here are your instructions:

--- SYSTEM PROMPT ---
$($task.systemPrompt)
--- END SYSTEM PROMPT ---

Here is the conversation so far:

$conversationHistory

Respond to the latest user message. Stay in character as described in the system prompt. Be conversational and chat-friendly. Do NOT include any preamble like "Here's my response" — just respond naturally as the agent would in a chat.
"@

        # Write prompt to a temp file to avoid command-line length limits
        $tempFile = Join-Path $env:TEMP "alchemy-task-$($task.id).txt"
        [System.IO.File]::WriteAllText($tempFile, $cliPrompt, [System.Text.Encoding]::UTF8)

        # Run Claude CLI in print mode (non-interactive, uses Max plan)
        $env:PYTHONUTF8 = "1"
        $rawOutput = & cmd /c "chcp 65001 >nul && type `"$tempFile`" | claude --print 2>&1"

        # Clean up temp file
        Remove-Item -Path $tempFile -ErrorAction SilentlyContinue

        # Join array output into a single string
        if ($rawOutput -is [array]) {
            $responseText = $rawOutput -join "`n"
        } else {
            $responseText = [string]$rawOutput
        }

        if ([string]::IsNullOrWhiteSpace($responseText)) {
            Write-Host "  WARNING: Empty response from Claude CLI" -ForegroundColor Red
            return
        }

        # Build result as proper JSON string with UTF-8 encoding
        $resultObj = @{
            id          = $task.id
            agentId     = $task.agentId
            viewKey     = $task.viewKey
            text        = $responseText.Trim()
            status      = "completed"
            completedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        }
        $resultJson = $resultObj | ConvertTo-Json -Depth 10 -Compress:$false

        # Write result file with proper UTF-8 (no BOM)
        $resultPath = Join-Path $resultsDir $fileName
        [System.IO.File]::WriteAllText($resultPath, $resultJson, (New-Object System.Text.UTF8Encoding $false))

        # Delete the original task file
        Remove-Item -Path $FilePath -ErrorAction SilentlyContinue

        Write-Host "  Done! Response written." -ForegroundColor Green

    } catch {
        Write-Host "  ERROR processing task: $_" -ForegroundColor Red
        # Clean up broken task so it doesn't block future runs
        Remove-Item -Path $FilePath -ErrorAction SilentlyContinue
    }
}

# --- Process any tasks already in the folder on startup ---
Write-Host ""
Write-Host "  =======================================" -ForegroundColor DarkYellow
Write-Host "    ALCHEMY SAUNAS - Cowork Watcher" -ForegroundColor Yellow
Write-Host "  =======================================" -ForegroundColor DarkYellow
Write-Host ""
Write-Host "  Watching: $tasksDir" -ForegroundColor Gray
Write-Host "  Results:  $resultsDir" -ForegroundColor Gray
Write-Host "  Claude:   $($claudePath.Source)" -ForegroundColor Gray
Write-Host ""
Write-Host "  Ready. Waiting for delegated tasks..." -ForegroundColor Green
Write-Host "  (Press Ctrl+C to stop)" -ForegroundColor DarkGray
Write-Host ""

$existing = Get-ChildItem -Path $tasksDir -Filter "*.json" -ErrorAction SilentlyContinue
foreach ($file in $existing) {
    Process-Task -FilePath $file.FullName
}

# --- Set up FileSystemWatcher ---
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $tasksDir
$watcher.Filter = "*.json"
$watcher.NotifyFilter = [System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::LastWrite
$watcher.EnableRaisingEvents = $true

# Event handler for new files
$action = {
    $filePath = $Event.SourceEventArgs.FullPath
    $changeType = $Event.SourceEventArgs.ChangeType
    if ($changeType -eq "Created") {
        Process-Task -FilePath $filePath
    }
}

Register-ObjectEvent -InputObject $watcher -EventName "Created" -Action $action | Out-Null

# --- Keep script running ---
try {
    while ($true) {
        Wait-Event -Timeout 1 | Out-Null
    }
} finally {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
    Write-Host ""
    Write-Host "  Watcher stopped." -ForegroundColor Yellow
}
