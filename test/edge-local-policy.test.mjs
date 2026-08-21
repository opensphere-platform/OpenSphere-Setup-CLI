import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('GitHub Actions never resolves, installs, publishes, or deploys the edge channel', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const executable = workflow
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(executable, /(?:resolve|bootstrap|publish|deploy)[^\n]*--release\s+edge/iu);
  assert.doesNotMatch(executable, /helm\/kind-action|upload-artifact|kind-opensphere-e2e/iu);
});
