#!/usr/bin/env node
// Acceptance test for the C_API-owned first-access administrator and browser session.
// The generated password and opaque cookie values remain process-local and are never printed or saved.
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
        setCookies: Array.isArray(res.headers['set-cookie'])
          ? res.headers['set-cookie']
          : (res.headers['set-cookie'] ? [res.headers['set-cookie']] : []),
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function expect(response, status, step) {
  if (response.status !== status) throw new Error(`${step}: expected HTTP ${status}, got ${response.status}`);
  return response;
}

let response = expect(await request('GET', '/api/identity/bootstrap/status', undefined, {
  accept: 'application/json'
}), 200, 'read first-access state');
if (JSON.parse(response.text).state !== 'required') throw new Error('Fresh installation did not require the administrator Wizard');

response = expect(await request('POST', '/api/identity/bootstrap', JSON.stringify({
  ...initialAdmin, password, passwordConfirm: password
}), {
  origin: consoleUrl.origin, 'content-type': 'application/json', accept: 'application/json'
}), 201, 'create first administrator');
const created = JSON.parse(response.text);
if (created.state !== 'complete' || Object.hasOwn(created, 'userId')) {
  throw new Error('First-administrator bootstrap response differs from its safe closed contract');
}

response = expect(await request('GET', '/api/identity/bootstrap/status', undefined, {
  accept: 'application/json'
}), 200, 'read completed first-access state');
if (JSON.parse(response.text).state !== 'complete') throw new Error('Completed first-access Wizard remained active');

response = expect(await request('POST', '/api/identity/session/login', JSON.stringify({
  email: initialAdmin.email, password
}), {
  origin: consoleUrl.origin, 'content-type': 'application/json', accept: 'application/json'
}), 200, 'create opaque C_API browser session');
const login = JSON.parse(response.text);
if (login.mfaRequired !== false || login.mfaEnrollmentRequired !== true || !login.session?.id) {
  throw new Error('First administrator login did not return the expected enrollment-required session projection');
}
if (response.setCookies.length !== 2) throw new Error('C_API login did not return the exact session and CSRF cookie pair');
const cookiePairs = response.setCookies.map((value) => String(value).split(';', 1)[0]);
if (!cookiePairs.some((value) => value.startsWith('__Host-opensphere-session='))
    || !cookiePairs.some((value) => value.startsWith('__Host-opensphere_csrf='))) {
  throw new Error('C_API login cookies differ from the opaque browser-session contract');
}
const cookie = cookiePairs.join('; ');

response = expect(await request('GET', '/api/identity/session', undefined, {
  cookie, accept: 'application/json'
}), 200, 'read current C_API browser session');
const sessionEnvelope = JSON.parse(response.text);
if (sessionEnvelope.authority !== 'SupabaseAuth'
    || sessionEnvelope.freshness !== 'fresh'
    || sessionEnvelope.data?.state !== 'Active'
    || sessionEnvelope.data?.email !== initialAdmin.email
    || sessionEnvelope.data?.username !== initialAdmin.username
    || !sessionEnvelope.data?.subjectId
    || !sessionEnvelope.data?.groups?.includes('console-admins')) {
  throw new Error('Current C_API session ReadEnvelope differs from the first administrator authority');
}

response = expect(await request('GET', '/api/identity', undefined, {
  cookie, accept: 'application/json'
}), 200, 'read managed identity inventory through the C_API session');
const identity = JSON.parse(response.text);
const operator = (identity.users ?? []).find((item) => item.id === sessionEnvelope.data.subjectId);
const operatorRoles = (operator?.groups ?? []).map((group) => group?.name).filter(Boolean);
if (!operator || operator.email !== initialAdmin.email || operator.username !== initialAdmin.username
    || !operatorRoles.includes('console-admins')) {
  throw new Error('First administrator is missing from the cookie-authenticated managed identity inventory');
}
if (/access_token|refresh_token|bearer/i.test(response.text)) {
  throw new Error('Managed identity response exposed a raw authority credential');
}

console.log('[E2E] first-access administrator and opaque C_API browser session passed');
