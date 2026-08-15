import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  INSTALLATION_LOCK_RECOVERY_APPROVAL_CONTRACT,
  INSTALLATION_LOCK_RECOVERY_EVIDENCE_CONTRACT,
  INSTALLATION_LOCK_RECOVERY_TOOLING_PATHS,
  buildInstallationLockRecoveryApprovalDocument,
  buildInstallationLockRecoveryPlan,
  canonicalJson,
  executeInstallationLockRecovery,
  gitBlobSha,
  sha256,
  validateInstallationLockRecoveryPlan,
} from '../src/installation-lock-recovery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name, encoding = 'utf8') => fs.readFileSync(
  path.join(here, 'fixtures', name), encoding
);
const incidentText = fixture('installation-lock-recovery-incident.json');
const governedText = Buffer.from(
  fixture('installation-lock-recovery-governed-change.base64').trim(), 'base64'
).toString('utf8');
const governed = JSON.parse(governedText);
const targetLock = governed.spec.desiredState.targetLock;

const EXPECTED = Object.freeze({
  incidentSha: 'sha256:5a7e292bad4905a82cadbd8202f95247c475b456bbcb676392340964049a6796',
  governedSha: 'sha256:65c2f82112e888ff8bc3ee7344f7b38934c2cf5a9b439984981f9dc0c28dd469',
  governedBlob: 'c264f5625f369a9d75e6c76b7f793d754af777b5',
  releaseSha: 'sha256:6f5570434a64a7b7157bf1a38da1a4b5c39437b943b1f4a4cb18e02d30eb4c00',
  configSha: 'sha256:ebc2dbab240cb2f081571d48dd220523a348f3c78519908b0e4e5c5c24fa6561',
});

const workloadIdentity = Object.freeze([
  ['backend', 'Deployment', 'opensphere-console', 'opensphere-console-backend', 'api'],
  ['console', 'Deployment', 'opensphere-console', 'opensphere-console', 'shell'],
  ['dupaController', 'Deployment', 'opensphere-console', 'opensphere-console-dupa-controller', 'controller'],
  ['gitea', 'Deployment', 'opensphere-console-change', 'opensphere-gitea', 'gitea'],
  ['giteaPostgres', 'Deployment', 'opensphere-console-change', 'opensphere-gitea-postgres', 'postgres'],
  ['notificationDispatcher', 'Deployment', 'opensphere-console', 'opensphere-external-channel-executor', 'executor'],
  ['notificationDispatcher', 'Deployment', 'opensphere-console', 'opensphere-notification-dispatcher', 'dispatcher'],
  ['oaaGateway', 'Deployment', 'opensphere-console', 'opensphere-console-oaa-gateway', 'gateway'],
  ['oaaGovernedAdapter', 'Deployment', 'opensphere-console', 'oaa-governed-adapter', 'reconciler'],
  ['recovery', 'CronJob', 'opensphere-console-change', 'opensphere-gitea-recovery-backup', 'recovery'],
  ['recovery', 'CronJob', 'opensphere-console-data', 'opensphere-supabase-recovery-backup', 'recovery'],
  ['supabaseAuth', 'Deployment', 'opensphere-console-data', 'opensphere-supabase-auth', 'auth'],
  ['supabasePostgres', 'StatefulSet', 'opensphere-console-data', 'opensphere-supabase-postgres', 'postgres'],
  ['supabaseRest', 'Deployment', 'opensphere-console-data', 'opensphere-supabase-rest', 'rest'],
  ['supabaseStorage', 'Deployment', 'opensphere-console-data', 'opensphere-supabase-storage', 'storage'],
]);

function clone(value) {
  return structuredClone(value);
}

function observationBundle() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const components = workloadIdentity.map((identity, index) => {
    const [component, kind, namespace, name, container] = identity;
    return {
      component,
      kind,
      namespace,
      name,
      container,
      uid: `runtime-workload-${String(index + 1).padStart(2, '0')}`,
      resourceVersion: String(14000000 + index),
      image: targetLock.components[component].image,
      sourceRevision: targetLock.components[component].sourceRevision,
      ready: true,
      executionState: kind === 'CronJob' ? 'SuspendedSafeDefault' : 'Ready',
      podImageIds: kind === 'CronJob'
        ? []
        : [`docker-pullable://${targetLock.components[component].image}`],
    };
  });
  const pvcs = [
    ['opensphere-console-change', 'opensphere-gitea-data', 'pvc-gitea-data', '6297'],
    ['opensphere-console-change', 'opensphere-gitea-postgres-data', 'pvc-gitea-postgres', '6196'],
    ['opensphere-console-data', 'opensphere-supabase-postgres-data', 'pvc-supabase-postgres', '5674'],
    ['opensphere-console-data', 'opensphere-supabase-storage-data', 'pvc-supabase-storage', '5681'],
  ].map(([namespace, name, uid, resourceVersion]) => ({
    namespace, name, uid, resourceVersion, storageClass: 'hostpath', phase: 'Bound',
  }));
  const trustObservation = {
    contract: 'opensphere.installation-lock.edge-trust-observation/v1',
    namespace: 'opensphere-console',
    configMapName: 'dupa-trusted-keys',
    uid: 'trust-config-fixture-uid',
    resourceVersion: '13370001',
    keyId: 'opensphere-edge-local-v1',
    publicKeySpkiBase64: publicKeyDer.toString('base64'),
    publicKeySpkiSha256: sha256(publicKeyDer),
  };
  const recoveryToolingAuthority = {
    contract: 'opensphere.installation-lock.recovery-tooling-authority/v1',
    repository: 'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git',
    branch: 'main', sourceRevision: '7'.repeat(40),
    files: INSTALLATION_LOCK_RECOVERY_TOOLING_PATHS.map((toolPath, index) => ({
      path: toolPath,
      sha256: `sha256:${String(index + 1).padStart(64, '0')}`,
      gitBlob: String(index + 1).padStart(40, '0'),
    })),
  };
  const bundle = {
    contract: INSTALLATION_LOCK_RECOVERY_EVIDENCE_CONTRACT,
    incidentSource: {
      path: '.codex-tmp/incidents/2026-08-15-installation-lock-accidental-delete.json',
      documentText: incidentText,
      documentSha256: sha256(incidentText),
    },
    governedSource: {
      repository: 'opensphere/platform-declarations',
      commit: 'c51319d2bddac715eea840417552dde46de686de',
      path: 'platform-release/requests/a649530f-c8d5-4a0f-a461-9707bc9809b8.json',
      gitBlob: gitBlobSha(governedText),
      documentSha256: sha256(governedText),
      documentText: governedText,
    },
    receipt: {
      request_id: 'a649530f-c8d5-4a0f-a461-9707bc9809b8',
      operation_id: 'a649530f-c8d5-4a0f-a461-9707bc9809b8:c51319d2bddac715eea840417552dde46de686de:1',
      desired_revision: 'c51319d2bddac715eea840417552dde46de686de',
      applied_revision: '59778b3cfe26cadc93f832ecb67e0c3720b3d803',
      succeeded: true,
      result: 'signed Platform Release applied and verified',
      evidence: {
        stage: 'observed',
        channel: 'edge',
        previousReleaseDigest: 'sha256:81b9a4f2b80debe90daf93cb3f60e9bdc085a91509dacbf3203220914f1a1fea',
        installedReleaseDigest: targetLock.releaseDigest,
        sourceRevision: targetLock.sourceRevision,
        platforms: ['linux/amd64'],
        changed: true,
        podCount: 2,
        serviceCount: 13,
        rollbackContract: 'Setup upgrade restores the previously verified release on failed target verification',
      },
      received_at: '2026-08-15T07:45:37.035426+00:00',
    },
    configObservation: {
      contract: 'opensphere.installation-lock.config-observation/v1',
      observedAt: '2026-08-16T00:00:00.000Z',
      expectedReleaseJsonSha256: EXPECTED.releaseSha,
      expectedConfigJsonSha256: EXPECTED.configSha,
      installationEvidence: {
        uid: 'b6b66c91-f04c-4ada-8b07-c474f6ddf6a7',
        resourceVersion: '13330542',
        releaseDigest: targetLock.releaseDigest,
        runtimeImagesMatchLock: true,
        verifiedAt: '2026-08-15T07:45:38.000Z',
      },
      releaseInventory: {
        uid: 'dbc61098-0895-4375-b43f-6303a75878dd',
        resourceVersion: '13330552',
        releaseDigest: targetLock.releaseDigest,
        resourceCount: 88,
        resourceSetDigest: sha256('fixture-release-inventory'),
      },
      initialAdmin: {
        uid: '6e65e7de-3f02-4553-8b47-2a853c3c8d71',
        resourceVersion: '6658',
        username: 'opensphere-admin',
        displayName: 'OpenSphere Administrator',
        email: 'admin@opensphere.local',
        state: 'required',
      },
      managedStorage: {
        storageClass: 'hostpath',
        pvcCount: 4,
        pvcSetDigest: sha256(canonicalJson(pvcs)),
        pvcs,
      },
      backend: {
        deploymentUid: '9acfc920-60cb-48ea-afd2-e80b88d7be0f',
        resourceVersion: '13367481',
        consolePublicUrl: 'https://localhost:1114',
      },
      authEnvironmentReconstruction: {
        value: 'development',
        status: 'SemanticReconstructionApproved',
        basis: 'edge-channel-policy',
      },
      shellTls: {
        mode: 'managed',
        secretName: 'shell-tls',
        uid: '0311f1d5-9699-4d36-b943-00bdf97dab7e',
        resourceVersion: '5513',
        secretType: 'Opaque',
        dataKeys: ['ca.crt', 'tls.crt', 'tls.key'],
        workloadSetDigest: sha256('fixture-shell-tls-workload-set'),
      },
    },
    runtimeObservation: {
      contract: 'opensphere.installation-lock.runtime-images/v1',
      observedAt: '2026-08-16T00:00:00.000Z',
      components,
      imageSetDigest: sha256(canonicalJson(components)),
    },
    trustObservation,
    recoveryToolingAuthority,
    localState: {
      workspaceRoot: 'D:\\@PROJECT\\OpenSphere\\OpenSphere-Platform-V2',
      receiptDirectory: 'D:\\@PROJECT\\OpenSphere\\installation-lock-recovery-receipts',
      path: '.codex-deploy/current-installation-lock.json',
      status: 'AbsentAfterExactStaleQuarantine',
      quarantine: {
        contract: 'opensphere.installation-lock.stale-quarantine-journal/v1',
        operationId: '20000000-0000-4000-8000-000000000001',
        journalPath: 'D:\\@PROJECT\\OpenSphere\\installation-lock-recovery-quarantine\\stale.journal.json',
        journalSha256: `sha256:${'9'.repeat(64)}`,
        filePath: 'D:\\@PROJECT\\OpenSphere\\installation-lock-recovery-quarantine\\stale.json',
        fileType: 'RegularFile',
        fileSha256: 'sha256:a74e679607070e8ceab782c11ea0d2317cd8261d9e1fbf0d77dccf139ec75bc1',
        size: 4654,
        releaseDigest: 'sha256:0a580e9e212f15018a84fd8d227a3dbdbb4b4a274ba7b6bd009861ad63d4d9d4',
        sourceRevision: '4f77114125bde4ad5fcb0478ce8168684d66209f',
        completedAt: '2026-08-16T00:02:00.000Z',
        status: 'Quarantined',
      },
    },
  };
  return { bundle, privateKey };
}

function signedPlan() {
  const { bundle, privateKey } = observationBundle();
  const approvalDocument = buildInstallationLockRecoveryApprovalDocument(bundle, {
    approvalId: '10000000-0000-4000-8000-000000000001',
    reason: 'Explicitly reconstruct the verified missing installation lock after incident review.',
    approvedAt: '2026-08-16T00:05:00.000Z',
    expiresAt: '2026-08-16T00:35:00.000Z',
  });
  const documentText = JSON.stringify(approvalDocument);
  const signature = sign('sha256', Buffer.from(documentText), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  const approval = {
    contract: INSTALLATION_LOCK_RECOVERY_APPROVAL_CONTRACT,
    approvalId: approvalDocument.approvalId,
    keyId: bundle.trustObservation.keyId,
    publicKeySpkiBase64: bundle.trustObservation.publicKeySpkiBase64,
    publicKeySpkiSha256: bundle.trustObservation.publicKeySpkiSha256,
    documentText,
    documentSha256: sha256(documentText),
    signatureBase64: signature.toString('base64'),
  };
  return {
    plan: buildInstallationLockRecoveryPlan({ ...bundle, approval }),
    bundle,
  };
}

function verificationFor(plan) {
  return {
    releaseDigest: plan.releaseDigest,
    releaseJsonSha256: plan.reconstruction.releaseJsonSha256,
    configJsonSha256: plan.reconstruction.configJsonSha256,
    runtimeImagesMatchLock: true,
    runtimeImageSetDigest: plan.evidence.runtimeImageSetDigest,
    installationEvidenceUid: plan.preconditions.installationEvidence.uid,
    installationEvidenceResourceVersion: plan.preconditions.installationEvidence.resourceVersion,
    releaseInventoryUid: plan.preconditions.releaseInventory.uid,
    releaseInventoryResourceVersion: plan.preconditions.releaseInventory.resourceVersion,
  };
}

function exactServerObject(plan, uid = 'recovered-lock-uid', resourceVersion = '14000001') {
  return {
    ...clone(plan.manifest),
    metadata: { ...clone(plan.manifest.metadata), uid, resourceVersion },
  };
}

function mockRuntime(plan, options = {}) {
  let installationLock = options.installationLock ?? null;
  let receipt = options.receipt ?? null;
  const calls = { create: 0, delete: 0, verify: 0, writeReceipt: 0 };
  return {
    calls,
    now() { return options.now ?? '2026-08-16T00:10:00.000Z'; },
    get installationLock() { return installationLock; },
    get receipt() { return receipt; },
    async observe() {
      return {
        preconditionDigest: plan.evidence.preconditionDigest,
        installationLock: installationLock ? clone(installationLock) : null,
      };
    },
    async readReceipt() { return receipt ? clone(receipt) : null; },
    async createConfigMap() {
      calls.create += 1;
      if (options.conflictObject) {
        installationLock = clone(options.conflictObject);
        const error = new Error('AlreadyExists');
        error.statusCode = 409;
        throw error;
      }
      installationLock = exactServerObject(plan);
      if (options.responseLost) {
        const error = new Error('response lost');
        error.code = 'ResponseLost';
        throw error;
      }
      return clone(installationLock);
    },
    async deleteConfigMap(precondition) {
      calls.delete += 1;
      assert.deepEqual(precondition, {
        uid: installationLock.metadata.uid,
        resourceVersion: installationLock.metadata.resourceVersion,
      });
      installationLock = null;
      if (options.deleteResponseLostAfterRemoval) {
        const error = new Error('DELETE response lost after removal');
        error.code = 'ResponseLost';
        throw error;
      }
    },
    async verifyRecoveredInstallation() {
      calls.verify += 1;
      if (options.verificationError) throw new Error(options.verificationError);
      return verificationFor(plan);
    },
    async writeReceipt(value) {
      calls.writeReceipt += 1;
      receipt = clone(value);
      if (options.receiptError
          || options.receiptErrorAfterState === value.state) {
        throw new Error(options.receiptError ?? `receipt response lost for ${value.state}`);
      }
    },
  };
}

test('reviewed incident and Gitea blob fixtures are byte exact', () => {
  assert.equal(sha256(incidentText), EXPECTED.incidentSha);
  assert.equal(sha256(governedText), EXPECTED.governedSha);
  assert.equal(gitBlobSha(governedText), EXPECTED.governedBlob);
  assert.equal(Buffer.byteLength(JSON.stringify(targetLock)), 4652);
  assert.equal(sha256(JSON.stringify(targetLock)), EXPECTED.releaseSha);
});

test('builds and independently revalidates the exact signed reconstruction plan', () => {
  const { plan } = signedPlan();
  assert.equal(validateInstallationLockRecoveryPlan(plan), plan);
  assert.equal(plan.reconstruction.configJsonStatus,
    'SemanticReconstructionApprovedNotHistoricalByteRestore');
  assert.equal(Buffer.byteLength(plan.manifest.data['config.json']), 474);
  assert.equal(sha256(plan.manifest.data['config.json']), EXPECTED.configSha);
});

test('rejects approval, evidence, local-state, and closed-schema tampering', () => {
  const { plan, bundle } = signedPlan();
  for (const mutate of [
    (value) => { value.approval.signatureBase64 = Buffer.alloc(64).toString('base64'); },
    (value) => { value.evidence.runtimeImageSetDigest = sha256('tampered'); },
    (value) => { value.manifest.data['config.json'] = '{}'; },
    (value) => { value.extra = true; },
  ]) {
    const changed = clone(plan);
    mutate(changed);
    assert.throws(() => validateInstallationLockRecoveryPlan(changed));
  }
  const stale = clone(bundle);
  stale.localState.status = 'Present';
  assert.throws(() => buildInstallationLockRecoveryApprovalDocument(stale, {
    approvalId: '10000000-0000-4000-8000-000000000002',
    reason: 'Reject the stale local installation lock cache before any recovery action.',
    approvedAt: '2026-08-16T00:05:00.000Z',
    expiresAt: '2026-08-16T00:35:00.000Z',
  }), /stale/);
});

test('create-only recovery verifies exact state and writes the durable success receipt', async () => {
  const { plan } = signedPlan();
  const runtime = mockRuntime(plan);
  const receipt = await executeInstallationLockRecovery(plan, runtime);
  assert.equal(receipt.succeeded, true);
  assert.equal(receipt.state, 'SemanticReconstructionRecovered');
  assert.equal(receipt.oldInstallationLockUid, '7016251f-c144-4e71-8b54-0df6e956854a');
  assert.equal(runtime.calls.create, 1);
  assert.equal(runtime.calls.verify, 1);
  assert.equal(runtime.calls.writeReceipt, 1);
  assert.equal(runtime.calls.delete, 0);
});

test('approval freshness is bounded and create is mutation-free after expiry', async () => {
  const { plan, bundle } = signedPlan();
  assert.throws(() => buildInstallationLockRecoveryApprovalDocument(bundle, {
    approvalId: '10000000-0000-4000-8000-000000000099',
    reason: 'Reject an approval whose execution window exceeds the reviewed maximum.',
    approvedAt: '2026-08-16T00:05:00.000Z',
    expiresAt: '2026-08-16T00:35:00.001Z',
  }), /at most 30 minutes/u);
  const expired = mockRuntime(plan, { now: '2026-08-16T00:35:00.001Z' });
  await assert.rejects(executeInstallationLockRecovery(plan, expired), /approval is not fresh for create/u);
  assert.equal(expired.calls.create, 0);
  assert.equal(expired.calls.delete, 0);
  assert.equal(expired.calls.writeReceipt, 0);

  const exactResponseLossObject = exactServerObject(plan);
  const expiredReplay = mockRuntime(plan, {
    installationLock: exactResponseLossObject,
    now: '2026-08-16T00:40:00.000Z',
  });
  const replayReceipt = await executeInstallationLockRecovery(plan, expiredReplay);
  assert.equal(replayReceipt.state, 'SemanticReconstructionRecovered');
  assert.equal(replayReceipt.responseLossReplay, true);
  assert.equal(expiredReplay.calls.create, 0);
  assert.equal(expiredReplay.calls.delete, 0);
});

test('response-loss accepts only an exact object but never assigns create ownership', async () => {
  const { plan } = signedPlan();
  const runtime = mockRuntime(plan, { responseLost: true });
  const receipt = await executeInstallationLockRecovery(plan, runtime);
  assert.equal(receipt.responseLossReplay, true);
  assert.equal(runtime.calls.create, 1);
  const ambiguousVerifierFailure = mockRuntime(plan, {
    responseLost: true,
    verificationError: 'concurrent verifier failure',
  });
  await assert.rejects(executeInstallationLockRecovery(plan, ambiguousVerifierFailure),
    /not owned by this execution/u);
  assert.equal(ambiguousVerifierFailure.calls.delete, 0);
  assert.equal(ambiguousVerifierFailure.receipt.state, 'NeedsAttentionPreservedExactObject');
  const conflict = mockRuntime(plan, {
    conflictObject: {
      ...exactServerObject(plan),
      data: { ...plan.manifest.data, 'config.json': '{}' },
    },
  });
  await assert.rejects(executeInstallationLockRecovery(plan, conflict), /without an exact/);
  assert.equal(conflict.calls.delete, 0);
  assert.equal(conflict.calls.writeReceipt, 0);
});

test('verification failure rolls back only an object created by this execution', async () => {
  const { plan } = signedPlan();
  const created = mockRuntime(plan, { verificationError: 'postcondition drift' });
  await assert.rejects(executeInstallationLockRecovery(plan, created), /rollback is complete/u);
  assert.equal(created.installationLock, null);
  assert.equal(created.calls.delete, 1);
  assert.equal(created.receipt.state, 'RolledBackToMissing');
  assert.equal(created.calls.writeReceipt, 2);

  const preexisting = mockRuntime(plan, {
    installationLock: exactServerObject(plan),
    verificationError: 'transient verifier failure',
  });
  await assert.rejects(executeInstallationLockRecovery(plan, preexisting), (error) => {
    assert.equal(error.code, 'InstallationLockRecoveryVerificationNeedsAttention');
    return true;
  });
  assert.notEqual(preexisting.installationLock, null);
  assert.equal(preexisting.calls.delete, 0);
  assert.equal(preexisting.calls.writeReceipt, 1);
  assert.equal(preexisting.receipt.state, 'NeedsAttentionPreservedExactObject');

  const recoveredVerifier = mockRuntime(plan, {
    installationLock: preexisting.installationLock,
    receipt: preexisting.receipt,
  });
  const recoveredReceipt = await executeInstallationLockRecovery(plan, recoveredVerifier);
  assert.equal(recoveredReceipt.state, 'SemanticReconstructionRecovered');
  assert.equal(recoveredVerifier.calls.create, 0);
  assert.equal(recoveredVerifier.calls.delete, 0);
  assert.equal(recoveredVerifier.calls.writeReceipt, 1);
});

test('lifecycle metadata mutations are never accepted as the recovered object', async () => {
  const { plan } = signedPlan();
  for (const mutate of [
    (value) => { value.metadata.deletionTimestamp = '2026-08-16T00:11:00.000Z'; },
    (value) => { value.metadata.deletionGracePeriodSeconds = 0; },
    (value) => { value.metadata.finalizers = ['foreign.example/finalizer']; },
    (value) => { value.metadata.ownerReferences = [{ apiVersion: 'v1', kind: 'Secret', name: 'x', uid: 'x' }]; },
  ]) {
    const object = exactServerObject(plan);
    mutate(object);
    const runtime = mockRuntime(plan, { installationLock: object });
    await assert.rejects(executeInstallationLockRecovery(plan, runtime), /different installation lock/u);
    assert.equal(runtime.calls.create, 0);
    assert.equal(runtime.calls.delete, 0);
    assert.equal(runtime.calls.writeReceipt, 0);
  }
});

test('rollback claim is durable, resumable, and never deletes a concurrent object', async () => {
  const { plan } = signedPlan();
  const claimLost = mockRuntime(plan, {
    verificationError: 'owned postcondition failure',
    receiptErrorAfterState: 'RollbackClaimed',
  });
  await assert.rejects(executeInstallationLockRecovery(plan, claimLost), (error) => {
    assert.equal(error.code, 'InstallationLockRecoveryReceiptPending');
    assert.equal(error.receipt.state, 'RollbackClaimed');
    return true;
  });
  assert.equal(claimLost.calls.delete, 0);
  const replay = mockRuntime(plan, {
    installationLock: claimLost.installationLock,
    receipt: claimLost.receipt,
    deleteResponseLostAfterRemoval: true,
  });
  await assert.rejects(executeInstallationLockRecovery(plan, replay), /ambiguous DELETE response/u);
  assert.equal(replay.calls.delete, 1);
  assert.equal(replay.receipt.state, 'RolledBackToMissing');

  const foreign = exactServerObject(plan, 'concurrent-uid', '14000099');
  const collision = mockRuntime(plan, { installationLock: foreign, receipt: claimLost.receipt });
  await assert.rejects(executeInstallationLockRecovery(plan, collision), /different installation-lock object/u);
  assert.equal(collision.calls.create, 0);
  assert.equal(collision.calls.delete, 0);
  assert.equal(collision.receipt.state, 'NeedsAttentionPreservedExactObject');
});

test('terminal rollback receipt response loss is replay-safe and cannot recreate', async () => {
  const { plan } = signedPlan();
  const runtime = mockRuntime(plan, {
    verificationError: 'owned verifier failure',
    receiptErrorAfterState: 'RolledBackToMissing',
  });
  await assert.rejects(executeInstallationLockRecovery(plan, runtime), (error) => {
    assert.equal(error.code, 'InstallationLockRecoveryReceiptPending');
    assert.equal(error.receipt.state, 'RolledBackToMissing');
    return true;
  });
  assert.equal(runtime.installationLock, null);
  const replay = mockRuntime(plan, { installationLock: null, receipt: runtime.receipt });
  await assert.rejects(executeInstallationLockRecovery(plan, replay), /new approval is required/u);
  assert.equal(replay.calls.create, 0);
  assert.equal(replay.calls.delete, 0);
});

test('durable success receipt makes replay side-effect free after exact re-verification', async () => {
  const { plan } = signedPlan();
  const runtime = mockRuntime(plan);
  const first = await executeInstallationLockRecovery(plan, runtime);
  const writes = runtime.calls.writeReceipt;
  const second = await executeInstallationLockRecovery(plan, runtime);
  assert.deepEqual(second, first);
  assert.equal(runtime.calls.create, 1);
  assert.equal(runtime.calls.writeReceipt, writes);
  assert.equal(runtime.calls.verify, 2);
});

test('receipt response loss preserves the verified object and an exact replay can finish', async () => {
  const { plan } = signedPlan();
  const first = mockRuntime(plan, { receiptError: 'receipt store unavailable' });
  await assert.rejects(executeInstallationLockRecovery(plan, first), (error) => {
    assert.equal(error.code, 'InstallationLockRecoveryReceiptPending');
    assert.equal(error.receipt.state, 'SemanticReconstructionRecovered');
    return true;
  });
  assert.notEqual(first.installationLock, null);
  assert.equal(first.calls.delete, 0);

  const replay = mockRuntime(plan, { installationLock: first.installationLock });
  const receipt = await executeInstallationLockRecovery(plan, replay);
  assert.equal(receipt.succeeded, true);
  assert.equal(receipt.responseLossReplay, true);
  assert.equal(replay.calls.create, 0);
});

test('a malformed durable receipt cannot authorize a replay', async () => {
  const { plan } = signedPlan();
  const runtime = mockRuntime(plan);
  const receipt = await executeInstallationLockRecovery(plan, runtime);
  const malformed = { ...receipt, unbound: true };
  const replay = mockRuntime(plan, {
    installationLock: runtime.installationLock,
    receipt: malformed,
  });
  await assert.rejects(executeInstallationLockRecovery(plan, replay), /receipt.*canonical|malformed/);
  assert.equal(replay.calls.create, 0);
  assert.equal(replay.calls.delete, 0);
});

test('a prior success receipt cannot recreate a subsequently missing lock', async () => {
  const { plan } = signedPlan();
  const initial = mockRuntime(plan);
  const receipt = await executeInstallationLockRecovery(plan, initial);
  const missing = mockRuntime(plan, { receipt, installationLock: null });
  await assert.rejects(
    executeInstallationLockRecovery(plan, missing),
    /receipt exists.*missing or different.*new approval/
  );
  assert.equal(missing.calls.create, 0);
  assert.equal(missing.calls.delete, 0);
  assert.equal(missing.calls.writeReceipt, 0);
});
