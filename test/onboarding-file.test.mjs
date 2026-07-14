import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeOnboardingUrl } from '../src/bootstrap.mjs';

test('headless onboarding stores the one-time URL in a private file instead of stdout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensphere-onboarding-'));
  const target = join(directory, 'initial-admin.url');
  try {
    await writeOnboardingUrl('https://console.example.test/ui/reset?token=one-time-value', target);
    assert.equal(await readFile(target, 'utf8'), 'https://console.example.test/ui/reset?token=one-time-value\n');
    if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o077, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
