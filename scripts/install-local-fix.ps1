$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'dist\win-unpacked')).Path
$installRoot = (Resolve-Path -LiteralPath 'C:\Program Files\WisperTalk').Path
$backupRoot = Join-Path $projectRoot ('local-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$installedExe = Join-Path $installRoot 'WisperTalk.exe'
if ($installRoot -ne 'C:\Program Files\WisperTalk') { throw 'Unexpected install destination' }
$newExe = Join-Path $sourceRoot 'WisperTalk.exe'
if ((Get-Item -LiteralPath $newExe).VersionInfo.ProductVersion -notmatch '^1\.3\.1') { throw 'Expected tested 1.3.1 build' }
# Complete the backup before stopping or replacing any installed file.
New-Item -ItemType Directory -Path $backupRoot | Out-Null
Get-ChildItem -LiteralPath $installRoot -Force | Copy-Item -Destination $backupRoot -Recurse -Force
function Stop-WisperTalk {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $installedExe } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 700
}
Stop-WisperTalk
try {
  Get-ChildItem -LiteralPath $sourceRoot -Force | Copy-Item -Destination $installRoot -Recurse -Force
  foreach ($relative in @('WisperTalk.exe', 'resources\app.asar')) {
    $expected = (Get-FileHash -LiteralPath (Join-Path $sourceRoot $relative)).Hash
    $actual = (Get-FileHash -LiteralPath (Join-Path $installRoot $relative)).Hash
    if ($expected -ne $actual) { throw "Installed file did not match tested build: $relative" }
  }
  $runningApp = Start-Process -FilePath $installedExe -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
  if ($runningApp.HasExited) { throw 'Updated application exited during startup' }
  [pscustomobject]@{ Version = (Get-Item -LiteralPath $installedExe).VersionInfo.ProductVersion; ProcessId = $runningApp.Id; Backup = $backupRoot } | ConvertTo-Json
} catch {
  Stop-WisperTalk
  Get-ChildItem -LiteralPath $backupRoot -Force | Copy-Item -Destination $installRoot -Recurse -Force
  Start-Process -FilePath $installedExe -WindowStyle Hidden
  throw
}
