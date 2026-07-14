import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

function platformDescriptor(platform = process.platform, arch = process.arch) {
  const os = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!os || !cpu) throw new Error(`Unsupported os CLI platform: ${platform}/${arch}`);
  return { os, arch: cpu };
}

function defaultInstallDirectory(platform = process.platform) {
  if (process.env.OPENSPHERE_OS_INSTALL_DIR) return resolve(process.env.OPENSPHERE_OS_INSTALL_DIR);
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error('LOCALAPPDATA is not available');
    return resolve(local, 'OpenSphere', 'bin');
  }
  return resolve(homedir(), '.local', 'bin');
}

function request(url, { insecureSkipTlsVerify = false, redirects = 3 } = {}) {
  return new Promise((resolveResponse, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, {
      headers: { accept: 'application/json, application/octet-stream' },
      rejectUnauthorized: !insecureSkipTlsVerify,
      timeout: 30_000
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects === 0) return reject(new Error(`Too many redirects downloading ${url}`));
        const next = new URL(response.headers.location, url);
        if (next.origin !== url.origin) return reject(new Error('Cross-origin CLI download redirect is not allowed'));
        request(next, { insecureSkipTlsVerify, redirects: redirects - 1 }).then(resolveResponse, reject);
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveResponse({
        status: response.statusCode,
        contentType: String(response.headers['content-type'] ?? '').split(';')[0],
        buffer: Buffer.concat(chunks)
      }));
    });
    request.on('timeout', () => request.destroy(new Error(`CLI download timed out: ${url}`)));
    request.on('error', reject);
  });
}

function validateManifest(document) {
  if (document?.name !== 'os' || document?.ownership !== 'console-native') {
    throw new Error('Console returned a non-canonical os CLI manifest');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(document.version ?? '')) {
    throw new Error('Console returned an invalid os CLI version');
  }
  if (!Array.isArray(document.links) || document.links.length === 0) {
    throw new Error('Console returned an empty os CLI artifact set');
  }
  return document;
}

function ensureUserPath(directory) {
  if (process.platform !== 'win32') return;
  const script = [
    "$d=$env:OPENSPHERE_OS_INSTALL_DIR",
    "$p=[Environment]::GetEnvironmentVariable('Path','User')",
    "$items=@($p -split ';' | Where-Object { $_ })",
    "if ($items -notcontains $d) { [Environment]::SetEnvironmentVariable('Path',(($items + $d) -join ';'),'User') }"
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, OPENSPHERE_OS_INSTALL_DIR: directory }
  });
  if (result.status !== 0) {
    throw new Error(`os CLI was installed but the user PATH update failed: ${result.stderr.trim()}`);
  }
}

async function replaceAtomically(target, bytes) {
  const directory = resolve(target, '..');
  const filename = basename(target);
  await mkdir(directory, { recursive: true });
  const nonce = `${process.pid}.${Date.now()}`;
  const temporary = join(directory, `.${filename}.${nonce}.tmp`);
  // A running Windows executable can keep its old file handle locked after a
  // successful rename. Never reuse or synchronously delete a fixed backup name.
  const backup = join(directory, `.${filename}.previous.${nonce}`);
  await writeFile(temporary, bytes, { mode: 0o755 });
  let hadTarget = false;
  try {
    await rename(target, backup);
    hadTarget = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  try {
    await rename(temporary, target);
    if (process.platform !== 'win32') await chmod(target, 0o755);
    // Replacement is already committed. Locked stale backups are harmless and
    // are retried on later installs instead of turning a successful upgrade into
    // a false failure.
    for (const entry of await readdir(directory)) {
      if (entry.startsWith(`.${filename}.previous.`)) {
        await rm(join(directory, entry), { force: true }).catch(() => {});
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    if (hadTarget) await rename(backup, target).catch(() => {});
    throw error;
  }
}

export async function installConsoleCli({
  consoleUrl = 'https://localhost:8090',
  installDirectory = defaultInstallDirectory(),
  insecureSkipTlsVerify = false,
  platform = process.platform,
  arch = process.arch,
  // A CLI artifact installation must not mutate a user's shell environment
  // unless the operator explicitly asks for it. The caller can opt in with
  // `--add-to-path`; the returned target is always usable directly.
  updatePath = false
} = {}) {
  const base = new URL(consoleUrl);
  if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Console URL must use HTTP or HTTPS');
  base.pathname = '/';
  base.search = '';
  base.hash = '';

  const manifestUrl = new URL('/api/cli/index.json', base);
  const manifestResponse = await request(manifestUrl, { insecureSkipTlsVerify });
  if (manifestResponse.status !== 200) throw new Error(`os CLI manifest returned HTTP ${manifestResponse.status}`);
  let manifest;
  try { manifest = validateManifest(JSON.parse(manifestResponse.buffer.toString('utf8'))); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('os CLI manifest is not valid JSON');
    throw error;
  }

  const targetPlatform = platformDescriptor(platform, arch);
  const link = manifest.links.find((entry) => entry.os === targetPlatform.os && entry.arch === targetPlatform.arch);
  if (!link) throw new Error(`Console has no os CLI artifact for ${targetPlatform.os}/${targetPlatform.arch}`);
  if (!Number.isSafeInteger(link.size) || link.size <= 0 || !/^[a-f0-9]{64}$/.test(link.sha256 ?? '')) {
    throw new Error('os CLI artifact metadata is invalid');
  }
  const artifactUrl = new URL(link.href, base);
  if (artifactUrl.origin !== base.origin || !artifactUrl.pathname.startsWith('/api/cli/')) {
    throw new Error('os CLI artifact URL is outside the Console-owned download boundary');
  }
  const artifact = await request(artifactUrl, { insecureSkipTlsVerify });
  if (artifact.status !== 200) throw new Error(`os CLI artifact returned HTTP ${artifact.status}`);
  if (artifact.buffer.byteLength !== link.size) throw new Error('os CLI artifact size differs from its manifest');
  const digest = createHash('sha256').update(artifact.buffer).digest('hex');
  if (digest !== link.sha256) throw new Error('os CLI artifact digest differs from its manifest');

  const directory = resolve(installDirectory);
  const filename = platform === 'win32' ? 'os.exe' : 'os';
  const target = join(directory, filename);
  await replaceAtomically(target, artifact.buffer);
  const pathUpdated = Boolean(updatePath && process.platform === 'win32');
  if (pathUpdated) ensureUserPath(directory);
  return { version: manifest.version, target, sha256: digest, pathUpdated };
}

export const testing = { defaultInstallDirectory, platformDescriptor, validateManifest };
