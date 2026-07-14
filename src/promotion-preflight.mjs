import { selectAuthEnvironment } from './auth-environment.mjs';
import { assertReleaseBackupTarget, inspectBackupTarget, parseBackupTargetSecretRef } from './backup-target.mjs';
import { preflight } from './preflight.mjs';
import {
  assertReleaseShellTlsReference,
  inspectExternalShellTlsSecret,
  parseShellTlsSecretRef
} from './shell-tls.mjs';

const PROMOTION_CHANNELS = new Set(['candidate', 'stable']);

// This is deliberately read-only. It validates the operator-provided
// prerequisites before a promotion-channel bootstrap writes any OpenSphere
// object into the cluster. Secret values are held only long enough to validate
// their contract and are never returned or logged.
export function preflightPromotion({
  channel,
  storageClass,
  consoleUrl,
  authEnvironment,
  backupTargetSecret,
  shellTlsSecret,
  readSecret,
  runPreflight = preflight,
  inspectBackup = inspectBackupTarget,
  inspectTls = inspectExternalShellTlsSecret
}) {
  if (!PROMOTION_CHANNELS.has(channel)) {
    throw new Error('promotion preflight is only available for candidate or stable');
  }
  if (!consoleUrl) throw new Error('promotion preflight requires --console <https-origin>');
  if (typeof readSecret !== 'function') throw new Error('promotion preflight requires a Secret reader');

  const backupReference = parseBackupTargetSecretRef(backupTargetSecret);
  const tlsReference = parseShellTlsSecretRef(shellTlsSecret);
  assertReleaseShellTlsReference(channel, tlsReference);

  const cluster = runPreflight({ storageClass, channel });
  const backup = assertReleaseBackupTarget(inspectBackup(readSecret(backupReference)), channel);
  const tls = inspectTls(readSecret(tlsReference), consoleUrl);

  return {
    channel,
    authEnvironment: selectAuthEnvironment(channel, authEnvironment),
    kubernetesVersion: cluster.serverVersion,
    nodeCount: cluster.nodeCount,
    storageClass: cluster.storageClass,
    backup: {
      endpoint: backup.endpoint,
      bucket: backup.bucket,
      region: backup.region
    },
    tls: {
      hostname: tls.hostname,
      subject: tls.subject,
      validTo: tls.validTo,
      certificateCount: tls.certificateCount,
      profile: tls.profile
    }
  };
}
