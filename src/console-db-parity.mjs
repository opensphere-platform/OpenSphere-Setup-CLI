// The parity gate of the Console DB cutover (R2-C2 scope 3). The Service moves to the CloudNativePG primary only when
// source and target agree on every item below, except the differences the lab explained (R2-C2-CNPG-LAB-RESULTS
// §2.4). Anything else stops the cutover before the switch, where rollback loses nothing.
//   - every table: exact row count and a content hash (review 2026-10-27, finding 5): the md5 of every row's text
//     form, folded into two 64-bit sums, so the order of rows does not matter and nothing is sorted or held in memory.
//     Tables larger than the size guard (1 GiB by default, measured on the source) are compared by row count only and
//     listed as such; only supabase_vault's tables may be missing (user decision I1);
//   - definitions: columns with types, defaults, identity and generation; indexes; constraints; views; functions
//     (pg_get_functiondef); sequences with their last value; comments; large objects. Objects that belong to an
//     extension are compared through the extension line instead (the CNPG image ships a newer vector). A CHECK or view
//     whose text the restore re-rendered passes only when the source text, parsed on the target, renders the same;
//   - the migration ledger: count, head and an md5 over every row;
//   - roles: attributes, password hash, settings (authenticator loses session_preload_libraries; supabase_admin gets a
//     new SCRAM hash for the same password from managed.roles; CNPG adds streaming_replica and cnpg_metrics_exporter);
//   - memberships with their admin/inherit/set options (memberships of postgres are CNPG's own);
//   - grants: database, schema, relation and function privileges, compared semantically (the owner's own rights are
//     implicit). In the extensions schema only an owner change to postgres is explained, and only when the grants are
//     otherwise the same;
//   - object owners, function bodies, RLS flags, policies, triggers, event triggers and their superuser owner, default
//     privileges, database locale, publications.
// The SQL is read-only and uses no XML function (triage M3).
import { effectiveGrants } from './console-db-role-repair.mjs';

const HEADER = '\\pset pager off\n\\pset tuples_only on\n\\pset format unaligned\nBEGIN TRANSACTION READ ONLY;\nSET LOCAL search_path = pg_catalog;\n';
// Row text depends on these session settings; both sides use the same values.
const DATA_HEADER = `${HEADER}SET LOCAL TimeZone = 'UTC';\nSET LOCAL DateStyle = 'ISO, MDY';\nSET LOCAL IntervalStyle = 'postgres';\n`
  + 'SET LOCAL extra_float_digits = 1;\nSET LOCAL bytea_output = \'hex\';\n';
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
export const CONTENT_HASH_LIMIT_BYTES = 1024 ** 3;
const USER_SCHEMA = (n) => `${n}.nspname NOT IN ('pg_catalog','information_schema') AND ${n}.nspname NOT LIKE 'pg\\_toast%' AND ${n}.nspname NOT LIKE 'pg\\_temp%'`;
const NOT_EXTENSION_MEMBER = (catalog, oid) => `NOT EXISTS (SELECT 1 FROM pg_depend xd WHERE xd.classid = '${catalog}'::regclass AND xd.objid = ${oid} AND xd.deptype = 'e')`;

export const TABLES_SQL = `${HEADER}SELECT 'table|' || n.nspname || '|' || c.relname || '|' || pg_total_relation_size(c.oid)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' ORDER BY 1;
ROLLBACK;
`;
export function parseTables(output) {
  return String(output).split(/\r?\n/).filter((l) => l.startsWith('table|')).map((l) => {
    const [, schema, name, bytes] = l.split('|');
    return { schema, name, bytes: bytes === undefined ? null : Number(bytes) };
  });
}
// Which tables get a content hash. The source decides (its sizes); the target follows the source's plan, so both
// sides hash the same tables. A table the source does not have is counted only (it is a difference anyway).
export function contentPlan(tables, { limitBytes = CONTENT_HASH_LIMIT_BYTES, plan = null } = {}) {
  const fromSource = plan ? new Map(plan.map((t) => [`${t.schema}.${t.name}`, t.hashed])) : null;
  return tables.map((t) => ({ schema: t.schema, name: t.name, bytes: t.bytes,
    hashed: fromSource ? fromSource.get(`${t.schema}.${t.name}`) === true : !(t.bytes > limitBytes) }));
}
// Row counts and content hashes: rows|<schema.table>|<count> and content|<schema.table>|<hash> or "unhashed".
export function tableDataSql(plan) {
  if (!plan.length) throw new Error('No tables to count');
  const row = '_opensphere_parity_row';
  const parts = plan.map(({ schema, name, hashed }) => {
    const key = `${schema}.${name}`;
    const from = `${ident(schema)}.${ident(name)}`;
    if (!hashed) return `SELECT unnest(ARRAY[${lit(`rows|${key}|`)} || count(*)::text, ${lit(`content|${key}|unhashed`)}]) FROM ${from}`;
    return `SELECT unnest(ARRAY[${lit(`rows|${key}|`)} || a.n::text, ${lit(`content|${key}|`)} || coalesce(a.h1::text || ':' || a.h2::text, 'empty')])`
      + ` FROM (SELECT count(*) AS n, sum(('x' || substr(h, 1, 16))::bit(64)::bigint::numeric) AS h1, sum(('x' || substr(h, 17, 16))::bit(64)::bigint::numeric) AS h2`
      + ` FROM (SELECT md5(${row}::text) AS h FROM ${from} ${row}) r) a`;
  });
  return `${DATA_HEADER}${parts.join('\nUNION ALL ')};\nROLLBACK;\n`;
}
// Kept for callers that only need the counts (the plan without hashes).
export function rowCountSql(tables) {
  return tableDataSql(tables.map((t) => ({ ...t, hashed: false })));
}

const acl = (column) => `coalesce(${column}::text, 'NULL')`;
export const FINGERPRINT_SQL = `${HEADER}SELECT line FROM (
  SELECT 'ledger|count|' || count(*)::text AS line FROM console_migration.applied_migration
  UNION ALL SELECT 'ledger|head|' || coalesce((SELECT global_id || ' ' || migration_set_digest FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1), '')
  UNION ALL SELECT 'ledger|md5|' || coalesce(md5(string_agg(row_to_json(a)::text, E'\\n' ORDER BY applied_sequence)), '') FROM console_migration.applied_migration a
  UNION ALL SELECT 'role|' || r.rolname || '|' || concat_ws(',', 'super=' || r.rolsuper, 'inherit=' || r.rolinherit, 'createrole=' || r.rolcreaterole,
      'createdb=' || r.rolcreatedb, 'login=' || r.rolcanlogin, 'repl=' || r.rolreplication, 'bypassrls=' || r.rolbypassrls,
      'connlimit=' || r.rolconnlimit, 'validuntil=' || coalesce(r.rolvaliduntil::text, ''), 'pw=' || coalesce(left(md5(a.rolpassword), 12), '-'))
    FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid WHERE r.rolname NOT LIKE 'pg\\_%'
  UNION ALL SELECT 'member|' || g.rolname || '>' || m.rolname || '|' || concat_ws(',', 'admin=' || am.admin_option, 'inherit=' || am.inherit_option, 'set=' || am.set_option)
    FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
  UNION ALL SELECT 'setting|' || coalesce(d.datname, '*') || '|' || coalesce(r.rolname, '*') || '|' || array_to_string(s.setconfig, ';')
    FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase LEFT JOIN pg_roles r ON r.oid = s.setrole
  UNION ALL SELECT 'ext|' || e.extname || '|' || e.extversion || '|' || n.nspname || '|' || pg_get_userbyid(e.extowner)
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  UNION ALL SELECT 'db|' || datname || '|owner=' || pg_get_userbyid(datdba) || ' provider=' || datlocprovider::text || ' locale=' || coalesce(datlocale, '')
      || ' collate=' || datcollate || ' ctype=' || datctype || ' encoding=' || pg_encoding_to_char(encoding)
    FROM pg_database WHERE datname = 'postgres'
  UNION ALL SELECT 'acl|database|' || datname || '|' || pg_get_userbyid(datdba) || '|' || ${acl('datacl')} FROM pg_database WHERE datname = 'postgres'
  UNION ALL SELECT 'acl|schema|' || nspname || '|' || pg_get_userbyid(nspowner) || '|' || ${acl('nspacl')}
    FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
  UNION ALL SELECT 'acl|rel|' || n.nspname || '.' || c.relname || ':' || c.relkind::text || '|' || pg_get_userbyid(c.relowner) || '|' || ${acl('c.relacl')}
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','S','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
  UNION ALL SELECT 'acl|func|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || pg_get_userbyid(p.proowner) || '|' || ${acl('p.proacl')}
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL SELECT 'rls|' || n.nspname || '.' || c.relname || '|' || c.relrowsecurity || '/' || c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND (c.relrowsecurity OR c.relforcerowsecurity)
  UNION ALL SELECT 'func|' || n.nspname || '|' || count(*) || ' secdef=' || count(*) FILTER (WHERE p.prosecdef) || ' src=' ||
      md5(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || p.prosrc || coalesce(array_to_string(p.proconfig, ';'), ''), ',' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') GROUP BY n.nspname
  UNION ALL SELECT 'policy|' || schemaname || '.' || tablename || '.' || policyname || '|' || md5(permissive || cmd || array_to_string(roles, ',') || coalesce(qual, '') || coalesce(with_check, ''))
    FROM pg_policies
  UNION ALL SELECT 'trigger|' || n.nspname || '.' || c.relname || '.' || t.tgname || '|' || md5(pg_get_triggerdef(t.oid)) || ' enabled=' || t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal
  UNION ALL SELECT 'evtrigger|' || evtname || '|' || evtevent || ' owner=' || pg_get_userbyid(evtowner) || ' enabled=' || evtenabled::text || ' func=' || evtfoid::regproc::text
    FROM pg_event_trigger
  UNION ALL SELECT 'defacl|' || pg_get_userbyid(defaclrole) || '|' || coalesce(n.nspname, '*') || '|' || defaclobjtype::text || '|' || defaclacl::text
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  UNION ALL SELECT 'publication|' || pubname || '|' || pg_get_userbyid(pubowner) || ' all=' || puballtables FROM pg_publication
  UNION ALL SELECT p || md5(d) FROM (
    SELECT 'def|columns|' || n.nspname || '.' || c.relname || ':' || c.relkind::text || '|' AS p, coalesce(string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
        || ' nn=' || a.attnotnull || ' id=' || a.attidentity::text || ' gen=' || a.attgenerated::text || ' coll=' || coalesce(co.collname, '')
        || ' def=' || coalesce(pg_get_expr(ad.adbin, ad.adrelid), ''), ',' ORDER BY a.attnum), '') AS d
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      LEFT JOIN pg_collation co ON co.oid = a.attcollation
      WHERE c.relkind IN ('r','p','v','m','f') AND ${USER_SCHEMA('n')} AND ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
      GROUP BY n.nspname, c.relname, c.relkind
    UNION ALL SELECT 'def|index|' || n.nspname || '.' || ic.relname || '|', pg_get_indexdef(i.indexrelid)
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE ${USER_SCHEMA('n')} AND ${NOT_EXTENSION_MEMBER('pg_class', 'i.indrelid')}
    UNION ALL SELECT 'def|constraint|' || n.nspname || '.' || coalesce(c.relname, t.typname, '-') || '.' || con.conname || '|',
        con.contype::text || ' ' || pg_get_constraintdef(con.oid) || ' valid=' || con.convalidated || ' deferrable=' || con.condeferrable || '/' || con.condeferred
      FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace LEFT JOIN pg_class c ON c.oid = con.conrelid LEFT JOIN pg_type t ON t.oid = con.contypid
      WHERE ${USER_SCHEMA('n')} AND (c.oid IS NULL OR ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}) AND (t.oid IS NULL OR ${NOT_EXTENSION_MEMBER('pg_type', 't.oid')})
    UNION ALL SELECT 'def|view|' || n.nspname || '.' || c.relname || '|', pg_get_viewdef(c.oid)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v','m') AND ${USER_SCHEMA('n')} AND ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
    UNION ALL SELECT 'def|function|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|', pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prokind <> 'a' AND ${USER_SCHEMA('n')} AND ${NOT_EXTENSION_MEMBER('pg_proc', 'p.oid')}
  ) defs
  UNION ALL SELECT 'seq|' || schemaname || '.' || sequencename || '|' || coalesce(last_value::text, 'unset') || ' inc=' || increment_by
      || ' min=' || min_value || ' max=' || max_value || ' cycle=' || cycle
    FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog','information_schema')
  -- Comments on user objects (not on extensions or their members, not on objects initdb made), and large objects.
  UNION ALL SELECT 'comment|objects|' || count(*)::text || ' ' || coalesce(md5(string_agg(pg_describe_object(d.classoid, d.objoid, d.objsubid) || '=' || d.description,
      E'\\n' ORDER BY pg_describe_object(d.classoid, d.objoid, d.objsubid))), '')
    FROM pg_description d WHERE d.objoid >= 16384 AND d.classoid <> 'pg_extension'::regclass
      AND NOT EXISTS (SELECT 1 FROM pg_depend xd WHERE xd.classid = d.classoid AND xd.objid = d.objoid AND xd.deptype = 'e')
  UNION ALL SELECT 'lo|metadata|' || count(*)::text || ' ' || coalesce(md5(string_agg(oid::text || ':' || pg_get_userbyid(lomowner) || ':' || coalesce(lomacl::text, ''), ',' ORDER BY oid)), '')
    FROM pg_largeobject_metadata
  UNION ALL SELECT 'lo|data|' || coalesce(md5(string_agg(loid::text || ':' || pageno::text || ':' || md5(data), ',' ORDER BY loid, pageno)), '') FROM pg_largeobject
) x ORDER BY 1;
ROLLBACK;
`;

// The text of every CHECK constraint and view, kept from the source (finding 5 of the second review). A restore
// re-renders these: it parses "((a AND b) AND c)" into one flat AND, and gives a view's UNION arms "AS text" aliases,
// so their deparsed text changes although the definition does not (lab 2026-10-27: 7 CHECKs, 1 view). The parity
// step parses the source text on the target, inside a transaction it rolls back, and compares what the target renders
// with the target's own object (rerenderSql). Nothing is normalised by pattern.
export const DEFINITIONS_SQL = `${HEADER}SELECT coalesce(json_agg(x ORDER BY x.key), '[]') FROM (
  SELECT 'constraint|' || n.nspname || '.' || c.relname || '.' || con.conname AS key, 'constraint' AS kind, n.nspname AS schema, c.relname AS "table",
      pg_get_constraintdef(con.oid) AS text
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'c' AND c.relkind IN ('r','p') AND ${USER_SCHEMA('n')} AND ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
  UNION ALL SELECT 'view|' || n.nspname || '.' || c.relname, 'view', n.nspname, c.relname, pg_get_viewdef(c.oid)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'v' AND ${USER_SCHEMA('n')} AND ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
) x;
ROLLBACK;
`;
export function parseDefinitions(output) {
  const text = String(output);
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('No definitions in the output');
  return JSON.parse(text.slice(start, end + 1));
}
// One savepoint per item: an item the target cannot parse prints nothing and stays a difference.
export function rerenderSql(items) {
  const parts = ['\\set ON_ERROR_STOP off', 'BEGIN;', 'SET LOCAL search_path = pg_catalog;'];
  items.forEach((item, i) => {
    if (!['constraint', 'view'].includes(item.kind)) throw new Error(`No re-render for ${item.kind}`);
    parts.push('SAVEPOINT rerender;');
    if (item.kind === 'constraint') {
      if (!/^CHECK \(/.test(item.text)) throw new Error(`Not a CHECK constraint: ${item.key}`);
      parts.push(`CREATE TEMP TABLE _opensphere_rerender_${i} (LIKE ${ident(item.schema)}.${ident(item.table)});`,
        `ALTER TABLE pg_temp._opensphere_rerender_${i} ADD CONSTRAINT _opensphere_rerender ${item.text};`,
        `SELECT ${lit(`rerender|${item.key}|`)} || md5(con.contype::text || ' ' || pg_get_constraintdef(con.oid) || ' valid=' || con.convalidated || ' deferrable=' || con.condeferrable || '/' || con.condeferred)`
        + ` FROM pg_constraint con WHERE con.conrelid = 'pg_temp._opensphere_rerender_${i}'::regclass AND con.conname = '_opensphere_rerender';`);
    } else {
      parts.push(`CREATE TEMP VIEW _opensphere_rerender_${i} AS ${item.text.trim().replace(/;$/, '')};`,
        `SELECT ${lit(`rerender|${item.key}|`)} || md5(pg_get_viewdef('pg_temp._opensphere_rerender_${i}'::regclass));`);
    }
    parts.push('ROLLBACK TO SAVEPOINT rerender;');
  });
  parts.push('ROLLBACK;', '');
  return parts.join('\n');
}
export function parseRerendered(output) {
  return new Map(String(output).split(/\r?\n/).filter((l) => l.startsWith('rerender|')).map((l) => {
    const i = l.lastIndexOf('|');
    return [l.slice('rerender|'.length, i), l.slice(i + 1)];
  }));
}

const KEYED = ['ledger', 'role', 'member', 'ext', 'db', 'rls', 'func', 'policy', 'trigger', 'evtrigger', 'defacl', 'publication', 'content', 'seq', 'comment', 'lo'];
export function parseFingerprint(output) {
  const fp = { rows: new Map(), acl: new Map(), settings: new Map(), def: new Map() };
  for (const k of KEYED) fp[k] = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const parts = line.split('|');
    const kind = parts[0];
    if (kind === 'rows') fp.rows.set(parts[1], parts[2]);
    else if (kind === 'acl') fp.acl.set(`${parts[1]}|${parts[2]}`, { owner: parts[3], acl: parts.slice(4).join('|') });
    else if (kind === 'setting') fp.settings.set(`${parts[1]}|${parts[2]}`, parts.slice(3).join('|'));
    else if (kind === 'def' && parts.length >= 4) fp.def.set(`${parts[1]}|${parts[2]}`, parts.slice(3).join('|'));
    else if (KEYED.includes(kind) && parts.length >= 3) fp[kind].set(parts[1], parts.slice(2).join('|'));
  }
  return fp;
}

// Explained differences (lab §2.4), each with its reason. Nothing else is accepted.
const EXCLUDED_EXTENSION = 'supabase_vault';
const EXCLUDED_SCHEMA = 'vault';
const CNPG_ROLES = new Set(['streaming_replica', 'cnpg_metrics_exporter']);
const inExcludedSchema = (qualified) => qualified.startsWith(`${EXCLUDED_SCHEMA}.`);
const inExtensionsSchema = (qualified) => qualified.startsWith('extensions.');
const dropPreload = (config) => config.split(';').filter((s) => !s.startsWith('session_preload_libraries=')).join(';');
const versionAtLeast = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return true;
};

// rerendered: Map(def key -> md5 of the source text as the target renders it), from rerenderSql.
export function compareParity(source, target, { rerendered = new Map() } = {}) {
  const differences = [], explained = [], unhashed = [];
  const differ = (what, s, t) => differences.push({ what, source: s ?? null, target: t ?? null });
  const explain = (what, reason) => explained.push({ what, reason });
  const both = (a, b) => new Set([...a.keys(), ...b.keys()]);

  // Rows and contents.
  if (!source.rows.size) differ('rows', 'no source row counts', null);
  for (const key of both(source.rows, target.rows)) {
    const s = source.rows.get(key), t = target.rows.get(key);
    if (s === t) continue;
    if (t === undefined && inExcludedSchema(key)) { explain(`rows|${key}`, 'supabase_vault is not imported (I1)'); continue; }
    differ(`rows|${key}`, s, t);
  }
  if (source.rows.size && !source.content.size) differ('content', 'no source content hashes', null);
  for (const key of both(source.content, target.content)) {
    const s = source.content.get(key), t = target.content.get(key);
    if (t === undefined && inExcludedSchema(key)) { explain(`content|${key}`, 'supabase_vault is not imported (I1)'); continue; }
    if (s === 'unhashed' && t === 'unhashed') { unhashed.push(key); continue; }
    if (s === t && s !== undefined) continue;
    differ(`content|${key}`, s, t);
  }
  // Ledger.
  for (const key of ['count', 'head', 'md5']) if (source.ledger.get(key) !== target.ledger.get(key) || !source.ledger.get(key)) differ(`ledger|${key}`, source.ledger.get(key), target.ledger.get(key));
  // Roles.
  for (const role of both(source.role, target.role)) {
    const s = source.role.get(role), t = target.role.get(role);
    if (role === 'postgres') { if (s !== t) explain('role|postgres', 'CNPG runs as postgres (superuser, no password); Console connects with other roles'); continue; }
    if (s === undefined && CNPG_ROLES.has(role)) { explain(`role|${role}`, 'created by CloudNativePG'); continue; }
    if (s === t) continue;
    if (role === 'supabase_admin' && s && t && s.replace(/,pw=[^,]*$/, '') === t.replace(/,pw=[^,]*$/, '')) {
      explain('role|supabase_admin', 'managed.roles sets the same password as a new SCRAM hash'); continue;
    }
    differ(`role|${role}`, s, t);
  }
  // Memberships.
  for (const key of both(source.member, target.member)) {
    const s = source.member.get(key), t = target.member.get(key);
    if (s === t) continue;
    const member = key.split('>')[1];
    if (member === 'postgres' || (s === undefined && (CNPG_ROLES.has(member) || key.split('>')[0] === 'streaming_replica'))) {
      explain(`member|${key}`, 'membership of a CloudNativePG role'); continue;
    }
    differ(`member|${key}`, s, t);
  }
  // Role settings.
  for (const key of both(source.settings, target.settings)) {
    const s = source.settings.get(key), t = target.settings.get(key);
    if (s === t) continue;
    if (key === '*|postgres') { explain(`setting|${key}`, 'postgres is CNPG\'s own role'); continue; }
    if (key === '*|authenticator' && s !== undefined && dropPreload(s) === (t ?? '')) {
      explain(`setting|${key}`, 'supautils and safeupdate preload dropped (I1)'); continue;
    }
    differ(`setting|${key}`, s, t);
  }
  // Extensions.
  for (const name of both(source.ext, target.ext)) {
    const s = source.ext.get(name), t = target.ext.get(name);
    if (s === t) continue;
    if (name === EXCLUDED_EXTENSION && t === undefined) { explain(`ext|${name}`, 'excluded from the import (I1)'); continue; }
    if (s && t) {
      const [sv, ss] = s.split('|'), [tv, ts] = t.split('|');
      const versionOk = sv === tv || (name === 'vector' && versionAtLeast(tv, sv));
      if (versionOk && ss === ts) { explain(`ext|${name}`, `restored by the CNPG image${sv !== tv ? ` at ${tv}` : ''}; extension owner becomes postgres`); continue; }
    }
    differ(`ext|${name}`, s, t);
  }
  // Database.
  if (source.db.get('postgres') !== target.db.get('postgres') || !source.db.get('postgres')) differ('db|postgres', source.db.get('postgres'), target.db.get('postgres'));
  // Grants and owners.
  for (const key of both(source.acl, target.acl)) {
    const [kind, name] = key.split('|');
    const s = source.acl.get(key), t = target.acl.get(key);
    const qualified = kind === 'schema' ? `${name}.` : name;
    if (inExcludedSchema(qualified)) { if (!t) { explain(`acl|${key}`, 'supabase_vault schema is not imported'); continue; } }
    if (!s || !t) { differ(`acl|${key}`, s && `${s.owner} ${s.acl}`, t && `${t.owner} ${t.acl}`); continue; }
    const grantSet = (x) => [...effectiveGrants({ database: 'database', func: 'function' }[kind] ?? kind, x.owner, x.acl)];
    const grants = (x) => grantSet(x).sort().join(',');
    const sameOwner = s.owner === t.owner, sameGrants = grants(s) === grants(t);
    if (sameOwner && sameGrants) continue;
    if (kind !== 'schema' && kind !== 'database' && inExtensionsSchema(qualified) && !sameOwner && t.owner === 'postgres') {
      // The extension's objects change owner to postgres. Grants either owner held are implicit on one side and
      // explicit on the other; every other grant must be the same.
      const owners = new Set([s.owner, t.owner]);
      const others = (x) => grantSet(x).filter((g) => !owners.has(g.split(':')[0])).sort().join(',');
      if (others(s) === others(t)) { explain(`acl|${key}`, 'object of an extension; its owner becomes postgres, other grants unchanged'); continue; }
    }
    differ(`acl|${key}`, `${s.owner} ${grants(s)}`, `${t.owner} ${grants(t)}`);
  }
  // Functions, policies, triggers, event triggers, default privileges, RLS, publications, definitions, sequences.
  for (const kind of ['func', 'policy', 'trigger', 'evtrigger', 'defacl', 'rls', 'publication', 'def', 'seq', 'comment', 'lo']) {
    for (const key of both(source[kind], target[kind])) {
      const s = source[kind].get(key), t = target[kind].get(key);
      if (s === t) continue;
      if (kind === 'func' && key === EXCLUDED_SCHEMA && t === undefined) { explain(`func|${key}`, 'supabase_vault functions are not imported'); continue; }
      if (kind === 'func' && key === 'extensions' && s && t && s.split(' src=')[0] === t.split(' src=')[0]) {
        explain('func|extensions', 'extension functions of the CNPG image (vector version)'); continue;
      }
      const object = kind === 'def' ? key.slice(key.indexOf('|') + 1) : key;
      // A CHECK or view the restore re-rendered: the source text, parsed on the target, renders exactly as the target's.
      if (kind === 'def' && s && t && /^(constraint|view)\|/.test(key) && rerendered.get(key) === t) {
        explain(`def|${key}`, 're-rendered by the restore: the source definition parsed on the target renders exactly as the target object'); continue;
      }
      if ((kind === 'def' || kind === 'seq') && t === undefined && inExcludedSchema(object)) { explain(`${kind}|${key}`, 'supabase_vault is not imported (I1)'); continue; }
      differ(`${kind}|${key}`, s, t);
    }
  }
  if (!source.def.size) differ('def', 'no source definitions', null);
  for (const [name, value] of source.evtrigger) {
    if (!/ owner=supabase_admin /.test(value)) differ(`evtrigger|${name}`, value, 'event triggers must stay owned by supabase_admin');
  }
  return { ok: differences.length === 0, differences, explained,
    compared: { tables: source.rows.size, contentHashed: source.content.size - unhashed.length, unhashed, definitions: source.def.size,
      sequences: source.seq.size, roles: source.role.size, memberships: source.member.size, grants: source.acl.size, ledger: source.ledger.get('count') } };
}
