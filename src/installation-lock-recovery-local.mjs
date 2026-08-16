import {
  lstat, mkdir, open, readFile, realpath,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  canonicalJson,
  INSTALLATION_LOCK_RECOVERY_STALE_QUARANTINE_CONTRACT,
  sha256,
} from './installation-lock-recovery.mjs';
import {
  assertInstallationLockRecoveryPrivateDirectory,
  ensureInstallationLockRecoveryPrivateDirectory,
} from './installation-lock-recovery-windows-custody.mjs';

export const INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION =
  'QUARANTINE-STALE-INSTALLATION-LOCK';
export const INSTALLATION_LOCK_STALE_QUARANTINE_INTENT_CONTRACT =
  'opensphere.installation-lock.stale-quarantine-intent/v1';

export const REVIEWED_STALE_INSTALLATION_LOCK = Object.freeze({
  path: '.codex-deploy/current-installation-lock.json',
  fileType: 'RegularFile',
  size: 4654,
  sha256: 'sha256:a74e679607070e8ceab782c11ea0d2317cd8261d9e1fbf0d77dccf139ec75bc1',
  releaseDigest: 'sha256:0a580e9e212f15018a84fd8d227a3dbdbb4b4a274ba7b6bd009861ad63d4d9d4',
  sourceRevision: '4f77114125bde4ad5fcb0478ce8168684d66209f',
});

const ATOMIC_NO_REPLACE_MOVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'atomic stale quarantine move is Windows-only' }
if ([string]::IsNullOrWhiteSpace($env:OPENSPHERE_RECOVERY_MOVE_SOURCE) -or
    [string]::IsNullOrWhiteSpace($env:OPENSPHERE_RECOVERY_MOVE_DESTINATION)) {
  throw 'atomic stale quarantine move requires env-only source and destination'
}
[System.IO.File]::Move(
  $env:OPENSPHERE_RECOVERY_MOVE_SOURCE,
  $env:OPENSPHERE_RECOVERY_MOVE_DESTINATION,
  $false
)
`;

export function atomicNoReplaceMove(source, destination, execFileSyncFn = execFileSync) {
  const encoded = Buffer.from(ATOMIC_NO_REPLACE_MOVE_SCRIPT, 'utf16le').toString('base64');
  execFileSyncFn('pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENSPHERE_RECOVERY_MOVE_SOURCE: resolve(source),
      OPENSPHERE_RECOVERY_MOVE_DESTINATION: resolve(destination),
    },
  });
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`${label} keys are not canonical`);
  }
  return value;
}

function uuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    .test(value ?? '')) throw new Error(`${label} is invalid`);
  return value;
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return resolve(value);
}

function outside(root, candidate, label) {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`${label} must be outside the source repository`);
  }
}

async function regularFile(path, label) {
  await assertNoSymlinkParents(path, label);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (Number.isInteger(stat.nlink) && stat.nlink !== 1) {
    throw new Error(`${label} must not have hard-link ambiguity`);
  }
  return stat;
}

async function assertNoSymlinkParents(path, label) {
  const chain = [];
  let cursor = resolve(path);
  while (true) {
    chain.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const candidate of chain.reverse()) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error(`${label} parent path must not be a symlink or junction`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function absent(path, label) {
  try {
    await lstat(path);
    throw new Error(`${label} must be absent: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function parseJson(bytes, label) {
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error(`${label} is invalid JSON`); }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync().catch((error) => {
      if (!['EINVAL', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
    });
  } finally { await handle.close(); }
}

async function writeExclusive(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

function validateReviewedStaleLock(bytes, profile = REVIEWED_STALE_INSTALLATION_LOCK) {
  if (bytes.length !== profile.size || sha256(bytes) !== profile.sha256) {
    throw new Error('stale installation-lock bytes differ from the reviewed incident profile');
  }
  const lock = parseJson(bytes, 'stale installation-lock');
  if (lock.apiVersion !== 'release.opensphere.io/v1alpha1'
      || lock.kind !== 'OpenSphereReleaseLock'
      || lock.channel !== 'edge'
      || lock.releaseScope !== 'component'
      || canonicalJson(lock.changedComponents) !== canonicalJson(['console'])
      || lock.releaseDigest !== profile.releaseDigest
      || lock.sourceRevision !== profile.sourceRevision) {
    throw new Error('stale installation-lock identity differs from the reviewed stale cache');
  }
  return lock;
}

function validateSourceProfile(source, profile) {
  exactKeys(source, [
    'path', 'fileType', 'size', 'sha256', 'releaseDigest', 'sourceRevision',
  ], 'stale quarantine source profile');
  if (canonicalJson(source) !== canonicalJson(profile)) {
    throw new Error('stale quarantine intent does not bind the reviewed stale cache');
  }
}

export function validateStaleInstallationLockQuarantineIntent(
  intent, profile = REVIEWED_STALE_INSTALLATION_LOCK
) {
  exactKeys(intent, [
    'contract', 'operationId', 'workspaceRoot', 'receiptDirectory',
    'quarantineDirectory', 'source', 'createdAt',
  ], 'stale installation-lock quarantine intent');
  if (intent.contract !== INSTALLATION_LOCK_STALE_QUARANTINE_INTENT_CONTRACT) {
    throw new Error('stale installation-lock quarantine intent contract is invalid');
  }
  uuid(intent.operationId, 'stale quarantine operationId');
  assertAbsolute(intent.workspaceRoot, 'stale quarantine workspaceRoot');
  assertAbsolute(intent.receiptDirectory, 'stale quarantine receiptDirectory');
  assertAbsolute(intent.quarantineDirectory, 'stale quarantine directory');
  outside(intent.workspaceRoot, intent.receiptDirectory, 'recovery receipt directory');
  outside(intent.workspaceRoot, intent.quarantineDirectory, 'stale quarantine directory');
  validateSourceProfile(intent.source, profile);
  isoTimestamp(intent.createdAt, 'stale quarantine intent timestamp');
  return intent;
}

function finalJournal(intent, paths, preparedJournalSha256, completedAt) {
  return {
    contract: INSTALLATION_LOCK_RECOVERY_STALE_QUARANTINE_CONTRACT,
    operationId: intent.operationId,
    state: 'Quarantined',
    source: {
      workspaceRoot: resolve(intent.workspaceRoot),
      path: intent.source.path,
      fileType: intent.source.fileType,
      size: intent.source.size,
      sha256: intent.source.sha256,
      releaseDigest: intent.source.releaseDigest,
      sourceRevision: intent.source.sourceRevision,
    },
    quarantine: {
      directory: resolve(intent.quarantineDirectory),
      filePath: paths.filePath,
      fileType: 'RegularFile',
      size: intent.source.size,
      sha256: intent.source.sha256,
    },
    preparedJournalSha256,
    preparedAt: intent.createdAt,
    completedAt,
  };
}

function preparedJournal(intent, paths, completedAt) {
  return {
    contract: INSTALLATION_LOCK_RECOVERY_STALE_QUARANTINE_CONTRACT,
    operationId: intent.operationId,
    state: 'PreparedForQuarantine',
    source: {
      workspaceRoot: resolve(intent.workspaceRoot), path: intent.source.path,
      fileType: intent.source.fileType, size: intent.source.size, sha256: intent.source.sha256,
      releaseDigest: intent.source.releaseDigest, sourceRevision: intent.source.sourceRevision,
    },
    quarantine: {
      directory: resolve(intent.quarantineDirectory), filePath: paths.filePath,
      fileType: 'RegularFile', size: intent.source.size, sha256: intent.source.sha256,
    },
    preparedAt: intent.createdAt,
    completionTimestamp: completedAt,
  };
}

function pathsFor(intent) {
  const stem = `stale-current-installation-lock-${intent.operationId}`;
  const directory = resolve(intent.quarantineDirectory);
  return {
    sourcePath: resolve(intent.workspaceRoot, intent.source.path),
    filePath: join(directory, `${stem}.json`),
    preparedJournalPath: join(directory, `${stem}.prepared.json`),
    journalPath: join(directory, `${stem}.journal.json`),
  };
}

function localStateFromJournal(journal, journalPath, journalBytes, receiptDirectory) {
  return {
    workspaceRoot: journal.source.workspaceRoot,
    receiptDirectory: resolve(receiptDirectory),
    path: journal.source.path,
    status: 'AbsentAfterExactStaleQuarantine',
    quarantine: {
      contract: journal.contract,
      operationId: journal.operationId,
      journalPath: resolve(journalPath),
      journalSha256: sha256(journalBytes),
      filePath: journal.quarantine.filePath,
      fileType: journal.quarantine.fileType,
      fileSha256: journal.quarantine.sha256,
      size: journal.quarantine.size,
      releaseDigest: journal.source.releaseDigest,
      sourceRevision: journal.source.sourceRevision,
      completedAt: journal.completedAt,
      status: journal.state,
    },
  };
}

async function readCompletedJournal(path, intent, profile, receiptDirectory) {
  const journalStat = await regularFile(path, 'stale quarantine journal');
  const bytes = await readFile(path);
  if (journalStat.size !== bytes.length) throw new Error('stale quarantine journal changed while read');
  const journal = parseJson(bytes, 'stale quarantine journal');
  exactKeys(journal, [
    'contract', 'operationId', 'state', 'source', 'quarantine',
    'preparedJournalSha256', 'preparedAt', 'completedAt',
  ], 'stale quarantine journal');
  const paths = pathsFor(intent);
  await regularFile(paths.preparedJournalPath, 'stale quarantine preparation journal');
  const preparedBytes = await readFile(paths.preparedJournalPath);
  const expected = finalJournal(intent, paths, sha256(preparedBytes), journal.completedAt);
  if (canonicalJson(journal) !== canonicalJson(expected)) {
    throw new Error('stale quarantine journal differs from the reviewed operation');
  }
  validateSourceProfile({
    path: journal.source.path, fileType: journal.source.fileType, size: journal.source.size,
    sha256: journal.source.sha256, releaseDigest: journal.source.releaseDigest,
    sourceRevision: journal.source.sourceRevision,
  }, profile);
  await assertInstallationLockRecoveryLocalState(
    localStateFromJournal(journal, path, bytes, receiptDirectory), { profile }
  );
  return localStateFromJournal(journal, path, bytes, receiptDirectory);
}

export async function assertInstallationLockRecoveryLocalState(localState, {
  profile = REVIEWED_STALE_INSTALLATION_LOCK,
} = {}) {
  exactKeys(localState, [
    'workspaceRoot', 'receiptDirectory', 'path', 'status', 'quarantine',
  ], 'signed recovery localState');
  const q = exactKeys(localState.quarantine, [
    'contract', 'operationId', 'journalPath', 'journalSha256', 'filePath',
    'fileType', 'fileSha256', 'size', 'releaseDigest', 'sourceRevision',
    'completedAt', 'status',
  ], 'signed stale quarantine state');
  const workspace = assertAbsolute(localState.workspaceRoot, 'signed recovery workspaceRoot');
  assertAbsolute(localState.receiptDirectory, 'signed recovery receiptDirectory');
  if (localState.path !== profile.path
      || localState.status !== 'AbsentAfterExactStaleQuarantine'
      || q.contract !== INSTALLATION_LOCK_RECOVERY_STALE_QUARANTINE_CONTRACT
      || q.fileType !== 'RegularFile' || q.fileSha256 !== profile.sha256
      || q.size !== profile.size || q.releaseDigest !== profile.releaseDigest
      || q.sourceRevision !== profile.sourceRevision || q.status !== 'Quarantined') {
    throw new Error('signed recovery localState is not the exact stale quarantine boundary');
  }
  uuid(q.operationId, 'signed stale quarantine operationId');
  isoTimestamp(q.completedAt, 'signed stale quarantine completion');
  outside(workspace, q.filePath, 'stale quarantine file');
  outside(workspace, q.journalPath, 'stale quarantine journal');
  outside(workspace, localState.receiptDirectory, 'recovery receipt directory');
  await assertNoSymlinkParents(workspace, 'signed recovery workspaceRoot');
  await assertNoSymlinkParents(localState.receiptDirectory, 'signed recovery receiptDirectory');
  if (await realpath(workspace) !== workspace) {
    throw new Error('signed recovery workspaceRoot resolves through a symlink or junction');
  }
  await absent(resolve(workspace, localState.path), 'original stale installation-lock cache');
  const fileStat = await regularFile(q.filePath, 'quarantined stale installation-lock');
  const fileBytes = await readFile(q.filePath);
  if (fileStat.size !== q.size || fileBytes.length !== q.size || sha256(fileBytes) !== q.fileSha256) {
    throw new Error('quarantined stale installation-lock bytes drifted');
  }
  validateReviewedStaleLock(fileBytes, profile);
  const journalStat = await regularFile(q.journalPath, 'stale quarantine journal');
  const journalBytes = await readFile(q.journalPath);
  if (journalStat.size !== journalBytes.length || sha256(journalBytes) !== q.journalSha256) {
    throw new Error('stale quarantine journal bytes drifted');
  }
  const journal = parseJson(journalBytes, 'stale quarantine journal');
  exactKeys(journal, [
    'contract', 'operationId', 'state', 'source', 'quarantine',
    'preparedJournalSha256', 'preparedAt', 'completedAt',
  ], 'stale quarantine journal');
  exactKeys(journal.source, [
    'workspaceRoot', 'path', 'fileType', 'size', 'sha256', 'releaseDigest', 'sourceRevision',
  ], 'stale quarantine journal source');
  exactKeys(journal.quarantine, [
    'directory', 'filePath', 'fileType', 'size', 'sha256',
  ], 'stale quarantine journal destination');
  if (journal.contract !== q.contract || journal.operationId !== q.operationId
      || journal.state !== q.status || journal.source.workspaceRoot !== workspace
      || journal.source.path !== localState.path || journal.source.fileType !== q.fileType
      || journal.source.size !== q.size || journal.source.sha256 !== q.fileSha256
      || journal.source.releaseDigest !== q.releaseDigest
      || journal.source.sourceRevision !== q.sourceRevision
      || journal.quarantine.filePath !== resolve(q.filePath)
      || journal.quarantine.directory !== dirname(resolve(q.filePath))
      || journal.quarantine.fileType !== q.fileType || journal.quarantine.size !== q.size
      || journal.quarantine.sha256 !== q.fileSha256 || journal.completedAt !== q.completedAt) {
    throw new Error('stale quarantine journal does not bind the signed localState');
  }
  isoTimestamp(journal.preparedAt, 'stale quarantine preparation timestamp');
  isoTimestamp(journal.completedAt, 'stale quarantine completion timestamp');
  if (!/^sha256:[a-f0-9]{64}$/u.test(journal.preparedJournalSha256 ?? '')) {
    throw new Error('stale quarantine prepared journal digest is invalid');
  }
  const preparedPath = q.journalPath.replace(/\.journal\.json$/u, '.prepared.json');
  if (preparedPath === q.journalPath) {
    throw new Error('stale quarantine journal path is not canonical');
  }
  await regularFile(preparedPath, 'stale quarantine preparation journal');
  const preparedBytes = await readFile(preparedPath);
  if (sha256(preparedBytes) !== journal.preparedJournalSha256) {
    throw new Error('stale quarantine preparation journal bytes drifted');
  }
  const prepared = parseJson(preparedBytes, 'stale quarantine preparation journal');
  const expectedPrepared = preparedJournal({
    operationId: q.operationId,
    workspaceRoot: localState.workspaceRoot,
    quarantineDirectory: journal.quarantine.directory,
    source: {
      path: localState.path, fileType: q.fileType, size: q.size, sha256: q.fileSha256,
      releaseDigest: q.releaseDigest, sourceRevision: q.sourceRevision,
    },
    createdAt: journal.preparedAt,
  }, {
    filePath: q.filePath,
  }, journal.completedAt);
  if (canonicalJson(prepared) !== canonicalJson(expectedPrepared)) {
    throw new Error('stale quarantine preparation journal is not canonical');
  }
  return localState;
}

export async function quarantineStaleInstallationLock({
  intent,
  confirmation,
  profile = REVIEWED_STALE_INSTALLATION_LOCK,
  nowFn = () => new Date().toISOString(),
  assertIntentUnchanged = async () => {},
  renameFn = atomicNoReplaceMove,
  platform = process.platform,
  ensureDirectoryCustodyFn = ensureInstallationLockRecoveryPrivateDirectory,
  assertDirectoryCustodyFn = assertInstallationLockRecoveryPrivateDirectory,
} = {}) {
  if (confirmation !== INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION) {
    throw new Error(`stale quarantine requires --confirm ${INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION}`);
  }
  validateStaleInstallationLockQuarantineIntent(intent, profile);
  if (platform !== 'win32') {
    throw new Error('stale installation-lock quarantine is restricted to the reviewed Windows host');
  }
  await assertIntentUnchanged();
  const paths = pathsFor(intent);
  try {
    await lstat(resolve(intent.quarantineDirectory));
    await assertDirectoryCustodyFn(resolve(intent.quarantineDirectory));
    return await readCompletedJournal(paths.journalPath, intent, profile, intent.receiptDirectory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await assertNoSymlinkParents(intent.workspaceRoot, 'stale quarantine workspaceRoot');
  await assertNoSymlinkParents(intent.quarantineDirectory, 'stale quarantine directory');
  await assertNoSymlinkParents(intent.receiptDirectory, 'recovery receipt directory');
  const workspaceReal = await realpath(intent.workspaceRoot);
  if (workspaceReal !== resolve(intent.workspaceRoot)) {
    throw new Error('stale quarantine workspaceRoot resolves through a symlink or junction');
  }
  let existingPrepared;
  let existingPreparedBytes;
  try {
    await regularFile(paths.preparedJournalPath, 'stale quarantine preparation journal');
    existingPreparedBytes = await readFile(paths.preparedJournalPath);
    existingPrepared = parseJson(existingPreparedBytes, 'stale quarantine preparation journal');
    exactKeys(existingPrepared, [
      'contract', 'operationId', 'state', 'source', 'quarantine',
      'preparedAt', 'completionTimestamp',
    ], 'stale quarantine preparation journal');
    const expectedPrepared = preparedJournal(intent, paths, existingPrepared.completionTimestamp);
    if (canonicalJson(existingPrepared) !== canonicalJson(expectedPrepared)) {
      throw new Error('stale quarantine preparation journal differs from the reviewed operation');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const completionTimestamp = existingPrepared
    ? existingPrepared.completionTimestamp
    : isoTimestamp(nowFn(), 'stale quarantine completion timestamp');
  const createdQuarantineDirectory = await mkdir(
    resolve(intent.quarantineDirectory), { recursive: true, mode: 0o700 }
  );
  if (createdQuarantineDirectory) {
    await ensureDirectoryCustodyFn(resolve(intent.quarantineDirectory));
  } else {
    await assertDirectoryCustodyFn(resolve(intent.quarantineDirectory));
  }
  const quarantineReal = await realpath(intent.quarantineDirectory);
  if (quarantineReal !== resolve(intent.quarantineDirectory)) {
    throw new Error('stale quarantine directory resolves through a symlink or junction');
  }
  outside(workspaceReal, quarantineReal, 'stale quarantine directory');
  let quarantineDirectoryStat = await lstat(quarantineReal);
  const assertQuarantineDirectoryIdentity = async ({ refreshAfterOwnedWrite = false } = {}) => {
    await assertDirectoryCustodyFn(quarantineReal);
    await assertNoSymlinkParents(quarantineReal, 'stale quarantine directory');
    const current = await lstat(quarantineReal);
    if (!current.isDirectory() || current.isSymbolicLink()
        || current.dev !== quarantineDirectoryStat.dev
        || current.ino !== quarantineDirectoryStat.ino
        || (!refreshAfterOwnedWrite && current.ctimeMs !== quarantineDirectoryStat.ctimeMs)
        || await realpath(quarantineReal) !== quarantineReal) {
      throw new Error('stale quarantine directory identity changed during operation');
    }
    if (refreshAfterOwnedWrite) quarantineDirectoryStat = current;
  };

  let sourceStat;
  let sourceBytes;
  try {
    sourceStat = await regularFile(paths.sourcePath, 'stale installation-lock source');
    sourceBytes = await readFile(paths.sourcePath);
    validateReviewedStaleLock(sourceBytes, profile);
    if (sourceStat.size !== sourceBytes.length) throw new Error('stale installation-lock changed while read');
  } catch (error) {
    if (error.code !== 'ENOENT' || !existingPrepared) throw error;
  }
  await assertIntentUnchanged();

  const prepared = preparedJournal(intent, paths, completionTimestamp);
  const preparedBytes = Buffer.from(`${JSON.stringify(prepared, null, 2)}\n`, 'utf8');
  await assertQuarantineDirectoryIdentity();
  try { await writeExclusive(paths.preparedJournalPath, preparedBytes); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!Buffer.from(await readFile(paths.preparedJournalPath)).equals(preparedBytes)) {
      throw new Error('existing stale quarantine preparation journal differs');
    }
  }
  await assertQuarantineDirectoryIdentity({ refreshAfterOwnedWrite: true });

  if (sourceStat) {
    await assertIntentUnchanged();
    const finalSourceStat = await regularFile(paths.sourcePath, 'stale installation-lock source');
    const finalSourceBytes = await readFile(paths.sourcePath);
    validateReviewedStaleLock(finalSourceBytes, profile);
    if (finalSourceStat.dev !== sourceStat.dev || finalSourceStat.ino !== sourceStat.ino
        || finalSourceStat.ctimeMs !== sourceStat.ctimeMs
        || finalSourceStat.size !== sourceStat.size || finalSourceStat.mtimeMs !== sourceStat.mtimeMs) {
      throw new Error('stale installation-lock identity changed before atomic quarantine rename');
    }
    if (finalSourceStat.dev !== quarantineDirectoryStat.dev) {
      throw new Error('stale quarantine source and destination are not on the same volume');
    }
    await absent(paths.filePath, 'stale quarantine destination');
    await assertQuarantineDirectoryIdentity();
    try {
      await renameFn(paths.sourcePath, paths.filePath);
    } catch (error) {
      let sourcePresent = true;
      try { await regularFile(paths.sourcePath, 'stale installation-lock source'); }
      catch (readError) {
        if (readError.code === 'ENOENT') sourcePresent = false;
        else throw readError;
      }
      let destinationExact = false;
      try {
        const destinationBytes = await readFile(paths.filePath);
        await regularFile(paths.filePath, 'quarantined stale installation-lock');
        validateReviewedStaleLock(destinationBytes, profile);
        destinationExact = true;
      } catch (readError) {
        if (readError.code !== 'ENOENT') {
          throw new Error(`NeedsAttention: atomic quarantine destination is not the reviewed file (${readError.message})`);
        }
      }
      if (sourcePresent || !destinationExact) {
        throw new Error(`NeedsAttention: atomic quarantine rename is ambiguous (${error.message})`);
      }
    }
    await assertQuarantineDirectoryIdentity({ refreshAfterOwnedWrite: true });
  }
  await absent(paths.sourcePath, 'original stale installation-lock cache');
  const quarantined = await readFile(paths.filePath);
  await regularFile(paths.filePath, 'quarantined stale installation-lock');
  validateReviewedStaleLock(quarantined, profile);

  const journal = finalJournal(intent, paths, sha256(preparedBytes), completionTimestamp);
  const journalBytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  await assertQuarantineDirectoryIdentity();
  try { await writeExclusive(paths.journalPath, journalBytes); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!Buffer.from(await readFile(paths.journalPath)).equals(journalBytes)) {
      throw new Error('existing stale quarantine completion journal differs');
    }
  }
  await assertQuarantineDirectoryIdentity({ refreshAfterOwnedWrite: true });
  return readCompletedJournal(paths.journalPath, intent, profile, intent.receiptDirectory);
}

export async function quarantineStaleInstallationLockFromIntent({
  intentPath, confirmation, profile = REVIEWED_STALE_INSTALLATION_LOCK, nowFn,
  ensureDirectoryCustodyFn, assertDirectoryCustodyFn, renameFn, platform,
} = {}) {
  if (!intentPath) throw new Error('stale quarantine requires an immutable intent file');
  const absolute = resolve(intentPath);
  const stat = await regularFile(absolute, 'stale quarantine intent');
  const bytes = await readFile(absolute);
  const rawSha256 = sha256(bytes);
  const intent = parseJson(bytes, 'stale quarantine intent');
  const assertIntentUnchanged = async () => {
    const current = await regularFile(absolute, 'stale quarantine intent');
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs
        || current.ctimeMs !== stat.ctimeMs || current.dev !== stat.dev || current.ino !== stat.ino
        || sha256(await readFile(absolute)) !== rawSha256) {
      throw new Error('immutable stale quarantine intent changed during execution');
    }
  };
  return quarantineStaleInstallationLock({
    intent, confirmation, profile, nowFn, assertIntentUnchanged,
    ensureDirectoryCustodyFn, assertDirectoryCustodyFn, renameFn, platform,
  });
}
