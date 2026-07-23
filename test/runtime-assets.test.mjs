import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeRuntimeAsset } from '../src/runtime-assets.mjs';

test('package execution resolves runtime assets without copying them', async () => {
  const asset = await materializeRuntimeAsset('New-Certificates.ps1', '/opt/opensphere/setup');
  assert.equal(asset.path, process.platform === 'win32'
    ? '\\opt\\opensphere\\setup\\New-Certificates.ps1'
    : '/opt/opensphere/setup/New-Certificates.ps1');
  await asset.cleanup();
});
