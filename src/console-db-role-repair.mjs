// Post-import repair of what a CloudNativePG monolith import does not carry (lab 2026-10-27 breaks X2, X3; prototype
// r2-c2-lab-20261027/scripts/33-role-fixup.mjs):
//   - role memberships: CNPG replays them "GRANTED BY supabase_admin", which PostgreSQL 16+ refuses because
//     supabase_admin is no longer the bootstrap superuser (18 of 18 failed in the lab, including every Console runtime
//     login -> authority membership and anon/authenticated/service_role -> authenticator);
//   - role-level settings (ALTER ROLE ... SET: search_path, statement_timeout, lock_timeout, ...);
//   - REPLICATION and the other role attributes;
//   - the session_preload_libraries setting of authenticator is dropped: supautils and safeupdate are not in the CNPG
//     standard image and every PostgREST login would fail (user decision I1);
//   - schema and database privileges the restore leaves out (lab §2.4: graphql/graphql_public USAGE).
// Input: `pg_dumpall --roles-only --no-role-passwords` of the source, and the source and target ACL fingerprints.
// Output: one SQL transaction to run on the CNPG primary as postgres. postgres and streaming_replica are never touched
// (an `ALTER ROLE postgres WITH NOSUPERUSER` would break CNPG); supabase_admin keeps its attributes from postInitSQL and
// managed.roles, so only its SET lines are replayed.
const SKIP_ROLES = new Set(['postgres', 'streaming_replica', 'cnpg_metrics_exporter']);
const unquote = (s) => s.replace(/^"|"$/g, '').replace(/""/g, '"');
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

export function roleRepairStatements(rolesDump, { withoutSessionPreload = true } = {}) {
  const statements = [], dropped = [];
  let grants = 0, settings = 0, attributes = 0;
  for (const line of String(rolesDump).split(/\r?\n/)) {
    let m;
    if ((m = /^ALTER ROLE ("(?:[^"]|"")+"|[^" ]+) (?:IN DATABASE \S+ )?SET /.exec(line))) {
      if (SKIP_ROLES.has(unquote(m[1]))) continue;
      if (withoutSessionPreload && / SET session_preload_libraries /.test(line)) { dropped.push(line); continue; }
      statements.push(line); settings += 1;
    } else if ((m = /^ALTER ROLE ("(?:[^"]|"")+"|[^" ]+) WITH (.*);$/.exec(line))) {
      const role = unquote(m[1]);
      if (SKIP_ROLES.has(role) || role === 'supabase_admin') continue;
      statements.push(line); attributes += 1;
    } else if ((m = /^GRANT ("(?:[^"]|"")+"|[^" ]+) TO ("(?:[^"]|"")+"|[^" ]+)(.*);$/.exec(line))) {
      if (SKIP_ROLES.has(unquote(m[2]))) continue;
      // The grantor becomes postgres (the CNPG superuser); admin/inherit/set options are kept.
      statements.push(`GRANT ${m[1]} TO ${m[2]}${m[3].replace(/ GRANTED BY ("(?:[^"]|"")+"|[^" ;]+)/, '')};`); grants += 1;
    }
  }
  return { statements, dropped, counts: { grants, settings, attributes, dropped: dropped.length } };
}

// aclitem text: grantee=privs/grantor (grantee empty = PUBLIC; a '*' after a letter is the grant option).
export function parseAclItem(item) {
  const m = /^((?:"(?:[^"]|"")*"|[^=]*))=([A-Za-z*]*)\/((?:"(?:[^"]|"")*"|.*))$/.exec(item);
  if (!m) throw new Error(`Unreadable ACL item: ${item}`);
  const privileges = [];
  for (let i = 0; i < m[2].length; i += 1) {
    if (m[2][i] === '*') continue;
    privileges.push({ letter: m[2][i], grantOption: m[2][i + 1] === '*' });
  }
  return { grantee: unquote(m[1]), privileges, grantor: unquote(m[3]) };
}
export function parseAcl(text) {
  if (text === null || text === undefined || text === '' || text === 'NULL') return null;
  const inner = String(text).replace(/^\{|\}$/g, '');
  if (!inner) return [];
  const items = [];
  let current = '', quoted = false;
  for (const ch of inner) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) { items.push(current); current = ''; continue; }
    current += ch;
  }
  items.push(current);
  return items.map((i) => parseAclItem(i.replace(/^"(.*)"$/, (_, x) => x.replace(/\\"/g, '"'))));
}

const LETTERS = {
  database: { C: 'CREATE', T: 'TEMPORARY', c: 'CONNECT' },
  schema: { U: 'USAGE', C: 'CREATE' },
};
// The privileges an object grants beyond its owner's implicit rights. A NULL ACL is the default: for a database,
// PUBLIC may CONNECT and create TEMPORARY tables; for a function, PUBLIC may EXECUTE; otherwise only the owner.
const DEFAULT_PUBLIC = { database: ['T', 'c'], function: ['X'] };
export function effectiveGrants(kind, owner, aclText) {
  const acl = parseAcl(aclText);
  const items = acl === null ? (DEFAULT_PUBLIC[kind] ? [{ grantee: '', privileges: DEFAULT_PUBLIC[kind].map((letter) => ({ letter, grantOption: false })), grantor: owner }] : []) : acl;
  const out = new Set();
  for (const item of items) {
    if (item.grantee === owner) continue;
    for (const p of item.privileges) out.add(`${item.grantee || 'PUBLIC'}:${p.letter}${p.grantOption ? '*' : ''}`);
  }
  return out;
}

// Grants (and, for the database, revokes) that make the target ACL equal to the source ACL. Run as the object owner's
// grantor: schema grants as their owner, so the grantor matches the source.
export function aclReplayStatements({ kind, name, sourceOwner, targetOwner, sourceAcl, targetAcl }) {
  const letters = LETTERS[kind];
  if (!letters) throw new Error(`No ACL replay for ${kind}`);
  const want = effectiveGrants(kind, sourceOwner, sourceAcl), have = effectiveGrants(kind, targetOwner, targetAcl);
  const target = kind === 'database' ? `DATABASE ${ident(name)}` : `SCHEMA ${ident(name)}`;
  const grantee = (g) => (g === 'PUBLIC' ? 'PUBLIC' : ident(g));
  const statements = [];
  for (const entry of [...have].filter((x) => !want.has(x)).sort()) {
    const [g, p] = entry.split(':');
    statements.push(`REVOKE ${letters[p[0]]} ON ${target} FROM ${grantee(g)};`);
  }
  for (const entry of [...want].filter((x) => !have.has(x)).sort()) {
    const [g, p] = entry.split(':');
    statements.push(`GRANT ${letters[p[0]]} ON ${target} TO ${grantee(g)}${p.endsWith('*') ? ' WITH GRANT OPTION' : ''};`);
  }
  return statements;
}

// The full repair transaction. acl: {source, target} parsed fingerprints (console-db-parity.mjs parseFingerprint).
export function buildRepairSql(rolesDump, { source, target } = {}, options = {}) {
  const roles = roleRepairStatements(rolesDump, options);
  const acl = [];
  if (source && target) {
    for (const [key, s] of source.acl) {
      const [kind, name] = key.split('|');
      if (!['database', 'schema'].includes(kind) || (kind === 'database' && name !== 'postgres')) continue;
      const t = target.acl.get(key);
      if (!t) continue;
      const statements = aclReplayStatements({ kind, name, sourceOwner: s.owner, targetOwner: t.owner, sourceAcl: s.acl, targetAcl: t.acl });
      if (!statements.length) continue;
      // Grant as the owner so the grantor is the same as on the source (supabase_admin for the Console schemas).
      acl.push(kind === 'schema' ? `SET LOCAL ROLE ${ident(t.owner)};` : 'RESET ROLE;', ...statements, 'RESET ROLE;');
    }
  }
  const sql = ['-- Console DB post-import repair (Setup console-db-role-repair.mjs)', 'BEGIN;', ...roles.statements, ...acl, 'COMMIT;', ''].join('\n');
  return { sql, counts: { ...roles.counts, aclStatements: acl.filter((s) => /^(GRANT|REVOKE) /.test(s)).length }, dropped: roles.dropped };
}
