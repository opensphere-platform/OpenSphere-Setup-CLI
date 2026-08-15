import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson, gitBlobSha, INSTALLATION_LOCK_RECOVERY_TOOLING_PATHS, sha256,
} from '../src/installation-lock-recovery.mjs';
import {
  INSTALLATION_LOCK_RECOVERY_PREPARE_CONFIRMATION,
  observeInstallationLockRecoveryToolingAuthority,
  prepareInstallationLockRecovery,
} from '../src/installation-lock-recovery-prepare.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function fakeApprovalDocument(_bundle, { approvalId, reason, approvedAt, expiresAt }) {
  return {
    contract: 'opensphere.installation-lock.reconstruction-approval/v1',
    approvalId, action: 'CreateOnlySemanticInstallationLockReconstruction', reason, approvedAt, expiresAt,
  };
}

function fakePlan(bundle) {
  const unsigned = {
    contract: 'opensphere.installation-lock.recovery-plan-fixture/v1',
    approval: bundle.approval,
    preconditions: { localState: bundle.localState },
  };
  return { ...unsigned, planDigest: sha256(canonicalJson(unsigned)) };
}

function fakeValidatePlan(plan) {
  const { planDigest, ...unsigned } = plan;
  if (planDigest !== sha256(canonicalJson(unsigned))) throw new Error('fixture plan digest mismatch');
  return plan;
}

async function toolingBoundary() {
  const files = [];
  for (const path of INSTALLATION_LOCK_RECOVERY_TOOLING_PATHS) {
    const bytes = await readFile(join(repositoryRoot, path));
    files.push({ path, sha256: sha256(bytes), gitBlob: gitBlobSha(bytes) });
  }
  return {
    evidence: {
      contract: 'opensphere.installation-lock.recovery-tooling-authority/v1',
      repository: 'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git',
      sourceRevision: '7'.repeat(40), branch: 'main', files,
    },
    helperPath: join(repositoryRoot, 'scripts/Assert-InstallationLockRecoverySigningKey.ps1'),
  };
}

async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'opensphere-recovery-prepare-'));
  const workspaceRoot = join(root, 'workspace');
  const receiptDirectory = join(root, 'receipts');
  const quarantineDirectory = join(root, 'quarantine');
  const outputDirectory = join(root, 'prepared');
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(quarantineDirectory, { recursive: true }),
  ]);
  const staleBase64 = await readFile(new URL(
    './fixtures/stale-current-installation-lock.base64', import.meta.url
  ), 'utf8');
  const staleBytes = Buffer.from(staleBase64.trim(), 'base64');
  const filePath = join(quarantineDirectory, 'stale.json');
  await writeFile(filePath, staleBytes);
  const preparedJournal = {
    contract: 'opensphere.installation-lock.stale-quarantine-journal/v1',
    operationId: '40000000-0000-4000-8000-000000000001', state: 'PreparedForQuarantine',
    source: {
      workspaceRoot, path: '.codex-deploy/current-installation-lock.json',
      fileType: 'RegularFile', size: 4654,
      sha256: 'sha256:a74e679607070e8ceab782c11ea0d2317cd8261d9e1fbf0d77dccf139ec75bc1',
      releaseDigest: 'sha256:0a580e9e212f15018a84fd8d227a3dbdbb4b4a274ba7b6bd009861ad63d4d9d4',
      sourceRevision: '4f77114125bde4ad5fcb0478ce8168684d66209f',
    },
    quarantine: {
      directory: quarantineDirectory, filePath, fileType: 'RegularFile', size: 4654,
      sha256: 'sha256:a74e679607070e8ceab782c11ea0d2317cd8261d9e1fbf0d77dccf139ec75bc1',
    },
    preparedAt: '2026-08-16T03:00:00.000Z',
    completionTimestamp: '2026-08-16T03:01:00.000Z',
  };
  const preparedBytes = Buffer.from(`${JSON.stringify(preparedJournal, null, 2)}\n`);
  await writeFile(join(quarantineDirectory, 'stale.prepared.json'), preparedBytes);
  const journalPath = join(quarantineDirectory, 'stale.journal.json');
  const journal = {
    contract: 'opensphere.installation-lock.stale-quarantine-journal/v1',
    operationId: '40000000-0000-4000-8000-000000000001', state: 'Quarantined',
    source: {
      workspaceRoot, path: '.codex-deploy/current-installation-lock.json',
      fileType: 'RegularFile', size: 4654,
      sha256: 'sha256:a74e679607070e8ceab782c11ea0d2317cd8261d9e1fbf0d77dccf139ec75bc1',
      releaseDigest: 'sha256:0a580e9e212f15018a84fd8d227a3dbdbb4b4a274ba7b6bd009861ad63d4d9d4',
      sourceRevision: '4f77114125bde4ad5fcb0478ce8168684d66209f',
    },
    quarantine: {
      directory: quarantineDirectory, filePath, fileType: 'RegularFile', size: 4654,
      sha256: 'sha256:a74e679607070e8ceab782c11ea0d2317cd8261d9e1fbf0d77dccf139ec75bc1',
    },
    preparedJournalSha256: sha256(preparedBytes),
    preparedAt: '2026-08-16T03:00:00.000Z', completedAt: '2026-08-16T03:01:00.000Z',
  };
  const journalBytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
  await writeFile(journalPath, journalBytes);
  const localState = {
    workspaceRoot, receiptDirectory,
    path: '.codex-deploy/current-installation-lock.json',
    status: 'AbsentAfterExactStaleQuarantine',
    quarantine: {
      contract: journal.contract, operationId: journal.operationId, journalPath,
      journalSha256: sha256(journalBytes), filePath, fileType: 'RegularFile',
      fileSha256: journal.quarantine.sha256, size: journal.quarantine.size,
      releaseDigest: journal.source.releaseDigest, sourceRevision: journal.source.sourceRevision,
      completedAt: journal.completedAt, status: journal.state,
    },
  };
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const reviewedTooling = await toolingBoundary();
  const bundle = {
    contract: 'fixture-reviewed-evidence/v1', localState,
    recoveryToolingAuthority: reviewedTooling.evidence,
    trustObservation: {
      keyId: 'opensphere-edge-local-v1', publicKeySpkiBase64: spki.toString('base64'),
      publicKeySpkiSha256: sha256(spki),
    },
  };
  const evidenceBundlePath = join(root, 'reviewed-evidence.json');
  const approvalKeyPath = join(root, 'edge-local-v1-p256.pem');
  const reasonFilePath = join(root, 'reason.txt');
  await writeFile(evidenceBundlePath, JSON.stringify(bundle));
  await writeFile(approvalKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  await writeFile(reasonFilePath,
    'Explicitly approve the exact semantic installation-lock reconstruction evidence.\n');
  return {
    root, workspaceRoot, receiptDirectory, outputDirectory, bundle,
    evidenceBundlePath, approvalKeyPath, reasonFilePath,
  };
}

function options(state, overrides = {}) {
  return {
    evidenceBundlePath: state.evidenceBundlePath,
    approvalKeyPath: state.approvalKeyPath,
    outputDirectory: state.outputDirectory,
    reasonFilePath: state.reasonFilePath,
    approvalId: '50000000-0000-4000-8000-000000000001',
    approvedAt: '2026-08-16T03:05:00.000Z',
    expiresAt: '2026-08-16T03:35:00.000Z',
    nowFn: () => '2026-08-16T03:06:00.000Z',
    ensureDirectoryCustodyFn: async () => {},
    assertDirectoryCustodyFn: async () => {},
    confirmation: INSTALLATION_LOCK_RECOVERY_PREPARE_CONFIRMATION,
    keyBoundaryFn: async () => ({
      helperPath: join(repositoryRoot, 'scripts/Assert-InstallationLockRecoverySigningKey.ps1'),
    }),
    toolingBoundaryFn: toolingBoundary,
    buildApprovalDocumentFn: fakeApprovalDocument,
    buildPlanFn: fakePlan,
    validatePlanFn: fakeValidatePlan,
    ...overrides,
  };
}

test('prepare writes no-overwrite approval, signature, plan, and hash receipt and replays exactly', async (t) => {
  const state = await layout();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const first = await prepareInstallationLockRecovery(options(state));
  const second = await prepareInstallationLockRecovery(options(state));
  assert.deepEqual(second, first);
  assert.deepEqual((await readdir(state.outputDirectory)).sort(), [
    'installation-lock-recovery-approval-document.json',
    'installation-lock-recovery-approval-signature.json',
    'installation-lock-recovery-plan.json',
    'installation-lock-recovery-preparation-receipt.json',
  ]);
  const receipt = JSON.parse(await readFile(first.receiptPath, 'utf8'));
  assert.equal(receipt.contract, 'opensphere.installation-lock.recovery-preparation-receipt/v1');
  assert.equal(receipt.plan.planDigest, first.planDigest);
  assert.equal(receipt.approval.documentSha256, first.approvalDocumentSha256);
  assert.equal(receipt.approval.signatureSha256, first.approvalSignatureSha256);
  assert.equal(receipt.evidenceBundle.rawSha256, first.evidenceBundleSha256);
  assert.equal(receipt.completedAt, '2026-08-16T03:06:00.000Z');
  assert.notEqual(receipt.completedAt, '2026-08-16T03:05:00.000Z');
  assert.equal(JSON.stringify(receipt).includes('PRIVATE KEY'), false);
});

test('wrong key, stale bundle, in-repo output, and tooling failure are mutation free', async (t) => {
  const wrong = await layout();
  const stale = await layout();
  const inside = await layout();
  const tooling = await layout();
  t.after(() => Promise.all([wrong, stale, inside, tooling].map((item) =>
    rm(item.root, { recursive: true, force: true }))));
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  await writeFile(wrong.approvalKeyPath, other.export({ format: 'pem', type: 'pkcs8' }));
  await assert.rejects(prepareInstallationLockRecovery(options(wrong)), /differs from the signed edge trust/u);
  await assert.rejects(readdir(wrong.outputDirectory), { code: 'ENOENT' });

  await mkdir(dirname(join(stale.workspaceRoot, '.codex-deploy/current-installation-lock.json')),
    { recursive: true });
  await writeFile(join(stale.workspaceRoot, '.codex-deploy/current-installation-lock.json'), '{}');
  await assert.rejects(prepareInstallationLockRecovery(options(stale)), /must be absent/u);
  await assert.rejects(readdir(stale.outputDirectory), { code: 'ENOENT' });

  await assert.rejects(prepareInstallationLockRecovery(options(inside, {
    outputDirectory: join(inside.workspaceRoot, 'prepared'),
  })), /outside the source repository/u);

  let keyBoundaryCalls = 0;
  await assert.rejects(prepareInstallationLockRecovery(options(tooling, {
    toolingBoundaryFn: async () => { throw new Error('tooling not canonical'); },
    keyBoundaryFn: async () => { keyBoundaryCalls += 1; return {}; },
  })), /tooling not canonical/u);
  assert.equal(keyBoundaryCalls, 0);
});

test('evidence and persisted plan tamper are rejected without overwrite', async (t) => {
  const evidence = await layout();
  const plan = await layout();
  t.after(() => Promise.all([evidence, plan].map((item) =>
    rm(item.root, { recursive: true, force: true }))));
  await assert.rejects(prepareInstallationLockRecovery(options(evidence, {
    beforeFirstOutputFn: async () => writeFile(evidence.evidenceBundlePath, '{}'),
  })), /changed during recovery preparation/u);
  await assert.rejects(readdir(evidence.outputDirectory), { code: 'ENOENT' });

  const prepared = await prepareInstallationLockRecovery(options(plan));
  await writeFile(prepared.planPath, '{"tampered":true}\n');
  await assert.rejects(prepareInstallationLockRecovery(options(plan)),
    /signed recovery plan exists with different bytes/u);
  assert.equal(await readFile(prepared.planPath, 'utf8'), '{"tampered":true}\n');
});

test('canonical tooling boundary fetches origin main and rejects a stale local HEAD', async () => {
  const calls = [];
  const head = 'a'.repeat(40);
  const origin = 'b'.repeat(40);
  const runGitFn = (_root, args) => {
    calls.push(args.join(' '));
    const command = args.join(' ');
    if (command === 'symbolic-ref --short HEAD') return 'main\n';
    if (command === 'remote get-url origin') {
      return 'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git\n';
    }
    if (command.startsWith('status ')) return '';
    if (command === 'fetch --prune origin main') return '';
    if (command === 'rev-parse HEAD') return `${head}\n`;
    if (command === 'rev-parse refs/remotes/origin/main') return `${origin}\n`;
    throw new Error(`unexpected git command ${command}`);
  };
  await assert.rejects(observeInstallationLockRecoveryToolingAuthority({
    repositoryRoot, runGitFn,
  }), /not clean canonical main/u);
  assert.ok(calls.includes('fetch --prune origin main'));
});

test('preparation rejects a junction-backed output parent before writing artifacts', async (t) => {
  const state = await layout();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const target = join(state.root, 'junction-target');
  const junction = join(state.root, 'junction-output');
  await mkdir(target);
  await symlink(target, junction, 'junction');
  await assert.rejects(prepareInstallationLockRecovery(options(state, {
    outputDirectory: junction,
  })), /symlink or junction/u);
  assert.deepEqual(await readdir(target), []);
});
