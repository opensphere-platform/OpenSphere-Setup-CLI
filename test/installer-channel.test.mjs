import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const edge = (await readFile(new URL('../channels/edge', import.meta.url), 'utf8')).trim();
const candidate = (await readFile(new URL('../channels/candidate', import.meta.url), 'utf8')).trim();
const stable = (await readFile(new URL('../channels/stable', import.meta.url), 'utf8')).trim();
const workflow = await readFile(new URL('../.github/workflows/publish-platforms.yml', import.meta.url), 'utf8');
const documentation = await readFile(new URL('../docs/PLATFORM-INSTALL.md', import.meta.url), 'utf8');

test('published edge channel may lag the source candidate but cannot lead it', () => {
  assert.match(pkg.version, /^[0-9]+[.][0-9]+[.][0-9]+-edge[.][0-9]+$/);
  const pattern = /^setup-v([0-9]+)[.]([0-9]+)[.]([0-9]+)-edge[.]([0-9]+)$/;
  assert.match(edge, pattern);
  const published = edge.match(pattern).slice(1).map(Number);
  const candidateVersion = `setup-v${pkg.version}`.match(pattern).slice(1).map(Number);
  const firstDifference = published.map((value, index) => value - candidateVersion[index]).find(value => value !== 0);
  assert.ok(firstDifference === undefined || firstDifference < 0, 'Unpublished candidate must not move the public channel forward');
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
test('executed CLI reports the package version for version and help',async()=>{
  const {spawnSync}=await import('node:child_process');
  for(const arg of ['version','--help']) {
    const result=spawnSync(process.execPath,['src/cli.mjs',arg],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.ok(result.stdout.includes(pkg.version),result.stdout);
    if(arg==='version')assert.equal(result.stdout.trim(),`opensphere-setup ${pkg.version}`);
  }
});
