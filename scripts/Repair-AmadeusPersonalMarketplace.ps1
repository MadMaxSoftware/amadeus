# Migrates a live personal marketplace Amadeus entry from absolute host paths
# (for example a private setup-tree plugin-source path) to supported relative
# in-root path "./.agents/plugins/amadeus" under the personal marketplace root.
# Preserves unrelated marketplace plugins. Does not publish remotely.
[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent),
  [string]$AgentsHome = (Join-Path $env:USERPROFILE ".agents"),
  [string]$PluginSource = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

if (-not $PluginSource) {
  foreach ($candidate in @(
      (Join-Path $RepoRoot "plugin-source\amadeus"),
      (Join-Path $RepoRoot "plugins\amadeus"),
      (Join-Path $RepoRoot "public-release\plugins\amadeus")
    )) {
    if (Test-Path (Join-Path $candidate ".codex-plugin\plugin.json")) {
      $PluginSource = $candidate
      break
    }
  }
}
if (-not $PluginSource) { throw "Amadeus plugin source not found under $RepoRoot" }

$marketDir = Join-Path $AgentsHome "plugins"
$marketFile = Join-Path $marketDir "marketplace.json"
$pluginDir = Join-Path $marketDir "amadeus"
$handoff = Join-Path $RepoRoot "verification\origin-host-marketplace-repair\marketplace.json"

if (-not (Test-Path $marketFile)) {
  throw "Personal marketplace not found at $marketFile"
}

$raw = Get-Content -LiteralPath $marketFile -Raw
$market = $raw | ConvertFrom-Json
$before = @($market.plugins | ForEach-Object { [pscustomobject]@{ name = $_.name; path = $_.source.path } })
$amadeus = @($market.plugins | Where-Object { $_.name -eq "amadeus" })
if ($amadeus.Count -eq 0) { throw "Amadeus entry missing from personal marketplace" }
$oldPath = [string]$amadeus[0].source.path
$needsRepair = -not ($oldPath -eq "./.agents/plugins/amadeus" -or $oldPath -eq ".\\.agents\\plugins\\amadeus")

$desired = Get-Content -LiteralPath $handoff -Raw | ConvertFrom-Json
# Preserve unrelated plugins from the live marketplace.
$others = @($market.plugins | Where-Object { $_.name -ne "amadeus" })
$merged = [ordered]@{
  name = if ($market.name) { $market.name } else { "amadeus-personal" }
  interface = if ($market.interface) { $market.interface } else { $desired.interface }
  plugins = @($others + $desired.plugins[0])
}
$json = ($merged | ConvertTo-Json -Depth 8) + [Environment]::NewLine

$result = [ordered]@{
  ok = $false
  marketFile = $marketFile
  before = $before
  oldAmadeusPath = $oldPath
  needsRepair = $needsRepair
  targetPath = "./.agents/plugins/amadeus"
  dryRun = [bool]$DryRun
  wrote = $false
  copiedPlugin = $false
  error = $null
}

if ($DryRun) {
  $result.ok = $true
  $result.note = "Dry run only; no files changed. Re-run without -DryRun on the origin host outside the Cursor sandbox."
  Write-Output ($result | ConvertTo-Json -Depth 6)
  exit 0
}

try {
  New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
  Copy-Item -Recurse -Force (Join-Path $PluginSource "*") $pluginDir
  $result.copiedPlugin = $true
  [System.IO.File]::WriteAllText($marketFile, $json)
  $result.wrote = $true
  $verify = Get-Content -LiteralPath $marketFile -Raw | ConvertFrom-Json
  $path = ($verify.plugins | Where-Object { $_.name -eq "amadeus" }).source.path
  if ($path -ne "./.agents/plugins/amadeus") { throw "Post-repair path is '$path', expected ./.agents/plugins/amadeus" }
  $result.ok = $true
  $result.afterPath = $path
} catch {
  $result.error = $_.Exception.Message
  $fallback = Join-Path $RepoRoot "verification\origin-host-marketplace-repair\marketplace.applied-pending.json"
  [System.IO.File]::WriteAllText($fallback, $json)
  $result.fallback = $fallback
  $result.ok = $false
}

Write-Output ($result | ConvertTo-Json -Depth 6)
if (-not $result.ok) { exit 2 }
