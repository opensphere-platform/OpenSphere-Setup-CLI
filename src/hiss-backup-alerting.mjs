import { createHash } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { run } from './process.mjs';
import { installTarget } from './install-target.mjs';

// RKE2 readiness stage R1 (plan 2026-10-24, R1-4 and R1-5, user approval "전부 승인 (권장)"). Two Cluster Manager
// artifacts that Setup pins by sha256 and applies in prepare-hiss:
//
// - deploy/hiss-backup-alerting.yaml (plan §4.1 BK-P6, AL-P4): Cluster Manager's Roles for its core alert rule, the
//   temporary emergency AlertmanagerConfig and the Longhorn backup target, recurring jobs and volume group labels, and
//   five admission policies that fence those writes. The Longhorn half is applied only where Longhorn runs. The alert
//   fences hold only together with the Cluster Manager privileged-write fence (CM #32 / Setup #45): on RKE2 the same
//   account already writes every Secret in monitoring through the kube-prometheus-stack executor Role.
// - deploy/hiss-scrape-access.yaml (AL-P5): NetworkPolicies that admit Prometheus to the ingress-nginx and cert-manager
//   metrics ports. Each is applied only where another policy already isolates those Pods: a policy that selects a Pod
//   denies every ingress it does not list, so applying it to an unisolated namespace would cut 80/443 and the webhook.
//
// Server-side apply under the opensphere-setup-hiss field manager, never forcing conflicts; admission policies are
// applied before the permissions they fence.
export const BACKUP_ALERTING_SOURCE = Object.freeze({
  repository: 'opensphere-platform/OpenSphere-shell-clusterManager',
  path: 'deploy/hiss-backup-alerting.yaml',
  revision: '2dc28f6f746dff1757120c9d82da5003c6ef2117',
});
export const SCRAPE_ACCESS_SOURCE = Object.freeze({
  repository: 'opensphere-platform/OpenSphere-shell-clusterManager',
  path: 'deploy/hiss-scrape-access.yaml',
  revision: '2dc28f6f746dff1757120c9d82da5003c6ef2117',
});
const BACKUP_ALERTING_SHA256 = '6d36bb48a5f09226bc9a82b1772f61da427a5872cdabbd288e4435e602fb2280';
const SCRAPE_ACCESS_SHA256 = '0132b4889591dcae9aba87af076aba2c101484544f2f30d62cf62bf2e5a8b0a4';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const documentsOf = raw => parseAllDocuments(String(raw)).map(d => d.toJSON()).filter(Boolean);
const normalExpression = value => String(value).replace(/\s+/g, ' ').trim();
const isFence = d => d.kind === 'ValidatingAdmissionPolicy' || d.kind === 'ValidatingAdmissionPolicyBinding';
const isLonghornPart = d => d.metadata?.namespace === 'longhorn-system' || /^opensphere-hiss-backup-/.test(d.metadata?.name || '');

export function verifyHissBackupAlertingArtifact(raw) {
  if (typeof raw !== 'string' || digest(raw) !== BACKUP_ALERTING_SHA256) throw fail('UNTRUSTED_PROFILE', 'HISS backup and alerting bytes differ from the approved contract');
  return raw;
}
export function verifyHissScrapeAccessArtifact(raw) {
  if (typeof raw !== 'string' || digest(raw) !== SCRAPE_ACCESS_SHA256) throw fail('UNTRUSTED_PROFILE', 'HISS scrape access bytes differ from the approved contract');
  return raw;
}

// The artifact cut at its document separators into the four apply units, bytes unchanged.
export function backupAlertingParts(raw) {
  const parts = String(raw).split(/^---\n/m).filter(p => /^kind: /m.test(p));
  const doc = part => documentsOf(part)[0];
  const join = list => list.map(p => (p.endsWith('\n') ? p : p + '\n')).join('---\n');
  const pick = (longhorn, fence) => join(parts.filter(p => isLonghornPart(doc(p)) === longhorn && isFence(doc(p)) === fence));
  return { alertingFences: pick(false, true), alertingPermissions: pick(false, false), backupFences: pick(true, true), backupPermissions: pick(true, false) };
}

const fenceProjection = policy => ({
  failurePolicy: policy?.spec?.failurePolicy ?? null,
  namespaceSelector: policy?.spec?.matchConstraints?.namespaceSelector?.matchLabels ?? null,
  resourceRules: (policy?.spec?.matchConstraints?.resourceRules || []).map(r => ({ apiGroups: r.apiGroups, apiVersions: r.apiVersions, operations: r.operations, resources: r.resources })),
  matchConditions: (policy?.spec?.matchConditions || []).map(c => ({ name: c.name, expression: normalExpression(c.expression) })),
  variables: (policy?.spec?.variables || []).map(v => ({ name: v.name, expression: normalExpression(v.expression) })),
  validations: (policy?.spec?.validations || []).map(v => ({ expression: normalExpression(v.expression), message: v.message ?? null })),
});

// The three Longhorn policy bindings start as [Warn, Audit] (the artifact bytes): the policies see the object after
// Longhorn's mutating webhooks, which only RKE2 exercises (review M2). `backupFences: 'deny'` (CLI
// `prepare-hiss --apply --backup-fences deny`) moves them to [Deny] once the first target set, job apply and volume
// assign/unassign on RKE2 raised no warning; `'warn'` moves them back. Without the option a live [Deny] is kept, so a
// later prepare-hiss never weakens the fence silently.
export const BACKUP_FENCE_BINDINGS = Object.freeze(['opensphere-hiss-backup-target', 'opensphere-hiss-backup-recurring-jobs', 'opensphere-hiss-backup-volume-labels']);
const WARN_ACTIONS = '  validationActions: ["Warn", "Audit"]';
const DENY_ACTIONS = '  validationActions: ["Deny"]';
export function backupFenceText(part, mode) {
  if (mode !== 'deny') return part;
  if (part.split(WARN_ACTIONS).length - 1 !== BACKUP_FENCE_BINDINGS.length) throw fail('UNTRUSTED_PROFILE', 'The backup fence bindings are not in the reviewed shape');
  return part.split(WARN_ACTIONS).join(DENY_ACTIONS);
}

// The live shape compared with the artifact: for policies their match, variables and validations; for Roles their
// rules; for RoleBindings their roleRef and subjects; for bindings their policy, parameter and actions.
const sortedJson = v => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
const projection = d => {
  if (!d) return null;
  if (d.kind === 'ValidatingAdmissionPolicy') return sortedJson({ ...fenceProjection(d), paramKind: d.spec?.paramKind ?? null });
  if (d.kind === 'ValidatingAdmissionPolicyBinding') return sortedJson({ policyName: d.spec?.policyName, paramRef: d.spec?.paramRef ?? null, validationActions: d.spec?.validationActions || [] });
  if (d.kind === 'Role') return sortedJson((d.rules || []).map(r => ({ apiGroups: r.apiGroups || [], resources: r.resources || [], resourceNames: r.resourceNames || [], verbs: r.verbs || [] })));
  if (d.kind === 'RoleBinding') return sortedJson({ roleRef: d.roleRef, subjects: d.subjects });
  return null;
};

export function prepareHissBackupAlerting(raw, scope, { runner = run, apply = false, backupFences } = {}) {
  const target = installTarget(scope);
  verifyHissBackupAlertingArtifact(raw);
  if (backupFences !== undefined && !['deny', 'warn'].includes(backupFences)) throw fail('INVALID_INPUT', '--backup-fences is deny or warn');
  const kubectl = (args, input) => String(runner('kubectl', ['--context', target.context, ...args], { capture: true, ...(input !== undefined ? { input } : {}) }) || '');
  const exists = (kind, name) => Boolean(kubectl(['get', kind, name, '--ignore-not-found', '-o', 'name', '--request-timeout=10s']).trim());
  const live = d => {
    const kind = { ValidatingAdmissionPolicy: 'validatingadmissionpolicy', ValidatingAdmissionPolicyBinding: 'validatingadmissionpolicybinding', Role: 'role', RoleBinding: 'rolebinding' }[d.kind];
    try { const text = kubectl([...(d.metadata.namespace ? ['-n', d.metadata.namespace] : []), 'get', kind, d.metadata.name, '--ignore-not-found', '-o', 'json', '--request-timeout=10s']); return text.trim() ? JSON.parse(text) : null; }
    catch { return null; }
  };
  const missing = ['monitoring', 'opensphere-console'].filter(name => !exists('namespace', name));
  if (missing.length) return { state: 'Blocked', reason: 'NamespacesMissing', missing, applied: false };
  const longhorn = exists('namespace', 'longhorn-system') && exists('customresourcedefinition', 'recurringjobs.longhorn.io');
  const parts = backupAlertingParts(raw);
  // The fence mode: as asked, else as it is live (Deny stays Deny), else the artifact's Warn/Audit.
  const liveDeny = longhorn && BACKUP_FENCE_BINDINGS.every(name => (live({ kind: 'ValidatingAdmissionPolicyBinding', metadata: { name } })?.spec?.validationActions || []).includes('Deny'));
  const mode = backupFences ?? (liveDeny ? 'deny' : 'warn');
  const selected = [parts.alertingFences, parts.alertingPermissions, ...(longhorn ? [backupFenceText(parts.backupFences, mode), parts.backupPermissions] : [])];
  const docs = selected.flatMap(documentsOf);
  const result = { resourceCount: docs.length, longhorn: longhorn ? 'Included' : 'NotApplicable', ...(longhorn ? { backupFences: mode === 'deny' ? 'Deny' : 'WarnAudit' } : {}) };
  if (!apply) {
    const present = kubectl(['get', '-f', '-', '--ignore-not-found', '-o', 'name', '--request-timeout=10s'], selected.join('---\n')).split(/\r?\n/).filter(Boolean).length;
    if (present === 0) return { state: 'NeedsPreparation', applied: false, ...result };
    if (present < docs.length) return { state: 'NeedsUpdate', reason: 'Partial', present, applied: false, ...result };
    const differs = docs.filter(d => projection(d) !== null && projection(live(d)) !== projection(d)).map(d => `${d.kind}/${d.metadata.name}`);
    return { state: differs.length ? 'NeedsUpdate' : 'Present', ...(differs.length ? { reason: 'RevisionDiffers', differs } : {}), applied: false, ...result };
  }
  // Fences first: a failed policy apply stops before the rights it would fence exist.
  for (const part of selected) kubectl(['apply', '--server-side', '--field-manager=opensphere-setup-hiss', '-f', '-', '--request-timeout=20s'], part);
  return { state: 'Applied', applied: true, ...result };
}

// Label selector matching as Kubernetes evaluates it (matchLabels and matchExpressions).
export function selects(selector, labels) {
  if (!selector) return false;
  const l = labels || {};
  if (Object.entries(selector.matchLabels || {}).some(([k, v]) => l[k] !== v)) return false;
  return (selector.matchExpressions || []).every(({ key, operator, values = [] }) => ({
    In: () => key in l && values.includes(l[key]), NotIn: () => !(key in l && values.includes(l[key])),
    Exists: () => key in l, DoesNotExist: () => !(key in l),
  })[operator]?.() ?? false);
}
// A Kubernetes NetworkPolicy isolates its Pods for ingress when its policyTypes include Ingress (the default when
// policyTypes is empty); a CiliumNetworkPolicy does when it has ingress or ingressDeny rules.
const isolatesIngress = policy => (policy.kind === 'CiliumNetworkPolicy'
  ? Boolean(policy.spec?.ingress || policy.spec?.ingressDeny)
  : (policy.spec?.policyTypes?.length ? policy.spec.policyTypes.includes('Ingress') : true));
const policySelector = policy => (policy.kind === 'CiliumNetworkPolicy' ? policy.spec?.endpointSelector : policy.spec?.podSelector);

export function prepareHissScrapeAccess(raw, scope, { runner = run, apply = false } = {}) {
  const target = installTarget(scope);
  verifyHissScrapeAccessArtifact(raw);
  const kubectl = (args, input) => String(runner('kubectl', ['--context', target.context, ...args], { capture: true, ...(input !== undefined ? { input } : {}) }) || '');
  const json = args => { const text = kubectl([...args, '-o', 'json', '--request-timeout=10s']); return text.trim() ? JSON.parse(text) : { items: [] }; };
  const parts = String(raw).split(/^---\n/m).filter(p => /^kind: NetworkPolicy$/m.test(p));
  const policies = [];
  for (const part of parts) {
    const desired = documentsOf(part)[0], namespace = desired.metadata.namespace, name = desired.metadata.name;
    const row = { namespace, name };
    if (!kubectl(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name', '--request-timeout=10s']).trim()) { policies.push({ ...row, state: 'NamespaceMissing' }); continue; }
    const pods = json(['-n', namespace, 'get', 'pods']).items || [];
    const targets = pods.filter(p => selects(desired.spec.podSelector, p.metadata?.labels));
    const subjects = targets.length ? targets.map(p => p.metadata.labels || {}) : [desired.spec.podSelector.matchLabels || {}];
    let cilium = [];
    try { cilium = json(['-n', namespace, 'get', 'ciliumnetworkpolicies.cilium.io', '--ignore-not-found']).items || []; } catch { cilium = []; }
    const live = (json(['-n', namespace, 'get', 'networkpolicies']).items || []);
    const ours = live.find(p => p.metadata?.name === name);
    const others = [...live.filter(p => p.metadata?.name !== name).map(p => ({ ...p, kind: 'NetworkPolicy' })), ...cilium.map(p => ({ ...p, kind: 'CiliumNetworkPolicy' }))];
    const isolated = others.some(p => isolatesIngress(p) && subjects.some(labels => selects(policySelector(p), labels)));
    let state;
    if (!isolated) state = ours ? 'IsolatesAlone' : 'NotNeeded';
    else if (!ours) state = 'NeedsPreparation';
    else state = JSON.stringify(ours.spec) === JSON.stringify(desired.spec) ? 'Present' : 'NeedsUpdate';
    if (apply && ['NeedsPreparation', 'NeedsUpdate'].includes(state)) {
      kubectl(['apply', '--server-side', '--field-manager=opensphere-setup-hiss', '-f', '-', '--request-timeout=20s'], part);
      state = 'Applied';
    } else if (apply && state === 'IsolatesAlone') {
      // Setup's own policy left as the only isolating one would deny the namespace's other ingress; it goes.
      kubectl(['-n', namespace, 'delete', 'networkpolicy', name, '--ignore-not-found', '--request-timeout=20s']);
      state = 'Removed';
    }
    policies.push({ ...row, state, isolatedBy: others.filter(p => isolatesIngress(p) && subjects.some(labels => selects(policySelector(p), labels))).map(p => `${p.kind}/${p.metadata.name}`).slice(0, 8) });
  }
  const pending = policies.some(p => ['NeedsPreparation', 'NeedsUpdate', 'IsolatesAlone'].includes(p.state));
  return { state: apply ? 'Applied' : pending ? 'NeedsPreparation' : 'Present', applied: apply, policies };
}
