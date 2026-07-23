import { randomUUID } from 'node:crypto';
import { kubectl } from './process.mjs';
import { waitForJobCompletion } from './bootstrap.mjs';

const COMPONENTS = Object.freeze(['supabase', 'gitea']);
const NAMESPACE = 'opensphere-console-recovery';
const TARGET_SECRET = 'opensphere-platform-recovery-target';

export function assertRecoveryManifestKey(value) {
  const key = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{3,500}\/manifest\.json$/.test(key) || key.includes('..')) {
    throw new Error('--manifest-key must be a normalized S3 object key ending in /manifest.json');
  }
  return key;
}

export function recoveryDrillJob(lock, { component, manifestKey, id = randomUUID() } = {}) {
  if (!COMPONENTS.includes(component)) throw new Error(`--component must be one of ${COMPONENTS.join(', ')}`);
  const image = lock?.components?.recovery?.image;
  if (!/^ghcr\.io\/opensphere-platform\/opensphere-console-recovery@sha256:[a-f0-9]{64}$/.test(image ?? '')) {
    throw new Error('Installed release lock does not contain the governed recovery executor image');
  }
  const key = assertRecoveryManifestKey(manifestKey);
  const suffix = String(id).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12);
  if (!suffix) throw new Error('Recovery drill job id is invalid');
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `opensphere-recovery-drill-${component}-${suffix}`,
      namespace: NAMESPACE,
      labels: {
        'app.kubernetes.io/part-of': 'opensphere-console',
        'opensphere.io/recovery-component': component,
        'opensphere.io/recovery-mode': 'isolated-non-destructive-drill'
      }
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 604800,
      activeDeadlineSeconds: 1800,
      template: {
        metadata: { labels: { 'opensphere.io/recovery-component': component } },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: 'opensphere-platform-recovery',
          imagePullSecrets: [{ name: 'opensphere-ghcr-pull' }],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' }
          },
          containers: [{
            name: 'recovery',
            image,
            imagePullPolicy: 'IfNotPresent',
            env: [
              { name: 'RECOVERY_MODE', value: `drill-${component}` },
              { name: 'RECOVERY_MANIFEST_KEY', value: key },
              { name: 'RECOVERY_EVIDENCE_NAMESPACE', value: 'opensphere-console' },
              { name: 'RECOVERY_EVIDENCE_NAME', value: 'opensphere-platform-recovery-evidence' },
              { name: 'RECOVERY_S3_ENDPOINT', valueFrom: { secretKeyRef: { name: TARGET_SECRET, key: 'endpoint' } } },
              { name: 'RECOVERY_S3_BUCKET', valueFrom: { secretKeyRef: { name: TARGET_SECRET, key: 'bucket' } } },
              { name: 'RECOVERY_S3_REGION', valueFrom: { secretKeyRef: { name: TARGET_SECRET, key: 'region' } } },
              { name: 'RECOVERY_S3_ACCESS_KEY', valueFrom: { secretKeyRef: { name: TARGET_SECRET, key: 'access_key' } } },
              { name: 'RECOVERY_S3_SECRET_KEY', valueFrom: { secretKeyRef: { name: TARGET_SECRET, key: 'secret_key' } } },
              { name: 'RECOVERY_ENCRYPTION_KEY', valueFrom: { secretKeyRef: { name: TARGET_SECRET, key: 'encryption_key' } } },
              { name: 'AWS_CA_BUNDLE', value: '/run/recovery-target/ca.crt' }
            ],
            resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '2', memory: '2Gi' } },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] }
            },
            volumeMounts: [
              { name: 'target', mountPath: '/run/recovery-target', readOnly: true },
              { name: 'work', mountPath: '/work' }
            ]
          }],
          volumes: [
            { name: 'target', secret: { secretName: TARGET_SECRET, defaultMode: 288 } },
            { name: 'work', emptyDir: { sizeLimit: '20Gi' } }
          ]
        }
      }
    }
  };
}

export function startRecoveryDrill(lock, options, {
  apply = (manifest) => kubectl(['apply', '-f', '-'], { capture: true, input: JSON.stringify(manifest) }),
  wait = waitForJobCompletion
} = {}) {
  const job = recoveryDrillJob(lock, options);
  apply(job);
  wait(NAMESPACE, job.metadata.name, { timeoutMs: 1_860_000 });
  return { namespace: NAMESPACE, name: job.metadata.name, component: options.component };
}

export { COMPONENTS as RECOVERY_DRILL_COMPONENTS, NAMESPACE as RECOVERY_DRILL_NAMESPACE };
