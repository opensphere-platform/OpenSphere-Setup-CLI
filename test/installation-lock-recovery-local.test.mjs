import test from 'node:test';
import assert from 'node:assert/strict';
import {
  link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sha256 } from '../src/installation-lock-recovery.mjs';
import {
  atomicNoReplaceMove,
  assertInstallationLockRecoveryLocalState,
  INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION,
  INSTALLATION_LOCK_STALE_QUARANTINE_INTENT_CONTRACT,
  quarantineStaleInstallationLock as quarantineStaleInstallationLockImpl,
  quarantineStaleInstallationLockFromIntent as quarantineStaleInstallationLockFromIntentImpl,
  REVIEWED_STALE_INSTALLATION_LOCK,
} from '../src/installation-lock-recovery-local.mjs';

const mockCustody = {
  ensureDirectoryCustodyFn: async () => {},
  assertDirectoryCustodyFn: async () => {},
};
const windowsOnlyTest = process.platform === 'win32' ? test : test.skip;
async function recoveryTemp(prefix) {
  const testTempParent = join(tmpdir(), 'opensphere-installation-lock-recovery-tests');
  await mkdir(testTempParent, { recursive: true });
  return mkdtemp(join(await realpath(testTempParent), prefix));
}
function quarantineStaleInstallationLock(options) {
  return quarantineStaleInstallationLockImpl({ ...mockCustody, ...options });
}
function quarantineStaleInstallationLockFromIntent(options) {
  return quarantineStaleInstallationLockFromIntentImpl({ ...mockCustody, ...options });
}

function staleFixture() {
  const lock = {
    apiVersion: 'release.opensphere.io/v1alpha1',
    kind: 'OpenSphereReleaseLock',
    channel: 'edge', releaseScope: 'component', changedComponents: ['console'],
    releaseDigest: `sha256:${'1'.repeat(64)}`,
    sourceRevision: '2'.repeat(40), components: {},
  };
  const bytes = Buffer.from(`${JSON.stringify(lock)}\r\n`);
  return {
    bytes,
    profile: {
      path: '.codex-deploy/current-installation-lock.json', fileType: 'RegularFile',
      size: bytes.length, sha256: sha256(bytes), releaseDigest: lock.releaseDigest,
      sourceRevision: lock.sourceRevision,
    },
  };
}

async function layout() {
  const root = await recoveryTemp('opensphere-stale-quarantine-');
  const workspaceRoot = join(root, 'workspace');
  const quarantineDirectory = join(root, 'quarantine');
  const receiptDirectory = join(root, 'receipts');
  await mkdir(join(workspaceRoot, '.codex-deploy'), { recursive: true });
  const fixture = staleFixture();
  const sourcePath = join(workspaceRoot, fixture.profile.path);
  await writeFile(sourcePath, fixture.bytes);
  const intent = {
    contract: INSTALLATION_LOCK_STALE_QUARANTINE_INTENT_CONTRACT,
    operationId: '30000000-0000-4000-8000-000000000001',
    workspaceRoot, receiptDirectory, quarantineDirectory,
    source: fixture.profile, createdAt: '2026-08-16T02:00:00.000Z',
  };
  return { root, workspaceRoot, quarantineDirectory, receiptDirectory, sourcePath, intent, ...fixture };
}

test('reviewed stale fixture is the exact known cache and is never a recovery lock input', async () => {
  const text = await readFile(new URL(
    './fixtures/stale-current-installation-lock.base64', import.meta.url
  ), 'utf8');
  const bytes = Buffer.from(text.trim(), 'base64');
  const lock = JSON.parse(bytes.toString('utf8'));
  assert.equal(bytes.length, REVIEWED_STALE_INSTALLATION_LOCK.size);
  assert.equal(sha256(bytes), REVIEWED_STALE_INSTALLATION_LOCK.sha256);
  assert.equal(lock.releaseDigest, REVIEWED_STALE_INSTALLATION_LOCK.releaseDigest);
  assert.equal(lock.sourceRevision, REVIEWED_STALE_INSTALLATION_LOCK.sourceRevision);
  assert.notEqual(lock.releaseDigest,
    'sha256:3c39bccb079c8019b51e1d736775b9b9677a235c25584ae51f5da5d010048911');
});

test('actual Windows atomic move never overwrites an existing destination', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only atomic move contract');
  const root = await recoveryTemp('opensphere-no-replace-move-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.txt');
  const destination = join(root, 'destination.txt');
  await writeFile(source, 'SOURCE');
  await writeFile(destination, 'DESTINATION');
  assert.throws(() => atomicNoReplaceMove(source, destination), /Command failed/u);
  assert.equal(await readFile(source, 'utf8'), 'SOURCE');
  assert.equal(await readFile(destination, 'utf8'), 'DESTINATION');
});

windowsOnlyTest('explicit local operation quarantines exact bytes with no-overwrite journal and replay', async (t) => {
  const state = await layout();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const localState = await quarantineStaleInstallationLock({
    intent: state.intent, profile: state.profile,
    confirmation: INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION,
    nowFn: () => '2026-08-16T02:01:00.000Z',
  });
  assert.equal(localState.status, 'AbsentAfterExactStaleQuarantine');
  assert.equal(localState.quarantine.fileSha256, state.profile.sha256);
  await assert.rejects(readFile(state.sourcePath), { code: 'ENOENT' });
  await assertInstallationLockRecoveryLocalState(localState, { profile: state.profile });
  await unlink(localState.quarantine.journalPath);
  const replay = await quarantineStaleInstallationLock({
    intent: state.intent, profile: state.profile,
    confirmation: INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION,
    nowFn: () => '2026-08-16T09:00:00.000Z',
  });
  assert.deepEqual(replay, localState);
  const journal = JSON.parse(await readFile(localState.quarantine.journalPath, 'utf8'));
  assert.equal(journal.source.workspaceRoot, state.workspaceRoot);
  assert.equal(journal.source.size, state.profile.size);
  assert.equal(journal.source.sha256, state.profile.sha256);
  assert.equal(journal.source.releaseDigest, state.profile.releaseDigest);
  assert.equal(journal.source.sourceRevision, state.profile.sourceRevision);
  assert.equal(journal.quarantine.filePath, localState.quarantine.filePath);
  assert.equal(journal.operationId, state.intent.operationId);
  assert.equal(journal.completedAt, '2026-08-16T02:01:00.000Z');
});

windowsOnlyTest('atomic rename response loss resumes from exact destination without pathname unlink', async (t) => {
  const state = await layout();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  let renameCalls = 0;
  const result = await quarantineStaleInstallationLock({
    intent: state.intent,
    profile: state.profile,
    confirmation: INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION,
    nowFn: () => '2026-08-16T02:02:00.000Z',
    renameFn: async (source, destination) => {
      renameCalls += 1;
      await rename(source, destination);
      throw new Error('transport lost after MoveFile completed');
    },
  });
  assert.equal(renameCalls, 1);
  assert.equal(result.status, 'AbsentAfterExactStaleQuarantine');
  assert.deepEqual(await readFile(result.quarantine.filePath), state.bytes);
  await assert.rejects(readFile(state.sourcePath), { code: 'ENOENT' });
  const replay = await quarantineStaleInstallationLock({
    intent: state.intent,
    profile: state.profile,
    confirmation: INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION,
  });
  assert.deepEqual(replay, result);
});

windowsOnlyTest('confirmation, wrong bytes, existing destination drift, and hard links are fail closed', async (t) => {
  const first = await layout();
  const second = await layout();
  const third = await layout();
  t.after(() => Promise.all([first, second, third].map((item) =>
    rm(item.root, { recursive: true, force: true }))));
  await assert.rejects(quarantineStaleInstallationLock({
    intent: first.intent, profile: first.profile, confirmation: 'WRONG',
  }), /requires --confirm/u);
  await assert.rejects(readFile(first.quarantineDirectory), { code: 'ENOENT' });

  await writeFile(second.sourcePath, Buffer.from('tampered'));
  await assert.rejects(quarantineStaleInstallationLock({
    intent: second.intent, profile: second.profile,
    confirmation: INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION,
  }), /bytes differ/u);

  const hardLink = join(third.root, 'hard-link.json');
  await link(third.sourcePath, hardLink);
  await assert.rejects(quarantineStaleInstallationLock({
    intent: third.intent, profile: third.profile,
    confirmation: INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION,
  }), /hard-link ambiguity/u);
});

windowsOnlyTest('immutable intent wrapper rejects intent mutation before any source move', async (t) => {
  const state = await layout();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const intentPath = join(state.root, 'quarantine-intent.json');
  await writeFile(intentPath, JSON.stringify(state.intent));
  await assert.rejects(quarantineStaleInstallationLockFromIntent({
    intentPath, confirmation: INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION,
    profile: state.profile,
    nowFn: () => 'not-a-timestamp',
  }), /timestamp is invalid/u);
  assert.deepEqual(await readFile(state.sourcePath), state.bytes);
});

windowsOnlyTest('quarantine rejects a junction-backed workspace before atomic rename', async (t) => {
  const state = await layout();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const junction = join(state.root, 'workspace-junction');
  await symlink(state.workspaceRoot, junction, 'junction');
  const intent = { ...state.intent, workspaceRoot: junction };
  await assert.rejects(quarantineStaleInstallationLock({
    intent, profile: state.profile,
    confirmation: INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION,
  }), /symlink or junction/u);
  assert.deepEqual(await readFile(state.sourcePath), state.bytes);
});

windowsOnlyTest('quarantine rejects a destination directory junction swap before atomic rename', async (t) => {
  const state = await layout();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  let checks = 0;
  const original = `${state.quarantineDirectory}-original`;
  const replacement = `${state.quarantineDirectory}-replacement`;
  await assert.rejects(quarantineStaleInstallationLock({
    intent: state.intent,
    profile: state.profile,
    confirmation: INSTALLATION_LOCK_STALE_QUARANTINE_CONFIRMATION,
    assertIntentUnchanged: async () => {
      checks += 1;
      if (checks === 3) {
        await mkdir(replacement);
        await rename(state.quarantineDirectory, original);
        await symlink(replacement, state.quarantineDirectory, 'junction');
      }
    },
  }), /symlink or junction|identity changed/u);
  assert.deepEqual(await readFile(state.sourcePath), state.bytes);
});
