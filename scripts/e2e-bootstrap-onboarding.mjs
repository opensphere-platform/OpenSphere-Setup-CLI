#!/usr/bin/env node
// Clean-install acceptance test for the first administrator. Reset tokens and the
// generated password remain process-local and are never printed or persisted.
import crypto from 'node:crypto';
import https from 'node:https';
import { bootstrap } from '../src/bootstrap.mjs';
import { resolveChannel, validateChannel } from '../src/release.mjs';

const channel = process.argv[2] ?? 'edge';
validateChannel(channel);

const initialAdmin = {
  username: 'e2e-admin',
  displayName: 'OpenSphere E2E Administrator',
  email: 'e2e-admin@opensphere.local'
};
const password = `${crypto.randomBytes(24).toString('base64url')}Aa9!`;
const consoleUrl = new URL('https://localhost:8090/');

function request(method, input, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = input instanceof URL ? input : new URL(input, consoleUrl);
    const data = body === undefined ? null : Buffer.from(body);
    const req = https.request({
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      rejectUnauthorized: false,
      headers: { ...headers, ...(data ? { 'content-length': data.length } : {}) }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function decodeHtml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function hiddenInput(html, name) {
  const pattern = new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["'][^>]*>`, 'i');
  const match = html.match(pattern);
  if (!match) throw new Error(`Onboarding page did not contain ${name}`);
  return decodeHtml(match[1]);
}

function expect(response, status, step) {
  if (response.status !== status) throw new Error(`${step}: expected HTTP ${status}, got ${response.status}`);
  return response;
}

const lock = await resolveChannel(channel);
const result = await bootstrap(lock, { initialAdmin, openOnboarding: false });
if (!result.onboardingUrl) throw new Error('Fresh bootstrap did not return a first-administrator onboarding URL');

let response = expect(await request('GET', new URL(result.onboardingUrl)), 200, 'open onboarding Wizard');
const session = hiddenInput(response.text, 'session');
const account = hiddenInput(response.text, 'account');
const setupForm = new URLSearchParams({
  password,
  totp: '',
  session,
  secret: hiddenInput(response.text, 'secret'),
  account,
  otpauth: hiddenInput(response.text, 'otpauth')
}).toString();
response = expect(await request('POST', '/ui/reset', setupForm, {
  'content-type': 'application/x-www-form-urlencoded'
}), 200, 'commit first-administrator credentials');
if (!response.text.includes("You're all set") || !response.text.includes('Your password is enrolled')) {
  throw new Error('First-administrator Wizard did not commit the password-only credential');
}

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const redirectUri = consoleUrl.href;
const authorizeForm = new URLSearchParams({
  client_id: 'opensphere-console',
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'openid profile email groups_name groups',
  state: 'setup-e2e-state',
  nonce: 'setup-e2e-nonce',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  username: initialAdmin.username,
  password,
  totp: ''
}).toString();
response = await request('POST', '/oauth2/openid/opensphere-console/authorize', authorizeForm, {
  'content-type': 'application/x-www-form-urlencoded'
});
expect(response, 302, 'Console administrator authorization');
const redirect = new URL(response.headers.location, consoleUrl);
const code = redirect.searchParams.get('code');
if (!code || redirect.origin !== consoleUrl.origin) throw new Error('Console authorization redirect contract failed');

const tokenForm = new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  redirect_uri: redirectUri,
  client_id: 'opensphere-console',
  code_verifier: verifier
}).toString();
response = expect(await request('POST', '/oauth2/openid/opensphere-console/token', tokenForm, {
  'content-type': 'application/x-www-form-urlencoded'
}), 200, 'Console token exchange');
const idToken = JSON.parse(response.text).id_token;
const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
if (claims.preferred_username !== initialAdmin.username) throw new Error('First-administrator identity claim mismatch');
if (!claims.groups?.includes('opensphere-console-admins')) throw new Error('First administrator is missing the Console admin role');
if (claims.iss !== 'https://localhost:8444/oauth2/openid/opensphere-console' || claims.aud !== 'opensphere-console') {
  throw new Error('Console issuer/audience claims mismatch');
}

for (const path of [
  '/api/identity',
  '/api/rhdh/catalog/entities?limit=1',
  '/api/admin/plugins/catalog',
  '/api/admin/backbone/status',
  '/api/admin/observability/status',
  '/api/admin/plugins/events',
  '/api/proxy/apis/backbone.opensphere.io/v1alpha1/backboneclaims'
]) {
  response = await request('GET', path, undefined, { authorization: `Bearer ${idToken}`, accept: 'application/json' });
  expect(response, 200, `authenticated Console API ${path}`);
}

// The administrator CLI uses persistent P-256 device trust, not a repeatedly
// minted bearer token. Exercise the complete enrollment, short-session and
// immediate-revocation path against the freshly installed Console.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = publicKey.export({ format: 'jwk' });
const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' };
response = expect(await request('POST', '/bff/cli/enrollments', JSON.stringify({
  label: 'setup-e2e-device',
  publicJwk
}), jsonHeaders), 201, 'create CLI device enrollment');
const enrollment = JSON.parse(response.text);

response = expect(await request(
  'GET',
  `/bff/cli/enrollments/${enrollment.enrollmentId}?code=${encodeURIComponent(enrollment.userCode)}`,
  undefined,
  { authorization: `Bearer ${idToken}`, accept: 'application/json' }
), 200, 'inspect CLI device enrollment');
response = expect(await request(
  'POST',
  `/bff/cli/enrollments/${enrollment.enrollmentId}/approve`,
  JSON.stringify({ userCode: enrollment.userCode }),
  { ...jsonHeaders, authorization: `Bearer ${idToken}` }
), 200, 'approve CLI device enrollment');

response = expect(await request(
  'POST',
  `/bff/cli/enrollments/${enrollment.enrollmentId}/poll`,
  JSON.stringify({ pollToken: enrollment.pollToken }),
  jsonHeaders
), 200, 'poll approved CLI device enrollment');
const device = JSON.parse(response.text);

response = expect(await request('POST', '/bff/cli/challenge', JSON.stringify({ deviceId: device.deviceId }), jsonHeaders), 201, 'create CLI device challenge');
const cliChallenge = JSON.parse(response.text);
const challengeMessage = `opensphere-cli-session-v1\n${device.deviceId}\n${cliChallenge.challengeId}\n${cliChallenge.nonce}`;
// Match the production Go CLI's ecdsa.SignASN1 wire format. Node's default
// ECDSA encoding is ASN.1 DER; the Auth BFF verifies that same representation.
const signature = crypto.sign('SHA256', Buffer.from(challengeMessage), privateKey).toString('base64url');
response = expect(await request('POST', '/bff/cli/session', JSON.stringify({
  deviceId: device.deviceId,
  challengeId: cliChallenge.challengeId,
  signature
}), jsonHeaders), 200, 'exchange device proof for short CLI session');
const cliSession = JSON.parse(response.text).accessToken;

response = expect(await request('GET', '/api/admin/backbone/status', undefined, {
  authorization: `Bearer ${cliSession}`,
  accept: 'application/json'
}), 200, 'use short CLI session on managed API');
response = expect(await request('DELETE', `/bff/cli/devices/${device.deviceId}`, undefined, {
  authorization: `Bearer ${idToken}`,
  accept: 'application/json'
}), 200, 'revoke CLI device');
response = expect(await request('POST', '/bff/token/introspect', new URLSearchParams({ token: cliSession }).toString(), {
  'content-type': 'application/x-www-form-urlencoded',
  accept: 'application/json'
}), 200, 'introspect revoked CLI session');
if (JSON.parse(response.text).active !== false) throw new Error('Revoked CLI device session remained active');

console.log('[E2E] First-administrator Wizard, OIDC login, core management APIs, and CLI device trust passed');
