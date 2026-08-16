#requires -Version 7.2
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($env:OPENSPHERE_RECOVERY_KEY_PATH)) {
  throw 'recovery approval key path must be supplied only through OPENSPHERE_RECOVERY_KEY_PATH'
}
$Path = $env:OPENSPHERE_RECOVERY_KEY_PATH

if ($env:OS -ne 'Windows_NT') {
  throw 'installation-lock recovery approval signing is restricted to the Windows Docker Desktop host'
}
$resolved = (Resolve-Path -LiteralPath $Path).Path
$keyRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.opensphere\keys')).TrimEnd('\') + '\'
if (-not ([IO.Path]::GetFullPath($resolved).StartsWith($keyRoot, [StringComparison]::OrdinalIgnoreCase))) {
  throw 'recovery approval key must remain under the current user .opensphere/keys directory'
}
if (([IO.File]::GetAttributes($resolved) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'recovery approval key must not be a reparse point'
}
$item = Get-Item -LiteralPath $resolved
if ($item.PSIsContainer) { throw 'recovery approval key must be a regular file' }
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $resolved
$ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier])
if ($ownerSid -ne $currentSid -or -not $acl.AreAccessRulesProtected) {
  throw 'recovery approval key ACL inheritance must be disabled'
}
$currentAllow = $false
foreach ($rule in @($acl.Access)) {
  $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier])
  if ($sid -ne $currentSid -or
      $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
    throw 'recovery approval key ACL is not current-user-only'
  }
  if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -ne 0) {
    $currentAllow = $true
  }
}
if (-not $currentAllow) { throw 'recovery approval key is not readable by the current user' }

[ordered]@{
  contract = 'opensphere.installation-lock.recovery-key-boundary/v1'
  keyId = 'opensphere-edge-local-v1'
  resolvedPath = $resolved
  currentUserSid = [string]$currentSid.Value
} | ConvertTo-Json -Compress
