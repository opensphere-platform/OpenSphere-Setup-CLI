import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { shouldUseBrowserSetup } from '../src/bootstrap.mjs';

const bootstrap = await readFile(new URL('../src/bootstrap.mjs', import.meta.url), 'utf8');
const cli = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8');
const acceptance = await readFile(new URL('../scripts/e2e-first-admin.mjs', import.meta.url), 'utf8');

test('clean bootstrap delegates human credentials to the Supabase first-access Wizard', () => {
  assert.match(bootstrap, /recordInitialAdmin\(initialAdmin, 'required'\)/);
  assert.match(bootstrap, /Supabase 최초 관리자 Wizard/);
  assert.doesNotMatch(bootstrap, /passwordConfirm|recover-account|KANIDM_ADMIN_PASSWORD/);
});

test('bootstrap resume never creates the human administrator behind a required Wizard', () => {
  assert.equal(shouldUseBrowserSetup(false, null), true);
  assert.equal(shouldUseBrowserSetup(true, undefined), true);
  assert.equal(shouldUseBrowserSetup(true, { state: 'required' }), true);
  assert.equal(shouldUseBrowserSetup(true, { state: 'claiming' }), true);
  assert.equal(shouldUseBrowserSetup(true, { state: 'complete' }), false);
});

test('Setup never prints or persists a credential-reset URL', () => {
  assert.doesNotMatch(cli, /onboarding-url-file/);
  assert.doesNotMatch(bootstrap, /writeOnboardingUrl|initial-admin-.*\.url|resetToken/);
});

test('clean-cluster acceptance uses Supabase bootstrap and password login contracts', () => {
  assert.match(acceptance, /\/api\/identity\/bootstrap\/status/);
  assert.match(acceptance, /\/api\/identity\/bootstrap/);
  assert.match(acceptance, /\/api\/identity\/session\/login/);
  assert.match(acceptance, /set-cookie/);
  assert.match(acceptance, /\/api\/identity\/session/);
  assert.match(acceptance, /subjectId/);
  assert.match(acceptance, /console-admins/);
  assert.doesNotMatch(acceptance, /\/auth\/v1\/token|authorization[^\n]*bearer/i);
  assert.match(acceptance, /access_token\|refresh_token\|bearer/);
  assert.doesNotMatch(acceptance, /identity\.operators|operator\.roles/);
  assert.doesNotMatch(acceptance, /\/bff\/|\/oauth2\/openid\/|KANIDM/i);
  assert.doesNotMatch(acceptance, /console\.log\([^\n]*(password|secret)/i);
});
