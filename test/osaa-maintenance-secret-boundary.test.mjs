import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const verifySource = readFileSync(new URL('../src/verify.mjs', import.meta.url), 'utf8');

test('installation verification keeps OSAA serving and maintenance credentials separate', () => {
  const runtimeContract = verifySource.match(
    /'opensphere-console\/opensphere-osaa-runtime': \[([\s\S]*?)\n  \],/
  )?.[1] ?? '';
  const maintenanceContract = verifySource.match(
    /'opensphere-console\/opensphere-osaa-maintenance-runtime': \[([\s\S]*?)\n  \],/
  )?.[1] ?? '';

  assert.match(runtimeContract, /'pg-password'/);
  assert.match(runtimeContract, /'observer-pg-password'/);
  assert.match(runtimeContract, /'relay-pg-password'/);
  assert.doesNotMatch(runtimeContract, /maintenance-pg|dialogue-pg|operational-pg/);

  assert.match(maintenanceContract, /'operational-pg-password'/);
  assert.match(maintenanceContract, /'dialogue-pg-password'/);
  assert.doesNotMatch(maintenanceContract, /'pg-password'|'observer-pg-password'|'relay-pg-password'/);
});
