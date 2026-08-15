import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const DIRECTORY_CUSTODY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'recovery directory custody is Windows-only' }
$path = $env:OPENSPHERE_RECOVERY_DIRECTORY
$mode = $env:OPENSPHERE_RECOVERY_DIRECTORY_MODE
if ([string]::IsNullOrWhiteSpace($path) -or $mode -notin @('Ensure','Assert')) {
  throw 'recovery directory custody requires env-only path and mode'
}
if ($mode -eq 'Ensure') {
  if (-not (Test-Path -LiteralPath $path)) {
    [void](New-Item -ItemType Directory -Path $path)
  }
  $item = Get-Item -LiteralPath $path
  if (-not $item.PSIsContainer -or
      (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'recovery custody path must be a non-reparse directory'
  }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
}
$resolved = (Resolve-Path -LiteralPath $path).Path
$item = Get-Item -LiteralPath $resolved
if (-not $item.PSIsContainer -or
    (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
  throw 'recovery custody path must be a non-reparse directory'
}
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $resolved
$ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier])
$rules = @($acl.Access)
if ($ownerSid -ne $currentSid -or -not $acl.AreAccessRulesProtected -or $rules.Count -ne 1) {
  throw 'recovery directory ACL must disable inheritance and contain one rule'
}
$rule = $rules[0]
$ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier])
$full = [Security.AccessControl.FileSystemRights]::FullControl
if ($ruleSid -ne $currentSid -or $rule.IsInherited -or
    $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
    $rule.FileSystemRights -ne $full -or
    $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' -or
    $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
  throw 'recovery directory ACL is not current-user-only full-control custody'
}
[ordered]@{
  contract = 'opensphere.installation-lock.recovery-directory-custody/v1'
  resolvedPath = $resolved
  currentUserSid = [string]$currentSid.Value
  ownerSid = [string]$ownerSid.Value
  inheritanceDisabled = [bool]$acl.AreAccessRulesProtected
  ruleCount = [int]$rules.Count
  inheritanceFlags = [string]$rule.InheritanceFlags
  propagationFlags = [string]$rule.PropagationFlags
} | ConvertTo-Json -Compress
`;

function invoke(path, mode, execFileSyncFn = execFileSync) {
  if (process.platform !== 'win32') {
    throw new Error('installation-lock recovery directory custody is Windows-only');
  }
  const absolute = resolve(path);
  const encoded = Buffer.from(DIRECTORY_CUSTODY_SCRIPT, 'utf16le').toString('base64');
  const output = execFileSyncFn('pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENSPHERE_RECOVERY_DIRECTORY: absolute,
      OPENSPHERE_RECOVERY_DIRECTORY_MODE: mode,
    },
  });
  let result;
  try { result = JSON.parse(output); }
  catch { throw new Error('recovery directory custody returned invalid JSON'); }
  if (Object.keys(result).sort().join(',')
        !== ['contract', 'currentUserSid', 'inheritanceDisabled', 'inheritanceFlags', 'ownerSid',
          'propagationFlags', 'resolvedPath', 'ruleCount'].sort().join(',')
      || result.contract !== 'opensphere.installation-lock.recovery-directory-custody/v1'
      || resolve(result.resolvedPath) !== absolute
      || typeof result.currentUserSid !== 'string' || result.currentUserSid.length < 4
      || result.ownerSid !== result.currentUserSid
      || result.inheritanceDisabled !== true || result.ruleCount !== 1
      || result.inheritanceFlags !== 'ContainerInherit, ObjectInherit'
      || result.propagationFlags !== 'None') {
    throw new Error('recovery directory custody result is non-canonical');
  }
  return result;
}

export function ensureInstallationLockRecoveryPrivateDirectory(path, options = {}) {
  return invoke(path, 'Ensure', options.execFileSyncFn);
}

export function assertInstallationLockRecoveryPrivateDirectory(path, options = {}) {
  return invoke(path, 'Assert', options.execFileSyncFn);
}
