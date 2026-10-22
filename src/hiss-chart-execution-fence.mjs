import { createHash } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { run } from './process.mjs';
import { installTarget } from './install-target.mjs';

// HISS chart execution fence (Cluster Manager privileged-write fence design 2026-10-22, user decision "권고대로, 실험·구현
// 진행 (권장)": D-F1-D-F12). Source: Cluster Manager deploy/hiss-chart-execution-fence.yaml, generated from the kind-lab
// reviewed shapes (tools/render-hiss-chart-execution-fence.cjs). The bytes are pinned here; Setup applies them with
// server-side apply under the HISS field manager, admission policies first, bindings next, Pod Security labels last, and
// never takes over a field another manager owns (--force-conflicts is not used). Nothing here grants a permission.
export const HISS_CHART_EXECUTION_FENCE = Object.freeze({
  id: 'hiss-chart-execution-fence-v1',
  sourceRepository: 'opensphere-platform/OpenSphere-shell-clusterManager',
  sourcePath: 'deploy/hiss-chart-execution-fence.yaml',
  sourceRevision: '9541f28dcb66cfa9bc60dfdd9375e9ad63f11dc2',
  sha256: '0b0ac99913f64df8660fe33761e64762e9e08ce0d669970c5469b4256a0e6700',
  resourceCount: 31,
});
// Namespaces whose Pod Security labels the artifact sets; they must exist (the HISS execution profile creates them).
const LABELLED_NAMESPACES = Object.freeze(['cert-manager', 'metrics-server', 'ingress-nginx']);
const MANAGER = 'opensphere-setup-hiss';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const canonical = (v) => JSON.stringify(sorted(v));
const fail = (code, message, evidence) => Object.assign(new Error(message), { code, ...(evidence ? { evidence } : {}) });
const id = (o) => `${o.kind}/${o.metadata?.namespace || ''}/${o.metadata?.name}`;

export function verifyHissChartExecutionFence(raw) {
  if (typeof raw !== 'string' || digest(raw) !== HISS_CHART_EXECUTION_FENCE.sha256) throw fail('UNTRUSTED_PROFILE', 'HISS chart execution fence bytes differ from the approved contract');
  const documents = parseAllDocuments(raw).map((d) => d.toJSON()).filter(Boolean);
  if (documents.length !== HISS_CHART_EXECUTION_FENCE.resourceCount) throw fail('UNTRUSTED_PROFILE', 'HISS chart execution fence envelope differs');
  if (documents.some((d) => !['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding', 'Namespace'].includes(d.kind)))
    throw fail('UNTRUSTED_PROFILE', 'HISS chart execution fence carries an object that is not a fence');
  for (const d of documents.filter((x) => x.kind === 'Namespace')) {
    if (!LABELLED_NAMESPACES.includes(d.metadata.name) || Object.keys(d).some((k) => !['apiVersion', 'kind', 'metadata'].includes(k))
      || Object.keys(d.metadata).some((k) => !['name', 'labels'].includes(k)) || Object.keys(d.metadata.labels || {}).some((k) => !k.startsWith('pod-security.kubernetes.io/')))
      throw fail('UNTRUSTED_PROFILE', 'HISS chart execution fence may only set Pod Security labels on its namespaces');
  }
  return documents;
}

// What the API server keeps of an applied document: every field set here is present with the same value. A policy must
// carry nothing that narrows it (an extra match condition, parameter or exclusion); a binding nothing that narrows it.
function holds(live, wanted) {
  if (Array.isArray(wanted)) return Array.isArray(live) && live.length === wanted.length && wanted.every((v, i) => holds(live[i], v));
  if (wanted && typeof wanted === 'object') return !!live && typeof live === 'object' && Object.keys(wanted).every((k) => holds(live[k], wanted[k]));
  return live === wanted;
}
const emptySelector = (v) => v === undefined || v === null || (typeof v === 'object' && Object.entries(v).every(([k, x]) =>
  x === undefined || x === null || (Array.isArray(x) && !x.length) || (k === 'matchPolicy' && x === 'Equivalent') || emptySelector(x)));
export function fenceMatches(document, live) {
  if (!live?.metadata?.uid || live.metadata.deletionTimestamp) return false;
  if (document.kind === 'Namespace') return holds(live.metadata.labels || {}, document.metadata.labels || {});
  if (!holds(live.metadata.labels || {}, document.metadata.labels || {})) return false;
  if (document.kind === 'ValidatingAdmissionPolicy') {
    const same = (key) => canonical(live.spec?.[key] ?? null) === canonical(document.spec[key] ?? null);
    return holds(live.spec, document.spec) && ['matchConditions', 'variables', 'validations', 'paramKind', 'auditAnnotations'].every(same)
      && emptySelector(live.spec?.matchConstraints?.excludeResourceRules) && (document.spec.matchConstraints?.objectSelector ? true : emptySelector(live.spec?.matchConstraints?.objectSelector));
  }
  return holds(live.spec, document.spec) && live.spec?.paramRef === undefined && emptySelector(live.spec?.matchResources)
    && canonical(live.spec?.validationActions) === canonical(document.spec.validationActions);
}
const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function parseStream(text) {
  const out = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{') { if (depth++ === 0) start = i; } else if (ch === '}' && --depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
  }
  return out.flatMap((o) => (o.kind === 'List' ? o.items || [] : [o]));
}

export function prepareHissChartExecutionFence(raw, scope, { runner = run, apply = false, sleep = defaultSleep, attempts = 60 } = {}) {
  const target = installTarget(scope);
  const documents = verifyHissChartExecutionFence(raw);
  const k = (args, options = {}) => String(runner('kubectl', ['--context', target.context, ...args], { capture: true, ...options }) || '');
  const list = (items) => `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items })}\n`;
  const missingNamespaces = LABELLED_NAMESPACES.filter((name) => !k(['get', 'namespace', name, '--ignore-not-found', '-o', 'name', '--request-timeout=10s']).trim());
  if (missingNamespaces.length) return { state: 'Blocked', reason: 'NamespacesMissing', missing: missingNamespaces, applied: false, resourceCount: documents.length };
  const observe = (subset = documents) => {
    const live = new Map(parseStream(k(['get', '-f', '-', '--ignore-not-found', '-o', 'json', '--request-timeout=30s'], { input: list(subset) })).map((o) => [id(o), o]));
    const objects = subset.map((d) => ({ identity: id(d), status: !live.has(id(d)) ? 'Missing' : fenceMatches(d, live.get(id(d))) ? 'Matching' : 'Differs' }));
    return { objects, missing: objects.filter((o) => o.status === 'Missing').length, differs: objects.filter((o) => o.status === 'Differs').length };
  };
  const before = observe();
  // NeedsPreparation: no policy or binding of this fence exists yet; NeedsUpdate: some exist, or differ, or labels are missing.
  const fenceObjects = before.objects.filter((o) => !o.identity.startsWith('Namespace/'));
  const state = !before.missing && !before.differs ? 'Present' : fenceObjects.every((o) => o.status === 'Missing') ? 'NeedsPreparation' : 'NeedsUpdate';
  if (!apply || state === 'Present') return { state, applied: false, resourceCount: documents.length, missing: before.missing, differs: before.differs,
    objects: before.objects.filter((o) => o.status !== 'Matching') };
  const applyAll = (subset) => k(['apply', '--server-side', `--field-manager=${MANAGER}`, '-f', '-', '--request-timeout=60s'], { input: list(subset) });
  const readBack = (subset, phase) => {
    const after = observe(subset);
    if (after.missing || after.differs) throw fail('PREPARATION_INCOMPLETE', `HISS chart execution fence (${phase}) does not read back as applied`, { objects: after.objects.filter((o) => o.status !== 'Matching') });
  };
  // Policies first, type-checked without warnings, before any binding makes them act.
  const policies = documents.filter((d) => d.kind === 'ValidatingAdmissionPolicy');
  applyAll(policies);
  readBack(policies, 'policies');
  for (let attempt = 1; ; attempt += 1) {
    const live = parseStream(k(['get', '-f', '-', '-o', 'json', '--request-timeout=30s'], { input: list(policies) }));
    if (live.length === policies.length && live.every((p) => p.status?.observedGeneration === p.metadata?.generation && !(p.status?.typeChecking?.expressionWarnings || []).length)) break;
    if (attempt >= attempts) throw fail('PREPARATION_INCOMPLETE', 'A HISS chart execution fence policy is not type-checked without warnings; no binding was applied');
    sleep(500);
  }
  const bindings = documents.filter((d) => d.kind === 'ValidatingAdmissionPolicyBinding');
  applyAll(bindings);
  readBack(bindings, 'bindings');
  const labels = documents.filter((d) => d.kind === 'Namespace');
  applyAll(labels);
  readBack(documents, 'all objects');
  return { state: 'Applied', applied: true, resourceCount: documents.length, created: before.missing, updated: before.differs,
    enforcement: [...new Set(bindings.flatMap((b) => b.spec.validationActions))] };
}

// ---- F-6 plan invariant -------------------------------------------------------------------------------------------
// Cluster Manager may create objects that become Pods (directly, through a controller, or through an operator) only in
// namespaces an admission fence covers. Setup reads the RBAC that applies to the Cluster Manager runtime account, asks the
// API server (SubjectAccessReview) for every Pod-producing kind in those namespaces and cluster-wide, and refuses
// (Blocked) when such a right has no fence, or when Cluster Manager may create a kind this table does not know.
export const CM_RUNTIME = Object.freeze({ namespace: 'opensphere-console', name: 'opensphere-cluster-manager-runtime' });
const CM_USER = `system:serviceaccount:${CM_RUNTIME.namespace}:${CM_RUNTIME.name}`;
const CM_GROUPS = Object.freeze(['system:serviceaccounts', `system:serviceaccounts:${CM_RUNTIME.namespace}`, 'system:authenticated']);
export const POD_PRODUCING = Object.freeze([
  ['', 'pods'], ['', 'replicationcontrollers'], ['apps', 'deployments'], ['apps', 'daemonsets'], ['apps', 'statefulsets'], ['apps', 'replicasets'],
  ['batch', 'jobs'], ['batch', 'cronjobs'],
  ['monitoring.coreos.com', 'prometheuses'], ['monitoring.coreos.com', 'alertmanagers'], ['monitoring.coreos.com', 'prometheusagents'], ['monitoring.coreos.com', 'thanosrulers'],
  ['ceph.rook.io', 'cephclusters'], ['ceph.rook.io', 'cephfilesystems'], ['ceph.rook.io', 'cephobjectstores'], ['ceph.rook.io', 'cephnfses'],
  ['ceph.rook.io', 'cephrbdmirrors'], ['ceph.rook.io', 'cephfilesystemmirrors'], ['ceph.rook.io', 'cephcosidrivers'],
  ['stackgres.io', 'sgclusters'], ['stackgres.io', 'sgshardedclusters'], ['stackgres.io', 'sgdistributedlogs'], ['stackgres.io', 'sgdbops'],
  ['stackgres.io', 'sgshardeddbops'], ['stackgres.io', 'sgstreams'], ['stackgres.io', 'sgbackups'], ['stackgres.io', 'sgshardedbackups'],
]);
// Namespaced kinds Cluster Manager may create that never become Pods. Fenced elsewhere where content matters (F-2, F-3,
// F-5, F-8) or harmless on their own.
export const NON_POD = Object.freeze([
  ['', 'configmaps'], ['', 'secrets'], ['', 'services'], ['', 'persistentvolumeclaims'], ['', 'serviceaccounts'], ['', 'serviceaccounts/token'],
  ['', 'events'], ['', 'pods/eviction'], ['', 'endpoints'], ['networking.k8s.io', 'networkpolicies'], ['networking.k8s.io', 'ingresses'],
  ['monitoring.coreos.com', 'servicemonitors'], ['monitoring.coreos.com', 'prometheusrules'], ['monitoring.coreos.com', 'podmonitors'],
  ['monitoring.coreos.com', 'probes'], ['monitoring.coreos.com', 'scrapeconfigs'], ['monitoring.coreos.com', 'alertmanagerconfigs'],
  ['cert-manager.io', 'certificates'], ['cert-manager.io', 'issuers'], ['csi.ceph.io', 'cephconnections'], ['csi.ceph.io', 'clientprofiles'],
  ['snapshot.storage.k8s.io', 'volumesnapshots'], ['coordination.k8s.io', 'leases'], ['events.k8s.io', 'events'],
  ['stackgres.io', 'sgconfigs'], ['stackgres.io', 'sgpgconfigs'], ['stackgres.io', 'sginstanceprofiles'], ['stackgres.io', 'sgpoolconfigs'],
  ['stackgres.io', 'sgobjectstorages'], ['stackgres.io', 'sgscripts'],
  ['opensphere.io', 'observabilitybindings'], ['opensphere.io', 'observabilitybindings/status'],
]);
// Cluster-scoped kinds: no Pod of their own; fenced by F-4 and the earlier Ceph storage policies.
export const CLUSTER_SCOPED = Object.freeze([
  ['admissionregistration.k8s.io', 'mutatingwebhookconfigurations'], ['admissionregistration.k8s.io', 'validatingwebhookconfigurations'],
  ['apiextensions.k8s.io', 'customresourcedefinitions'], ['apiregistration.k8s.io', 'apiservices'], ['cert-manager.io', 'clusterissuers'],
  ['storage.k8s.io', 'storageclasses'], ['snapshot.storage.k8s.io', 'volumesnapshotclasses'], ['networking.k8s.io', 'ingressclasses'],
  ['authentication.k8s.io', 'tokenreviews'], ['authentication.k8s.io', 'selfsubjectreviews'], ['authorization.k8s.io', 'selfsubjectaccessreviews'],
  ['authorization.k8s.io', 'selfsubjectrulesreviews'], ['authorization.k8s.io', 'subjectaccessreviews'],
]);
// A namespace with Pod-producing rights counts as covered by one of these (design F-6). A fence counts when its policy and
// a binding of the same name exist; the binding's actions are reported (Warn during F1-F2, Deny from F3).
export const COVERAGE = Object.freeze([
  ...['monitoring', 'cert-manager', 'ingress-nginx', 'metrics-server'].map((namespace) => ({ namespace, policy: `opensphere-hiss-workload-shape-${namespace}`, source: 'chart-execution-fence' })),
  { namespace: 'opensphere-node-maintenance', policy: 'opensphere-hiss-node-maintenance-workload', source: 'node-maintenance' },
  { namespace: 'opensphere-console', policy: 'opensphere-ceph-preparation-job', source: 'ceph-preparation' },
  { namespace: 'rook-ceph', policy: 'opensphere-hiss-ceph-cluster-cm', source: 'chart-execution-fence' },
  { namespace: 'opensphere-stackgres', policy: 'opensphere-hiss-stackgres-operator-workload', source: 'operator-stackgres' },
  // PSA restricted, and the only ServiceAccount there is a default one with no rights (design F-6).
  { namespace: 'opensphere-hiss-validation', restrictedDefaultOnly: true },
  { namespace: 'opensphere-ceph-verification', restrictedDefaultOnly: true },
]);
const key = (g, r) => `${g}/${r}`;
const POD_KEYS = new Set(POD_PRODUCING.map(([g, r]) => key(g, r)));
const NON_POD_KEYS = new Set(NON_POD.map(([g, r]) => key(g, r)));
const CLUSTER_KEYS = new Set(CLUSTER_SCOPED.map(([g, r]) => key(g, r)));
const subjectMatches = (s) => (s.kind === 'ServiceAccount' && s.name === CM_RUNTIME.name && (s.namespace || '') === CM_RUNTIME.namespace)
  || (s.kind === 'Group' && CM_GROUPS.includes(s.name)) || (s.kind === 'User' && s.name === CM_USER);

// Every (scope, group, resource) the Cluster Manager runtime may create according to RBAC. scope is a namespace or '*'.
export function cmCreateGrants({ clusterRoleBindings, roleBindings, clusterRoles, roles }) {
  const cr = new Map(clusterRoles.map((r) => [r.metadata.name, r]));
  const rl = new Map(roles.map((r) => [`${r.metadata.namespace}/${r.metadata.name}`, r]));
  const grants = [];
  const take = (scope, role) => {
    for (const rule of role?.rules || []) {
      if (!(rule.verbs || []).some((v) => v === 'create' || v === '*')) continue;
      for (const g of rule.apiGroups || ['']) for (const r of rule.resources || []) grants.push({ scope, group: g, resource: r, named: (rule.resourceNames || []).length > 0 });
    }
  };
  for (const b of clusterRoleBindings) if ((b.subjects || []).some(subjectMatches)) take('*', cr.get(b.roleRef.name));
  for (const b of roleBindings) if ((b.subjects || []).some(subjectMatches))
    take(b.metadata.namespace, b.roleRef.kind === 'ClusterRole' ? cr.get(b.roleRef.name) : rl.get(`${b.metadata.namespace}/${b.roleRef.name}`));
  return grants;
}
export function classifyGrants(grants) {
  const podScopes = new Set(), unknown = [];
  for (const g of grants) {
    const k = key(g.group, g.resource);
    if (g.group === '*' || g.resource === '*' || g.resource.endsWith('/*')) { unknown.push(`${g.scope}:${k}`); continue; }
    if (POD_KEYS.has(k)) { podScopes.add(g.scope); continue; }
    if (NON_POD_KEYS.has(k) || CLUSTER_KEYS.has(k)) continue;
    unknown.push(`${g.scope}:${k}`);
  }
  return { podScopes: [...podScopes].sort(), unknown: [...new Set(unknown)].sort() };
}

export function hissExecutionCoverage(scope, { runner = run, pendingPolicies = [] } = {}) {
  const target = installTarget(scope);
  const k = (args, options = {}) => String(runner('kubectl', ['--context', target.context, ...args], { capture: true, ...options }) || '');
  const items = (args) => parseStream(k([...args, '-o', 'json', '--request-timeout=30s']));
  const rbac = { clusterRoleBindings: items(['get', 'clusterrolebindings']), roleBindings: items(['get', 'rolebindings', '-A']),
    clusterRoles: items(['get', 'clusterroles']), roles: items(['get', 'roles', '-A']) };
  const { podScopes, unknown } = classifyGrants(cmCreateGrants(rbac));
  // The API server's answer for every Pod-producing kind, cluster-wide and in each namespace RBAC names.
  const namespaces = podScopes.filter((s) => s !== '*');
  const reviews = ['', ...new Set([...namespaces, ...COVERAGE.map((c) => c.namespace)])].flatMap((namespace) => POD_PRODUCING.map(([group, resource]) => ({
    apiVersion: 'authorization.k8s.io/v1', kind: 'SubjectAccessReview',
    spec: { user: CM_USER, groups: [...CM_GROUPS], resourceAttributes: { namespace, verb: 'create', group, resource } } })));
  const answers = parseStream(k(['create', '-f', '-', '-o', 'json', '--request-timeout=60s'], { input: `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items: reviews })}\n` }));
  if (answers.length !== reviews.length) throw fail('OBSERVATION_UNAVAILABLE', 'SubjectAccessReview answers are incomplete; coverage cannot be judged');
  const allowed = new Map();
  answers.forEach((a, i) => { if (a.status?.allowed) { const r = reviews[i].spec.resourceAttributes; (allowed.get(r.namespace) || allowed.set(r.namespace, []).get(r.namespace)).push(r.resource); } });
  const clusterWide = allowed.get('') || [];
  const policies = new Map(items(['get', 'validatingadmissionpolicies']).map((p) => [p.metadata.name, p]));
  const bindings = items(['get', 'validatingadmissionpolicybindings']);
  const report = [];
  for (const [namespace, kinds] of [...allowed].filter(([n]) => n !== '').sort()) {
    const cover = COVERAGE.find((c) => c.namespace === namespace);
    let state = 'Uncovered', enforcement = null;
    if (cover?.policy) {
      const b = bindings.find((x) => x.spec?.policyName === cover.policy);
      if (policies.has(cover.policy) && b) { state = 'Covered'; enforcement = (b.spec.validationActions || []).join(','); }
      else if (pendingPolicies.includes(cover.policy)) state = 'Pending';
    } else if (cover?.restrictedDefaultOnly) {
      const ns = items(['get', 'namespace', namespace])[0];
      const accounts = items(['get', 'serviceaccounts', '-n', namespace]).map((s) => s.metadata.name);
      const defaultBound = rbac.roleBindings.concat(rbac.clusterRoleBindings).some((b) => (b.subjects || []).some((s) => s.kind === 'ServiceAccount' && s.namespace === namespace));
      if (ns?.metadata?.labels?.['pod-security.kubernetes.io/enforce'] === 'restricted' && canonical(accounts) === canonical(['default']) && !defaultBound) state = 'Covered';
    }
    report.push({ namespace, kinds: kinds.sort(), state, ...(cover?.policy ? { policy: cover.policy } : {}), ...(enforcement ? { enforcement } : {}) });
  }
  const blocked = clusterWide.length > 0 || unknown.length > 0 || report.some((r) => r.state === 'Uncovered');
  return { state: blocked ? 'Blocked' : report.some((r) => r.state === 'Pending') ? 'NeedsPreparation' : 'Covered',
    ...(clusterWide.length ? { clusterWide } : {}), ...(unknown.length ? { unknown } : {}), namespaces: report };
}
