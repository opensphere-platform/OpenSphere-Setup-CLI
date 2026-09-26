// Review R1 (2026-09-26, Console R2D2 activation): some Console migrations cannot be undone by
// installing the previous release. After the R2D2 task engine cutover commits, LangGraph tasks
// belong to Hermes and the previous images refuse to create tasks on that database, so a
// "rollback" would install binaries that do not fit the data and remove the worker.
//
// A one-way migration is identified by its semantic key in the release's verified migration
// manifest and by the live ledger, never by a component count or a migration number.
export const ONE_WAY_MIGRATIONS = Object.freeze({
  'console.osdst.task_engine_cutover': 'R2D2 task engine cutover',
});

// The one-way migrations this upgrade would apply: in the target manifest, not yet in the ledger.
// The ledger is read only when the target carries one; a read failure stops the upgrade before
// any change, because afterwards the outcome could not be told apart.
export function pendingOneWayMigrations(manifest, readLedger) {
  const oneWay = (manifest?.migrations ?? []).filter((entry) => Object.hasOwn(ONE_WAY_MIGRATIONS, entry.semanticKey));
  if (!oneWay.length) return [];
  let rows;
  try { rows = readLedger(); } catch (error) {
    throw new Error(`The migration ledger could not be read before an upgrade that includes a one-way migration; nothing was changed: ${error.message}`);
  }
  return Object.freeze(oneWay.filter((entry) => !applied(rows, entry))
    .map((entry) => Object.freeze({ globalId: entry.globalId, semanticKey: entry.semanticKey })));
}

// After a failure: which of those committed. null means it cannot be established.
export function committedOneWayMigrations(pending, readLedger) {
  let rows;
  try { rows = readLedger(); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  return pending.filter((entry) => applied(rows, entry));
}

function applied(rows, entry) {
  if (!Array.isArray(rows)) throw new Error('Migration ledger rows are not a list');
  return rows.some((row) => row[0] === entry.globalId && row[1] === entry.semanticKey);
}

export function describeOneWay(pending) {
  return pending.map((entry) => `${ONE_WAY_MIGRATIONS[entry.semanticKey]} (${entry.globalId})`).join(', ');
}
