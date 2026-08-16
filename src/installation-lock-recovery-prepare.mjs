import { execFileSync } from 'node:child_process';
import {
  createPrivateKey, createPublicKey, sign, verify,
} from 'node:crypto';
import {
  lstat, mkdir, open, readFile, realpath,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildInstallationLockRecoveryApprovalDocument,
  buildInstallationLockRecoveryPlan,
  canonicalJson,
  gitBlobSha,
  INSTALLATION_LOCK_RECOVERY_TOOLING_PATHS,
  sha256,
  validateInstallationLockRecoveryToolingAuthority,
  validateInstallationLockRecoveryPlan,
} from './installation-lock-recovery.mjs';
import { assertInstallationLockRecoveryLocalState } from './installation-lock-recovery-local.mjs';
import {
  assertInstallationLockRecoveryPrivateDirectory,
  ensureInstallationLockRecoveryPrivateDirectory,
} from './installation-lock-recovery-windows-custody.mjs';

export const INSTALLATION_LOCK_RECOVERY_PREPARE_CONFIRMATION =
  'PREPARE-SIGNED-INSTALLATION-LOCK-RECOVERY';
export const INSTALLATION_LOCK_RECOVERY_PREPARATION_RECEIPT_CONTRACT =
  'opensphere.installation-lock.recovery-preparation-receipt/v1';
const KEY_ID = 'opensphere-edge-local-v1';
const CANONICAL_SETUP_REMOTE = 'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git';

function parseJson(bytes, label) {
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error(`${label} is invalid JSON`); }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`${label} keys are not canonical`);
  }
  return value;
}

function outside(root, candidate, label) {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`${label} must be outside the source repository`);
  }
}

async function regularInput(path, label) {
  const absolute = resolve(path);
  await assertNoSymlinkPath(absolute, label);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (Number.isInteger(stat.nlink) && stat.nlink !== 1) {
    throw new Error(`${label} must not have hard-link ambiguity`);
  }
  const bytes = await readFile(absolute);
  if (stat.size !== bytes.length) throw new Error(`${label} changed while read`);
  const rawSha256 = sha256(bytes);
  return {
    absolute, stat, bytes, rawSha256,
    async assertUnchanged() {
      const current = await lstat(absolute);
      if (!current.isFile() || current.isSymbolicLink()
          || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs
          || current.ctimeMs !== stat.ctimeMs || current.dev !== stat.dev || current.ino !== stat.ino
          || sha256(await readFile(absolute)) !== rawSha256) {
        throw new Error(`${label} changed during recovery preparation`);
      }
    },
  };
}

async function assertNoSymlinkPath(path, label) {
  const chain = [];
  let cursor = resolve(path);
  while (true) {
    chain.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const candidate of chain.reverse()) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symlink or junction`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync().catch((error) => {
      if (!['EINVAL', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
    });
  } finally { await handle.close(); }
}

async function writeOrVerify(path, bytes, label) {
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await syncDirectory(dirname(path));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await regularInput(path, label);
    if (!existing.bytes.equals(bytes)) throw new Error(`${label} exists with different bytes; overwrite is forbidden`);
  }
  const written = await regularInput(path, label);
  if (!written.bytes.equals(bytes)) throw new Error(`${label} post-write verification failed`);
  return written;
}

async function defaultKeyBoundary(keyPath, { expectedHelperSha256 } = {}) {
  const helperPath = fileURLToPath(new URL(
    '../scripts/Assert-InstallationLockRecoverySigningKey.ps1', import.meta.url
  ));
  const helper = await regularInput(helperPath, 'recovery key boundary helper');
  if (expectedHelperSha256 && helper.rawSha256 !== expectedHelperSha256) {
    throw new Error('recovery key boundary helper bytes differ from reviewed authority');
  }
  const helperText = helper.bytes.toString('utf8');
  if (!Buffer.from(helperText, 'utf8').equals(helper.bytes)) {
    throw new Error('recovery key boundary helper is not canonical UTF-8 source');
  }
  const encodedCommand = Buffer.from(helperText, 'utf16le').toString('base64');
  const output = execFileSync('pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand,
  ], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENSPHERE_RECOVERY_KEY_PATH: resolve(keyPath) },
  });
  const result = parseJson(output, 'recovery approval key boundary');
  exactKeys(result, ['contract', 'keyId', 'resolvedPath', 'currentUserSid'], 'key boundary result');
  if (result.contract !== 'opensphere.installation-lock.recovery-key-boundary/v1'
      || result.keyId !== KEY_ID || resolve(result.resolvedPath) !== resolve(keyPath)) {
    throw new Error('recovery approval key boundary returned a different key');
  }
  return { result, helperPath };
}

function runGit(repositoryRoot, args, { encoding = 'utf8' } = {}) {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: encoding === 'buffer' ? null : encoding,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function defaultToolingBoundary({
  repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url))),
  runGitFn = runGit,
} = {}) {
  const branch = runGitFn(repositoryRoot, ['symbolic-ref', '--short', 'HEAD']).trim();
  const remote = runGitFn(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
  const initialStatus = runGitFn(
    repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all']
  ).trim();
  if (initialStatus || branch !== 'main' || remote !== CANONICAL_SETUP_REMOTE) {
    throw new Error('recovery preparation tooling is not clean canonical main before fetch');
  }
  runGitFn(repositoryRoot, ['fetch', '--prune', 'origin', 'main']);
  const status = runGitFn(repositoryRoot,
    ['status', '--porcelain=v1', '--untracked-files=all']).trim();
  const head = runGitFn(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const originMain = runGitFn(repositoryRoot, ['rev-parse', 'refs/remotes/origin/main']).trim();
  if (status || branch !== 'main' || head !== originMain || remote !== CANONICAL_SETUP_REMOTE
      || !/^[a-f0-9]{40}$/u.test(head)) {
    throw new Error('recovery preparation tooling is not clean canonical main at fetched origin/main');
  }
  const files = [];
  for (const path of INSTALLATION_LOCK_RECOVERY_TOOLING_PATHS) {
    runGitFn(repositoryRoot, ['ls-files', '--error-unmatch', '--', path]);
    const committed = runGitFn(repositoryRoot, ['show', `HEAD:${path}`], { encoding: 'buffer' });
    const input = await regularInput(join(repositoryRoot, path), `recovery tooling ${path}`);
    if (!input.bytes.equals(committed)) throw new Error(`recovery tooling ${path} differs from canonical HEAD`);
    files.push({ path, sha256: input.rawSha256, gitBlob: gitBlobSha(input.bytes) });
  }
  return {
    evidence: {
      contract: 'opensphere.installation-lock.recovery-tooling-authority/v1',
      repository: CANONICAL_SETUP_REMOTE,
      sourceRevision: head,
      branch: 'main',
      files,
    },
    helperPath: join(repositoryRoot, 'scripts/Assert-InstallationLockRecoverySigningKey.ps1'),
  };
}

export async function observeInstallationLockRecoveryToolingAuthority(options) {
  return defaultToolingBoundary(options);
}

async function validateToolingBoundary(result) {
  exactKeys(result, ['evidence', 'helperPath'], 'recovery tooling boundary');
  const evidence = exactKeys(result.evidence, [
    'contract', 'repository', 'sourceRevision', 'branch', 'files',
  ], 'recovery tooling evidence');
  validateInstallationLockRecoveryToolingAuthority(evidence);
  const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  for (let index = 0; index < INSTALLATION_LOCK_RECOVERY_TOOLING_PATHS.length; index += 1) {
    const file = exactKeys(evidence.files[index], ['path', 'sha256', 'gitBlob'], 'recovery tooling file');
    if (file.path !== INSTALLATION_LOCK_RECOVERY_TOOLING_PATHS[index]
        || !/^sha256:[a-f0-9]{64}$/u.test(file.sha256 ?? '')
        || !/^[a-f0-9]{40}$/u.test(file.gitBlob ?? '')) {
      throw new Error('recovery tooling file authority is invalid');
    }
    const input = await regularInput(join(repositoryRoot, file.path), `recovery tooling ${file.path}`);
    if (input.rawSha256 !== file.sha256 || gitBlobSha(input.bytes) !== file.gitBlob) {
      throw new Error(`recovery tooling ${file.path} differs from reviewed authority`);
    }
  }
  if (resolve(result.helperPath)
      !== join(repositoryRoot, 'scripts/Assert-InstallationLockRecoverySigningKey.ps1')) {
    throw new Error('recovery tooling boundary selected a different key helper');
  }
  return result;
}

export async function assertInstallationLockRecoveryToolingAuthority(
  expected, toolingBoundaryFn = observeInstallationLockRecoveryToolingAuthority
) {
  const actual = await validateToolingBoundary(await toolingBoundaryFn());
  if (canonicalJson(expected) !== canonicalJson(actual.evidence)) {
    throw new Error('signed recovery tooling authority differs from canonical tooling');
  }
  return actual;
}

function approvalFromEnvelope(documentText, envelope) {
  exactKeys(envelope, [
    'contract', 'algorithm', 'keyId', 'publicKeySpkiBase64', 'publicKeySpkiSha256',
    'documentSha256', 'signatureBase64',
  ], 'recovery approval signature envelope');
  if (envelope.contract !== 'opensphere.installation-lock.recovery-signature/v1'
      || envelope.algorithm !== 'ES256-P1363' || envelope.keyId !== KEY_ID
      || envelope.documentSha256 !== sha256(documentText)
      || envelope.publicKeySpkiSha256
        !== sha256(Buffer.from(envelope.publicKeySpkiBase64, 'base64'))
      || Buffer.from(envelope.signatureBase64, 'base64').length !== 64) {
    throw new Error('recovery approval signature envelope is invalid');
  }
  const document = parseJson(documentText, 'recovery approval document');
  return {
    contract: document.contract,
    approvalId: document.approvalId,
    keyId: envelope.keyId,
    publicKeySpkiBase64: envelope.publicKeySpkiBase64,
    publicKeySpkiSha256: envelope.publicKeySpkiSha256,
    documentText,
    documentSha256: envelope.documentSha256,
    signatureBase64: envelope.signatureBase64,
  };
}

export async function prepareInstallationLockRecovery({
  evidenceBundlePath,
  approvalKeyPath,
  outputDirectory,
  approvalId,
  reasonFilePath,
  approvedAt,
  expiresAt,
  confirmation,
  keyBoundaryFn = defaultKeyBoundary,
  buildApprovalDocumentFn = buildInstallationLockRecoveryApprovalDocument,
  buildPlanFn = buildInstallationLockRecoveryPlan,
  validatePlanFn = validateInstallationLockRecoveryPlan,
  beforeFirstOutputFn = async () => {},
  toolingBoundaryFn = observeInstallationLockRecoveryToolingAuthority,
  nowFn = () => new Date().toISOString(),
  ensureDirectoryCustodyFn = ensureInstallationLockRecoveryPrivateDirectory,
  assertDirectoryCustodyFn = assertInstallationLockRecoveryPrivateDirectory,
} = {}) {
  if (confirmation !== INSTALLATION_LOCK_RECOVERY_PREPARE_CONFIRMATION) {
    throw new Error(`recovery preparation requires --confirm ${INSTALLATION_LOCK_RECOVERY_PREPARE_CONFIRMATION}`);
  }
  if (!evidenceBundlePath || !approvalKeyPath || !outputDirectory || !reasonFilePath) {
    throw new Error('recovery preparation requires evidence, key, output, and reason file paths');
  }
  const evidenceInput = await regularInput(evidenceBundlePath, 'reviewed recovery evidence bundle');
  const reasonInput = await regularInput(reasonFilePath, 'recovery approval reason file');
  const bundle = parseJson(evidenceInput.bytes, 'reviewed recovery evidence bundle');
  const workspaceRoot = resolve(bundle?.localState?.workspaceRoot ?? '');
  if (!isAbsolute(bundle?.localState?.workspaceRoot ?? '')) {
    throw new Error('reviewed evidence bundle lacks a signed absolute workspaceRoot');
  }
  const output = resolve(outputDirectory);
  outside(workspaceRoot, output, 'recovery preparation output directory');
  await assertNoSymlinkPath(output, 'recovery preparation output directory');
  outside(workspaceRoot, resolve(approvalKeyPath), 'recovery approval private key');
  await assertDirectoryCustodyFn(dirname(bundle.localState.quarantine.filePath));
  await assertInstallationLockRecoveryLocalState(bundle.localState);
  const reason = reasonInput.bytes.toString('utf8').trim();
  const tooling = await assertInstallationLockRecoveryToolingAuthority(
    bundle.recoveryToolingAuthority, toolingBoundaryFn
  );
  const helperAuthority = tooling.evidence.files.find((file) =>
    file.path === 'scripts/Assert-InstallationLockRecoverySigningKey.ps1');
  const boundary = await keyBoundaryFn(resolve(approvalKeyPath), {
    expectedHelperSha256: helperAuthority?.sha256,
  });
  if (boundary?.helperPath && resolve(boundary.helperPath) !== resolve(tooling.helperPath)) {
    throw new Error('recovery key boundary executed an unreviewed helper');
  }
  const keyInput = await regularInput(approvalKeyPath, 'recovery approval private key');

  let privateKey;
  let publicKey;
  const keyBytes = Buffer.from(keyInput.bytes);
  try {
    const pem = keyBytes.toString('utf8');
    if ((pem.match(/-----BEGIN PRIVATE KEY-----/gu) ?? []).length !== 1
        || (pem.match(/-----END PRIVATE KEY-----/gu) ?? []).length !== 1
        || /BEGIN (?:EC|ENCRYPTED) PRIVATE KEY/u.test(pem)) {
      throw new Error('recovery approval key must be a single unencrypted PKCS8 private key');
    }
    privateKey = createPrivateKey(pem);
    publicKey = createPublicKey(privateKey);
  } finally { keyBytes.fill(0); }
  if (privateKey.asymmetricKeyType !== 'ec'
      || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('recovery approval key is not P-256');
  }
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeySpkiBase64 = spki.toString('base64');
  const publicKeySpkiSha256 = sha256(spki);
  if (bundle.trustObservation?.keyId !== KEY_ID
      || bundle.trustObservation?.publicKeySpkiBase64 !== publicKeySpkiBase64
      || bundle.trustObservation?.publicKeySpkiSha256 !== publicKeySpkiSha256) {
    throw new Error('recovery approval key differs from the signed edge trust observation');
  }

  const approvalDocument = buildApprovalDocumentFn(bundle, {
    approvalId, reason, approvedAt, expiresAt,
  });
  const documentText = JSON.stringify(approvalDocument);
  const documentBytes = Buffer.from(documentText, 'utf8');
  const signatureCandidatePath = join(output, 'installation-lock-recovery-approval-signature.json');
  let envelope;
  try {
    envelope = parseJson(
      (await regularInput(signatureCandidatePath, 'recovery approval signature')).bytes,
      'recovery approval signature'
    );
    approvalFromEnvelope(documentText, envelope);
    if (envelope.publicKeySpkiBase64 !== publicKeySpkiBase64
        || envelope.publicKeySpkiSha256 !== publicKeySpkiSha256) {
      throw new Error('existing recovery approval signature uses a different key');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const generated = sign('sha256', documentBytes, {
      key: privateKey, dsaEncoding: 'ieee-p1363',
    });
    if (generated.length !== 64) throw new Error('recovery approval signature is not ES256-P1363');
    envelope = {
      contract: 'opensphere.installation-lock.recovery-signature/v1',
      algorithm: 'ES256-P1363',
      keyId: KEY_ID,
      publicKeySpkiBase64,
      publicKeySpkiSha256,
      documentSha256: sha256(documentBytes),
      signatureBase64: generated.toString('base64'),
    };
  }
  const signatureBytes = Buffer.from(envelope.signatureBase64, 'base64');
  if (!verify('sha256', documentBytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signatureBytes)) {
    throw new Error('recovery approval signature self-verification failed');
  }
  const approval = approvalFromEnvelope(documentText, envelope);
  const plan = validatePlanFn(buildPlanFn({ ...bundle, approval }));

  await assertInstallationLockRecoveryToolingAuthority(
    bundle.recoveryToolingAuthority, toolingBoundaryFn
  );
  await beforeFirstOutputFn();
  await Promise.all([
    evidenceInput.assertUnchanged(), reasonInput.assertUnchanged(), keyInput.assertUnchanged(),
    assertDirectoryCustodyFn(dirname(bundle.localState.quarantine.filePath)),
    assertInstallationLockRecoveryLocalState(bundle.localState),
  ]);
  const createdOutputDirectory = await mkdir(output, { recursive: true, mode: 0o700 });
  if (createdOutputDirectory) await ensureDirectoryCustodyFn(output);
  else await assertDirectoryCustodyFn(output);
  const [realOutput, realWorkspace] = await Promise.all([realpath(output), realpath(workspaceRoot)]);
  if (realOutput !== output || realWorkspace !== workspaceRoot) {
    throw new Error('recovery preparation paths resolve through a symlink or junction');
  }
  outside(realWorkspace, realOutput, 'recovery preparation output directory');
  let outputIdentity = await lstat(realOutput);
  const assertOutputIdentity = async ({ refreshAfterOwnedWrite = false } = {}) => {
    await assertDirectoryCustodyFn(realOutput);
    await assertNoSymlinkPath(realOutput, 'recovery preparation output directory');
    const current = await lstat(realOutput);
    if (!current.isDirectory() || current.isSymbolicLink()
        || current.dev !== outputIdentity.dev || current.ino !== outputIdentity.ino
        || (!refreshAfterOwnedWrite && current.ctimeMs !== outputIdentity.ctimeMs)
        || await realpath(realOutput) !== realOutput) {
      throw new Error('recovery preparation output directory identity changed during execution');
    }
    if (refreshAfterOwnedWrite) outputIdentity = current;
  };

  const approvalDocumentPath = join(realOutput, 'installation-lock-recovery-approval-document.json');
  const signaturePath = join(realOutput, 'installation-lock-recovery-approval-signature.json');
  const planPath = join(realOutput, 'installation-lock-recovery-plan.json');
  const receiptPath = join(realOutput, 'installation-lock-recovery-preparation-receipt.json');
  const envelopeBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  const writeBoundOutput = async (path, bytes, label) => {
    await assertOutputIdentity();
    const result = await writeOrVerify(path, bytes, label);
    await assertOutputIdentity({ refreshAfterOwnedWrite: true });
    return result;
  };
  await writeBoundOutput(approvalDocumentPath, documentBytes, 'recovery approval document');
  await writeBoundOutput(signaturePath, envelopeBytes, 'recovery approval signature');
  await writeBoundOutput(planPath, planBytes, 'signed recovery plan');
  const persistedPlan = validatePlanFn(parseJson(await readFile(planPath), 'persisted signed recovery plan'));
  if (canonicalJson(persistedPlan) !== canonicalJson(plan)) {
    throw new Error('persisted signed recovery plan differs after validation');
  }

  const modulePath = fileURLToPath(import.meta.url);
  const helperPath = boundary?.helperPath ?? tooling.helperPath;
  const [moduleInput, helperInput] = await Promise.all([
    regularInput(modulePath, 'recovery preparation module'),
    regularInput(helperPath, 'recovery key boundary helper'),
  ]);
  const completedAt = nowFn();
  if (typeof completedAt !== 'string' || !Number.isFinite(Date.parse(completedAt))) {
    throw new Error('recovery preparation completion timestamp is invalid');
  }
  const receipt = {
    contract: INSTALLATION_LOCK_RECOVERY_PREPARATION_RECEIPT_CONTRACT,
    approvalId,
    evidenceBundle: {
      path: evidenceInput.absolute, size: evidenceInput.bytes.length,
      rawSha256: evidenceInput.rawSha256, canonicalSha256: sha256(canonicalJson(bundle)),
    },
    approval: {
      documentPath: approvalDocumentPath, documentSha256: envelope.documentSha256,
      signaturePath, signatureFileSha256: sha256(envelopeBytes),
      signatureSha256: sha256(signatureBytes), keyId: KEY_ID, publicKeySpkiSha256,
    },
    plan: { path: planPath, fileSha256: sha256(planBytes), planDigest: plan.planDigest },
    localStateDigest: sha256(canonicalJson(bundle.localState)),
    tooling: {
      authority: tooling.evidence,
      prepareModulePath: modulePath, prepareModuleSha256: moduleInput.rawSha256,
      keyBoundaryHelperPath: helperPath, keyBoundaryHelperSha256: helperInput.rawSha256,
    },
    completedAt,
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await Promise.all([
    evidenceInput.assertUnchanged(), reasonInput.assertUnchanged(), keyInput.assertUnchanged(),
    moduleInput.assertUnchanged(), helperInput.assertUnchanged(),
    assertDirectoryCustodyFn(dirname(bundle.localState.quarantine.filePath)),
    assertInstallationLockRecoveryLocalState(bundle.localState),
  ]);
  await assertInstallationLockRecoveryToolingAuthority(
    bundle.recoveryToolingAuthority, toolingBoundaryFn
  );
  await writeBoundOutput(receiptPath, receiptBytes, 'recovery preparation receipt');
  return {
    approvalId, planDigest: plan.planDigest, planPath, receiptPath,
    evidenceBundleSha256: evidenceInput.rawSha256,
    approvalDocumentSha256: envelope.documentSha256,
    approvalSignatureSha256: sha256(signatureBytes),
    preparationReceiptSha256: sha256(receiptBytes),
  };
}
