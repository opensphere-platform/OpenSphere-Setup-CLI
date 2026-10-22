import test from 'node:test';
import assert from 'node:assert/strict';
import artifact from '../src/hiss-chart-execution-fence-artifact.json' with { type: 'json' };
import { HISS_CHART_EXECUTION_FENCE, classifyGrants, cmCreateGrants, fenceMatches, prepareHissChartExecutionFence, verifyHissChartExecutionFence } from '../src/hiss-chart-execution-fence.mjs';

const scope = { context: 'rke2', channel: 'edge', consoleUrl: 'https://console.example.test' };
const docs = () => verifyHissChartExecutionFence(artifact.yaml);
const live = (d, extra = {}) => ({ ...structuredClone(d), metadata: { ...d.metadata, uid: 'u', generation: 1 }, status: { observedGeneration: 1, typeChecking: {} }, ...extra });

test('the pinned bytes are the approved fence: policies, bindings and Pod Security labels only', () => {
  const all = docs();
  assert.equal(all.length, HISS_CHART_EXECUTION_FENCE.resourceCount);
  assert.match(HISS_CHART_EXECUTION_FENCE.sourceRevision, /^[a-f0-9]{40}$/);
  assert.throws(() => verifyHissChartExecutionFence(`${artifact.yaml}\n`), /differ from the approved contract/);
  const bindings = all.filter((d) => d.kind === 'ValidatingAdmissionPolicyBinding');
  assert.equal(bindings.length, 14);
  for (const b of bindings) assert.deepEqual(b.spec.validationActions, ['Warn', 'Audit'], 'F1 is Warn; Deny is a later revision');
  for (const p of all.filter((d) => d.kind === 'ValidatingAdmissionPolicy')) assert.equal(p.spec.failurePolicy, 'Fail');
});

test('a live policy or binding that is narrowed or weakened does not count as prepared', () => {
  const policy = docs().find((d) => d.kind === 'ValidatingAdmissionPolicy');
  const binding = docs().find((d) => d.kind === 'ValidatingAdmissionPolicyBinding');
  assert.equal(fenceMatches(policy, live(policy)), true);
  const narrowed = live(policy); narrowed.spec.matchConditions = [...(narrowed.spec.matchConditions || []), { name: 'x', expression: 'false' }];
  assert.equal(fenceMatches(policy, narrowed), false);
  const excluded = live(policy); excluded.spec.matchConstraints.excludeResourceRules = [{ apiGroups: [''], apiVersions: ['*'], operations: ['CREATE'], resources: ['pods'] }];
  assert.equal(fenceMatches(policy, excluded), false);
  const changed = live(policy); changed.spec.validations[0].expression = 'true';
  assert.equal(fenceMatches(policy, changed), false);
  assert.equal(fenceMatches(binding, live(binding)), true);
  const selected = live(binding); selected.spec.matchResources = { namespaceSelector: { matchLabels: { x: 'y' } } };
  assert.equal(fenceMatches(binding, selected), false);
  const deny = live(binding); deny.spec.validationActions = ['Deny'];
  assert.equal(fenceMatches(binding, deny), false, 'a different revision of the bindings is NeedsUpdate');
  assert.equal(fenceMatches(policy, { ...live(policy), metadata: { ...live(policy).metadata, deletionTimestamp: 'now' } }), false);
});

function fixture({ warnings = false, missingNamespace = false } = {}) {
  const state = new Map(), calls = [];
  const id = (o) => `${o.kind}/${o.metadata?.namespace || ''}/${o.metadata?.name}`;
  for (const n of ['cert-manager', 'metrics-server', 'ingress-nginx']) state.set(`Namespace//${n}`, { kind: 'Namespace', apiVersion: 'v1', metadata: { name: n, uid: n } });
  const runner = (_exe, args, options) => {
    calls.push(args.join(' '));
    if (args.includes('namespace') && args.includes('--ignore-not-found')) return missingNamespace && args.includes('ingress-nginx') ? '' : 'namespace/x\n';
    const input = options?.input ? JSON.parse(options.input) : null;
    if (args.includes('apply')) {
      assert.ok(!args.includes('--force-conflicts'));
      for (const o of input.items) { const prev = state.get(id(o)); state.set(id(o), { ...structuredClone(o), metadata: { ...(prev?.metadata || {}), ...o.metadata, labels: { ...(prev?.metadata?.labels || {}), ...(o.metadata.labels || {}) }, uid: 'u', generation: 1 },
        status: { observedGeneration: 1, typeChecking: warnings ? { expressionWarnings: [{ fieldRef: 'x', warning: 'w' }] } : {} } }); }
      return '';
    }
    if (args.includes('get')) return input.items.filter((o) => state.has(id(o))).map((o) => JSON.stringify(state.get(id(o)))).join('\n');
    throw Error(`unexpected ${args.join(' ')}`);
  };
  return { runner, calls, state };
}

test('apply order: policies type-checked first, then bindings, then labels; a replay writes nothing', () => {
  const f = fixture();
  assert.equal(prepareHissChartExecutionFence(artifact.yaml, scope, { runner: f.runner }).state, 'NeedsPreparation');
  assert.equal(f.calls.filter((c) => c.includes('apply')).length, 0);
  const r = prepareHissChartExecutionFence(artifact.yaml, scope, { runner: f.runner, apply: true, sleep: () => {} });
  assert.equal(r.state, 'Applied');
  const applies = f.calls.filter((c) => c.includes('apply'));
  assert.equal(applies.length, 3);
  for (const a of applies) assert.match(a, /--server-side --field-manager=opensphere-setup-hiss/);
  const before = f.calls.length;
  assert.equal(prepareHissChartExecutionFence(artifact.yaml, scope, { runner: f.runner, apply: true }).state, 'Present');
  assert.equal(f.calls.slice(before).filter((c) => c.includes('apply')).length, 0);
});

test('a policy with type-check warnings stops before any binding exists', () => {
  const f = fixture({ warnings: true });
  assert.throws(() => prepareHissChartExecutionFence(artifact.yaml, scope, { runner: f.runner, apply: true, sleep: () => {}, attempts: 2 }), /no binding was applied/);
  assert.equal([...f.state.keys()].filter((k) => k.startsWith('ValidatingAdmissionPolicyBinding/')).length, 0);
});

test('a missing labelled namespace blocks without writing', () => {
  const f = fixture({ missingNamespace: true });
  const r = prepareHissChartExecutionFence(artifact.yaml, scope, { runner: f.runner, apply: true });
  assert.equal(r.state, 'Blocked');
  assert.deepEqual(r.missing, ['ingress-nginx']);
  assert.equal(f.calls.filter((c) => c.includes('apply')).length, 0);
});

test('F-6 grants: Pod-producing scopes, known kinds, and anything unknown or wildcard', () => {
  const sa = { kind: 'ServiceAccount', name: 'opensphere-cluster-manager-runtime', namespace: 'opensphere-console' };
  const grants = cmCreateGrants({
    clusterRoleBindings: [{ roleRef: { kind: 'ClusterRole', name: 'c' }, subjects: [sa] }, { roleRef: { kind: 'ClusterRole', name: 'other' }, subjects: [{ kind: 'ServiceAccount', name: 'x', namespace: 'y' }] }],
    roleBindings: [{ metadata: { namespace: 'monitoring' }, roleRef: { kind: 'Role', name: 'r' }, subjects: [sa] },
      { metadata: { namespace: 'team' }, roleRef: { kind: 'Role', name: 't' }, subjects: [{ kind: 'Group', name: 'system:serviceaccounts' }] }],
    clusterRoles: [{ metadata: { name: 'c' }, rules: [{ apiGroups: ['admissionregistration.k8s.io'], resources: ['validatingwebhookconfigurations'], verbs: ['create'] }] },
      { metadata: { name: 'other' }, rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] }],
    roles: [{ metadata: { name: 'r', namespace: 'monitoring' }, rules: [{ apiGroups: ['apps'], resources: ['daemonsets'], verbs: ['create'] }, { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'create'] }] },
      { metadata: { name: 't', namespace: 'team' }, rules: [{ apiGroups: ['example.io'], resources: ['widgets'], verbs: ['*'] }] }],
  });
  const c = classifyGrants(grants);
  assert.deepEqual(c.podScopes, ['monitoring']);
  assert.deepEqual(c.unknown, ['team:example.io/widgets']);
  assert.deepEqual(classifyGrants([{ scope: '*', group: '*', resource: 'pods' }]).unknown, ['*:*/pods']);
});
