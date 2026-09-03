import {
  lstat, mkdir, open, readFile, readdir, realpath, unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  canonicalJson,
  executeInstallationLockRecovery,
  INSTALLATION_LOCK_RECOVERY_RUNTIME_WORKLOADS,
  sha256,
  validateInstallationLockRecoveryPlan,
} from './installation-lock-recovery.mjs';
import {
  assertInstallationLockRecoveryLocalState,
  atomicNoReplaceMove,
} from './installation-lock-recovery-local.mjs';
import { assertInstallationLockRecoveryToolingAuthority } from './installation-lock-recovery-prepare.mjs';
import {
  assertInstallationLockRecoveryPrivateDirectory,
  ensureInstallationLockRecoveryPrivateDirectory,
} from './installation-lock-recovery-windows-custody.mjs';
import { kubectl } from './process.mjs';

export const INSTALLATION_LOCK_RECOVERY_CONFIRMATION =
  'RECOVER-MISSING-INSTALLATION-LOCK';
const NAMESPACE = 'opensphere-console';
const LOCK_NAME = 'opensphere-installation-lock';

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}

function exact(value, expected, label) {
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error(`${label} drifted from the signed recovery plan`);
  }
  return value;
}

function getJson(kubectlFn, kind, namespace, name, { optional = false } = {}) {
  const output = kubectlFn([
    ...(namespace ? ['-n', namespace] : []),
    'get', kind, name, ...(optional ? ['--ignore-not-found'] : []), '-o', 'json',
  ], { capture: true });
  if (!String(output).trim()) return null;
  return parseJson(output, `${kind}/${name}`);
}

function getSecretMetadata(kubectlFn, namespace, name) {
  const template = [
    '{{.metadata.uid}}', '{{"\\t"}}', '{{.metadata.resourceVersion}}', '{{"\\t"}}',
    '{{.type}}', '{{"\\n"}}', '{{range $key, $_ := .data}}{{$key}}{{"\\n"}}{{end}}',
  ].join('');
  const output = String(kubectlFn([
    '-n', namespace, 'get', 'secret', name, '-o', `go-template=${template}`,
  ], { capture: true }));
  const [header = '', ...keys] = output.split(/\r?\n/u).filter((line) => line.length > 0);
  const [uid, resourceVersion, secretType, extra] = header.split('\t');
  if (!uid || !resourceVersion || !secretType || extra !== undefined) {
    throw new Error(`Secret/${namespace}/${name} metadata projection is invalid`);
  }
  return { uid, resourceVersion, secretType, dataKeys: keys.sort() };
}

function identity(object, expected, label) {
  const actual = {
    uid: String(object?.metadata?.uid ?? ''),
    resourceVersion: String(object?.metadata?.resourceVersion ?? ''),
  };
  exact(actual, {
    uid: expected.uid,
    resourceVersion: expected.resourceVersion,
  }, label);
  return actual;
}

function workloadSpec(object) {
  return object.kind === 'CronJob'
    ? object.spec?.jobTemplate?.spec?.template?.spec
    : object.spec?.template?.spec;
}

function workloadContainer(object, container, expectedSourceRevision) {
  const spec = workloadSpec(object);
  const selected = (spec?.containers ?? []).find((item) => item.name === container);
  if (!selected) throw new Error(`${object.kind}/${object.metadata?.name} lacks container ${container}`);
  const values = [
    ...(selected.env ?? []).filter((item) => item.name === 'OS_SOURCE_REVISION').map((item) => item.value),
    object.metadata?.annotations?.['opensphere.io/source-revision'],
    object.metadata?.labels?.['io.opensphere.source-revision'],
  ].filter(Boolean);
  if (new Set(values).size > 1 || values.some((value) => value !== expectedSourceRevision)) {
    throw new Error(`${object.kind}/${object.metadata?.name} has conflicting observed source provenance`);
  }
  return selected;
}

function readyWorkload(object) {
  if (object.kind === 'CronJob') return object.spec?.suspend === true;
  const desired = Number(object.spec?.replicas ?? 1);
  return Number(object.status?.observedGeneration ?? 0) >= Number(object.metadata?.generation ?? 0)
    && Number(object.status?.readyReplicas ?? 0) === desired
    && Number(object.status?.updatedReplicas ?? 0) === desired
    && (object.kind !== 'Deployment' || Number(object.status?.availableReplicas ?? 0) === desired);
}

function selectorText(object) {
  const selector = object.spec?.selector?.matchLabels;
  if (!selector || Object.keys(selector).length === 0) {
    throw new Error(`${object.kind}/${object.metadata?.name} has no exact Pod selector`);
  }
  return Object.entries(selector).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join(',');
}

function normalizeImageId(value) {
  return String(value ?? '').replace(/^(?:docker-pullable|containerd):\/\//u, '');
}

function observeRuntime(plan, kubectlFn) {
  const expected = plan.preconditions.runtimeObservation;
  if (!Array.isArray(expected?.components)
      || expected.components.length !== INSTALLATION_LOCK_RECOVERY_RUNTIME_WORKLOADS.length) {
    throw new Error('signed runtime observation is not canonical');
  }
  const objects = new Map();
  const components = expected.components.map((entry, index) => {
    const mapping = INSTALLATION_LOCK_RECOVERY_RUNTIME_WORKLOADS[index];
    exact(
      [entry.component, entry.kind, entry.namespace, entry.name, entry.container],
      mapping,
      `runtime workload mapping ${index}`
    );
    const object = getJson(kubectlFn, entry.kind.toLowerCase(), entry.namespace, entry.name);
    objects.set(`${entry.namespace}/${entry.kind}/${entry.name}`, object);
    identity(object, entry, `${entry.kind}/${entry.namespace}/${entry.name}`);
    const selected = workloadContainer(object, entry.container, entry.sourceRevision);
    if (selected.image !== entry.image || readyWorkload(object) !== true) {
      throw new Error(`${entry.kind}/${entry.namespace}/${entry.name} runtime state drifted`);
    }
    let podImageIds = [];
    if (entry.kind !== 'CronJob') {
      const pods = parseJson(kubectlFn([
        '-n', entry.namespace, 'get', 'pods', '-l', selectorText(object), '-o', 'json',
      ], { capture: true }), `Pods for ${entry.name}`);
      podImageIds = (pods.items ?? []).filter((pod) =>
        !pod.metadata?.deletionTimestamp
        && (pod.status?.conditions ?? []).some((condition) =>
          condition.type === 'Ready' && condition.status === 'True'))
        .map((pod) => {
          const status = (pod.status?.containerStatuses ?? [])
            .find((item) => item.name === entry.container);
          if (!status?.ready) throw new Error(`Ready Pod for ${entry.name} lacks ready ${entry.container}`);
          const imageId = normalizeImageId(status.imageID);
          if (imageId !== entry.image) throw new Error(`Pod imageID drifted for ${entry.name}/${entry.container}`);
          return imageId;
        }).sort();
      if (podImageIds.length === 0) throw new Error(`no Ready Pod imageID exists for ${entry.name}`);
    }
    const actual = {
      component: entry.component,
      kind: entry.kind,
      namespace: entry.namespace,
      name: entry.name,
      container: entry.container,
      uid: object.metadata.uid,
      resourceVersion: object.metadata.resourceVersion,
      image: selected.image,
      sourceRevision: entry.sourceRevision,
      ready: true,
      executionState: entry.kind === 'CronJob' ? 'SuspendedSafeDefault' : 'Ready',
      podImageIds,
    };
    exact(actual, entry, `runtime workload ${entry.name}`);
    return actual;
  });
  const actual = {
    contract: expected.contract,
    observedAt: expected.observedAt,
    components,
    imageSetDigest: sha256(canonicalJson(components)),
  };
  exact(actual, expected, 'runtime image observation');
  return { observation: actual, objects };
}

function observeConfiguration(plan, kubectlFn, runtimeObjects) {
  const expected = plan.preconditions.configurationObservation;
  const evidenceCm = getJson(kubectlFn, 'configmap', NAMESPACE, 'opensphere-installation-evidence');
  identity(evidenceCm, expected.installationEvidence, 'installation evidence');
  const evidenceData = parseJson(evidenceCm.data?.['evidence.json'] ?? '', 'installation evidence');
  const installationEvidence = {
    uid: evidenceCm.metadata.uid,
    resourceVersion: evidenceCm.metadata.resourceVersion,
    releaseDigest: evidenceData.releaseDigest,
    runtimeImagesMatchLock: evidenceData.runtimeImagesMatchLock,
    verifiedAt: evidenceData.verifiedAt,
  };
  exact(installationEvidence, expected.installationEvidence, 'installation evidence');

  const inventoryCm = getJson(kubectlFn, 'configmap', NAMESPACE, 'opensphere-release-inventory');
  identity(inventoryCm, expected.releaseInventory, 'release inventory');
  const resources = parseJson(inventoryCm.data?.['resources.json'] ?? '', 'release inventory');
  const releaseInventory = {
    uid: inventoryCm.metadata.uid,
    resourceVersion: inventoryCm.metadata.resourceVersion,
    releaseDigest: inventoryCm.data?.['release-digest'],
    resourceCount: resources.length,
    resourceSetDigest: sha256(canonicalJson(resources)),
  };
  exact(releaseInventory, expected.releaseInventory, 'release inventory');

  const adminCm = getJson(kubectlFn, 'configmap', NAMESPACE, 'opensphere-initial-admin');
  const initialAdmin = {
    uid: adminCm.metadata.uid,
    resourceVersion: adminCm.metadata.resourceVersion,
    username: adminCm.data?.username,
    displayName: adminCm.data?.displayName,
    email: adminCm.data?.email,
    state: adminCm.data?.state,
  };
  exact(initialAdmin, expected.initialAdmin, 'initial admin observation');

  const pvcs = expected.managedStorage.pvcs.map((item) => {
    const pvc = getJson(kubectlFn, 'pvc', item.namespace, item.name);
    return {
      namespace: item.namespace,
      name: item.name,
      uid: pvc.metadata.uid,
      resourceVersion: pvc.metadata.resourceVersion,
      storageClass: pvc.spec?.storageClassName,
      phase: pvc.status?.phase,
    };
  });
  const managedStorage = {
    storageClass: expected.managedStorage.storageClass,
    pvcCount: pvcs.length,
    pvcSetDigest: sha256(canonicalJson(pvcs)),
    pvcs,
  };
  exact(managedStorage, expected.managedStorage, 'managed storage observation');

  const backend = runtimeObjects.get('opensphere-console/Deployment/opensphere-console-backend')
    ?? getJson(kubectlFn, 'deployment', NAMESPACE, 'opensphere-console-backend');
  const api = (backend.spec?.template?.spec?.containers ?? []).find((item) => item.name === 'api');
  const consolePublicUrl = (api?.env ?? []).find((item) => item.name === 'CONSOLE_PUBLIC_URL')?.value;
  const backendObservation = {
    deploymentUid: backend.metadata.uid,
    resourceVersion: backend.metadata.resourceVersion,
    consolePublicUrl,
  };
  exact(backendObservation, expected.backend, 'Backend observation');

  const tls = getSecretMetadata(kubectlFn, NAMESPACE, expected.shellTls.secretName);
  const tlsUsers = [...runtimeObjects.values()].flatMap((object) => {
    const spec = workloadSpec(object);
    const volumes = (spec?.volumes ?? []).filter((volume) =>
      volume.secret?.secretName === expected.shellTls.secretName)
      .map((volume) => ({ name: volume.name, secretName: volume.secret.secretName }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (volumes.length === 0) return [];
    return [{
      kind: object.kind,
      namespace: object.metadata.namespace,
      name: object.metadata.name,
      uid: object.metadata.uid,
      resourceVersion: object.metadata.resourceVersion,
      volumes,
    }];
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const shellTls = {
    mode: 'managed',
    secretName: expected.shellTls.secretName,
    uid: tls.uid,
    resourceVersion: tls.resourceVersion,
    secretType: tls.secretType,
    dataKeys: tls.dataKeys,
    workloadSetDigest: sha256(canonicalJson(tlsUsers)),
  };
  exact(shellTls, expected.shellTls, 'managed Shell TLS observation');

  const actual = {
    contract: expected.contract,
    observedAt: expected.observedAt,
    expectedReleaseJsonSha256: expected.expectedReleaseJsonSha256,
    expectedConfigJsonSha256: expected.expectedConfigJsonSha256,
    installationEvidence,
    releaseInventory,
    initialAdmin,
    managedStorage,
    backend: backendObservation,
    authEnvironmentReconstruction: expected.authEnvironmentReconstruction,
    shellTls,
  };
  exact(actual, expected, 'configuration observation');
  return actual;
}

function observeTrust(plan, kubectlFn) {
  const expected = plan.preconditions.trustObservation;
  const cm = getJson(kubectlFn, 'configmap', expected.namespace, expected.configMapName);
  const document = parseJson(cm.data?.['trusted-keys.json'] ?? '', 'trusted key set');
  if (Object.keys(document).sort().join(',') !== 'trustedKeys'
      || !document.trustedKeys || typeof document.trustedKeys !== 'object'
      || Array.isArray(document.trustedKeys)) {
    throw new Error('opensphere-extension-trusted-keys has a non-canonical nested document');
  }
  const actual = {
    ...expected,
    uid: cm.metadata.uid,
    resourceVersion: cm.metadata.resourceVersion,
    publicKeySpkiBase64: document.trustedKeys[expected.keyId],
  };
  exact(actual, expected, 'edge trust observation');
  return actual;
}

function receiptTransitionAllowed(previous, next) {
  if (!previous) return true;
  if (canonicalJson(previous) === canonicalJson(next)) return true;
  const fenceKeys = [
    'planDigest', 'incidentId', 'requestId', 'operationId', 'mergeRevision',
    'approvalId', 'releaseDigest', 'sourceRevision', 'oldInstallationLockUid',
    'recoveredUid', 'recoveredResourceVersion',
  ];
  if (fenceKeys.some((key) => previous[key] !== next[key])) return false;
  if (canonicalJson(previous.reconstruction) !== canonicalJson(next.reconstruction)
      || canonicalJson(previous.evidence) !== canonicalJson(next.evidence)) return false;
  if (previous.succeeded !== false) return false;
  if (previous.state === 'NeedsAttentionPreservedExactObject') {
    return next.succeeded === true && next.state === 'SemanticReconstructionRecovered';
  }
  if (previous.state === 'RollbackClaimed') {
    return next.succeeded === false
      && ['RolledBackToMissing', 'NeedsAttentionPreservedExactObject'].includes(next.state);
  }
  return false;
}

async function assertNoSymlinkPath(path, label) {
  const chain = [];
  let cursor = resolve(path);
  while (true) {
    chain.push(cursor);
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const candidate of chain.reverse()) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symlink or junction`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function readReceiptRevision(path) {
  await assertNoSymlinkPath(path, 'recovery receipt revision');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()
      || (Number.isInteger(stat.nlink) && stat.nlink !== 1)) {
    throw new Error('recovery receipt revision is not a unique regular file');
  }
  const bytes = await readFile(path);
  if (bytes.length !== stat.size) throw new Error('recovery receipt revision changed while read');
  return parseJson(bytes, 'recovery receipt');
}

async function readReceiptCandidate(path, expectedBytes, expectedIdentity) {
  await assertNoSymlinkPath(path, 'recovery receipt staging candidate');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()
      || (Number.isInteger(stat.nlink) && stat.nlink !== 1)) {
    throw new Error('recovery receipt staging candidate is not a unique regular file');
  }
  if (expectedIdentity && (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino
      || stat.ctimeMs !== expectedIdentity.ctimeMs || stat.size !== expectedIdentity.size)) {
    throw new Error('recovery receipt staging candidate identity changed');
  }
  const bytes = await readFile(path);
  if (bytes.length !== stat.size) {
    throw new Error('recovery receipt staging candidate changed while read');
  }
  if (expectedBytes && !bytes.equals(expectedBytes)) {
    throw new Error('recovery receipt staging candidate bytes changed');
  }
  return { stat, bytes };
}

export async function createDurableInstallationLockRecoveryReceiptStore(
  receiptDirectory, workspaceRoot, {
    ensureDirectoryCustodyFn = ensureInstallationLockRecoveryPrivateDirectory,
    assertDirectoryCustodyFn = assertInstallationLockRecoveryPrivateDirectory,
    moveNoReplaceFn = atomicNoReplaceMove,
    unlinkTemporaryFn = unlink,
    readCustodyEntriesFn = readdir,
    candidateIdFn = () => randomUUID().replaceAll('-', ''),
  } = {}
) {
  const requestedDirectory = resolve(receiptDirectory);
  const requestedWorkspace = resolve(workspaceRoot);
  const lexicalRelative = relative(requestedWorkspace, requestedDirectory);
  if (!lexicalRelative || (!lexicalRelative.startsWith('..') && !isAbsolute(lexicalRelative))) {
    throw new Error('recovery receipt directory must be outside the source repository');
  }
  await assertNoSymlinkPath(requestedDirectory, 'recovery receipt directory');
  await assertNoSymlinkPath(requestedWorkspace, 'recovery workspace');
  const createdReceiptDirectory = await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  if (createdReceiptDirectory) await ensureDirectoryCustodyFn(requestedDirectory);
  else await assertDirectoryCustodyFn(requestedDirectory);
  const temporaryDirectory = join(requestedDirectory, '.tmp');
  const stagingDirectory = join(requestedDirectory, '.staging');
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  const [directory, workspace] = await Promise.all([
    realpath(requestedDirectory), realpath(requestedWorkspace),
  ]);
  let [directoryStat, workspaceStat, temporaryStat, stagingStat] = await Promise.all([
    lstat(directory), lstat(workspace), lstat(temporaryDirectory), lstat(stagingDirectory),
  ]);
  const rel = relative(workspace, directory);
  if (workspace !== requestedWorkspace || directory !== requestedDirectory
      || !rel || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error('recovery receipt directory must be outside the source repository');
  }
  const assertCustodyDirectories = async () => {
    await assertDirectoryCustodyFn(directory);
    await assertNoSymlinkPath(directory, 'recovery receipt directory');
    await assertNoSymlinkPath(workspace, 'recovery workspace');
    const [currentDirectory, currentWorkspace] = await Promise.all([
      lstat(directory), lstat(workspace),
    ]);
    for (const [current, expected, label] of [
      [currentDirectory, directoryStat, 'recovery receipt directory'],
      [currentWorkspace, workspaceStat, 'recovery workspace'],
    ]) {
      if (!current.isDirectory() || current.isSymbolicLink()
          || current.dev !== expected.dev || current.ino !== expected.ino
          || await realpath(label === 'recovery receipt directory' ? directory : workspace)
            !== (label === 'recovery receipt directory' ? directory : workspace)) {
        throw new Error(`${label} identity changed during recovery`);
      }
    }
    const currentTemporary = await lstat(temporaryDirectory);
    if (!currentTemporary.isDirectory() || currentTemporary.isSymbolicLink()
        || currentTemporary.dev !== temporaryStat.dev || currentTemporary.ino !== temporaryStat.ino
        || await realpath(temporaryDirectory) !== resolve(temporaryDirectory)) {
      throw new Error('recovery receipt temporary directory identity changed during recovery');
    }
    const temporaryEntries = await readCustodyEntriesFn(temporaryDirectory, { withFileTypes: true });
    for (const entry of temporaryEntries) {
      if (!/^[a-f0-9]{64}\.[0-9]{8}\.json$/u.test(entry.name)
          || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('recovery receipt temporary directory contains an unknown artifact');
      }
      try { await readReceiptRevision(join(temporaryDirectory, entry.name)); }
      catch (error) {
        // This directory scan observes peers' transient files. A peer can
        // promote/remove an entry after readdir; append and cleanup still
        // validate exact pending/final bytes before accepting a receipt.
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const currentStaging = await lstat(stagingDirectory);
    if (!currentStaging.isDirectory() || currentStaging.isSymbolicLink()
        || currentStaging.dev !== stagingStat.dev || currentStaging.ino !== stagingStat.ino
        || await realpath(stagingDirectory) !== resolve(stagingDirectory)) {
      throw new Error('recovery receipt staging directory identity changed during recovery');
    }
    const stagingEntries = await readCustodyEntriesFn(stagingDirectory, { withFileTypes: true });
    for (const entry of stagingEntries) {
      if (!/^[a-f0-9]{64}\.[0-9]{8}\.[a-f0-9]{32}\.candidate$/u.test(entry.name)
          || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('recovery receipt staging directory contains an unknown artifact');
      }
      let candidateStat;
      try { candidateStat = await lstat(join(stagingDirectory, entry.name)); }
      catch (error) {
        // Candidates legitimately disappear when another writer promotes or
        // removes its own file. Only absence during this scan is harmless.
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!candidateStat.isFile() || candidateStat.isSymbolicLink()
          || (Number.isInteger(candidateStat.nlink) && candidateStat.nlink !== 1)) {
        throw new Error('recovery receipt staging directory contains an irregular candidate');
      }
    }
  };
  const historyFor = (planDigest) => join(directory, planDigest.replace('sha256:', ''));
  async function revisions(planDigest) {
    await assertCustodyDirectories();
    const history = historyFor(planDigest);
    try {
      await assertNoSymlinkPath(history, 'recovery receipt history');
      const entries = await readdir(history, { withFileTypes: true });
      if (entries.some((entry) => !/^\d{8}\.json$/u.test(entry.name)
        || !entry.isFile() || entry.isSymbolicLink())) {
        throw new Error('recovery receipt history contains an unknown or irregular revision');
      }
      const names = entries.map((entry) => entry.name).sort();
      for (let index = 0; index < names.length; index += 1) {
        if (names[index] !== `${String(index + 1).padStart(8, '0')}.json`) {
          throw new Error('recovery receipt history is not contiguous');
        }
        await readReceiptRevision(join(history, names[index]));
      }
      return names;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  return {
    async read(planDigest) {
      await assertCustodyDirectories();
      const names = await revisions(planDigest);
      if (names.length === 0) return null;
      return readReceiptRevision(join(historyFor(planDigest), names.at(-1)));
    },
    async write(planDigest, receipt) {
      await assertCustodyDirectories();
      const history = historyFor(planDigest);
      await mkdir(history, { recursive: true, mode: 0o700 });
      const afterHistoryCreate = await lstat(directory);
      if (afterHistoryCreate.dev !== directoryStat.dev
          || afterHistoryCreate.ino !== directoryStat.ino) {
        throw new Error('recovery receipt directory identity changed while creating history');
      }
      directoryStat = afterHistoryCreate;
      if (await realpath(history) !== resolve(history)) {
        throw new Error('recovery receipt history resolves through a symlink or junction');
      }
      const names = await revisions(planDigest);
      const previous = names.length === 0 ? null
        : await readReceiptRevision(join(history, names.at(-1)));
      if (!receiptTransitionAllowed(previous, receipt)) {
        throw new Error('durable recovery receipt transition is not append-only or canonical');
      }
      if (previous && canonicalJson(previous) === canonicalJson(receipt)) return previous;
      const revision = String(names.length + 1).padStart(8, '0');
      const finalPath = join(history, `${revision}.json`);
      const temporary = join(temporaryDirectory,
        `${planDigest.replace('sha256:', '')}.${revision}.json`);
      const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      const syncDirectory = async (path) => {
        const handle = await open(path, 'r');
        try {
          await handle.sync().catch((error) => {
            if (!['EINVAL', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
          });
        } finally { await handle.close(); }
      };
      const refreshTemporaryIdentity = async () => {
        const current = await lstat(temporaryDirectory);
        if (!current.isDirectory() || current.isSymbolicLink()
            || current.dev !== temporaryStat.dev || current.ino !== temporaryStat.ino
            || await realpath(temporaryDirectory) !== resolve(temporaryDirectory)) {
          throw new Error('recovery receipt temporary directory identity changed during append');
        }
        temporaryStat = current;
      };
      const refreshStagingIdentity = async () => {
        const current = await lstat(stagingDirectory);
        if (!current.isDirectory() || current.isSymbolicLink()
            || current.dev !== stagingStat.dev || current.ino !== stagingStat.ino
            || await realpath(stagingDirectory) !== resolve(stagingDirectory)) {
          throw new Error('recovery receipt staging directory identity changed during append');
        }
        stagingStat = current;
      };
      const optionalReceipt = async (path) => {
        try { return await readReceiptRevision(path); }
        catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
      };
      let candidate;
      let candidateIdentity;
      for (let attempt = 0; attempt < 8 && !candidate; attempt += 1) {
        const candidateId = candidateIdFn();
        if (!/^[a-f0-9]{32}$/u.test(candidateId ?? '')) {
          throw new Error('recovery receipt staging candidate ID is non-canonical');
        }
        const proposed = join(stagingDirectory,
          `${planDigest.replace('sha256:', '')}.${revision}.${candidateId}.candidate`);
        let handle;
        try { handle = await open(proposed, 'wx', 0o600); }
        catch (error) {
          if (error.code === 'EEXIST') continue;
          throw error;
        }
        candidate = proposed;
        try {
          await handle.writeFile(receiptBytes);
          await handle.sync();
        } finally { await handle.close(); }
        ({ stat: candidateIdentity } = await readReceiptCandidate(
          candidate, receiptBytes
        ));
      }
      if (!candidate || !candidateIdentity) {
        throw new Error('recovery receipt could not allocate a unique staging candidate');
      }
      await syncDirectory(stagingDirectory);
      await refreshStagingIdentity();
      const removeOwnedCandidate = async () => {
        try {
          await readReceiptCandidate(candidate, receiptBytes, candidateIdentity);
        } catch (error) {
          if (error.code === 'ENOENT') return;
          throw error;
        }
        await unlink(candidate);
        await syncDirectory(stagingDirectory);
        await refreshStagingIdentity();
      };
      try {
        try { await moveNoReplaceFn(candidate, temporary); }
        finally {
          await refreshStagingIdentity();
          await refreshTemporaryIdentity();
        }
      } catch (error) {
        const pending = await optionalReceipt(temporary);
        if (pending) {
          if (canonicalJson(pending) !== canonicalJson(receipt)) {
            throw new Error('deterministic recovery receipt pending file differs from this append');
          }
          await removeOwnedCandidate();
        } else {
          const concurrent = await optionalReceipt(finalPath);
          if (concurrent && canonicalJson(concurrent) === canonicalJson(receipt)) {
            await removeOwnedCandidate();
            return concurrent;
          }
          try { await readReceiptCandidate(candidate, receiptBytes, candidateIdentity); }
          catch (candidateError) {
            throw new Error(`durable recovery receipt staging promotion is ambiguous (${candidateError.message})`);
          }
          const interrupted = new Error(
            `durable recovery receipt staging promotion is pending replay (${error.message})`
          );
          interrupted.code = 'InstallationLockRecoveryReceiptCandidateMovePending';
          throw interrupted;
        }
      }
      const promoted = await optionalReceipt(temporary);
      if (!promoted) {
        const concurrent = await optionalReceipt(finalPath);
        if (!concurrent || canonicalJson(concurrent) !== canonicalJson(receipt)) {
          throw new Error('promoted recovery receipt disappeared without an exact final revision');
        }
        await removeOwnedCandidate();
        return concurrent;
      }
      if (canonicalJson(promoted) !== canonicalJson(receipt)) {
        throw new Error('promoted recovery receipt pending file differs from this append');
      }
      await syncDirectory(temporaryDirectory);
      const removeExactTemporary = async () => {
        for (let attempt = 0; ; attempt += 1) {
          // Revalidate both authorities on every retry. Windows may briefly
          // deny unlink while another identical writer finishes cleanup.
          const concurrent = await optionalReceipt(finalPath);
          if (!concurrent || canonicalJson(concurrent) !== canonicalJson(receipt)) {
            throw new Error('recovery receipt temporary cleanup lost its exact final revision');
          }
          const pending = await optionalReceipt(temporary);
          if (!pending) break;
          if (canonicalJson(pending) !== canonicalJson(receipt)) {
            throw new Error('recovery receipt temporary cleanup encountered different bytes');
          }
          try { await unlinkTemporaryFn(temporary); break; }
          catch (error) {
            if (error.code === 'ENOENT') {
              const final = await optionalReceipt(finalPath);
              if (!final || canonicalJson(final) !== canonicalJson(receipt)) {
                throw new Error('recovery receipt temporary cleanup lost its exact final revision');
              }
              break;
            }
            // Persistent EPERM and all other access errors remain failures.
            if (error.code !== 'EPERM' || attempt >= 3) throw error;
            await delay(25 * (attempt + 1));
          }
        }
        await syncDirectory(temporaryDirectory);
        await refreshTemporaryIdentity();
      };
      try {
        try { await moveNoReplaceFn(temporary, finalPath); }
        finally { await refreshTemporaryIdentity(); }
      } catch (error) {
        const concurrent = await optionalReceipt(finalPath);
        if (concurrent) {
          if (canonicalJson(concurrent) !== canonicalJson(receipt)) {
            throw new Error('concurrent recovery receipt revision differs from this append');
          }
          await removeExactTemporary();
          return concurrent;
        }
        const pending = await optionalReceipt(temporary);
        if (pending && canonicalJson(pending) === canonicalJson(receipt)) {
          const interrupted = new Error(`durable recovery receipt move is pending replay (${error.message})`);
          interrupted.code = 'InstallationLockRecoveryReceiptMovePending';
          throw interrupted;
        }
        throw new Error(`durable recovery receipt move is ambiguous (${error.message})`);
      }
      const persisted = await readReceiptRevision(finalPath);
      if (canonicalJson(persisted) !== canonicalJson(receipt)) {
        throw new Error('persisted recovery receipt differs from this append');
      }
      await removeExactTemporary();
      const directoryHandle = await open(history, 'r');
      try {
        await directoryHandle.sync().catch((error) => {
          if (!['EINVAL', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
        });
      } finally { await directoryHandle.close(); }
      await assertCustodyDirectories();
      return persisted;
    },
  };
}

function directHttpsJsonRequest(options, body) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveRequest({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', rejectRequest);
    request.end(body);
  });
}

function assertKubeContext(kubectlFn, expected = 'docker-desktop') {
  const actual = String(kubectlFn(['config', 'current-context'], { capture: true })).trim();
  if (actual !== expected) {
    throw new Error(`installation-lock recovery requires Kubernetes context ${expected}`);
  }
  return actual;
}

function currentKubeAuthority(kubectlFn, expectedContext = 'docker-desktop') {
  assertKubeContext(kubectlFn, expectedContext);
  const config = parseJson(kubectlFn([
    'config', 'view', '--raw', '--minify', '-o', 'json',
  ], { capture: true }), 'current kubeconfig');
  if (!Array.isArray(config.contexts) || config.contexts.length !== 1
      || !Array.isArray(config.clusters) || config.clusters.length !== 1
      || !Array.isArray(config.users) || config.users.length !== 1
      || config.contexts[0].name !== config['current-context']) {
    throw new Error('current kubeconfig authority is not a single minified context');
  }
  const context = config.contexts[0].context;
  const clusterEntry = config.clusters.find((item) => item.name === context.cluster);
  const userEntry = config.users.find((item) => item.name === context.user);
  const cluster = clusterEntry?.cluster;
  const user = userEntry?.user;
  if (!cluster?.server?.startsWith('https://') || cluster['insecure-skip-tls-verify'] === true
      || !cluster['certificate-authority-data']
      || (!user?.token && !(user?.['client-certificate-data'] && user?.['client-key-data']))) {
    throw new Error('kubeconfig lacks exact TLS server authority and non-interactive credentials');
  }
  return { cluster, user };
}

export async function deleteConfigMapWithPreconditions({
  namespace, name, uid, resourceVersion, kubectlFn = kubectl,
  requestFn = directHttpsJsonRequest, kubeContext = 'docker-desktop',
} = {}) {
  if (!namespace || !name || !uid || !/^[1-9][0-9]*$/u.test(resourceVersion ?? '')) {
    throw new Error('ConfigMap DELETE preconditions are incomplete');
  }
  const { cluster, user } = currentKubeAuthority(kubectlFn, kubeContext);
  const server = new URL(cluster.server);
  const body = JSON.stringify({
    apiVersion: 'v1',
    kind: 'DeleteOptions',
    propagationPolicy: 'Background',
    preconditions: { uid, resourceVersion },
  });
  const response = await requestFn({
    protocol: 'https:',
    hostname: server.hostname,
    port: server.port || 443,
    method: 'DELETE',
    path: `${server.pathname.replace(/\/$/u, '')}/api/v1/namespaces/${encodeURIComponent(namespace)}`
      + `/configmaps/${encodeURIComponent(name)}`,
    ca: Buffer.from(cluster['certificate-authority-data'], 'base64'),
    ...(user.token ? { headers: { authorization: `Bearer ${user.token}` } } : {
      cert: Buffer.from(user['client-certificate-data'], 'base64'),
      key: Buffer.from(user['client-key-data'], 'base64'),
    }),
    rejectUnauthorized: true,
    servername: server.hostname,
    headers: {
      ...(user.token ? { authorization: `Bearer ${user.token}` } : {}),
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  }, body);
  if (![200, 202].includes(response?.statusCode)) {
    throw new Error(`Kubernetes UID+resourceVersion DELETE failed with status ${response?.statusCode ?? 'unknown'}`);
  }
  const result = parseJson(response.body, 'Kubernetes DELETE response');
  if (result?.metadata?.uid && result.metadata.uid !== uid) {
    throw new Error('Kubernetes DELETE response UID differs from the precondition');
  }
  return result;
}

export function createInstallationLockRecoveryRuntime(plan, {
  kubectlFn = kubectl,
  receiptStore,
  assertPlanUnchanged = async () => {},
  deleteWithPreconditionsFn = deleteConfigMapWithPreconditions,
  directRequestFn,
  assertToolingUnchanged = async () => {},
  now = () => new Date().toISOString(),
  assertDirectoryCustodyFn = assertInstallationLockRecoveryPrivateDirectory,
} = {}) {
  async function assertExecutionBoundary() {
    await assertPlanUnchanged();
    await assertToolingUnchanged();
    await assertDirectoryCustodyFn(dirname(plan.preconditions.localState.quarantine.filePath));
    assertKubeContext(kubectlFn, plan.execution.kubeContext);
  }
  async function observe() {
    await assertExecutionBoundary();
    await assertInstallationLockRecoveryLocalState(plan.preconditions.localState);
    const installationLock = getJson(kubectlFn, 'configmap', NAMESPACE, LOCK_NAME, { optional: true });
    const runtime = observeRuntime(plan, kubectlFn);
    const configurationObservation = observeConfiguration(plan, kubectlFn, runtime.objects);
    const trustObservation = observeTrust(plan, kubectlFn);
    const preconditions = {
      ...plan.preconditions,
      installationEvidence: configurationObservation.installationEvidence,
      releaseInventory: configurationObservation.releaseInventory,
      configurationObservation,
      runtimeObservation: runtime.observation,
      runtimeImageSetDigest: runtime.observation.imageSetDigest,
      configurationObservationDigest: sha256(canonicalJson(configurationObservation)),
      trustObservation,
      localInstallationLockCache: 'Absent',
    };
    return { preconditionDigest: sha256(canonicalJson(preconditions)), installationLock };
  }
  return {
    observe,
    now,
    async readReceipt(planDigest) {
      await assertPlanUnchanged();
      await assertToolingUnchanged();
      return receiptStore.read(planDigest);
    },
    async createConfigMap(manifest) {
      await assertExecutionBoundary();
      try {
        return parseJson(kubectlFn(['create', '-f', '-', '-o', 'json'], {
          capture: true, input: JSON.stringify(manifest),
        }), 'installation-lock create');
      } catch (error) {
        const ambiguous = new Error(`installation-lock create result is ambiguous: ${error.message}`);
        if (/AlreadyExists|already exists|\b409\b/iu.test(error.message ?? '')) {
          ambiguous.code = 'AlreadyExists';
          ambiguous.statusCode = 409;
        } else {
          ambiguous.code = 'ResponseLost';
        }
        throw ambiguous;
      }
    },
    async deleteConfigMap({ uid, resourceVersion }) {
      await assertExecutionBoundary();
      const current = getJson(kubectlFn, 'configmap', NAMESPACE, LOCK_NAME);
      exact({ uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion },
        { uid, resourceVersion }, 'rollback precondition');
      await deleteWithPreconditionsFn({
        namespace: NAMESPACE,
        name: LOCK_NAME,
        uid,
        resourceVersion,
        kubectlFn,
        requestFn: directRequestFn,
        kubeContext: plan.execution.kubeContext,
      });
    },
    async verifyRecoveredInstallation() {
      const state = await observe();
      if (!state.installationLock) throw new Error('recovered installation lock is absent');
      return {
        releaseDigest: plan.releaseDigest,
        releaseJsonSha256: sha256(state.installationLock.data?.['release.json'] ?? ''),
        configJsonSha256: sha256(state.installationLock.data?.['config.json'] ?? ''),
        runtimeImagesMatchLock: true,
        runtimeImageSetDigest: plan.preconditions.runtimeObservation.imageSetDigest,
        installationEvidenceUid: plan.preconditions.installationEvidence.uid,
        installationEvidenceResourceVersion: plan.preconditions.installationEvidence.resourceVersion,
        releaseInventoryUid: plan.preconditions.releaseInventory.uid,
        releaseInventoryResourceVersion: plan.preconditions.releaseInventory.resourceVersion,
      };
    },
    async writeReceipt(receipt) {
      await assertPlanUnchanged();
      await assertToolingUnchanged();
      return receiptStore.write(plan.planDigest, receipt);
    },
  };
}

export async function recoverInstallationLockFromPlan({
  planPath,
  confirmation,
  kubectlFn = kubectl,
  deleteWithPreconditionsFn = deleteConfigMapWithPreconditions,
  directRequestFn,
  validatePlanFn = validateInstallationLockRecoveryPlan,
  executeRecoveryFn = executeInstallationLockRecovery,
  toolingBoundaryFn,
  assertToolingAuthorityFn = assertInstallationLockRecoveryToolingAuthority,
  ensureDirectoryCustodyFn = ensureInstallationLockRecoveryPrivateDirectory,
  assertDirectoryCustodyFn = assertInstallationLockRecoveryPrivateDirectory,
  moveNoReplaceFn = atomicNoReplaceMove,
} = {}) {
  if (confirmation !== INSTALLATION_LOCK_RECOVERY_CONFIRMATION) {
    throw new Error(`installation-lock recovery requires --confirm ${INSTALLATION_LOCK_RECOVERY_CONFIRMATION}`);
  }
  if (!planPath) {
    throw new Error('installation-lock recovery requires planPath');
  }
  const absolutePlan = resolve(planPath);
  await assertNoSymlinkPath(absolutePlan, 'recovery plan');
  const stat = await lstat(absolutePlan);
  if (!stat.isFile() || stat.isSymbolicLink()
      || (Number.isInteger(stat.nlink) && stat.nlink !== 1)) {
    throw new Error('recovery plan must be an immutable unique regular file');
  }
  const planBytes = await readFile(absolutePlan);
  const planFileSha256 = sha256(planBytes);
  const plan = validatePlanFn(parseJson(planBytes, 'recovery plan'));
  const workspaceRoot = resolve(plan.preconditions.localState.workspaceRoot);
  const receiptDirectory = resolve(plan.preconditions.localState.receiptDirectory);
  const assertPlanUnchanged = async () => {
    await assertNoSymlinkPath(absolutePlan, 'recovery plan');
    const current = await lstat(absolutePlan);
    if (!current.isFile() || current.isSymbolicLink()
        || (Number.isInteger(current.nlink) && current.nlink !== 1)
        || current.dev !== stat.dev || current.ino !== stat.ino
        || current.ctimeMs !== stat.ctimeMs || current.size !== stat.size
        || current.mtimeMs !== stat.mtimeMs
        || sha256(await readFile(absolutePlan)) !== planFileSha256) {
      throw new Error('immutable signed recovery plan changed during execution');
    }
  };
  const assertToolingUnchanged = async () => assertToolingAuthorityFn(
    plan.preconditions.recoveryToolingAuthority, toolingBoundaryFn
  );
  await assertToolingUnchanged();
  await assertDirectoryCustodyFn(dirname(plan.preconditions.localState.quarantine.filePath));
  await assertInstallationLockRecoveryLocalState(plan.preconditions.localState);
  const receiptStore = await createDurableInstallationLockRecoveryReceiptStore(
    resolve(receiptDirectory), resolve(workspaceRoot), {
      ensureDirectoryCustodyFn, assertDirectoryCustodyFn, moveNoReplaceFn,
    }
  );
  const runtime = createInstallationLockRecoveryRuntime(plan, {
    kubectlFn, receiptStore, assertPlanUnchanged,
    deleteWithPreconditionsFn, directRequestFn,
    assertToolingUnchanged,
    assertDirectoryCustodyFn,
  });
  return executeRecoveryFn(plan, runtime);
}
