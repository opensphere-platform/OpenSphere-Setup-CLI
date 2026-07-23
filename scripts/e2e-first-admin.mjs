#!/usr/bin/env node
// Acceptance test for the Supabase-backed first-access administrator Wizard.
// The generated password remains process-local and is never printed or saved.
import crypto from 'node:crypto';
import https from 'node:https';

const consoleUrl = new URL(process.env.OPENSPHERE_E2E_CONSOLE || 'https://localhost:18090/');
const initialAdmin = {
  username: process.env.OPENSPHERE_E2E_ADMIN_USERNAME || 'e2e-admin',
  displayName: process.env.OPENSPHERE_E2E_ADMIN_DISPLAY_NAME || 'OpenSphere E2E Administrator',
  email: process.env.OPENSPHERE_E2E_ADMIN_EMAIL || 'e2e-admin@opensphere.local'
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

function expect(response, status, step) {
  if (response.status !== status) {
    throw new Error(`${step}: expected HTTP ${status}, got ${response.status}`);
  }
  return response;
}

let response = expect(await request('GET', '/api/identity/bootstrap/status', undefined, {
  accept: 'application/json'
}), 200, 'read Supabase first-access state');
if (JSON.parse(response.text).state !== 'required') {
  throw new Error('Fresh installation did not require the Supabase administrator Wizard');
}

response = expect(await request('POST', '/api/identity/bootstrap', JSON.stringify({
  ...initialAdmin,
  password,
  passwordConfirm: password
}), {
  origin: consoleUrl.origin,
  'content-type': 'application/json',
  accept: 'application/json'
}), 201, 'create first Supabase administrator');
const created = JSON.parse(response.text);
if (created.state !== 'complete' || !created.userId) {
  throw new Error('Supabase first-access administrator was not completed');
}

response = expect(await request('GET', '/api/identity/bootstrap/status', undefined, {
  accept: 'application/json'
}), 200, 'read completed Supabase first-access state');
if (JSON.parse(response.text).state !== 'complete') {
  throw new Error('Completed Supabase first-access Wizard remained active');
}

response = expect(await request(
  'POST',
  '/auth/v1/token?grant_type=password',
  JSON.stringify({ email: initialAdmin.email, password }),
  { 'content-type': 'application/json', accept: 'application/json' }
), 200, 'Supabase password login');
const session = JSON.parse(response.text);
if (!session.access_token || session.user?.id !== created.userId) {
  throw new Error('Supabase login subject differs from the canonical first administrator');
}

response = expect(await request('GET', '/api/identity', undefined, {
  authorization: `Bearer ${session.access_token}`,
  accept: 'application/json'
}), 200, 'use Supabase administrator session on the managed identity API');
const identity = JSON.parse(response.text);
const operator = (identity.operators ?? []).find((item) => item.userId === created.userId);
if (!operator || !(operator.roles ?? []).includes('console-admins')) {
  throw new Error('First Supabase administrator is missing the canonical Console admin role');
}

console.log('[E2E] Supabase first-access administrator Wizard and login passed');
