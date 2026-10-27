// `opensphere-setup migrate-console-db`: move the Console database from the Supabase StatefulSet to the CloudNativePG
// Cluster (R2-C2 scope 3; runbook R2-C2-CNPG-LAB-RESULTS-20261027.md §6, measured in the lab).
//
// Steps, each recorded in the checkpoint ConfigMap opensphere-console-data/opensphere-console-db-cutover before the next
// one starts. Re-running the command resumes at the first step that is not recorded; a recorded step is never redone.
//   freeze       old PV reclaim policy -> Retain; record and stop every writer; the source must show no client session
//   dump         final pg_dump -Fc on the source volume, checked with pg_restore --list, copied off the cluster into the
//                evidence directory and compared by sha256
//   fingerprint  source table rows, ledger, roles, memberships, grants (read-only), and the role dump without passwords
//   create       Setup Secrets (supabase_admin password copied in-process, never printed), temporary source Service,
//                the Cluster; wait for the monolith import and for three instances with a synchronous standby
//   repair       memberships, role settings, attributes and schema/database grants the import leaves out
//   parity       the gate: anything outside the explained differences stops here (rollback loses nothing)
//   switch       Service opensphere-supabase-postgres -> {app, cnpg.io/instanceRole: primary}, targetPort 5432; one
//                endpoint, the primary; the StatefulSet goes to 0 (its PVC and PV stay)
//   reopen       the point of no return is recorded first, then the writers come back as they were
//   verify       PostgREST schema reload, ledger through the CNPG executor path, every writer's role connected, Cluster
//                healthy
//   finalize     the temporary source Service and the import-source Secret are removed
// Rollback (before reopen only): hibernate the Cluster first (its Pods carry the Service's app label), restore the
// selector and targetPort, start the StatefulSet, check the ledger, bring the writers back. Nothing is deleted: the
// hibernated Cluster stays for inspection; `--discard-attempt` removes it before a new attempt. The old PVC and PV are
// never deleted by this command.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { run } from './process.mjs';
import { observeInstalledHissTarget } from './prepare-installed-hiss.mjs';
import { createConsoleDbClient, prepareConsoleDb } from './console-db-prepare.mjs';
import {
  ADMIN_SECRET, CLUSTER_NAME, CONSOLE_DB_SERVICE, CUTOVER_CONFIGMAP, DATA_NAMESPACE, FIELD_MANAGER, IMPORT_SOURCE_SECRET,
  LEGACY_PVC, LEGACY_SELECTOR, LEGACY_SOURCE_SERVICE, LEGACY_STATEFULSET, PRIMARY_SELECTOR, SUPABASE_SECRET,
  assertConsoleDbClusterHealthy, consoleDbSql, consoleDbTarget, observeConsoleDataLayout, renderConsoleDbCluster, renderLegacySourceService,
} from './console-db-cnpg.mjs';
import { FINGERPRINT_SQL, TABLES_SQL, compareParity, parseFingerprint, parseTables, rowCountSql } from './console-db-parity.mjs';
import { buildRepairSql } from './console-db-role-repair.mjs';

export const CUTOVER_STEPS = Object.freeze(['freeze', 'dump', 'fingerprint', 'create', 'repair', 'parity', 'switch', 'reopen', 'verify', 'finalize']);
const BEFORE_REOPEN = new Set(['freeze', 'dump', 'fingerprint', 'create', 'repair', 'parity', 'switch']);
// Every process that holds a Console DB session (RKE2 inventory 2026-10-27 §7), stopped Console first and restarted
// Supabase first, with the database role it logs in as (the verify step waits for each).
export const CONSOLE_DB_WRITERS = Object.freeze([
  { namespace: 'opensphere-console', name: 'opensphere-console-api', role: 'opensphere_console_api_runtime' },
  { namespace: 'opensphere-console', name: 'opensphere-extension-controller', role: 'opensphere_console_extension_runtime' },
  { namespace: 'opensphere-console', name: 'opensphere-console-osaa-gateway', role: 'opensphere_osaa_gateway_runtime' },
  { namespace: 'opensphere-console', name: 'opensphere-osdst', role: 'opensphere_osdst_runtime' },
  { namespace: 'opensphere-console', name: 'opensphere-shell-api', role: 'opensphere_shell_api_runtime' },
  { namespace: 'opensphere-console', name: 'opensphere-shell-gateway', role: 'opensphere_shell_gateway_runtime' },
  { namespace: 'opensphere-console', name: 'opensphere-shell-reconciler', role: 'opensphere_shell_reconciler_runtime' },
  { namespace: DATA_NAMESPACE, name: 'opensphere-supabase-storage', role: 'supabase_storage_admin' },
  { namespace: DATA_NAMESPACE, name: 'opensphere-supabase-rest', role: 'authenticator' },
  { namespace: DATA_NAMESPACE, name: 'opensphere-supabase-auth', role: 'supabase_auth_admin' },
]);
// Conditions Setup cannot observe itself; each must be accepted by name (recorded in the checkpoint).
export const CUTOVER_PREREQUISITES = Object.freeze({
  'pool-error-listener': 'Console release (R2-C1 rebase) with a pg Pool error listener in console-api, extension-controller and os-shell-control (lab X6)',
  'crash-alerts': 'Cluster Manager alert for PostgreSQL crash recovery and CNPG instance restarts (triage M4)',
  'kured-cnpg-gate': 'Cluster Manager release with the kured PDBBlocking exclusion for CNPG primary PDBs (HA design §1.5)',
  'node-maintenance-paused': 'node-maintenance paused for the window (OS Shell node-maintenance.pause)',
  'outage-announced': 'the planned stop was announced a day ahead (plan §4.5)',
  'console-layout-release': 'a Console release that declares -ConsoleDataLayout is ready for the first Setup upgrade after the cutover',
});
const SCHEMA = 'opensphere.console-db-cutover/v1';

const fail = (code, message, evidence) => Object.assign(new Error(message), { code, ...(evidence ? { evidence } : {}) });
const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const json = (text) => (String(text || '').trim() ? JSON.parse(text) : null);
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const sameMap = (a, b) => JSON.stringify(sorted(a || {})) === JSON.stringify(sorted(b || {}));

// Binary-safe copy of a file in a Pod to the operator's machine (the off-cluster dump copy).
export function copyFromPod({ context, pod, container, path, file }) {
  const fd = openSync(file, 'w', 0o600);
  try {
    const r = spawnSync('kubectl', ['--context', context, '-n', DATA_NAMESPACE, 'exec', pod, '-c', container, '--', 'cat', path],
      { stdio: ['ignore', fd, 'pipe'], windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`copy from ${pod} failed: ${String(r.stderr || '').trim()}`);
  } finally { closeSync(fd); }
  return file;
}

export function parseExtraWriters(values = []) {
  return values.map((v) => {
    const m = /^([a-z0-9-]+)\/([a-z0-9-]+)(?:=([a-z_][a-z0-9_]*))?$/.exec(v);
    if (!m) throw fail('INVALID_INPUT', `--extra-writer must be <namespace>/<deployment>[=<db role>]: ${v}`);
    return { namespace: m[1], name: m[2], role: m[3] || null, extra: true };
  });
}

export function createCutover({ context, clusterUid, evidenceDir, runner = run, sleep = defaultSleep, now = () => Date.now(),
  log = (line) => console.log(line), extraWriters = [], acceptedPrerequisites = [], copyOut = copyFromPod, timeouts = {} } = {}) {
  const k = createConsoleDbClient(context, runner);
  const T = { connections: 180_000, import: 3_600_000, ready: 1_800_000, rollout: 900_000, connect: 600_000, ...timeouts };
  const get = (args) => {
    try { return json(k([...args, '--ignore-not-found', '-o', 'json', '--request-timeout=20s'])); } catch (error) {
      // Before prepare-console-db the CNPG kinds are not served yet: nothing of that kind exists.
      if (/doesn't have a resource type/.test(String(error?.stderr || error?.message))) return null;
      throw error;
    }
  };
  const ns = (args) => ['-n', DATA_NAMESPACE, ...args];
  const source = { layout: 'statefulset', pod: `${LEGACY_STATEFULSET}-0`, container: 'postgres' };
  const sourceSql = (sql, options) => consoleDbSql(k, source, sql, options);
  const target = () => consoleDbTarget(k, 'Console DB cutover', { layout: 'cnpg' });
  // The target's SQL runs as postgres here (repair, parity): the repair writes role catalog rows supabase_admin may not.
  const targetSuperSql = (sql) => k(ns(['exec', '-i', primaryPod(), '-c', 'postgres', '--', 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tA']), { input: sql });
  const primaryPod = () => {
    const pods = JSON.parse(k(ns(['get', 'pods', '-l', `cnpg.io/cluster=${CLUSTER_NAME},cnpg.io/instanceRole=primary`, '-o', 'json']))).items
      .filter((p) => p.status?.phase === 'Running' && !p.metadata.deletionTimestamp);
    if (pods.length !== 1) throw fail('CONSOLE_DB_UNHEALTHY', 'Exactly one running CloudNativePG primary is required');
    return pods[0].metadata.name;
  };
  const evidence = (name) => join(evidenceDir, name);
  const writeEvidence = (name, content) => { writeFileSync(evidence(name), content, { mode: 0o600 }); return evidence(name); };
  const timeline = (entry) => appendFileSync(evidence('steps.jsonl'), `${JSON.stringify({ at: new Date(now()).toISOString(), ...entry })}\n`);
  const writers = [...CONSOLE_DB_WRITERS, ...parseExtraWriters(extraWriters)];

  // ---- checkpoint -----------------------------------------------------------------------------------------------
  const readCheckpoint = () => {
    const cm = get(ns(['get', 'configmap', CUTOVER_CONFIGMAP]));
    if (!cm) return null;
    const state = JSON.parse(cm.data?.['state.json'] ?? 'null');
    if (state?.schema !== SCHEMA) throw fail('CHECKPOINT_UNREADABLE', `${CUTOVER_CONFIGMAP} is not a cutover checkpoint this Setup understands`);
    return { cm, state };
  };
  const writeCheckpoint = (state, previous) => {
    const doc = { apiVersion: 'v1', kind: 'ConfigMap',
      metadata: { name: CUTOVER_CONFIGMAP, namespace: DATA_NAMESPACE,
        labels: { 'app.kubernetes.io/part-of': 'opensphere-console', 'app.kubernetes.io/managed-by': 'opensphere-setup', 'opensphere.io/authority': 'console-db-cnpg-v1' },
        ...(previous ? { resourceVersion: previous.metadata.resourceVersion } : {}) },
      data: { 'state.json': `${JSON.stringify(state, null, 1)}\n` } };
    // create fails if another run created it; replace fails if another run changed it (resourceVersion).
    k([previous ? 'replace' : 'create', '-f', '-', '-o', 'json'], { input: `${JSON.stringify(doc)}\n` });
    return readCheckpoint();
  };
  let checkpoint = null;
  const save = (mutate) => {
    const state = structuredClone(checkpoint.state);
    mutate(state);
    checkpoint = writeCheckpoint(state, checkpoint.cm);
  };
  const recordStep = (step, result = {}) => save((s) => { s.steps[step] = { at: new Date(now()).toISOString(), ...result }; });

  // ---- observations ---------------------------------------------------------------------------------------------
  const assertIdentity = () => {
    const uid = k(['get', 'namespace', 'kube-system', '-o', 'jsonpath={.metadata.uid}']);
    if (uid !== clusterUid) throw fail('PRECONDITION_FAILED', `Kubernetes context ${context} is cluster ${uid}, not ${clusterUid}`);
  };
  const installation = () => {
    const t = observeInstalledHissTarget(context, runner);
    const record = JSON.parse(k(['-n', 'opensphere-console', 'get', 'configmap', 'opensphere-installation-lock', '-o', 'json']));
    const config = JSON.parse(record.data['config.json']);
    if (!config.storageClass) throw fail('PRECONDITION_FAILED', 'Installation config names no StorageClass');
    return { installationUid: t.installationUid, releaseDigest: t.releaseDigest, storageClass: config.storageClass };
  };
  const writerState = () => writers.map((w) => {
    const d = get(['-n', w.namespace, 'get', 'deployment', w.name]);
    return d ? { ...w, replicas: Number(d.spec?.replicas ?? 1), selector: d.spec?.selector?.matchLabels || {} } : { ...w, absent: true };
  });
  const scale = (w, replicas) => k(['-n', w.namespace, 'scale', 'deployment', w.name, `--replicas=${replicas}`]);
  const waitPodsGone = (w) => {
    const selector = Object.entries(w.selector).map(([a, b]) => `${a}=${b}`).join(',');
    if (!selector) throw fail('PRECONDITION_FAILED', `Writer ${w.namespace}/${w.name} has no selector`);
    const deadline = now() + T.rollout;
    while ((JSON.parse(k(['-n', w.namespace, 'get', 'pods', '-l', selector, '-o', 'json'])).items || []).length) {
      if (now() > deadline) throw fail('TIMEOUT', `Pods of ${w.namespace}/${w.name} did not stop`);
      sleep(1000);
    }
  };
  const sourceSessions = () => String(sourceSql("SELECT usename || ' ' || coalesce(application_name, '') || ' ' || coalesce(client_addr::text, 'local') FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid();") || '')
    .split(/\r?\n/).filter(Boolean);
  const fingerprint = (sql) => {
    const tables = parseTables(sql(TABLES_SQL));
    return { tables, text: `${sql(rowCountSql(tables))}\n${sql(FINGERPRINT_SQL)}` };
  };
  const nodesForInstances = () => JSON.parse(k(['get', 'nodes', '-o', 'json'])).items.filter((n) => (n.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True')
    && !n.spec?.unschedulable && !(n.spec?.taints || []).some((t) => ['NoSchedule', 'NoExecute'].includes(t.effect))).length;

  function preflight() {
    assertIdentity();
    const inst = installation();
    const layout = observeConsoleDataLayout(k);
    const checks = [];
    const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
    const sts = get(ns(['get', 'statefulset', LEGACY_STATEFULSET]));
    const pvc = get(ns(['get', 'pvc', LEGACY_PVC]));
    const storageClass = get(['get', 'storageclass', inst.storageClass]);
    const cluster = get(ns(['get', 'clusters.postgresql.cnpg.io', CLUSTER_NAME]));
    const nodes = nodesForInstances();
    check('layout', ['statefulset', 'cutover'].includes(layout.layout), `layout ${layout.layout}`);
    check('source-statefulset', sts && sts.spec?.replicas === 1 && sts.status?.readyReplicas === 1, sts ? `replicas ${sts.spec?.replicas}, ready ${sts.status?.readyReplicas ?? 0}` : 'absent');
    check('source-pvc', pvc?.status?.phase === 'Bound', pvc ? `${pvc.status?.phase}, PV ${pvc.spec?.volumeName}` : 'absent');
    check('storage-class', Boolean(storageClass), inst.storageClass);
    check('nodes', nodes >= 3, `${nodes} schedulable nodes for 3 instances with required anti-affinity${nodes === 3 ? ' (a drain then leaves one instance Pending)' : ''}`);
    check('no-cluster', !cluster || layout.layout === 'cutover', cluster ? `Cluster ${CLUSTER_NAME} exists (${cluster.metadata?.annotations?.['cnpg.io/hibernation'] === 'on' ? 'hibernated' : 'running'})` : 'absent');
    const ksm = get(['-n', 'monitoring', 'get', 'deployment', '-l', 'app.kubernetes.io/name=kube-state-metrics']);
    const ksmArgs = JSON.stringify(ksm?.items?.[0]?.spec?.template?.spec?.containers?.[0]?.args || []);
    const prerequisites = Object.entries(CUTOVER_PREREQUISITES).map(([id, text]) => ({ id, text, accepted: acceptedPrerequisites.includes(id) }));
    prerequisites.push({ id: 'ksm-pdb-labels', text: 'kube-state-metrics exports the cnpg.io/cluster PDB label (kured gate input)',
      observed: /poddisruptionbudgets=\[[^\]]*cnpg\.io\/cluster/.test(ksmArgs), accepted: acceptedPrerequisites.includes('ksm-pdb-labels') });
    for (const p of prerequisites) check(`prerequisite:${p.id}`, p.observed || p.accepted, p.observed ? 'observed' : p.accepted ? 'accepted by the operator' : `not met: ${p.text}`);
    return { ...inst, layout: layout.layout, checks, ok: checks.every((c) => c.ok), prerequisites, writers: writerState(), pv: pvc?.spec?.volumeName };
  }

  // ---- steps ----------------------------------------------------------------------------------------------------
  const steps = {
    freeze() {
      const pv = get(['get', 'pv', checkpoint.state.source.pv]);
      if (!pv) throw fail('PRECONDITION_FAILED', 'The source PersistentVolume is missing');
      if (pv.spec.persistentVolumeReclaimPolicy !== 'Retain') {
        k(['patch', 'pv', pv.metadata.name, '--type=json', '-p', JSON.stringify([{ op: 'test', path: '/metadata/uid', value: pv.metadata.uid },
          { op: 'replace', path: '/spec/persistentVolumeReclaimPolicy', value: 'Retain' }])]);
      }
      const present = checkpoint.state.writers.filter((w) => !w.absent);
      for (const w of present) { scale(w, 0); log(`  stopped ${w.namespace}/${w.name} (was ${w.replicas})`); }
      for (const w of present) waitPodsGone(w);
      const deadline = now() + T.connections;
      let sessions = sourceSessions();
      while (sessions.length && now() < deadline) { sleep(2000); sessions = sourceSessions(); }
      if (sessions.length) throw fail('SOURCE_BUSY', `Client sessions remain on the source: ${sessions.join('; ')}. Stop them (--extra-writer) or roll back.`);
      return { pvReclaimPolicyBefore: pv.spec.persistentVolumeReclaimPolicy, stopped: present.map((w) => `${w.namespace}/${w.name}`) };
    },
    dump() {
      const file = `/var/lib/postgresql/data/opensphere-console-db-${checkpoint.state.attemptId}.dump`;
      const out = k(ns(['exec', source.pod, '-c', 'postgres', '--', 'sh', '-ec',
        `PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U supabase_admin -d postgres -Fc -f '${file}' && pg_restore --list '${file}' >/dev/null && sha256sum '${file}' && stat -c %s '${file}'`]));
      const [shaLine, bytes] = out.split(/\r?\n/);
      const remote = shaLine.split(/\s+/)[0];
      const local = copyOut({ context, pod: source.pod, container: 'postgres', path: file, file: evidence(`console-db-${checkpoint.state.attemptId}.dump`) });
      const localSha = sha256(readFileSync(local));
      if (localSha !== remote) throw fail('DUMP_MISMATCH', `Off-cluster dump copy differs (${localSha} != ${remote})`);
      return { inPod: file, offCluster: resolve(local), sha256: remote, bytes: Number(bytes) };
    },
    fingerprint() {
      const fp = fingerprint(sourceSql);
      writeEvidence('source-fingerprint.txt', fp.text);
      const roles = k(ns(['exec', source.pod, '-c', 'postgres', '--', 'sh', '-ec', 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dumpall -h 127.0.0.1 -U supabase_admin --roles-only --no-role-passwords']));
      writeEvidence('source-roles.sql', `${roles}\n`);
      const parsed = parseFingerprint(fp.text);
      return { tables: fp.tables.length, ledger: parsed.ledger.get('count'), head: parsed.ledger.get('head'), sha256: sha256(fp.text) };
    },
    create() {
      const encoded = k(ns(['get', 'secret', SUPABASE_SECRET, '-o', 'jsonpath={.data.postgres-password}']));
      if (!encoded) throw fail('PRECONDITION_FAILED', `${SUPABASE_SECRET} has no postgres-password`);
      const labels = { 'app.kubernetes.io/part-of': 'opensphere-console', 'app.kubernetes.io/managed-by': 'opensphere-setup', 'opensphere.io/authority': 'console-db-cnpg-v1' };
      const username = Buffer.from('supabase_admin').toString('base64');
      const secrets = [
        { apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/basic-auth', metadata: { name: ADMIN_SECRET, namespace: DATA_NAMESPACE, labels }, data: { username, password: encoded } },
        { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: IMPORT_SOURCE_SECRET, namespace: DATA_NAMESPACE, labels }, data: { password: encoded } },
      ];
      const apply = (doc) => k(['apply', '--server-side', `--field-manager=${FIELD_MANAGER}`, '-f', '-', '-o', 'name'], { input: `${JSON.stringify(doc)}\n` });
      for (const s of secrets) apply(s);
      apply(renderLegacySourceService());
      const cluster = renderConsoleDbCluster({ storageClass: checkpoint.state.storageClass });
      apply(cluster);
      log('  Cluster applied; waiting for the import');
      const deadline = now() + T.import;
      let job = null;
      for (;;) {
        const pods = JSON.parse(k(ns(['get', 'pods', '-l', `cnpg.io/cluster=${CLUSTER_NAME},cnpg.io/jobRole=import`, '-o', 'json']))).items || [];
        job = pods.find((p) => ['Succeeded', 'Failed'].includes(p.status?.phase));
        if (job) break;
        const c = get(ns(['get', 'clusters.postgresql.cnpg.io', CLUSTER_NAME]));
        if ((c?.status?.readyInstances ?? 0) >= 1 && !pods.length) break; // resumed after CNPG removed the import Job
        if (now() > deadline) throw fail('TIMEOUT', 'The CloudNativePG import did not finish');
        sleep(2000);
      }
      let importErrors = null;
      if (job) {
        // CNPG deletes the import Job once the Cluster is up; keep its log now (lab §2.3).
        const logs = k(ns(['logs', job.metadata.name, '--all-containers']));
        writeEvidence('import.log', `${logs}\n`);
        if (job.status.phase === 'Failed') throw fail('IMPORT_FAILED', `The import Job failed; see ${evidence('import.log')}`);
        importErrors = classifyImportErrors(logs);
        writeEvidence('import-errors.json', `${JSON.stringify(importErrors, null, 1)}\n`);
        if (importErrors.unexpected.length) throw fail('IMPORT_ERRORS', `The import reported ${importErrors.unexpected.length} unexpected error(s); see ${evidence('import-errors.json')}`);
      }
      const readyDeadline = now() + T.ready;
      for (;;) {
        const c = get(ns(['get', 'clusters.postgresql.cnpg.io', CLUSTER_NAME]));
        if (c?.status?.readyInstances === 3 && c.status.currentPrimary && c.status.currentPrimary === c.status.targetPrimary) {
          const sync = Number(targetSuperSql("SELECT count(*) FROM pg_stat_replication WHERE sync_state IN ('quorum','sync');").trim());
          if (sync >= 1) return { primary: c.status.currentPrimary, readyInstances: 3, synchronousStandbys: sync, importErrors: importErrors && { expected: importErrors.expected.length } };
        }
        if (now() > readyDeadline) throw fail('TIMEOUT', 'The Cluster did not reach three ready instances with a synchronous standby');
        sleep(3000);
      }
    },
    repair() {
      const sourceFp = parseFingerprint(readFileSync(evidence('source-fingerprint.txt'), 'utf8'));
      const targetFp = parseFingerprint(targetSuperSql(FINGERPRINT_SQL));
      const repair = buildRepairSql(readFileSync(evidence('source-roles.sql'), 'utf8'), { source: sourceFp, target: targetFp });
      writeEvidence('repair.sql', repair.sql);
      targetSuperSql(repair.sql);
      return repair.counts;
    },
    parity() {
      const fp = fingerprint((sql) => targetSuperSql(sql));
      writeEvidence('target-fingerprint.txt', fp.text);
      const result = compareParity(parseFingerprint(readFileSync(evidence('source-fingerprint.txt'), 'utf8')), parseFingerprint(fp.text));
      writeEvidence('parity.json', `${JSON.stringify(result, null, 1)}\n`);
      if (!result.ok) throw fail('PARITY_FAILED', `Parity failed on ${result.differences.length} item(s); nothing was switched. See ${evidence('parity.json')}`);
      return { ...result.compared, explained: result.explained.length };
    },
    switch() {
      const svc = JSON.parse(k(ns(['get', 'service', CONSOLE_DB_SERVICE, '-o', 'json'])));
      if (!sameMap(svc.spec.selector, PRIMARY_SELECTOR)) {
        if (!sameMap(svc.spec.selector, LEGACY_SELECTOR)) throw fail('PRECONDITION_FAILED', `Service ${CONSOLE_DB_SERVICE} has an unexpected selector`);
        k(ns(['patch', 'service', CONSOLE_DB_SERVICE, '--type=json', '-p', JSON.stringify([
          { op: 'test', path: '/metadata/uid', value: svc.metadata.uid },
          { op: 'test', path: '/spec/selector', value: svc.spec.selector },
          { op: 'replace', path: '/spec/selector', value: { ...PRIMARY_SELECTOR } },
          { op: 'replace', path: '/spec/ports', value: [{ name: 'postgres', port: 5432, protocol: 'TCP', targetPort: 5432 }] }])]));
      }
      const primary = primaryPod();
      const ip = JSON.parse(k(ns(['get', 'pod', primary, '-o', 'json']))).status.podIP;
      const deadline = now() + 120_000;
      for (;;) {
        const slices = JSON.parse(k(ns(['get', 'endpointslices', '-l', `kubernetes.io/service-name=${CONSOLE_DB_SERVICE}`, '-o', 'json']))).items || [];
        const ready = slices.flatMap((s) => (s.endpoints || []).filter((e) => e.conditions?.ready !== false).flatMap((e) => e.addresses));
        if (ready.length === 1 && ready[0] === ip) break;
        if (now() > deadline) throw fail('SWITCH_INCOMPLETE', `Service endpoints are ${ready.join(',') || 'empty'}, expected only the primary ${ip}`);
        sleep(1000);
      }
      k(ns(['scale', 'statefulset', LEGACY_STATEFULSET, '--replicas=0']));
      const gone = now() + T.rollout;
      while (get(ns(['get', 'pod', `${LEGACY_STATEFULSET}-0`]))) { if (now() > gone) throw fail('TIMEOUT', 'The StatefulSet Pod did not stop'); sleep(1000); }
      save((s) => { s.state = 'Switched'; });
      return { primary, endpoint: ip };
    },
    reopen() {
      // Point of no return: from here, writes land only on CNPG and rollback is a new dump.
      save((s) => { s.state = 'Reopened'; });
      const present = checkpoint.state.writers.filter((w) => !w.absent);
      for (const w of [...present].reverse()) scale(w, w.replicas);
      for (const w of [...present].reverse()) k(['-n', w.namespace, 'rollout', 'status', `deployment/${w.name}`, `--timeout=${Math.round(T.rollout / 1000)}s`]);
      return { started: present.map((w) => `${w.namespace}/${w.name}=${w.replicas}`) };
    },
    verify() {
      const t = target();
      consoleDbSql(k, t, "NOTIFY pgrst, 'reload schema';", { transaction: true });
      const ledger = consoleDbSql(k, t, "SELECT count(*) || '|' || (SELECT global_id || ' ' || migration_set_digest FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1) FROM console_migration.applied_migration;").trim();
      const expected = `${checkpoint.state.steps.fingerprint.ledger}|${checkpoint.state.steps.fingerprint.head}`;
      if (ledger !== expected) throw fail('VERIFY_FAILED', `Ledger through the CNPG executor path is ${ledger}, expected ${expected}`);
      const roles = checkpoint.state.writers.filter((w) => !w.absent && w.replicas > 0 && w.role).map((w) => w.role);
      const deadline = now() + T.connect;
      let missing = roles;
      while (missing.length) {
        const connected = new Set(consoleDbSql(k, t, "SELECT DISTINCT usename FROM pg_stat_activity WHERE backend_type = 'client backend';").split(/\r?\n/).filter(Boolean));
        missing = roles.filter((r) => !connected.has(r));
        if (!missing.length) break;
        if (now() > deadline) throw fail('VERIFY_FAILED', `Writers have not connected to the new primary: ${missing.join(', ')}`);
        sleep(2000);
      }
      const health = assertConsoleDbClusterHealthy(get(ns(['get', 'clusters.postgresql.cnpg.io', CLUSTER_NAME])), { storageClass: checkpoint.state.storageClass });
      return { ledger, connectedRoles: roles, cluster: health };
    },
    finalize() {
      // The import is over: its source Service and Secret go (lab: the Cluster stays healthy without them).
      k(ns(['delete', 'service', LEGACY_SOURCE_SERVICE, '--ignore-not-found']));
      k(ns(['delete', 'secret', IMPORT_SOURCE_SECRET, '--ignore-not-found']));
      save((s) => { s.state = 'Completed'; });
      return { removed: [`Service/${LEGACY_SOURCE_SERVICE}`, `Secret/${IMPORT_SOURCE_SECRET}`],
        kept: [`StatefulSet/${LEGACY_STATEFULSET} (0)`, `PVC/${LEGACY_PVC}`, `PV/${checkpoint.state.source.pv} (Retain)`] };
    },
  };

  return {
    preflight,
    status() { const c = readCheckpoint(); return c ? c.state : null; },
    // Plan, or apply up to and including `until`.
    async apply({ until = 'finalize' } = {}) {
      if (!CUTOVER_STEPS.includes(until)) throw fail('INVALID_INPUT', `--until must be one of ${CUTOVER_STEPS.join(', ')}`);
      if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true });
      checkpoint = readCheckpoint();
      if (checkpoint && ['Completed'].includes(checkpoint.state.state)) return { state: checkpoint.state, done: true };
      if (checkpoint && checkpoint.state.state === 'RolledBack') throw fail('PRECONDITION_FAILED', `Attempt ${checkpoint.state.attemptId} was rolled back; inspect it, then --discard-attempt ${checkpoint.state.attemptId}`);
      if (checkpoint && checkpoint.state.clusterUid !== clusterUid) throw fail('PRECONDITION_FAILED', 'The checkpoint belongs to another cluster');
      if (!checkpoint || checkpoint.state.state === 'Discarded') {
        const p = preflight();
        writeEvidence('preflight.json', `${JSON.stringify(p, null, 1)}\n`);
        if (!p.ok) throw fail('PREFLIGHT_FAILED', `Preflight failed: ${p.checks.filter((c) => !c.ok).map((c) => `${c.id} (${c.detail})`).join('; ')}`, p);
        const operator = await prepareConsoleDb({ context, apply: false, runner });
        if (operator.state !== 'Present') throw fail('PREFLIGHT_FAILED', `The CloudNativePG operator is ${operator.state}; run prepare-console-db --apply first`);
        const sts = JSON.parse(k(ns(['get', 'statefulset', LEGACY_STATEFULSET, '-o', 'json'])));
        const state = { schema: SCHEMA, attemptId: `${new Date(now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`,
          state: 'InProgress', clusterUid, installationUid: p.installationUid, releaseDigest: p.releaseDigest, storageClass: p.storageClass,
          source: { statefulSetUid: sts.metadata.uid, pvc: LEGACY_PVC, pv: p.pv }, writers: p.writers, prerequisites: p.prerequisites,
          evidenceDir: resolve(evidenceDir), steps: {}, history: checkpoint ? [...(checkpoint.state.history || []), { attemptId: checkpoint.state.attemptId, state: checkpoint.state.state }] : [] };
        checkpoint = writeCheckpoint(state, checkpoint?.cm);
        log(`attempt ${state.attemptId} started`);
      } else {
        assertIdentity();
        log(`attempt ${checkpoint.state.attemptId} resumes (${checkpoint.state.state})`);
      }
      for (const step of CUTOVER_STEPS) {
        if (checkpoint.state.steps[step]) continue;
        const started = now();
        log(`[${step}]`);
        timeline({ step, event: 'start' });
        let result;
        try { result = steps[step](); } catch (error) {
          timeline({ step, event: 'failed', ms: now() - started, code: error.code, message: error.message });
          throw error;
        }
        const ms = now() - started;
        recordStep(step, { ms, ...result });
        timeline({ step, event: 'done', ms });
        log(`  done in ${(ms / 1000).toFixed(1)} s`);
        if (step === until) break;
      }
      return { state: checkpoint.state, done: checkpoint.state.state === 'Completed' };
    },
    rollback() {
      checkpoint = readCheckpoint();
      if (!checkpoint) throw fail('PRECONDITION_FAILED', 'No cutover to roll back');
      assertIdentity();
      const s = checkpoint.state;
      if (!['InProgress', 'Switched'].includes(s.state) || s.steps.reopen) {
        throw fail('ROLLBACK_REFUSED', `Attempt ${s.attemptId} is ${s.state}; after reopen the way back is a new dump of the CloudNativePG database (design §1.6)`);
      }
      const started = now();
      const actions = [];
      const cluster = get(ns(['get', 'clusters.postgresql.cnpg.io', CLUSTER_NAME]));
      if (cluster && cluster.metadata?.annotations?.['cnpg.io/hibernation'] !== 'on') {
        // First: the instances carry app=opensphere-supabase-postgres, so the old selector would also pick them.
        k(ns(['annotate', 'clusters.postgresql.cnpg.io', CLUSTER_NAME, 'cnpg.io/hibernation=on', '--overwrite']));
        actions.push('hibernated the Cluster');
      }
      const gone = now() + T.rollout;
      while ((JSON.parse(k(ns(['get', 'pods', '-l', `cnpg.io/cluster=${CLUSTER_NAME}`, '-o', 'json']))).items || []).some((p) => !['Succeeded', 'Failed'].includes(p.status?.phase))) {
        if (now() > gone) throw fail('TIMEOUT', 'CloudNativePG Pods did not stop after hibernation');
        sleep(1000);
      }
      const svc = JSON.parse(k(ns(['get', 'service', CONSOLE_DB_SERVICE, '-o', 'json'])));
      if (!sameMap(svc.spec.selector, LEGACY_SELECTOR)) {
        k(ns(['patch', 'service', CONSOLE_DB_SERVICE, '--type=json', '-p', JSON.stringify([
          { op: 'test', path: '/metadata/uid', value: svc.metadata.uid },
          { op: 'replace', path: '/spec/selector', value: { ...LEGACY_SELECTOR } },
          { op: 'replace', path: '/spec/ports', value: [{ name: 'postgres', port: 5432, protocol: 'TCP', targetPort: 'postgres' }] }])]));
        actions.push('restored the Service selector and targetPort');
      }
      k(ns(['scale', 'statefulset', LEGACY_STATEFULSET, '--replicas=1']));
      k(ns(['rollout', 'status', `statefulset/${LEGACY_STATEFULSET}`, `--timeout=${Math.round(T.rollout / 1000)}s`]));
      if (s.steps.fingerprint) {
        const ledger = sourceSql("SELECT count(*) || '|' || (SELECT global_id || ' ' || migration_set_digest FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1) FROM console_migration.applied_migration;").trim();
        if (ledger !== `${s.steps.fingerprint.ledger}|${s.steps.fingerprint.head}`) throw fail('ROLLBACK_INCOMPLETE', `The source ledger is ${ledger}; the writers stay stopped`);
      }
      const present = s.writers.filter((w) => !w.absent);
      for (const w of [...present].reverse()) scale(w, w.replicas);
      for (const w of [...present].reverse()) k(['-n', w.namespace, 'rollout', 'status', `deployment/${w.name}`, `--timeout=${Math.round(T.rollout / 1000)}s`]);
      actions.push('started the StatefulSet and the writers');
      k(ns(['delete', 'service', LEGACY_SOURCE_SERVICE, '--ignore-not-found']));
      save((x) => { x.state = 'RolledBack'; x.rollback = { at: new Date(now()).toISOString(), ms: now() - started, actions }; });
      if (existsSync(evidenceDir)) timeline({ step: 'rollback', event: 'done', ms: now() - started });
      return { state: checkpoint.state, ms: now() - started, actions };
    },
    discard(attemptId) {
      checkpoint = readCheckpoint();
      if (!checkpoint || checkpoint.state.state !== 'RolledBack') throw fail('PRECONDITION_FAILED', 'Only a rolled-back attempt can be discarded');
      if (attemptId !== checkpoint.state.attemptId) throw fail('PRECONDITION_FAILED', `--discard-attempt must name ${checkpoint.state.attemptId}`);
      assertIdentity();
      // The hibernated Cluster holds only the imported copy; CNPG removes its PVCs and Secrets with it.
      k(ns(['delete', 'clusters.postgresql.cnpg.io', CLUSTER_NAME, '--ignore-not-found', '--wait=true']));
      k(ns(['delete', 'secret', ADMIN_SECRET, IMPORT_SOURCE_SECRET, '--ignore-not-found']));
      save((x) => { x.state = 'Discarded'; x.discardedAt = new Date(now()).toISOString(); });
      return { state: checkpoint.state };
    },
  };
}

// Errors in the CNPG import log (JSON lines: PostgreSQL records and the instance manager's own entries). The role
// memberships CNPG replays "GRANTED BY supabase_admin" fail by design on PostgreSQL 16+ and are what the repair step
// restores (lab trial 2: SQLSTATE 42501 "permission denied to grant privileges as role supabase_admin", logged again as
// "while importing role inheritance"). Any other error stops the cutover before the switch.
const EXPECTED_IMPORT_ERRORS = [
  /permission denied to grant privileges as role "supabase_admin"/,
  /while importing role inheritance/,
];
export function classifyImportErrors(log) {
  const expected = [], unexpected = [];
  for (const line of String(log).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { if (/\bERROR\b|FATAL|pg_restore: error/.test(line)) unexpected.push(line.slice(0, 500)); continue; }
    let text = null;
    if (['ERROR', 'FATAL', 'PANIC'].includes(entry.record?.error_severity)) text = `${entry.record.command_tag || ''}: ${entry.record.message || ''}`;
    else if (entry.level === 'error') text = `${entry.msg || ''}: ${entry.error || ''}`;
    else if (/pg_restore: error/.test(entry.msg || '')) text = entry.msg;
    if (!text) continue;
    (EXPECTED_IMPORT_ERRORS.some((pattern) => pattern.test(text)) ? expected : unexpected).push(text.slice(0, 500));
  }
  return { expected, unexpected };
}
