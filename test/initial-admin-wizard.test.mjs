import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const bootstrap = await readFile(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
const provision = await readFile(new URL('../src/provision-admin.mjs', import.meta.url), 'utf8');
const cli = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8');

test('clean bootstrap delegates human credentials to the Console first-access Wizard', () => {
  assert.match(bootstrap, /OPENSPHERE_BROWSER_SETUP:\s*String\(browserSetup\)/);
  assert.match(bootstrap, /browserSetup:\s*!installed/);
  assert.match(provision, /The Console first-access Wizard owns the one-time credential-update session/);
  assert.doesNotMatch(provision, /_credential\/_update_intent\/3600/);
  assert.match(bootstrap, /function recordInitialAdmin[\s\S]{0,500}const existing = readInitialAdmin\(\)/);
  assert.match(bootstrap, /opensphere-initial-admin'[\s\S]{0,120}'--ignore-not-found'/);
});

test('Setup never prints or persists a credential-reset URL', () => {
  assert.doesNotMatch(cli, /onboarding-url-file/);
  assert.doesNotMatch(bootstrap, /writeOnboardingUrl|initial-admin-.*\.url/);
  assert.doesNotMatch(provision, /resetToken/);
});
