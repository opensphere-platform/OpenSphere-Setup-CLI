import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const collector = readFileSync(new URL('../scripts/collect-audit-evidence.sh', import.meta.url), 'utf8');

test('clean-cluster CI preserves redacted, post-run audit evidence on success and failure', () => {
  assert.match(workflow, /Collect redacted audit evidence[\s\S]*?if: always\(\)/);
  assert.match(workflow, /Collect redacted upgrade and rollback evidence[\s\S]*?if: always\(\)/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /retention-days: 90/);
});

test('evidence collector records runtime facts but never reads Secret objects or data', () => {
  assert.match(collector, /installation-lock\.yaml/);
  assert.match(collector, /release-inventory\.yaml/);
  assert.match(collector, /audit-runtime-boundary\.txt/);
  assert.doesNotMatch(collector, /\bget\s+secrets?\b/i);
  assert.doesNotMatch(collector, /\bdescribe\s+secrets?\b/i);
});
