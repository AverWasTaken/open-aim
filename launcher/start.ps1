# Starts AimTrainer from this folder, so it always runs the newest code here.
# Run by AimTrainer.vbs (no console window). Log: %LOCALAPPDATA%\AimTrainer-launcher.log
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root 'app'
$log = Join-Path $env:LOCALAPPDATA 'AimTrainer-launcher.log'
$electron = Join-Path $app 'node_modules\electron\dist\electron.exe'

function Log($msg) { "$(Get-Date -Format s)  $msg" | Out-File -FilePath $log -Append -Encoding utf8 }
# Run a program, append its output to the log, return its exit code.
# (Stderr lines like npm warnings must not count as script errors.)
function Run($exe) {
  $ErrorActionPreference = 'Continue'
  & $exe @args 2>&1 | ForEach-Object { "$_" } | Out-File -FilePath $log -Append -Encoding utf8
  return $LASTEXITCODE
}

try {
  Set-Location $app
  Log "launch from $root"

  # Get the newest code from the GitHub fork (origin). Skipped when offline,
  # on another branch, or when there are uncommitted edits. Never blocks the start.
  try {
    $git = (Get-Command git -ErrorAction SilentlyContinue).Source
    if ($git) {
      $branch = & $git -C $root rev-parse --abbrev-ref HEAD
      $dirty = & $git -C $root status --porcelain --untracked-files=no
      if ($branch -eq 'personal-improvements' -and -not $dirty) {
        $env:GIT_TERMINAL_PROMPT = '0'
        $out = Join-Path $env:TEMP 'aimtrainer-git-pull.txt'
        $p = Start-Process -FilePath $git -NoNewWindow -PassThru `
          -ArgumentList '-C', ('"' + $root + '"'), 'pull', '--ff-only', 'origin', 'personal-improvements' `
          -RedirectStandardOutput $out -RedirectStandardError "$out.err"
        $null = $p.Handle  # needed so ExitCode is filled in
        if ($p.WaitForExit(20000)) {
          Log "git pull exit $($p.ExitCode): $((Get-Content $out, "$out.err" -ErrorAction SilentlyContinue) -join ' | ')"
        } else {
          $p.Kill()
          Log 'git pull timed out, starting anyway'
        }
      } else {
        Log "git pull skipped (branch $branch, local edits: $([bool]$dirty))"
      }
    }
  } catch { Log "git pull skipped: $_" }

  # Reinstall dependencies only when package-lock.json changed (or they are missing).
  $stamp = Join-Path $app 'node_modules\.launcher-lock-hash'
  $hash = (Get-FileHash (Join-Path $app 'package-lock.json')).Hash
  $saved = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { '' }
  if (-not (Test-Path $electron) -or $saved -ne $hash) {
    # npm ci installs exactly what package-lock.json lists and never rewrites it,
    # so the folder stays clean and the git pull above keeps working.
    Log "installing dependencies"
    $code = Run 'npm.cmd' ci --no-audit --no-fund
    if ($code -ne 0) {
      Log "npm ci failed (exit $code), trying npm install"
      # npm install may rewrite package-lock.json; put the original bytes back.
      $lockFile = Join-Path $app 'package-lock.json'
      $lockBytes = [IO.File]::ReadAllBytes($lockFile)
      $code = Run 'npm.cmd' install --no-audit --no-fund
      [IO.File]::WriteAllBytes($lockFile, $lockBytes)
    }
    if ($code -ne 0) { throw "npm install failed (exit $code)" }
    if (-not (Test-Path $electron)) {
      $code = Run 'node' (Join-Path $app 'node_modules\electron\install.js')
      if ($code -ne 0) { throw "electron download failed (exit $code)" }
    }
    Set-Content -Path $stamp -Value $hash -Encoding ascii
  }

  # Rebuild the drill list from scenarios/ (same as `npm start` does).
  $code = Run 'node' (Join-Path $root 'scripts\build-scenarios.mjs')
  if ($code -ne 0) { throw "building drills failed (exit $code)" }

  Start-Process -FilePath $electron -ArgumentList ('"' + $app + '"') -WorkingDirectory $app
  Log "started"
} catch {
  Log "ERROR: $_"
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("AimTrainer could not start:`n`n$_`n`nDetails: $log", 'AimTrainer') | Out-Null
  exit 1
}
