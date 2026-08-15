import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  parseConsoleSourceLock, readConsoleSourceLock,
} from '../scripts/resolve-console-source-lock.mjs';

const expected = {
  contract: 'opensphere-setup-console-source/v1',
  githubRepository: 'opensphere-platform/OpenSphere-console',
  canonicalUrl: 'https://github.com/opensphere-platform/OpenSphere-console.git',
  revision: '4d7a08e4a9dcfa805b35428de782851b01045d2d',
};

test('Console source lock is a closed canonical commit authority', () => {
  assert.deepEqual(readConsoleSourceLock(), expected);
  assert.deepEqual(parseConsoleSourceLock(JSON.stringify(expected)), expected);
  for (const mutation of [
    { ...expected, extra: true },
    Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'revision')),
    { ...expected, githubRepository: 'example/OpenSphere-console' },
    { ...expected, canonicalUrl: 'https://example.invalid/OpenSphere-console.git' },
    { ...expected, revision: expected.revision.slice(0, 12) },
    { ...expected, revision: expected.revision.toUpperCase() },
  ]) {
    assert.throws(() => parseConsoleSourceLock(JSON.stringify(mutation)), /Console source lock/u);
  }
  assert.throws(() => parseConsoleSourceLock('{'), /valid JSON/u);
});

test('Console source lock resolver emits only the canonical closed document', () => {
  const result = spawnSync(process.execPath, ['scripts/resolve-console-source-lock.mjs'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.deepEqual(
    JSON.parse(readFileSync(new URL('../console-source.lock.json', import.meta.url), 'utf8')),
    expected
  );
});

test('CI and private packaging use the governed Console revision instead of floating main', () => {
  for (const path of [
    '../.github/workflows/ci.yml',
    '../.github/workflows/publish-private-platforms.yml',
  ]) {
    const workflow = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(workflow, /name: Resolve governed Console source/u);
    assert.match(workflow,
      /repository: \$\{\{ steps[.]console_source[.]outputs[.]repository \}\}/u);
    assert.match(workflow, /ref: \$\{\{ steps[.]console_source[.]outputs[.]revision \}\}/u);
    assert.match(workflow, /name: Verify governed Console checkout/u);
    assert.doesNotMatch(workflow, /^\s+repository: opensphere-platform\/OpenSphere-console\s*$/mu);
  }
});
