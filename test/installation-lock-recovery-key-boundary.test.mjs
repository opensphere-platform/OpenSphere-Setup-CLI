import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  assertInstallationLockRecoveryPrivateDirectory,
  ensureInstallationLockRecoveryPrivateDirectory,
} from '../src/installation-lock-recovery-windows-custody.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const helper = join(repositoryRoot, 'scripts', 'Assert-InstallationLockRecoverySigningKey.ps1');
const prepareModule = join(repositoryRoot, 'src', 'installation-lock-recovery-prepare.mjs');

function invoke(path, userProfile) {
  const helperBytes = readFileSync(helper);
  const encoded = Buffer.from(helperBytes.toString('utf8'), 'utf16le').toString('base64');
  return execFileSync('pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], {
    encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env,
      USERPROFILE: userProfile,
      OPENSPHERE_RECOVERY_KEY_PATH: path,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function protect(path, userProfile) {
  const script = '$ErrorActionPreference="Stop";'
    + '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;'
    + '$acl=[Security.AccessControl.FileSecurity]::new();'
    + '$acl.SetOwner($sid);'
    + '$acl.SetAccessRuleProtection($true,$false);'
    + '$rights=[Security.AccessControl.FileSystemRights]::Read -bor '
    + '[Security.AccessControl.FileSystemRights]::Write;'
    + '$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,'
    + '[Security.AccessControl.AccessControlType]::Allow);'
    + '$acl.AddAccessRule($rule);Set-Acl -LiteralPath $env:RECOVERY_TEST_KEY -AclObject $acl';
  execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, USERPROFILE: userProfile, RECOVERY_TEST_KEY: path },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function mutateDirectoryAcl(path, mode) {
  const script = String.raw`
$ErrorActionPreference='Stop'
$path=$env:RECOVERY_TEST_DIRECTORY
$mode=$env:RECOVERY_TEST_ACL_MODE
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User
if ($mode -eq 'Propagation') {
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  $rule=[Security.AccessControl.FileSystemAccessRule]::new(
    $current,[Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
    [Security.AccessControl.PropagationFlags]::NoPropagateInherit,
    [Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($path),$acl)
} elseif ($mode -eq 'Broaden') {
  & icacls.exe $path /grant '*S-1-5-32-545:(RX)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls ACL mutation failed' }
} else { throw 'unknown ACL mutation' }
$after=Get-Acl -LiteralPath $path
@($after.Access | ForEach-Object {
  [ordered]@{sid=[string]$_.IdentityReference;rights=[string]$_.FileSystemRights;
    inheritance=[string]$_.InheritanceFlags;propagation=[string]$_.PropagationFlags;
    inherited=[bool]$_.IsInherited}
}) | ConvertTo-Json -Compress
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, RECOVERY_TEST_DIRECTORY: path, RECOVERY_TEST_ACL_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function readDirectoryOwner(path) {
  const script = String.raw`
$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:RECOVERY_TEST_DIRECTORY
$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier])
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User
[ordered]@{owner=[string]$owner.Value;current=[string]$current.Value}|ConvertTo-Json -Compress
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return JSON.parse(execFileSync('pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, RECOVERY_TEST_DIRECTORY: path },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

test('Windows recovery key helper enforces current-user-only .opensphere/keys custody', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only edge key custody');
  const root = await mkdtemp(join(tmpdir(), 'opensphere-recovery-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyRoot = join(root, '.opensphere', 'keys');
  const helperSource = readFileSync(helper, 'utf8');
  const prepareSource = readFileSync(prepareModule, 'utf8');
  assert.match(helperSource, /OPENSPHERE_RECOVERY_KEY_PATH/u);
  assert.doesNotMatch(helperSource, /Parameter\(Mandatory\).*\$Path/u);
  assert.match(prepareSource, /'-EncodedCommand', encodedCommand/u);
  assert.match(prepareSource, /OPENSPHERE_RECOVERY_KEY_PATH: resolve\(keyPath\)/u);
  assert.doesNotMatch(prepareSource, /'-File', helperPath/u);
  await mkdir(keyRoot, { recursive: true });
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
    .export({ format: 'pem', type: 'pkcs8' });
  const keyPath = join(keyRoot, 'edge-local-v1-p256.pem');
  await writeFile(keyPath, key);
  protect(keyPath, root);
  const result = JSON.parse(invoke(keyPath, root));
  assert.equal(result.contract, 'opensphere.installation-lock.recovery-key-boundary/v1');
  assert.equal(result.keyId, 'opensphere-edge-local-v1');

  const outside = join(root, 'outside.pem');
  await writeFile(outside, key);
  protect(outside, root);
  assert.throws(() => invoke(outside, root), /Command failed/u);

  const inherited = join(keyRoot, 'inherited.pem');
  await writeFile(inherited, key);
  assert.throws(() => invoke(inherited, root), /Command failed/u);
});

test('Windows recovery directories disable inheritance and retain one current-user rule', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only recovery directory custody');
  const root = await mkdtemp(join(tmpdir(), 'opensphere-recovery-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'external-receipts');
  await mkdir(directory);
  assert.throws(() => assertInstallationLockRecoveryPrivateDirectory(directory), /Command failed/u);
  const ensured = ensureInstallationLockRecoveryPrivateDirectory(directory);
  assert.equal(ensured.inheritanceDisabled, true);
  assert.equal(ensured.ruleCount, 1);
  assert.deepEqual(assertInstallationLockRecoveryPrivateDirectory(directory), ensured);
  const systemRoot = process.env.SystemRoot;
  assert.equal(typeof systemRoot, 'string');
  const foreignOwner = readDirectoryOwner(systemRoot);
  assert.notEqual(foreignOwner.owner, foreignOwner.current);
  assert.throws(() => assertInstallationLockRecoveryPrivateDirectory(systemRoot), /Command failed/u);
  for (const mode of ['Propagation', 'Broaden']) {
    const candidate = join(root, `external-${mode.toLowerCase()}`);
    await mkdir(candidate);
    ensureInstallationLockRecoveryPrivateDirectory(candidate);
    const mutated = mutateDirectoryAcl(candidate, mode);
    assert.ok(Array.isArray(mutated), `${mode} ACL projection must be an array`);
    assert.throws(() => assertInstallationLockRecoveryPrivateDirectory(candidate), /Command failed/u,
      `${mode}: ${JSON.stringify(mutated)}`);
  }
});
