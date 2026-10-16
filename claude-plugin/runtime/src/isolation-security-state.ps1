[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('codex', 'cursor', 'claude')]
    [string]$Adapter,
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [Parameter(Mandatory = $true)]
    [string]$PathsJson
)

$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
$paths = @(foreach ($item in ($PathsJson | ConvertFrom-Json)) { [string]$item })
if ($paths.Count -eq 0) { throw 'At least one security boundary path is required' }
$entries = foreach ($path in @($paths | Sort-Object -Unique)) {
    try { $fullPath = [IO.Path]::GetFullPath([string]$path) }
    catch { throw "Invalid security boundary path '$path': $($_.Exception.Message)" }
    if (Test-Path -LiteralPath $fullPath) {
        $resolved = (Resolve-Path -LiteralPath $fullPath).Path
        $acl = Get-Acl -LiteralPath $resolved
        [ordered]@{ path = $resolved; exists = $true; owner = [string]$acl.Owner; sddl = [string]$acl.Sddl }
    } else {
        [ordered]@{ path = $fullPath; exists = $false; owner = $null; sddl = $null }
    }
}
$canonical = [ordered]@{
    schemaVersion = 1
    adapter = $Adapter
    workspace = $workspacePath
    identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    entries = @($entries)
} | ConvertTo-Json -Depth 6 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
$sha256 = [Security.Cryptography.SHA256]::Create()
try { $fingerprint = ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '') }
finally { $sha256.Dispose() }
[ordered]@{
    schemaVersion = 1
    adapter = $Adapter
    workspace = $workspacePath
    fingerprintSha256 = $fingerprint
} | ConvertTo-Json -Depth 4 -Compress
