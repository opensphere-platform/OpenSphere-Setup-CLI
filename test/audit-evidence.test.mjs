import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const collector = readFileSync(new URL('../scripts/collect-audit-evidence.sh', import.meta.url), 'utf8');

function escapeRegex(value) {
  return value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

test('edge audit evidence remains a local-run responsibility instead of a GitHub artifact', () => {
  assert.doesNotMatch(workflow, /Collect redacted audit evidence/);
  assert.doesNotMatch(workflow, /audit-evidence-supabase/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
  assert.doesNotMatch(workflow, /retention-days:/);
});

test('evidence collector is scoped to the exact target bootstrap ownership set', () => {
  for (const namespace of [
    'opensphere-console-data',
    'opensphere-console-change',
    'opensphere-monitoring',
    'opensphere-console',
    'opensphere-system'
  ]) assert.match(collector, new RegExp('^  ' + namespace + '$', 'mu'));

  for (const foreignNamespace of [
    'opensphere-foundation',
    'opensphere-osaa-credentials',
    'opensphere-developer',
    'opensphere-www'
  ]) assert.doesNotMatch(collector, new RegExp('^  ' + foreignNamespace + '$', 'mu'));

  for (const resource of [
    'customresourcedefinition/uipluginpackages.plugins.opensphere.io',
    'customresourcedefinition/uipluginregistrations.plugins.opensphere.io',
    'clusterrole/opensphere-extension-controller-cli-downloads',
    'clusterrole/opensphere-registry',
    'clusterrolebinding/opensphere-extension-controller-cli-downloads',
    'clusterrolebinding/opensphere-registry',
    'validatingadmissionpolicy/opensphere-console-manual-ui-contract',
    'validatingadmissionpolicybinding/opensphere-console-image-integrity-cronjob'
  ]) assert.match(collector, new RegExp(escapeRegex(resource)));
});

test('evidence collector records target runtime facts but never reads Secret objects or data', () => {
  assert.match(collector, /installation-lock\.yaml/);
  assert.match(collector, /installation-state\.yaml/);
  assert.match(collector, /installation-evidence\.yaml/);
  assert.match(collector, /release-inventory\.yaml/);
  assert.match(collector, /audit-runtime-boundary\.txt/);
  assert.match(collector, /statefulset\/opensphere-supabase-postgres/);
  assert.match(collector, /opensphere_console_api_runtime/);
  assert.match(collector, /console_audit_event_rls/);
  assert.doesNotMatch(collector, /app\.kubernetes\.io\/part-of=opensphere/);
  assert.doesNotMatch(collector, /\bget\s+secrets?\b/i);
  assert.doesNotMatch(collector, /\bdescribe\s+secrets?\b/i);
});
