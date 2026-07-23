import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CONSOLE_URL } from '../src/console-url.mjs';

const consoleSource = process.env.OPENSPHERE_CONSOLE_SOURCE
  ? pathToFileURL(`${resolve(process.env.OPENSPHERE_CONSOLE_SOURCE)}${sep}`)
  : new URL('../../OpenSphere-console/', import.meta.url);

test('Docker Desktop Console contract exposes 1114 and keeps the internal HTTPS target', async () => {
  const manifest = await readFile(
    new URL('deploy/opensphere-console.yaml', consoleSource),
    'utf8'
  );

  assert.equal(DEFAULT_CONSOLE_URL, 'https://localhost:1114');
  assert.match(
    manifest,
    /name:\s*opensphere-console-ext[\s\S]*?name:\s*https[\s\S]*?port:\s*1114[\s\S]*?targetPort:\s*8443/
  );
  assert.doesNotMatch(manifest, /name:\s*opensphere-console-ext[\s\S]*?port:\s*8090/);
});
