import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import artifact from '../src/hiss-operator-stackgres-artifact.json' with { type: 'json' };
import { HISS_OPERATOR_STACKGRES, prepareHissOperatorStackgres, verifyHissOperatorStackgresArtifact } from '../src/hiss-prerequisites.mjs';

// PostgreSQL Provider P2: the HISS StackGres operator prerequisites (hiss-operator-stackgres-v1). The bytes are Cluster
// Manager deploy/hiss-operator-stackgres.yaml; this pins them and the apply, read-back, type-check and probe sequence.
const scope = { context: 'rke2', channel: 'edge', consoleUrl: 'https://console.example.test' };
const documents = () => parseAllDocuments(artifact.yaml).map((d) => d.toJSON()).filter(Boolean);
const id = (o) => `${o.kind}/${o.metadata?.namespace || ''}/${o.metadata?.name}`;
const GUARDS = ['opensphere-pfss-pg-writers', 'opensphere-pfss-pg-cluster-scope', 'opensphere-pfss-pg-foundation-names', 'opensphere-pfss-pg-sgclusters', 'opensphere-pfss-pg-cluster-objects', 'opensphere-pfss-pg-cluster-services',
  'opensphere-hiss-stackgres-operator-workload', 'opensphere-hiss-stackgres-operator-extension'];

function cluster({ warnings = false, probe = 'denied', drift = null, narrow = false } = {}) {
  const state = new Map(), calls = [];
  let serial = 0;
  const runner = (exe, args, options = {}) => {
    assert.equal(exe, 'kubectl');
    assert.deepEqual(args.slice(0, 2), ['--context', 'rke2']);
    const verb = args[2];
    calls.push(args.slice(2).filter((a) => !a.startsWith('--request-timeout')).join(' '));
    if (verb === 'get' && args[3] === '-f') {
      const asked = JSON.parse(options.input).items;
      return JSON.stringify({ kind: 'List', items: asked.filter((d) => state.has(id(d))).map((d) => state.get(id(d))) });
    }
    if (verb === 'apply') {
      assert.ok(args.includes('--server-side') && args.includes('--field-manager=opensphere-setup-hiss') && !args.includes('--force-conflicts'));
      const items = JSON.parse(options.input).items;
      calls.push('applied ' + [...new Set(items.map((d) => d.kind))].join(','));
      for (const d of items) {
        const live = structuredClone(d);
        live.metadata.uid = state.get(id(d))?.metadata.uid || `uid-${++serial}`;
        live.metadata.generation = 1;
        if (d.kind === 'ValidatingAdmissionPolicy') live.status = { observedGeneration: 1, typeChecking: warnings ? { expressionWarnings: [{ warning: 'x' }] } : {} };
        if (drift && id(d) === drift) live.rules = [];
        if (narrow && d.kind === 'ValidatingAdmissionPolicyBinding') live.spec.matchResources = { namespaceSelector: { matchLabels: { none: 'x' } } };
        state.set(id(d), live);
      }
      return '';
    }
    if (verb === 'get' && args[3] === 'validatingadmissionpolicy') return JSON.stringify(state.get(`ValidatingAdmissionPolicy//${args[4]}`));
    if (verb === 'create') {
      assert.ok(args.includes('--dry-run=server'));
      assert.deepEqual(args.slice(args.indexOf('--as'), args.indexOf('--as') + 2), ['--as', 'system:serviceaccount:opensphere-foundation:foundation-control-plane']);
      assert.equal(JSON.parse(options.input).metadata.name, 'setup-admission-probe');
      if (probe === 'admitted') return 'secret/setup-admission-probe';
      throw Object.assign(new Error('failed'), { stderr: probe === 'denied'
        ? "secrets \"setup-admission-probe\" is forbidden: ValidatingAdmissionPolicy 'opensphere-pfss-pg-foundation-names' with binding 'opensphere-pfss-pg-foundation-names' denied request"
        : 'error: impersonation refused' });
    }
    throw new Error(`unexpected kubectl ${args.join(' ')}`);
  };
  return { state, calls, runner };
}
const quick = { sleep: () => {}, attempts: 6 };

test('the artifact is pinned: 49 objects from Cluster Manager deploy/hiss-operator-stackgres.yaml', () => {
  assert.equal(createHash('sha256').update(artifact.yaml).digest('hex'), HISS_OPERATOR_STACKGRES.sha256);
  assert.equal(verifyHissOperatorStackgresArtifact(artifact.yaml).length, 49);
  assert.throws(() => verifyHissOperatorStackgresArtifact(artifact.yaml.replace('verbs: [get, list]', 'verbs: [get, list, create]')), { code: 'UNTRUSTED_PROFILE' });
  assert.match(HISS_OPERATOR_STACKGRES.sourceRevision, /^[a-f0-9]{40}$/);
  const kinds = documents().reduce((m, d) => ({ ...m, [d.kind]: (m[d.kind] || 0) + 1 }), {});
  assert.deepEqual(kinds, { Namespace: 3, NetworkPolicy: 2, ClusterRole: 2, ClusterRoleBinding: 2, Role: 12, RoleBinding: 12, ValidatingAdmissionPolicy: 8, ValidatingAdmissionPolicyBinding: 8 });
  // Nothing here lets any account escalate, bind or impersonate, and the operator's ClusterRole only reads.
  for (const d of documents().filter((x) => x.rules)) for (const r of d.rules) assert.ok(r.verbs.every((v) => !['*', 'escalate', 'bind', 'impersonate'].includes(v)));
  assert.ok(documents().find((d) => d.kind === 'ClusterRole' && d.metadata.name === 'opensphere-stackgres-operator').rules.every((r) => r.verbs.every((v) => ['get', 'list'].includes(v))));
});

test('plan only reads; apply creates, reads back, waits for type checking and proves the Secret name guard', () => {
  const c = cluster();
  assert.deepEqual(prepareHissOperatorStackgres(artifact.yaml, scope, { runner: c.runner, ...quick }),
    { state: 'NeedsPreparation', applied: false, resourceCount: 49, missing: 49, differs: 0 });
  assert.deepEqual(c.calls, ['get -f - --ignore-not-found -o json']);
  const applied = prepareHissOperatorStackgres(artifact.yaml, scope, { runner: c.runner, apply: true, ...quick });
  assert.deepEqual(applied, { state: 'Applied', applied: true, resourceCount: 49, created: 49, updated: 0, guardProbe: 'denied' });
  // The guards (and namespaces) are applied and type-checked before any RBAC or NetworkPolicy exists.
  assert.deepEqual(c.calls.filter((x) => x.startsWith('applied ')), ['applied Namespace,ValidatingAdmissionPolicy,ValidatingAdmissionPolicyBinding', 'applied NetworkPolicy,ClusterRole,ClusterRoleBinding,Role,RoleBinding']);
  assert.ok(c.calls.findIndex((x) => x.startsWith('get validatingadmissionpolicy')) < c.calls.findIndex((x) => x.startsWith('applied NetworkPolicy')));
  assert.equal(c.calls.filter((x) => x.startsWith('create -f - --dry-run=server')).length, 5);
  assert.deepEqual(c.calls.filter((x) => x.startsWith('get validatingadmissionpolicy')).map((x) => x.split(' ')[2]), GUARDS);
  assert.equal(prepareHissOperatorStackgres(artifact.yaml, scope, { runner: c.runner, ...quick }).state, 'Present');
});

test('a guard with type-check warnings, a narrowed binding or an unproven Secret guard stops before the operator can be installed', () => {
  const warned = cluster({ warnings: true });
  assert.throws(() => prepareHissOperatorStackgres(artifact.yaml, scope, { runner: warned.runner, apply: true, ...quick }),
    { code: 'PREPARATION_INCOMPLETE', message: /type-checked/ });
  assert.ok(![...warned.state.keys()].some((x) => /^(Role|RoleBinding|ClusterRole|ClusterRoleBinding)\//.test(x)), 'no RBAC exists when the guards are not type-checked');
  assert.throws(() => prepareHissOperatorStackgres(artifact.yaml, scope, { runner: cluster({ narrow: true }).runner, apply: true, ...quick }),
    { code: 'PREPARATION_INCOMPLETE', message: /namespaces and write guards/ });
  for (const probe of ['admitted', 'unavailable']) {
    assert.throws(() => prepareHissOperatorStackgres(artifact.yaml, scope, { runner: cluster({ probe }).runner, apply: true, ...quick }),
      { code: 'PREPARATION_INCOMPLETE', message: new RegExp(probe) });
  }
});

test('changed live RBAC is reported as NeedsUpdate and a read-back that differs is never reported Applied', () => {
  const c = cluster({ drift: 'Role/opensphere-pfss-pg-shared/stackgres-operator' });
  assert.throws(() => prepareHissOperatorStackgres(artifact.yaml, scope, { runner: c.runner, apply: true, ...quick }), { code: 'PREPARATION_INCOMPLETE', message: /read back/ });
  assert.equal(prepareHissOperatorStackgres(artifact.yaml, scope, { runner: c.runner, ...quick }).state, 'NeedsUpdate');
});

test('the explicit target is required before any kubectl call', () => {
  assert.throws(() => prepareHissOperatorStackgres(artifact.yaml, { ...scope, context: '' }, { runner: () => assert.fail('unexpected I/O') }));
});

test('D-F8: the opensphere-stackgres fence is part of the pinned prerequisites, binds every requester and starts as Warn and Audit', () => {
  const fences = ['opensphere-hiss-stackgres-operator-workload', 'opensphere-hiss-stackgres-operator-extension'];
  for (const name of fences) {
    const policy = documents().find((d) => d.kind === 'ValidatingAdmissionPolicy' && d.metadata.name === name);
    const binding = documents().find((d) => d.kind === 'ValidatingAdmissionPolicyBinding' && d.metadata.name === name);
    assert.equal(policy.spec.failurePolicy, 'Fail', name);
    assert.deepEqual(binding.spec, { policyName: name, validationActions: ['Warn', 'Audit'] }, name);
    assert.ok(!(policy.spec.matchConditions || []).some((c) => /userInfo/.test(c.expression)), `${name} has no identity exception`);
  }
  // Setup #45's F-6 coverage table counts this policy for opensphere-stackgres: it must match Deployments (and Pods) there.
  const workload = documents().find((d) => d.kind === 'ValidatingAdmissionPolicy' && d.metadata.name === fences[0]).spec.matchConstraints;
  assert.deepEqual(workload.namespaceSelector, { matchLabels: { 'kubernetes.io/metadata.name': 'opensphere-stackgres' } });
  const resources = workload.resourceRules.flatMap((r) => r.resources);
  for (const kind of ['pods', 'deployments', 'replicasets', 'jobs', 'secrets', 'serviceaccounts']) assert.ok(resources.includes(kind), kind);
  // The six write guards stay Deny.
  for (const b of documents().filter((d) => d.kind === 'ValidatingAdmissionPolicyBinding' && !fences.includes(d.metadata.name))) assert.deepEqual(b.spec.validationActions, ['Deny']);
});
