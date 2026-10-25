// Consumer side of the one-way migration conformance (re-review decision 1, 2026-09-26). The
// fixture is published by Console (scripts/sync-one-way-migrations.mjs --setup-root) from its
// declaration and its migration manifest; Setup must recognize exactly those migrations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ONE_WAY_MIGRATIONS, oneWayEntries, oneWayBoundary, releaseIncludes } from '../src/one-way-migrations.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/one-way-migrations-v1.json', import.meta.url), 'utf8'));
const producer=process.env.OPENSPHERE_CONSOLE_SOURCE;
const producerRequired={skip:producer?false:'governed Console checkout is not configured'};
const setupRoot=fileURLToPath(new URL('../',import.meta.url));
const generator='scripts/sync-one-way-migrations.mjs';
const producerFixture='packages/contracts/fixtures/one-way-migrations-v1.json';

// Execute the governed producer's unchanged generator. --check is read-only;
// predecessor mutations below occur only in an isolated temporary copy.
const check=(source,consumer)=>spawnSync(process.execPath,[resolve(source,generator),'--check','--setup-root',consumer],{
  encoding:'utf8',windowsHide:true,cwd:source,
});
test('the governed producer manifest regenerates the exact whole producer and Setup fixtures',producerRequired,()=>{
  const checked=check(producer,setupRoot);
  assert.equal(checked.status,0,checked.stderr);
  assert.deepEqual(fixture,JSON.parse(readFileSync(resolve(producer,producerFixture),'utf8')));
});

for(const changed of ['producer fixture','consumer fixture','manifest']){
  test('normal producer check rejects a changed predecessor in the '+changed,producerRequired,()=>{
    const temporary=mkdtempSync(join(tmpdir(),'opensphere-one-way-conformance-'));
    const source=join(temporary,'console'),consumer=join(temporary,'setup');
    const write=(root,path,raw)=>{const destination=join(root,path);mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,raw);};
    try{
      for(const path of [generator,producerFixture,'packages/contracts/runtime/one-way-migrations.json','migrations/manifest.json'])write(source,path,readFileSync(resolve(producer,path)));
      write(consumer,'package.json',JSON.stringify({name:'@opensphere/setup-cli'}));
      write(consumer,'test/fixtures/one-way-migrations-v1.json',readFileSync(resolve(setupRoot,'test/fixtures/one-way-migrations-v1.json')));
      assert.equal(check(source,consumer).status,0,'the isolated copy must first pass the real producer check');
      const root=changed==='consumer fixture'?consumer:source;
      const path=changed==='manifest'?'migrations/manifest.json':changed==='consumer fixture'?'test/fixtures/one-way-migrations-v1.json':producerFixture;
      const value=JSON.parse(readFileSync(resolve(root,path),'utf8'));
      const migration=value.migrations.find(entry=>entry.semanticKey==='console.r2d2.native_request_journal');
      assert.ok(migration);assert.notEqual(migration.predecessorGlobalId,'opensphere-console/20261019/0143','the original stale predecessor cannot be the passing baseline');
      migration.predecessorGlobalId='opensphere-console/20261019/0143';write(root,path,JSON.stringify(value,null,2)+'\n');
      const rejected=check(source,consumer);
      assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/Stale one-way migration fixture/);
    }finally{rmSync(temporary,{recursive:true,force:true});}
  });
}

test('Setup recognizes exactly the one-way migrations Console declares', () => {
  assert.equal(fixture.schema, 'opensphere.one-way-migrations-fixture/v1');
  assert.ok(fixture.migrations.length > 0);
  assert.deepEqual(Object.keys(ONE_WAY_MIGRATIONS).sort(), fixture.migrations.map((m) => m.semanticKey).sort(),
    'a one-way boundary Console declares is missing from Setup, or Setup names one Console does not declare');
});

test('each declared one-way migration is found in a chain and decides the rollback candidate', () => {
  for (const m of fixture.migrations) {
    const entry = { ...m, sourceRevision: 'f'.repeat(40), setDigest: `sha256:${'5'.repeat(64)}`, setSize: 1 };
    const predecessor = { globalId: m.predecessorGlobalId, semanticKey: 'console.fixture.predecessor', predecessorGlobalId: '',
      sha256: '0'.repeat(64), sourceRevision: 'f'.repeat(40), setDigest: `sha256:${'5'.repeat(64)}`, setSize: 0 };
    const chain = { schemaVersion: 1, migrations: [predecessor, entry] };
    assert.deepEqual(oneWayEntries(chain).map((e) => [e.globalId, e.semanticKey, e.sha256]), [[m.globalId, m.semanticKey, m.sha256]]);
    const row = (e) => [e.globalId, e.semanticKey, e.predecessorGlobalId, e.sha256, e.sourceRevision, e.setDigest, String(e.setSize)];
    assert.equal(oneWayBoundary(chain, () => [row(predecessor)]).pending.length, 1);
    const crossed = oneWayBoundary(chain, () => [row(predecessor), row(entry)]);
    assert.equal(crossed.committed.length, 1);
    assert.equal(releaseIncludes([chain], crossed.committed), true);
    assert.equal(releaseIncludes([{ migrations: [predecessor] }], crossed.committed), false, 'a release built before it is not a rollback');
    assert.equal(releaseIncludes([{ migrations: [predecessor, { ...entry, sha256: '1'.repeat(64) }] }], crossed.committed), false, 'another file hash does not count');
  }
});
