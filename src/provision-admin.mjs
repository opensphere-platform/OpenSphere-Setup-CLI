#!/usr/bin/env node
import https from 'node:https';
import { spawnSync } from 'node:child_process';

const BASE = process.env.KANIDM_BOOTSTRAP_URL || 'https://localhost:18443';
const PASSWORD = process.env.KANIDM_ADMIN_PASSWORD;
const ADMIN = process.env.OPENSPHERE_INITIAL_ADMIN || 'opensphere-admin';
const ADMIN_DISPLAY = process.env.OPENSPHERE_INITIAL_ADMIN_DISPLAY || 'OpenSphere Administrator';
const ADMIN_EMAIL = process.env.OPENSPHERE_INITIAL_ADMIN_EMAIL || 'admin@opensphere.local';
const SKIP_SERVICE_TOKENS = process.env.OPENSPHERE_SKIP_SERVICE_TOKENS === 'true';

if (!PASSWORD) throw new Error('KANIDM_ADMIN_PASSWORD is required');

function request(method, path, body, token, sid) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const url = new URL(path, BASE);
    const req = https.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      rejectUnauthorized: false,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(sid ? { 'x-kanidm-auth-session-id': sid } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: response.statusCode, sid: response.headers['x-kanidm-auth-session-id'], json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function authenticate() {
  let response = await request('POST', '/v1/auth', { step: { init: 'idm_admin' } });
  if (response.status !== 200 || !response.sid) throw new Error('Kanidm admin auth initialization failed');
  const sid = response.sid;
  response = await request('POST', '/v1/auth', { step: { begin: 'password' } }, undefined, sid);
  if (response.status !== 200) throw new Error('Kanidm admin password mechanism failed');
  response = await request('POST', '/v1/auth', { step: { cred: { password: PASSWORD } } }, undefined, sid);
  const token = response.json?.state?.success;
  if (!token) throw new Error('Kanidm admin authentication failed');
  return token;
}

async function ensureEntry(token, path, body) {
  const current = await request('GET', path, undefined, token);
  // Kanidm represents an absent Option<Entry> as HTTP 200 with a JSON null body.
  if (current.status === 200 && current.json !== null) return;
  if (current.status !== 404 && !(current.status === 200 && current.json === null)) {
    throw new Error(`Entry check failed ${path}: HTTP ${current.status}`);
  }
  const collection = path.slice(0, path.lastIndexOf('/'));
  const created = await request('POST', collection, body, token);
  if (created.status >= 300) throw new Error(`Entry create failed ${path}: HTTP ${created.status} ${created.text}`);
}

async function addMember(token, group, member) {
  const response = await request('POST', `/v1/group/${encodeURIComponent(group)}/_attr/member`, [member], token);
  if (response.status >= 300 && response.status !== 409) {
    throw new Error(`Group membership failed ${group}/${member}: HTTP ${response.status}`);
  }
}

async function serviceToken(token, account, displayName, readWrite) {
  await ensureEntry(token, `/v1/service_account/${account}`, {
    attrs: { name: [account], displayname: [displayName], entry_managed_by: ['idm_admin'] }
  });
  const response = await request('POST', `/v1/service_account/${account}/_api_token`, {
    label: 'opensphere-console-bootstrap', expiry: null, read_write: readWrite
  }, token);
  if (response.status >= 300 || typeof response.json !== 'string') {
    throw new Error(`API token generation failed for ${account}: HTTP ${response.status}`);
  }
  return response.json;
}

function applySecret(name, token) {
  const create = spawnSync('kubectl', [
    '-n', 'opensphere-console', 'create', 'secret', 'generic', name,
    '--from-literal=url=https://kanidm.opensphere-console-auth.svc:8443',
    `--from-literal=token=${token}`,
    '--dry-run=client', '-o', 'yaml'
  ], { encoding: 'utf8', windowsHide: true });
  if (create.status !== 0) throw new Error(`Secret render failed: ${name}`);
  const apply = spawnSync('kubectl', ['apply', '-f', '-'], {
    encoding: 'utf8', input: create.stdout, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe']
  });
  if (apply.status !== 0) throw new Error(`Secret apply failed: ${name}`);
}

const token = await authenticate();
for (const group of ['opensphere-console-admins', 'opensphere-console-operators', 'opensphere-console-viewers']) {
  await ensureEntry(token, `/v1/group/${group}`, { attrs: { name: [group] } });
}
await ensureEntry(token, `/v1/person/${ADMIN}`, { attrs: { name: [ADMIN], displayname: [ADMIN_DISPLAY] } });
let response = await request('PATCH', `/v1/person/${ADMIN}`, { attrs: { mail: [ADMIN_EMAIL] } }, token);
for (let attempt = 0; response.status === 404 && attempt < 10; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  response = await request('PATCH', `/v1/person/${ADMIN}`, { attrs: { mail: [ADMIN_EMAIL] } }, token);
}
if (response.status >= 300) {
  throw new Error(`Admin mail update failed: HTTP ${response.status}`);
}
await addMember(token, 'opensphere-console-admins', ADMIN);

if (!SKIP_SERVICE_TOKENS) {
  const reader = await serviceToken(token, 'opensphere-console-reader', 'OpenSphere Console Reader', false);
  await addMember(token, 'idm_people_pii_read', 'opensphere-console-reader');
  const roleManager = await serviceToken(token, 'opensphere-console-rolemgr', 'OpenSphere Console Role Manager', true);
  for (const group of ['idm_people_admins', 'idm_group_admins']) {
    await addMember(token, group, 'opensphere-console-rolemgr');
  }
  applySecret('opensphere-identity-kanidm', reader);
  applySecret('opensphere-rolemgr-kanidm', roleManager);
}

response = await request('GET', `/v1/person/${ADMIN}/_credential/_status`, undefined, token);
if (response.status !== 200 || !Array.isArray(response.json?.creds)) {
  throw new Error(`Initial admin credential status failed: HTTP ${response.status}`);
}
if (response.json.creds.length > 0) {
  process.stdout.write(JSON.stringify({ onboardingRequired: false }));
  process.exit(0);
}

response = await request('GET', `/v1/person/${ADMIN}/_credential/_update_intent/3600`, undefined, token);
if (response.status !== 200 || !response.json?.token) {
  throw new Error(`Initial admin reset intent failed: HTTP ${response.status}`);
}

// The reset token is captured by the parent, never logged or persisted.
process.stdout.write(JSON.stringify({ onboardingRequired: true, resetToken: response.json.token }));
