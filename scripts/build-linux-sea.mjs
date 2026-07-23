#!/usr/bin/env node
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function option(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`);
  return resolve(value);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 26) {
  throw new Error('Building the ESM single executable requires Node.js 26 or newer');
}

const targetNode = option('--node-executable');
const output = option('--output');
const root = resolve(import.meta.dirname, '..');
const bundle = resolve(root, '.release', 'bundle', 'index.mjs');
const buildDirectory = dirname(output);
const configPath = resolve(buildDirectory, `sea-${process.pid}.json`);

await mkdir(buildDirectory, { recursive: true });
await writeFile(configPath, `${JSON.stringify({
  main: bundle,
  mainFormat: 'module',
  executable: targetNode,
  output,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgvExtension: 'none',
  assets: {
    'New-Certificates.ps1': resolve(root, 'src', 'New-Certificates.ps1'),
    'Install-LocalDevelopmentCa.ps1': resolve(root, 'src', 'Install-LocalDevelopmentCa.ps1')
  }
}, null, 2)}\n`, 'utf8');

try {
  const result = spawnSync(process.execPath, ['--build-sea', configPath], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`node --build-sea failed with exit code ${result.status}`);
  await chmod(output, 0o755);
} finally {
  await rm(configPath, { force: true });
}

console.log(`[완료] Linux SEA: ${output}`);
