import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aclReplayStatements, buildRepairSql, effectiveGrants, parseAcl, roleRepairStatements } from '../src/console-db-role-repair.mjs';
import { FINGERPRINT_SQL, TABLES_SQL, compareParity, parseFingerprint, parseTables, rowCountSql } from '../src/console-db-parity.mjs';
import { CONSOLE_DB_WRITERS, CUTOVER_STEPS, classifyImportErrors, createCutover, parseExtraWriters } from '../src/console-db-cutover.mjs';
import { CUTOVER_CONFIGMAP, DATA_NAMESPACE } from '../src/console-db-cnpg.mjs';

// R2-C2 scope 3: post-import repair (lab breaks X2, X3), the parity gate, and the resumable cutover with rollback.
const ROLES = [
  'CREATE ROLE anon;',
  'ALTER ROLE anon WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;',
  'ALTER ROLE postgres WITH NOSUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS;',
  'ALTER ROLE supabase_admin WITH SUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS;',
  'ALTER ROLE supabase_etl_admin WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN REPLICATION BYPASSRLS;',
  "ALTER ROLE authenticator SET session_preload_libraries TO 'supautils', 'safeupdate';",
  "ALTER ROLE authenticator SET statement_timeout TO '8s';",
  "ALTER ROLE supabase_admin SET search_path TO '$user', 'public', 'auth', 'extensions';",
  "ALTER ROLE postgres SET search_path TO '$user', 'public', 'extensions';",
  'GRANT anon TO authenticator WITH INHERIT TRUE GRANTED BY supabase_admin;',
  'GRANT console_api TO opensphere_console_api_runtime WITH INHERIT TRUE GRANTED BY supabase_admin;',
  'GRANT anon TO postgres WITH ADMIN OPTION, INHERIT TRUE GRANTED BY supabase_admin;',
  'GRANT "weird""role" TO "x y" GRANTED BY "supabase_admin";',
].join('\n');

test('role repair: memberships without GRANTED BY, settings and attributes; postgres untouched; preload dropped', () => {
  const r = roleRepairStatements(ROLES);
  assert.deepEqual(r.counts, { grants: 3, settings: 2, attributes: 2, dropped: 1 });
  assert.ok(r.statements.includes('GRANT anon TO authenticator WITH INHERIT TRUE;'));
  assert.ok(r.statements.includes('GRANT console_api TO opensphere_console_api_runtime WITH INHERIT TRUE;'));
  assert.ok(r.statements.includes('GRANT "weird""role" TO "x y";'));
  assert.ok(!r.statements.some((s) => /postgres WITH|TO postgres|ROLE postgres/.test(s)), 'never touches postgres');
  assert.ok(!r.statements.some((s) => /^ALTER ROLE supabase_admin WITH/.test(s)), 'supabase_admin keeps its attributes');
  assert.ok(r.statements.some((s) => /^ALTER ROLE supabase_admin SET search_path/.test(s)));
  assert.ok(!r.statements.some((s) => /session_preload_libraries/.test(s)));
  assert.equal(roleRepairStatements(ROLES, { withoutSessionPreload: false }).counts.settings, 3);
});

test('ACLs: parsing, implicit owner rights and defaults, and the replay that restores lost schema grants', () => {
  assert.deepEqual(parseAcl('{=Tc/postgres,postgres=CTc/postgres}').map((i) => i.grantee), ['', 'postgres']);
  assert.equal(parseAcl('NULL'), null);
  assert.deepEqual([...effectiveGrants('database', 'postgres', 'NULL')].sort(), ['PUBLIC:T', 'PUBLIC:c']);
  assert.deepEqual([...effectiveGrants('function', 'a', 'NULL')], ['PUBLIC:X']);
  assert.deepEqual([...effectiveGrants('schema', 'supabase_admin', '{supabase_admin=UC/supabase_admin,anon=U/supabase_admin,postgres=U*/supabase_admin}')].sort(), ['anon:U', 'postgres:U*']);
  // Lab §2.4: graphql/graphql_public lost USAGE for anon/authenticated/service_role and postgres WITH GRANT OPTION.
  assert.deepEqual(aclReplayStatements({ kind: 'schema', name: 'graphql', sourceOwner: 'supabase_admin', targetOwner: 'supabase_admin',
    sourceAcl: '{supabase_admin=UC/supabase_admin,anon=U/supabase_admin,postgres=U*/supabase_admin}', targetAcl: 'NULL' }),
  ['GRANT USAGE ON SCHEMA "graphql" TO "anon";', 'GRANT USAGE ON SCHEMA "graphql" TO "postgres" WITH GRANT OPTION;']);
  // A source that revoked PUBLIC from the database keeps it revoked on the target.
  assert.deepEqual(aclReplayStatements({ kind: 'database', name: 'postgres', sourceOwner: 'postgres', targetOwner: 'postgres',
    sourceAcl: '{postgres=CTc/postgres,console_api=c/postgres}', targetAcl: 'NULL' }),
  ['REVOKE TEMPORARY ON DATABASE "postgres" FROM PUBLIC;', 'REVOKE CONNECT ON DATABASE "postgres" FROM PUBLIC;', 'GRANT CONNECT ON DATABASE "postgres" TO "console_api";']);
  const source = parseFingerprint('acl|schema|graphql|supabase_admin|{supabase_admin=UC/supabase_admin,anon=U/supabase_admin}\nacl|database|postgres|postgres|NULL\n');
  const target = parseFingerprint('acl|schema|graphql|supabase_admin|NULL\nacl|database|postgres|postgres|NULL\n');
  const repair = buildRepairSql(ROLES, { source, target });
  assert.match(repair.sql, /^-- Console DB post-import repair[\s\S]*BEGIN;[\s\S]*SET LOCAL ROLE "supabase_admin";\nGRANT USAGE ON SCHEMA "graphql" TO "anon";\nRESET ROLE;\nCOMMIT;\n$/);
  assert.equal(repair.counts.aclStatements, 1);
});

const FP = (extra = '') => [
  'rows|console_operation.x|10', 'rows|vault.secrets|0', 'rows|auth.users|20',
  'ledger|count|137', 'ledger|head|opensphere-console/20261026/0151 sha256:781b', 'ledger|md5|abc',
  'role|anon|super=false,inherit=true,pw=-', 'role|postgres|super=false,pw=1111', 'role|supabase_admin|super=true,inherit=true,pw=aaaa',
  'role|authenticator|super=false,inherit=false,pw=bbbb',
  'member|anon>authenticator|admin=false,inherit=true,set=true', 'member|anon>postgres|admin=true,inherit=true,set=true',
  "setting|*|authenticator|session_preload_libraries=supautils, safeupdate;statement_timeout=8s",
  'setting|*|postgres|search_path=x',
  'ext|vector|0.8.2|extensions|supabase_admin', 'ext|supabase_vault|0.3.1|vault|supabase_admin', 'ext|pgcrypto|1.3|extensions|postgres',
  'db|postgres|owner=postgres provider=i locale=en-US collate=en_US.UTF-8 ctype=en_US.UTF-8 encoding=UTF8',
  'acl|database|postgres|postgres|NULL',
  'acl|schema|graphql|supabase_admin|{supabase_admin=UC/supabase_admin,anon=U/supabase_admin}',
  'acl|schema|vault|supabase_admin|NULL',
  'acl|rel|console_operation.x:r|supabase_admin|{supabase_admin=arwdDxtm/supabase_admin,console_api=r/supabase_admin}',
  'acl|rel|extensions.pg_stat_statements:v|supabase_admin|{=r/supabase_admin,postgres=arwdDxtm/supabase_admin}',
  'acl|func|console_operation.f()|supabase_admin|NULL',
  'func|console_operation|3 secdef=1 src=111', 'func|vault|5 secdef=2 src=222', 'func|extensions|170 secdef=0 src=333',
  'policy|console_operation.x.p|aaa', 'trigger|console_operation.x.t|bbb enabled=O',
  'evtrigger|pgrst_ddl_watch|ddl_command_end owner=supabase_admin enabled=O func=extensions.pgrst_ddl_watch',
  extra,
].join('\n');
const TARGET = (extra = '') => [
  'rows|console_operation.x|10', 'rows|auth.users|20',
  'ledger|count|137', 'ledger|head|opensphere-console/20261026/0151 sha256:781b', 'ledger|md5|abc',
  'role|anon|super=false,inherit=true,pw=-', 'role|postgres|super=true,pw=-', 'role|supabase_admin|super=true,inherit=true,pw=cccc',
  'role|authenticator|super=false,inherit=false,pw=bbbb', 'role|streaming_replica|super=false,repl=true,pw=-', 'role|cnpg_metrics_exporter|super=false,pw=-',
  'member|anon>authenticator|admin=false,inherit=true,set=true', 'member|pg_monitor>cnpg_metrics_exporter|admin=false,inherit=true,set=true',
  'setting|*|authenticator|statement_timeout=8s',
  'ext|vector|0.8.7|extensions|postgres', 'ext|pgcrypto|1.3|extensions|postgres',
  'db|postgres|owner=postgres provider=i locale=en-US collate=en_US.UTF-8 ctype=en_US.UTF-8 encoding=UTF8',
  'acl|database|postgres|postgres|{=Tc/postgres,postgres=CTc/postgres}',
  'acl|schema|graphql|supabase_admin|{supabase_admin=UC/supabase_admin,anon=U/supabase_admin}',
  'acl|rel|console_operation.x:r|supabase_admin|{console_api=r/supabase_admin}',
  'acl|rel|extensions.pg_stat_statements:v|postgres|{=r/postgres}',
  'acl|func|console_operation.f()|supabase_admin|{=X/supabase_admin}',
  'func|console_operation|3 secdef=1 src=111', 'func|extensions|170 secdef=0 src=999',
  'policy|console_operation.x.p|aaa', 'trigger|console_operation.x.t|bbb enabled=O',
  'evtrigger|pgrst_ddl_watch|ddl_command_end owner=supabase_admin enabled=O func=extensions.pgrst_ddl_watch',
  extra,
].join('\n');

test('parity: only the explained differences pass', () => {
  const result = compareParity(parseFingerprint(FP()), parseFingerprint(TARGET()));
  assert.deepEqual(result.differences, []);
  assert.equal(result.ok, true);
  const reasons = result.explained.map((e) => e.what).sort();
  for (const what of ['rows|vault.secrets', 'role|supabase_admin', 'role|streaming_replica', 'ext|vector', 'ext|supabase_vault',
    'setting|*|authenticator', 'member|anon>postgres', 'func|vault', 'acl|schema|vault']) assert.ok(reasons.includes(what), what);
});

test('parity: a lost row, membership, setting, owner or grant, or an event trigger owner change stops the cutover', () => {
  const bad = [
    [FP(), TARGET().replace('rows|auth.users|20', 'rows|auth.users|19'), 'rows|auth.users'],
    [FP(), TARGET().replace('member|anon>authenticator|admin=false,inherit=true,set=true\n', ''), 'member|anon>authenticator'],
    [FP(), TARGET().replace('setting|*|authenticator|statement_timeout=8s', 'setting|*|authenticator|'), 'setting|*|authenticator'],
    [FP(), TARGET().replace('acl|rel|console_operation.x:r|supabase_admin|{console_api=r/supabase_admin}', 'acl|rel|console_operation.x:r|postgres|{console_api=r/supabase_admin}'), 'acl|rel|console_operation.x:r'],
    [FP(), TARGET().replace('{console_api=r/supabase_admin}', 'NULL'), 'acl|rel|console_operation.x:r'],
    [FP(), TARGET().replace('ledger|md5|abc', 'ledger|md5|abd'), 'ledger|md5'],
    [FP(), TARGET().replace('ext|vector|0.8.7', 'ext|vector|0.8.1'), 'ext|vector'],
    [FP(), TARGET().replace('role|supabase_admin|super=true', 'role|supabase_admin|super=false'), 'role|supabase_admin'],
    [FP('rows|console_audit.e|5'), TARGET(), 'rows|console_audit.e'],
    [FP().replace('owner=supabase_admin enabled', 'owner=postgres enabled'), TARGET().replace('owner=supabase_admin enabled', 'owner=postgres enabled'), 'evtrigger|pgrst_ddl_watch'],
  ];
  for (const [s, t, what] of bad) {
    const r = compareParity(parseFingerprint(s), parseFingerprint(t));
    assert.equal(r.ok, false, what);
    assert.ok(r.differences.some((d) => d.what === what), `${what}: ${JSON.stringify(r.differences)}`);
  }
});

test('parity SQL: read-only, no XML function, quoted identifiers in the row counts', () => {
  for (const sql of [TABLES_SQL, FINGERPRINT_SQL]) {
    assert.match(sql, /BEGIN TRANSACTION READ ONLY;/);
    assert.match(sql, /ROLLBACK;\n$/);
    assert.doesNotMatch(sql, /xml/i);
  }
  const tables = parseTables('BEGIN\ntable|osaa|runtime_event\ntable|we"ird|t\nROLLBACK');
  assert.deepEqual(tables, [{ schema: 'osaa', name: 'runtime_event' }, { schema: 'we"ird', name: 't' }]);
  const sql = rowCountSql(tables);
  assert.match(sql, /FROM "osaa"\."runtime_event"/);
  assert.match(sql, /FROM "we""ird"\."t"/);
  assert.doesNotMatch(sql, /xml/i);
});

test('import log: only the replayed-membership refusals are expected', () => {
  const lines = [
    JSON.stringify({ level: 'info', logger: 'postgres', msg: 'record', record: { error_severity: 'ERROR', command_tag: 'GRANT ROLE', message: 'permission denied to grant privileges as role "supabase_admin"' } }),
    JSON.stringify({ level: 'error', msg: 'while importing role inheritance', error: 'ERROR: permission denied to grant privileges as role "supabase_admin" (SQLSTATE 42501)' }),
    JSON.stringify({ level: 'info', logger: 'pg_dump', msg: 'dumping' }),
  ];
  assert.deepEqual(classifyImportErrors(lines.join('\n')).unexpected, []);
  assert.equal(classifyImportErrors(lines.join('\n')).expected.length, 2);
  const extra = JSON.stringify({ level: 'info', logger: 'postgres', msg: 'record', record: { error_severity: 'ERROR', command_tag: 'CREATE EXTENSION', message: 'extension "x" is not available' } });
  assert.equal(classifyImportErrors([...lines, extra].join('\n')).unexpected.length, 1);
  assert.equal(classifyImportErrors('pg_restore: error: could not execute query').unexpected.length, 1);
});

test('writers: the Console DB clients, Console stopped first; extra writers by name', () => {
  assert.deepEqual(CONSOLE_DB_WRITERS.slice(-3).map((w) => w.name), ['opensphere-supabase-storage', 'opensphere-supabase-rest', 'opensphere-supabase-auth']);
  assert.ok(CONSOLE_DB_WRITERS.every((w) => w.role));
  assert.deepEqual(parseExtraWriters(['opensphere-console/r2c2-pool=r2c2_probe', 'a/b']), [
    { namespace: 'opensphere-console', name: 'r2c2-pool', role: 'r2c2_probe', extra: true }, { namespace: 'a', name: 'b', role: null, extra: true }]);
  assert.throws(() => parseExtraWriters(['bad']), /--extra-writer/);
  assert.deepEqual(CUTOVER_STEPS, ['freeze', 'dump', 'fingerprint', 'create', 'repair', 'parity', 'switch', 'reopen', 'verify', 'finalize']);
});

// A fake cluster holding only the checkpoint ConfigMap and the objects the asked step reads.
function fakeCluster(state, { uid = '11111111-2222-3333-4444-555555555555' } = {}) {
  const store = { configmap: state ? { metadata: { resourceVersion: '1' }, data: { 'state.json': JSON.stringify(state) } } : null, calls: [] };
  const runner = (bin, args, options) => {
    assert.equal(bin, 'kubectl');
    assert.deepEqual(args.slice(0, 2), ['--context', 'lab']);
    const a = args.slice(2);
    store.calls.push(a.join(' '));
    if (a[0] === 'get' && a[1] === 'namespace' && a[2] === 'kube-system') return uid;
    if (a.includes('configmap') && a.includes(CUTOVER_CONFIGMAP) && a.includes('get')) return store.configmap ? JSON.stringify(store.configmap) : '';
    if (a[0] === 'replace' || a[0] === 'create') {
      const doc = JSON.parse(options.input);
      assert.equal(doc.metadata.name, CUTOVER_CONFIGMAP);
      if (a[0] === 'replace') assert.equal(doc.metadata.resourceVersion, store.configmap.metadata.resourceVersion, 'optimistic concurrency');
      store.configmap = { ...doc, metadata: { ...doc.metadata, resourceVersion: String(Number(store.configmap?.metadata.resourceVersion || 0) + 1) } };
      return '{}';
    }
    if (a.includes('delete') && (a.includes('service') || a.includes('secret'))) return '';
    throw new Error(`unexpected kubectl ${a.join(' ')}`);
  };
  return { store, runner };
}
const base = (over = {}) => ({ schema: 'opensphere.console-db-cutover/v1', attemptId: '20261027-abc', state: 'Reopened', clusterUid: '11111111-2222-3333-4444-555555555555',
  storageClass: 'longhorn', source: { pv: 'pv-1' }, writers: [], steps: {}, history: [], ...over });

test('resume: recorded steps are never redone; the next step continues from the checkpoint', async () => {
  const steps = Object.fromEntries(CUTOVER_STEPS.filter((s) => s !== 'finalize').map((s) => [s, { at: 'x', ms: 1 }]));
  const { store, runner } = fakeCluster(base({ steps }));
  const dir = mkdtempSync(join(tmpdir(), 'r2c2-cutover-'));
  try {
    const cutover = createCutover({ context: 'lab', clusterUid: '11111111-2222-3333-4444-555555555555', evidenceDir: dir, runner, log: () => {} });
    const result = await cutover.apply();
    assert.equal(result.done, true);
    assert.equal(result.state.state, 'Completed');
    assert.ok(result.state.steps.finalize);
    // Only finalize's own write (the temporary source Service) reached the cluster besides the checkpoint.
    assert.deepEqual(store.calls.filter((c) => !/configmap|replace|kube-system/.test(c)), [`-n ${DATA_NAMESPACE} delete service opensphere-supabase-postgres-legacy --ignore-not-found`,
      `-n ${DATA_NAMESPACE} delete secret opensphere-console-db-import-source --ignore-not-found`]);
    assert.equal((await cutover.apply()).done, true, 'a completed cutover is a no-op');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rollback: refused once the writers were reopened; a checkpoint from another cluster is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c2-cutover-'));
  try {
    const reopened = fakeCluster(base({ steps: { reopen: { at: 'x' } } }));
    assert.throws(() => createCutover({ context: 'lab', clusterUid: '11111111-2222-3333-4444-555555555555', evidenceDir: dir, runner: reopened.runner }).rollback(),
      { code: 'ROLLBACK_REFUSED' });
    const foreign = fakeCluster(base({ state: 'InProgress', clusterUid: '99999999-2222-3333-4444-555555555555' }));
    await assert.rejects(createCutover({ context: 'lab', clusterUid: '11111111-2222-3333-4444-555555555555', evidenceDir: dir, runner: foreign.runner, log: () => {} }).apply(),
      /another cluster/);
    const rolledBack = fakeCluster(base({ state: 'RolledBack' }));
    await assert.rejects(createCutover({ context: 'lab', clusterUid: '11111111-2222-3333-4444-555555555555', evidenceDir: dir, runner: rolledBack.runner, log: () => {} }).apply(),
      /--discard-attempt 20261027-abc/);
    const wrongCluster = fakeCluster(base({ state: 'InProgress' }), { uid: '00000000-2222-3333-4444-555555555555' });
    assert.throws(() => createCutover({ context: 'lab', clusterUid: '11111111-2222-3333-4444-555555555555', evidenceDir: dir, runner: wrongCluster.runner }).rollback(),
      /not 11111111/);
    assert.throws(() => createCutover({ context: 'lab', clusterUid: '11111111-2222-3333-4444-555555555555', evidenceDir: dir, runner: rolledBack.runner }).discard('other'),
      /must name 20261027-abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
