// Persistent installation identity (Claude, single editor; agreed 2026-10-04).
// One installationId per installation, bound to the cluster it was created on:
// - created once, if absent, as an immutable ConfigMap; a concurrent creation converges because only
//   one create can succeed and every writer then reads the stored value;
// - kept outside the installation lock, so a lock rewrite or recovery never changes it;
// - refused when the stored cluster binding differs from the current cluster;
// - copied into the installation config (config.json installationId) for the components that read it.
import { randomUUID } from 'node:crypto';
import { kubectl as defaultKubectl } from './process.mjs';

export const INSTALLATION_IDENTITY_CONFIGMAP = 'opensphere-installation-identity';
const NAMESPACE = 'opensphere-console';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KUBE_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

// The kube-system namespace UID identifies the cluster; it changes only when the cluster is rebuilt.
export function readClusterUid({ kubectl = defaultKubectl } = {}) {
  const uid = kubectl(['get', 'namespace', 'kube-system', '-o', 'jsonpath={.metadata.uid}'], { capture: true });
  if (!KUBE_UID.test(String(uid))) fail('InstallationIdentityUnavailable', 'the cluster identity (kube-system UID) could not be read');
  return uid;
}

function readStoredIdentity(kubectl) {
  const text = kubectl(['-n', NAMESPACE, 'get', 'configmap', INSTALLATION_IDENTITY_CONFIGMAP, '--ignore-not-found', '-o', 'json'], { capture: true });
  if (!text) return null;
  let object;
  try { object = JSON.parse(text); } catch { fail('InstallationIdentityInvalid', 'the stored installation identity is not JSON'); }
  const data = object?.data ?? {};
  const keys = Object.keys(data).sort().join(',');
  if (object?.immutable !== true || keys !== 'clusterUid,createdAt,installationId'
      || !UUID.test(data.installationId) || !KUBE_UID.test(data.clusterUid) || !TIMESTAMP.test(data.createdAt)) {
    fail('InstallationIdentityInvalid', 'the stored installation identity is malformed; it is never repaired automatically');
  }
  return { installationId: data.installationId, clusterUid: data.clusterUid, createdAt: data.createdAt };
}

// adoptInstallationId: an ID an earlier installation already recorded in its config.json, kept when
// the identity record is created for the first time (upgrade from a lock that carried one).
export function ensureInstallationIdentity({ kubectl = defaultKubectl, newId = randomUUID, now = () => new Date(), adoptInstallationId } = {}) {
  const clusterUid = readClusterUid({ kubectl });
  let identity = readStoredIdentity(kubectl);
  if (!identity) {
    if (adoptInstallationId !== undefined && !UUID.test(String(adoptInstallationId))) {
      fail('InstallationIdentityInvalid', 'the recorded installationId to keep is not a UUID');
    }
    const installationId = adoptInstallationId ?? newId();
    if (!UUID.test(String(installationId))) fail('InstallationIdentityInvalid', 'a generated installationId is not a UUID');
    const manifest = {
      apiVersion: 'v1', kind: 'ConfigMap', immutable: true,
      metadata: { name: INSTALLATION_IDENTITY_CONFIGMAP, namespace: NAMESPACE,
        labels: { 'app.kubernetes.io/managed-by': 'opensphere-setup', 'opensphere.io/installation-identity': 'true' } },
      data: { installationId, clusterUid, createdAt: now().toISOString().replace(/\.\d{3}Z$/u, 'Z') },
    };
    try {
      // create, never apply: exactly one writer can create it.
      kubectl(['create', '-f', '-'], { capture: true, input: `${JSON.stringify(manifest)}\n` });
    } catch (error) {
      if (!/AlreadyExists|already exists/u.test(String(error?.stderr ?? error?.message ?? ''))) throw error;
    }
    identity = readStoredIdentity(kubectl);
    if (!identity) fail('InstallationIdentityUnavailable', 'the installation identity could not be read back after creation');
  }
  if (identity.clusterUid !== clusterUid) {
    fail('InstallationIdentityClusterMismatch', 'the installation identity belongs to another cluster; it is not reused or replaced automatically');
  }
  if (adoptInstallationId !== undefined && adoptInstallationId !== identity.installationId) {
    fail('InstallationIdentityConflict', 'the installation config names another installationId than the identity record');
  }
  return { installationId: identity.installationId, clusterUid: identity.clusterUid };
}
