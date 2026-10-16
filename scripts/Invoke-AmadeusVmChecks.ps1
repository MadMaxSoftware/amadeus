# Runs sandbox-safe Amadeus VM checks without Node realpath on the script path.
param(
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
)
$ErrorActionPreference = "Stop"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { "C:\Program Files\nodejs\node.exe" }
$scriptPath = Join-Path $RepoRoot "scripts\run-amadeus-vm-checks.mjs"
$bytes = [System.IO.File]::ReadAllBytes($scriptPath)
$b64 = [Convert]::ToBase64String($bytes)
$env:AMADEUS_VM_ROOT = $RepoRoot
& $node --experimental-vm-modules --input-type=module -e "await import('data:text/javascript;base64,$b64')"
exit $LASTEXITCODE
