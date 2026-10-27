import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CUTOVER_STEPS, WRITE_COUNTERS_SQL, catalogLines, counterChanges, createCutover, ensurePrivateEvidenceDirectory, parseWriteCounters,
} from '../src/console-db-cutover.mjs';
import {
  CLUSTER_NAME, CONSOLE_DB_SERVICE, CUTOVER_CONFIGMAP, CUTOVER_LOCK, DATA_NAMESPACE, LEGACY_SELECTOR, PRIMARY_SELECTOR,
  classifyConsoleDataLayout, renderConsoleDbCluster,
} from '../src/console-db-cnpg.mjs';
import { liveFenceMode } from '../src/console-db-prepare.mjs';
import { FINGERPRINT_SQL } from '../src/console-db-parity.mjs';

// Review findings 1-3 and 6-9 of Setup PR #64 (2026-10-27), against a small stateful model of the cluster: the
// Service and the endpoints it really selects, the StatefulSet and CNPG Pods, hibernation that can stall, the writer
// Deployments, the checkpoint ConfigMap and the run-lock Lease with resourceVersions, and the source database's
// sessions and write counters. The model answers kubectl the way the API server would; the tests assert outcomes
// (what the Service selects, which writers run, what the checkpoint says), not the calls the code happens to make.
const UID = '11111111-2222-3333-4444-555555555555';
const NS = DATA_NAMESPACE;
const LEGACY_POD = 'opensphere-supabase-postgres-0';
const COUNTERS = 'relfiles|aaa\nrestart|2026-10-27 01:00:00+00\nsequences|bbb\nstatsreset|never\ntables|12 tables, 100 tuples written';
const CATALOG = 'member|anon>authenticator|admin=false\nrole|authenticator|super=false,pw=aaaa\nsetting|*|authenticator|statement_timeout=8s';
const ORIGINAL_PORTS = [{ name: 'postgres', port: 5432, protocol: 'TCP', targetPort: 'postgres' }];
const WRITER = { namespace: 'opensphere-console', name: 'opensphere-console-api', role: 'opensphere_console_api_runtime', replicas: 2, selector: { app: 'opensphere-console-api' } };
const labelsOf = (selector) => Object.fromEntries(selector.split(',').map((x) => x.split('=')));
const matches = (labels, selector) => Object.entries(selector).every(([k, v]) => labels[k] === v);

function world(over = {}) {
  const w = {
    now: 1_800_000_000_000, rv: 10, checkpoint: null, lease: null,
    service: { uid: 'svc-uid', selector: { ...LEGACY_SELECTOR }, ports: structuredClone(ORIGINAL_PORTS) },
    sts: 1, cnpg: [`${CLUSTER_NAME}-1`, `${CLUSTER_NAME}-2`, `${CLUSTER_NAME}-3`], primary: `${CLUSTER_NAME}-1`,
    cluster: { exists: true, hibernation: false, readyInstances: 3 }, stallHibernation: false,
    deployments: { 'opensphere-console/opensphere-console-api': 0 }, importPods: [], importLog: '',
    counters: COUNTERS, catalog: CATALOG, sessions: [], onCall: null, ledger: '137|0151 sha256:781b', podFreeKb: 50 * 1024 * 1024, dbBytes: 450 * 1024 ** 2,
    dumpBody: 'DUMP-BYTES', dumpSha: null, rolloutStsFails: false, calls: [], onSql: null, onSleep: null, ...over,
  };
  w.dumpSha ??= createHash('sha256').update(w.dumpBody).digest('hex');
  const pods = () => [
    ...(w.sts > 0 ? [{ name: LEGACY_POD, ip: '10.0.0.1', labels: { ...LEGACY_SELECTOR, 'statefulset.kubernetes.io/pod-name': LEGACY_POD } }] : []),
    ...w.cnpg.map((name) => ({ name, ip: `10.0.1.${name.slice(-1)}`, labels: { ...LEGACY_SELECTOR, 'cnpg.io/cluster': CLUSTER_NAME, 'cnpg.io/podRole': 'instance',
      'cnpg.io/instanceRole': name === w.primary ? 'primary' : 'replica' } })),
  ];
  const podJson = (p) => ({ metadata: { name: p.name, labels: p.labels }, status: { phase: 'Running', podIP: p.ip, conditions: [{ type: 'Ready', status: 'True' }] } });
  const clusterJson = () => (w.cluster.exists ? { metadata: { name: CLUSTER_NAME, annotations: w.cluster.hibernation ? { 'cnpg.io/hibernation': 'on' } : {} },
    spec: renderConsoleDbCluster({ storageClass: 'longhorn' }).spec,
    status: { readyInstances: w.cluster.readyInstances, currentPrimary: w.primary, targetPrimary: w.primary } } : null);
  const store = (slot, verb, input) => {
    const doc = JSON.parse(input);
    if (verb === 'create' && w[slot]) throw Object.assign(new Error('AlreadyExists'), { stderr: 'AlreadyExists' });
    if (verb === 'replace' && (!w[slot] || doc.metadata.resourceVersion !== w[slot].metadata.resourceVersion)) throw Object.assign(new Error('Conflict'), { stderr: 'the object has been modified' });
    w.rv += 1;
    w[slot] = { ...doc, metadata: { ...doc.metadata, resourceVersion: String(w.rv) } };
    return JSON.stringify(w[slot]);
  };
  const sql = (input) => {
    w.onSql?.(w, input);
    if (input === FINGERPRINT_SQL) return `BEGIN\n${w.catalog}\nROLLBACK`;
    if (input === WRITE_COUNTERS_SQL) return `BEGIN\n${typeof w.counters === 'function' ? w.counters() : w.counters}\nROLLBACK`;
    if (/pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid/.test(input)) return w.sessions.join('\n');
    if (/applied_sequence DESC LIMIT 1\) FROM console_migration/.test(input)) return w.ledger;
    if (/pg_stat_replication/.test(input)) return '1';
    throw new Error(`unexpected SQL ${input.slice(0, 80)}`);
  };
  w.runner = (bin, args, options = {}) => {
    assert.equal(bin, 'kubectl');
    assert.deepEqual(args.slice(0, 2), ['--context', 'lab']);
    let a = args.slice(2);
    w.calls.push(a.join(' '));
    w.onCall?.(w, a);
    let namespace = null;
    if (a[0] === '-n') { namespace = a[1]; a = a.slice(2); }
    const [verb, kind, name] = a;
    const label = a.includes('-l') ? labelsOf(a[a.indexOf('-l') + 1]) : null;
    if (verb === 'get' && kind === 'namespace' && name === 'kube-system') return UID;
    if (verb === 'get' && kind === 'configmap' && name === CUTOVER_CONFIGMAP) return w.checkpoint ? JSON.stringify(w.checkpoint) : '';
    if (verb === 'get' && kind === 'lease' && name === CUTOVER_LOCK) return w.lease ? JSON.stringify(w.lease) : '';
    if (verb === 'create' || verb === 'replace') {
      const doc = JSON.parse(options.input);
      return store(doc.kind === 'Lease' ? 'lease' : 'checkpoint', verb, options.input);
    }
    if (verb === 'get' && kind === 'service' && name === CONSOLE_DB_SERVICE) return JSON.stringify({ metadata: { uid: w.service.uid }, spec: { selector: w.service.selector, ports: w.service.ports } });
    if (verb === 'get' && kind === 'endpointslices') {
      const ready = pods().filter((p) => matches(p.labels, w.service.selector));
      return JSON.stringify({ items: [{ endpoints: ready.map((p) => ({ addresses: [p.ip], conditions: { ready: true } })) }] });
    }
    if (verb === 'get' && kind === 'pods' && label?.['cnpg.io/jobRole'] === 'import') return JSON.stringify({ items: w.importPods });
    if (verb === 'get' && kind === 'pods' && label?.['cnpg.io/cluster']) return JSON.stringify({ items: pods().filter((p) => matches(p.labels, label)).map(podJson) });
    if (verb === 'get' && kind === 'pods' && label?.app) return JSON.stringify({ items: (w.deployments[`${namespace}/${label.app}`] ?? 0) > 0 ? [{ metadata: { name: `${label.app}-x` } }] : [] });
    if (verb === 'get' && kind === 'pod') { const p = pods().find((x) => x.name === name); return p ? JSON.stringify(podJson(p)) : ''; }
    if (verb === 'get' && kind === 'clusters.postgresql.cnpg.io') return w.cluster.exists ? JSON.stringify(clusterJson()) : '';
    if (verb === 'get' && kind === 'deployment') {
      const replicas = w.deployments[`${namespace}/${name}`];
      return replicas === undefined ? '' : JSON.stringify({ spec: { replicas, selector: { matchLabels: { app: name } } } });
    }
    if (verb === 'get' && kind === 'pv') return JSON.stringify({ metadata: { name, uid: 'pv-uid' }, spec: { persistentVolumeReclaimPolicy: 'Retain' } });
    if (verb === 'get' && kind === 'secret') return 'cGFzcw==';
    if (verb === 'patch' && kind === 'service') {
      for (const op of JSON.parse(a[a.indexOf('-p') + 1])) {
        if (op.op === 'test' && op.path === '/metadata/uid') assert.equal(op.value, w.service.uid);
        if (op.op === 'test' && op.path === '/spec/selector') assert.deepEqual(op.value, w.service.selector);
        if (op.op === 'replace') w.service[op.path.split('/')[2]] = structuredClone(op.value);
      }
      return '';
    }
    if (verb === 'scale' && kind === 'statefulset') { w.sts = Number(a.at(-1).split('=')[1]); return ''; }
    if (verb === 'scale' && kind === 'deployment') { w.deployments[`${namespace}/${name}`] = Number(a.at(-1).split('=')[1]); return ''; }
    if (verb === 'rollout' && name.startsWith('statefulset/')) { if (w.rolloutStsFails) throw new Error('rollout timed out'); return ''; }
    if (verb === 'rollout') return '';
    if (verb === 'annotate') { w.cluster.hibernation = true; if (!w.stallHibernation) { w.cnpg = []; w.cluster.readyInstances = 0; } return ''; }
    if (verb === 'delete' && kind === 'pods') { assert.equal(a[a.indexOf('-l') + 1], `cnpg.io/cluster=${CLUSTER_NAME}`, 'every Pod of the Cluster'); w.cnpg = []; w.importPods = []; return ''; }
    if (verb === 'delete') return '';
    if (verb === 'apply' || (verb === 'patch' && kind === 'pv')) return '';
    if (verb === 'logs') return w.importLog;
    if (verb === 'exec') {
      const pod = a.find((x, i) => i > 0 && (x === LEGACY_POD || w.cnpg.includes(x)));
      if (!pod || (pod === LEGACY_POD && w.sts === 0)) throw new Error(`pod ${a[1]} not found`);
      const tail = a.slice(a.indexOf('--') + 1);
      if (tail[0] === 'rm') return '';
      if (tail[0] === 'psql') return sql(options.input);
      const script = tail.at(-1);
      if (options.input !== undefined) return sql(options.input);
      if (script.includes('df -Pk')) return `${w.podFreeKb}\n${w.dbBytes}`;
      if (script.includes('pg_dump ')) return `${w.dumpSha}  /var/lib/postgresql/data/x.dump\n${w.dumpBody.length}`;
      throw new Error(`unexpected exec ${tail.join(' ').slice(0, 80)}`);
    }
    throw new Error(`unexpected kubectl ${args.slice(2).join(' ')}`);
  };
  return w;
}

const steps = (until) => Object.fromEntries(CUTOVER_STEPS.slice(0, CUTOVER_STEPS.indexOf(until) + 1).map((s) => [s, { at: 'x', ms: 1, ...(s === 'freeze' ? { writeCounters: COUNTERS } : {}),
  ...(s === 'fingerprint' ? { ledger: '137', head: '0151 sha256:781b' } : {}) }]));
const checkpoint = (w, over = {}) => {
  w.rv += 1;
  w.checkpoint = { metadata: { name: CUTOVER_CONFIGMAP, resourceVersion: String(w.rv) }, data: { 'state.json': JSON.stringify({ schema: 'opensphere.console-db-cutover/v1',
    attemptId: '20261027-abc', state: 'InProgress', clusterUid: UID, storageClass: 'longhorn', source: { pv: 'pv-1' }, writers: [WRITER], steps: {}, history: [], ...over }) } };
};
const stateOf = (w) => JSON.parse(w.checkpoint.data['state.json']);
const withDir = async (fn) => { const dir = mkdtempSync(join(tmpdir(), 'r2c2-safety-')); try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const cutover = (w, dir, over = {}) => createCutover({ context: 'lab', clusterUid: UID, evidenceDir: dir, runner: w.runner, log: () => {},
  now: () => w.now, sleep: (ms) => { w.now += ms; w.onSleep?.(w); }, privateDirectory: () => ({}), freeBytes: () => 100 * 1024 ** 3,
  holder: 'me/1', ...over });
// The source as it is after switch: the Service on the primary, the StatefulSet at 0, the original recorded.
const switched = (over = {}) => {
  const w = world({ sts: 0, ...over });
  w.service.selector = { ...PRIMARY_SELECTOR };
  w.service.ports = [{ name: 'postgres', port: 5432, protocol: 'TCP', targetPort: 5432 }];
  checkpoint(w, { state: 'Switched', steps: steps('switch'), service: { uid: 'svc-uid', selector: { ...LEGACY_SELECTOR }, ports: structuredClone(ORIGINAL_PORTS) } });
  return w;
};

test('finding 1: a rollback is recorded before it acts; apply refuses an attempt that is rolling back; the rollback finishes on a re-run', async () => withDir(async (dir) => {
  const w = switched({ rolloutStsFails: true });
  assert.throws(() => cutover(w, dir).rollback(), /rollout timed out/);
  assert.equal(stateOf(w).state, 'RollingBack');
  assert.equal(stateOf(w).rollingBackFrom, 'Switched');
  assert.equal(classifyConsoleDataLayout({ spec: { selector: w.service.selector, ports: w.service.ports } }, w.checkpoint).layout, 'cutover', 'Setup stays blocked');
  await assert.rejects(cutover(w, dir).apply(), /rolling back; run --rollback again/);
  assert.equal(w.deployments['opensphere-console/opensphere-console-api'], 0, 'no writer was started by the refused apply');
  w.rolloutStsFails = false;
  const done = cutover(w, dir).rollback();
  assert.equal(done.state.state, 'RolledBack');
  assert.deepEqual(w.service.selector, LEGACY_SELECTOR);
  assert.deepEqual(w.service.ports, ORIGINAL_PORTS, 'finding 6: the recorded ports come back exactly');
  assert.equal(w.deployments['opensphere-console/opensphere-console-api'], 2);
  assert.equal(w.lease.spec.holderIdentity, undefined, 'the lock is released');
}));

test('finding 1: reopen starts the writers only when the Service selects the healthy CNPG primary alone', async () => withDir(async (dir) => {
  const broken = [
    ['the Service was put back on the StatefulSet', (w) => { w.service.selector = { ...LEGACY_SELECTOR }; }],
    ['the Cluster is hibernated', (w) => { w.cluster.hibernation = true; }],
    ['an instance is not ready', (w) => { w.cluster.readyInstances = 2; }],
    ['the StatefulSet Pod runs again', (w) => { w.sts = 1; }],
    ['the targetPort is not 5432', (w) => { w.service.ports = structuredClone(ORIGINAL_PORTS); }],
  ];
  for (const [what, breakIt] of broken) {
    const w = switched();
    breakIt(w);
    await assert.rejects(cutover(w, dir).apply({ until: 'reopen' }), /REOPEN_REFUSED|not healthy|writers stay stopped/, what);
    assert.equal(stateOf(w).state, 'Switched', `${what}: the point of no return is not recorded`);
    assert.equal(w.deployments['opensphere-console/opensphere-console-api'], 0, `${what}: no writer started`);
  }
  const w = switched();
  const result = await cutover(w, dir).apply({ until: 'reopen' });
  assert.equal(result.state.state, 'Reopened');
  assert.equal(w.deployments['opensphere-console/opensphere-console-api'], 2);
}));

test('finding 6: rollback restores the old path at once and, if hibernation stalls, deletes the CNPG Pods before any writer starts', async () => withDir(async (dir) => {
  const w = switched({ stallHibernation: true });
  let writersWhileCnpgServed = false;
  w.onSleep = (x) => { if (x.cnpg.length && x.deployments['opensphere-console/opensphere-console-api'] > 0) writersWhileCnpgServed = true; };
  const started = w.now;
  const result = cutover(w, dir).rollback();
  assert.equal(result.state.state, 'RolledBack');
  assert.ok(result.actions.some((a) => /deleted every Pod of the Cluster/.test(a)), result.actions.join('; '));
  const patched = w.calls.findIndex((c) => c.includes('patch service'));
  const deleted = w.calls.findIndex((c) => c.includes('delete pods'));
  const writer = w.calls.findIndex((c) => c.includes('scale deployment opensphere-console-api'));
  assert.ok(patched >= 0 && patched < deleted, 'the Service is restored without waiting for the CNPG Pods');
  assert.ok(deleted < writer, 'writers start only after the CNPG Pods stopped serving');
  assert.equal(writersWhileCnpgServed, false);
  assert.ok(w.now - started <= 2 * 180_000 + 10_000, 'the wait is bounded');
  // Without a stall nothing is deleted.
  const quick = switched();
  assert.ok(!cutover(quick, dir).rollback().actions.some((a) => /deleted/.test(a)));
  assert.ok(!quick.calls.some((c) => c.includes('delete pods')));
}));

test('finding 2: switch refuses when a session or any write counter moved since freeze, before and after the Service moves', async () => withDir(async (dir) => {
  writeFileSync(join(dir, 'source-fingerprint.txt'), `rows|x.t|1\ncontent|x.t|1:2\n${CATALOG}\n`);
  const before = (over) => { const w = world(over); checkpoint(w, { steps: steps('parity') }); return w; };
  for (const [what, over, message] of [['a row written', { counters: COUNTERS.replace('100 tuples', '101 tuples') }],
    ['a TRUNCATE or DDL', { counters: COUNTERS.replace('relfiles|aaa', 'relfiles|aab') }],
    ['a sequence advanced', { counters: COUNTERS.replace('sequences|bbb', 'sequences|bbc') }],
    ['a client session', { sessions: ['opensphere_osdst_runtime osdst 10.42.1.9'] }],
    // Second review, item 2: writes only the catalog sees.
    ['a password change', { catalog: CATALOG.replace('pw=aaaa', 'pw=bbbb') }],
    ['a GRANT of a role', { catalog: `${CATALOG}\nmember|service_role>authenticator|admin=false` }],
    ['an ALTER ROLE ... SET', { catalog: CATALOG.replace('statement_timeout=8s', 'statement_timeout=0') }],
    ['a COMMENT', { catalog: `${CATALOG}\ncomment|objects|1 abc` }],
    // Item 6: a restart or a statistics reset is named as such.
    ['a restart', { counters: COUNTERS.replace('01:00:00', '01:30:00') }, /the source restarted/],
    ['a statistics reset', { counters: COUNTERS.replace('statsreset|never', 'statsreset|2026-10-27 02:00:00+00') }, /statistics were reset/]]) {
    const w = before(over);
    await assert.rejects(cutover(w, dir).apply({ until: 'switch' }), (e) => e.code === 'SOURCE_WRITTEN' && (!message || message.test(e.message)), what);
    assert.deepEqual(w.service.selector, LEGACY_SELECTOR, `${what}: nothing was switched`);
    assert.equal(w.sts, 1);
  }
  // A write that lands on the source directly while the Service already points at CNPG: the StatefulSet stays up.
  const late = before();
  late.onSql = (x, input) => { if (input === WRITE_COUNTERS_SQL && x.service.selector['cnpg.io/instanceRole']) x.counters = COUNTERS.replace('100 tuples', '107 tuples'); };
  await assert.rejects(cutover(late, dir).apply({ until: 'switch' }), /after the Service moved/);
  assert.equal(late.sts, 1, 'the source keeps running for the rollback');
  assert.equal(stateOf(late).service.ports[0].targetPort, 'postgres', 'the original Service was recorded before the patch');
  assert.equal(cutover(late, dir).rollback().state.state, 'RolledBack');
  assert.deepEqual(late.service.ports, ORIGINAL_PORTS);
  // Quiet: the switch goes through.
  const ok = before();
  assert.equal((await cutover(ok, dir).apply({ until: 'switch' })).state.state, 'Switched');
  assert.deepEqual(ok.service.selector, PRIMARY_SELECTOR);
  assert.equal(ok.sts, 0);
}));

test('finding 2: freeze records the write counters once they are stable, and the fingerprint refuses a moved source', async () => withDir(async (dir) => {
  const w = world({ deployments: { 'opensphere-console/opensphere-console-api': 2 } });
  checkpoint(w, {});
  const r = await cutover(w, dir).apply({ until: 'freeze' });
  assert.equal(r.state.steps.freeze.writeCounters, COUNTERS);
  assert.equal(w.deployments['opensphere-console/opensphere-console-api'], 0);
  let n = 0;
  const busy = world({ counters: () => `relfiles|aaa\nsequences|bbb\ntables|12 tables, ${(n += 1)} tuples written` });
  checkpoint(busy, {});
  await assert.rejects(cutover(busy, dir).apply({ until: 'freeze' }), { code: 'SOURCE_BUSY' });
  const moved = world({ counters: COUNTERS.replace('100 tuples', '150 tuples') });
  checkpoint(moved, { steps: steps('dump') });
  await assert.rejects(cutover(moved, dir).apply({ until: 'fingerprint' }), { code: 'SOURCE_WRITTEN' });
  // A checkpoint without a baseline (an attempt started by an older Setup) cannot be switched.
  const old = world();
  checkpoint(old, { steps: { ...steps('parity'), freeze: { at: 'x' } } });
  await assert.rejects(cutover(old, dir).apply({ until: 'switch' }), /no write baseline/);
  assert.deepEqual(counterChanges(COUNTERS, COUNTERS.replace('100 tuples', '113 tuples')), ['tables: 12 tables, 100 tuples written -> 12 tables, 113 tuples written']);
  assert.equal(parseWriteCounters(`BEGIN\n${COUNTERS}\nROLLBACK\n`), COUNTERS);
  assert.match(WRITE_COUNTERS_SQL, /^BEGIN TRANSACTION READ ONLY;/);
}));

test('finding 3: create fails closed when CNPG removed the import Job before its log was read', async () => withDir(async (dir) => {
  const resumed = () => { const w = world({ cluster: { exists: true, hibernation: false, readyInstances: 1 } }); checkpoint(w, { steps: steps('fingerprint') }); return w; };
  const w = resumed();
  await assert.rejects(cutover(w, dir).apply({ until: 'create' }), { code: 'IMPORT_LOG_MISSING' });
  assert.match(stateOf(w).attemptId, /abc/);
  assert.equal(stateOf(w).steps.create, undefined);
  // A log an earlier run of the same attempt captured from the succeeded import Pod counts; a changed one does not.
  const log = '{"level":"info","msg":"import done"}\n';
  writeFileSync(join(dir, 'import.log'), log);
  writeFileSync(join(dir, 'import-capture.json'), JSON.stringify({ pod: 'x-import', phase: 'Succeeded', sha256: createHash('sha256').update(log).digest('hex') }));
  const good = resumed();
  good.onSleep = (x) => { x.cluster.readyInstances = 3; };
  assert.ok((await cutover(good, dir).apply({ until: 'create' })).state.steps.create);
  writeFileSync(join(dir, 'import.log'), `${log}{"level":"error","msg":"x","error":"ERROR: lost"}\n`);
  await assert.rejects(cutover(resumed(), dir).apply({ until: 'create' }), { code: 'IMPORT_LOG_MISSING' });
  writeFileSync(join(dir, 'import-capture.json'), JSON.stringify({ pod: 'x-import', phase: 'Running', sha256: createHash('sha256').update(readFileSync(join(dir, 'import.log'))).digest('hex') }));
  await assert.rejects(cutover(resumed(), dir).apply({ until: 'create' }), { code: 'IMPORT_LOG_MISSING' });
  // A captured log with an unexpected error stops the cutover.
  const failing = world({ importPods: [{ metadata: { name: 'x-import' }, status: { phase: 'Succeeded' } }],
    importLog: '{"level":"info","msg":"record","record":{"error_severity":"ERROR","command_tag":"CREATE TABLE","message":"boom"}}' });
  checkpoint(failing, { steps: steps('fingerprint') });
  await assert.rejects(cutover(failing, dir).apply({ until: 'create' }), { code: 'IMPORT_ERRORS' });
}));

test('finding 7: the dump checks free space first, lands in the private directory and is removed from the source volume', async () => withDir(async (dir) => {
  const prepared = (over) => { const w = world(over); checkpoint(w, { steps: steps('freeze') }); return w; };
  const small = prepared({ podFreeKb: 100 * 1024 });
  await assert.rejects(cutover(small, dir).apply({ until: 'dump' }), { code: 'INSUFFICIENT_SPACE' });
  assert.ok(!small.calls.some((c) => c.includes('pg_dump ')), 'nothing was dumped');
  const local = prepared();
  await assert.rejects(cutover(local, dir, { freeBytes: () => 10 * 1024 ** 2 }).apply({ until: 'dump' }), /evidence directory has/);
  const custody = [];
  const ok = prepared();
  const copyOut = ({ file }) => { writeFileSync(file, ok.dumpBody); return file; };
  const r = await cutover(ok, dir, { copyOut, privateDirectory: (d) => custody.push(d) }).apply({ until: 'dump' });
  assert.deepEqual(custody, [dir]);
  assert.equal(r.state.steps.dump.sha256, ok.dumpSha);
  assert.ok(ok.calls.some((c) => c.endsWith(`rm -f /var/lib/postgresql/data/opensphere-console-db-20261027-abc.dump`)));
  assert.equal(r.state.steps.dump.inPod, undefined);
  const bad = prepared({ dumpSha: 'f'.repeat(64) });
  await assert.rejects(cutover(bad, dir, { copyOut }).apply({ until: 'dump' }), { code: 'DUMP_MISMATCH' });
  assert.ok(bad.calls.some((c) => c.includes(' rm -f ')), 'a mismatched dump is removed too');
  // Windows: the recovery-key custody helper; elsewhere 0700 without it.
  const seen = [];
  assert.equal(ensurePrivateEvidenceDirectory(join(dir, 'w'), { platform: 'win32', windowsCheck: () => { throw new Error('not yet'); }, windowsCustody: (d) => { seen.push(d); return { ruleCount: 1 }; } }).custody, 'windows-acl');
  assert.equal(ensurePrivateEvidenceDirectory(join(dir, 'p'), { platform: 'linux', windowsCustody: () => { throw new Error('not on linux'); } }).custody, 'posix-0700');
  assert.deepEqual(seen, [join(dir, 'w')]);
  // A resumed run finds the ACL already set and only checks it.
  assert.equal(ensurePrivateEvidenceDirectory(join(dir, 'w'), { platform: 'win32', windowsCheck: () => ({ ruleCount: 1 }), windowsCustody: () => { throw new Error('must not reset'); } }).ruleCount, 1);
  assert.throws(() => ensurePrivateEvidenceDirectory(join(dir, 'x'), { platform: 'win32', windowsCheck: () => { throw new Error('not yet'); }, windowsCustody: () => { throw new Error('Set-Acl: Attempted to perform an unauthorized operation.'); } }),
    { code: 'EVIDENCE_CUSTODY', message: /cannot be made current-user-only \(Attempted to perform an unauthorized operation\)/ });
}));

test('finding 8: one run at a time; a live lock refuses, an expired or explicitly broken one is taken over, a stolen one stops the run', async () => withDir(async (dir) => {
  const held = (renewedAgoMs, holder = 'other-host/42/aa') => {
    const w = world({ sts: 0 });
    w.service.selector = { ...PRIMARY_SELECTOR };
    checkpoint(w, { state: 'Reopened', steps: steps('verify') });
    w.lease = { metadata: { name: CUTOVER_LOCK, resourceVersion: '5' }, spec: { holderIdentity: holder, leaseDurationSeconds: 1800, renewTime: new Date(w.now - renewedAgoMs).toISOString() } };
    return w;
  };
  const live = held(60_000);
  const before = live.checkpoint.metadata.resourceVersion;
  await assert.rejects(cutover(live, dir).apply(), { code: 'CUTOVER_LOCKED' });
  assert.equal(live.checkpoint.metadata.resourceVersion, before, 'the checkpoint was not touched');
  assert.throws(() => cutover(live, dir).rollback(), { code: 'CUTOVER_LOCKED' });
  const expired = held(31 * 60_000);
  assert.equal((await cutover(expired, dir).apply()).state.state, 'Completed');
  assert.equal(expired.lease.spec.holderIdentity, undefined);
  const broken = held(60_000);
  assert.equal((await cutover(broken, dir, { breakLock: 'other-host/42/aa' }).apply()).state.state, 'Completed');
  await assert.rejects(cutover(held(60_000), dir, { breakLock: 'someone-else' }).apply(), { code: 'CUTOVER_LOCKED' });
  // Another run replaces the Lease while this one waits: the next renewal fails and the run stops.
  const stolen = switched({ stallHibernation: true });
  let stole = false;
  stolen.onSleep = (x) => {
    if (stole || !x.lease) return;
    stole = true;
    x.rv += 1;
    x.lease = { ...x.lease, metadata: { ...x.lease.metadata, resourceVersion: String(x.rv) }, spec: { ...x.lease.spec, holderIdentity: 'thief' } };
  };
  assert.throws(() => cutover(stolen, dir).rollback(), { code: 'CUTOVER_LOCK_LOST' });
  assert.equal(stateOf(stolen).state, 'RollingBack');
  assert.equal(stolen.deployments['opensphere-console/opensphere-console-api'], 0);
}));

test('second review, item 4: every change checks the Lease first; a takeover before reopen leaves the writers stopped', async () => withDir(async (dir) => {
  const w = switched();
  w.onCall = (x, a) => {
    if (a.includes('endpointslices') && x.lease?.spec.holderIdentity === 'me/1') {
      x.rv += 1;
      x.lease = { ...x.lease, metadata: { ...x.lease.metadata, resourceVersion: String(x.rv) }, spec: { ...x.lease.spec, holderIdentity: 'other/2', acquireTime: 'later' } };
    }
  };
  await assert.rejects(cutover(w, dir).apply({ until: 'reopen' }), { code: 'CUTOVER_LOCK_LOST' });
  assert.equal(stateOf(w).state, 'Switched', 'the point of no return was not recorded');
  assert.equal(w.deployments['opensphere-console/opensphere-console-api'], 0);
  assert.equal(w.lease.spec.holderIdentity, 'other/2', 'the other run keeps its lock');
  assert.deepEqual(catalogLines(`rows|a|1\ncontent|a|x\ntable|a|b|1\nrole|r|x\nBEGIN\nledger|count|1`), ['ledger|count|1', 'role|r|x']);
}));

test('finding 9: --extra-writer on a resume joins before freeze and is refused after it', async () => withDir(async (dir) => {
  const w = world({ deployments: { 'opensphere-console/opensphere-console-api': 2, 'opensphere-console/r2c2-pool': 1 } });
  checkpoint(w, {});
  const r = await cutover(w, dir, { extraWriters: ['opensphere-console/r2c2-pool=r2c2_probe'] }).apply({ until: 'freeze' });
  assert.ok(r.state.writers.some((x) => x.name === 'r2c2-pool' && x.replicas === 1 && x.role === 'r2c2_probe'));
  assert.equal(w.deployments['opensphere-console/r2c2-pool'], 0, 'the added writer was stopped by freeze');
  await assert.rejects(cutover(w, dir, { extraWriters: ['opensphere-console/late'] }).apply({ until: 'dump' }), /already froze its writers/);
}));

test('finding 9: an upgrade keeps the operator fence in the mode it is in', () => {
  const k = (binding) => () => (binding ? JSON.stringify({ spec: { validationActions: binding } }) : '');
  assert.equal(liveFenceMode(k(['Warn', 'Audit'])), 'warn');
  assert.equal(liveFenceMode(k(['Deny'])), 'deny');
  assert.equal(liveFenceMode(k(null)), 'deny');
});

test('resume, refusals and discard as before', async () => withDir(async (dir) => {
  const done = switched();
  checkpoint(done, { state: 'Reopened', steps: steps('verify') });
  const result = await cutover(done, dir).apply();
  assert.equal(result.state.state, 'Completed');
  assert.equal((await cutover(done, dir).apply()).done, true, 'a completed cutover is a no-op');
  const reopened = world();
  checkpoint(reopened, { state: 'Reopened', steps: steps('reopen') });
  assert.throws(() => cutover(reopened, dir).rollback(), { code: 'ROLLBACK_REFUSED' });
  const foreign = world();
  checkpoint(foreign, { clusterUid: '99999999-2222-3333-4444-555555555555' });
  await assert.rejects(cutover(foreign, dir).apply(), /another cluster/);
  const rolled = world();
  checkpoint(rolled, { state: 'RolledBack' });
  await assert.rejects(cutover(rolled, dir).apply(), /--discard-attempt 20261027-abc/);
  assert.throws(() => cutover(rolled, dir).discard('other'), /must name 20261027-abc/);
  assert.equal(cutover(rolled, dir).discard('20261027-abc').state.state, 'Discarded');
  assert.throws(() => createCutover({ context: 'lab', clusterUid: '00000000-2222-3333-4444-555555555555', evidenceDir: dir, runner: rolled.runner, privateDirectory: () => ({}) }).rollback(), /not 00000000/);
}));
