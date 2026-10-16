# Origin-host / friend-host activation for Amadeus - Local AI Orchestrator.
# - Keeps the checkout marketplace on supported relative in-root paths
# - Mirrors the plugin under the personal marketplace root so Codex can resolve
#   relative "./.agents/plugins/amadeus" paths from the personal marketplace root
# - Installs the versioned Codex cache layout and enables amadeus@amadeus-personal
# Does not publish remotely or remove unrelated plugins/marketplace entries.
[CmdletBinding()]
param(
  [string]$RepoRoot = "",
  [string]$PluginSource = "",
  [string]$Version = "0.4.0",
  [string]$CodexHome = "",
  [string]$AgentsHome = "",
  [switch]$SimulateOnly
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = Split-Path $PSScriptRoot -Parent
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

if (-not $PluginSource) {
  foreach ($candidate in @(
      (Join-Path $RepoRoot "plugins\amadeus"),
      (Join-Path $RepoRoot "plugin-source\amadeus"),
      (Join-Path $RepoRoot "public-release\plugins\amadeus")
    )) {
    if (Test-Path (Join-Path $candidate ".codex-plugin\plugin.json")) {
      $PluginSource = $candidate
      break
    }
  }
}
if (-not $PluginSource -or -not (Test-Path (Join-Path $PluginSource ".codex-plugin\plugin.json"))) {
  throw "Amadeus plugin source not found under $RepoRoot"
}
$PluginSource = [System.IO.Path]::GetFullPath($PluginSource)

if (-not $AgentsHome) {
  $AgentsHome = if ($SimulateOnly) {
    Join-Path $RepoRoot "verification\fake-home\.agents"
  } else {
    Join-Path $env:USERPROFILE ".agents"
  }
}
if (-not $CodexHome) {
  $CodexHome = if ($SimulateOnly) {
    Join-Path $RepoRoot "verification\fake-home\.codex"
  } else {
    Join-Path $env:USERPROFILE ".codex"
  }
}

function Write-Marketplace([string]$MarketFile, [string]$RelativePluginPath, [string]$MarketName) {
  $dir = Split-Path $MarketFile -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $existingPlugins = @()
  if (Test-Path $MarketFile) {
    try {
      $existing = Get-Content -LiteralPath $MarketFile -Raw | ConvertFrom-Json
      if ($existing.plugins) {
        $amadeusExisting = @($existing.plugins | Where-Object { $_.name -eq "amadeus" })
        if ($amadeusExisting.Count -eq 1 -and $amadeusExisting[0].source.path -eq $RelativePluginPath -and $amadeusExisting[0].policy.installation -eq "INSTALLED_BY_DEFAULT") {
          # Already correct; avoid rewriting ACL-locked in-repo marketplace files.
          return
        }
        $existingPlugins = @($existing.plugins | Where-Object { $_.name -ne "amadeus" })
      }
    } catch {
      $existingPlugins = @()
    }
  }
  $amadeusEntry = [ordered]@{
    name = "amadeus"
    source = [ordered]@{ source = "local"; path = $RelativePluginPath }
    policy = [ordered]@{ installation = "INSTALLED_BY_DEFAULT"; authentication = "ON_INSTALL" }
    category = "Productivity"
  }
  $marketplace = [ordered]@{
    name = $MarketName
    interface = [ordered]@{ displayName = "Amadeus - Local AI Orchestrator" }
    plugins = @($existingPlugins + $amadeusEntry)
  }
  $json = ($marketplace | ConvertTo-Json -Depth 8)
  try {
    [System.IO.File]::WriteAllText($MarketFile, $json + [Environment]::NewLine)
  } catch {
    $fallback = Join-Path $RepoRoot "verification\marketplace-write-fallback\marketplace.json"
    New-Item -ItemType Directory -Force -Path (Split-Path $fallback) | Out-Null
    [System.IO.File]::WriteAllText($fallback, $json + [Environment]::NewLine)
    Write-Warning "Could not write $MarketFile ($($_.Exception.Message)); wrote fallback $fallback"
  }
}

# 1) In-repo marketplace: relative in-root path only.
$inRepoRelative = if (Test-Path (Join-Path $RepoRoot "plugins\amadeus\.codex-plugin\plugin.json")) {
  "./plugins/amadeus"
} else {
  "./plugin-source/amadeus"
}
$inRepoMarketFile = Join-Path $RepoRoot ".agents\plugins\marketplace.json"
Write-Marketplace -MarketFile $inRepoMarketFile -RelativePluginPath $inRepoRelative -MarketName "amadeus-personal"

# 2) Personal marketplace root is the user profile; copy under .agents/plugins.
$personalMarketDir = Join-Path $AgentsHome "plugins"
$personalPlugin = Join-Path $personalMarketDir "amadeus"
New-Item -ItemType Directory -Force -Path $personalMarketDir | Out-Null
New-Item -ItemType Directory -Force -Path $personalPlugin | Out-Null
# Refresh in place so ACL-locked destination trees still receive updated files.
Copy-Item -Recurse -Force (Join-Path $PluginSource "*") $personalPlugin
$personalMarketFile = Join-Path $personalMarketDir "marketplace.json"
Write-Marketplace -MarketFile $personalMarketFile -RelativePluginPath "./.agents/plugins/amadeus" -MarketName "amadeus-personal"

# 3) Codex versioned cache layout (current Codex behavior)
$cacheRoot = Join-Path $CodexHome "plugins\cache\personal\amadeus\$Version"
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
Copy-Item -Recurse -Force (Join-Path $PluginSource "*") $cacheRoot

$pluginJson = Get-Content -LiteralPath (Join-Path $cacheRoot ".codex-plugin\plugin.json") -Raw | ConvertFrom-Json
if ($pluginJson.name -ne "amadeus") { throw "Installed copy plugin name mismatch" }
if ($pluginJson.author.name -ne "Mad Max Systems") { throw "Installed copy publisher mismatch" }
if ($pluginJson.interface.displayName -ne "Amadeus") { throw "Installed copy displayName mismatch" }
if ($pluginJson.interface.shortDescription -ne "Local AI Orchestrator") { throw "Installed copy descriptor mismatch" }

# 4) Explicitly enable Amadeus in user configuration; do not strip unrelated keys.
$configPath = Join-Path $CodexHome "config.toml"
New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
$enableBlock = @"
[plugins."amadeus@amadeus-personal"]
enabled = true
"@
if (Test-Path $configPath) {
  $existing = Get-Content -LiteralPath $configPath -Raw
  if ($existing -notmatch '\[plugins\."amadeus@amadeus-personal"\]') {
    Add-Content -LiteralPath $configPath -Value "`n$enableBlock`n" -Encoding utf8
  } elseif ($existing -match '\[plugins\."amadeus@amadeus-personal"\][\s\S]*?enabled\s*=\s*false') {
    $updated = [regex]::Replace($existing, '(?s)(\[plugins\."amadeus@amadeus-personal"\][\s\S]*?enabled\s*=\s*)false', '${1}true')
    Set-Content -LiteralPath $configPath -Value $updated -Encoding utf8
  }
} else {
  [System.IO.File]::WriteAllText($configPath, "$enableBlock`n")
}

$personalMarket = Get-Content -LiteralPath $personalMarketFile -Raw | ConvertFrom-Json
if ($personalMarket.plugins | Where-Object { $_.name -eq "amadeus" -and $_.source.path -ne "./.agents/plugins/amadeus" }) {
  throw "Personal marketplace Amadeus path must be relative ./.agents/plugins/amadeus"
}
$inRepoMarket = Get-Content -LiteralPath $inRepoMarketFile -Raw | ConvertFrom-Json
$inRepoPath = ($inRepoMarket.plugins | Where-Object { $_.name -eq "amadeus" }).source.path
if ($inRepoPath -notmatch '^\./') {
  throw "In-repo marketplace path must be relative"
}

Write-Output (@{
  ok = $true
  marketplaceInRepo = $inRepoMarketFile
  marketplaceInRepoPath = $inRepoPath
  marketplacePersonal = $personalMarketFile
  marketplacePersonalPath = "./.agents/plugins/amadeus"
  installedCopy = $cacheRoot
  personalMarketplacePlugin = $personalPlugin
  plugin = $pluginJson.name
  version = $pluginJson.version
  displayName = $pluginJson.interface.displayName
  descriptor = $pluginJson.interface.shortDescription
  publisher = $pluginJson.author.name
  policy = "INSTALLED_BY_DEFAULT"
  enabledInUserConfig = $true
  userConfig = $configPath
  simulateOnly = [bool]$SimulateOnly
  desktopUiRefreshVerified = $false
  note = "Restart Codex / ChatGPT desktop before claiming the UI lists Amadeus."
} | ConvertTo-Json -Depth 6)
