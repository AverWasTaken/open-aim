# Run by Install.cmd. Makes the desktop shortcut and starts AimTrainer once.
# Safe to run again: it just replaces the shortcut.
#   -ShortcutDir <folder>  put the shortcut somewhere else (default: your Desktop)
#   -NoLaunch              only make the shortcut
param(
  [string]$ShortcutDir = $env:AIM_SHORTCUT_DIR,
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent $here

try {
  if (-not $ShortcutDir) { $ShortcutDir = [Environment]::GetFolderPath('Desktop') }
  if (-not (Test-Path $ShortcutDir)) { New-Item -ItemType Directory -Path $ShortcutDir | Out-Null }
  $lnkPath = Join-Path $ShortcutDir 'AimTrainer.lnk'

  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($lnkPath)
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $here 'AimTrainer.vbs') + '"'
  $lnk.WorkingDirectory = $here
  $lnk.IconLocation = (Join-Path $root 'app\build\icon.ico') + ',0'
  $lnk.WindowStyle = 1
  $lnk.Description = "AimTrainer (runs the latest code in $root)"
  $lnk.Save()
  Write-Host ''
  Write-Host "Made the shortcut: $lnkPath"
} catch {
  Write-Host ''
  Write-Host "Could not make the desktop shortcut: $_"
  exit 1
}

if ($NoLaunch) { exit 0 }

Write-Host ''
Write-Host 'Starting AimTrainer. The first start downloads what the game needs,'
Write-Host 'so it can take a few minutes. Leave this window open.'
Write-Host 'The game opens by itself when it is ready.'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'start.ps1')
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host "AimTrainer did not start. Details: $env:LOCALAPPDATA\AimTrainer-launcher.log"
  exit 1
}
Write-Host ''
Write-Host 'Done. Next time, just double-click AimTrainer on your desktop.'
exit 0
