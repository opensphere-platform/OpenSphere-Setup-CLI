import test from 'node:test';
import assert from 'node:assert/strict';
import {
  link, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  INSTALLATION_LOCK_RECOVERY_RUNTIME_WORKLOADS,
  canonicalJson,
  sha256,
} from '../src/installation-lock-recovery.mjs';
import {
  createDurableInstallationLockRecoveryReceiptStore as createReceiptStoreImpl,
  createInstallationLockRecoveryRuntime as createRuntimeImpl,
  deleteConfigMapWithPreconditions,
  INSTALLATION_LOCK_RECOVERY_CONFIRMATION,
  recoverInstallationLockFromPlan as recoverInstallationLockFromPlanImpl,
} from '../src/installation-lock-recovery-runtime.mjs';

const mockCustody = {
  ensureDirectoryCustodyFn: async () => {},
  assertDirectoryCustodyFn: async () => {},
  moveNoReplaceFn: async (source, destination) => {
    try {
      await lstat(destination);
      const error = new Error('destination exists');
      error.code = 'EEXIST';
      throw error;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(source, destination);
  },
};
async function recoveryTemp(prefix) {
  const testTempParent = join(tmpdir(), 'opensphere-installation-lock-recovery-tests');
  await mkdir(testTempParent, { recursive: true });
  return mkdtemp(join(await realpath(testTempParent), prefix));
}
function createDurableInstallationLockRecoveryReceiptStore(receiptDirectory, workspaceRoot, options = {}) {
  return createReceiptStoreImpl(receiptDirectory, workspaceRoot, { ...mockCustody, ...options });
}
function createInstallationLockRecoveryRuntime(plan, options = {}) {
  return createRuntimeImpl(plan, { ...mockCustody, ...options });
}
function recoverInstallationLockFromPlan(options) {
  return recoverInstallationLockFromPlanImpl({ ...mockCustody, ...options });
}

function clone(value) { return structuredClone(value); }

function workloadObject(entry, index) {
  const [component, kind, namespace, name, container] = entry;
  const image = `ghcr.io/opensphere-platform/${component}@sha256:${String(index + 1).padStart(64, '0')}`;
  const containerSpec = {
    name: container,
    image,
    ...(name === 'opensphere-console-backend' ? {
      env: [{ name: 'CONSOLE_PUBLIC_URL', value: 'https://localhost:1114' }],
      volumeMounts: [{ name: 'shell-tls', mountPath: '/tls', readOnly: true }],
    } : {}),
  };
  const podSpec = {
    containers: [containerSpec],
    ...(name === 'opensphere-console-backend' ? {
      volumes: [{ name: 'shell-tls', secret: { secretName: 'shell-tls' } }],
    } : {}),
  };
  const metadata = {
    namespace, name, uid: `workload-uid-${index}`, resourceVersion: String(2000 + index), generation: 2,
  };
  const object = kind === 'CronJob' ? {
    apiVersion: 'batch/v1', kind, metadata,
    spec: { suspend: true, jobTemplate: { spec: { template: { spec: podSpec } } } },
  } : {
    apiVersion: 'apps/v1', kind, metadata,
    spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { spec: podSpec } },
    status: { observedGeneration: 2, readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 },
  };
  return { object, image, component, kind, namespace, name, container };
}

function fixture(workspaceRoot, receiptDirectory, localState) {
  const workloadRecords = INSTALLATION_LOCK_RECOVERY_RUNTIME_WORKLOADS.map(workloadObject);
  const objects = new Map();
  const pods = new Map();
  const components = workloadRecords.map((record, index) => {
    objects.set(`${record.kind.toLowerCase()}/${record.namespace}/${record.name}`, record.object);
    if (record.kind !== 'CronJob') {
      pods.set(`${record.namespace}/${record.name}`, { items: [{
        metadata: { name: `${record.name}-pod`, labels: { app: record.name } },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [{
            name: record.container, ready: true,
            imageID: `docker-pullable://${record.image}`,
          }],
        },
      }] });
    }
    return {
      component: record.component,
      kind: record.kind,
      namespace: record.namespace,
      name: record.name,
      container: record.container,
      uid: record.object.metadata.uid,
      resourceVersion: record.object.metadata.resourceVersion,
      image: record.image,
      sourceRevision: '5'.repeat(40),
      ready: true,
      executionState: record.kind === 'CronJob' ? 'SuspendedSafeDefault' : 'Ready',
      podImageIds: record.kind === 'CronJob' ? [] : [record.image],
    };
  });
  const runtimeObservation = {
    contract: 'opensphere.installation-lock.runtime-images/v1',
    observedAt: '2026-08-16T01:00:00.000Z',
    components,
    imageSetDigest: sha256(canonicalJson(components)),
  };
  const pvcs = [
    ['opensphere-console-change', 'opensphere-gitea-data'],
    ['opensphere-console-change', 'opensphere-gitea-postgres-data'],
    ['opensphere-console-data', 'opensphere-supabase-postgres-data'],
    ['opensphere-console-data', 'opensphere-supabase-storage-data'],
  ].map(([namespace, name], index) => ({
    namespace, name, uid: `pvc-uid-${index}`, resourceVersion: String(3000 + index),
    storageClass: 'hostpath', phase: 'Bound',
  }));
  for (const pvc of pvcs) objects.set(`pvc/${pvc.namespace}/${pvc.name}`, {
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { namespace: pvc.namespace, name: pvc.name, uid: pvc.uid, resourceVersion: pvc.resourceVersion },
    spec: { storageClassName: pvc.storageClass }, status: { phase: pvc.phase },
  });
  const resources = [{ apiVersion: 'v1', kind: 'Service', namespace: 'opensphere-console', name: 'console' }];
  const installationEvidence = {
    uid: 'evidence-uid', resourceVersion: '4001', releaseDigest: `sha256:${'a'.repeat(64)}`,
    runtimeImagesMatchLock: true, verifiedAt: '2026-08-15T07:45:38.000Z',
  };
  const releaseInventory = {
    uid: 'inventory-uid', resourceVersion: '4002', releaseDigest: installationEvidence.releaseDigest,
    resourceCount: resources.length, resourceSetDigest: sha256(canonicalJson(resources)),
  };
  objects.set('configmap/opensphere-console/opensphere-installation-evidence', {
    apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { uid: installationEvidence.uid, resourceVersion: installationEvidence.resourceVersion },
    data: { 'evidence.json': JSON.stringify(installationEvidence) },
  });
  objects.set('configmap/opensphere-console/opensphere-release-inventory', {
    apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { uid: releaseInventory.uid, resourceVersion: releaseInventory.resourceVersion },
    data: { 'release-digest': releaseInventory.releaseDigest, 'resources.json': JSON.stringify(resources) },
  });
  const initialAdmin = {
    uid: 'admin-uid', resourceVersion: '4003', username: 'opensphere-admin',
    displayName: 'OpenSphere Administrator', email: 'admin@opensphere.local', state: 'required',
  };
  objects.set('configmap/opensphere-console/opensphere-initial-admin', {
    apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { uid: initialAdmin.uid, resourceVersion: initialAdmin.resourceVersion },
    data: { username: initialAdmin.username, displayName: initialAdmin.displayName,
      email: initialAdmin.email, state: initialAdmin.state },
  });
  const trust = {
    contract: 'opensphere.installation-lock.edge-trust-observation/v1',
    namespace: 'opensphere-console', configMapName: 'opensphere-extension-trusted-keys',
    uid: 'trust-uid', resourceVersion: '4004', keyId: 'opensphere-edge-local-v1',
    publicKeySpkiBase64: 'fixture-spki', publicKeySpkiSha256: sha256('fixture-spki-bytes'),
  };
  objects.set('configmap/opensphere-console/opensphere-extension-trusted-keys', {
    apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { uid: trust.uid, resourceVersion: trust.resourceVersion },
    data: { 'trusted-keys.json': JSON.stringify({ trustedKeys: { [trust.keyId]: trust.publicKeySpkiBase64 } }) },
  });
  const backendObject = objects.get('deployment/opensphere-console/opensphere-console-backend');
  const tlsUsers = [{
    kind: 'Deployment', namespace: 'opensphere-console', name: 'opensphere-console-backend',
    uid: backendObject.metadata.uid, resourceVersion: backendObject.metadata.resourceVersion,
    volumes: [{ name: 'shell-tls', secretName: 'shell-tls' }],
  }];
  const shellTls = {
    mode: 'managed', secretName: 'shell-tls', uid: 'tls-uid', resourceVersion: '4005',
    secretType: 'Opaque', dataKeys: ['ca.crt', 'tls.crt', 'tls.key'],
    workloadSetDigest: sha256(canonicalJson(tlsUsers)),
  };
  const configurationObservation = {
    contract: 'opensphere.installation-lock.config-observation/v1',
    observedAt: '2026-08-16T01:00:00.000Z',
    expectedReleaseJsonSha256: sha256('release'), expectedConfigJsonSha256: sha256('config'),
    installationEvidence, releaseInventory, initialAdmin,
    managedStorage: { storageClass: 'hostpath', pvcCount: 4, pvcSetDigest: sha256(canonicalJson(pvcs)), pvcs },
    backend: { deploymentUid: backendObject.metadata.uid,
      resourceVersion: backendObject.metadata.resourceVersion, consolePublicUrl: 'https://localhost:1114' },
    authEnvironmentReconstruction: {
      value: 'development', status: 'SemanticReconstructionApproved', basis: 'edge-channel-policy',
    },
    shellTls,
  };
  const preconditions = {
    installationLock: 'Absent', oldInstallationLockUid: 'old-lock-uid',
    installationEvidence, releaseInventory, configurationObservation, runtimeObservation,
    runtimeImageSetDigest: runtimeObservation.imageSetDigest,
    configurationObservationDigest: sha256(canonicalJson(configurationObservation)),
    trustObservation: trust,
    recoveryToolingAuthority: { contract: 'fixture-tooling-authority/v1' },
    localState, localInstallationLockCache: 'Absent',
  };
  const plan = {
    contract: 'opensphere.installation-lock.recovery-plan/v1',
    planDigest: `sha256:${'f'.repeat(64)}`,
    preconditions,
    evidence: { preconditionDigest: sha256(canonicalJson(preconditions)), runtimeImageSetDigest: runtimeObservation.imageSetDigest },
    reconstruction: { releaseJsonSha256: sha256('release'), configJsonSha256: sha256('config') },
    releaseDigest: installationEvidence.releaseDigest,
    execution: { kubeContext: 'docker-desktop' },
    manifest: {
      apiVersion: 'v1', kind: 'ConfigMap',
      metadata: { name: 'opensphere-installation-lock', namespace: 'opensphere-console', labels: {}, annotations: {} },
      data: { 'release.json': 'release', 'config.json': 'config' },
    },
  };
  let installationLock = null;
  const calls = [];
  function kubectlFn(args, options = {}) {
    calls.push({ args: [...args], options: clone(options) });
    if (args.join(' ') === 'config current-context') return 'docker-desktop';
    if (args[0] === 'create') {
      installationLock = parseJson(options.input, 'create input');
      installationLock.metadata = { ...installationLock.metadata, uid: 'new-lock-uid', resourceVersion: '5001' };
      return JSON.stringify(installationLock);
    }
    if (args.includes('pods')) {
      const namespace = args[args.indexOf('-n') + 1];
      const selector = args[args.indexOf('-l') + 1];
      const name = selector.replace('app=', '');
      return JSON.stringify(pods.get(`${namespace}/${name}`));
    }
    const kindIndex = args.indexOf('get') + 1;
    const kind = args[kindIndex];
    const name = args[kindIndex + 1];
    const namespace = args.includes('-n') ? args[args.indexOf('-n') + 1] : '';
    if (kind === 'secret') {
      return `${shellTls.uid}\t${shellTls.resourceVersion}\t${shellTls.secretType}\n${shellTls.dataKeys.join('\n')}\n`;
    }
    if (kind === 'configmap' && name === 'opensphere-installation-lock') {
      return installationLock ? JSON.stringify(installationLock) : '';
    }
    const found = objects.get(`${kind}/${namespace}/${name}`);
    if (!found) throw new Error(`unexpected kubectl read: ${args.join(' ')}`);
    return JSON.stringify(found);
  }
  return { plan, kubectlFn, calls, get installationLock() { return installationLock; }, set installationLock(value) { installationLock = value; } };
}

function parseJson(value, label) {
  try { return JSON.parse(value); } catch { throw new Error(`${label} invalid JSON`); }
}

async function tempLayout() {
  const base = await recoveryTemp('opensphere-lock-recovery-');
  const workspace = join(base, 'workspace');
  const receipts = join(base, 'receipts');
  const quarantine = join(base, 'quarantine');
  await mkdir(workspace, { recursive: true });
  await mkdir(quarantine, { recursive: true });
  const filePath = join(quarantine, 'stale.json');
  const staleBase64 = await readFile(new URL(
    './fixtures/stale-current-installation-lock.base64', import.meta.url
  ), 'utf8');
  const staleBytes = Buffer.from(staleBase64.trim(), 'base64');
  await writeFile(filePath, staleBytes);
  const prepared = {
    contract: 'opensphere.installation-lock.stale-quarantine-journal/v1',
    operationId: '20000000-0000-4000-8000-000000000001',
    state: 'PreparedForQuarantine',
    source: {
      workspaceRoot: workspace, path: '.codex-deploy/current-installation-lock.json',
      fileType: 'RegularFile', size: 4654,
      sha256: 'sha256:a74e679607070e8ceab782c11ea0d2317cd8261d9e1fbf0d77dccf139ec75bc1',
      releaseDigest: 'sha256:0a580e9e212f15018a84fd8d227a3dbdbb4b4a274ba7b6bd009861ad63d4d9d4',
      sourceRevision: '4f77114125bde4ad5fcb0478ce8168684d66209f',
    },
    quarantine: {
      directory: quarantine, filePath, fileType: 'RegularFile', size: 4654,
      sha256: 'sha256:a74e679607070e8ceab782c11ea0d2317cd8261d9e1fbf0d77dccf139ec75bc1',
    },
    preparedAt: '2026-08-16T00:01:00.000Z',
    completionTimestamp: '2026-08-16T00:02:00.000Z',
  };
  const preparedBytes = Buffer.from(`${JSON.stringify(prepared, null, 2)}\n`);
  await writeFile(join(quarantine, 'stale.prepared.json'), preparedBytes);
  const journalPath = join(quarantine, 'stale.journal.json');
  const journal = {
    contract: 'opensphere.installation-lock.stale-quarantine-journal/v1',
    operationId: '20000000-0000-4000-8000-000000000001',
    state: 'Quarantined',
    source: {
      workspaceRoot: workspace, path: '.codex-deploy/current-installation-lock.json',
      fileType: 'RegularFile', size: 4654,
      sha256: 'sha256:a74e679607070e8ceab782c11ea0d2317cd8261d9e1fbf0d77dccf139ec75bc1',
      releaseDigest: 'sha256:0a580e9e212f15018a84fd8d227a3dbdbb4b4a274ba7b6bd009861ad63d4d9d4',
      sourceRevision: '4f77114125bde4ad5fcb0478ce8168684d66209f',
    },
    quarantine: {
      directory: quarantine, filePath, fileType: 'RegularFile', size: 4654,
      sha256: 'sha256:a74e679607070e8ceab782c11ea0d2317cd8261d9e1fbf0d77dccf139ec75bc1',
    },
    preparedJournalSha256: sha256(preparedBytes),
    preparedAt: '2026-08-16T00:01:00.000Z',
    completedAt: '2026-08-16T00:02:00.000Z',
  };
  const journalBytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
  await writeFile(journalPath, journalBytes);
  const localState = {
    workspaceRoot: workspace, receiptDirectory: receipts,
    path: '.codex-deploy/current-installation-lock.json',
    status: 'AbsentAfterExactStaleQuarantine',
    quarantine: {
      contract: journal.contract, operationId: journal.operationId, journalPath,
      journalSha256: sha256(journalBytes), filePath, fileType: 'RegularFile',
      fileSha256: journal.quarantine.sha256, size: 4654,
      releaseDigest: journal.source.releaseDigest, sourceRevision: journal.source.sourceRevision,
      completedAt: journal.completedAt, status: 'Quarantined',
    },
  };
  return { base, workspace, receipts, quarantine, localState };
}

test('adapter emits only Secret UID/RV/type/key names across the kubectl child boundary', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const state = fixture(layout.workspace, layout.receipts, layout.localState);
  const receiptStore = await createDurableInstallationLockRecoveryReceiptStore(layout.receipts, layout.workspace);
  const runtime = createInstallationLockRecoveryRuntime(state.plan, {
    kubectlFn: state.kubectlFn, receiptStore,
    deleteWithPreconditionsFn: async () => { throw new Error('delete not expected'); },
  });
  const observed = await runtime.observe();
  assert.equal(observed.preconditionDigest, state.plan.evidence.preconditionDigest);
  assert.equal(observed.installationLock, null);
  await runtime.createConfigMap(state.plan.manifest);
  const verification = await runtime.verifyRecoveredInstallation();
  assert.equal(verification.runtimeImagesMatchLock, true);
  const secretCall = state.calls.find(({ args }) => args.includes('secret'));
  assert.match(secretCall.args.at(-1), /^go-template=/u);
  assert.equal(secretCall.args.includes('json'), false);
});

test('CLI adapter derives custody paths only from the signed plan and persists outside the repo', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const state = fixture(layout.workspace, layout.receipts, layout.localState);
  const planPath = join(layout.base, 'signed-plan.json');
  await writeFile(planPath, JSON.stringify(state.plan));
  const result = await recoverInstallationLockFromPlan({
    planPath,
    confirmation: INSTALLATION_LOCK_RECOVERY_CONFIRMATION,
    kubectlFn: state.kubectlFn,
    validatePlanFn: (value) => value,
    assertToolingAuthorityFn: async () => {},
    executeRecoveryFn: async (plan, runtime) => {
      assert.equal((await runtime.observe()).installationLock, null);
      await runtime.createConfigMap(plan.manifest);
      const verification = await runtime.verifyRecoveredInstallation();
      const receipt = {
        planDigest: plan.planDigest, incidentId: 'incident', approvalId: 'approval',
        recoveredUid: 'new-lock-uid', recoveredResourceVersion: '5001',
        succeeded: true, state: 'SemanticReconstructionRecovered', verification,
      };
      await runtime.writeReceipt(receipt);
      return receipt;
    },
  });
  assert.equal(result.state, 'SemanticReconstructionRecovered');
  const history = join(layout.receipts, state.plan.planDigest.replace('sha256:', ''));
  assert.deepEqual(await readdir(history), ['00000001.json']);
  assert.equal((await readFile(join(history, '00000001.json'), 'utf8')).includes('new-lock-uid'), true);
  const cliSource = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(cliSource, /recover-installation-lock/u);
  assert.match(cliSource, /workspace and receipt paths are signed plan fields and cannot be overridden/u);
});

test('ambiguous create response is fenced for exact GET recovery', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const state = fixture(layout.workspace, layout.receipts, layout.localState);
  const receiptStore = await createDurableInstallationLockRecoveryReceiptStore(layout.receipts, layout.workspace);
  const kubectlFn = (args, options) => {
    if (args[0] !== 'create') return state.kubectlFn(args, options);
    state.kubectlFn(args, options);
    throw new Error('connection closed after request bytes were sent');
  };
  const runtime = createInstallationLockRecoveryRuntime(state.plan, {
    kubectlFn, receiptStore, deleteWithPreconditionsFn: async () => {},
  });
  await assert.rejects(runtime.createConfigMap(state.plan.manifest), (error) => {
    assert.equal(error.code, 'ResponseLost');
    return true;
  });
  assert.equal((await runtime.observe()).installationLock.metadata.uid, 'new-lock-uid');
});

test('docker-desktop context is revalidated before every Kubernetes boundary', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const state = fixture(layout.workspace, layout.receipts, layout.localState);
  const receiptStore = await createDurableInstallationLockRecoveryReceiptStore(layout.receipts, layout.workspace);
  let mutationCalls = 0;
  const wrongContext = (args, options) => {
    if (args.join(' ') === 'config current-context') return 'production-cluster';
    if (args.includes('get') || args[0] === 'create') mutationCalls += 1;
    return state.kubectlFn(args, options);
  };
  const runtime = createInstallationLockRecoveryRuntime(state.plan, {
    kubectlFn: wrongContext, receiptStore,
    deleteWithPreconditionsFn: async () => { mutationCalls += 1; },
  });
  await assert.rejects(runtime.observe(), /requires Kubernetes context docker-desktop/u);
  await assert.rejects(runtime.createConfigMap(state.plan.manifest), /requires Kubernetes context docker-desktop/u);
  await assert.rejects(runtime.deleteConfigMap({ uid: 'x', resourceVersion: '1' }),
    /requires Kubernetes context docker-desktop/u);
  assert.equal(mutationCalls, 0);
});

test('recovery CronJobs must remain suspended safe defaults', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const state = fixture(layout.workspace, layout.receipts, layout.localState);
  const receiptStore = await createDurableInstallationLockRecoveryReceiptStore(layout.receipts, layout.workspace);
  const drifted = (args, options) => {
    const output = state.kubectlFn(args, options);
    if (args.includes('get') && args.includes('cronjob')) {
      const object = JSON.parse(output);
      object.spec.suspend = false;
      return JSON.stringify(object);
    }
    return output;
  };
  const runtime = createInstallationLockRecoveryRuntime(state.plan, {
    kubectlFn: drifted, receiptStore,
  });
  await assert.rejects(runtime.observe(), /runtime state drifted/u);
});

test('signed workspace/receipt paths, confirmation, stale cache, and immutable plan fail before mutation', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const state = fixture(layout.workspace, layout.receipts, layout.localState);
  const planPath = join(layout.base, 'plan.json');
  await writeFile(planPath, JSON.stringify(state.plan));
  await assert.rejects(recoverInstallationLockFromPlan({
    planPath, confirmation: 'WRONG', kubectlFn: state.kubectlFn,
    validatePlanFn: (value) => value, executeRecoveryFn: async () => {},
    assertToolingAuthorityFn: async () => {},
  }), /requires --confirm/u);
  assert.equal(state.calls.length, 0);
  const hardLinkedPlan = join(layout.base, 'hard-linked-plan.json');
  await link(planPath, hardLinkedPlan);
  await assert.rejects(recoverInstallationLockFromPlan({
    planPath,
    confirmation: INSTALLATION_LOCK_RECOVERY_CONFIRMATION,
    kubectlFn: state.kubectlFn,
    validatePlanFn: (value) => value,
    assertToolingAuthorityFn: async () => {},
    executeRecoveryFn: async () => {},
  }), /immutable unique regular file/u);
  await unlink(hardLinkedPlan);
  assert.equal(state.calls.length, 0);
  await assert.rejects(recoverInstallationLockFromPlan({
    planPath, confirmation: INSTALLATION_LOCK_RECOVERY_CONFIRMATION,
    kubectlFn: state.kubectlFn, validatePlanFn: (value) => value,
    assertToolingAuthorityFn: async () => { throw new Error('reviewed tooling drift'); },
    executeRecoveryFn: async () => {},
  }), /reviewed tooling drift/u);
  assert.equal(state.calls.length, 0);
  await mkdir(join(layout.workspace, '.codex-deploy'), { recursive: true });
  await writeFile(join(layout.workspace, '.codex-deploy', 'current-installation-lock.json'), '{}');
  await assert.rejects(recoverInstallationLockFromPlan({
    planPath, confirmation: INSTALLATION_LOCK_RECOVERY_CONFIRMATION, kubectlFn: state.kubectlFn,
    validatePlanFn: (value) => value, executeRecoveryFn: async () => {},
    assertToolingAuthorityFn: async () => {},
  }), /must be absent/u);
  assert.equal(state.calls.length, 0);
  await rm(join(layout.workspace, '.codex-deploy', 'current-installation-lock.json'));
  await writeFile(planPath, JSON.stringify(state.plan));
  await assert.rejects(recoverInstallationLockFromPlan({
    planPath, confirmation: INSTALLATION_LOCK_RECOVERY_CONFIRMATION, kubectlFn: state.kubectlFn,
    validatePlanFn: (value) => value,
    assertToolingAuthorityFn: async () => {},
    executeRecoveryFn: async (_plan, runtime) => {
      await writeFile(planPath, `${JSON.stringify(state.plan)}\n`);
      return runtime.observe();
    },
  }), /changed during execution/u);
  assert.equal(state.calls.length, 0);
});

test('append-only receipts allow NeedsAttention to terminal success but never rolled-back reuse', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const store = await createDurableInstallationLockRecoveryReceiptStore(layout.receipts, layout.workspace);
  const digest = `sha256:${'a'.repeat(64)}`;
  const needsAttention = {
    planDigest: digest, incidentId: 'incident', approvalId: 'approval', recoveredUid: 'uid',
    succeeded: false, state: 'NeedsAttentionPreservedExactObject',
  };
  const success = { ...needsAttention, succeeded: true, state: 'SemanticReconstructionRecovered' };
  await store.write(digest, needsAttention);
  await store.write(digest, success);
  assert.deepEqual(await store.read(digest), success);
  const history = await readdir(join(layout.receipts, digest.replace('sha256:', '')));
  assert.deepEqual(history.sort(), ['00000001.json', '00000002.json']);
  const historyPath = join(layout.receipts, digest.replace('sha256:', ''));
  await writeFile(join(historyPath, '00000004.json'), JSON.stringify(success));
  await assert.rejects(store.read(digest), /not contiguous/u);
  await rm(join(historyPath, '00000004.json'));
  await writeFile(join(historyPath, 'unexpected.txt'), 'x');
  await assert.rejects(store.read(digest), /unknown or irregular/u);
  await rm(join(historyPath, 'unexpected.txt'));
  await link(join(historyPath, '00000002.json'), join(historyPath, '00000003.json'));
  await assert.rejects(store.read(digest), /unique regular file/u);
  await rm(join(historyPath, '00000003.json'));
  const rolledDigest = `sha256:${'b'.repeat(64)}`;
  const rolled = { ...needsAttention, planDigest: rolledDigest, state: 'RolledBackToMissing' };
  await store.write(rolledDigest, rolled);
  await assert.rejects(store.write(rolledDigest, { ...success, planDigest: rolledDigest }), /append-only/u);
  const claimedDigest = `sha256:${'d'.repeat(64)}`;
  const claimed = { ...needsAttention, planDigest: claimedDigest, state: 'RollbackClaimed' };
  const completed = { ...claimed, state: 'RolledBackToMissing' };
  await store.write(claimedDigest, claimed);
  await store.write(claimedDigest, completed);
  assert.deepEqual(await store.read(claimedDigest), completed);
});

test('concurrent identical receipt append converges without exposing temporary revisions', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const store = await createDurableInstallationLockRecoveryReceiptStore(layout.receipts, layout.workspace);
  const digest = `sha256:${'c'.repeat(64)}`;
  const receipt = {
    planDigest: digest, incidentId: 'incident', approvalId: 'approval',
    recoveredUid: 'uid', recoveredResourceVersion: '1', succeeded: true,
    state: 'SemanticReconstructionRecovered',
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => store.write(digest, receipt)));
  assert.deepEqual(results, Array.from({ length: 8 }, () => receipt));
  assert.deepEqual(await readdir(join(layout.receipts, digest.replace('sha256:', ''))),
    ['00000001.json']);
  assert.deepEqual(await store.read(digest), receipt);
  assert.equal((await lstat(join(layout.receipts, digest.replace('sha256:', ''),
    '00000001.json'))).nlink, 1);
  assert.deepEqual(await readdir(join(layout.receipts, '.tmp')), []);
  assert.deepEqual(await readdir(join(layout.receipts, '.staging')), []);
});

test('custody scan tolerates vanished peer files but rejects irregular replacements', async (t) => {
  for (const folder of ['.tmp', '.staging']) {
    for (const scenario of ['removed', 'hard-link', 'directory']) {
      await t.test(`${folder}/${scenario}`, async (t) => {
        const layout = await tempLayout();
        t.after(() => rm(layout.base, { recursive: true, force: true }));
        const digest = `sha256:${'6'.repeat(64)}`;
        const receipt = { planDigest: digest, incidentId: 'incident', approvalId: 'approval',
          recoveredUid: 'uid', succeeded: true, state: 'SemanticReconstructionRecovered' };
        const store = await createDurableInstallationLockRecoveryReceiptStore(
          layout.receipts, layout.workspace, {
            readCustodyEntriesFn: async (path, options) => {
              const entries = await readdir(path, options);
              if (path === join(layout.receipts, folder) && entries.length) {
                const peerFile = join(path, entries[0].name);
                await unlink(peerFile);
                if (scenario === 'hard-link') {
                  const other = join(layout.base, 'other-receipt.json');
                  await writeFile(other, JSON.stringify(receipt));
                  await link(other, peerFile);
                }
                if (scenario === 'directory') await mkdir(peerFile);
              }
              return entries;
            },
          }
        );
        const name = folder === '.tmp' ? `${'6'.repeat(64)}.00000001.json`
          : `${'6'.repeat(64)}.00000001.${'8'.repeat(32)}.candidate`;
        await writeFile(join(layout.receipts, folder, name), JSON.stringify(receipt));
        if (scenario === 'removed') {
          // A transient peer file is not a durable receipt, even when observed
          // immediately before the peer moves or cleans it up.
          assert.equal(await store.read(digest), null);
          assert.deepEqual(await readdir(join(layout.receipts, folder)), []);
        } else {
          await assert.rejects(store.read(digest), /unique regular file|irregular candidate/u);
        }
      });
    }
  }
});
test('temporary receipt cleanup accepts a peer removal only with the exact final revision', async (t) => {
  for (const scenario of ['identical', 'missing', 'different', 'access-denied']) {
    await t.test(scenario, async (t) => {
      const layout = await tempLayout();
      t.after(() => rm(layout.base, { recursive: true, force: true }));
      const digest = 'sha256:' + '7'.repeat(64);
      const receipt = {
        planDigest: digest, incidentId: 'incident', approvalId: 'approval',
        recoveredUid: 'uid', recoveredResourceVersion: '1', succeeded: true,
        state: 'SemanticReconstructionRecovered',
      };
      const finalPath = join(layout.receipts, '7'.repeat(64), '00000001.json');
      const store = await createDurableInstallationLockRecoveryReceiptStore(
        layout.receipts, layout.workspace, {
          moveNoReplaceFn: async (source, destination) => {
            if (destination === finalPath) {
              // A concurrent writer has persisted the final revision while an
              // identical pending revision still awaits cleanup.
              await writeFile(destination, await readFile(source), { flag: 'wx' });
              return;
            }
            await mockCustody.moveNoReplaceFn(source, destination);
          },
          unlinkTemporaryFn: async (path) => {
            if (scenario === 'access-denied') {
              throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
            }
            // A peer removes the pending file between the validated read and unlink.
            await unlink(path);
            if (scenario === 'missing') await unlink(finalPath);
            if (scenario === 'different') {
              await writeFile(finalPath, JSON.stringify({ ...receipt, recoveredUid: 'other' }));
            }
            await unlink(path);
          },
        }
      );
      if (scenario === 'identical') {
        assert.deepEqual(await store.write(digest, receipt), receipt);
        assert.deepEqual(await store.read(digest), receipt);
        assert.deepEqual(await readdir(join(layout.receipts, '.tmp')), []);
      } else {
        await assert.rejects(store.write(digest, receipt), scenario === 'access-denied'
          ? /cleanup denied/u : /lost its exact final revision/u);
      }
    });
  }
});

test('temporary receipt EPERM retry preserves exact final and pending bytes', async (t) => {
  for (const scenario of ['transient', 'peer-removed', 'permanent', 'final-missing', 'pending-different']) {
    await t.test(scenario, async (t) => {
      const layout = await tempLayout();
      t.after(() => rm(layout.base, { recursive: true, force: true }));
      const digest = 'sha256:' + '4'.repeat(64);
      const receipt = { planDigest: digest, incidentId: 'incident', approvalId: 'approval',
        recoveredUid: 'uid', recoveredResourceVersion: '1', succeeded: true,
        state: 'SemanticReconstructionRecovered' };
      const finalPath = join(layout.receipts, '4'.repeat(64), '00000001.json');
      let attempts = 0;
      const store = await createDurableInstallationLockRecoveryReceiptStore(layout.receipts, layout.workspace, {
        moveNoReplaceFn: async (source, destination) => {
          if (destination === finalPath) { await writeFile(destination, await readFile(source), { flag: 'wx' }); return; }
          await mockCustody.moveNoReplaceFn(source, destination);
        },
        unlinkTemporaryFn: async (path) => {
          attempts += 1;
          if (attempts === 1 || scenario === 'permanent') {
            if (scenario === 'peer-removed') await unlink(path);
            if (scenario === 'final-missing') await unlink(finalPath);
            if (scenario === 'pending-different') await writeFile(path, JSON.stringify({ ...receipt, recoveredUid: 'other' }));
            throw Object.assign(new Error('temporary cleanup EPERM'), { code: 'EPERM' });
          }
          await unlink(path);
        },
      });
      if (['transient', 'peer-removed'].includes(scenario)) {
        assert.deepEqual(await store.write(digest, receipt), receipt);
        assert.deepEqual(await readdir(join(layout.receipts, '.tmp')), []);
        assert.equal(attempts, scenario === 'transient' ? 2 : 1);
      } else {
        await assert.rejects(store.write(digest, receipt), scenario === 'permanent'
          ? /temporary cleanup EPERM/u : scenario === 'final-missing'
            ? /lost its exact final revision/u : /encountered different bytes/u);
        assert.equal(attempts, scenario === 'permanent' ? 4 : 1);
      }
    });
  }
});

test('actual Windows no-replace receipt promotion converges across eight writers', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only no-replace receipt promotion');
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const store = await createReceiptStoreImpl(layout.receipts, layout.workspace);
  const digest = `sha256:${'5'.repeat(64)}`;
  const receipt = {
    planDigest: digest, incidentId: 'incident', approvalId: 'approval',
    recoveredUid: 'uid', recoveredResourceVersion: '1', succeeded: true,
    state: 'SemanticReconstructionRecovered',
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => store.write(digest, receipt)));
  assert.deepEqual(results, Array.from({ length: 8 }, () => receipt));
  const finalPath = join(layout.receipts, '5'.repeat(64), '00000001.json');
  assert.equal((await lstat(finalPath)).nlink, 1);
  assert.deepEqual(await readdir(join(layout.receipts, '.tmp')), []);
  assert.deepEqual(await readdir(join(layout.receipts, '.staging')), []);
});

test('receipt append resumes a unique staging pre-move crash without hard-link residue', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const digest = `sha256:${'6'.repeat(64)}`;
  const receipt = {
    planDigest: digest, incidentId: 'incident', approvalId: 'approval',
    recoveredUid: 'uid', recoveredResourceVersion: '1', succeeded: true,
    state: 'SemanticReconstructionRecovered',
  };
  const interrupted = await createReceiptStoreImpl(layout.receipts, layout.workspace, {
    ...mockCustody,
    moveNoReplaceFn: async () => { throw new Error('crash before MoveFile'); },
  });
  await assert.rejects(interrupted.write(digest, receipt), (error) => {
    assert.equal(error.code, 'InstallationLockRecoveryReceiptCandidateMovePending');
    return true;
  });
  const staged = await readdir(join(layout.receipts, '.staging'));
  assert.equal(staged.length, 1);
  const stagedPath = join(layout.receipts, '.staging', staged[0]);
  assert.equal((await lstat(stagedPath)).nlink, 1);
  assert.deepEqual(await readdir(join(layout.receipts, '.tmp')), []);
  const resumed = await createDurableInstallationLockRecoveryReceiptStore(
    layout.receipts, layout.workspace
  );
  assert.deepEqual(await resumed.write(digest, receipt), receipt);
  assert.deepEqual(await readdir(join(layout.receipts, '.tmp')), []);
  const finalPath = join(layout.receipts, '6'.repeat(64), '00000001.json');
  assert.equal((await lstat(finalPath)).nlink, 1);
});

test('repeated partial unique staging candidates are non-authoritative and cannot block restart', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const digest = `sha256:${'9'.repeat(64)}`;
  const receipt = {
    planDigest: digest, incidentId: 'incident', approvalId: 'approval',
    recoveredUid: 'uid', recoveredResourceVersion: '1', succeeded: true,
    state: 'SemanticReconstructionRecovered',
  };
  await createDurableInstallationLockRecoveryReceiptStore(layout.receipts, layout.workspace);
  const partialNames = Array.from({ length: 16 }, (_unused, index) =>
    `${'9'.repeat(64)}.00000001.${index.toString(16).padStart(32, '0')}.candidate`);
  for (const [index, name] of partialNames.entries()) {
    await writeFile(join(layout.receipts, '.staging', name),
      `{"planDigest":${index}`, { flag: 'wx' });
  }
  await assert.rejects(lstat(join(layout.receipts, '9'.repeat(64), '00000001.json')),
    { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(layout.receipts, '.tmp')), []);
  const restarted = await createDurableInstallationLockRecoveryReceiptStore(
    layout.receipts, layout.workspace
  );
  assert.deepEqual(await restarted.write(digest, receipt), receipt);
  assert.deepEqual(await restarted.read(digest), receipt);
  assert.deepEqual(await readdir(join(layout.receipts, '.tmp')), []);
  assert.deepEqual((await readdir(join(layout.receipts, '.staging'))).sort(),
    [...partialNames].sort());
  for (const [index, name] of partialNames.entries()) {
    const partialPath = join(layout.receipts, '.staging', name);
    assert.equal(await readFile(partialPath, 'utf8'), `{"planDigest":${index}`);
    assert.equal((await lstat(partialPath)).nlink, 1);
  }
  const finalPath = join(layout.receipts, '9'.repeat(64), '00000001.json');
  assert.equal((await lstat(finalPath)).nlink, 1);
  const unknown = join(layout.receipts, '.staging', 'unexpected.txt');
  await writeFile(unknown, 'not a candidate');
  const rescanned = await createDurableInstallationLockRecoveryReceiptStore(
    layout.receipts, layout.workspace
  );
  await assert.rejects(rescanned.read(digest), /staging directory contains an unknown artifact/u);
  await rm(unknown);
});

test('receipt move response loss accepts exact final and removes only exact temp', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const digest = `sha256:${'7'.repeat(64)}`;
  const receipt = {
    planDigest: digest, incidentId: 'incident', approvalId: 'approval',
    recoveredUid: 'uid', recoveredResourceVersion: '1', succeeded: true,
    state: 'SemanticReconstructionRecovered',
  };
  const store = await createReceiptStoreImpl(layout.receipts, layout.workspace, {
    ...mockCustody,
    moveNoReplaceFn: async (source, destination) => {
      await rename(source, destination);
      throw new Error('response lost after MoveFile completed');
    },
  });
  assert.deepEqual(await store.write(digest, receipt), receipt);
  const finalPath = join(layout.receipts, '7'.repeat(64), '00000001.json');
  assert.equal((await lstat(finalPath)).nlink, 1);
  assert.deepEqual(await readdir(join(layout.receipts, '.tmp')), []);
});

test('receipt no-replace collision preserves different final and exact pending temp', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const digest = `sha256:${'8'.repeat(64)}`;
  const receipt = {
    planDigest: digest, incidentId: 'incident', approvalId: 'approval',
    recoveredUid: 'uid', recoveredResourceVersion: '1', succeeded: true,
    state: 'SemanticReconstructionRecovered',
  };
  const foreign = { ...receipt, recoveredUid: 'foreign' };
  const store = await createReceiptStoreImpl(layout.receipts, layout.workspace, {
    ...mockCustody,
    moveNoReplaceFn: async (source, destination) => {
      const finalPath = join(layout.receipts, '8'.repeat(64), '00000001.json');
      if (destination === finalPath) {
        await writeFile(destination, `${JSON.stringify(foreign)}\n`, { flag: 'wx' });
        throw new Error('destination won concurrently');
      }
      await mockCustody.moveNoReplaceFn(source, destination);
    },
  });
  await assert.rejects(store.write(digest, receipt), /differs from this append/u);
  const finalPath = join(layout.receipts, '8'.repeat(64), '00000001.json');
  assert.deepEqual(JSON.parse(await readFile(finalPath, 'utf8')), foreign);
  const tempPath = join(layout.receipts, '.tmp', `${'8'.repeat(64)}.00000001.json`);
  assert.deepEqual(JSON.parse(await readFile(tempPath, 'utf8')), receipt);
  assert.deepEqual(await readdir(join(layout.receipts, '.staging')), []);
  assert.equal((await lstat(finalPath)).nlink, 1);
  assert.equal((await lstat(tempPath)).nlink, 1);
});

test('receipt custody rejects a directory junction replacement after identity capture', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const store = await createDurableInstallationLockRecoveryReceiptStore(layout.receipts, layout.workspace);
  const original = `${layout.receipts}-original`;
  const replacement = `${layout.receipts}-replacement`;
  await mkdir(replacement);
  await rename(layout.receipts, original);
  await symlink(replacement, layout.receipts, 'junction');
  await assert.rejects(store.read(`sha256:${'e'.repeat(64)}`), /symlink or junction|identity changed/u);
});

test('direct Kubernetes DELETE sends exact UID and resourceVersion DeleteOptions', async () => {
  let request;
  const kubeconfig = {
    'current-context': 'ctx',
    contexts: [{ name: 'ctx', context: { cluster: 'cluster', user: 'user' } }],
    clusters: [{ name: 'cluster', cluster: {
      server: 'https://127.0.0.1:6443', 'certificate-authority-data': Buffer.from('ca').toString('base64'),
    } }],
    users: [{ name: 'user', user: { token: 'token' } }],
  };
  await deleteConfigMapWithPreconditions({
    namespace: 'opensphere-console', name: 'opensphere-installation-lock',
    uid: 'owned-uid', resourceVersion: '5001',
    kubectlFn: (args) => args.join(' ') === 'config current-context'
      ? 'docker-desktop' : JSON.stringify(kubeconfig),
    requestFn: async (options, body) => {
      request = { options, body: JSON.parse(body) };
      return { statusCode: 200, body: JSON.stringify({ metadata: { uid: 'owned-uid' } }) };
    },
  });
  assert.equal(request.options.method, 'DELETE');
  assert.equal(request.options.path,
    '/api/v1/namespaces/opensphere-console/configmaps/opensphere-installation-lock');
  assert.deepEqual(request.body.preconditions, { uid: 'owned-uid', resourceVersion: '5001' });
  assert.equal(request.body.kind, 'DeleteOptions');
  await assert.rejects(deleteConfigMapWithPreconditions({
    namespace: 'opensphere-console', name: 'opensphere-installation-lock',
    uid: 'owned-uid', resourceVersion: 'stale-rv',
    kubectlFn: (args) => args.join(' ') === 'config current-context'
      ? 'docker-desktop' : JSON.stringify(kubeconfig), requestFn: async () => {
      throw new Error('request boundary must not run for malformed preconditions');
    },
  }), /preconditions are incomplete/u);
  await assert.rejects(deleteConfigMapWithPreconditions({
    namespace: 'opensphere-console', name: 'opensphere-installation-lock',
    uid: 'owned-uid', resourceVersion: '5001',
    kubectlFn: (args) => args.join(' ') === 'config current-context'
      ? 'docker-desktop' : JSON.stringify(kubeconfig),
    requestFn: async () => ({ statusCode: 409, body: '{"kind":"Status"}' }),
  }), /status 409/u);
});

test('rollback mismatch never reaches the direct DELETE boundary', async (t) => {
  const layout = await tempLayout();
  t.after(() => rm(layout.base, { recursive: true, force: true }));
  const state = fixture(layout.workspace, layout.receipts, layout.localState);
  state.installationLock = {
    ...clone(state.plan.manifest),
    metadata: { ...clone(state.plan.manifest.metadata), uid: 'other-uid', resourceVersion: '9999' },
  };
  const receiptStore = await createDurableInstallationLockRecoveryReceiptStore(layout.receipts, layout.workspace);
  let deletes = 0;
  const runtime = createInstallationLockRecoveryRuntime(state.plan, {
    kubectlFn: state.kubectlFn, receiptStore,
    deleteWithPreconditionsFn: async () => { deletes += 1; },
  });
  await assert.rejects(runtime.deleteConfigMap({ uid: 'owned-uid', resourceVersion: '5001' }),
    /rollback precondition drifted/u);
  assert.equal(deletes, 0);
});
