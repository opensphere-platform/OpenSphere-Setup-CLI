import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installConsoleCli } from '../src/install-cli.mjs';

async function fixture({
  advertisedBytes,
  servedBytes = advertisedBytes,
  os = 'windows',
  arch = 'amd64',
  href = '/api/cli/os.exe'
}) {
  const digest = createHash('sha256').update(advertisedBytes).digest('hex');
  const manifest = {
    name: 'os', ownership: 'console-native', version: '0.4.0',
    links: [{
      os, arch, href,
      size: advertisedBytes.byteLength, sha256: digest
    }]
  };
  const server = createServer((request, response) => {
    if (request.url === '/api/cli/index.json') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify(manifest));
    }
    if (request.url === href) {
      response.setHeader('content-type', 'application/octet-stream');
      return response.end(servedBytes);
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('installs the Console-owned artifact only after size and digest verification', async () => {
  const bytes = Buffer.from('verified-os-cli');
  const source = await fixture({ advertisedBytes: bytes });
  const directory = await mkdtemp(join(tmpdir(), 'opensphere-os-install-'));
  try {
    const installed = await installConsoleCli({
      consoleUrl: source.url,
      installDirectory: directory,
      platform: 'win32',
      arch: 'x64'
    });
    assert.equal(installed.version, '0.4.0');
    assert.equal(installed.pathUpdated, false);
    assert.deepEqual(await readFile(join(directory, 'os.exe')), bytes);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('installs the native Apple Silicon artifact on macOS', async () => {
  const bytes = Buffer.from('verified-darwin-arm64-cli');
  const source = await fixture({
    advertisedBytes: bytes,
    os: 'darwin',
    arch: 'arm64',
    href: '/api/cli/opensphere-cli-darwin-arm64'
  });
  const directory = await mkdtemp(join(tmpdir(), 'opensphere-os-install-'));
  try {
    const installed = await installConsoleCli({
      consoleUrl: source.url,
      installDirectory: directory,
      platform: 'darwin',
      arch: 'arm64'
    });
    assert.equal(installed.version, '0.4.0');
    assert.deepEqual(await readFile(join(directory, 'os')), bytes);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('digest mismatch fails closed without replacing an existing CLI', async () => {
  const source = await fixture({
    advertisedBytes: Buffer.from('expected'),
    servedBytes: Buffer.from('tampered')
  });
  const directory = await mkdtemp(join(tmpdir(), 'opensphere-os-install-'));
  const current = Buffer.from('current-cli');
  await writeFile(join(directory, 'os.exe'), current);
  try {
    await assert.rejects(() => installConsoleCli({
      consoleUrl: source.url,
      installDirectory: directory,
      platform: 'win32',
      arch: 'x64',
      updatePath: false
    }), /size differs|digest differs/);
    assert.deepEqual(await readFile(join(directory, 'os.exe')), current);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a verified reinstall replaces an existing CLI without a fixed backup collision', async () => {
  const source = await fixture({ advertisedBytes: Buffer.from('new-verified-cli') });
  const directory = await mkdtemp(join(tmpdir(), 'opensphere-os-install-'));
  await writeFile(join(directory, 'os.exe'), Buffer.from('old-cli'));
  // This legacy fixed backup name reproduced the Windows EPERM failure in the
  // previous installer. The new transaction must not touch or reuse it.
  await writeFile(join(directory, 'os.exe.previous'), Buffer.from('legacy-backup'));
  try {
    await installConsoleCli({
      consoleUrl: source.url,
      installDirectory: directory,
      platform: 'win32',
      arch: 'x64',
      updatePath: false
    });
    assert.deepEqual(await readFile(join(directory, 'os.exe')), Buffer.from('new-verified-cli'));
    assert.deepEqual(await readFile(join(directory, 'os.exe.previous')), Buffer.from('legacy-backup'));
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
