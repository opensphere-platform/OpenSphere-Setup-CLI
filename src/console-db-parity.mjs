// The parity gate of the Console DB cutover (R2-C2 scope 3). The Service moves to the CloudNativePG primary only when
// source and target agree on every item below, except the differences the lab explained (R2-C2-CNPG-LAB-RESULTS
// §2.4). Anything else stops the cutover before the switch, where rollback loses nothing.
//   - exact row count of every table (only supabase_vault's tables may be missing: user decision I1);
//   - the migration ledger: count, head and an md5 over every row;
//   - roles: attributes, password hash, settings (authenticator loses session_preload_libraries; supabase_admin gets a
//     new SCRAM hash for the same password from managed.roles; CNPG adds streaming_replica and cnpg_metrics_exporter);
//   - memberships with their admin/inherit/set options (memberships of postgres are CNPG's own);
//   - grants: database, schema, relation and function privileges, compared semantically (the owner's own rights are
//     implicit); objects of the extensions schema belong to the extensions, whose owner moves to postgres;
//   - object owners, function bodies, RLS flags, policies, triggers, event triggers and their superuser owner, default
//     privileges, database locale, publications.
// The SQL is read-only and uses no XML function (triage M3).
import { effectiveGrants } from './console-db-role-repair.mjs';

const HEADER = '\\pset pager off\n\\pset tuples_only on\n\\pset format unaligned\nBEGIN TRANSACTION READ ONLY;\nSET LOCAL search_path = pg_catalog;\n';
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

export const TABLES_SQL = `${HEADER}SELECT 'table|' || n.nspname || '|' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' ORDER BY 1;
ROLLBACK;
`;
export function parseTables(output) {
  return String(output).split(/\r?\n/).filter((l) => l.startsWith('table|')).map((l) => { const [, schema, name] = l.split('|'); return { schema, name }; });
}
export function rowCountSql(tables) {
  if (!tables.length) throw new Error('No tables to count');
  const parts = tables.map(({ schema, name }) => `SELECT ${lit(`rows|${schema}.${name}`)} || '|' || count(*)::text FROM ${ident(schema)}.${ident(name)}`);
  return `${HEADER}${parts.join('\nUNION ALL ')};\nROLLBACK;\n`;
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
) x ORDER BY 1;
ROLLBACK;
`;

const KEYED = ['ledger', 'role', 'member', 'ext', 'db', 'rls', 'func', 'policy', 'trigger', 'evtrigger', 'defacl', 'publication'];
export function parseFingerprint(output) {
  const fp = { rows: new Map(), acl: new Map(), settings: new Map() };
  for (const k of KEYED) fp[k] = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const parts = line.split('|');
    const kind = parts[0];
    if (kind === 'rows') fp.rows.set(parts[1], parts[2]);
    else if (kind === 'acl') fp.acl.set(`${parts[1]}|${parts[2]}`, { owner: parts[3], acl: parts.slice(4).join('|') });
    else if (kind === 'setting') fp.settings.set(`${parts[1]}|${parts[2]}`, parts.slice(3).join('|'));
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

export function compareParity(source, target) {
  const differences = [], explained = [];
  const differ = (what, s, t) => differences.push({ what, source: s ?? null, target: t ?? null });
  const explain = (what, reason) => explained.push({ what, reason });
  const both = (a, b) => new Set([...a.keys(), ...b.keys()]);

  // Rows.
  if (!source.rows.size) differ('rows', 'no source row counts', null);
  for (const key of both(source.rows, target.rows)) {
    const s = source.rows.get(key), t = target.rows.get(key);
    if (s === t) continue;
    if (t === undefined && inExcludedSchema(key)) { explain(`rows|${key}`, 'supabase_vault is not imported (I1)'); continue; }
    differ(`rows|${key}`, s, t);
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
    const grants = (x) => [...effectiveGrants({ database: 'database', func: 'function' }[kind] ?? kind, x.owner, x.acl)].sort().join(',');
    const sameOwner = s.owner === t.owner, sameGrants = grants(s) === grants(t);
    if (sameOwner && sameGrants) continue;
    if (kind !== 'schema' && kind !== 'database' && inExtensionsSchema(qualified)) {
      explain(`acl|${key}`, 'object of an extension; the extension owner becomes postgres'); continue;
    }
    if (kind === 'database' && sameGrants && s.owner !== t.owner) { differ(`acl|${key}`, s.owner, t.owner); continue; }
    differ(`acl|${key}`, `${s.owner} ${grants(s)}`, `${t.owner} ${grants(t)}`);
  }
  // Functions, policies, triggers, event triggers, default privileges, RLS, publications.
  for (const kind of ['func', 'policy', 'trigger', 'evtrigger', 'defacl', 'rls', 'publication']) {
    for (const key of both(source[kind], target[kind])) {
      const s = source[kind].get(key), t = target[kind].get(key);
      if (s === t) continue;
      if (kind === 'func' && key === EXCLUDED_SCHEMA && t === undefined) { explain(`func|${key}`, 'supabase_vault functions are not imported'); continue; }
      if (kind === 'func' && key === 'extensions' && s && t && s.split(' src=')[0] === t.split(' src=')[0]) {
        explain('func|extensions', 'extension functions of the CNPG image (vector version)'); continue;
      }
      differ(`${kind}|${key}`, s, t);
    }
  }
  for (const [name, value] of source.evtrigger) {
    if (!/ owner=supabase_admin /.test(value)) differ(`evtrigger|${name}`, value, 'event triggers must stay owned by supabase_admin');
  }
  return { ok: differences.length === 0, differences, explained,
    compared: { tables: source.rows.size, roles: source.role.size, memberships: source.member.size, grants: source.acl.size, ledger: source.ledger.get('count') } };
}
