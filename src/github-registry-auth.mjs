// registry-auth/v1 provider implementation. No credential is persisted or logged here.
import { setTimeout as delay } from 'node:timers/promises';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CLIENT = /^[A-Za-z0-9._-]{8,128}$/;
export const DEVICE_URL = 'https://github.com/login/device';
export const REQUESTED_SCOPES = 'read:packages offline_access';
export function authError(code) {
  return Object.assign(new Error('GitHub registry authentication: ' + code), { code, status: code === 'PermissionDenied' ? 403 : 503 });
}
function safeToken(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value)) throw authError('InvalidCredential');
  return value;
}
export function limitedScopes(value) {
  const scopes = [...new Set(String(value ?? '').split(/[ ,]+/).filter(Boolean))].sort();
  if (!scopes.includes('read:packages') || scopes.some(s => !['read:packages', 'offline_access'].includes(s))) throw authError('ReadOnlyPackagesScopeRequired');
  return scopes;
}
function seconds(value, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw authError('InvalidProviderResponse');
  return value;
}
export function createGitHubRegistryAuth({fetchImpl = globalThis.fetch, now = Date.now, sleep = (ms, signal) => delay(ms, undefined, {signal}), timeoutMs = 15000} = {}) {
  async function request(url, options = {}) {
    const headers = {accept: 'application/json', 'user-agent': 'OpenSphere-Registry-Auth', ...options.headers};
    let response;
    try { response = await fetchImpl(url, {...options, headers, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)}); }
    catch { throw authError('ProviderUnavailable'); }
    // Do not include provider response/error text: it can echo submitted credentials.
    if (!response.ok) throw authError([401,403].includes(response.status) ? 'PermissionDenied' : 'ProviderUnavailable');
    const reader = response.body?.getReader();
    if (!reader) throw authError('InvalidProviderResponse');
    const chunks = []; let size = 0;
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.length; if (size > 65536) { await reader.cancel(); throw authError('InvalidProviderResponse'); }
      chunks.push(Buffer.from(value));
    }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw authError('InvalidProviderResponse'); }
    return {body, headers: response.headers};
  }
  function client(value) { if (!CLIENT.test(String(value || '')) || /^(?:gh[pousr]_|github_pat_)/u.test(String(value))) throw authError('OpenSphereOAuthClientIdRequired'); return value; }
  async function post(path, fields, signal) {
    return (await request('https://github.com/login/' + path, {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams(fields).toString(), signal})).body;
  }
  async function inspect(token, {username, userId, scopes} = {}) {
    safeToken(token);
    const result = await request('https://api.github.com/user', {headers:{authorization:'Bearer ' + token}});
    const login = result.body?.login;
    const id = result.body?.id;
    if (!LOGIN.test(login || '') || !Number.isSafeInteger(id) || id < 1) throw authError('InvalidProviderIdentity');
    if ((username && login.toLowerCase() !== username.toLowerCase()) || (userId && String(id) !== String(userId))) throw authError('IdentityMismatch');
    const headerScopes = result.headers.get('x-oauth-scopes');
    // A supplied OAuth response does not override the actual granted scopes.
    if (headerScopes === null && scopes === undefined) throw authError('ReadOnlyPackagesScopeUnverifiable');
    const actualScopes = limitedScopes(headerScopes ?? scopes);
    if (scopes !== undefined) limitedScopes(scopes);
    const expiry = result.headers.get('github-authentication-token-expiration');
    const expiresAt = expiry && Number.isFinite(Date.parse(expiry)) ? new Date(expiry).toISOString() : null;
    if (expiresAt && Date.parse(expiresAt) <= now()) throw authError('CredentialExpired');
    return {username:login, userId:String(id), scopes:actualScopes, expiresAt};
  }
  async function credential(body, clientId, expected = {}) {
    if (body?.error) throw authError(['bad_refresh_token','access_denied','expired_token'].includes(body.error) ? 'ReauthorizationRequired' : 'ProviderRejected');
    if (String(body?.token_type).toLowerCase() !== 'bearer') throw authError('InvalidProviderResponse');
    const token = safeToken(body.access_token);
    const identity = await inspect(token, {...expected, scopes:body.scope});
    const expiresAt = body.expires_in ? new Date(now() + seconds(body.expires_in, 86400 * 366) * 1000).toISOString() : null;
    const refreshToken = body.refresh_token ? safeToken(body.refresh_token) : null;
    if (refreshToken && (!expiresAt || !body.refresh_token_expires_in)) throw authError('InvalidProviderResponse');
    return {username:identity.username, token, lifecycle:{schemaVersion:'1.0', mode:'github-device', clientId:client(clientId), userId:identity.userId, scopes:identity.scopes,
      expiresAt, refreshToken, refreshExpiresAt:refreshToken ? new Date(now() + seconds(body.refresh_token_expires_in, 86400 * 366) * 1000).toISOString() : null,
      verifiedAt:new Date(now()).toISOString(), refreshPolicy:refreshToken ? 'automatic' : 'reauthorize'}};
  }
  return Object.freeze({
    inspect,
    async pat({username, token}) {
      const identity = await inspect(token, {username});
      return {username:identity.username, token, lifecycle:{schemaVersion:'1.0', mode:'pat', userId:identity.userId, scopes:identity.scopes, expiresAt:identity.expiresAt,
        refreshToken:null, refreshExpiresAt:null, verifiedAt:new Date(now()).toISOString(), refreshPolicy:'manual'}};
    },
    async start(clientId, signal) {
      const body = await post('device/code', {client_id:client(clientId), scope:REQUESTED_SCOPES}, signal);
      if (body.error) throw authError(body.error === 'device_flow_disabled' ? 'DeviceFlowDisabled' : 'ProviderRejected');
      if (body.verification_uri !== DEVICE_URL || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(body.user_code || '') || !/^[A-Za-z0-9_-]{16,256}$/.test(body.device_code || '')) throw authError('InvalidProviderResponse');
      return {clientId, deviceCode:body.device_code, userCode:body.user_code, verificationUri:DEVICE_URL,
        expiresAt:new Date(now() + seconds(body.expires_in, 1800) * 1000).toISOString(), interval:seconds(body.interval || 5,60), nextPollAt:now() + (body.interval || 5)*1000};
    },
    async poll(flow, signal) {
      if (Date.parse(flow.expiresAt) <= now()) throw authError('ReauthorizationRequired');
      if (now() < flow.nextPollAt) return {pending:true, flow};
      const body = await post('oauth/access_token', {client_id:client(flow.clientId), device_code:flow.deviceCode, grant_type:'urn:ietf:params:oauth:grant-type:device_code'}, signal);
      if (['authorization_pending','slow_down'].includes(body.error)) {
        const interval = body.error === 'slow_down' ? Math.min(900, Math.max(flow.interval+5, body.interval === undefined ? 0 : seconds(body.interval,900))) : flow.interval;
        return {pending:true, flow:{...flow, interval, nextPollAt:now()+interval*1000}};
      }
      return {pending:false, credentials:await credential(body,flow.clientId)};
    },
    async login(clientId, {onCode=()=>{}, signal} = {}) {
      let flow = await this.start(clientId, signal); await onCode({userCode:flow.userCode, verificationUri:flow.verificationUri, expiresAt:flow.expiresAt});
      while (true) {
        await sleep(Math.max(1,Math.min(flow.nextPollAt,Date.parse(flow.expiresAt))-now()), signal);
        const result = await this.poll(flow, signal); if (!result.pending) return result.credentials; flow=result.flow;
      }
    },
    async refresh(current) {
      const life=current.lifecycle;
      if (life?.mode !== 'github-device' || !life.refreshToken || Date.parse(life.refreshExpiresAt) <= now()) throw authError('ReauthorizationRequired');
      const body=await post('oauth/access_token',{client_id:client(life.clientId),grant_type:'refresh_token',refresh_token:life.refreshToken});
      const next=await credential(body,life.clientId,{userId:life.userId});
      if (!next.lifecycle.refreshToken) throw authError('ReauthorizationRequired');
      return next;
    },
    async verifyImages(credentials, images) {
      if (!Array.isArray(images) || !images.length || images.length > 128) throw authError('RequiredRegistryImagesMissing');
      for (const image of [...new Set(images)]) {
        const match=String(image).match(/^ghcr\.io\/(opensphere-platform\/[a-z0-9][a-z0-9._-]*)@(sha256:[a-f0-9]{64})$/);
        if (!match) throw authError('InvalidRegistryImage');
        const access=await request('https://ghcr.io/token?service=ghcr.io&scope='+encodeURIComponent('repository:'+match[1]+':pull'), {headers:{authorization:'Basic '+Buffer.from(credentials.username+':'+safeToken(credentials.token)).toString('base64')}});
        const token=safeToken(access.body.token || access.body.access_token);
        // A successful /token response can carry no usable pull permission. Check the exact signed manifest too.
        let response;
        try { response=await fetchImpl('https://ghcr.io/v2/'+match[1]+'/manifests/'+match[2],{method:'HEAD', headers:{authorization:'Bearer '+token, accept:'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json'}, redirect:'error',signal:AbortSignal.timeout(timeoutMs)}); }
        catch { throw authError('ProviderUnavailable'); }
        if (!response.ok) throw authError([401,403].includes(response.status) ? 'RegistryPullDenied' : 'RegistryImageUnavailable');
        if (response.headers.get('docker-content-digest') !== match[2]) throw authError('RegistryDigestMismatch');
      }
      return {verifiedAt:new Date(now()).toISOString(), imageCount:new Set(images).size};
    }
  });
}
