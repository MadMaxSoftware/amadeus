param([Parameter(Mandatory=$true)][string]$Adapter,
      [Parameter(Mandatory=$true)][string]$Workspace,
      [Parameter(Mandatory=$true)][string]$PathsJson)
$ErrorActionPreference = 'Stop'
$boundaries = @($PathsJson | ConvertFrom-Json)
$entries = @()
foreach ($boundary in $boundaries) {
    # Exact declared security boundaries only; never enumerate drives or files.
    try {
        if (-not (Test-Path -LiteralPath $boundary)) {
            $entries += [ordered]@{ path = $boundary; missing = $true }
            continue
        }
        $item = Get-Item -Force -LiteralPath $boundary -ErrorAction Stop
        $acl = Get-Acl -LiteralPath $boundary -ErrorAction Stop
        $entries += [ordered]@{ path = $boundary; owner = $acl.Owner; sddl = $acl.Sddl;
            attributes = [string]$item.Attributes; target = @($item.Target) }
    } catch [System.Management.Automation.ItemNotFoundException] {
        # Optional credential boundaries may disappear between Test-Path and Get-Item.
        # Record that race as a missing boundary while still failing closed for access errors.
        $entries += [ordered]@{ path = $boundary; missing = $true }
    }
}
$bytes = [System.Text.Encoding]::UTF8.GetBytes(($entries | ConvertTo-Json -Depth 8 -Compress))
$hasher = [System.Security.Cryptography.SHA256]::Create()
try { $fingerprint = ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '') }
finally { $hasher.Dispose() }
[ordered]@{ schemaVersion=1; adapter=$Adapter; workspace=[System.IO.Path]::GetFullPath($Workspace); fingerprintSha256=$fingerprint } | ConvertTo-Json -Compress
