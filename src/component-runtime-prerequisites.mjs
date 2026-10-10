import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseAllDocuments } from 'yaml';

// A component release applies only its changed components' manifests. A full installation also runs the
// Console installers, which prepare runtime prerequisites those manifests do not carry or carry too late:
// Prepare-FoundationPrerequisites.ps1 (the Foundation runtime RBAC) and Install-ConsoleNativeRuntime.ps1 (the
// OS Shell CA projection into opensphere-foundation). This module delivers both before any workload manifest.

export const FOUNDATION_BOOTSTRAP_PATH = 'apps/extension-controller/src/foundation-bootstrap.json';
const FOUNDATION_BOOTSTRAP_SCHEMA = 'opensphere.foundation-bootstrap/v1';
const RBAC_API_VERSION = 'rbac.authorization.k8s.io/v1';

// Exactly the objects C_EXT verifyFoundationProfile reads and compares on every reconcile of the Foundation
// registration (Console apps/extension-controller/src/foundation-profile.mjs): foundationPrerequisites(
// 'opensphere-console') and foundationControllerProfile() without the controller's ServiceAccount. Console
// revisions before 6d7739b5 declare a subset of these; no revision renames one. Namespaces, CRDs and the
// profile-reader roles are not verified there and are not part of this step.
export const FOUNDATION_RUNTIME_RBAC = Object.freeze([
  ['ServiceAccount', 'opensphere-console', 'opensphere-foundation-runtime'],
  ['ClusterRole', null, 'opensphere-foundation-runtime'],
  ['ClusterRoleBinding', null, 'opensphere-foundation-runtime'],
  ['Role', 'opensphere-foundation', 'opensphere-foundation-runtime'],
  ['RoleBinding', 'opensphere-foundation', 'opensphere-foundation-runtime'],
  ['Role', 'opensphere-foundation-secure-input', 'opensphere-foundation-runtime'],
  ['RoleBinding', 'opensphere-foundation-secure-input', 'opensphere-foundation-runtime'],
  ['ClusterRole', null, 'opensphere-foundation-console-admins'],
  ['ClusterRoleBinding', null, 'opensphere-foundation-console-admins'],
  ['ClusterRole', null, 'opensphere-foundation-contract-controller'],
  ['ClusterRoleBinding', null, 'opensphere-foundation-contract-controller'],
  ['Role', 'opensphere-foundation', 'opensphere-foundation-contract-controller'],
  ['RoleBinding', 'opensphere-foundation', 'opensphere-foundation-contract-controller'],
  ['Role', 'opensphere-foundation-secure-input', 'opensphere-foundation-contract-controller'],
  ['RoleBinding', 'opensphere-foundation-secure-input', 'opensphere-foundation-contract-controller']
].map(([kind, namespace, name]) => Object.freeze({ kind, namespace, name })));

const RESOURCES = Object.freeze({
  ServiceAccount: 'serviceaccounts',
  ClusterRole: 'clusterroles.rbac.authorization.k8s.io',
  ClusterRoleBinding: 'clusterrolebindings.rbac.authorization.k8s.io',
  Role: 'roles.rbac.authorization.k8s.io',
  RoleBinding: 'rolebindings.rbac.authorization.k8s.io'
});

// The controller's own comparison (foundation-profile.mjs canonical): key order and array order are ignored.
const canonical = (value) => JSON.stringify(Array.isArray(value)
  ? value.map(canonical).sort()
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value);
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const identityOf = (document) => ({
  kind: document.kind, namespace: document.metadata?.namespace ?? null, name: document.metadata?.name
});
const sameIdentity = (want) => (document) => document?.kind === want.kind
  && document.metadata?.name === want.name && (document.metadata?.namespace ?? null) === want.namespace;
export const foundationRbacIdentity = ({ kind, namespace, name }) => `${kind}/${namespace ? `${namespace}/` : ''}${name}`;

export function selectFoundationRuntimeRbac(bundleText) {
  let bundle;
  try { bundle = JSON.parse(bundleText); } catch { throw new Error('Foundation bootstrap artifact is not valid JSON'); }
  if (bundle?.schema !== FOUNDATION_BOOTSTRAP_SCHEMA || !Array.isArray(bundle.resources)) {
    throw new Error('Foundation bootstrap artifact has an unsupported contract');
  }
  return FOUNDATION_RUNTIME_RBAC.flatMap((want) => {
    const found = bundle.resources.filter(sameIdentity(want));
    if (found.length > 1) throw new Error(`Foundation bootstrap artifact declares ${foundationRbacIdentity(want)} more than once`);
    if (found.length === 0) return [];
    if (found[0].apiVersion !== (want.kind === 'ServiceAccount' ? 'v1' : RBAC_API_VERSION)) {
      throw new Error(`Foundation bootstrap artifact declares ${foundationRbacIdentity(want)} with an unexpected API version`);
    }
    return [structuredClone(found[0])];
  });
}

function manifestCopies(controllerManifest) {
  return parseAllDocuments(controllerManifest).map((document) => {
    if (document.errors.length) throw new Error('Extension controller manifest could not be parsed to compare its Foundation profile');
    return document.toJS();
  }).filter(Boolean);
}

// The Foundation runtime RBAC that a component release of the extension controller must deliver. Both
// artifacts are read from pinned source revisions: the target controller's and the installed controller's.
export function planFoundationRuntimeRbac({
  sourceRevision,
  bundle,
  baselineRevision = null,
  baselineBundle = null,
  controllerManifest
}) {
  // The complete extension-controller manifest declares the same objects and is applied right after this
  // step, so a disagreement would leave whichever came last. Since Console fca6b223 both are identical.
  const copies = typeof controllerManifest === 'string' ? manifestCopies(controllerManifest) : [];
  if (bundle === null || bundle === undefined) {
    if (FOUNDATION_RUNTIME_RBAC.some((want) => copies.some(sameIdentity(want)))) {
      throw new Error(`Extension controller ${sourceRevision} declares the Foundation profile but ${FOUNDATION_BOOTSTRAP_PATH} is missing`);
    }
    return { sourceRevision, baselineRevision, changed: false, reason: 'not-declared', documents: [] };
  }
  const documents = selectFoundationRuntimeRbac(bundle);
  for (const document of documents) {
    const found = copies.filter(sameIdentity(identityOf(document)));
    if (found.length > 1 || (found.length === 1 && !isDeepStrictEqual(found[0], document))) {
      throw new Error(`Foundation bootstrap artifact and extension controller manifest disagree on ${foundationRbacIdentity(identityOf(document))}`);
    }
  }
  const baseline = baselineBundle === null || baselineBundle === undefined ? null : selectFoundationRuntimeRbac(baselineBundle);
  const changed = documents.length > 0 && (baseline === null || canonical(baseline) !== canonical(documents));
  return {
    sourceRevision,
    baselineRevision,
    changed,
    reason: documents.length === 0 ? 'not-declared'
      : baseline === null ? (baselineRevision ? 'installed-profile-absent' : 'no-installed-baseline')
        : changed ? 'profile-changed' : 'profile-unchanged',
    bootstrapSha256: sha256(bundle),
    profileDigest: sha256(canonical(documents)),
    documents
  };
}

// verifyFoundationProfile's per-object test, applied to what the API server returns after the apply.
export function foundationRuntimeObjectMatches(expected, observed) {
  if (!observed || observed.kind !== expected.kind || observed.apiVersion !== expected.apiVersion
      || observed.metadata?.name !== expected.metadata.name
      || (observed.metadata?.namespace ?? null) !== (expected.metadata.namespace ?? null)
      || observed.metadata?.deletionTimestamp || observed.aggregationRule) return false;
  if (expected.kind === 'ServiceAccount') {
    return observed.automountServiceAccountToken === expected.automountServiceAccountToken
      && canonical(observed.secrets ?? []) === canonical(expected.secrets ?? [])
      && canonical(observed.imagePullSecrets ?? []) === canonical(expected.imagePullSecrets ?? []);
  }
  if (expected.rules) return canonical(observed.rules ?? []) === canonical(expected.rules);
  return canonical(observed.roleRef) === canonical(expected.roleRef)
    && canonical(observed.subjects ?? []) === canonical(expected.subjects ?? []);
}

function readObject(kubectl, document) {
  const raw = kubectl([
    ...(document.metadata.namespace ? ['-n', document.metadata.namespace] : []),
    'get', RESOURCES[document.kind], document.metadata.name, '--ignore-not-found', '-o', 'json'
  ], { capture: true });
  return raw.trim() ? JSON.parse(raw) : null;
}

export function applyFoundationRuntimeRbac(plan, { kubectl, now = () => new Date() }) {
  const record = {
    step: 'foundation-runtime-rbac',
    artifact: FOUNDATION_BOOTSTRAP_PATH,
    sourceRevision: plan.sourceRevision,
    baselineRevision: plan.baselineRevision ?? null,
    reason: plan.reason,
    ...(plan.profileDigest ? { profileDigest: plan.profileDigest, bootstrapSha256: plan.bootstrapSha256 } : {}),
    objects: plan.documents.map((document) => foundationRbacIdentity(identityOf(document)))
  };
  if (!plan.changed) return { ...record, decision: plan.reason === 'not-declared' ? 'not-declared' : 'unchanged' };
  // Namespaces belong to their owners (upgrade ensures the managed ones first). A missing one stops this
  // step before its first write instead of leaving part of the profile applied.
  const namespaces = [...new Set(plan.documents.map((document) => document.metadata.namespace).filter(Boolean))].sort();
  const missing = namespaces.filter((namespace) =>
    !kubectl(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'], { capture: true }).trim());
  if (missing.length) {
    throw new Error(`Foundation runtime RBAC was not applied: namespace ${missing.join(', ')} does not exist`);
  }
  // Prepare-FoundationPrerequisites.ps1 semantics: one List through client-side `kubectl apply`. RBAC rules have
  // no merge key, so each complete target list replaces the live one; the read-back below proves it did.
  kubectl(['apply', '-f', '-'], {
    capture: true,
    input: `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items: plan.documents })}\n`
  });
  const mismatched = plan.documents.filter((document) =>
    !foundationRuntimeObjectMatches(document, readObject(kubectl, document)));
  if (mismatched.length) {
    throw new Error(`Foundation runtime RBAC did not read back as the target profile: ${mismatched
      .map((document) => foundationRbacIdentity(identityOf(document))).join(', ')}; no workload manifest was applied`);
  }
  return { ...record, decision: 'applied', verifiedAt: now().toISOString() };
}

export const OS_SHELL_CONTROL_CA = 'opensphere-shell-control-ca';
const OS_SHELL_CA_SOURCE_NAMESPACE = 'opensphere-console';
const FOUNDATION_NAMESPACE = 'opensphere-foundation';
// Only certificate blocks: a key, a CSR or any other PEM never passes as the public CA.
const CERTIFICATE_PEM = /^(?:-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*)+$/u;

// Install-ConsoleNativeRuntime.ps1 (Console d429dfe9): the Foundation controller verifies the OS Shell API
// internal listener with this CA, so the public certificate from opensphere-console is applied into
// opensphere-foundation and read back. The CA itself is never created or rotated here.
export function publishOsShellFoundationCa({ kubectl }) {
  const record = {
    step: 'os-shell-ca-foundation',
    configMap: OS_SHELL_CONTROL_CA,
    sourceNamespace: OS_SHELL_CA_SOURCE_NAMESPACE,
    namespace: FOUNDATION_NAMESPACE
  };
  const namespace = kubectl(['get', 'namespace', FOUNDATION_NAMESPACE, '--ignore-not-found', '-o', 'json'], { capture: true });
  if (!namespace.trim()) return { ...record, decision: 'skipped', reason: 'namespace-missing' };
  if (JSON.parse(namespace).metadata?.deletionTimestamp) {
    throw new Error(`Namespace ${FOUNDATION_NAMESPACE} is terminating; the OS Shell CA was not published`);
  }
  const source = JSON.parse(kubectl(['-n', OS_SHELL_CA_SOURCE_NAMESPACE, 'get', 'configmap', OS_SHELL_CONTROL_CA, '-o', 'json'], { capture: true }));
  const certificate = source?.data?.['ca.crt'];
  if (typeof certificate !== 'string' || !CERTIFICATE_PEM.test(certificate)) {
    throw new Error(`${OS_SHELL_CA_SOURCE_NAMESPACE}/${OS_SHELL_CONTROL_CA} does not hold only a public CA certificate`);
  }
  kubectl(['apply', '-f', '-'], {
    capture: true,
    input: `${JSON.stringify({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: OS_SHELL_CONTROL_CA,
        namespace: FOUNDATION_NAMESPACE,
        labels: { 'app.kubernetes.io/managed-by': 'opensphere-setup-cli' }
      },
      data: { 'ca.crt': certificate }
    })}\n`
  });
  const projected = JSON.parse(kubectl(['-n', FOUNDATION_NAMESPACE, 'get', 'configmap', OS_SHELL_CONTROL_CA, '-o', 'json'], { capture: true }));
  if (canonical(Object.keys(projected?.data ?? {})) !== canonical(['ca.crt'])
      || projected.data['ca.crt'] !== certificate || projected.binaryData) {
    throw new Error(`${FOUNDATION_NAMESPACE}/${OS_SHELL_CONTROL_CA} did not read back as exactly the public CA certificate`);
  }
  return { ...record, decision: 'published', certificateSha256: sha256(certificate) };
}

// Runs before the first workload manifest of a component release, in this order: the RBAC step may be the one
// that a new extension controller verifies, and the CA lands in the namespace the controller runs in.
export function applyComponentRuntimePrerequisites(prepared, changedComponents, {
  kubectl,
  onRecord = () => {},
  now
}) {
  const records = [];
  const record = (value) => { records.push(value); onRecord(value); };
  const foundationRbac = prepared?.foundation?.foundationRuntimeRbac;
  if (changedComponents.includes('extensionController') && foundationRbac) {
    record(applyFoundationRuntimeRbac(foundationRbac, { kubectl, ...(now ? { now } : {}) }));
  }
  if (changedComponents.includes('osShellControl')) record(publishOsShellFoundationCa({ kubectl }));
  return records;
}

export function describeComponentRuntimePrerequisite(record) {
  const revision = String(record.sourceRevision ?? '').slice(0, 12);
  if (record.step === 'foundation-runtime-rbac') {
    return {
      applied: `Foundation 실행 RBAC ${record.objects.length}개 적용, 재확인 일치 (${revision})`,
      unchanged: `Foundation 실행 RBAC 변경 없음, 적용 생략 (${revision})`,
      'not-declared': `Foundation 실행 RBAC 선언 없음 (${revision})`
    }[record.decision];
  }
  return record.decision === 'published'
    ? `OS Shell CA 공개 인증서를 ${record.namespace}에 게시, 재확인 일치`
    : `${record.namespace} namespace 없음, OS Shell CA 게시 생략`;
}
