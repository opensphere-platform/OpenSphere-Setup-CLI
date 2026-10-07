// Consumer side of the one-way migration conformance (re-review decision 1, 2026-09-26). The
// fixture is published by Console (scripts/sync-one-way-migrations.mjs --setup-root) from its
// declaration and its migration manifest; Setup must recognize exactly those migrations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ONE_WAY_MIGRATIONS, oneWayEntries, oneWayBoundary, releaseIncludes } from '../src/one-way-migrations.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/one-way-migrations-v1.json', import.meta.url), 'utf8'));

test('Setup recognizes exactly the one-way migrations Console declares', () => {
  assert.equal(fixture.schema, 'opensphere.one-way-migrations-fixture/v1');
  assert.ok(fixture.migrations.length > 0);
  assert.deepEqual(Object.keys(ONE_WAY_MIGRATIONS).sort(), fixture.migrations.map((m) => m.semanticKey).sort(),
    'a one-way boundary Console declares is missing from Setup, or Setup names one Console does not declare');
});

test('each declared one-way migration is found in a chain and decides the rollback candidate', () => {
  for (const m of fixture.migrations) {
    const entry = { ...m, sourceRevision: 'f'.repeat(40), setDigest: `sha256:${'5'.repeat(64)}`, setSize: 1 };
    const predecessor = { globalId: m.predecessorGlobalId, semanticKey: 'console.fixture.predecessor', predecessorGlobalId: '',
      sha256: '0'.repeat(64), sourceRevision: 'f'.repeat(40), setDigest: `sha256:${'5'.repeat(64)}`, setSize: 0 };
    const chain = { schemaVersion: 1, migrations: [predecessor, entry] };
    assert.deepEqual(oneWayEntries(chain).map((e) => [e.globalId, e.semanticKey, e.sha256]), [[m.globalId, m.semanticKey, m.sha256]]);
    const row = (e) => [e.globalId, e.semanticKey, e.predecessorGlobalId, e.sha256, e.sourceRevision, e.setDigest, String(e.setSize)];
    assert.equal(oneWayBoundary(chain, () => [row(predecessor)]).pending.length, 1);
    const crossed = oneWayBoundary(chain, () => [row(predecessor), row(entry)]);
    assert.equal(crossed.committed.length, 1);
    assert.equal(releaseIncludes([chain], crossed.committed), true);
    assert.equal(releaseIncludes([{ migrations: [predecessor] }], crossed.committed), false, 'a release built before it is not a rollback');
    assert.equal(releaseIncludes([{ migrations: [predecessor, { ...entry, sha256: '1'.repeat(64) }] }], crossed.committed), false, 'another file hash does not count');
  }
});
