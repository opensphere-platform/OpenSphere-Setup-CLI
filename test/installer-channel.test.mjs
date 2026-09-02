import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const edge = (await readFile(new URL('../channels/edge', import.meta.url), 'utf8')).trim();
const candidate = (await readFile(new URL('../channels/candidate', import.meta.url), 'utf8')).trim();
const stable = (await readFile(new URL('../channels/stable', import.meta.url), 'utf8')).trim();
const workflow = await readFile(new URL('../.github/workflows/publish-platforms.yml', import.meta.url), 'utf8');
const documentation = await readFile(new URL('../docs/PLATFORM-INSTALL.md', import.meta.url), 'utf8');

test('current Setup package is the declared edge channel target', () => {
  assert.match(pkg.version, /^[0-9]+[.][0-9]+[.][0-9]+-edge[.][0-9]+$/);
  assert.equal(edge, `setup-v${pkg.version}`);
  assert.equal(candidate, 'HOLD');
  assert.equal(stable, 'HOLD');
});

test('release publication binds version, channel pointer and prerelease class', () => {
  assert.match(workflow, /Require declared Setup CLI channel pointer/);
  assert.match(workflow, /Package version has no supported Setup CLI channel/);
  assert.match(workflow, /prerelease flag must be/);
  assert.match(workflow, /candidate[/]stable Setup publication remains on HOLD/);
});

test('Setup package selectors remain separate from Console release selection', () => {
  assert.match(documentation, /--version <semver>/);
  assert.match(documentation, /--channel <edge[|]candidate[|]stable>/);
  assert.match(documentation, /상호 배타적/);
  assert.match(documentation, /Console.*--release.*--lock/s);
});