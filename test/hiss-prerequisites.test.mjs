import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HISS_EXECUTION_PROFILE,
  createHissPrerequisiteClient,
  prepareHissPrerequisites,
} from '../src/hiss-prerequisites.mjs';

const raw = readFileSync(new URL('./fixtures/hiss-execution-profile.v1.proposed.json', import.meta.url), 'utf8');
const profile = JSON.parse(raw);
const scope = { context: 'docker-desktop', channel: 'edge', consoleUrl: 'https://localhost:1114' };
const key = r => `${r.apiVersion}/${r.kind}/${r.metadata.namespace || ''}/${r.metadata.name}`;
const copy = value => structuredClone(value);
const resource = (kind, name, namespace, extra = {}) => ({
  apiVersion: ['Namespace', 'ServiceAccount'].includes(kind) ? 'v1' : 'rbac.authorization.k8s.io/v1',
  kind, metadata: { name, ...(namespace ? { namespace } : {}) }, ...extra,
});
const external = [
  resource('Namespace', 'opensphere-console'),
  resource('Namespace', 'kube-system'),
  resource('ServiceAccount', 'opensphere-cluster-manager-runtime', 'opensphere-console'),
  resource('ClusterRole', 'system:auth-delegator', undefined, { rules: [] }),
  resource('Role', 'extension-apiserver-authentication-reader', 'kube-system', { rules: [] }),
];

// No Kubernetes, subprocess, network or credentials. The API keeps UIDs across
// reads and exposes faults at the same boundaries as a real get/create call.
function memoryClient(present = []) {
  let serial = 0;
  const state = new Map();
  const client = {
    state, reads: [], creates: [], beforeRead: null, beforeCreate: null,
    put(value) {
      const item = copy(value);
      item.metadata.uid ||= `uid-${++serial}`;
      item.metadata.resourceVersion ||= String(serial);
      state.set(key(item), item);
      return copy(item);
    },
    async read(requested) {
      this.reads.push(copy(requested));
      const replacement = await this.beforeRead?.(requested, this.reads.length);
      if (replacement !== undefined) return replacement;
      return requested.flatMap(r => state.has(key(r)) ? [copy(state.get(key(r)))] : []);
    },
    async create(value) {
      this.creates.push(copy(value));
      const replacement = await this.beforeCreate?.(value, this.creates.length);
      if (replacement !== undefined) return replacement;
      assert.equal(state.has(key(value)), false, 'create must never overwrite an existing object');
      return this.put(value);
    },
  };
  for (const item of [...external, ...present]) client.put(item);
  return client;
}
const prepare = (client, options = {}) => prepareHissPrerequisites(raw, scope, { client, ...options });
const prepareApply = (client, options = {}) => prepare(client, { apply: true, ...options });

test('HISS preparation rejects changed profile bytes and out-of-scope targets before I/O', async () => {
  const client = memoryClient();
  await assert.rejects(prepareHissPrerequisites(`${raw}\n`, scope, { client, apply: true }), { code: 'UNTRUSTED_PROFILE' });
  for (const changes of [
    { context: 'production' }, { channel: 'stable' }, { consoleUrl: 'https://example.test' },
    { consoleUrl: 'http://localhost:1114' }, { consoleUrl: 'https://localhost:1114/path' },
    { consoleUrl: 'https://user:password@localhost:1114' }, { consoleUrl: 'https://localhost:1114/?scope=edge' },
  ]) {
    await assert.rejects(prepareHissPrerequisites(raw, { ...scope, ...changes }, { client, apply: true }), { code: 'INVALID_SCOPE' });
  }
  assert.equal(client.reads.length, 0);
  assert.equal(client.creates.length, 0);
});

test('default preparation only inspects all 54 objects and five external dependencies', async () => {
  const client = memoryClient();
  const plan = await prepare(client);
  assert.equal(plan.status, 'NeedsPreparation');
  assert.equal(plan.resources.length, 54);
  assert.equal(plan.applied, false);
  assert.equal(plan.installationComplete, false);
  assert.equal(plan.resources.every(r => r.status === 'Missing'), true);
  assert.equal(client.reads.length, 1);
  assert.equal(client.reads[0].length, 59);
  assert.equal(client.creates.length, 0);
});

test('whole-profile policy conflict, Helm hook or missing dependency prevents all writes', async () => {
  const expected = profile.resources.find(r => r.kind === 'ClusterRole');
  for (const mutate of [
    r => { r.rules.push({ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }); },
    r => { r.metadata.annotations = { 'helm.sh/hook': 'pre-install' }; },
    r => { r.metadata.deletionTimestamp = '2026-09-07T00:00:00Z'; },
  ]) {
    const client = memoryClient([expected]);
    mutate(client.state.get(key(expected)));
    await assert.rejects(prepareApply(client), { code: 'PRECONDITION_FAILED' });
    assert.equal(client.creates.length, 0);
  }
  for (const dependency of external) {
    const client = memoryClient();
    client.state.delete(key(dependency));
    await assert.rejects(prepareApply(client), { code: 'PRECONDITION_FAILED' });
    assert.equal(client.creates.length, 0);
  }
});

test('forbidden, malformed, unexpected or duplicate observation never implies absence', async () => {
  for (const fault of [
    () => { throw new Error('403 with sensitive upstream detail'); },
    () => null, () => [null], () => [{ kind: 'Role', metadata: { name: 'broken' } }],
    (_requested, _call, client) => [client.put(resource('Namespace', 'unexpected'))],
    (_requested, _call, client) => [copy(client.state.get(key(external[0]))), copy(client.state.get(key(external[0])))],
  ]) {
    const client = memoryClient();
    client.beforeRead = (requested, call) => fault(requested, call, client);
    await assert.rejects(prepareApply(client), error => {
      assert.equal(error.code, 'OBSERVATION_UNAVAILABLE');
      assert.doesNotMatch(error.message, /sensitive upstream detail/);
      return true;
    });
    assert.equal(client.creates.length, 0);
  }
});

test('missing prerequisites create in dependency order and replay makes no writes', async () => {
  const client = memoryClient();
  client.beforeCreate = item => {
    if (item.metadata.namespace) assert.ok(client.state.has(key(resource('Namespace', item.metadata.namespace))));
    if (item.roleRef) {
      assert.ok(client.state.has(key(resource(item.roleRef.kind, item.roleRef.name,
        item.roleRef.kind === 'Role' ? item.metadata.namespace : undefined))));
      for (const subject of item.subjects || []) {
        if (subject.kind === 'ServiceAccount') assert.ok(client.state.has(key(resource('ServiceAccount', subject.name, subject.namespace))));
      }
    }
  };
  const first = await prepareApply(client);
  assert.equal(first.status, 'Prepared');
  assert.equal(first.installationComplete, false);
  assert.equal(first.created.length, 54);
  assert.equal(client.creates.length, 54);
  const before = copy([...client.state]);
  const second = await prepareApply(client);
  assert.equal(second.created.length, 0);
  assert.equal(second.preserved.length, 54);
  assert.equal(client.creates.length, 54);
  assert.deepEqual([...client.state], before);
});

test('existing namespaces retain PSA, labels and annotations; existing RBAC retains ownership', async () => {
  const namespace = copy(profile.resources.find(r => r.kind === 'Namespace'));
  namespace.metadata.labels = { 'pod-security.kubernetes.io/enforce': 'restricted', owner: 'operator' };
  namespace.metadata.annotations = { retained: 'true' };
  const role = copy(profile.resources.find(r => r.kind === 'ClusterRole'));
  role.metadata.labels = { 'app.kubernetes.io/managed-by': 'Helm' };
  role.metadata.annotations = { 'meta.helm.sh/release-name': 'existing' };
  const client = memoryClient([namespace, role]);
  const before = [copy(client.state.get(key(namespace))), copy(client.state.get(key(role)))];
  const result = await prepareApply(client);
  assert.equal(result.created.length, 52);
  assert.deepEqual([client.state.get(key(namespace)), client.state.get(key(role))], before);
  assert.equal(client.creates.some(r => key(r) === key(namespace) || key(r) === key(role)), false);
});

test('an existing object disappearing or changing UID after review is never replaced', async () => {
  for (const replace of [false, true]) {
    const client = memoryClient(profile.resources);
    client.beforeRead = (requested, call) => {
      if (call !== 2) return;
      const item = client.state.get(key(requested[0]));
      if (replace) item.metadata.uid = 'replacement-uid';
      else client.state.delete(key(item));
    };
    await assert.rejects(prepareApply(client), { code: 'PREPARATION_INCOMPLETE' });
    assert.equal(client.creates.length, 0);
  }
});

test('role drift before a binding stops without granting that binding or rolling back the prefix', async () => {
  const client = memoryClient();
  let changedBinding;
  client.beforeRead = requested => {
    const binding = requested[0];
    if (changedBinding || !binding?.roleRef || requested.length > 10) return;
    const role = resource(binding.roleRef.kind, binding.roleRef.name, binding.roleRef.kind === 'Role' ? binding.metadata.namespace : undefined);
    client.state.get(key(role)).rules = [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }];
    changedBinding = key(binding);
  };
  await assert.rejects(prepareApply(client), error => {
    assert.equal(error.code, 'PREPARATION_INCOMPLETE');
    assert.ok(error.evidence.created.length > 0);
    assert.equal(error.evidence.installationComplete, false);
    return true;
  });
  assert.ok(changedBinding);
  assert.equal(client.creates.some(r => key(r) === changedBinding), false);
  assert.equal(client.state.size, external.length + client.creates.length);
});

test('timeout after a persisted create observes the result once and does not issue a blind retry', async () => {
  const client = memoryClient();
  client.beforeCreate = (item, call) => {
    if (call === 4) { client.put(item); throw new Error('timeout after persistence'); }
  };
  const result = await prepareApply(client);
  assert.equal(result.status, 'Prepared');
  assert.equal(result.created.length, 53);
  assert.equal(result.observedAfterCreate.length, 1);
  assert.equal(client.creates.length, 54);
  assert.equal(new Set(client.creates.map(key)).size, 54);
  assert.equal((await prepareApply(client)).created.length, 0);
  assert.equal(client.creates.length, 54);
});

test('an unconfirmed create stops, preserves completed work, and the next invocation fills only missing objects', async () => {
  const client = memoryClient();
  client.beforeCreate = (_item, call) => { if (call === 4) throw new Error('connection lost before persistence'); };
  await assert.rejects(prepareApply(client), error => {
    assert.equal(error.code, 'PREPARATION_INCOMPLETE');
    assert.equal(error.evidence.created.length, 3);
    assert.equal(error.evidence.context, 'docker-desktop');
    return true;
  });
  const prefix = [...client.state.values()].map(copy);
  assert.equal(client.state.size, external.length + 3);
  client.beforeCreate = null;
  const retry = await prepareApply(client);
  assert.equal(retry.created.length, 51);
  assert.equal(retry.preserved.length, 3);
  for (const item of prefix) assert.deepEqual(client.state.get(key(item)), item);
});

test('ambiguous create followed by malformed observation returns bounded incomplete evidence', async () => {
  const client = memoryClient();
  client.beforeCreate = () => { throw new Error('sensitive upstream detail'); };
  client.beforeRead = (_requested, call) => call === 3 ? [null] : undefined;
  await assert.rejects(prepareApply(client), error => {
    assert.equal(error.code, 'PREPARATION_INCOMPLETE');
    assert.equal(error.evidence.created.length, 0);
    assert.doesNotMatch(error.message, /sensitive upstream detail|TypeError/);
    return true;
  });
  assert.equal(client.creates.length, 1);
});

test('final observation failure, policy drift or replacement never reports Prepared', async () => {
  for (const fault of ['unavailable', 'policy', 'replacement', 'external-replacement']) {
    const client = memoryClient();
    client.beforeRead = (requested, call) => {
      if (call === 1 || requested.length !== 59) return;
      if (fault === 'unavailable') throw new Error('API unavailable');
      if (fault === 'external-replacement') client.state.get(key(external[0])).metadata.uid = 'new-external-uid';
      else {
        const role = profile.resources.find(r => r.kind === 'ClusterRole');
        const actual = client.state.get(key(role));
        if (fault === 'policy') actual.rules = [];
        else actual.metadata.uid = 'new-role-uid';
      }
    };
    await assert.rejects(prepareApply(client), error => {
      assert.equal(error.code, 'PREPARATION_INCOMPLETE');
      assert.equal(error.evidence.created.length, 54);
      assert.equal(error.evidence.installationComplete, false);
      return true;
    });
    assert.equal(client.state.size, 59);
  }
});

test('wrong-identity create response is rejected even for a Namespace', async () => {
  const client = memoryClient();
  client.beforeCreate = () => client.put(resource('Namespace', 'wrong-namespace'));
  await assert.rejects(prepareApply(client), { code: 'PREPARATION_INCOMPLETE' });
  assert.equal(client.creates.length, 1);
});

test('progress callback failures cannot reverse confirmed writes or change the captured context', async () => {
  const client = memoryClient();
  const mutableScope = { ...scope };
  const result = await prepareHissPrerequisites(raw, mutableScope, {
    client, apply: true, onProgress() { mutableScope.context = 'production'; throw new Error('logger unavailable'); },
  });
  assert.equal(result.status, 'Prepared');
  assert.equal(result.context, 'docker-desktop');
  assert.equal(result.created.length, 54);
});

test('kubectl adapter pins context and only exposes bounded get/create', async () => {
  const calls = [];
  const mutableScope = { ...scope };
  const client = createHissPrerequisiteClient(mutableScope, (command, args, options) => {
    calls.push({ command, args, options });
    const input = JSON.parse(options.input);
    return JSON.stringify(args.includes('get') ? { apiVersion: 'v1', kind: 'List', items: [] } : input);
  });
  mutableScope.context = 'production';
  assert.deepEqual(await client.read(profile.resources), []);
  await client.create(profile.resources[0]);
  assert.deepEqual(Object.keys(client).sort(), ['create', 'read']);
  for (const call of calls) {
    assert.equal(call.command, 'kubectl');
    assert.deepEqual(call.args.slice(0, 2), ['--context', 'docker-desktop']);
    assert.ok(call.args.includes('--request-timeout=10s'));
    assert.equal(call.options.spawn.timeout, 60000);
    assert.equal(call.options.spawn.maxBuffer, 8 * 1024 * 1024);
    assert.equal(call.options.capture, true);
    assert.equal(call.args.some(arg => ['apply', 'patch', 'delete', 'replace'].includes(arg)), false);
  }
  assert.equal(HISS_EXECUTION_PROFILE.sha256.length, 64);
});
