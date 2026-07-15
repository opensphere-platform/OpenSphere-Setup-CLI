#!/usr/bin/env node
// Acceptance test for an already-installed Console first-access administrator
// Wizard. Credentials and TOTP material remain process-local and are never
// printed or persisted.
import crypto from 'node:crypto';
import https from 'node:https';

const consoleUrl = new URL(process.env.OPENSPHERE_E2E_CONSOLE || 'https://localhost:18090/');
const authEnvironment = process.env.OPENSPHERE_E2E_AUTH_ENVIRONMENT || 'development';
const initialAdmin = {
  username: process.env.OPENSPHERE_E2E_ADMIN_USERNAME || 'e2e-admin',
  displayName: process.env.OPENSPHERE_E2E_ADMIN_DISPLAY_NAME || 'OpenSphere E2E Administrator',
  email: process.env.OPENSPHERE_E2E_ADMIN_EMAIL || 'e2e-admin@opensphere.local',
};
const password = `${crypto.randomBytes(24).toString('base64url')}Aa9!`;

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
      headers: { ...headers, ...(data ? { 'content-length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function expect(response, status, step) {
  if (response.status !== status) {
    throw new Error(`${step}: expected HTTP ${status}, got ${response.status}`);
  }
  return response;
}

function decodeBase32(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of String(input).replace(/=+$/g, '').toUpperCase()) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error('TOTP secret was not valid base32');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function totp(secret, now = Date.now()) {
  const counter = BigInt(Math.floor(now / 30_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = crypto.createHmac('sha256', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let response = expect(await request('GET', '/bff/setup/status', undefined, {
  accept: 'application/json',
}), 200, 'read first-access Wizard state');
if (JSON.parse(response.text).state !== 'required') {
  throw new Error('Fresh installation did not require the first-access administrator Wizard');
}

response = await request('POST', '/bff/setup/begin', JSON.stringify({
  ...initialAdmin,
  password,
  passwordConfirm: password,
}), {
  origin: consoleUrl.origin,
  'content-type': 'application/json',
  accept: 'application/json',
});

let totpSecret = '';
let enrollmentCounter = -1;
if (authEnvironment === 'production') {
  expect(response, 200, 'start production administrator enrollment');
  const enrollment = JSON.parse(response.text);
  if (enrollment.state !== 'totp-required' || !enrollment.setupId || !enrollment.secret) {
    throw new Error('Production installation did not require TOTP enrollment');
  }
  totpSecret = enrollment.secret;
  enrollmentCounter = Math.floor(Date.now() / 30_000);
  response = expect(await request('POST', '/bff/setup/totp', JSON.stringify({
    setupId: enrollment.setupId,
    code: totp(totpSecret),
  }), {
    origin: consoleUrl.origin,
    'content-type': 'application/json',
    accept: 'application/json',
  }), 201, 'complete production TOTP enrollment');
} else {
  expect(response, 201, 'commit development administrator credentials');
}
if (JSON.parse(response.text).state !== 'complete') {
  throw new Error('First-access administrator Wizard did not complete');
}

response = expect(await request('GET', '/bff/setup/status', undefined, {
  accept: 'application/json',
}), 200, 'read completed Wizard state');
if (JSON.parse(response.text).state !== 'complete') {
  throw new Error('Completed first-access Wizard remained active');
}

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const redirectUri = consoleUrl.href;
if (authEnvironment === 'production') {
  // Do not reuse the code that completed enrollment. Wait for the next RFC6238
  // time window so login also proves the configured authenticator works.
  while (Math.floor(Date.now() / 30_000) <= enrollmentCounter) await sleep(250);
}
const authorizeForm = new URLSearchParams({
  client_id: 'opensphere-console',
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'openid profile email groups_name groups',
  state: 'first-admin-e2e-state',
  nonce: 'first-admin-e2e-nonce',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  username: initialAdmin.username,
  password,
  totp: authEnvironment === 'production' ? totp(totpSecret) : '',
}).toString();

// The enrollment secret is intentionally retained only in this process. A
// fresh time-window code is generated for authorization without persisting it.
response = await request('POST', '/oauth2/openid/opensphere-console/authorize', authorizeForm, {
  'content-type': 'application/x-www-form-urlencoded',
});
expect(response, 302, 'first administrator authorization');
const redirect = new URL(response.headers.location, consoleUrl);
const code = redirect.searchParams.get('code');
if (!code || redirect.origin !== consoleUrl.origin) {
  throw new Error('First administrator authorization redirect contract failed');
}

const tokenForm = new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  redirect_uri: redirectUri,
  client_id: 'opensphere-console',
  code_verifier: verifier,
}).toString();
response = expect(await request('POST', '/oauth2/openid/opensphere-console/token', tokenForm, {
  'content-type': 'application/x-www-form-urlencoded',
}), 200, 'first administrator token exchange');
const idToken = JSON.parse(response.text).id_token;
const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
if (claims.preferred_username !== initialAdmin.username) {
  throw new Error('First-administrator identity claim mismatch');
}
if (!claims.groups?.includes('opensphere-console-admins')) {
  throw new Error('First administrator is missing the Console admin role');
}
if (claims.iss !== `${consoleUrl.origin}/oauth2/openid/opensphere-console` || claims.aud !== 'opensphere-console') {
  throw new Error('Console issuer/audience claims mismatch');
}

response = expect(await request('GET', '/api/identity', undefined, {
  authorization: `Bearer ${idToken}`,
  accept: 'application/json',
}), 200, 'use first administrator session on the managed identity API');

console.log(`[E2E] First-access administrator Wizard and login passed (${authEnvironment})`);
