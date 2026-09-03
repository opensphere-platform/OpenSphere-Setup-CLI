import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseConsoleSourceLock, readConsoleSourceLock,
} from '../scripts/resolve-console-source-lock.mjs';
import {
  verifyConsoleSourceCheckout, verifyConsoleSourceTransition,
} from '../scripts/verify-console-source-checkout.mjs';

const expected = {
  contract: 'opensphere-setup-console-source/v1',
  githubRepository: 'opensphere-platform/OpenSphere-console',
  canonicalUrl: 'https://github.com/opensphere-platform/OpenSphere-console.git',
  revision: '91cb7c99c3b8b499e204e4b6277e37d6bb901137',
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
    { ...expected, revision: `${expected.revision}\nmain` },
    { ...expected, revision: 'refs/heads/main' },
    { ...expected, revision: null },
  ]) {
    assert.throws(() => parseConsoleSourceLock(JSON.stringify(mutation)), /Console source lock/u);
  }
  assert.throws(() => parseConsoleSourceLock('{'), /valid JSON/u);
});

function git(path, ...args) {
  const result = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function gitGraph(t) {
  const path = await mkdtemp(join(tmpdir(), 'opensphere-console-source-lock-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  git(path, 'init', '--initial-branch=main');
  git(path, 'config', 'user.name', 'OpenSphere Test');
  git(path, 'config', 'user.email', 'test@opensphere.local');
  await writeFile(join(path, 'marker'), 'a\n', 'utf8');
  git(path, 'add', '--', 'marker');
  git(path, 'commit', '-m', 'a');
  const first = git(path, 'rev-parse', 'HEAD');
  await writeFile(join(path, 'marker'), 'b\n', 'utf8');
  git(path, 'commit', '-am', 'b');
  const second = git(path, 'rev-parse', 'HEAD');
  git(path, 'checkout', '--detach', first);
  await writeFile(join(path, 'feature'), 'diverged\n', 'utf8');
  git(path, 'add', '--', 'feature');
  git(path, 'commit', '-m', 'feature');
  const diverged = git(path, 'rev-parse', 'HEAD');
  git(path, 'checkout', '--detach', second);
  git(path, 'remote', 'add', 'origin', expected.canonicalUrl);
  git(path, 'update-ref', 'refs/remotes/origin/main', second);
  return { path, first, second, diverged };
}

function lock(revision) {
  return { ...expected, revision };
}

test('Console source transition accepts unchanged and forward-only commits', async (t) => {
  const graph = await gitGraph(t);
  const isAncestor = (older, newer) => spawnSync(
    'git', ['-C', graph.path, 'merge-base', '--is-ancestor', older, newer],
    { windowsHide: true }
  ).status === 0;
  assert.equal(verifyConsoleSourceTransition(
    lock(graph.second), lock(graph.second), isAncestor
  ).mode, 'unchanged');
  assert.equal(verifyConsoleSourceTransition(
    lock(graph.second), lock(graph.first), isAncestor
  ).mode, 'forward');
  assert.throws(() => verifyConsoleSourceTransition(
    lock(graph.first), lock(graph.second), isAncestor
  ), /forward-only/u);
  assert.throws(() => verifyConsoleSourceTransition(
    lock(graph.diverged), lock(graph.second), isAncestor
  ), /forward-only/u);
});

test('Console checkout verifies canonical origin, commit identity, and fetched main reachability', async (t) => {
  const graph = await gitGraph(t);
  const options = {
    current: lock(graph.second),
    previous: lock(graph.first),
    transitionMode: 'previous',
    fetchFn: () => {},
  };
  assert.equal(verifyConsoleSourceCheckout(graph.path, options).transitionMode, 'forward');
  git(graph.path, 'checkout', '--detach', graph.diverged);
  assert.throws(() => verifyConsoleSourceCheckout(graph.path, {
    ...options, current: lock(graph.diverged),
  }), /not reachable/u);
  git(graph.path, 'checkout', '--detach', graph.second);
  git(graph.path, 'remote', 'set-url', 'origin', 'https://example.invalid/OpenSphere-console.git');
  assert.throws(() => verifyConsoleSourceCheckout(graph.path, options), /origin is not canonical/u);
  git(graph.path, 'remote', 'set-url', 'origin', expected.canonicalUrl);
  assert.throws(() => verifyConsoleSourceCheckout(graph.path, {
    ...options, current: lock('f'.repeat(40)),
  }), /locked commit/u);
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

test('CI and public packaging use the governed Console revision instead of floating main', () => {
  for (const path of [
    '../.github/workflows/ci.yml',
    '../.github/workflows/publish-platforms.yml',
  ]) {
    const workflow = readFileSync(new URL(path, import.meta.url), 'utf8');
    const steps = workflow.split(/(?=^      - (?:name|uses):)/mu);
    const checkout = steps.filter((step) => step.includes('path: _fixtures/OpenSphere-console'));
    assert.equal(checkout.length, 1, `${path} must materialize exactly one Console checkout`);
    assert.match(checkout[0], /uses: actions\/checkout@v4/u);
    assert.match(checkout[0],
      /repository: \$\{\{ steps[.]console_source[.]outputs[.]repository \}\}/u);
    assert.match(checkout[0], /ref: \$\{\{ steps[.]console_source[.]outputs[.]revision \}\}/u);
    assert.match(checkout[0], /fetch-depth: 0/u);
    const checkoutIndex = steps.indexOf(checkout[0]);
    const verifyIndex = steps.findIndex((step) => step.includes('name: Verify governed Console checkout'));
    assert.ok(checkoutIndex >= 0 && verifyIndex > checkoutIndex,
      `${path} must verify the Console checkout before consuming it`);
    assert.match(steps[verifyIndex], /verify-console-source-checkout[.]mjs/u);
    assert.equal(steps.slice(verifyIndex + 1)
      .filter((step) => step.includes('_fixtures/OpenSphere-console')).length, 0,
    `${path} must not rewrite the verified Console fixture`);
    assert.doesNotMatch(workflow, /^\s+repository: opensphere-platform\/OpenSphere-console\s*$/mu);
  }
  const platformWorkflow = readFileSync(
    new URL('../.github/workflows/publish-platforms.yml', import.meta.url), 'utf8'
  );
  assert.match(platformWorkflow, /name: Require canonical Setup main release source/u);
  assert.match(platformWorkflow, /BOUND_REF: \$\{\{ github[.]ref \}\}/u);
  assert.match(platformWorkflow, /BOUND_SHA: \$\{\{ github[.]sha \}\}/u);
  assert.match(platformWorkflow, /refs\/heads\/main/u);
  assert.match(platformWorkflow, /rev-parse refs\/remotes\/origin\/main/u);
  assert.doesNotMatch(platformWorkflow, /github[.]event[.]pull_request[.]base[.]sha/u);
});

test('CODEOWNERS protects every Console source authority input', () => {
  const owners = readFileSync(new URL('../.github/CODEOWNERS', import.meta.url), 'utf8');
  for (const path of [
    '/.github/CODEOWNERS', '/.github/workflows/', '/console-source.lock.json',
    '/scripts/resolve-console-source-lock.mjs',
    '/scripts/verify-console-source-checkout.mjs', '/test/console-source-lock.test.mjs',
  ]) {
    assert.match(
      owners,
      new RegExp(`^${path.replaceAll('.', '[.]')} @opensphere-platform @choimars$`, 'mu')
    );
  }
});
