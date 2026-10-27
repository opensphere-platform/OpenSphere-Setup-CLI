// `opensphere-setup migrate-console-db`: move the Console database from the Supabase StatefulSet to the CloudNativePG
// Cluster (R2-C2 scope 3; runbook R2-C2-CNPG-LAB-RESULTS-20261027.md §6, measured in the lab).
//
// Steps, each recorded in the checkpoint ConfigMap opensphere-console-data/opensphere-console-db-cutover before the next
// one starts. Re-running the command resumes at the first step that is not recorded; a recorded step is never redone.
// One run at a time: every apply, rollback and discard holds the Lease of the same name (renewed while it waits).
//   freeze       old PV reclaim policy -> Retain; record and stop every writer; the source must show no client session;
//                then the source's write counters are recorded (user-table tuple counters, relation files, sequences)
//   dump         free space checked in the Pod and on this machine; final pg_dump -Fc on the source volume, checked with
//                pg_restore --list, copied into the private evidence directory and compared by sha256, then removed
//                from the source volume
//   fingerprint  the source must still be quiet; table rows and content hashes, definitions, ledger, roles,
//                memberships, grants (read-only), and the role dump without passwords
//   create       Setup Secrets (supabase_admin password copied in-process, never printed), temporary source Service,
//                the Cluster; wait for the monolith import (its log must be captured and checked) and for three
//                instances with a synchronous standby
//   repair       memberships, role settings, attributes and schema/database grants the import leaves out
//   parity       the gate: anything outside the explained differences stops here (rollback loses nothing)
//   switch       the source must still be quiet (no session, no counter moved); the Service's selector and ports are
//                recorded, then Service opensphere-supabase-postgres -> {app, cnpg.io/instanceRole: primary},
//                targetPort 5432; one endpoint, the primary; quiet again; the StatefulSet goes to 0 (PVC and PV stay)
//   reopen       the Service must select only the healthy CNPG primary; the point of no return is recorded, then the
//                writers come back as they were
//   verify       PostgREST schema reload, ledger through the CNPG executor path, every writer's role connected, Cluster
//                healthy
//   finalize     the temporary source Service and the import-source Secret are removed
// Rollback (before reopen only) is recorded as RollingBack before it touches anything, and can be re-run until it
// finishes; apply refuses an attempt that is rolling back. It requests hibernation (the CNPG Pods carry the Service's app
// label), restores the recorded selector and ports at once, starts the StatefulSet, checks the ledger, and brings the
// writers back only when the Service's only ready endpoint is the StatefulSet Pod (if hibernation stalls, the CNPG
// instance Pods are deleted). Nothing else is deleted: the hibernated Cluster stays for inspection; `--discard-attempt`
// removes it before a new attempt. The old PVC and PV are never deleted by this command.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, appendFileSync, statfsSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { Worker } from 'node:worker_threads';
import { join, resolve } from 'node:path';
import { run } from './process.mjs';
import { observeInstalledHissTarget } from './prepare-installed-hiss.mjs';
import { createConsoleDbClient, prepareConsoleDb } from './console-db-prepare.mjs';
import { assertInstallationLockRecoveryPrivateDirectory, ensureInstallationLockRecoveryPrivateDirectory } from './installation-lock-recovery-windows-custody.mjs';
import {
  ADMIN_SECRET, CLUSTER_NAME, CONSOLE_DB_SERVICE, CUTOVER_CONFIGMAP, CUTOVER_LOCK, DATA_NAMESPACE, FIELD_MANAGER, IMPORT_SOURCE_SECRET,
  LEGACY_PVC, LEGACY_SELECTOR, LEGACY_SOURCE_SERVICE, LEGACY_STATEFULSET, PRIMARY_SELECTOR, SUPABASE_SECRET,
  assertConsoleDbClusterHealthy, consoleDbSql, consoleDbTarget, observeConsoleDataLayout, renderConsoleDbCluster, renderLegacySourceService,
} from './console-db-cnpg.mjs';
import {
  CONTENT_HASH_LIMIT_BYTES, DEFINITIONS_SQL, FINGERPRINT_SQL, TABLES_SQL, compareParity, contentPlan, parseDefinitions, parseFingerprint, parseRerendered, parseTables,
  rerenderSql, tableDataSql,
} from './console-db-parity.mjs';
import { buildRepairSql } from './console-db-role-repair.mjs';

export const CUTOVER_STEPS = Object.freeze(['freeze', 'dump', 'fingerprint', 'create', 'repair', 'parity', 'switch', 'reopen', 'verify', 'finalize']);
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
const LABELS = Object.freeze({ 'app.kubernetes.io/part-of': 'opensphere-console', 'app.kubernetes.io/managed-by': 'opensphere-setup', 'opensphere.io/authority': 'console-db-cnpg-v1' });
const LEDGER_SQL = "SELECT count(*) || '|' || (SELECT global_id || ' ' || migration_set_digest FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1) FROM console_migration.applied_migration;";

// What a write to the source changes, read-only: tuple counters of every user table (n_tup_ins/upd/del; ANALYZE and
// autovacuum do not move them), every relation's file and catalog row version (TRUNCATE and DDL), every sequence's
// last value, and the tuple counters of any other database. Read after the writers stopped and compared again before
// the fingerprint and around the switch (review 2026-10-27, finding 2). Counters were chosen over a read-only source:
// default_transaction_read_only can be turned off by any session, and a source left read-only by a failed rollback would
// itself be an outage.
export const WRITE_COUNTERS_SQL = `BEGIN TRANSACTION READ ONLY;
SELECT line FROM (
  SELECT 'tables|' || count(*)::text || ' tables, ' || coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text || ' tuples written' AS line FROM pg_stat_user_tables
  UNION ALL SELECT 'relfiles|' || coalesce(md5(string_agg(c.oid::text || ':' || c.relfilenode::text || ':' || c.xmin::text, ',' ORDER BY c.oid)), '')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','S','m','i','v','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
  UNION ALL SELECT 'sequences|' || coalesce(md5(string_agg(schemaname || '.' || sequencename || '=' || coalesce(last_value::text, '-'), ',' ORDER BY schemaname, sequencename)), '')
    FROM pg_sequences
  UNION ALL SELECT 'db|' || datname || '|' || (tup_inserted + tup_updated + tup_deleted)::text
    FROM pg_stat_database WHERE datname IS NOT NULL AND datname NOT IN ('postgres', 'template0', 'template1')
  -- A restart or a statistics reset zeroes the counters above: either one is reported as such (second review, item 6).
  UNION ALL SELECT 'restart|' || pg_postmaster_start_time()::text
  UNION ALL SELECT 'statsreset|' || coalesce((SELECT stats_reset::text FROM pg_stat_database WHERE datname = 'postgres'), 'never')
) x ORDER BY 1;
ROLLBACK;
`;
export function parseWriteCounters(output) {
  return String(output || '').split(/\r?\n/).filter((l) => /^(tables|relfiles|sequences|db|restart|statsreset)\|/.test(l)).join('\n');
}
export function counterChanges(before, after) {
  const map = (text) => new Map(String(text || '').split('\n').filter(Boolean).map((l) => { const i = l.lastIndexOf('|'); return [l.slice(0, i), l.slice(i + 1)]; }));
  const a = map(before), b = map(after);
  const say = { restart: 'the source restarted', statsreset: 'the source statistics were reset' };
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key))
    .map((key) => `${say[key] ? `${say[key]} (the counters no longer prove it unchanged), ` : ''}${key}: ${a.get(key) ?? '-'} -> ${b.get(key) ?? '-'}`);
}
// The catalog lines of a fingerprint (everything except table rows and contents), for the switch-time comparison.
export function catalogLines(text) {
  return String(text || '').split(/\r?\n/).filter((l) => /^[a-z]+\|/.test(l) && !/^(rows|content|table)\|/.test(l)).sort();
}

// Renews the run lock from a worker thread, so a long synchronous kubectl call (a rollout status, a dump copy, the
// content hashes) cannot outlast the Lease (second review, item 4). It stops, and marks the lock lost, as soon as the
// Lease names another holder. Shared flags: [0] 0 running, 1 stop, 2 lost; [1] the last renewal (epoch seconds).
const LEASE_RENEWER = `
const { workerData } = require('node:worker_threads');
const { spawnSync } = require('node:child_process');
const { context, namespace, name, holder, acquireTime, everyMs } = workerData;
const flag = new Int32Array(workerData.flag);
const kubectl = (args, input) => spawnSync('kubectl', ['--context', context, '-n', namespace, ...args], { encoding: 'utf8', input, windowsHide: true, timeout: 20000 });
const micro = () => new Date().toISOString().replace(/\\.(\\d{3})Z$/, '.$1000Z');
let timer = null;
function renew() {
  if (Atomics.load(flag, 0) !== 0) { clearInterval(timer); return; }
  const got = kubectl(['get', 'lease', name, '-o', 'json']);
  if (got.status !== 0) return;
  const lease = JSON.parse(got.stdout);
  if (lease.spec?.holderIdentity !== holder || lease.spec?.acquireTime !== acquireTime) { Atomics.store(flag, 0, 2); clearInterval(timer); return; }
  lease.spec.renewTime = micro();
  if (Atomics.load(flag, 0) !== 0) return;
  const put = kubectl(['replace', '-f', '-', '-o', 'name'], JSON.stringify(lease));
  if (put.status === 0) Atomics.store(flag, 1, Math.floor(Date.now() / 1000));
}
timer = setInterval(renew, everyMs);
`;

const fail = (code, message, evidence) => Object.assign(new Error(message), { code, ...(evidence ? { evidence } : {}) });
const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const json = (text) => (String(text || '').trim() ? JSON.parse(text) : null);
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const sameMap = (a, b) => JSON.stringify(sorted(a || {})) === JSON.stringify(sorted(b || {}));
// Kubernetes MicroTime: RFC 3339 with six fractional digits.
const microTime = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');

// The evidence directory holds the full off-cluster dump: current-user-only (the recovery-key custody helper on
// Windows, 0700 elsewhere). A directory that already has that ACL (a resumed run) is only checked: setting it again
// needs SeSecurityPrivilege (lab 2026-10-27).
export function ensurePrivateEvidenceDirectory(dir, { platform = process.platform, windowsCustody = ensureInstallationLockRecoveryPrivateDirectory,
  windowsCheck = assertInstallationLockRecoveryPrivateDirectory } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') {
    try { return { custody: 'windows-acl', ...windowsCheck(dir) }; } catch { /* not yet owner-only: set it */ }
    try { return { custody: 'windows-acl', ...windowsCustody(dir) }; } catch (error) {
      // Set-Acl cannot make every volume owner-only (lab 2026-10-27: a data drive refused SetOwner); nothing is dumped.
      const why = String(error?.message || '').match(/Attempted to perform an unauthorized operation|recovery directory[^'<_]*/)?.[0] || 'the ACL helper failed';
      throw fail('EVIDENCE_CUSTODY', `The evidence directory ${dir} cannot be made current-user-only (${why}). `
        + 'Choose a directory on a local volume where you own new folders, for example under %LOCALAPPDATA%.');
    }
  }
  chmodSync(dir, 0o700);
  return { custody: 'posix-0700' };
}
const localFreeBytes = (dir) => { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); };

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
  log = (line) => console.log(line), extraWriters = [], acceptedPrerequisites = [], copyOut = copyFromPod, timeouts = {},
  holder = `${hostname()}/${process.pid}/${randomBytes(4).toString('hex')}`, breakLock = null, lockSeconds = 1800,
  privateDirectory = ensurePrivateEvidenceDirectory, freeBytes = localFreeBytes, contentHashLimitBytes = CONTENT_HASH_LIMIT_BYTES,
  backgroundRenewal = runner === run } = {}) {
  const k = createConsoleDbClient(context, runner);
  const T = { connections: 180_000, import: 3_600_000, ready: 1_800_000, rollout: 900_000, connect: 600_000, hibernate: 180_000, endpoints: 120_000, ...timeouts };
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

  // ---- run lock (review finding 8) -------------------------------------------------------------------------------
  // A Lease in the data namespace. Setup runs with the administrator kubeconfig, which may write Leases there; the
  // operator fence keeps the CNPG operator off this name.
  let lease = null, renewer = null, flags = null;
  const renewEvery = Math.max(1000, Math.min(60_000, Math.floor(lockSeconds * 1000 / 3)));
  const leaseDoc = (spec, resourceVersion) => ({ apiVersion: 'coordination.k8s.io/v1', kind: 'Lease',
    metadata: { name: CUTOVER_LOCK, namespace: DATA_NAMESPACE, labels: { ...LABELS }, ...(resourceVersion ? { resourceVersion } : {}) }, spec });
  const writeLease = (verb, spec, resourceVersion) => {
    const out = json(k([verb, '-f', '-', '-o', 'json'], { input: `${JSON.stringify(leaseDoc(spec, resourceVersion))}\n` }));
    return out?.metadata?.resourceVersion;
  };
  const readLease = () => get(ns(['get', 'lease', CUTOVER_LOCK]));
  const ours = (live) => Boolean(lease && live && live.spec?.holderIdentity === holder && live.spec?.acquireTime === lease.spec.acquireTime
    && now() <= (Date.parse(live.spec?.renewTime || '') || 0) + lockSeconds * 1000);
  const lost = (what, live) => fail('CUTOVER_LOCK_LOST', `${what}: the run lock ${DATA_NAMESPACE}/${CUTOVER_LOCK} is no longer held by this run `
    + `(holder ${live?.spec?.holderIdentity ?? 'none'}, renewed ${live?.spec?.renewTime ?? '-'}); nothing more is changed`);
  function acquireLock() {
    const live = readLease();
    const at = now();
    const spec = { holderIdentity: holder, leaseDurationSeconds: lockSeconds, acquireTime: microTime(at), renewTime: microTime(at) };
    if (live) {
      const current = live.spec?.holderIdentity;
      const renewed = Date.parse(live.spec?.renewTime || live.spec?.acquireTime || '') || 0;
      const expired = !current || at > renewed + Number(live.spec?.leaseDurationSeconds || 0) * 1000;
      if (!expired && current !== breakLock) {
        throw fail('CUTOVER_LOCKED', `Another migrate-console-db run holds ${DATA_NAMESPACE}/${CUTOVER_LOCK} (holder ${current}, renewed ${live.spec?.renewTime}). `
          + `Wait for it to finish; if that process is gone, run again with --break-lock ${current}.`);
      }
      if (current && current !== holder) log(`  run lock taken over from ${current} (${expired ? 'expired' : '--break-lock'})`);
      writeLease('replace', spec, live.metadata.resourceVersion);
    } else {
      writeLease('create', spec);
    }
    lease = { spec, renewed: at };
    if (backgroundRenewal) {
      flags = new Int32Array(new SharedArrayBuffer(8));
      renewer = new Worker(LEASE_RENEWER, { eval: true, workerData: { context, namespace: DATA_NAMESPACE, name: CUTOVER_LOCK, holder,
        acquireTime: spec.acquireTime, everyMs: renewEvery, flag: flags.buffer } });
      renewer.unref();
    }
  }
  // Before every change to the cluster: the Lease still names this run (holder and acquire time) and has not expired.
  function assertLockHeld(what) {
    if (flags && Atomics.load(flags, 0) === 2) throw lost(what, readLease());
    const live = readLease();
    if (!ours(live)) { lease = null; throw lost(what, live); }
  }
  // Without the worker (tests), every wait renews in this thread.
  function renewLock(force = false) {
    if (!lease || renewer) return;
    const at = now();
    if (!force && at - lease.renewed < renewEvery) return;
    for (let attempt = 1; ; attempt += 1) {
      const live = readLease();
      if (!ours(live)) { lease = null; throw lost('renewal', live); }
      try { writeLease('replace', { ...live.spec, renewTime: microTime(at) }, live.metadata.resourceVersion); break; } catch (error) {
        if (attempt >= 3) { lease = null; throw lost(`renewal (${String(error?.stderr || error?.message).split('\n')[0]})`, live); }
      }
    }
    lease.renewed = at;
  }
  function releaseLock() {
    if (renewer) { Atomics.store(flags, 0, 1); renewer.terminate(); renewer = null; }
    if (!lease) return;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const live = readLease();
        if (!ours(live)) break;
        writeLease('replace', { leaseDurationSeconds: lockSeconds }, live.metadata.resourceVersion);
        break;
      } catch { /* the worker may have renewed in between; otherwise the Lease expires on its own */ }
    }
    lease = null;
  }
  // The cluster identity is checked before the Lease is written, so a wrong context gets no write at all.
  const locked = (fn) => { assertIdentity(); acquireLock(); try { return fn(); } finally { releaseLock(); } };
  const lockedAsync = async (fn) => { assertIdentity(); acquireLock(); try { return await fn(); } finally { releaseLock(); } };
  const pause = (ms) => { sleep(ms); renewLock(); };
  // Every write to the cluster goes through here (the checkpoint has its own resourceVersion check).
  const mutate = (what, args, options) => { assertLockHeld(what); return k(args, options); };

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
      metadata: { name: CUTOVER_CONFIGMAP, namespace: DATA_NAMESPACE, labels: { ...LABELS },
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
  const writerState = (list = writers) => list.map((w) => {
    const d = get(['-n', w.namespace, 'get', 'deployment', w.name]);
    return d ? { ...w, replicas: Number(d.spec?.replicas ?? 1), selector: d.spec?.selector?.matchLabels || {} } : { ...w, absent: true };
  });
  const scale = (w, replicas) => mutate(`scale ${w.namespace}/${w.name}`, ['-n', w.namespace, 'scale', 'deployment', w.name, `--replicas=${replicas}`]);
  const waitPodsGone = (w) => {
    const selector = Object.entries(w.selector).map(([a, b]) => `${a}=${b}`).join(',');
    if (!selector) throw fail('PRECONDITION_FAILED', `Writer ${w.namespace}/${w.name} has no selector`);
    const deadline = now() + T.rollout;
    while ((JSON.parse(k(['-n', w.namespace, 'get', 'pods', '-l', selector, '-o', 'json'])).items || []).length) {
      if (now() > deadline) throw fail('TIMEOUT', `Pods of ${w.namespace}/${w.name} did not stop`);
      pause(1000);
    }
  };
  const restartWriters = (list) => {
    const present = list.filter((w) => !w.absent);
    for (const w of [...present].reverse()) scale(w, w.replicas);
    renewLock(true);
    for (const w of [...present].reverse()) k(['-n', w.namespace, 'rollout', 'status', `deployment/${w.name}`, `--timeout=${Math.round(T.rollout / 1000)}s`]);
    return present;
  };
  const sourceSessions = () => String(sourceSql("SELECT usename || ' ' || coalesce(application_name, '') || ' ' || coalesce(client_addr::text, 'local') FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid();") || '')
    .split(/\r?\n/).filter(Boolean);
  const writeCounters = () => parseWriteCounters(sourceSql(WRITE_COUNTERS_SQL));
  // The baseline is taken only when two reads 2 s apart agree (a backend that just exited may still be flushing).
  const stableWriteCounters = () => {
    let previous = writeCounters();
    for (let i = 0; i < 10; i += 1) {
      pause(2000);
      const current = writeCounters();
      if (current === previous) return current;
      previous = current;
    }
    throw fail('SOURCE_BUSY', 'The source keeps changing after every writer stopped; something else writes to the Console DB. Stop it (--extra-writer <namespace>/<deployment>) or roll back.');
  };
  // The source must be exactly as it was when the writers stopped: no client session, no counter moved, and (from
  // the switch on) the same catalog as the fingerprint: roles and passwords, memberships, role settings, grants,
  // default privileges, comments, large objects (second review, item 2).
  const assertSourceQuiet = (where, { catalog = false } = {}) => {
    const baseline = checkpoint.state.steps.freeze?.writeCounters;
    if (!baseline) throw fail('PRECONDITION_FAILED', `Attempt ${checkpoint.state.attemptId} recorded no write baseline at freeze; roll back and start a new attempt`);
    const sessions = sourceSessions();
    const moved = counterChanges(baseline, writeCounters());
    if (catalog) {
      const before = catalogLines(readFileSync(evidence('source-fingerprint.txt'), 'utf8'));
      const after = catalogLines(sourceSql(FINGERPRINT_SQL));
      const gone = before.filter((l) => !after.includes(l)), added = after.filter((l) => !before.includes(l));
      if (gone.length || added.length) moved.push(`catalog changed since the fingerprint (${gone.length} line(s) gone, ${added.length} new; first: ${(added[0] || gone[0]).slice(0, 160)})`);
    }
    if (sessions.length || moved.length) {
      throw fail('SOURCE_WRITTEN', `${where}: the source changed after the writers stopped (${[...sessions.map((x) => `session ${x}`), ...moved].join('; ')}). `
        + 'Something else writes to the Console DB; nothing was switched. Roll back (--rollback), find the writer, then start a new attempt with --extra-writer.');
    }
  };
  const fingerprint = (sql, plan) => {
    const tables = contentPlan(parseTables(sql(TABLES_SQL)), { limitBytes: contentHashLimitBytes, plan });
    return { tables, text: `${sql(tableDataSql(tables))}\n${sql(FINGERPRINT_SQL)}` };
  };
  const nodesForInstances = () => JSON.parse(k(['get', 'nodes', '-o', 'json'])).items.filter((n) => (n.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True')
    && !n.spec?.unschedulable && !(n.spec?.taints || []).some((t) => ['NoSchedule', 'NoExecute'].includes(t.effect))).length;
  const readyEndpoints = () => (JSON.parse(k(ns(['get', 'endpointslices', '-l', `kubernetes.io/service-name=${CONSOLE_DB_SERVICE}`, '-o', 'json']))).items || [])
    .flatMap((s) => (s.endpoints || []).filter((e) => e.conditions?.ready !== false).flatMap((e) => e.addresses));
  const waitOnlyEndpoint = (ip, ms, code) => {
    const deadline = now() + ms;
    for (;;) {
      const ready = readyEndpoints();
      if (ready.length === 1 && ready[0] === ip) return true;
      if (now() > deadline) {
        if (code) throw fail(code, `Service endpoints are ${ready.join(',') || 'empty'}, expected only ${ip}`);
        return false;
      }
      pause(1000);
    }
  };
  const podIp = (name) => get(ns(['get', 'pod', name]))?.status?.podIP;
  const legacyDump = () => `/var/lib/postgresql/data/opensphere-console-db-${checkpoint.state.attemptId}.dump`;

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
        mutate('freeze', ['patch', 'pv', pv.metadata.name, '--type=json', '-p', JSON.stringify([{ op: 'test', path: '/metadata/uid', value: pv.metadata.uid },
          { op: 'replace', path: '/spec/persistentVolumeReclaimPolicy', value: 'Retain' }])]);
      }
      const present = checkpoint.state.writers.filter((w) => !w.absent);
      for (const w of present) { scale(w, 0); log(`  stopped ${w.namespace}/${w.name} (was ${w.replicas})`); }
      for (const w of present) waitPodsGone(w);
      const deadline = now() + T.connections;
      let sessions = sourceSessions();
      while (sessions.length && now() < deadline) { pause(2000); sessions = sourceSessions(); }
      if (sessions.length) throw fail('SOURCE_BUSY', `Client sessions remain on the source: ${sessions.join('; ')}. Stop them: re-run with --extra-writer <namespace>/<deployment> (taken before freeze completes), or roll back.`);
      const writeCountersNow = stableWriteCounters();
      return { pvReclaimPolicyBefore: pv.spec.persistentVolumeReclaimPolicy, stopped: present.map((w) => `${w.namespace}/${w.name}`), writeCounters: writeCountersNow };
    },
    dump() {
      const file = legacyDump();
      // Free space (finding 7): the custom-format dump is compressed, so the database size bounds it. A full data
      // volume would stop PostgreSQL, so the Pod needs that much free beside PGDATA, and so does this machine.
      const [kbLine, sizeLine] = String(k(ns(['exec', source.pod, '-c', 'postgres', '--', 'sh', '-ec',
        `df -Pk /var/lib/postgresql/data | awk 'NR==2 {print $4}' && PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U supabase_admin -d postgres -tAc "SELECT pg_database_size('postgres')"`])))
        .trim().split(/\r?\n/);
      const podFree = Number(kbLine) * 1024, dbBytes = Number(sizeLine), needed = Math.ceil(dbBytes * 1.1) + 256 * 1024 ** 2;
      if (!(podFree > needed)) throw fail('INSUFFICIENT_SPACE', `The source volume has ${podFree} bytes free; the dump needs up to ${needed} (database ${dbBytes} bytes). Nothing was dumped.`);
      const localFree = freeBytes(evidenceDir);
      if (!(localFree > needed)) throw fail('INSUFFICIENT_SPACE', `The evidence directory has ${localFree} bytes free; the dump copy needs up to ${needed}. Nothing was dumped.`);
      const removeInPod = () => k(ns(['exec', source.pod, '-c', 'postgres', '--', 'rm', '-f', file]));
      const out = k(ns(['exec', source.pod, '-c', 'postgres', '--', 'sh', '-ec',
        `PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U supabase_admin -d postgres -Fc -f '${file}' && pg_restore --list '${file}' >/dev/null && sha256sum '${file}' && stat -c %s '${file}'`]));
      const [shaLine, bytes] = out.split(/\r?\n/);
      const remote = shaLine.split(/\s+/)[0];
      const local = copyOut({ context, pod: source.pod, container: 'postgres', path: file, file: evidence(`console-db-${checkpoint.state.attemptId}.dump`) });
      const localSha = sha256(readFileSync(local));
      if (localSha !== remote) {
        try { removeInPod(); } catch { /* the mismatch is the error that matters */ }
        throw fail('DUMP_MISMATCH', `Off-cluster dump copy differs (${localSha} != ${remote})`);
      }
      // The verified off-cluster copy is the custody copy; none stays on the source volume (finding 7).
      removeInPod();
      return { offCluster: resolve(local), sha256: remote, bytes: Number(bytes), removedFromSourceVolume: file, sourceVolumeFreeBefore: podFree, databaseBytes: dbBytes };
    },
    fingerprint() {
      assertSourceQuiet('fingerprint');
      const fp = fingerprint(sourceSql, null);
      writeEvidence('source-fingerprint.txt', fp.text);
      writeEvidence('source-tables.json', `${JSON.stringify(fp.tables, null, 1)}\n`);
      writeEvidence('source-definitions.json', `${JSON.stringify(parseDefinitions(sourceSql(DEFINITIONS_SQL)), null, 1)}\n`);
      const roles = k(ns(['exec', source.pod, '-c', 'postgres', '--', 'sh', '-ec', 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dumpall -h 127.0.0.1 -U supabase_admin --roles-only --no-role-passwords']));
      writeEvidence('source-roles.sql', `${roles}\n`);
      const parsed = parseFingerprint(fp.text);
      return { tables: fp.tables.length, contentHashed: fp.tables.filter((t) => t.hashed).length, unhashed: fp.tables.filter((t) => !t.hashed).map((t) => `${t.schema}.${t.name}`),
        ledger: parsed.ledger.get('count'), head: parsed.ledger.get('head'), sha256: sha256(fp.text) };
    },
    create() {
      const encoded = k(ns(['get', 'secret', SUPABASE_SECRET, '-o', 'jsonpath={.data.postgres-password}']));
      if (!encoded) throw fail('PRECONDITION_FAILED', `${SUPABASE_SECRET} has no postgres-password`);
      const username = Buffer.from('supabase_admin').toString('base64');
      const secrets = [
        { apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/basic-auth', metadata: { name: ADMIN_SECRET, namespace: DATA_NAMESPACE, labels: { ...LABELS } }, data: { username, password: encoded } },
        { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: IMPORT_SOURCE_SECRET, namespace: DATA_NAMESPACE, labels: { ...LABELS } }, data: { password: encoded } },
      ];
      const apply = (doc) => mutate('create', ['apply', '--server-side', `--field-manager=${FIELD_MANAGER}`, '-f', '-', '-o', 'name'], { input: `${JSON.stringify(doc)}\n` });
      for (const s of secrets) apply(s);
      apply(renderLegacySourceService());
      const cluster = renderConsoleDbCluster({ storageClass: checkpoint.state.storageClass });
      apply(cluster);
      log('  Cluster applied; waiting for the import');
      const deadline = now() + T.import;
      let job = null, resumedWithoutJob = false;
      for (;;) {
        const pods = JSON.parse(k(ns(['get', 'pods', '-l', `cnpg.io/cluster=${CLUSTER_NAME},cnpg.io/jobRole=import`, '-o', 'json']))).items || [];
        job = pods.find((p) => ['Succeeded', 'Failed'].includes(p.status?.phase));
        if (job) break;
        const c = get(ns(['get', 'clusters.postgresql.cnpg.io', CLUSTER_NAME]));
        if ((c?.status?.readyInstances ?? 0) >= 1 && !pods.length) { resumedWithoutJob = true; break; } // CNPG removed the import Job
        if (now() > deadline) throw fail('TIMEOUT', 'The CloudNativePG import did not finish');
        pause(2000);
      }
      let logs;
      if (job) {
        // CNPG deletes the import Job once the Cluster is up; keep its log now (lab §2.3).
        logs = k(ns(['logs', job.metadata.name, '--all-containers']));
        writeEvidence('import.log', `${logs}\n`);
        writeEvidence('import-capture.json', `${JSON.stringify({ pod: job.metadata.name, phase: job.status.phase, sha256: sha256(`${logs}\n`), at: new Date(now()).toISOString() }, null, 1)}\n`);
        if (job.status.phase === 'Failed') throw fail('IMPORT_FAILED', `The import Job failed; see ${evidence('import.log')}`);
      } else if (resumedWithoutJob) {
        // Finding 3: never continue without having read the import's errors. A log captured by an earlier run of this
        // attempt counts only if it belongs to a succeeded import Pod and is unchanged on disk.
        const capture = existsSync(evidence('import-capture.json')) ? JSON.parse(readFileSync(evidence('import-capture.json'), 'utf8')) : null;
        const saved = existsSync(evidence('import.log')) ? readFileSync(evidence('import.log'), 'utf8') : null;
        if (!capture || capture.phase !== 'Succeeded' || saved === null || sha256(saved) !== capture.sha256) {
          throw fail('IMPORT_LOG_MISSING', `CloudNativePG removed the import Job before Setup read its log, so the import cannot be checked for errors. `
            + `Nothing was switched: roll back (--rollback), --discard-attempt ${checkpoint.state.attemptId}, and start a new attempt.`);
        }
        logs = saved;
      }
      const importErrors = classifyImportErrors(logs);
      writeEvidence('import-errors.json', `${JSON.stringify(importErrors, null, 1)}\n`);
      if (importErrors.unexpected.length) throw fail('IMPORT_ERRORS', `The import reported ${importErrors.unexpected.length} unexpected error(s); see ${evidence('import-errors.json')}`);
      const readyDeadline = now() + T.ready;
      for (;;) {
        const c = get(ns(['get', 'clusters.postgresql.cnpg.io', CLUSTER_NAME]));
        if (c?.status?.readyInstances === 3 && c.status.currentPrimary && c.status.currentPrimary === c.status.targetPrimary) {
          const sync = Number(targetSuperSql("SELECT count(*) FROM pg_stat_replication WHERE sync_state IN ('quorum','sync');").trim());
          if (sync >= 1) return { primary: c.status.currentPrimary, readyInstances: 3, synchronousStandbys: sync, importErrors: { expected: importErrors.expected.length } };
        }
        if (now() > readyDeadline) throw fail('TIMEOUT', 'The Cluster did not reach three ready instances with a synchronous standby');
        pause(3000);
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
      const plan = JSON.parse(readFileSync(evidence('source-tables.json'), 'utf8'));
      const fp = fingerprint((sql) => targetSuperSql(sql), plan);
      writeEvidence('target-fingerprint.txt', fp.text);
      const source = parseFingerprint(readFileSync(evidence('source-fingerprint.txt'), 'utf8'));
      const targetFp = parseFingerprint(fp.text);
      let result = compareParity(source, targetFp);
      // CHECKs and views whose text differs: parse the source text on the target (rolled back) and compare renders.
      const differing = new Set(result.differences.map((d) => d.what.replace(/^def\|/, '')).filter((key) => /^(constraint|view)\|/.test(key)));
      if (differing.size) {
        const items = JSON.parse(readFileSync(evidence('source-definitions.json'), 'utf8')).filter((d) => differing.has(d.key));
        const rerendered = items.length ? parseRerendered(targetSuperSql(rerenderSql(items))) : new Map();
        writeEvidence('rerender.json', `${JSON.stringify([...differing].map((key) => ({ key, sourceText: items.some((d) => d.key === key),
          rerendered: rerendered.get(key) ?? null, target: targetFp.def.get(key) ?? null, same: rerendered.get(key) === targetFp.def.get(key) })), null, 1)}\n`);
        result = compareParity(source, targetFp, { rerendered });
      }
      writeEvidence('parity.json', `${JSON.stringify(result, null, 1)}\n`);
      if (!result.ok) throw fail('PARITY_FAILED', `Parity failed on ${result.differences.length} item(s); nothing was switched. See ${evidence('parity.json')}`);
      return { ...result.compared, unhashed: result.compared.unhashed.length, explained: result.explained.length };
    },
    switch() {
      const svc = JSON.parse(k(ns(['get', 'service', CONSOLE_DB_SERVICE, '-o', 'json'])));
      if (!sameMap(svc.spec.selector, PRIMARY_SELECTOR)) {
        if (!sameMap(svc.spec.selector, LEGACY_SELECTOR)) throw fail('PRECONDITION_FAILED', `Service ${CONSOLE_DB_SERVICE} has an unexpected selector`);
        // Finding 2: nothing may have written to the source since freeze, or it would be lost.
        assertSourceQuiet('switch', { catalog: true });
        // Finding 6: what rollback restores, exactly.
        if (!checkpoint.state.service) save((s) => { s.service = { uid: svc.metadata.uid, selector: svc.spec.selector, ports: svc.spec.ports }; });
        mutate('switch', ns(['patch', 'service', CONSOLE_DB_SERVICE, '--type=json', '-p', JSON.stringify([
          { op: 'test', path: '/metadata/uid', value: svc.metadata.uid },
          { op: 'test', path: '/spec/selector', value: svc.spec.selector },
          { op: 'replace', path: '/spec/selector', value: { ...PRIMARY_SELECTOR } },
          { op: 'replace', path: '/spec/ports', value: [{ name: 'postgres', port: 5432, protocol: 'TCP', targetPort: 5432 }] }])]));
      } else if (!checkpoint.state.service) {
        throw fail('PRECONDITION_FAILED', `Service ${CONSOLE_DB_SERVICE} already selects the CNPG primary, but attempt ${checkpoint.state.attemptId} recorded no original selector and ports`);
      }
      const primary = primaryPod();
      const ip = podIp(primary);
      waitOnlyEndpoint(ip, T.endpoints, 'SWITCH_INCOMPLETE');
      // Writes that reached the source directly (its Pod IP, the temporary Service) before it stops.
      if (get(ns(['get', 'pod', `${LEGACY_STATEFULSET}-0`]))) assertSourceQuiet('switch (after the Service moved)', { catalog: true });
      mutate('switch', ns(['scale', 'statefulset', LEGACY_STATEFULSET, '--replicas=0']));
      const gone = now() + T.rollout;
      while (get(ns(['get', 'pod', `${LEGACY_STATEFULSET}-0`]))) { if (now() > gone) throw fail('TIMEOUT', 'The StatefulSet Pod did not stop'); pause(1000); }
      save((s) => { s.state = 'Switched'; });
      return { primary, endpoint: ip };
    },
    reopen() {
      // Finding 1: writers come back only onto the healthy CNPG primary, whatever happened since switch.
      const svc = JSON.parse(k(ns(['get', 'service', CONSOLE_DB_SERVICE, '-o', 'json'])));
      const port = (svc.spec.ports || []).find((p) => p.port === 5432);
      if (!sameMap(svc.spec.selector, PRIMARY_SELECTOR) || port?.targetPort !== 5432) {
        throw fail('REOPEN_REFUSED', `Service ${CONSOLE_DB_SERVICE} does not select the CloudNativePG primary on 5432; the writers stay stopped`);
      }
      const cluster = get(ns(['get', 'clusters.postgresql.cnpg.io', CLUSTER_NAME]));
      if (!cluster || cluster.metadata?.annotations?.['cnpg.io/hibernation'] === 'on') throw fail('REOPEN_REFUSED', `Cluster ${CLUSTER_NAME} is missing or hibernated; the writers stay stopped`);
      assertConsoleDbClusterHealthy(cluster, { storageClass: checkpoint.state.storageClass });
      if (get(ns(['get', 'pod', `${LEGACY_STATEFULSET}-0`]))) throw fail('REOPEN_REFUSED', 'The StatefulSet Pod is running again; the writers stay stopped');
      const primary = primaryPod();
      if (!waitOnlyEndpoint(podIp(primary), T.endpoints, null)) throw fail('REOPEN_REFUSED', `The Service's only ready endpoint is not the primary ${primary}; the writers stay stopped`);
      // Point of no return: from here, writes land only on CNPG and rollback is a new dump.
      assertLockHeld('reopen');
      save((s) => { s.state = 'Reopened'; });
      const started = restartWriters(checkpoint.state.writers);
      return { primary, started: started.map((w) => `${w.namespace}/${w.name}=${w.replicas}`) };
    },
    verify() {
      const t = target();
      consoleDbSql(k, t, "NOTIFY pgrst, 'reload schema';", { transaction: true });
      const ledger = consoleDbSql(k, t, LEDGER_SQL).trim();
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
        pause(2000);
      }
      const health = assertConsoleDbClusterHealthy(get(ns(['get', 'clusters.postgresql.cnpg.io', CLUSTER_NAME])), { storageClass: checkpoint.state.storageClass });
      return { ledger, connectedRoles: roles, cluster: health };
    },
    finalize() {
      // The import is over: its source Service and Secret go (lab: the Cluster stays healthy without them).
      mutate('finalize', ns(['delete', 'service', LEGACY_SOURCE_SERVICE, '--ignore-not-found']));
      mutate('finalize', ns(['delete', 'secret', IMPORT_SOURCE_SECRET, '--ignore-not-found']));
      save((s) => { s.state = 'Completed'; });
      return { removed: [`Service/${LEGACY_SOURCE_SERVICE}`, `Secret/${IMPORT_SOURCE_SECRET}`],
        kept: [`StatefulSet/${LEGACY_STATEFULSET} (0)`, `PVC/${LEGACY_PVC}`, `PV/${checkpoint.state.source.pv} (Retain)`] };
    },
  };

  async function applySteps(until) {
    if (!CUTOVER_STEPS.includes(until)) throw fail('INVALID_INPUT', `--until must be one of ${CUTOVER_STEPS.join(', ')}`);
    checkpoint = readCheckpoint();
    if (checkpoint && ['Completed'].includes(checkpoint.state.state)) return { state: checkpoint.state, done: true };
    if (checkpoint && checkpoint.state.state === 'RolledBack') throw fail('PRECONDITION_FAILED', `Attempt ${checkpoint.state.attemptId} was rolled back; inspect it, then --discard-attempt ${checkpoint.state.attemptId}`);
    if (checkpoint && checkpoint.state.state === 'RollingBack') throw fail('PRECONDITION_FAILED', `Attempt ${checkpoint.state.attemptId} is rolling back; run --rollback again to finish it`);
    if (checkpoint && checkpoint.state.clusterUid !== clusterUid) throw fail('PRECONDITION_FAILED', 'The checkpoint belongs to another cluster');
    if (!checkpoint || checkpoint.state.state === 'Discarded') {
      const p = preflight();
      writeEvidence('preflight.json', `${JSON.stringify(p, null, 1)}\n`);
      if (!p.ok) throw fail('PREFLIGHT_FAILED', `Preflight failed: ${p.checks.filter((c) => !c.ok).map((c) => `${c.id} (${c.detail})`).join('; ')}`, p);
      // The fence must be in deny mode for a cutover: prepareConsoleDb's default.
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
      // Finding 9: --extra-writer on a resume is taken while the writers have not all been stopped yet.
      const known = (w) => checkpoint.state.writers.some((x) => x.namespace === w.namespace && x.name === w.name);
      const added = parseExtraWriters(extraWriters).filter((w) => !known(w));
      if (added.length) {
        if (checkpoint.state.steps.freeze) throw fail('INVALID_INPUT', `Attempt ${checkpoint.state.attemptId} already froze its writers; --extra-writer ${added.map((w) => `${w.namespace}/${w.name}`).join(', ')} cannot join it. Roll back and start a new attempt.`);
        const observed = writerState(added);
        save((s) => { s.writers.push(...observed); });
        log(`  added writers: ${observed.map((w) => `${w.namespace}/${w.name}${w.absent ? ' (absent)' : ` (${w.replicas})`}`).join(', ')}`);
      }
      log(`attempt ${checkpoint.state.attemptId} resumes (${checkpoint.state.state})`);
    }
    for (const step of CUTOVER_STEPS) {
      if (checkpoint.state.steps[step]) continue;
      renewLock(true);
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
  }

  function rollbackSteps() {
    checkpoint = readCheckpoint();
    if (!checkpoint) throw fail('PRECONDITION_FAILED', 'No cutover to roll back');
    assertIdentity();
    const s = checkpoint.state;
    if (!['InProgress', 'Switched', 'RollingBack'].includes(s.state) || s.steps.reopen) {
      throw fail('ROLLBACK_REFUSED', `Attempt ${s.attemptId} is ${s.state}; after reopen the way back is a new dump of the CloudNativePG database (design §1.6)`);
    }
    if (existsSync(evidenceDir)) timeline({ step: 'rollback', event: 'start' });
    // Finding 1: recorded before anything changes, so a failed rollback is never resumed as a cutover.
    if (s.state !== 'RollingBack') save((x) => { x.rollingBackFrom = x.state; x.state = 'RollingBack'; x.rollback = { startedAt: new Date(now()).toISOString(), actions: [] }; });
    const started = now();
    const act = (what) => { save((x) => { x.rollback.actions.push({ at: new Date(now()).toISOString(), what }); }); log(`  ${what}`); };
    // 1. The CNPG instances stop serving: they carry the Service's app label.
    const cluster = get(ns(['get', 'clusters.postgresql.cnpg.io', CLUSTER_NAME]));
    if (cluster && cluster.metadata?.annotations?.['cnpg.io/hibernation'] !== 'on') {
      mutate('rollback', ns(['annotate', 'clusters.postgresql.cnpg.io', CLUSTER_NAME, 'cnpg.io/hibernation=on', '--overwrite']));
      act('requested hibernation of the Cluster');
    }
    // 2. The old path at once (finding 6): the recorded selector and ports, the StatefulSet. The writers stay stopped
    // until the Service's only ready endpoint is the StatefulSet Pod.
    const svc = JSON.parse(k(ns(['get', 'service', CONSOLE_DB_SERVICE, '-o', 'json'])));
    if (!sameMap(svc.spec.selector, LEGACY_SELECTOR)) {
      const original = checkpoint.state.service;
      if (!original?.ports || !sameMap(original.selector, LEGACY_SELECTOR)) {
        throw fail('ROLLBACK_INCOMPLETE', `Service ${CONSOLE_DB_SERVICE} was changed but attempt ${s.attemptId} recorded no original selector and ports; restore it by hand, then run --rollback again`);
      }
      mutate('rollback', ns(['patch', 'service', CONSOLE_DB_SERVICE, '--type=json', '-p', JSON.stringify([
        { op: 'test', path: '/metadata/uid', value: svc.metadata.uid },
        { op: 'replace', path: '/spec/selector', value: original.selector },
        { op: 'replace', path: '/spec/ports', value: original.ports }])]));
      act('restored the recorded Service selector and ports');
    }
    mutate('rollback', ns(['scale', 'statefulset', LEGACY_STATEFULSET, '--replicas=1']));
    renewLock(true);
    k(ns(['rollout', 'status', `statefulset/${LEGACY_STATEFULSET}`, `--timeout=${Math.round(T.rollout / 1000)}s`]));
    act('started the StatefulSet');
    if (s.steps.fingerprint) {
      const ledger = sourceSql(LEDGER_SQL).trim();
      if (ledger !== `${s.steps.fingerprint.ledger}|${s.steps.fingerprint.head}`) throw fail('ROLLBACK_INCOMPLETE', `The source ledger is ${ledger}; the writers stay stopped`);
    }
    // A dump an interrupted dump step left on the source volume.
    try { k(ns(['exec', source.pod, '-c', 'postgres', '--', 'rm', '-f', legacyDump()])); } catch { /* best effort; the path is recorded */ }
    // 3. Gate: only the StatefulSet Pod serves. If hibernation stalls (operator down, Pods stuck), the CNPG instance
    // Pods are deleted; hibernation stays requested, so the operator does not recreate them.
    const ip = podIp(`${LEGACY_STATEFULSET}-0`);
    if (!waitOnlyEndpoint(ip, T.hibernate, null)) {
      // Every Pod of the Cluster, instance or Job (an import or join Pod carries the Service's label too).
      mutate('rollback', ns(['delete', 'pods', '-l', `cnpg.io/cluster=${CLUSTER_NAME}`, '--wait=false', '--ignore-not-found']));
      act('hibernation did not stop the CNPG Pods in time; deleted every Pod of the Cluster');
      waitOnlyEndpoint(ip, T.hibernate, 'ROLLBACK_INCOMPLETE');
    }
    act(`the Service's only ready endpoint is the StatefulSet Pod ${ip}`);
    restartWriters(s.writers);
    act('started the writers');
    mutate('rollback', ns(['delete', 'service', LEGACY_SOURCE_SERVICE, '--ignore-not-found']));
    save((x) => { x.state = 'RolledBack'; x.rollback.at = new Date(now()).toISOString(); x.rollback.ms = now() - started; });
    if (existsSync(evidenceDir)) timeline({ step: 'rollback', event: 'done', ms: now() - started });
    return { state: checkpoint.state, ms: now() - started, actions: checkpoint.state.rollback.actions.map((a) => a.what) };
  }

  return {
    preflight,
    status() { const c = readCheckpoint(); return c ? c.state : null; },
    // Plan, or apply up to and including `until`.
    async apply({ until = 'finalize' } = {}) {
      privateDirectory(evidenceDir);
      return lockedAsync(() => applySteps(until));
    },
    rollback() {
      return locked(() => rollbackSteps());
    },
    discard(attemptId) {
      return locked(() => {
        checkpoint = readCheckpoint();
        if (!checkpoint || checkpoint.state.state !== 'RolledBack') throw fail('PRECONDITION_FAILED', 'Only a rolled-back attempt can be discarded');
        if (attemptId !== checkpoint.state.attemptId) throw fail('PRECONDITION_FAILED', `--discard-attempt must name ${checkpoint.state.attemptId}`);
        assertIdentity();
        // The hibernated Cluster holds only the imported copy; CNPG removes its PVCs and Secrets with it.
        mutate('discard', ns(['delete', 'clusters.postgresql.cnpg.io', CLUSTER_NAME, '--ignore-not-found', '--wait=true']));
        mutate('discard', ns(['delete', 'secret', ADMIN_SECRET, IMPORT_SOURCE_SECRET, '--ignore-not-found']));
        save((x) => { x.state = 'Discarded'; x.discardedAt = new Date(now()).toISOString(); });
        return { state: checkpoint.state };
      });
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
