import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

import { normalizeConsoleUrl } from './console-url.mjs';

export const INSTALLATION_LOCK_RECOVERY_EVIDENCE_CONTRACT =
  'opensphere.installation-lock.recovery-evidence/v1';
export const INSTALLATION_LOCK_RECOVERY_PLAN_CONTRACT =
  'opensphere.installation-lock.recovery-plan/v1';
export const INSTALLATION_LOCK_RECOVERY_RECEIPT_CONTRACT =
  'opensphere.installation-lock.recovery-receipt/v1';
export const INSTALLATION_LOCK_RECOVERY_APPROVAL_CONTRACT =
  'opensphere.installation-lock.reconstruction-approval/v1';
export const INSTALLATION_LOCK_RECOVERY_STALE_QUARANTINE_CONTRACT =
  'opensphere.installation-lock.stale-quarantine-journal/v1';
export const INSTALLATION_LOCK_RECOVERY_TOOLING_PATHS = Object.freeze([
  'src/cli.mjs',
  'src/installation-lock-recovery.mjs',
  'src/installation-lock-recovery-local.mjs',
  'src/installation-lock-recovery-prepare.mjs',
  'src/installation-lock-recovery-runtime.mjs',
  'src/installation-lock-recovery-windows-custody.mjs',
  'scripts/Assert-InstallationLockRecoverySigningKey.ps1',
]);

const RECOVERY_INCIDENT = Object.freeze({
  incidentId: '2026-08-15-installation-lock-accidental-delete',
  incidentRawSha256: 'sha256:5a7e292bad4905a82cadbd8202f95247c475b456bbcb676392340964049a6796',
  incidentCanonicalSha256: 'sha256:0ea95682d3100f7056c672839eba9df5371c2442749d72f26a0452d9847d6f55',
  requestId: 'a649530f-c8d5-4a0f-a461-9707bc9809b8',
  operationId: 'a649530f-c8d5-4a0f-a461-9707bc9809b8:c51319d2bddac715eea840417552dde46de686de:1',
  giteaRepository: 'opensphere/platform-declarations',
  giteaCommit: 'c51319d2bddac715eea840417552dde46de686de',
  giteaPath: 'platform-release/requests/a649530f-c8d5-4a0f-a461-9707bc9809b8.json',
  giteaBlob: 'c264f5625f369a9d75e6c76b7f793d754af777b5',
  governedDocumentSha256: 'sha256:65c2f82112e888ff8bc3ee7344f7b38934c2cf5a9b439984981f9dc0c28dd469',
  receiptSha256: 'sha256:082fd587606cccfb6f734f1706379625e13619c5e523b2003123b78a542cf5ad',
  releaseDigest: 'sha256:3c39bccb079c8019b51e1d736775b9b9677a235c25584ae51f5da5d010048911',
  sourceRevision: '59778b3cfe26cadc93f832ecb67e0c3720b3d803',
  releaseJsonSha256: 'sha256:6f5570434a64a7b7157bf1a38da1a4b5c39437b943b1f4a4cb18e02d30eb4c00',
  releaseJsonBytes: 4652,
  configJsonSha256: 'sha256:ebc2dbab240cb2f081571d48dd220523a348f3c78519908b0e4e5c5c24fa6561',
  configJsonBytes: 474,
  oldInstallationLockUid: '7016251f-c144-4e71-8b54-0df6e956854a',
  installationEvidenceUid: 'b6b66c91-f04c-4ada-8b07-c474f6ddf6a7',
  installationEvidenceResourceVersion: '13330542',
  releaseInventoryUid: 'dbc61098-0895-4375-b43f-6303a75878dd',
  releaseInventoryResourceVersion: '13330552',
});

const TRUST_KEY_ID = 'opensphere-edge-local-v1';

const LOCAL_LOCK_PATH = '.codex-deploy/current-installation-lock.json';
const REVIEWED_STALE_LOCAL_LOCK = Object.freeze({
  sha256: 'sha256:a74e679607070e8ceab782c11ea0d2317cd8261d9e1fbf0d77dccf139ec75bc1',
  bytes: 4654,
  releaseDigest: 'sha256:0a580e9e212f15018a84fd8d227a3dbdbb4b4a274ba7b6bd009861ad63d4d9d4',
  sourceRevision: '4f77114125bde4ad5fcb0478ce8168684d66209f',
});
const REQUIRED_PVCS = Object.freeze([
  'opensphere-console-change/opensphere-gitea-data',
  'opensphere-console-change/opensphere-gitea-postgres-data',
  'opensphere-console-data/opensphere-supabase-postgres-data',
  'opensphere-console-data/opensphere-supabase-storage-data',
]);
export const INSTALLATION_LOCK_RECOVERY_RUNTIME_WORKLOADS = Object.freeze([
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

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function gitBlobSha(value) {
  const bytes = Buffer.from(value);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`${label} keys are not canonical`);
  }
  return value;
}

function digest(value, label) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`${label} is invalid`);
  return value;
}

function revision(value, label) {
  if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw new Error(`${label} is invalid`);
  return value;
}

function uid(value, label) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function resourceVersion(value, label) {
  if (!/^[1-9][0-9]*$/.test(value ?? '')) throw new Error(`${label} is invalid`);
  return value;
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function base64(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validateIncident(incident) {
  exactKeys(incident, [
    'contract', 'incidentId', 'status', 'resource', 'event', 'postcondition',
    'authoritativeRecoveryEvidence', 'recoveryPolicy',
  ], 'incident');
  if (incident.contract !== 'opensphere-codex-incident-evidence/v1'
      || incident.status !== 'recovery-pending-explicit-approval'
      || incident.resource?.context !== 'docker-desktop'
      || incident.resource?.apiVersion !== 'v1'
      || incident.resource?.kind !== 'ConfigMap'
      || incident.resource?.namespace !== 'opensphere-console'
      || incident.resource?.name !== 'opensphere-installation-lock'
      || incident.postcondition?.getResult !== 'NotFound'
      || incident.postcondition?.recoveryMutationPerformed !== false
      || incident.recoveryPolicy?.dataDeletionAuthorized !== false) {
    throw new Error('incident is not an approved missing installation-lock recovery boundary');
  }
  uid(incident.resource.preDeleteUid, 'incident pre-delete UID');
  isoTimestamp(incident.event.observedAtKst, 'incident deletion timestamp');
  const evidence = incident.authoritativeRecoveryEvidence;
  digest(evidence?.installedReleaseDigest, 'incident installed release digest');
  revision(evidence?.giteaCommit, 'incident Gitea commit');
  revision(evidence?.appliedSourceRevision, 'incident applied source revision');
  if (incident.incidentId !== RECOVERY_INCIDENT.incidentId
      || incident.resource.preDeleteUid !== RECOVERY_INCIDENT.oldInstallationLockUid
      || evidence.installedReleaseDigest !== RECOVERY_INCIDENT.releaseDigest
      || evidence.giteaRepository !== RECOVERY_INCIDENT.giteaRepository
      || evidence.giteaCommit !== RECOVERY_INCIDENT.giteaCommit
      || evidence.giteaPath !== RECOVERY_INCIDENT.giteaPath
      || evidence.requestId !== RECOVERY_INCIDENT.requestId
      || evidence.operationId !== RECOVERY_INCIDENT.operationId
      || evidence.appliedSourceRevision !== RECOVERY_INCIDENT.sourceRevision
      || evidence.installationEvidenceConfigMap?.uid
        !== RECOVERY_INCIDENT.installationEvidenceUid
      || evidence.installationEvidenceConfigMap?.resourceVersion
        !== RECOVERY_INCIDENT.installationEvidenceResourceVersion
      || evidence.releaseInventoryConfigMap?.uid !== RECOVERY_INCIDENT.releaseInventoryUid
      || evidence.releaseInventoryConfigMap?.resourceVersion
        !== RECOVERY_INCIDENT.releaseInventoryResourceVersion) {
    throw new Error('incident differs from the reviewed recovery profile');
  }
  return incident;
}

function validateGovernedSource(source, incident) {
  exactKeys(source, [
    'repository', 'commit', 'path', 'gitBlob', 'documentSha256', 'documentText',
  ], 'governed source');
  if (source.repository !== incident.authoritativeRecoveryEvidence.giteaRepository
      || source.commit !== incident.authoritativeRecoveryEvidence.giteaCommit
      || source.path !== incident.authoritativeRecoveryEvidence.giteaPath
      || gitBlobSha(source.documentText) !== source.gitBlob
      || sha256(source.documentText) !== source.documentSha256
      || source.commit !== RECOVERY_INCIDENT.giteaCommit
      || source.path !== RECOVERY_INCIDENT.giteaPath
      || source.gitBlob !== RECOVERY_INCIDENT.giteaBlob
      || source.documentSha256 !== RECOVERY_INCIDENT.governedDocumentSha256) {
    throw new Error('governed source differs from the incident authority');
  }
  let document;
  try { document = JSON.parse(source.documentText); }
  catch { throw new Error('governed source document is invalid JSON'); }
  exactKeys(document, ['apiVersion', 'kind', 'metadata', 'spec'], 'governed document');
  exactKeys(document.metadata,
    ['requestId', 'consumerId', 'submittedAt', 'payloadDigest'], 'governed metadata');
  exactKeys(document.spec, ['action', 'target', 'reason', 'desiredState'], 'governed spec');
  const desired = document.spec.desiredState;
  exactKeys(desired, ['contract', 'previousReleaseDigest', 'targetLock'], 'governed desired state');
  if (document.apiVersion !== 'platform.opensphere.io/v1alpha1'
      || document.kind !== 'GovernedChange'
      || document.metadata.requestId !== incident.authoritativeRecoveryEvidence.requestId
      || document.metadata.consumerId !== 'platform-release'
      || document.metadata.payloadDigest !== sha256(canonicalJson(desired))
      || document.spec.action !== 'apply'
      || document.spec.target !== 'opensphere-platform'
      || desired.contract !== 'opensphere.platform.release/v1') {
    throw new Error('governed document is not the applied Platform Release declaration');
  }
  return { document, desired };
}

function validateReceipt(receipt, incident, targetLock) {
  exactKeys(receipt, [
    'request_id', 'operation_id', 'desired_revision', 'applied_revision',
    'succeeded', 'result', 'evidence', 'received_at',
  ], 'reconcile receipt');
  exactKeys(receipt.evidence, [
    'stage', 'channel', 'previousReleaseDigest', 'installedReleaseDigest',
    'sourceRevision', 'platforms', 'changed', 'podCount', 'serviceCount',
    'rollbackContract',
  ], 'reconcile receipt evidence');
  const authority = incident.authoritativeRecoveryEvidence;
  if (receipt.request_id !== authority.requestId
      || receipt.operation_id !== authority.operationId
      || receipt.desired_revision !== authority.giteaCommit
      || receipt.applied_revision !== authority.appliedSourceRevision
      || receipt.succeeded !== true
      || receipt.result !== authority.receiptResult
      || receipt.received_at !== authority.receiptReceivedAt
      || receipt.evidence.stage !== 'observed'
      || receipt.evidence.channel !== targetLock.channel
      || receipt.evidence.previousReleaseDigest
        !== desiredPreviousReleaseDigest(targetLock)
      || receipt.evidence.installedReleaseDigest !== targetLock.releaseDigest
      || receipt.evidence.sourceRevision !== targetLock.sourceRevision
      || JSON.stringify(receipt.evidence.platforms) !== JSON.stringify(['linux/amd64'])
      || receipt.evidence.changed !== true
      || receipt.evidence.podCount !== 2
      || receipt.evidence.serviceCount !== 13
      || receipt.evidence.rollbackContract
        !== 'Setup upgrade restores the previously verified release on failed target verification') {
    throw new Error('reconcile receipt does not prove the governed release was applied');
  }
  return receipt;
}

function desiredPreviousReleaseDigest(targetLock) {
  return targetLock.baseReleaseDigest;
}

function validateObservation(observation, incident, lock) {
  exactKeys(observation, [
    'contract', 'observedAt', 'expectedReleaseJsonSha256', 'expectedConfigJsonSha256',
    'installationEvidence', 'releaseInventory', 'initialAdmin', 'managedStorage',
    'backend', 'authEnvironmentReconstruction', 'shellTls',
  ], 'configuration observation');
  if (observation.contract !== 'opensphere.installation-lock.config-observation/v1') {
    throw new Error('configuration observation contract is invalid');
  }
  isoTimestamp(observation.observedAt, 'configuration observation timestamp');
  digest(observation.expectedReleaseJsonSha256, 'expected release.json digest');
  digest(observation.expectedConfigJsonSha256, 'expected config.json digest');
  if (observation.expectedReleaseJsonSha256 !== RECOVERY_INCIDENT.releaseJsonSha256
      || observation.expectedConfigJsonSha256 !== RECOVERY_INCIDENT.configJsonSha256) {
    throw new Error('reviewed reconstruction byte digests differ from the incident profile');
  }

  const installed = exactKeys(observation.installationEvidence, [
    'uid', 'resourceVersion', 'releaseDigest', 'runtimeImagesMatchLock', 'verifiedAt',
  ], 'installation evidence');
  const incidentInstalled = incident.authoritativeRecoveryEvidence.installationEvidenceConfigMap;
  if (uid(installed.uid, 'installation evidence UID') !== incidentInstalled.uid
      || resourceVersion(installed.resourceVersion, 'installation evidence resourceVersion')
        !== incidentInstalled.resourceVersion
      || installed.releaseDigest !== lock.releaseDigest
      || installed.runtimeImagesMatchLock !== true
      || Date.parse(isoTimestamp(installed.verifiedAt, 'installation evidence verifiedAt'))
        > Date.parse(incident.event.observedAtKst)) {
    throw new Error('installation evidence is not the pre-delete verified release');
  }

  const inventory = exactKeys(observation.releaseInventory, [
    'uid', 'resourceVersion', 'releaseDigest', 'resourceCount', 'resourceSetDigest',
  ], 'release inventory');
  const incidentInventory = incident.authoritativeRecoveryEvidence.releaseInventoryConfigMap;
  if (uid(inventory.uid, 'release inventory UID') !== incidentInventory.uid
      || resourceVersion(inventory.resourceVersion, 'release inventory resourceVersion')
        !== incidentInventory.resourceVersion
      || inventory.releaseDigest !== lock.releaseDigest
      || !Number.isInteger(inventory.resourceCount) || inventory.resourceCount < 1) {
    throw new Error('release inventory is not the applied release inventory');
  }
  digest(inventory.resourceSetDigest, 'release inventory set digest');

  const admin = exactKeys(observation.initialAdmin, [
    'uid', 'resourceVersion', 'username', 'displayName', 'email', 'state',
  ], 'initial admin observation');
  uid(admin.uid, 'initial admin UID');
  resourceVersion(admin.resourceVersion, 'initial admin resourceVersion');
  if (admin.username !== 'opensphere-admin'
      || admin.displayName !== 'OpenSphere Administrator'
      || admin.email !== 'admin@opensphere.local'
      || admin.state !== 'required') {
    throw new Error('initial admin observation is invalid');
  }

  const storage = exactKeys(observation.managedStorage, [
    'storageClass', 'pvcCount', 'pvcSetDigest', 'pvcs',
  ], 'managed storage observation');
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(storage.storageClass)
      || storage.storageClass !== 'hostpath'
      || storage.pvcCount !== REQUIRED_PVCS.length
      || !Array.isArray(storage.pvcs) || storage.pvcs.length !== REQUIRED_PVCS.length) {
    throw new Error('managed storage observation is invalid');
  }
  const pvcReferences = storage.pvcs.map((item) => {
    exactKeys(item, [
      'namespace', 'name', 'uid', 'resourceVersion', 'storageClass', 'phase',
    ], 'managed PVC observation');
    uid(item.uid, 'managed PVC UID');
    resourceVersion(item.resourceVersion, 'managed PVC resourceVersion');
    if (item.storageClass !== 'hostpath' || item.phase !== 'Bound') {
      throw new Error('managed PVC is not an exact Bound hostpath claim');
    }
    return `${item.namespace}/${item.name}`;
  });
  if (JSON.stringify([...pvcReferences].sort()) !== JSON.stringify(REQUIRED_PVCS)
      || storage.pvcSetDigest !== sha256(canonicalJson(storage.pvcs))) {
    throw new Error('managed PVC set is not the canonical four-CBS set');
  }
  digest(storage.pvcSetDigest, 'managed PVC set digest');

  const backend = exactKeys(observation.backend, [
    'deploymentUid', 'resourceVersion', 'consolePublicUrl',
  ], 'Backend observation');
  uid(backend.deploymentUid, 'Backend Deployment UID');
  resourceVersion(backend.resourceVersion, 'Backend Deployment resourceVersion');
  if (normalizeConsoleUrl(backend.consolePublicUrl) !== backend.consolePublicUrl) {
    throw new Error('Backend configuration observation is invalid');
  }

  const auth = exactKeys(observation.authEnvironmentReconstruction, [
    'value', 'status', 'basis',
  ], 'auth environment reconstruction');
  if (auth.value !== 'development'
      || auth.status !== 'SemanticReconstructionApproved'
      || auth.basis !== 'edge-channel-policy') {
    throw new Error('authEnvironment must be explicitly owned by the signed reconstruction approval');
  }

  const shellTls = exactKeys(observation.shellTls, [
    'mode', 'secretName', 'uid', 'resourceVersion', 'secretType', 'dataKeys',
    'workloadSetDigest',
  ], 'Shell TLS observation');
  if (shellTls.mode !== 'managed' || shellTls.secretName !== 'shell-tls'
      || shellTls.secretType !== 'Opaque'
      || JSON.stringify(shellTls.dataKeys) !== JSON.stringify(['ca.crt', 'tls.crt', 'tls.key'])) {
    throw new Error('only the exact managed Shell TLS mode can be reconstructed without config.json');
  }
  uid(shellTls.uid, 'managed Shell TLS UID');
  resourceVersion(shellTls.resourceVersion, 'managed Shell TLS resourceVersion');
  digest(shellTls.workloadSetDigest, 'managed Shell TLS workload set digest');
  return observation;
}

function validateIncidentSource(source) {
  exactKeys(source, ['path', 'documentText', 'documentSha256'], 'incident source');
  if (source.path !== '.codex-tmp/incidents/2026-08-15-installation-lock-accidental-delete.json'
      || sha256(source.documentText) !== source.documentSha256
      || source.documentSha256 !== RECOVERY_INCIDENT.incidentRawSha256) {
    throw new Error('incident source bytes or path differ from the reviewed incident artifact');
  }
  let incident;
  try { incident = JSON.parse(source.documentText); }
  catch { throw new Error('incident source is invalid JSON'); }
  return validateIncident(incident);
}

function validateLocalState(localState) {
  exactKeys(localState, [
    'workspaceRoot', 'receiptDirectory', 'path', 'status', 'quarantine',
  ], 'local installation-lock cache state');
  const quarantine = exactKeys(localState.quarantine, [
    'contract', 'operationId', 'journalPath', 'journalSha256', 'filePath',
    'fileType', 'fileSha256', 'size', 'releaseDigest', 'sourceRevision',
    'completedAt', 'status',
  ], 'stale installation-lock quarantine state');
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(localState.workspaceRoot ?? '')
      || !/^(?:[A-Za-z]:[\\/]|\/)/.test(localState.receiptDirectory ?? '')
      || !/^(?:[A-Za-z]:[\\/]|\/)/.test(quarantine.journalPath ?? '')
      || !/^(?:[A-Za-z]:[\\/]|\/)/.test(quarantine.filePath ?? '')
      || localState.path !== LOCAL_LOCK_PATH
      || localState.status !== 'AbsentAfterExactStaleQuarantine'
      || quarantine.contract !== INSTALLATION_LOCK_RECOVERY_STALE_QUARANTINE_CONTRACT
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(quarantine.operationId ?? '')
      || quarantine.fileType !== 'RegularFile'
      || quarantine.fileSha256 !== REVIEWED_STALE_LOCAL_LOCK.sha256
      || quarantine.size !== REVIEWED_STALE_LOCAL_LOCK.bytes
      || quarantine.releaseDigest !== REVIEWED_STALE_LOCAL_LOCK.releaseDigest
      || quarantine.sourceRevision !== REVIEWED_STALE_LOCAL_LOCK.sourceRevision
      || quarantine.status !== 'Quarantined') {
    throw new Error(`stale ${LOCAL_LOCK_PATH} is forbidden during governed recovery`);
  }
  digest(quarantine.journalSha256, 'stale installation-lock quarantine journal digest');
  isoTimestamp(quarantine.completedAt, 'stale installation-lock quarantine completion');
  return localState;
}

export function validateInstallationLockRecoveryToolingAuthority(authority) {
  exactKeys(authority, [
    'contract', 'repository', 'branch', 'sourceRevision', 'files',
  ], 'recovery tooling authority');
  if (authority.contract !== 'opensphere.installation-lock.recovery-tooling-authority/v1'
      || authority.repository
        !== 'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git'
      || authority.branch !== 'main' || !/^[a-f0-9]{40}$/u.test(authority.sourceRevision ?? '')
      || !Array.isArray(authority.files)
      || authority.files.length !== INSTALLATION_LOCK_RECOVERY_TOOLING_PATHS.length) {
    throw new Error('recovery tooling authority is invalid');
  }
  authority.files.forEach((file, index) => {
    exactKeys(file, ['path', 'sha256', 'gitBlob'], 'recovery tooling file');
    if (file.path !== INSTALLATION_LOCK_RECOVERY_TOOLING_PATHS[index]
        || !/^sha256:[a-f0-9]{64}$/u.test(file.sha256 ?? '')
        || !/^[a-f0-9]{40}$/u.test(file.gitBlob ?? '')) {
      throw new Error('recovery tooling file authority is invalid');
    }
  });
  return authority;
}

function validateTrustObservation(trust) {
  exactKeys(trust, [
    'contract', 'namespace', 'configMapName', 'uid', 'resourceVersion',
    'keyId', 'publicKeySpkiBase64', 'publicKeySpkiSha256',
  ], 'edge trust observation');
  if (trust.contract !== 'opensphere.installation-lock.edge-trust-observation/v1'
      || trust.namespace !== 'opensphere-console'
      || trust.configMapName !== 'dupa-trusted-keys'
      || trust.keyId !== TRUST_KEY_ID
      || sha256(Buffer.from(base64(
        trust.publicKeySpkiBase64, 'edge trust public key'
      ), 'base64')) !== trust.publicKeySpkiSha256) {
    throw new Error('edge trust observation is invalid');
  }
  uid(trust.uid, 'edge trust ConfigMap UID');
  resourceVersion(trust.resourceVersion, 'edge trust ConfigMap resourceVersion');
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(trust.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki',
    });
  } catch { throw new Error('edge trust public key is invalid'); }
  if (publicKey.asymmetricKeyType !== 'ec'
      || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('edge trust public key is not P-256');
  }
  return trust;
}

function validateRuntimeObservation(runtimeObservation, lock) {
  exactKeys(runtimeObservation, [
    'contract', 'observedAt', 'components', 'imageSetDigest',
  ], 'runtime image observation');
  if (runtimeObservation.contract !== 'opensphere.installation-lock.runtime-images/v1') {
    throw new Error('runtime image observation contract is invalid');
  }
  isoTimestamp(runtimeObservation.observedAt, 'runtime image observation timestamp');
  if (!Array.isArray(runtimeObservation.components)
      || runtimeObservation.components.length !== INSTALLATION_LOCK_RECOVERY_RUNTIME_WORKLOADS.length) {
    throw new Error('runtime observation must contain the exact 15 governed workload images');
  }
  const seenComponents = new Set();
  const normalized = runtimeObservation.components.map((component, index) => {
    exactKeys(component, [
      'component', 'kind', 'namespace', 'name', 'uid', 'resourceVersion',
      'container', 'image', 'sourceRevision', 'ready', 'executionState', 'podImageIds',
    ], 'runtime component image');
    const [expectedComponent, expectedKind, expectedNamespace, expectedName, expectedContainer]
      = INSTALLATION_LOCK_RECOVERY_RUNTIME_WORKLOADS[index] ?? [];
    if (!Object.hasOwn(lock.components, component.component)
        || component.component !== expectedComponent
        || component.kind !== expectedKind
        || component.namespace !== expectedNamespace
        || component.name !== expectedName
        || component.container !== expectedContainer) {
      throw new Error('runtime workload identity or order is not canonical');
    }
    seenComponents.add(component.component);
    uid(component.uid, 'runtime workload UID');
    resourceVersion(component.resourceVersion, 'runtime workload resourceVersion');
    if (!Array.isArray(component.podImageIds)
        || JSON.stringify(component.podImageIds)
          !== JSON.stringify([...component.podImageIds].sort())
        || (component.kind === 'CronJob' && component.podImageIds.length !== 0)
        || (component.kind !== 'CronJob'
          && (component.podImageIds.length < 1
            || component.podImageIds.some((imageId) =>
              String(imageId).replace(/^docker-pullable:\/\//, '') !== component.image)))
        || component.image !== lock.components[component.component].image
        || component.sourceRevision !== lock.components[component.component].sourceRevision
        || component.ready !== true
        || component.executionState !== (component.kind === 'CronJob'
          ? 'SuspendedSafeDefault' : 'Ready')) {
      throw new Error(`runtime component ${component.component} differs from the governed lock`);
    }
    return component;
  });
  if (JSON.stringify([...seenComponents].sort()) !== JSON.stringify(Object.keys(lock.components).sort())
      || runtimeObservation.imageSetDigest !== sha256(canonicalJson(normalized))) {
    throw new Error('runtime image set digest differs from the exact 13 live images');
  }
  return runtimeObservation;
}

function validateApproval(approval, expectedDocument, trustObservation) {
  exactKeys(approval, [
    'contract', 'approvalId', 'keyId', 'publicKeySpkiBase64', 'publicKeySpkiSha256',
    'documentText', 'documentSha256', 'signatureBase64',
  ], 'reconstruction approval');
  if (approval.contract !== INSTALLATION_LOCK_RECOVERY_APPROVAL_CONTRACT
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(approval.approvalId ?? '')
      || approval.keyId !== TRUST_KEY_ID
      || approval.documentSha256 !== sha256(approval.documentText)
      || approval.publicKeySpkiSha256 !== sha256(Buffer.from(base64(
        approval.publicKeySpkiBase64, 'approval public key'
      ), 'base64'))
      || approval.publicKeySpkiSha256 !== trustObservation.publicKeySpkiSha256
      || approval.publicKeySpkiBase64 !== trustObservation.publicKeySpkiBase64) {
    throw new Error('reconstruction approval identity or digest is invalid');
  }
  let document;
  try { document = JSON.parse(approval.documentText); }
  catch { throw new Error('reconstruction approval document is invalid JSON'); }
  exactKeys(document, [
    'contract', 'approvalId', 'action', 'incidentRawSha256', 'incidentCanonicalSha256',
    'governedCommit', 'governedPath', 'governedGitBlob', 'governedDocumentSha256',
    'receiptDigest', 'releaseJsonSha256', 'configJsonSha256',
    'configReconstructionStatus', 'runtimeImageSetDigest', 'oldInstallationLockUid',
    'trustConfigUid', 'trustConfigResourceVersion', 'trustKeySpkiSha256',
    'recoveryToolingAuthorityDigest', 'reconstructionDigest', 'preconditionDigest',
    'kubeContext', 'reason', 'approvedAt', 'expiresAt',
  ], 'reconstruction approval document');
  if (document.contract !== INSTALLATION_LOCK_RECOVERY_APPROVAL_CONTRACT
      || document.approvalId !== approval.approvalId
      || document.action !== 'CreateOnlySemanticInstallationLockReconstruction'
      || typeof document.reason !== 'string' || document.reason.trim().length < 12
      || document.reason.length > 512
      || canonicalJson(document) !== canonicalJson(expectedDocument)) {
    throw new Error('reconstruction approval does not bind the exact recovery evidence');
  }
  isoTimestamp(document.approvedAt, 'reconstruction approval timestamp');
  isoTimestamp(document.expiresAt, 'reconstruction approval expiry');
  const approvalWindow = Date.parse(document.expiresAt) - Date.parse(document.approvedAt);
  if (document.kubeContext !== 'docker-desktop'
      || approvalWindow <= 0 || approvalWindow > 30 * 60 * 1000) {
    throw new Error('reconstruction approval context or validity window is invalid');
  }
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(approval.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki',
    });
  } catch { throw new Error('reconstruction approval public key is invalid'); }
  const signature = Buffer.from(base64(approval.signatureBase64, 'approval signature'), 'base64');
  if (signature.length !== 64
      || publicKey.asymmetricKeyType !== 'ec'
      || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      || !verifySignature('sha256', Buffer.from(approval.documentText), {
        key: publicKey, dsaEncoding: 'ieee-p1363',
      }, signature)) {
    throw new Error('reconstruction approval signature is invalid or is not P-256');
  }
  return approval;
}

function validateInstalledLock(lock, incident, receipt) {
  exactKeys(lock, [
    'apiVersion', 'kind', 'channel', 'releaseDigest', 'resolvedAt', 'source',
    'sourceRevision', 'trust', 'releaseScope', 'baseReleaseDigest',
    'changedComponents', 'components',
  ], 'reviewed governed target lock');
  if (lock.apiVersion !== 'release.opensphere.io/v1alpha1'
      || lock.kind !== 'OpenSphereReleaseLock'
      || lock.channel !== 'edge'
      || lock.releaseScope !== 'component'
      || JSON.stringify(lock.changedComponents) !== JSON.stringify(['console'])
      || lock.componentPublication !== undefined
      || lock.releaseDigest !== RECOVERY_INCIDENT.releaseDigest
      || lock.sourceRevision !== RECOVERY_INCIDENT.sourceRevision
      || lock.releaseDigest !== incident.authoritativeRecoveryEvidence.installedReleaseDigest
      || receipt.request_id !== RECOVERY_INCIDENT.requestId
      || receipt.operation_id !== RECOVERY_INCIDENT.operationId
      || receipt.desired_revision !== RECOVERY_INCIDENT.giteaCommit
      || receipt.applied_revision !== RECOVERY_INCIDENT.sourceRevision
      || Buffer.byteLength(JSON.stringify(lock)) !== RECOVERY_INCIDENT.releaseJsonBytes
      || sha256(JSON.stringify(lock)) !== RECOVERY_INCIDENT.releaseJsonSha256) {
    throw new Error('governed target lock differs from the incident recovery profile');
  }
  return lock;
}

function recoveredConfig(lock, observation) {
  return {
    apiVersion: 'bootstrap.opensphere.io/v1alpha1',
    kind: 'OpenSphereInstallationConfig',
    architecture: 'supabase-data-identity+gitea-change-authority',
    channel: lock.channel,
    releaseDigest: lock.releaseDigest,
    storageClass: observation.managedStorage.storageClass,
    consoleUrl: observation.backend.consolePublicUrl,
    authEnvironment: observation.authEnvironmentReconstruction.value,
    initialAdmin: {
      username: observation.initialAdmin.username,
      displayName: observation.initialAdmin.displayName,
      email: observation.initialAdmin.email,
    },
  };
}

function prepareInstallationLockRecovery(bundle) {
  exactKeys(bundle, [
    'contract', 'incidentSource', 'governedSource', 'receipt', 'configObservation',
    'runtimeObservation', 'trustObservation', 'localState', 'recoveryToolingAuthority',
  ], 'recovery evidence bundle');
  if (bundle.contract !== INSTALLATION_LOCK_RECOVERY_EVIDENCE_CONTRACT) {
    throw new Error('recovery evidence contract is invalid');
  }
  const incident = validateIncidentSource(bundle.incidentSource);
  validateLocalState(bundle.localState);
  const trustObservation = validateTrustObservation(bundle.trustObservation);
  const recoveryToolingAuthority = validateInstallationLockRecoveryToolingAuthority(
    bundle.recoveryToolingAuthority
  );
  const { desired } = validateGovernedSource(bundle.governedSource, incident);
  const provisionalLock = desired.targetLock;
  validateReceipt(bundle.receipt, incident, provisionalLock);
  const lock = validateInstalledLock(provisionalLock, incident, bundle.receipt);
  const observation = validateObservation(bundle.configObservation, incident, lock);
  const runtimeObservation = validateRuntimeObservation(bundle.runtimeObservation, lock);
  const releaseJson = JSON.stringify(lock);
  const configJson = JSON.stringify(recoveredConfig(lock, observation));
  if (sha256(releaseJson) !== observation.expectedReleaseJsonSha256
      || sha256(configJson) !== observation.expectedConfigJsonSha256
      || Buffer.byteLength(releaseJson) !== RECOVERY_INCIDENT.releaseJsonBytes
      || Buffer.byteLength(configJson) !== RECOVERY_INCIDENT.configJsonBytes
      || sha256(releaseJson) !== RECOVERY_INCIDENT.releaseJsonSha256
      || sha256(configJson) !== RECOVERY_INCIDENT.configJsonSha256) {
    throw new Error('reconstructed installation-lock bytes differ from the reviewed expected digests');
  }
  const reconstruction = {
    releaseJsonStatus: 'ByteExactFromGovernedGiteaTargetLock',
    configJsonStatus: 'SemanticReconstructionApprovedNotHistoricalByteRestore',
    releaseJsonSha256: sha256(releaseJson),
    configJsonSha256: sha256(configJson),
    authEnvironmentStatus: observation.authEnvironmentReconstruction.status,
  };
  const unsignedEvidence = {
    incidentRawSha256: bundle.incidentSource.documentSha256,
    incidentCanonicalSha256: sha256(canonicalJson(incident)),
    governedCommit: bundle.governedSource.commit,
    governedPath: bundle.governedSource.path,
    governedGitBlob: bundle.governedSource.gitBlob,
    governedDocumentSha256: bundle.governedSource.documentSha256,
    receiptDigest: sha256(canonicalJson(bundle.receipt)),
    installationEvidenceDigest: sha256(canonicalJson(observation.installationEvidence)),
    releaseInventoryDigest: sha256(canonicalJson(observation.releaseInventory)),
    runtimeImageSetDigest: runtimeObservation.imageSetDigest,
    recoveryToolingAuthorityDigest: sha256(canonicalJson(recoveryToolingAuthority)),
    reconstruction,
  };
  const reconstructionDigest = sha256(canonicalJson(unsignedEvidence));
  const preconditions = {
    installationLock: 'Absent',
    oldInstallationLockUid: incident.resource.preDeleteUid,
    installationEvidence: observation.installationEvidence,
    releaseInventory: observation.releaseInventory,
    configurationObservation: observation,
    runtimeObservation,
    runtimeImageSetDigest: runtimeObservation.imageSetDigest,
    configurationObservationDigest: sha256(canonicalJson(observation)),
    trustObservation,
    recoveryToolingAuthority,
    localState: bundle.localState,
    localInstallationLockCache: 'Absent',
  };
  return {
    incident, lock, observation, runtimeObservation, trustObservation, recoveryToolingAuthority,
    releaseJson, configJson, reconstruction, unsignedEvidence,
    reconstructionDigest, preconditions,
  };
}

export function buildInstallationLockRecoveryApprovalDocument(bundle, {
  approvalId, reason, approvedAt, expiresAt,
} = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(approvalId ?? '')
      || typeof reason !== 'string' || reason.trim().length < 12 || reason.length > 512) {
    throw new Error('reconstruction approval identity or reason is invalid');
  }
  isoTimestamp(approvedAt, 'reconstruction approval timestamp');
  isoTimestamp(expiresAt, 'reconstruction approval expiry');
  const approvalWindow = Date.parse(expiresAt) - Date.parse(approvedAt);
  if (approvalWindow <= 0 || approvalWindow > 30 * 60 * 1000) {
    throw new Error('reconstruction approval validity must be greater than zero and at most 30 minutes');
  }
  const prepared = prepareInstallationLockRecovery(bundle);
  return {
    contract: INSTALLATION_LOCK_RECOVERY_APPROVAL_CONTRACT,
    approvalId,
    action: 'CreateOnlySemanticInstallationLockReconstruction',
    incidentRawSha256: bundle.incidentSource.documentSha256,
    incidentCanonicalSha256: prepared.unsignedEvidence.incidentCanonicalSha256,
    governedCommit: bundle.governedSource.commit,
    governedPath: bundle.governedSource.path,
    governedGitBlob: bundle.governedSource.gitBlob,
    governedDocumentSha256: bundle.governedSource.documentSha256,
    receiptDigest: prepared.unsignedEvidence.receiptDigest,
    releaseJsonSha256: prepared.reconstruction.releaseJsonSha256,
    configJsonSha256: prepared.reconstruction.configJsonSha256,
    configReconstructionStatus: prepared.reconstruction.configJsonStatus,
    runtimeImageSetDigest: prepared.runtimeObservation.imageSetDigest,
    oldInstallationLockUid: prepared.incident.resource.preDeleteUid,
    trustConfigUid: prepared.trustObservation.uid,
    trustConfigResourceVersion: prepared.trustObservation.resourceVersion,
    trustKeySpkiSha256: prepared.trustObservation.publicKeySpkiSha256,
    recoveryToolingAuthorityDigest:
      prepared.unsignedEvidence.recoveryToolingAuthorityDigest,
    reconstructionDigest: prepared.reconstructionDigest,
    preconditionDigest: sha256(canonicalJson(prepared.preconditions)),
    kubeContext: 'docker-desktop',
    reason,
    approvedAt,
    expiresAt,
  };
}

export function buildInstallationLockRecoveryPlan(bundle) {
  exactKeys(bundle, [
    'contract', 'incidentSource', 'governedSource', 'receipt', 'configObservation',
    'runtimeObservation', 'trustObservation', 'localState', 'recoveryToolingAuthority', 'approval',
  ], 'recovery evidence bundle');
  const evidenceBundle = Object.fromEntries(
    Object.entries(bundle).filter(([key]) => key !== 'approval')
  );
  const prepared = prepareInstallationLockRecovery(evidenceBundle);
  let approvalDocument;
  try { approvalDocument = JSON.parse(bundle.approval.documentText); }
  catch { throw new Error('reconstruction approval document is invalid JSON'); }
  const expectedApprovalDocument = buildInstallationLockRecoveryApprovalDocument(evidenceBundle, {
    approvalId: bundle.approval.approvalId,
    reason: approvalDocument.reason,
    approvedAt: approvalDocument.approvedAt,
    expiresAt: approvalDocument.expiresAt,
  });
  const approval = validateApproval(
    bundle.approval, expectedApprovalDocument, prepared.trustObservation
  );
  const evidence = {
    ...prepared.unsignedEvidence,
    reconstructionDigest: prepared.reconstructionDigest,
    approvalId: approval.approvalId,
    approvalDocumentSha256: approval.documentSha256,
    approvalSignatureSha256: sha256(Buffer.from(approval.signatureBase64, 'base64')),
    approvalKeyId: approval.keyId,
    approvalKeySpkiSha256: approval.publicKeySpkiSha256,
    preconditionDigest: sha256(canonicalJson(prepared.preconditions)),
  };
  const manifest = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'opensphere-installation-lock',
      namespace: 'opensphere-console',
      labels: {
        'app.kubernetes.io/managed-by': 'opensphere-setup',
        'opensphere.io/evidence-kind': 'installation-lock-recovery',
      },
      annotations: {
        'opensphere.io/recovery-incident': prepared.incident.incidentId,
        'opensphere.io/recovery-pre-delete-uid': prepared.incident.resource.preDeleteUid,
        'opensphere.io/recovery-approval-id': approval.approvalId,
        'opensphere.io/recovery-evidence-digest': sha256(canonicalJson(evidence)),
      },
    },
    data: { 'release.json': prepared.releaseJson, 'config.json': prepared.configJson },
  };
  const unsigned = {
    contract: INSTALLATION_LOCK_RECOVERY_PLAN_CONTRACT,
    incidentId: prepared.incident.incidentId,
    requestId: bundle.receipt.request_id,
    operationId: bundle.receipt.operation_id,
    mergeRevision: bundle.receipt.desired_revision,
    releaseDigest: prepared.lock.releaseDigest,
    sourceRevision: prepared.lock.sourceRevision,
    approvalId: approval.approvalId,
    approval,
    evidence,
    reconstruction: prepared.reconstruction,
    preconditions: prepared.preconditions,
    manifest,
    execution: {
      authority: 'explicit-preservation-recovery',
      createMode: 'POST-create-only',
      conflictMode: 'HTTP-409-then-exact-GET-verify-only',
      rollbackMode: 'UID+resourceVersion-precondition-delete-only-before-success-receipt',
      completion: 'post-create exact verify + durable recovery receipt',
      kubeContext: 'docker-desktop',
    },
  };
  return { ...unsigned, planDigest: sha256(canonicalJson(unsigned)) };
}

function recoveredLockMatches(object, plan) {
  return object?.apiVersion === 'v1' && object?.kind === 'ConfigMap'
    && object?.metadata?.name === plan.manifest.metadata.name
    && object?.metadata?.namespace === plan.manifest.metadata.namespace
    && canonicalJson(object.metadata?.labels ?? {}) === canonicalJson(plan.manifest.metadata.labels)
    && canonicalJson(object.metadata?.annotations ?? {}) === canonicalJson(plan.manifest.metadata.annotations)
    && object.metadata?.deletionTimestamp === undefined
    && object.metadata?.deletionGracePeriodSeconds === undefined
    && canonicalJson(object.metadata?.finalizers ?? []) === '[]'
    && canonicalJson(object.metadata?.ownerReferences ?? []) === '[]'
    && canonicalJson(object.data) === canonicalJson(plan.manifest.data)
    && object.binaryData === undefined
    && object.immutable === undefined;
}

export function validateInstallationLockRecoveryPlan(plan) {
  exactKeys(plan, [
    'contract', 'incidentId', 'requestId', 'operationId', 'mergeRevision',
    'releaseDigest', 'sourceRevision', 'approvalId', 'approval', 'evidence',
    'reconstruction', 'preconditions', 'manifest', 'execution', 'planDigest',
  ], 'installation-lock recovery plan');
  const unsigned = Object.fromEntries(
    Object.entries(plan).filter(([key]) => key !== 'planDigest')
  );
  if (plan.contract !== INSTALLATION_LOCK_RECOVERY_PLAN_CONTRACT
      || plan.incidentId !== RECOVERY_INCIDENT.incidentId
      || plan.requestId !== RECOVERY_INCIDENT.requestId
      || plan.operationId !== RECOVERY_INCIDENT.operationId
      || plan.mergeRevision !== RECOVERY_INCIDENT.giteaCommit
      || plan.releaseDigest !== RECOVERY_INCIDENT.releaseDigest
      || plan.sourceRevision !== RECOVERY_INCIDENT.sourceRevision
      || plan.planDigest !== sha256(canonicalJson(unsigned))) {
    throw new Error('installation-lock recovery plan identity or digest is invalid');
  }
  exactKeys(plan.reconstruction, [
    'releaseJsonStatus', 'configJsonStatus', 'releaseJsonSha256',
    'configJsonSha256', 'authEnvironmentStatus',
  ], 'installation-lock reconstruction');
  if (plan.reconstruction.releaseJsonStatus !== 'ByteExactFromGovernedGiteaTargetLock'
      || plan.reconstruction.configJsonStatus
        !== 'SemanticReconstructionApprovedNotHistoricalByteRestore'
      || plan.reconstruction.releaseJsonSha256 !== RECOVERY_INCIDENT.releaseJsonSha256
      || plan.reconstruction.configJsonSha256 !== RECOVERY_INCIDENT.configJsonSha256
      || plan.reconstruction.authEnvironmentStatus !== 'SemanticReconstructionApproved') {
    throw new Error('installation-lock reconstruction status is invalid');
  }
  exactKeys(plan.preconditions, [
    'installationLock', 'oldInstallationLockUid', 'installationEvidence',
    'releaseInventory', 'configurationObservation', 'runtimeObservation',
    'runtimeImageSetDigest', 'configurationObservationDigest', 'trustObservation',
    'recoveryToolingAuthority', 'localState', 'localInstallationLockCache',
  ], 'installation-lock recovery preconditions');
  if (plan.preconditions.installationLock !== 'Absent'
      || plan.preconditions.oldInstallationLockUid !== RECOVERY_INCIDENT.oldInstallationLockUid
      || plan.preconditions.localInstallationLockCache !== 'Absent') {
    throw new Error('installation-lock recovery preconditions are invalid');
  }
  validateLocalState(plan.preconditions.localState);
  const tooling = validateInstallationLockRecoveryToolingAuthority(
    plan.preconditions.recoveryToolingAuthority
  );
  const trust = validateTrustObservation(plan.preconditions.trustObservation);
  let recoveredLock;
  try { recoveredLock = JSON.parse(plan.manifest?.data?.['release.json'] ?? '{}'); }
  catch { throw new Error('recovered release lock is invalid JSON'); }
  const incidentProfile = {
    event: { observedAtKst: '2026-08-15T22:53:08+09:00' },
    authoritativeRecoveryEvidence: {
      installationEvidenceConfigMap: {
        uid: RECOVERY_INCIDENT.installationEvidenceUid,
        resourceVersion: RECOVERY_INCIDENT.installationEvidenceResourceVersion,
      },
      releaseInventoryConfigMap: {
        uid: RECOVERY_INCIDENT.releaseInventoryUid,
        resourceVersion: RECOVERY_INCIDENT.releaseInventoryResourceVersion,
      },
    },
  };
  validateObservation(plan.preconditions.configurationObservation, incidentProfile, recoveredLock);
  validateRuntimeObservation(plan.preconditions.runtimeObservation, recoveredLock);
  if (plan.preconditions.configurationObservationDigest
        !== sha256(canonicalJson(plan.preconditions.configurationObservation))
      || plan.preconditions.runtimeImageSetDigest
        !== plan.preconditions.runtimeObservation.imageSetDigest
      || canonicalJson(plan.preconditions.installationEvidence)
        !== canonicalJson(plan.preconditions.configurationObservation.installationEvidence)
      || canonicalJson(plan.preconditions.releaseInventory)
        !== canonicalJson(plan.preconditions.configurationObservation.releaseInventory)) {
    throw new Error('installation-lock recovery observed preconditions are inconsistent');
  }
  exactKeys(plan.evidence, [
    'incidentRawSha256', 'incidentCanonicalSha256', 'governedCommit', 'governedPath',
    'governedGitBlob', 'governedDocumentSha256', 'receiptDigest',
    'installationEvidenceDigest', 'releaseInventoryDigest', 'runtimeImageSetDigest',
    'recoveryToolingAuthorityDigest', 'reconstruction', 'reconstructionDigest',
    'approvalId', 'approvalDocumentSha256',
    'approvalSignatureSha256', 'approvalKeyId', 'approvalKeySpkiSha256',
    'preconditionDigest',
  ], 'installation-lock recovery evidence');
  if (plan.evidence.incidentRawSha256 !== RECOVERY_INCIDENT.incidentRawSha256
      || plan.evidence.incidentCanonicalSha256 !== RECOVERY_INCIDENT.incidentCanonicalSha256
      || plan.evidence.governedCommit !== RECOVERY_INCIDENT.giteaCommit
      || plan.evidence.governedPath !== RECOVERY_INCIDENT.giteaPath
      || plan.evidence.governedGitBlob !== RECOVERY_INCIDENT.giteaBlob
      || plan.evidence.governedDocumentSha256 !== RECOVERY_INCIDENT.governedDocumentSha256
      || plan.evidence.receiptDigest !== RECOVERY_INCIDENT.receiptSha256
      || plan.evidence.reconstructionDigest
        !== sha256(canonicalJson(Object.fromEntries([
          ['incidentRawSha256', plan.evidence.incidentRawSha256],
          ['incidentCanonicalSha256', plan.evidence.incidentCanonicalSha256],
          ['governedCommit', plan.evidence.governedCommit],
          ['governedPath', plan.evidence.governedPath],
          ['governedGitBlob', plan.evidence.governedGitBlob],
          ['governedDocumentSha256', plan.evidence.governedDocumentSha256],
          ['receiptDigest', plan.evidence.receiptDigest],
          ['installationEvidenceDigest', plan.evidence.installationEvidenceDigest],
          ['releaseInventoryDigest', plan.evidence.releaseInventoryDigest],
          ['runtimeImageSetDigest', plan.evidence.runtimeImageSetDigest],
          ['recoveryToolingAuthorityDigest', plan.evidence.recoveryToolingAuthorityDigest],
          ['reconstruction', plan.evidence.reconstruction],
        ])))
      || canonicalJson(plan.evidence.reconstruction) !== canonicalJson(plan.reconstruction)
      || plan.evidence.recoveryToolingAuthorityDigest !== sha256(canonicalJson(tooling))
      || plan.evidence.preconditionDigest !== sha256(canonicalJson(plan.preconditions))
      || plan.evidence.approvalId !== plan.approvalId
      || plan.evidence.approvalKeyId !== TRUST_KEY_ID
      || plan.evidence.approvalKeySpkiSha256 !== trust.publicKeySpkiSha256
      || plan.evidence.approvalDocumentSha256 !== plan.approval.documentSha256
      || plan.evidence.approvalSignatureSha256
        !== sha256(Buffer.from(base64(plan.approval.signatureBase64, 'approval signature'), 'base64'))) {
    throw new Error('installation-lock recovery evidence is invalid');
  }
  let approvalDocument;
  try { approvalDocument = JSON.parse(plan.approval.documentText); }
  catch { throw new Error('reconstruction approval document is invalid JSON'); }
  const expectedApprovalDocument = {
    contract: INSTALLATION_LOCK_RECOVERY_APPROVAL_CONTRACT,
    approvalId: plan.approvalId,
    action: 'CreateOnlySemanticInstallationLockReconstruction',
    incidentRawSha256: plan.evidence.incidentRawSha256,
    incidentCanonicalSha256: plan.evidence.incidentCanonicalSha256,
    governedCommit: plan.evidence.governedCommit,
    governedPath: plan.evidence.governedPath,
    governedGitBlob: plan.evidence.governedGitBlob,
    governedDocumentSha256: plan.evidence.governedDocumentSha256,
    receiptDigest: plan.evidence.receiptDigest,
    releaseJsonSha256: plan.reconstruction.releaseJsonSha256,
    configJsonSha256: plan.reconstruction.configJsonSha256,
    configReconstructionStatus: plan.reconstruction.configJsonStatus,
    runtimeImageSetDigest: plan.evidence.runtimeImageSetDigest,
    oldInstallationLockUid: plan.preconditions.oldInstallationLockUid,
    trustConfigUid: trust.uid,
    trustConfigResourceVersion: trust.resourceVersion,
    trustKeySpkiSha256: trust.publicKeySpkiSha256,
    recoveryToolingAuthorityDigest: plan.evidence.recoveryToolingAuthorityDigest,
    reconstructionDigest: plan.evidence.reconstructionDigest,
    preconditionDigest: plan.evidence.preconditionDigest,
    kubeContext: 'docker-desktop',
    reason: approvalDocument.reason,
    approvedAt: approvalDocument.approvedAt,
    expiresAt: approvalDocument.expiresAt,
  };
  validateApproval(plan.approval, expectedApprovalDocument, trust);
  exactKeys(plan.manifest, ['apiVersion', 'kind', 'metadata', 'data'], 'recovery manifest');
  exactKeys(plan.manifest.metadata, ['name', 'namespace', 'labels', 'annotations'], 'recovery manifest metadata');
  exactKeys(plan.manifest.data, ['release.json', 'config.json'], 'recovery manifest data');
  if (plan.manifest.apiVersion !== 'v1' || plan.manifest.kind !== 'ConfigMap'
      || plan.manifest.metadata.name !== 'opensphere-installation-lock'
      || plan.manifest.metadata.namespace !== 'opensphere-console'
      || Buffer.byteLength(plan.manifest.data['release.json']) !== RECOVERY_INCIDENT.releaseJsonBytes
      || Buffer.byteLength(plan.manifest.data['config.json']) !== RECOVERY_INCIDENT.configJsonBytes
      || sha256(plan.manifest.data['release.json']) !== RECOVERY_INCIDENT.releaseJsonSha256
      || sha256(plan.manifest.data['config.json']) !== RECOVERY_INCIDENT.configJsonSha256
      || plan.manifest.metadata.annotations?.['opensphere.io/recovery-incident']
        !== RECOVERY_INCIDENT.incidentId
      || plan.manifest.metadata.annotations?.['opensphere.io/recovery-pre-delete-uid']
        !== RECOVERY_INCIDENT.oldInstallationLockUid
      || plan.manifest.metadata.annotations?.['opensphere.io/recovery-approval-id']
        !== plan.approvalId
      || plan.manifest.metadata.annotations?.['opensphere.io/recovery-evidence-digest']
        !== sha256(canonicalJson(plan.evidence))) {
    throw new Error('installation-lock recovery manifest is invalid');
  }
  exactKeys(plan.execution, [
    'authority', 'createMode', 'conflictMode', 'rollbackMode', 'completion', 'kubeContext',
  ], 'installation-lock recovery execution');
  if (plan.execution.authority !== 'explicit-preservation-recovery'
      || plan.execution.createMode !== 'POST-create-only'
      || plan.execution.conflictMode !== 'HTTP-409-then-exact-GET-verify-only'
      || plan.execution.rollbackMode
        !== 'UID+resourceVersion-precondition-delete-only-before-success-receipt'
      || plan.execution.completion !== 'post-create exact verify + durable recovery receipt'
      || plan.execution.kubeContext !== 'docker-desktop') {
    throw new Error('installation-lock recovery execution contract is invalid');
  }
  return plan;
}

function validateRecoveryReceiptForPlan(receipt, plan) {
  const successKeys = [
    'contract', 'planDigest', 'incidentId', 'requestId', 'operationId', 'mergeRevision',
    'approvalId', 'succeeded', 'state', 'releaseDigest', 'sourceRevision',
    'oldInstallationLockUid', 'recoveredUid', 'recoveredResourceVersion',
    'responseLossReplay', 'reconstruction', 'evidence', 'verification',
    'observedAt', 'completedAt',
  ];
  const failureKeys = [
    'contract', 'planDigest', 'incidentId', 'requestId', 'operationId', 'mergeRevision',
    'approvalId', 'succeeded', 'state', 'releaseDigest', 'sourceRevision',
    'oldInstallationLockUid', 'recoveredUid', 'recoveredResourceVersion',
    'reconstruction', 'evidence', 'error', 'observedAt', 'completedAt',
  ];
  exactKeys(receipt, receipt?.succeeded === true ? successKeys : failureKeys, 'recovery receipt');
  if (receipt.contract !== INSTALLATION_LOCK_RECOVERY_RECEIPT_CONTRACT
      || receipt.planDigest !== plan.planDigest
      || receipt.incidentId !== plan.incidentId
      || receipt.approvalId !== plan.approvalId
      || receipt.releaseDigest !== plan.releaseDigest
      || receipt.oldInstallationLockUid !== plan.preconditions.oldInstallationLockUid
      || canonicalJson(receipt.reconstruction) !== canonicalJson(plan.reconstruction)
      || canonicalJson(receipt.evidence) !== canonicalJson(plan.evidence)) {
    throw new Error('a different or malformed recovery receipt already exists');
  }
  uid(receipt.recoveredUid, 'recovery receipt recovered UID');
  resourceVersion(receipt.recoveredResourceVersion, 'recovery receipt recovered resourceVersion');
  isoTimestamp(receipt.observedAt, 'recovery receipt observation timestamp');
  isoTimestamp(receipt.completedAt, 'recovery receipt completion timestamp');
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.observedAt)) {
    throw new Error('a different or malformed recovery receipt already exists');
  }
  if (receipt.succeeded === true) {
    if (receipt.state !== 'SemanticReconstructionRecovered'
        || receipt.requestId !== plan.requestId
        || receipt.operationId !== plan.operationId
        || receipt.mergeRevision !== plan.mergeRevision
        || receipt.sourceRevision !== plan.sourceRevision
        || typeof receipt.responseLossReplay !== 'boolean') {
      throw new Error('a different or malformed recovery receipt already exists');
    }
  } else if (receipt.succeeded !== false
      || !['RollbackClaimed', 'RolledBackToMissing', 'NeedsAttentionPreservedExactObject'].includes(receipt.state)
      || receipt.requestId !== plan.requestId
      || receipt.operationId !== plan.operationId
      || receipt.mergeRevision !== plan.mergeRevision
      || receipt.sourceRevision !== plan.sourceRevision
      || typeof receipt.error !== 'string' || receipt.error.length < 1) {
    throw new Error('a different or malformed recovery receipt already exists');
  }
  return receipt;
}

function recoveryReceiptBase(plan, runtime, {
  succeeded, state, uidValue, rvValue, observedAt, error,
} = {}) {
  const receipt = {
    contract: INSTALLATION_LOCK_RECOVERY_RECEIPT_CONTRACT,
    planDigest: plan.planDigest,
    incidentId: plan.incidentId,
    requestId: plan.requestId,
    operationId: plan.operationId,
    mergeRevision: plan.mergeRevision,
    approvalId: plan.approvalId,
    succeeded,
    state,
    releaseDigest: plan.releaseDigest,
    sourceRevision: plan.sourceRevision,
    oldInstallationLockUid: plan.preconditions.oldInstallationLockUid,
    recoveredUid: uidValue,
    recoveredResourceVersion: rvValue,
    reconstruction: plan.reconstruction,
    evidence: plan.evidence,
    observedAt,
    completedAt: runtime.now(),
    ...(succeeded === false ? { error: String(error) } : {}),
  };
  validateRecoveryReceiptForPlan(receipt, plan);
  return receipt;
}

function recoveryNeedsAttention(message) {
  const error = new Error(`NeedsAttention: ${message}`);
  error.code = 'InstallationLockRecoveryVerificationNeedsAttention';
  return error;
}

async function writeRecoveryReceipt(runtime, receipt) {
  try {
    await runtime.writeReceipt(receipt);
  } catch (error) {
    const pending = new Error(
      `NeedsAttention: durable recovery receipt is pending (${error.message})`
    );
    pending.code = 'InstallationLockRecoveryReceiptPending';
    pending.receipt = receipt;
    throw pending;
  }
  return receipt;
}

function exactRecoveredIdentity(state, plan, receipt) {
  return recoveredLockMatches(state.installationLock, plan)
    && state.installationLock?.metadata?.uid === receipt.recoveredUid
    && state.installationLock?.metadata?.resourceVersion === receipt.recoveredResourceVersion;
}

async function resumeClaimedRollback(plan, runtime, claim, state) {
  const finalize = async () => writeRecoveryReceipt(runtime, recoveryReceiptBase(plan, runtime, {
    succeeded: false,
    state: 'RolledBackToMissing',
    uidValue: claim.recoveredUid,
    rvValue: claim.recoveredResourceVersion,
    observedAt: claim.observedAt,
    error: claim.error,
  }));
  const preserveDifferent = async (detail) => {
    const receipt = recoveryReceiptBase(plan, runtime, {
      succeeded: false,
      state: 'NeedsAttentionPreservedExactObject',
      uidValue: claim.recoveredUid,
      rvValue: claim.recoveredResourceVersion,
      observedAt: claim.observedAt,
      error: detail,
    });
    await writeRecoveryReceipt(runtime, receipt);
    throw recoveryNeedsAttention(detail);
  };
  if (!state.installationLock) {
    await finalize();
    throw new Error('owned recovery rollback is complete; a new approval is required');
  }
  if (!exactRecoveredIdentity(state, plan, claim)) {
    return preserveDifferent('rollback claim encountered a different installation-lock object; preserving it');
  }
  try {
    await runtime.deleteConfigMap({
      uid: claim.recoveredUid,
      resourceVersion: claim.recoveredResourceVersion,
    });
  } catch (deleteError) {
    const afterError = await runtime.observe();
    if (!afterError.installationLock) {
      await finalize();
      throw new Error('owned recovery rollback completed after an ambiguous DELETE response; a new approval is required');
    }
    if (!exactRecoveredIdentity(afterError, plan, claim)) {
      return preserveDifferent(
        `rollback DELETE became ambiguous and a different object is present; preserving it (${deleteError.message})`
      );
    }
    throw recoveryNeedsAttention(
      `rollback claim remains active after an ambiguous DELETE response; replay the same plan (${deleteError.message})`
    );
  }
  const afterDelete = await runtime.observe();
  if (!afterDelete.installationLock) {
    await finalize();
    throw new Error('owned recovery rollback is complete; a new approval is required');
  }
  if (!exactRecoveredIdentity(afterDelete, plan, claim)) {
    return preserveDifferent('rollback completed concurrently with creation of a different object; preserving it');
  }
  throw recoveryNeedsAttention('rollback DELETE returned success but the exact claimed object remains; replay the same plan');
}

export async function executeInstallationLockRecovery(plan, runtime) {
  validateInstallationLockRecoveryPlan(plan);
  const required = [
    'observe', 'readReceipt', 'createConfigMap', 'deleteConfigMap',
    'verifyRecoveredInstallation', 'writeReceipt', 'now',
  ];
  if (required.some((name) => typeof runtime?.[name] !== 'function')) {
    throw new Error('installation-lock recovery runtime is incomplete');
  }
  const priorReceipt = await runtime.readReceipt(plan.planDigest);
  if (priorReceipt) {
    validateRecoveryReceiptForPlan(priorReceipt, plan);
    if (!priorReceipt.succeeded && priorReceipt.state === 'RolledBackToMissing') {
      throw new Error('this recovery plan already has a durable failure receipt; a new approval is required');
    }
  }
  let state = await runtime.observe();
  if (state.preconditionDigest !== plan.evidence.preconditionDigest) {
    throw new Error('installation-lock recovery preconditions drifted before create');
  }
  if (priorReceipt?.state === 'RollbackClaimed') {
    return resumeClaimedRollback(plan, runtime, priorReceipt, state);
  }
  if (priorReceipt && !recoveredLockMatches(state.installationLock, plan)) {
    throw new Error('durable recovery receipt exists but its recovered installation lock is missing or different; a new approval is required');
  }
  const approvalDocument = JSON.parse(plan.approval.documentText);
  const executionStartedAt = runtime.now();
  isoTimestamp(executionStartedAt, 'recovery execution timestamp');
  const observedAt = executionStartedAt;
  let created = false;
  let ownedByThisExecution = false;
  let createResponse = null;
  if (state.installationLock && !recoveredLockMatches(state.installationLock, plan)) {
    throw new Error('a different installation lock already exists');
  }
  if (!state.installationLock) {
    if (!priorReceipt && (Date.parse(executionStartedAt) < Date.parse(approvalDocument.approvedAt)
        || Date.parse(executionStartedAt) > Date.parse(approvalDocument.expiresAt))) {
      throw new Error('installation-lock recovery approval is not fresh for create');
    }
    try {
      createResponse = await runtime.createConfigMap(structuredClone(plan.manifest));
    } catch (error) {
      if (error?.statusCode !== 409 && error?.code !== 'AlreadyExists'
          && error?.code !== 'ResponseLost') {
        throw error;
      }
      state = await runtime.observe();
      if (!recoveredLockMatches(state.installationLock, plan)) {
        throw new Error('installation-lock create failed without an exact response-loss recovery object');
      }
    }
  }
  state = await runtime.observe();
  if (state.preconditionDigest !== plan.evidence.preconditionDigest
      || !recoveredLockMatches(state.installationLock, plan)) {
    throw new Error('installation-lock recovery post-create state drifted');
  }
  const uidValue = uid(state.installationLock.metadata?.uid, 'recovered installation-lock UID');
  const rvValue = resourceVersion(
    state.installationLock.metadata?.resourceVersion, 'recovered installation-lock resourceVersion'
  );
  if (createResponse && recoveredLockMatches(createResponse, plan)
      && createResponse.metadata?.uid === uidValue
      && createResponse.metadata?.resourceVersion === rvValue) {
    created = true;
    ownedByThisExecution = true;
  }
  let verification;
  try {
    verification = await runtime.verifyRecoveredInstallation(plan);
    exactKeys(verification, [
      'releaseDigest', 'releaseJsonSha256', 'configJsonSha256', 'runtimeImagesMatchLock',
      'runtimeImageSetDigest', 'installationEvidenceUid',
      'installationEvidenceResourceVersion', 'releaseInventoryUid',
      'releaseInventoryResourceVersion',
    ], 'recovery verification');
    if (verification.releaseDigest !== plan.releaseDigest
        || verification.releaseJsonSha256 !== plan.reconstruction.releaseJsonSha256
        || verification.configJsonSha256 !== plan.reconstruction.configJsonSha256
        || verification.runtimeImagesMatchLock !== true
        || verification.runtimeImageSetDigest !== plan.evidence.runtimeImageSetDigest
        || verification.installationEvidenceUid !== plan.preconditions.installationEvidence.uid
        || verification.installationEvidenceResourceVersion
          !== plan.preconditions.installationEvidence.resourceVersion
        || verification.releaseInventoryUid !== plan.preconditions.releaseInventory.uid
        || verification.releaseInventoryResourceVersion
          !== plan.preconditions.releaseInventory.resourceVersion) {
      throw new Error('recovered installation verification differs from the plan');
    }
  } catch (error) {
    if (ownedByThisExecution && !priorReceipt) {
      const claim = recoveryReceiptBase(plan, runtime, {
        succeeded: false,
        state: 'RollbackClaimed',
        uidValue,
        rvValue,
        observedAt,
        error: String(error.message || error),
      });
      await writeRecoveryReceipt(runtime, claim);
      return resumeClaimedRollback(plan, runtime, claim, state);
    } else if (!priorReceipt) {
      const preserved = recoveryReceiptBase(plan, runtime, {
        succeeded: false,
        state: 'NeedsAttentionPreservedExactObject',
        uidValue,
        rvValue,
        observedAt,
        error: String(error.message || error),
      });
      await writeRecoveryReceipt(runtime, preserved);
      throw recoveryNeedsAttention(
        `an exact recovery object is not owned by this execution and verification failed; preserving it (${error.message})`
      );
    }
    throw error;
  }
  const receipt = {
    contract: INSTALLATION_LOCK_RECOVERY_RECEIPT_CONTRACT,
    planDigest: plan.planDigest,
    incidentId: plan.incidentId,
    requestId: plan.requestId,
    operationId: plan.operationId,
    mergeRevision: plan.mergeRevision,
    approvalId: plan.approvalId,
    succeeded: true,
    state: 'SemanticReconstructionRecovered',
    releaseDigest: plan.releaseDigest,
    sourceRevision: plan.sourceRevision,
    oldInstallationLockUid: plan.preconditions.oldInstallationLockUid,
    recoveredUid: uidValue,
    recoveredResourceVersion: rvValue,
    responseLossReplay: !created,
    reconstruction: plan.reconstruction,
    evidence: plan.evidence,
    verification,
    observedAt,
    completedAt: runtime.now(),
  };
  if (priorReceipt?.succeeded === true) {
    if (canonicalJson(priorReceipt.verification) !== canonicalJson(verification)
        || priorReceipt.recoveredUid !== uidValue
        || priorReceipt.recoveredResourceVersion !== rvValue
        || priorReceipt.state !== 'SemanticReconstructionRecovered') {
      throw new Error('durable recovery receipt differs from the current exact recovered state');
    }
    return priorReceipt;
  }
  try {
    await runtime.writeReceipt(receipt);
  } catch (error) {
    const pending = new Error(`NeedsAttention: recovered lock is verified but durable receipt is pending (${error.message})`);
    pending.code = 'InstallationLockRecoveryReceiptPending';
    pending.receipt = receipt;
    throw pending;
  }
  return receipt;
}
