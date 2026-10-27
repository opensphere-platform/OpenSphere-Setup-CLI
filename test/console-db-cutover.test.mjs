import test from 'node:test';
import assert from 'node:assert/strict';
import { aclReplayStatements, buildRepairSql, effectiveGrants, parseAcl, roleRepairStatements } from '../src/console-db-role-repair.mjs';
import {
  DEFINITIONS_SQL, FINGERPRINT_SQL, TABLES_SQL, compareParity, contentPlan, parseDefinitions, parseFingerprint, parseRerendered, parseTables, rerenderSql, rowCountSql, tableDataSql,
} from '../src/console-db-parity.mjs';
import { CONSOLE_DB_WRITERS, CUTOVER_STEPS, classifyImportErrors, parseExtraWriters } from '../src/console-db-cutover.mjs';

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
  'content|console_operation.x|111:222', 'content|vault.secrets|empty', 'content|auth.users|333:444',
  'def|columns|console_operation.x:r|c1', 'def|index|console_operation.x_pkey|i1', 'def|constraint|console_operation.x.x_pkey|p k1 valid=true deferrable=false/false',
  'def|view|console_operation.v|v1', 'def|function|console_operation.f()|f1', 'def|function|vault.create_secret(text)|f9',
  'seq|console_operation.x_id_seq|10 inc=1 min=1 max=9223372036854775807 cycle=false', 'seq|vault.s_seq|unset inc=1 min=1 max=9 cycle=false',
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
  'content|console_operation.x|111:222', 'content|auth.users|333:444',
  'def|columns|console_operation.x:r|c1', 'def|index|console_operation.x_pkey|i1', 'def|constraint|console_operation.x.x_pkey|p k1 valid=true deferrable=false/false',
  'def|view|console_operation.v|v1', 'def|function|console_operation.f()|f1',
  'seq|console_operation.x_id_seq|10 inc=1 min=1 max=9223372036854775807 cycle=false',
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
  for (const what of ['rows|vault.secrets', 'content|vault.secrets', 'def|function|vault.create_secret(text)', 'seq|vault.s_seq', 'role|supabase_admin',
    'role|streaming_replica', 'ext|vector', 'ext|supabase_vault', 'setting|*|authenticator', 'member|anon>postgres', 'func|vault', 'acl|schema|vault',
    'acl|rel|extensions.pg_stat_statements:v']) assert.ok(reasons.includes(what), what);
  assert.equal(result.compared.contentHashed, 3);
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
    // Finding 5: same row count, different content; a changed definition; a sequence behind the source.
    [FP(), TARGET().replace('content|auth.users|333:444', 'content|auth.users|333:445'), 'content|auth.users'],
    [FP(), TARGET().replace('content|auth.users|333:444', 'content|auth.users|unhashed'), 'content|auth.users'],
    [FP(), TARGET().replace('def|index|console_operation.x_pkey|i1', 'def|index|console_operation.x_pkey|i2'), 'def|index|console_operation.x_pkey'],
    [FP(), TARGET().replace('def|view|console_operation.v|v1', 'x'), 'def|view|console_operation.v'],
    [FP(), TARGET().replace('def|columns|console_operation.x:r|c1', 'def|columns|console_operation.x:r|c2'), 'def|columns|console_operation.x:r'],
    [FP(), TARGET().replace('def|function|console_operation.f()|f1', 'def|function|console_operation.f()|f0'), 'def|function|console_operation.f()'],
    [FP(), TARGET().replace('seq|console_operation.x_id_seq|10 ', 'seq|console_operation.x_id_seq|9 '), 'seq|console_operation.x_id_seq'],
    [FP(), TARGET().replace('def|constraint|console_operation.x.x_pkey|p k1 valid=true deferrable=false/false', 'x'), 'def|constraint|console_operation.x.x_pkey'],
    // Finding 5: in the extensions schema only an owner change to postgres is explained, not a lost or added grant.
    [FP(), TARGET().replace('acl|rel|extensions.pg_stat_statements:v|postgres|{=r/postgres}', 'acl|rel|extensions.pg_stat_statements:v|postgres|{=r/postgres,anon=arwd/postgres}'), 'acl|rel|extensions.pg_stat_statements:v'],
    [FP(), TARGET().replace('acl|rel|extensions.pg_stat_statements:v|postgres|{=r/postgres}', 'acl|rel|extensions.pg_stat_statements:v|postgres|{postgres=arwdDxtm/postgres}'), 'acl|rel|extensions.pg_stat_statements:v'],
    [FP(), TARGET().replace('acl|rel|extensions.pg_stat_statements:v|postgres|{=r/postgres}', 'acl|rel|extensions.pg_stat_statements:v|anon|{=r/anon}'), 'acl|rel|extensions.pg_stat_statements:v'],
  ];
  for (const [s, t, what] of bad) {
    const r = compareParity(parseFingerprint(s), parseFingerprint(t));
    assert.equal(r.ok, false, what);
    assert.ok(r.differences.some((d) => d.what === what), `${what}: ${JSON.stringify(r.differences)}`);
  }
});

test('parity (second review, item 1): a CHECK or view passes only when the source text re-renders on the target exactly', () => {
  const key = 'constraint|console_operation.x.x_pkey';
  const swap = (text, value) => text.replace('def|constraint|console_operation.x.x_pkey|p k1 valid=true deferrable=false/false', `def|${key}|${value}`);
  const source = parseFingerprint(swap(FP(), 'src-hash'));
  const target = parseFingerprint(swap(TARGET(), 'tgt-hash'));
  // Different text, no re-render: a difference (the counter-examples: "(a OR b) AND c" vs "a OR (b AND c)", a changed
  // partial-index predicate, DEFAULT 'pending review' vs 'pendingreview', CAST(x AS integer) all differ in text).
  assert.ok(compareParity(source, target).differences.some((d) => d.what === `def|${key}`));
  // The source text parsed on the target renders as the target object: explained, by name.
  const ok = compareParity(source, target, { rerendered: new Map([[key, 'tgt-hash']]) });
  assert.equal(ok.ok, true, JSON.stringify(ok.differences));
  assert.ok(ok.explained.some((e) => e.what === `def|${key}` && /re-rendered by the restore/.test(e.reason)));
  // It renders differently: still a difference.
  assert.ok(compareParity(source, target, { rerendered: new Map([[key, 'other']]) }).differences.some((d) => d.what === `def|${key}`));
  // A re-render is never accepted for an index, columns (defaults) or a function.
  for (const [kind, name] of [['index', 'console_operation.x_pkey'], ['columns', 'console_operation.x:r'], ['function', 'console_operation.f()']]) {
    const s2 = parseFingerprint(FP().replace(new RegExp(`def\\|${kind}\\|${name.replace(/[.()]/g, '\\$&')}\\|[^\\n]*`), `def|${kind}|${name}|a`));
    const t2 = parseFingerprint(TARGET().replace(new RegExp(`def\\|${kind}\\|${name.replace(/[.()]/g, '\\$&')}\\|[^\\n]*`), `def|${kind}|${name}|b`));
    const r = compareParity(s2, t2, { rerendered: new Map([[`${kind}|${name}`, 'b']]) });
    assert.ok(r.differences.some((d) => d.what === `def|${kind}|${name}`), kind);
  }
  assert.doesNotMatch(FINGERPRINT_SQL, /regexp_replace/, 'no pattern normalisation');
  for (const line of ["'comment|objects|'", "'lo|metadata|'", "'lo|data|'"]) assert.ok(FINGERPRINT_SQL.includes(line), line);
});

test('parity: the re-render SQL parses each source CHECK and view in its own savepoint and rolls everything back', () => {
  const items = parseDefinitions('BEGIN\n[{"key":"constraint|we\\"ird.t.c","kind":"constraint","schema":"we\\"ird","table":"t","text":"CHECK ((a > 1))"}, \n {"key":"view|s.v","kind":"view","schema":"s","table":"v","text":" SELECT 1 AS x;"}]\nROLLBACK');
  assert.equal(items.length, 2);
  const sql = rerenderSql(items);
  assert.ok(sql.startsWith('\\set ON_ERROR_STOP off\nBEGIN;\n'));
  assert.ok(sql.endsWith('ROLLBACK;\n'));
  assert.equal(sql.split('\n').filter((l) => l === 'SAVEPOINT rerender;').length, 2);
  assert.equal(sql.split('ROLLBACK TO SAVEPOINT rerender;').length - 1, 2);
  assert.ok(sql.includes('CREATE TEMP TABLE _opensphere_rerender_0 (LIKE "we""ird"."t");'));
  assert.ok(sql.includes('ADD CONSTRAINT _opensphere_rerender CHECK ((a > 1));'));
  assert.ok(sql.includes('CREATE TEMP VIEW _opensphere_rerender_1 AS SELECT 1 AS x;'));
  assert.ok(sql.includes(`'rerender|constraint|we"ird.t.c|'`));
  assert.throws(() => rerenderSql([{ key: 'constraint|s.t.u', kind: 'constraint', schema: 's', table: 't', text: 'UNIQUE (a)' }]), /Not a CHECK/);
  assert.throws(() => rerenderSql([{ key: 'index|s.i', kind: 'index', text: 'x' }]), /No re-render/);
  assert.deepEqual([...parseRerendered('NOTICE x\nrerender|view|s.v|abc\nrerender|constraint|a.b.c|def\n')], [['view|s.v', 'abc'], ['constraint|a.b.c', 'def']]);
  assert.ok(DEFINITIONS_SQL.includes("con.contype = 'c'") && DEFINITIONS_SQL.includes("c.relkind = 'v'"));
});

test('parity SQL: read-only, no XML function, quoted identifiers, content hashes within the size guard', () => {
  const tables = parseTables('BEGIN\ntable|osaa|runtime_event|3221225472\ntable|we"ird|t|8192\nROLLBACK');
  assert.deepEqual(tables, [{ schema: 'osaa', name: 'runtime_event', bytes: 3221225472 }, { schema: 'we"ird', name: 't', bytes: 8192 }]);
  const plan = contentPlan(tables);
  assert.deepEqual(plan.map((t) => t.hashed), [false, true], 'the 3 GiB table is over the 1 GiB guard');
  const data = tableDataSql(plan);
  for (const sql of [TABLES_SQL, FINGERPRINT_SQL, data]) {
    assert.match(sql, /BEGIN TRANSACTION READ ONLY;/);
    assert.match(sql, /ROLLBACK;\n$/);
    assert.doesNotMatch(sql, /xml/i);
  }
  assert.ok(data.includes(`SELECT unnest(ARRAY['rows|osaa.runtime_event|' || count(*)::text, 'content|osaa.runtime_event|unhashed']) FROM "osaa"."runtime_event"`));
  assert.ok(data.includes('md5(_opensphere_parity_row::text) AS h FROM "we""ird"."t" _opensphere_parity_row'));
  assert.ok(data.includes("SET LOCAL TimeZone = 'UTC';"));
  assert.doesNotMatch(data, /ORDER BY|string_agg/, 'the content hash folds row hashes into sums: no sort, no aggregated string');
  // The target follows the source's plan, whatever its own sizes are.
  assert.deepEqual(contentPlan([{ schema: 'osaa', name: 'runtime_event', bytes: 1 }, { schema: 'x', name: 'new', bytes: 1 }], { plan }).map((t) => t.hashed), [false, false]);
  assert.ok(rowCountSql(tables).includes('unhashed'));
  for (const kind of ['def|columns|', 'def|index|', 'def|constraint|', 'def|view|', 'def|function|', 'seq|']) assert.ok(FINGERPRINT_SQL.includes(`'${kind}`), kind);
  assert.ok(FINGERPRINT_SQL.includes("deptype = 'e'"), 'extension members are compared through the extension line');
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

