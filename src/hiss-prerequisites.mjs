import { createHash } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { run } from './process.mjs';
import { installTarget } from './install-target.mjs';

// Approved 2026-09-07 (first exercised on docker-desktop / HTTPS localhost / edge). Since
// 2026-09-23 the profile bytes stay pinned but the target cluster is not (install-target.mjs).
// Setup prepares authority; actual chart operations remain 22 -> OS Shell -> owner.
// No caller-supplied URL, chart, source path or arbitrary manifest is accepted.
export const HISS_EXECUTION_PROFILE = Object.freeze({
  id: 'hiss-chart-execution-v1',
  sourceRepository: 'opensphere-platform/OpenSphere-shell-clusterManager',
  // H2 (2026-10-16, user decisions HD2 and HD4): adds the node log agent identity and a second executor Role.
  // H3 (2026-10-16, HD6-HD9): adds the consumer-reader ClusterRole (tokenreviews create, ObservabilityBinding read
  // and status write). Additive only; creation never rewrites an object that an earlier revision prepared.
  // 2026-10-16 evening correction: bindings are namespaced in opensphere-foundation; the cluster-wide consumer
  // reader becomes a token-review ClusterRole plus a binding-reader Role there.
  sourceRevision: 'cefd0b5691cda09b2f7b3128c08d57d4e570be5b',
  sourcePath: 'deploy/hiss-execution-profile.proposed.json',
  // Console delivery must use the release's Console revision, never the owner
  // revision above. This path is metadata only; no artifact is fetched here.
  consoleArtifactPath: 'deploy/installation-profiles/hiss-execution.json',
  sha256: '615cc74f3e34e14a9175404b6fac086f9c84922eb7784bbfb02aa453c57efcb5',
});
const groups = {Namespace:['v1','namespaces'],ServiceAccount:['v1','serviceaccounts'],
  Role:['rbac.authorization.k8s.io/v1','roles'],RoleBinding:['rbac.authorization.k8s.io/v1','rolebindings'],
  ClusterRole:['rbac.authorization.k8s.io/v1','clusterroles'],ClusterRoleBinding:['rbac.authorization.k8s.io/v1','clusterrolebindings']};
const digest = value => createHash('sha256').update(value).digest('hex');
const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v==='object'
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])) : v;
const canonical = v=>JSON.stringify(sorted(v));
const identity = r=>`${r.apiVersion}/${r.kind}/${r.metadata.namespace||''}/${r.metadata.name}`;
const projection = r=>({apiVersion:r.apiVersion,kind:r.kind,name:r.metadata?.name,namespace:r.metadata?.namespace,
  rules:r.rules,roleRef:r.roleRef,subjects:r.subjects,aggregationRule:r.aggregationRule,
  automountServiceAccountToken:r.kind==='ServiceAccount'?r.automountServiceAccountToken!==false:undefined,
  imagePullSecrets:r.imagePullSecrets||[],aggregateLabels:Object.fromEntries(Object.entries(r.metadata?.labels||{}).filter(([k])=>k.startsWith('rbac.authorization.k8s.io/aggregate-to-')))});
const fail = (code,message,evidence)=>Object.assign(new Error(message),{code,...(evidence?{evidence}:{})});
export const HISS_VALIDATION_ARTIFACT = 'deploy/installation-profiles/hiss-validation.yaml';
const VALIDATION_SHA256 = '286b837d4104a8936cee5169f2a70f52fb20490f0df5c3ac6f6037c2cde342d4';

export function verifyHissValidationArtifact(raw) {
  if (typeof raw !== 'string' || digest(raw) !== VALIDATION_SHA256) throw fail('UNTRUSTED_PROFILE','HISS validation bytes differ from the approved contract');
  return raw;
}

export function prepareHissValidation(raw, scope, {runner=run}={}) {
  // Reuse the same target boundary; validate before any API call.
  const target = installTarget(scope);
  verifyHissValidationArtifact(raw);
  // Server-side apply makes the default ServiceAccount upsert atomic with the
  // namespace controller. Never force conflicts or modify unrelated fields.
  runner('kubectl',['--context',target.context,'apply','--server-side','--field-manager=opensphere-setup-hiss','-f','-','--request-timeout=20s'],
    {capture:true,input:raw});
  return {applied:true,resourceCount:7,installationComplete:false};
}
// Storage observation (H2, user decision HD4): a read-only Longhorn Role for Cluster Manager and one NetworkPolicy
// admitting Prometheus to longhorn-manager :9500. H-P6 (storage operations design 2026-10-19, M1) adds a read of
// one Longhorn setting by name (replica-soft-anti-affinity) and the backup targets to the same Role. Source: Cluster
// Manager deploy/hiss-storage-observation.yaml at b61276fbb4ac9a29fe2ede22619cbf364f13c14a. Applied only where Longhorn runs; elsewhere it is NotApplicable.
const STORAGE_OBSERVATION_SHA256 = '70311e8f7e5b14b5a8c8bbe77fe75d0c4135ffe17e97370a9a4bdedc22b2c2ea';
export function verifyHissStorageObservationArtifact(raw) {
  if (typeof raw !== 'string' || digest(raw) !== STORAGE_OBSERVATION_SHA256) throw fail('UNTRUSTED_PROFILE','HISS storage observation bytes differ from the approved contract');
  return raw;
}
export function prepareHissStorageObservation(raw, scope, {runner=run, apply=false}={}) {
  const target = installTarget(scope);
  verifyHissStorageObservationArtifact(raw);
  const present = args => Boolean(String(runner('kubectl',['--context',target.context,'get',...args,'--ignore-not-found','-o','name','--request-timeout=10s'],{capture:true})||'').trim());
  if (!present(['customresourcedefinition','volumes.longhorn.io']) || !present(['namespace','longhorn-system']))
    return {state:'NotApplicable',reason:'LonghornNotInstalled',applied:false};
  if (!apply) return {state:'NeedsPreparation',applied:false,resourceCount:3};
  runner('kubectl',['--context',target.context,'apply','--server-side','--field-manager=opensphere-setup-hiss','-f','-','--request-timeout=20s'],
    {capture:true,input:raw});
  return {state:'Applied',applied:true,resourceCount:3};
}
// H3 (HD7): the ObservabilityBinding CRD (v1alpha2). Source: Cluster Manager deploy/hiss-observability-binding.crd.yaml
// at 93180e6 (Y2, 2026-10-19: spec.targets x-kubernetes-validations, every target in opensphere-foundation; before it
// cefd0b5691cda09b2f7b3128c08d57d4e570be5b). Server-side apply under the same field manager as the other HISS artifacts,
// so an installed CRD is updated in place; the stored bindings already satisfy the rule (read-only check on RKE2).
const OBSERVABILITY_BINDING_CRD_SHA256 = 'c77629e8f632dc9be0b541445f465c4ff52055ab0dc0316a1f84daa95d4c4d6e';
export function verifyHissObservabilityBindingCrd(raw) {
  if (typeof raw !== 'string' || digest(raw) !== OBSERVABILITY_BINDING_CRD_SHA256) throw fail('UNTRUSTED_PROFILE','ObservabilityBinding CRD bytes differ from the approved contract');
  return raw;
}
// The CEL rules of the approved CRD, as written in its YAML (rule: "..."). A served CRD without every one of them is an
// older revision: the plan reports it as NeedsUpdate, not Present.
export function observabilityBindingCrdRules(raw) {
  return [...String(raw).matchAll(/^\s*- rule: "(.*)"\s*$/gm)].map((m) => m[1].replace(/\\"/g, '"'));
}
export function prepareHissObservabilityBindingCrd(raw, scope, {runner=run, apply=false}={}) {
  const target = installTarget(scope);
  verifyHissObservabilityBindingCrd(raw);
  if (!apply) {
    const live = String(runner('kubectl',['--context',target.context,'get','customresourcedefinition','observabilitybindings.observability.opensphere.io','--ignore-not-found','-o','json','--request-timeout=10s'],{capture:true})||'').trim();
    if (!live) return {state:'NeedsPreparation',applied:false};
    let rules = [];
    try {
      const crd = JSON.parse(live);
      const version = (crd.spec?.versions || []).find((v) => v.name === 'v1alpha2');
      rules = (version?.schema?.openAPIV3Schema?.properties?.spec?.properties?.targets?.['x-kubernetes-validations'] || []).map((v) => v.rule);
    } catch { rules = []; }
    const current = observabilityBindingCrdRules(raw).every((rule) => rules.includes(rule));
    return {state:current?'Present':'NeedsUpdate',applied:false};
  }
  runner('kubectl',['--context',target.context,'apply','--server-side','--field-manager=opensphere-setup-hiss','-f','-','--request-timeout=20s'],
    {capture:true,input:raw});
  return {state:'Applied',applied:true,resourceCount:1};
}
// HISS operator facility hiss.operator.stackgres (PostgreSQL Provider design 2026-10-20 §9.1, P0 lab results §15-§16;
// user decisions D-P1, D-P1a B, D-P2 and the Console-administrator bypass closure, 2026-10-20). Source: Cluster Manager
// deploy/hiss-operator-stackgres.yaml (tools/render-hiss-operator-stackgres.cjs) at the revision below. 49 objects:
// the operator namespace and the two PostgreSQL namespaces (PSA enforce=baseline), six ValidatingAdmissionPolicies with
// Deny bindings (StackGres objects are written by Foundation and the operator only, Console administrator impersonation
// included; a cluster's own accounts and dbops Jobs stay within their cluster; Foundation's Secret names; SGCluster names
// and resource split), a default-deny NetworkPolicy in each PostgreSQL namespace, the reduced operator RBAC, Foundation's
// write Role there (A4 exception until Y3) and Cluster Manager's executor and observer rights. Server-side apply under the
// same field manager as the other HISS artifacts; no Helm, no caller input.
// D-F8 (CM privileged-write fence design 2026-10-22, user decision: before P2 is applied) adds two policies with their
// bindings, applied and type-checked with the write guards in phase 1: opensphere-hiss-stackgres-operator-workload (in
// opensphere-stackgres only the reviewed StackGres 1.19.3 operator Deployment, ReplicaSets and Pods with the operator
// ServiceAccount, the approved image digest and environment, and the rendered Secret, ServiceAccount, Service, Issuer and
// Certificate) and opensphere-hiss-stackgres-operator-extension (the 14 StackGres CRDs and the two webhook configurations
// keep their rendered settings). Both bind every requester; the bindings start as Warn and Audit (D-F6, like the chart
// execution fence F1) and move to Deny in a later Setup revision. Setup #45's F-6 coverage counts the workload policy for
// opensphere-stackgres.
export const HISS_OPERATOR_STACKGRES = Object.freeze({
  id: 'hiss-operator-stackgres-v1',
  sourceRepository: 'opensphere-platform/OpenSphere-shell-clusterManager',
  sourcePath: 'deploy/hiss-operator-stackgres.yaml',
  sourceRevision: 'cc027967a8effe44438902b44c41dc2dce8db5c3',
  sha256: '85907be83b23efd769ee19f5f34bfdc2686f61db5bb99afdefd4324d929bdfe5',
  resourceCount: 49,
});
const STACKGRES_SECRET_PROBE_SUBJECT = 'system:serviceaccount:opensphere-foundation:foundation-control-plane';
const STACKGRES_SECRET_GUARD = 'opensphere-pfss-pg-foundation-names';
const STACKGRES_SECRET_PROBE = Object.freeze({ apiVersion: 'v1', kind: 'Secret',
  metadata: { name: 'setup-admission-probe', namespace: 'opensphere-pfss-pg-shared' }, stringData: { probe: 'not-stored' } });
export function verifyHissOperatorStackgresArtifact(raw) {
  if (typeof raw !== 'string' || digest(raw) !== HISS_OPERATOR_STACKGRES.sha256) throw fail('UNTRUSTED_PROFILE','HISS StackGres operator prerequisite bytes differ from the approved contract');
  const documents = parseAllDocuments(raw).map((d) => d.toJSON()).filter(Boolean);
  if (documents.length !== HISS_OPERATOR_STACKGRES.resourceCount) throw fail('UNTRUSTED_PROFILE','HISS StackGres operator prerequisite envelope differs');
  return documents;
}
// What the API server keeps of an applied document: every field we set is present with the same value (server defaults
// and other managers' fields are ignored; RBAC rules and subjects must match exactly). A write guard must also carry no
// extra match condition, parameter, audit annotation or binding selector that would narrow it (review 2026-10-22 M5).
function holds(live, wanted) {
  if (Array.isArray(wanted)) return Array.isArray(live) && live.length === wanted.length && wanted.every((v, i) => holds(live[i], v));
  if (wanted && typeof wanted === 'object') return !!live && typeof live === 'object' && Object.keys(wanted).every((k) => holds(live[k], wanted[k]));
  return live === wanted;
}
const emptySelector = (v) => v === undefined || v === null || (typeof v === 'object' && Object.entries(v).every(([k, x]) =>
  x === undefined || x === null || (Array.isArray(x) && !x.length) || (k === 'matchPolicy' && x === 'Equivalent') || emptySelector(x)));
function stackgresMatches(document, live) {
  if (!live?.metadata?.uid || live.metadata.deletionTimestamp) return false;
  if (!holds(live.metadata.labels || {}, document.metadata.labels || {})) return false;
  if (document.rules) return canonical(live.rules || []) === canonical(document.rules);
  if (document.roleRef) return canonical(live.roleRef) === canonical(document.roleRef) && canonical(live.subjects || []) === canonical(document.subjects || []);
  if (document.kind === 'ValidatingAdmissionPolicy') {
    const same = (key) => canonical(live.spec?.[key] ?? null) === canonical(document.spec[key] ?? null);
    return holds(live.spec, document.spec) && ['matchConditions', 'variables', 'validations', 'paramKind', 'auditAnnotations'].every(same)
      && emptySelector(live.spec?.matchConstraints?.excludeResourceRules) && emptySelector(live.spec?.matchConstraints?.objectSelector);
  }
  if (document.kind === 'ValidatingAdmissionPolicyBinding') return holds(live.spec, document.spec) && live.spec?.paramRef === undefined
    && emptySelector(live.spec?.matchResources) && canonical(live.spec?.validationActions) === canonical(document.spec.validationActions);
  return document.kind === 'Namespace' || holds(live.spec, document.spec);
}
const stackgresId = (o) => `${o.kind}/${o.metadata?.namespace || ''}/${o.metadata?.name}`;
const defaultSleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const GUARD_PHASE = new Set(['Namespace', 'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding']);
export function prepareHissOperatorStackgres(raw, scope, {runner=run, apply=false, sleep=defaultSleep, attempts=60, consecutive=5}={}) {
  const target = installTarget(scope);
  const documents = verifyHissOperatorStackgresArtifact(raw);
  const guards = documents.filter((d) => d.kind === 'ValidatingAdmissionPolicy').map((d) => d.metadata.name);
  const k = (args, options = {}) => runner('kubectl', ['--context', target.context, ...args], { capture: true, ...options });
  const list = (items) => `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items })}\n`;
  const observe = (subset = documents) => {
    const out = String(k(['get', '-f', '-', '--ignore-not-found', '-o', 'json', '--request-timeout=20s'], { input: list(subset) }) || '').trim();
    const found = out ? JSON.parse(out) : { items: [] };
    const live = new Map((found.kind === 'List' ? found.items : [found]).map((o) => [stackgresId(o), o]));
    const objects = subset.map((d) => ({ identity: stackgresId(d), status: !live.has(stackgresId(d)) ? 'Missing' : stackgresMatches(d, live.get(stackgresId(d))) ? 'Matching' : 'Differs' }));
    return { objects, missing: objects.filter((o) => o.status === 'Missing').length, differs: objects.filter((o) => o.status === 'Differs').length };
  };
  const before = observe();
  if (!apply) return { state: before.missing ? 'NeedsPreparation' : before.differs ? 'NeedsUpdate' : 'Present', applied: false,
    resourceCount: documents.length, missing: before.missing, differs: before.differs };
  // Never --force-conflicts: an object another manager owns stops the apply instead of being taken over.
  const applyAll = (subset) => k(['apply', '--server-side', '--field-manager=opensphere-setup-hiss', '-f', '-', '--request-timeout=30s'], { input: list(subset) });
  const readBack = (subset, phase) => {
    const after = observe(subset);
    if (after.missing || after.differs) throw fail('PREPARATION_INCOMPLETE', `HISS StackGres prerequisites (${phase}) do not read back as applied`,
      { objects: after.objects.filter((o) => o.status !== 'Matching') });
  };
  // Phase 1 (review M5): the namespaces and every write guard first, read back and type-checked by the API server, before
  // any RBAC that the guards bound exists. A failure here leaves no new permission behind.
  const first = documents.filter((d) => GUARD_PHASE.has(d.kind));
  applyAll(first);
  readBack(first, 'namespaces and write guards');
  for (let attempt = 1; ; attempt += 1) {
    const policies = guards.map((name) => JSON.parse(k(['get', 'validatingadmissionpolicy', name, '-o', 'json', '--request-timeout=10s'])));
    if (policies.every((p) => p.status?.observedGeneration === p.metadata?.generation && !(p.status?.typeChecking?.expressionWarnings || []).length)) break;
    if (attempt >= attempts) throw fail('PREPARATION_INCOMPLETE', 'A StackGres write guard is not type-checked without warnings; nothing else was applied');
    sleep(500);
  }
  // Phase 2: NetworkPolicies and RBAC.
  applyAll(documents.filter((d) => !GUARD_PHASE.has(d.kind)));
  readBack(documents, 'all objects');
  // Enforcement proof on the API servers that are reachable now (X precedent): a dry-run create of a Secret with a name
  // outside the instance families, as Foundation's controller, must be refused by the Secret name guard five times in a
  // row. The StackGres-object guards themselves are proven by Cluster Manager's verify once the CRDs exist.
  let denied = 0, probe = 'admitted';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      k(['create', '-f', '-', '--dry-run=server', '-o', 'name', '--as', STACKGRES_SECRET_PROBE_SUBJECT, '--request-timeout=10s'], { input: `${JSON.stringify(STACKGRES_SECRET_PROBE)}\n` });
      denied = 0;
    } catch (error) {
      const text = String(error?.stderr || error?.message || '');
      if (!text.includes(STACKGRES_SECRET_GUARD)) { probe = 'unavailable'; break; }
      denied += 1;
      if (denied >= consecutive) { probe = 'denied'; break; }
    }
    sleep(500);
  }
  if (probe !== 'denied') throw fail('PREPARATION_INCOMPLETE', `The StackGres Secret name guard was not proven enforced (${probe}); the operator must not be installed`);
  return { state: 'Applied', applied: true, resourceCount: documents.length, created: before.missing, updated: before.differs, guardProbe: probe };
}

// Node maintenance (node reboot coordination design 2026-10-22, user decision "모두 권고안대로 (권장)"): namespace
// opensphere-node-maintenance, kured's ServiceAccount, ClusterRole and lock Role, Cluster Manager's executor Role there,
// its Role in monitoring for one named NetworkPolicy, its operation-record Role, a NetworkPolicy admitting only Prometheus
// to kured, and two ValidatingAdmissionPolicies: kured may change only node cordon/kured annotations/its taint and its
// lock annotation; the namespace runs only the approved kured image, flags and mounts. Source: Cluster Manager
// deploy/hiss-node-maintenance.yaml (NODE_MAINTENANCE_SOURCE). Server-side apply under the same field manager as the
// other HISS artifacts, so a later revision (a new approved kured digest) updates the fence in place; another manager's
// field is a conflict that stops the apply. The two fences are applied first and the permissions only after them, so a
// failed fence never leaves kured's or Cluster Manager's new rights unfenced. Needs the monitoring and opensphere-console
// namespaces.
export const NODE_MAINTENANCE_SOURCE = Object.freeze({
  repository: 'opensphere-platform/OpenSphere-shell-clusterManager',
  path: 'deploy/hiss-node-maintenance.yaml',
  revision: 'c072d2989f1115fd4f738720b9742a53ea98424e',
});
const NODE_MAINTENANCE_SHA256 = 'e16edf1f9aeb1528764c91f76fc158ab7d1b0e3b3c46cd1095bb0eb964d7dec3';
const NODE_MAINTENANCE_OBJECTS = 17;
export function verifyHissNodeMaintenanceArtifact(raw) {
  if (typeof raw !== 'string' || digest(raw) !== NODE_MAINTENANCE_SHA256) throw fail('UNTRUSTED_PROFILE','HISS node maintenance bytes differ from the approved contract');
  return raw;
}
// The fences in the artifact, as compared with the served policies: matching, variables, validations and failure
// policy. A served policy that differs is an older revision (for example before a new approved kured digest or a
// tightened validation): the plan reports NeedsUpdate.
const normalExpression = value => String(value).replace(/\s+/g,' ').trim();
const fenceProjection = policy => ({
  failurePolicy: policy?.spec?.failurePolicy ?? null,
  namespaceSelector: policy?.spec?.matchConstraints?.namespaceSelector?.matchLabels ?? null,
  resourceRules: (policy?.spec?.matchConstraints?.resourceRules||[]).map(r=>({apiGroups:r.apiGroups,apiVersions:r.apiVersions,operations:r.operations,resources:r.resources})),
  matchConditions: (policy?.spec?.matchConditions||[]).map(c=>({name:c.name,expression:normalExpression(c.expression)})),
  variables: (policy?.spec?.variables||[]).map(v=>({name:v.name,expression:normalExpression(v.expression)})),
  validations: (policy?.spec?.validations||[]).map(v=>({expression:normalExpression(v.expression),message:v.message??null,messageExpression:v.messageExpression??null})),
});
const FENCES = ['opensphere-hiss-kured-writer-fence','opensphere-hiss-node-maintenance-workload'];
const artifactDocuments = raw => parseAllDocuments(String(raw)).map(d=>d.toJSON()).filter(Boolean);
export function nodeMaintenanceFenceExpressions(raw) {
  const policy = artifactDocuments(raw).find(d=>d.kind==='ValidatingAdmissionPolicy'&&d.metadata?.name==='opensphere-hiss-node-maintenance-workload');
  const variables = Object.fromEntries((policy?.spec?.variables||[]).map(v=>[v.name,normalExpression(v.expression)]));
  return Object.fromEntries(['approvedDigests','fixedArgs'].map(name=>[name,variables[name]??null]));
}
// The artifact split at its document separators: the admission fences, then everything else. Bytes are unchanged.
export function nodeMaintenanceApplyOrder(raw) {
  const parts = String(raw).split(/^---\n/m);
  const fence = part => /^kind: ValidatingAdmissionPolicy(Binding)?$/m.test(part);
  const join = list => list.map(p=>p.endsWith('\n')?p:p+'\n').join('---\n');
  return {fences:join(parts.filter(fence)),permissions:join(parts.filter(p=>!fence(p)))};
}
export function prepareHissNodeMaintenance(raw, scope, {runner=run, apply=false}={}) {
  const target = installTarget(scope);
  verifyHissNodeMaintenanceArtifact(raw);
  const kubectl = (args, input) => String(runner('kubectl',['--context',target.context,...args],{capture:true,...(input!==undefined?{input}:{})})||'');
  const missingNamespaces = ['monitoring','opensphere-console'].filter(name=>!kubectl(['get','namespace',name,'--ignore-not-found','-o','name','--request-timeout=10s']).trim());
  if (missingNamespaces.length) return {state:'Blocked',reason:'NamespacesMissing',missing:missingNamespaces,applied:false};
  if (!apply) {
    const present = kubectl(['get','-f','-','--ignore-not-found','-o','name','--request-timeout=10s'],raw).split(/\r?\n/).filter(Boolean).length;
    if (present === 0) return {state:'NeedsPreparation',applied:false,resourceCount:NODE_MAINTENANCE_OBJECTS};
    if (present < NODE_MAINTENANCE_OBJECTS) return {state:'NeedsUpdate',reason:'Partial',present,applied:false,resourceCount:NODE_MAINTENANCE_OBJECTS};
    const expected = artifactDocuments(raw).filter(d=>d.kind==='ValidatingAdmissionPolicy');
    const differs = FENCES.filter(name=>{
      let live = null;
      try { live = JSON.parse(kubectl(['get','validatingadmissionpolicy',name,'-o','json','--request-timeout=10s'])); } catch { live = null; }
      return JSON.stringify(fenceProjection(live))!==JSON.stringify(fenceProjection(expected.find(d=>d.metadata.name===name)));
    });
    return {state:differs.length?'NeedsUpdate':'Present',...(differs.length?{reason:'FenceRevisionDiffers',fences:differs}:{}),applied:false,resourceCount:NODE_MAINTENANCE_OBJECTS};
  }
  const {fences,permissions} = nodeMaintenanceApplyOrder(raw);
  kubectl(['apply','--server-side','--field-manager=opensphere-setup-hiss','-f','-','--request-timeout=20s'],fences);
  kubectl(['apply','--server-side','--field-manager=opensphere-setup-hiss','-f','-','--request-timeout=20s'],permissions);
  return {state:'Applied',applied:true,resourceCount:NODE_MAINTENANCE_OBJECTS};
}
const reference = (kind,name,namespace)=>({apiVersion:groups[kind][0],kind,metadata:{name,...(namespace?{namespace}:{})}});

function observationIndex(returned, requested) {
  const allowed = new Set(requested.map(identity));
  if (!Array.isArray(returned)) throw fail('OBSERVATION_UNAVAILABLE', 'Invalid prerequisite observation');
  const byId = new Map();
  for (const resource of returned) {
    if (!resource || !groups[resource.kind] || resource.apiVersion !== groups[resource.kind][0]
      || typeof resource.metadata?.name !== 'string' || !resource.metadata.name
      || typeof resource.metadata.uid !== 'string' || !resource.metadata.uid) {
      throw fail('OBSERVATION_UNAVAILABLE', 'Incomplete prerequisite observation');
    }
    const id = identity(resource);
    if (!allowed.has(id) || byId.has(id)) throw fail('OBSERVATION_UNAVAILABLE', 'Unexpected or duplicate prerequisite observation');
    byId.set(id, resource);
  }
  return byId;
}

export function verifyHissExecutionProfile(raw,scope) {
  installTarget(scope);
  if(typeof raw!=='string'||Buffer.byteLength(raw)>1024*1024||digest(raw)!==HISS_EXECUTION_PROFILE.sha256)throw fail('UNTRUSTED_PROFILE','HISS prerequisite bytes differ from the captured contract');
  const profile=JSON.parse(raw);
  if(profile.schemaVersion!==1||profile.status!=='proposed-not-applied'||profile.resources.length!==105)throw fail('UNTRUSTED_PROFILE','HISS prerequisite envelope differs');
  return profile;
}
function references(resources) {
  const all=new Map(resources.map(r=>[identity(r),r]));
  const dependencies=new Map();
  const add=r=>{if(!all.has(identity(r)))dependencies.set(identity(r),r);};
  for(const r of resources){
    if(r.metadata.namespace)add(reference('Namespace',r.metadata.namespace));
    if(r.roleRef){
      add(reference(r.roleRef.kind,r.roleRef.name,r.roleRef.kind==='Role'?r.metadata.namespace:undefined));
      for(const s of r.subjects||[])if(s.kind==='ServiceAccount'){
        add(reference('ServiceAccount',s.name,s.namespace));add(reference('Namespace',s.namespace));
      }
    }
  }
  return [...dependencies.values()];
}
function matches(expected,actual) {
  if(typeof actual?.metadata?.uid!=='string'||!actual.metadata.uid||actual.metadata.deletionTimestamp||identity(expected)!==identity(actual))return false;
  return expected.kind==='Namespace'||!Object.keys(actual.metadata.annotations||{}).some(k=>k.startsWith('helm.sh/hook'))
    &&canonical(projection(actual))===canonical(projection(expected));
}
async function observe(profile,dependencies,client) {
  let returned;try{returned=await client.read([...profile.resources,...dependencies]);}catch{throw fail('OBSERVATION_UNAVAILABLE','Cannot verify HISS prerequisites; no absence was inferred');}
  const byId=observationIndex(returned,[...profile.resources,...dependencies]);
  const resources=profile.resources.map(expected=>{
    const actual=byId.get(identity(expected));
    return {identity:identity(expected),expected,actual,status:!actual?'Missing':matches(expected,actual)
      ?expected.kind==='Namespace'?'PreserveNamespace':'Matching':'Conflict'};
  });
  const dependencyFailures=dependencies.filter(r=>!byId.get(identity(r))?.metadata?.uid||byId.get(identity(r))?.metadata?.deletionTimestamp).map(identity);
  return {resources,byId,dependencyFailures};
}
function publicPlan(observation,scope) {
  return {profile:HISS_EXECUTION_PROFILE.id,profileSha256:HISS_EXECUTION_PROFILE.sha256,context:scope.context,
    status:observation.dependencyFailures.length||observation.resources.some(r=>r.status==='Conflict')?'Blocked'
      :observation.resources.some(r=>r.status==='Missing')?'NeedsPreparation':'Prepared',
    resources:observation.resources.map(r=>({identity:r.identity,status:r.status})),dependencyFailures:observation.dependencyFailures,
    installationComplete:false};
}

export async function prepareHissPrerequisites(raw,scope,{client,apply=false,onProgress=()=>{}}) {
  scope={...scope};
  const profile=verifyHissExecutionProfile(raw,scope),dependencies=references(profile.resources);
  const initial=await observe(profile,dependencies,client),plan=publicPlan(initial,scope);
  if(!apply)return {...plan,applied:false,created:[],preserved:[]};
  if(plan.status==='Blocked')throw fail('PRECONDITION_FAILED','HISS prerequisite conflicts or missing dependencies must be resolved before preparation',plan);
  const created=[],preserved=[],observedAfterCreate=[];
  const observedUids=new Map(initial.resources.filter(r=>r.actual).map(r=>[r.identity,r.actual.metadata.uid]));
  // Definitions precede bindings. No new binding is created against an absent
  // or changed role, namespace or ServiceAccount.
  const rank={Namespace:0,ServiceAccount:1,Role:2,ClusterRole:2,RoleBinding:3,ClusterRoleBinding:3};
  const ordered=[...profile.resources].sort((a,b)=>rank[a.kind]-rank[b.kind]||identity(a).localeCompare(identity(b)));
  const expectedById=new Map(profile.resources.map(r=>[identity(r),r]));
  const dependencyOriginal=new Map(dependencies.map(r=>[identity(r),initial.byId.get(identity(r))]));
  const evidence=()=>({profile:HISS_EXECUTION_PROFILE.id,profileSha256:HISS_EXECUTION_PROFILE.sha256,context:scope.context,
    created:[...created],preserved:[...preserved],observedAfterCreate:[...observedAfterCreate],installationComplete:false});
  const report=event=>{try{onProgress(event);}catch{/* Logging cannot change authority or turn a confirmed write into an unknown outcome. */}};
  for(const resource of ordered){
    const id=identity(resource),needs=references([resource]);
    // Include internally prepared dependencies, which references([resource])
    // correctly treats as external to this single resource.
    let live;
    try{live=observationIndex(await client.read([resource,...needs]),[resource,...needs]);}
    catch{throw fail('PREPARATION_INCOMPLETE','Prerequisite recheck failed; existing resources were not rolled back',evidence());}
    for(const dependency of needs){
      const dependencyId=identity(dependency),actual=live.get(dependencyId),expected=expectedById.get(dependencyId);
      const before=dependencyOriginal.get(dependencyId);
      if(!actual?.metadata?.uid||actual.metadata.deletionTimestamp||expected&&!matches(expected,actual)
        ||observedUids.has(dependencyId)&&actual.metadata.uid!==observedUids.get(dependencyId)
        ||before&&(actual.metadata.uid!==before.metadata.uid||canonical(projection(actual))!==canonical(projection(before)))){
        throw fail('PREPARATION_INCOMPLETE','Referenced prerequisite changed; no further writes were made',evidence());
      }
    }
    const actual=live.get(id);
    if(actual){
      if(!matches(resource,actual)||observedUids.has(id)&&observedUids.get(id)!==actual.metadata.uid)throw fail('PREPARATION_INCOMPLETE','Prerequisite changed after review; no overwrite was attempted',evidence());
      observedUids.set(id,actual.metadata.uid);
      preserved.push(id);report({identity:id,state:'Preserved'});continue;
    }
    if(observedUids.has(id))throw fail('PREPARATION_INCOMPLETE','An existing prerequisite disappeared; no automatic replacement was attempted',evidence());
    let result;
    try{result=await client.create(structuredClone(resource));}catch{
      // Timeout/409 is ambiguous. Observe the exact identity once; never issue
      // a blind second create or delete resources as an automatic rollback.
      let after;try{after=observationIndex(await client.read([resource]),[resource]);}catch{throw fail('PREPARATION_INCOMPLETE','Create outcome is unknown; re-inspection is required',evidence());}
      const found=after.get(id);
      if(!matches(resource,found))throw fail('PREPARATION_INCOMPLETE','Create was not confirmed; re-inspection is required',evidence());
      observedUids.set(id,found.metadata.uid);observedAfterCreate.push(id);report({identity:id,state:'ObservedAfterUncertainCreate'});continue;
    }
    if(!matches(resource,result))throw fail('PREPARATION_INCOMPLETE','Created prerequisite does not match the captured contract',evidence());
    observedUids.set(id,result.metadata.uid);created.push(id);report({identity:id,state:'Created'});
  }
  let final;try{final=await observe(profile,dependencies,client);}catch{throw fail('PREPARATION_INCOMPLETE','Final prerequisite observation is unavailable; resources were preserved',evidence());}
  for(const [id,before]of dependencyOriginal){
    const actual=final.byId.get(id);
    if(!actual||actual.metadata.uid!==before.metadata.uid||canonical(projection(actual))!==canonical(projection(before)))throw fail('PREPARATION_INCOMPLETE','An external prerequisite changed; re-inspection is required',evidence());
  }
  for(const [id,uid]of observedUids)if(final.byId.get(id)?.metadata.uid!==uid)throw fail('PREPARATION_INCOMPLETE','A prerequisite was replaced during preparation; resources were preserved',evidence());
  const finalPlan=publicPlan(final,scope);
  if(finalPlan.status!=='Prepared')throw fail('PREPARATION_INCOMPLETE','Final prerequisite verification failed; resources were preserved',evidence());
  return {...finalPlan,applied:true,...evidence()};
}

// Explicit context is immutable for this adapter. It never follows a later
// kubectl current-context or OPENSPHERE_KUBE_CONTEXT environment change.
export function createHissPrerequisiteClient(scope,runner=run) {
  const {context}=installTarget(scope);
  const execute=(args,input)=>JSON.parse(runner('kubectl',['--context',context,...args,'--request-timeout=10s','-o','json'],
    {capture:true,input:JSON.stringify(input),spawn:{maxBuffer:8*1024*1024,timeout:60000}})||'null');
  const clusterIdentity=()=>execute(['get','namespace','kube-system'],null)?.metadata?.uid;
  const clusterUid=clusterIdentity();
  if(!clusterUid)throw fail('OBSERVATION_UNAVAILABLE','Cluster UID could not be verified');
  return {
    read:async resources=>{
      const result=execute(['get','--ignore-not-found','-f','-'],{apiVersion:'v1',kind:'List',items:resources});
      return result?result.kind==='List'?result.items:[result]:[];
    },
    create:async resource=>{
      if(clusterIdentity()!==clusterUid)throw fail('PRECONDITION_FAILED','Kubernetes context now points at a different cluster');
      return execute(['create','-f','-'],resource);
    },
  };
}
