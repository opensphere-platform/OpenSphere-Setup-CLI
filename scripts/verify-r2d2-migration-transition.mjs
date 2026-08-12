import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { materializeSupabaseMigrationSet } from '../src/bootstrap.mjs';

const POSTGRES_IMAGE = process.env.OPENSPHERE_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16';
const DATABASE = 'opensphere_transition';
const PASSWORD = 'r2d2-transition-test';

function sha256(value) {
  return createHash('sha256').update(String(value).replace(/\r\n/gu, '\n'), 'utf8').digest('hex');
}

function migrationManifest(migrations) {
  let predecessorMigrationId = null;
  const entries = migrations.map(({ id, name, sql }) => {
    const entry = {
      id,
      predecessorMigrationId,
      name,
      path: `backend/supabase/migrations/${name}`,
      sha256: sha256(sql),
    };
    predecessorMigrationId = id;
    return entry;
  });
  const material = entries.map(({ id, predecessorMigrationId: predecessor, name, sha256: digest }) =>
    `${id}\n${predecessor ?? '-'}\n${name}\n${digest}`).join('\n');
  return {
    schemaVersion: 2,
    migrationCount: entries.length,
    latestMigrationId: entries.at(-1).id,
    setDigest: `sha256:${sha256(material)}`,
    migrations: entries,
  };
}

function releaseEvidence(rawManifest, manifest) {
  return {
    path: 'backend/supabase/migrations/manifest.json',
    sha256: `sha256:${sha256(rawManifest)}`,
    setDigest: manifest.setDigest,
    latestMigrationId: manifest.latestMigrationId,
    migrationCount: manifest.migrationCount,
  };
}

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, windowsHide: true });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function waitForPostgres(container) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = docker(
      ['exec', container, 'pg_isready', '-U', 'postgres', '-d', DATABASE],
      { allowFailure: true },
    );
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('PostgreSQL did not become ready');
}

async function applyMigrationSet(container, root, manifest) {
  for (const entry of manifest.migrations) {
    const sql = await readFile(join(root, ...entry.path.split('/')), 'utf8');
    docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', DATABASE], { input: sql });
  }
}

const previousRevision = 'a'.repeat(40);
const targetRevision = 'b'.repeat(40);
const migration1 = {
  id: '0001',
  name: '0001_transition_baseline.sql',
  sql: `
CREATE TABLE IF NOT EXISTS r2d2_setup_transition (
  id integer PRIMARY KEY,
  phase text NOT NULL
);
INSERT INTO r2d2_setup_transition (id, phase)
VALUES (1, 'baseline')
ON CONFLICT (id) DO UPDATE SET phase = EXCLUDED.phase;
`,
};
const migration2 = {
  id: '0002',
  name: '0002_transition_target.sql',
  sql: `
ALTER TABLE r2d2_setup_transition ADD COLUMN IF NOT EXISTS target_revision text;
UPDATE r2d2_setup_transition SET phase = 'target', target_revision = '${targetRevision}' WHERE id = 1;
`,
};
const previousMigrations = [migration1];
const targetMigrations = [migration1, migration2];
const previousManifest = migrationManifest(previousMigrations);
const targetManifest = migrationManifest(targetMigrations);
const previousRaw = JSON.stringify(previousManifest, null, 2);
const targetRaw = JSON.stringify(targetManifest, null, 2);
const previousEvidence = releaseEvidence(previousRaw, previousManifest);
const targetEvidence = releaseEvidence(targetRaw, targetManifest);
const previousLock = {
  sourceRevision: previousRevision,
  releaseBom: { migrationManifest: previousEvidence },
};
const targetLock = {
  sourceRevision: targetRevision,
  releaseBom: { migrationManifest: targetEvidence },
};
const artifacts = new Map();
for (const [revision, raw, migrations] of [
  [previousRevision, previousRaw, previousMigrations],
  [targetRevision, targetRaw, targetMigrations],
]) {
  artifacts.set(`${revision}/backend/supabase/migrations/manifest.json`, raw);
  for (const migration of migrations) {
    artifacts.set(`${revision}/backend/supabase/migrations/${migration.name}`, migration.sql);
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const match = String(url).match(/OpenSphere-console\/([a-f0-9]{40})\/(.+)$/u);
  const value = match ? artifacts.get(`${match[1]}/${match[2]}`) : undefined;
  return value === undefined ? new Response('not found', { status: 404 }) : new Response(value, { status: 200 });
};

const work = await mkdtemp(join(tmpdir(), 'opensphere-r2d2-transition-'));
const previousRoot = join(work, 'previous');
const targetRoot = join(work, 'target');
const rollbackRoot = join(work, 'rollback');
const mismatchRoot = join(work, 'mismatch');
const container = `opensphere-r2d2-transition-${randomUUID().slice(0, 8)}`;

try {
  await materializeSupabaseMigrationSet(previousLock, previousRoot);
  await materializeSupabaseMigrationSet(targetLock, targetRoot);
  await materializeSupabaseMigrationSet(previousLock, rollbackRoot, targetRevision, targetEvidence);
  await assert.rejects(
    materializeSupabaseMigrationSet(previousLock, mismatchRoot, targetRevision, previousEvidence),
    /differs from signed Release BOM evidence/,
  );

  docker([
    'run', '--detach', '--name', container,
    '--env', `POSTGRES_PASSWORD=${PASSWORD}`,
    '--env', `POSTGRES_DB=${DATABASE}`,
    POSTGRES_IMAGE,
  ]);
  await waitForPostgres(container);
  await applyMigrationSet(container, previousRoot, previousManifest);
  await applyMigrationSet(container, targetRoot, targetManifest);
  await applyMigrationSet(container, rollbackRoot, targetManifest);
  const phase = docker([
    'exec', container, 'psql', '-At', '-U', 'postgres', '-d', DATABASE,
    '-c', 'SELECT phase || chr(58) || target_revision FROM r2d2_setup_transition WHERE id = 1',
  ]).stdout.trim();
  assert.equal(phase, `target:${targetRevision}`);
  console.log(JSON.stringify({
    ok: true,
    postgresImage: POSTGRES_IMAGE,
    previousMigrationCount: previousManifest.migrationCount,
    targetMigrationCount: targetManifest.migrationCount,
    rollbackEvidence: 'target-release-bom',
    forwardOnlyRollbackReapply: true,
    phase,
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  docker(['rm', '--force', container], { allowFailure: true });
  await rm(work, { recursive: true, force: true });
}
