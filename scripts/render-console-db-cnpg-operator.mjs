#!/usr/bin/env node
// Regenerate src/console-db-cnpg-operator-artifact.json from the upstream CloudNativePG Helm chart.
//
//   node scripts/render-console-db-cnpg-operator.mjs <cloudnative-pg-<version>.tgz>
//
// R2-C2 (Console DB to CloudNativePG, plan 2026-10-24 §4.1 "CNPG", lab 2026-10-27). The artifact keeps the exact
// `helm template` bytes; Setup never edits them on disk. src/console-db-cnpg.mjs turns them into the installed shape
// at run time (watch namespace, replicas, image, least-privilege RBAC, admission fence), and that transformation is
// what the tests and the lab review. The chart archive itself is not committed: its sha256 must equal the one the
// chart index publishes, which is recorded here and checked before rendering.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const CHART = Object.freeze({
  repository: 'https://cloudnative-pg.github.io/charts',
  name: 'cloudnative-pg',
  version: '0.29.1',
  appVersion: '1.30.1',
  // index.yaml digest of cloudnative-pg-0.29.1 (created 2026-09-23T16:56:41Z), read 2026-10-27.
  sha256: 'b53d3991fe84bcf38767e7702cae78666265427a127a26fff168ab4207d2b1df',
  url: 'https://github.com/cloudnative-pg/charts/releases/download/cloudnative-pg-v0.29.1/cloudnative-pg-0.29.1.tgz',
  // Namespaced install: the chart then renders its common rules as a Role (Setup binds them in the watched namespace).
  args: ['template', 'cnpg', '--namespace', 'opensphere-cnpg-system', '--set', 'config.clusterWide=false', '--include-crds'],
});

const archive = process.argv[2];
if (!archive) {
  console.error('usage: render-console-db-cnpg-operator.mjs <cloudnative-pg-0.29.1.tgz>');
  process.exit(2);
}
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (digest !== CHART.sha256) throw new Error(`chart archive sha256 ${digest} differs from the published ${CHART.sha256}`);
const [command, ...rest] = ['helm', ...CHART.args.slice(0, 2), archive, ...CHART.args.slice(2)];
const yaml = execFileSync(command, rest, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n');
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'console-db-cnpg-operator-artifact.json');
const { url, args, ...source } = CHART;
writeFileSync(out, `${JSON.stringify({ source: { ...source, url, render: `helm ${args.slice(0, 2).join(' ')} <chart> ${args.slice(2).join(' ')}` }, yaml }, null, 1)}\n`);
console.log(`wrote ${out}: ${Buffer.byteLength(yaml)} bytes, sha256 ${createHash('sha256').update(yaml).digest('hex')}`);
