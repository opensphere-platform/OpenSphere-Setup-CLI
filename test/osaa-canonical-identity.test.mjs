import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CUTOVER = 'src/release-agent-identity-cutover.mjs';
const HISTORICAL_MIGRATION = 'backend/supabase/migrations/0038_oaa_watch_cursor_status_vocabulary.sql';

function filesUnder(path) {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? filesUnder(child) : [child];
  });
}

test('active Setup surface exposes OSAA only and isolates the exact installed-lock cutover reader', () => {
  const findings = [];
  for (const root of ['src', 'scripts', 'docs']) {
    for (const path of filesUnder(join(ROOT, root))) {
      const name = relative(ROOT, path).replaceAll('\\', '/');
      if (name === CUTOVER || name === 'src/installation-lock-recovery.mjs') continue;
      const contents = readFileSync(path, 'utf8');
      for (const [index, line] of contents.split(/\r?\n/u).entries()) {
        if (!/oaa/iu.test(line)) continue;
        if (name === 'src/bootstrap.mjs' && line.includes(HISTORICAL_MIGRATION)) continue;
        findings.push(`${name}:${index + 1}:${line.trim()}`);
      }
    }
  }
  assert.deepEqual(findings, []);

  const cutover = readFileSync(join(ROOT, CUTOVER), 'utf8');
  assert.match(cutover, /never used to accept a\s*\/\/ new request/iu);
  assert.match(cutover, /oaaGateway[\s\S]*osaaGateway/u);
  assert.doesNotMatch(cutover, /export\s+(?:const|function)\s+.*(?:route|endpoint|alias)/iu);
});
