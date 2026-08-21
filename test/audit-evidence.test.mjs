import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const collector = readFileSync(new URL('../scripts/collect-audit-evidence.sh', import.meta.url), 'utf8');

test('edge audit evidence remains a local-run responsibility instead of a GitHub artifact', () => {
  assert.doesNotMatch(workflow, /Collect redacted audit evidence/);
  assert.doesNotMatch(workflow, /audit-evidence-supabase/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
  assert.doesNotMatch(workflow, /retention-days:/);
});

test('evidence collector records runtime facts but never reads Secret objects or data', () => {
  assert.match(collector, /installation-lock\.yaml/);
  assert.match(collector, /release-inventory\.yaml/);
  assert.match(collector, /audit-runtime-boundary\.txt/);
  assert.match(collector, /clusterrole\/dupa-console-evidence-reader/);
  assert.match(collector, /statefulset\/opensphere-supabase-postgres/);
  assert.match(collector, /clusterrolebinding\/opensphere-console-backend/);
  assert.doesNotMatch(collector, /app\.kubernetes\.io\/part-of=opensphere/);
  assert.doesNotMatch(collector, /\bget\s+secrets?\b/i);
  assert.doesNotMatch(collector, /\bdescribe\s+secrets?\b/i);
});
