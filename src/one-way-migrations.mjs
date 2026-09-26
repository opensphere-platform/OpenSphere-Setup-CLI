// Review R1 and re-review F1–F3 (2026-09-26, Console R2D2 activation): some Console migrations
// cannot be undone by installing an earlier release. After the R2D2 task engine cutover commits,
// LangGraph tasks belong to Hermes and releases built before it refuse to create tasks on that
// database. Installing such a release as a "rollback" would put binaries on data they do not fit.
//
// A one-way migration is named by its semantic key and found in a release's verified migration
// manifest; whether it is applied is read from the live ledger, which must be an exact prefix of
// the target's migration chain. Component counts and migration numbers decide nothing.
export const ONE_WAY_MIGRATIONS = Object.freeze({
  'console.osdst.task_engine_cutover': 'R2D2 task engine cutover',
});

export class LedgerMismatch extends Error {}
const mismatch = (reason) => { throw new LedgerMismatch(`The migration ledger does not match the target migration chain: ${reason}`); };
const expectedRow = (entry) => [entry.globalId, entry.semanticKey, entry.predecessorGlobalId || '', entry.sha256,
  entry.sourceRevision, entry.setDigest, String(entry.setSize)];

// How many target migrations the database has applied. Every row must equal the manifest entry at
// its position (identity, key, lineage, file hash, source revision, set digest and size); a row
// that differs, a ledger ahead of the target, or a malformed answer is a mismatch, never "not applied".
export function ledgerPosition(manifest, rows) {
  const chain = manifest?.migrations;
  if (!Array.isArray(chain)) mismatch('the target migration manifest is unavailable');
  if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row) || row.length !== 7 || row.some((v) => typeof v !== 'string'))) {
    mismatch('the ledger answer is malformed');
  }
  if (rows.length > chain.length) mismatch(`the ledger has ${rows.length} migrations, more than the target's ${chain.length}`);
  rows.forEach((row, index) => {
    const expected = expectedRow(chain[index]);
    if (JSON.stringify(row) !== JSON.stringify(expected)) {
      mismatch(`ledger row ${index + 1} (${row[0]} ${row[1]}) differs from ${expected[0]} ${expected[1]}`);
    }
  });
  return rows.length;
}

export function oneWayEntries(manifest) {
  return (manifest?.migrations ?? []).map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => Object.hasOwn(ONE_WAY_MIGRATIONS, entry.semanticKey))
    .map(({ entry, index }) => Object.freeze({ globalId: entry.globalId, semanticKey: entry.semanticKey, sha256: entry.sha256, index }));
}

// Where the database stands against the one-way migrations of the target. readLedger may throw;
// the caller decides what an unreadable ledger means at that point.
export function oneWayBoundary(manifest, readLedger) {
  const entries = oneWayEntries(manifest);
  if (!entries.length) return null;
  const applied = ledgerPosition(manifest, readLedger());
  return Object.freeze({
    entries,
    applied,
    committed: entries.filter((e) => e.index < applied),
    pending: entries.filter((e) => e.index >= applied),
  });
}

// After a failure: how far the database got and which of the pending one-way migrations committed.
// null when that cannot be established: the ledger is unreadable, no longer matches the chain, or
// lost rows it had.
export function progressAfterFailure(manifest, boundary, readLedger) {
  let applied;
  try { applied = ledgerPosition(manifest, readLedger()); } catch { return null; }
  if (applied < boundary.applied) return null;
  return Object.freeze({ applied, committed: boundary.pending.filter((e) => e.index < applied) });
}

export function committedAfterFailure(manifest, boundary, readLedger) {
  return progressAfterFailure(manifest, boundary, readLedger)?.committed ?? null;
}

// A release fits a database past these migrations only if its own verified migration chain
// contains each of them, with the same identity and file hash.
export function releaseIncludes(manifests, entries) {
  if (!Array.isArray(manifests) || !manifests.length) return false;
  return manifests.every((manifest) => entries.every((e) => (manifest?.migrations ?? [])
    .some((m) => m.globalId === e.globalId && m.semanticKey === e.semanticKey && m.sha256 === e.sha256)));
}

export function describeOneWay(entries) {
  return entries.map((e) => `${ONE_WAY_MIGRATIONS[e.semanticKey]} (${e.globalId})`).join(', ');
}

// An interrupted transition recorded in the installation state: which one-way migrations it would
// cross, as plain identities for a later reader.
export function transitionOneWay(boundary) {
  return boundary ? {
    migrations: boundary.entries.map(({ globalId, semanticKey }) => ({ globalId, semanticKey })),
    committedAtStart: boundary.committed.map((e) => e.globalId),
  } : undefined;
}
