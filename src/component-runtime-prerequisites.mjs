import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseAllDocuments } from 'yaml';

// A component release applies only its changed components' manifests. A full installation also runs the
// Console installers, which prepare runtime prerequisites those manifests do not carry or carry too late:
// Prepare-FoundationPrerequisites.ps1 (the Foundation runtime RBAC) and Install-ConsoleNativeRuntime.ps1 (the
// OS Shell CA projection into opensphere-foundation). This module delivers both before any workload manifest.

export const FOUNDATION_BOOTSTRAP_PATH = 'apps/extension-controller/src/foundation-bootstrap.json';
// v2 (Console D-C2 release, review 2026-10-19): the bundle that grants FoundationModel writes without names and carries
// the name policy. A Setup that knows only v1 refuses it, so it can never apply that RBAC before the policy exists.
const FOUNDATION_BOOTSTRAP_SCHEMAS = Object.freeze(['opensphere.foundation-bootstrap/v1', 'opensphere.foundation-bootstrap/v2']);
const FOUNDATION_BOOTSTRAP_V2 = 'opensphere.foundation-bootstrap/v2';
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

// Console Provider-list decoupling D-C2 (user decision 2026-10-19, Console design CONSOLE-PROVIDER-LIST-DECOUPLING §3.4):
// from that Console revision the Foundation RBAC names no FoundationModel; the ValidatingAdmissionPolicy and binding
// below admit only the bootstrap names and the names approved in Foundation's declaration. They must exist, and be
// type-checked by the API server, before the name-free RBAC is applied, so there is never a moment without the name
// check. Older revisions declare neither and are applied exactly as before. C_EXT verifyFoundationProfile reads them.
export const FOUNDATION_ADMISSION = Object.freeze([
  ['ValidatingAdmissionPolicy', null, 'opensphere-foundation-model-writer'],
  ['ValidatingAdmissionPolicyBinding', null, 'opensphere-foundation-model-writer']
].map(([kind, namespace, name]) => Object.freeze({ kind, namespace, name })));
const ADMISSION_API_VERSION = 'admissionregistration.k8s.io/v1';

const RESOURCES = Object.freeze({
  ServiceAccount: 'serviceaccounts',
  ClusterRole: 'clusterroles.rbac.authorization.k8s.io',
  ClusterRoleBinding: 'clusterrolebindings.rbac.authorization.k8s.io',
  Role: 'roles.rbac.authorization.k8s.io',
  RoleBinding: 'rolebindings.rbac.authorization.k8s.io',
  ValidatingAdmissionPolicy: 'validatingadmissionpolicies.admissionregistration.k8s.io',
  ValidatingAdmissionPolicyBinding: 'validatingadmissionpolicybindings.admissionregistration.k8s.io'
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

function parseBundle(bundleText) {
  let bundle;
  try { bundle = JSON.parse(bundleText); } catch { throw new Error('Foundation bootstrap artifact is not valid JSON'); }
  if (!FOUNDATION_BOOTSTRAP_SCHEMAS.includes(bundle?.schema) || !Array.isArray(bundle.resources)) {
    throw new Error('Foundation bootstrap artifact has an unsupported contract');
  }
  return bundle;
}

function selectIdentities(bundle, identities, apiVersionOf) {
  return identities.flatMap((want) => {
    const found = bundle.resources.filter(sameIdentity(want));
    if (found.length > 1) throw new Error(`Foundation bootstrap artifact declares ${foundationRbacIdentity(want)} more than once`);
    if (found.length === 0) return [];
    if (found[0].apiVersion !== apiVersionOf(want)) {
      throw new Error(`Foundation bootstrap artifact declares ${foundationRbacIdentity(want)} with an unexpected API version`);
    }
    return [structuredClone(found[0])];
  });
}

export function selectFoundationRuntimeRbac(bundleText) {
  return selectIdentities(parseBundle(bundleText), FOUNDATION_RUNTIME_RBAC,
    (want) => (want.kind === 'ServiceAccount' ? 'v1' : RBAC_API_VERSION));
}

// D-C2: the FoundationModel name policy and its binding, both or neither.
export function selectFoundationAdmission(bundleText) {
  const documents = selectIdentities(parseBundle(bundleText), FOUNDATION_ADMISSION, () => ADMISSION_API_VERSION);
  if (documents.length === 1) throw new Error('Foundation bootstrap artifact declares the FoundationModel name policy without its binding, or the reverse');
  return documents;
}

// A Foundation RBAC rule that lets an identity create, patch or update FoundationModels without naming them.
const nameFreeModelWrite = (documents) => documents.some((document) => (document.rules ?? []).some((rule) =>
  (rule.apiGroups ?? []).includes('foundation.opensphere.io') && (rule.resources ?? []).includes('foundationmodels')
  && (rule.verbs ?? []).some((verb) => ['create', 'patch', 'update', '*'].includes(verb)) && !rule.resourceNames?.length
  && (rule.verbs ?? []).some((verb) => verb !== 'create')));

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
  const admission = selectFoundationAdmission(bundle);
  for (const document of [...admission, ...documents]) {
    const found = copies.filter(sameIdentity(identityOf(document)));
    if (found.length > 1 || (found.length === 1 && !isDeepStrictEqual(found[0], document))) {
      throw new Error(`Foundation bootstrap artifact and extension controller manifest disagree on ${foundationRbacIdentity(identityOf(document))}`);
    }
  }
  // D-C2: a revision whose RBAC writes FoundationModels by any name must carry the policy that bounds the names.
  if (nameFreeModelWrite(documents) && admission.length === 0) {
    throw new Error(`Foundation bootstrap artifact at ${sourceRevision} grants FoundationModel writes without names but declares no FoundationModel name policy`);
  }
  // The policy and the name-free RBAC travel only in a v2 bundle, which an older Setup refuses.
  if ((admission.length || nameFreeModelWrite(documents)) && JSON.parse(bundle).schema !== FOUNDATION_BOOTSTRAP_V2) {
    throw new Error(`Foundation bootstrap artifact at ${sourceRevision} carries the FoundationModel name policy but is not ${FOUNDATION_BOOTSTRAP_V2}`);
  }
  const baseline = baselineBundle === null || baselineBundle === undefined ? null : selectFoundationRuntimeRbac(baselineBundle);
  const baselineAdmission = baselineBundle === null || baselineBundle === undefined ? null : selectFoundationAdmission(baselineBundle);
  const changed = documents.length > 0 && (baseline === null || canonical(baseline) !== canonical(documents)
    || canonical(baselineAdmission) !== canonical(admission));
  return {
    sourceRevision,
    baselineRevision,
    changed,
    reason: documents.length === 0 ? 'not-declared'
      : baseline === null ? (baselineRevision ? 'installed-profile-absent' : 'no-installed-baseline')
        : changed ? 'profile-changed' : 'profile-unchanged',
    bootstrapSha256: sha256(bundle),
    profileDigest: sha256(canonical(documents)),
    ...(admission.length ? { admissionDigest: sha256(canonical(admission)) } : {}),
    admission,
    documents
  };
}

// verifyFoundationProfile's admission test (Console foundation-profile.mjs sameAdmission): Kubernetes defaulting is the
// only normalization, and the policy must be type-checked at its current generation without warnings.
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
export function foundationAdmissionObjectMatches(expected, observed) {
  if (!observed || observed.kind !== expected.kind || observed.apiVersion !== expected.apiVersion
      || observed.metadata?.name !== expected.metadata.name || observed.metadata?.deletionTimestamp) return false;
  const spec = structuredClone(observed.spec ?? {});
  if (expected.kind === 'ValidatingAdmissionPolicy') {
    if (spec.matchConstraints?.matchPolicy === 'Equivalent') delete spec.matchConstraints.matchPolicy;
    for (const selector of ['namespaceSelector', 'objectSelector']) {
      if (JSON.stringify(stable(spec.matchConstraints?.[selector])) === '{}') delete spec.matchConstraints[selector];
    }
    for (const rule of spec.matchConstraints?.resourceRules ?? []) if (rule.scope === '*') delete rule.scope;
    if (observed.status?.observedGeneration !== observed.metadata?.generation
        || observed.status?.typeChecking?.expressionWarnings?.length) return false;
  }
  return JSON.stringify(stable(spec)) === JSON.stringify(stable(expected.spec));
}
const typeCheckPending = (expected, observed) => expected.kind === 'ValidatingAdmissionPolicy'
  && observed?.status?.observedGeneration !== observed?.metadata?.generation;

// Review 2026-10-19 (kind, 5 rounds): an API server enforced the policy up to about 1.1 s after status.typeChecking was
// observed, and RKE2 runs three API servers, each with its own admission informer. So before the RBAC is widened Setup
// asks the API servers directly: a server dry-run create of a FoundationModel name nobody approved, as the Foundation
// runtime ServiceAccount, must be denied by this policy several times in a row. Nothing is persisted by a dry run.
export const ADMISSION_PROBE_SUBJECT = 'system:serviceaccount:opensphere-console:opensphere-foundation-runtime';
const ADMISSION_PROBE_NAME = 'setup-admission-probe';
const ADMISSION_PROBE_MODEL = Object.freeze({ apiVersion: 'foundation.opensphere.io/v1alpha1', kind: 'FoundationModel',
  metadata: { name: ADMISSION_PROBE_NAME }, spec: { model: ADMISSION_PROBE_NAME, desiredState: 'Installed' } });
const POLICY_NAME = 'opensphere-foundation-model-writer';
export function probeFoundationAdmission(kubectl, { sleep = defaultSleep, attempts = 40, consecutive = 5, settleMilliseconds = 3000 } = {}) {
  let denied = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      kubectl(['create', '-f', '-', '--dry-run=server', '-o', 'name', '--as', ADMISSION_PROBE_SUBJECT],
        { capture: true, input: `${JSON.stringify(ADMISSION_PROBE_MODEL)}\n` });
      denied = 0; // admitted: this API server does not enforce the policy yet
    } catch (error) {
      const text = String(error?.stderr || error?.message || '');
      if (text.includes(POLICY_NAME)) {
        denied += 1;
        if (denied >= consecutive) return { probe: 'denied', attempts: attempt };
      } else {
        // RBAC already refuses the runtime identity (it cannot create today): the policy cannot be observed through it,
        // so Setup waits for the slowest informer it measured and records why. Any other failure means the probe could not
        // run (for example impersonation refused); enforcement is then unproven and the caller stops (review 2026-10-19).
        if (/forbidden/i.test(text) && /cannot create resource/i.test(text)) {
          sleep(settleMilliseconds);
          return { probe: 'rbac-forbidden', attempts: attempt };
        }
        return { probe: 'unavailable', attempts: attempt, reason: text.slice(0, 200) };
      }
    }
    sleep(500);
  }
  return { probe: 'admitted', attempts };
}
const defaultSleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

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

export function applyFoundationRuntimeRbac(plan, { kubectl, now = () => new Date(), sleep = defaultSleep, typeCheckAttempts = 60 }) {
  const admission = plan.admission ?? [];
  const record = {
    step: 'foundation-runtime-rbac',
    artifact: FOUNDATION_BOOTSTRAP_PATH,
    sourceRevision: plan.sourceRevision,
    baselineRevision: plan.baselineRevision ?? null,
    reason: plan.reason,
    ...(plan.profileDigest ? { profileDigest: plan.profileDigest, bootstrapSha256: plan.bootstrapSha256 } : {}),
    ...(admission.length ? { admissionDigest: plan.admissionDigest, admissionObjects: admission.map((document) => foundationRbacIdentity(identityOf(document))) } : {}),
    objects: plan.documents.map((document) => foundationRbacIdentity(identityOf(document)))
  };
  if (!plan.changed) {
    if (plan.reason === 'not-declared' || !admission.length) return { ...record, decision: plan.reason === 'not-declared' ? 'not-declared' : 'unchanged' };
    // Review 2026-10-19 (minor 4): an unchanged bundle still has its name policy read and compared, so a deleted or
    // edited policy is restored, type-checked and proven before this release continues (the RBAC is already name-free).
    let drifted;
    try { drifted = admission.filter((document) => !foundationAdmissionObjectMatches(document, readObject(kubectl, document))); }
    catch (error) { throw afterWrite(error, { ...record, decision: 'admission-unverified' }, 'The FoundationModel name policy could not be read to compare it. Nothing was written.'); }
    if (!drifted.length) return { ...record, decision: 'unchanged' };
    const restored = applyAdmission(plan, admission, record, { kubectl, sleep, typeCheckAttempts });
    return { ...record, ...restored, decision: 'admission-restored', restored: drifted.map((document) => foundationRbacIdentity(identityOf(document))),
      verifiedAt: now().toISOString() };
  }
  // Namespaces belong to their owners (upgrade ensures the managed ones first). A missing one stops this
  // step before its first write instead of leaving part of the profile applied.
  const namespaces = [...new Set(plan.documents.map((document) => document.metadata.namespace).filter(Boolean))].sort();
  const missing = namespaces.filter((namespace) =>
    !kubectl(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'], { capture: true }).trim());
  if (missing.length) {
    throw new Error(`Foundation runtime RBAC was not applied: namespace ${missing.join(', ')} does not exist`);
  }
  // D-C2: the FoundationModel name policy and its binding first, read back, type-checked and proven enforced by the API
  // servers, before any RBAC write. A failure here stops the step with the RBAC untouched.
  const enforced = admission.length ? applyAdmission(plan, admission, record, { kubectl, sleep, typeCheckAttempts }) : {};
  // Prepare-FoundationPrerequisites.ps1 semantics: one List through client-side `kubectl apply`. RBAC rules have
  // no merge key, so each complete target list replaces the live one; the read-back below proves it did.
  // From the apply on, a failure is never "nothing changed": the cluster RBAC may already differ, so the
  // failure carries its own record (afterWrite) for the transition and the run's effects.
  try {
    kubectl(['apply', '-f', '-'], {
      capture: true,
      input: `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items: plan.documents })}\n`
    });
  } catch (error) {
    throw afterWrite(error, { ...record, decision: 'apply-outcome-unknown' },
      'Foundation runtime RBAC apply did not complete; the cluster RBAC may be partly changed. No workload manifest was applied.');
  }
  let mismatched;
  try {
    mismatched = plan.documents.filter((document) =>
      !foundationRuntimeObjectMatches(document, readObject(kubectl, document)));
  } catch (error) {
    throw afterWrite(error, { ...record, decision: 'changed-unverified' },
      'Foundation runtime RBAC was sent but could not be read back; the cluster RBAC may already be changed. No workload manifest was applied.');
  }
  if (mismatched.length) {
    const names = mismatched.map((document) => foundationRbacIdentity(identityOf(document)));
    throw afterWrite(null, { ...record, decision: 'changed-unverified', mismatched: names },
      `Foundation runtime RBAC did not read back as the target profile: ${names.join(', ')}. It was sent, so the cluster RBAC may already be changed. No workload manifest was applied.`);
  }
  return { ...record, ...enforced, decision: 'applied', verifiedAt: now().toISOString() };
}

function applyAdmission(plan, admission, record, { kubectl, sleep, typeCheckAttempts }) {
  try {
    kubectl(['apply', '-f', '-'], { capture: true, input: `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items: admission })}\n` });
  } catch (error) {
    throw afterWrite(error, { ...record, decision: 'apply-outcome-unknown' },
      'The FoundationModel name policy apply did not complete; it may be partly changed. The Foundation RBAC and every workload manifest were left as they were.');
  }
  let mismatchedPolicy;
  try {
    mismatchedPolicy = admission.filter((document) => {
      for (let attempt = 1; ; attempt += 1) {
        const observed = readObject(kubectl, document);
        if (!typeCheckPending(document, observed) || attempt >= typeCheckAttempts) return !foundationAdmissionObjectMatches(document, observed);
        sleep(500);
      }
    });
  } catch (error) {
    throw afterWrite(error, { ...record, decision: 'changed-unverified' },
      'The FoundationModel name policy was sent but could not be read back. The Foundation RBAC and every workload manifest were left as they were.');
  }
  if (mismatchedPolicy.length) {
    const names = mismatchedPolicy.map((document) => foundationRbacIdentity(identityOf(document)));
    throw afterWrite(null, { ...record, decision: 'changed-unverified', mismatched: names },
      `The FoundationModel name policy did not read back as the target or is not type-checked without warnings: ${names.join(', ')}. The Foundation RBAC and every workload manifest were left as they were.`);
  }
  const probe = probeFoundationAdmission(kubectl, { sleep });
  if (probe.probe === 'unavailable') {
    throw afterWrite(null, { ...record, decision: 'changed-unverified', admissionProbe: probe },
      'The enforcement probe for the FoundationModel name policy could not run, so the policy is not proven enforced. The Foundation RBAC and every workload manifest were left as they were.');
  }
  if (probe.probe === 'admitted') {
    throw afterWrite(null, { ...record, decision: 'changed-unverified', admissionProbe: probe },
      `The API servers kept admitting an unapproved FoundationModel name for the Foundation runtime after ${probe.attempts} dry runs, so the name policy is not proven enforced. The Foundation RBAC and every workload manifest were left as they were.`);
  }
  return { admissionProbe: probe };
}

// An error after a write: the step's record travels with it, so the caller records the possible change.
function afterWrite(cause, prerequisiteRecord, message) {
  const error = new Error(cause ? `${message} (${cause.message})` : message);
  error.prerequisiteRecord = prerequisiteRecord;
  return error;
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
  try {
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
  } catch (error) {
    throw afterWrite(error, { ...record, decision: 'apply-outcome-unknown' },
      `${FOUNDATION_NAMESPACE}/${OS_SHELL_CONTROL_CA} apply did not complete; it may already be changed.`);
  }
  let projected;
  try {
    projected = JSON.parse(kubectl(['-n', FOUNDATION_NAMESPACE, 'get', 'configmap', OS_SHELL_CONTROL_CA, '-o', 'json'], { capture: true }));
  } catch (error) {
    throw afterWrite(error, { ...record, decision: 'changed-unverified' },
      `${FOUNDATION_NAMESPACE}/${OS_SHELL_CONTROL_CA} was sent but could not be read back; it may already be changed.`);
  }
  if (canonical(Object.keys(projected?.data ?? {})) !== canonical(['ca.crt'])
      || projected.data['ca.crt'] !== certificate || projected.binaryData) {
    throw afterWrite(null, { ...record, decision: 'changed-unverified' },
      `${FOUNDATION_NAMESPACE}/${OS_SHELL_CONTROL_CA} did not read back as exactly the public CA certificate; it was sent, so it may already be changed.`);
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
  // A step that fails after its write still reports that write before the failure propagates.
  const run = (step) => {
    try { record(step()); } catch (error) {
      if (error?.prerequisiteRecord) record(error.prerequisiteRecord);
      throw error;
    }
  };
  const foundationRbac = prepared?.foundation?.foundationRuntimeRbac;
  if (changedComponents.includes('extensionController') && foundationRbac) {
    run(() => applyFoundationRuntimeRbac(foundationRbac, { kubectl, ...(now ? { now } : {}) }));
  }
  if (changedComponents.includes('osShellControl')) run(() => publishOsShellFoundationCa({ kubectl }));
  return records;
}

export function describeComponentRuntimePrerequisite(record) {
  const revision = String(record.sourceRevision ?? '').slice(0, 12);
  if (record.step === 'foundation-runtime-rbac') {
    const policy = record.admissionObjects?.length ? `FoundationModel 이름 정책 ${record.admissionObjects.length}개와 ` : '';
    return {
      applied: `${policy}Foundation 실행 RBAC ${record.objects.length}개 적용, 재확인 일치 (${revision})`,
      unchanged: `Foundation 실행 RBAC 변경 없음, 적용 생략 (${revision})`,
      'not-declared': `Foundation 실행 RBAC 선언 없음 (${revision})`,
      'admission-restored': `FoundationModel 이름 정책이 바뀌었거나 없어 다시 적용, 재확인 일치 (${revision})`,
      'admission-unverified': `FoundationModel 이름 정책을 읽지 못해 비교하지 못함. 아무것도 쓰지 않음 (${revision})`,
      'changed-unverified': `Foundation 실행 RBAC를 보냈지만 재확인이 맞지 않음. 클러스터 RBAC가 이미 바뀌었을 수 있음 (${revision})`,
      'apply-outcome-unknown': `Foundation 실행 RBAC 적용이 끝나지 않음. 일부가 바뀌었을 수 있음 (${revision})`
    }[record.decision];
  }
  return {
    published: `OS Shell CA 공개 인증서를 ${record.namespace}에 게시, 재확인 일치`,
    skipped: `${record.namespace} namespace 없음, OS Shell CA 게시 생략`,
    'changed-unverified': `OS Shell CA를 ${record.namespace}에 보냈지만 재확인이 맞지 않음. 이미 바뀌었을 수 있음`,
    'apply-outcome-unknown': `OS Shell CA 적용이 끝나지 않음. ${record.namespace}에서 이미 바뀌었을 수 있음`
  }[record.decision];
}
