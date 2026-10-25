'use strict';

const DNS = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const USER_NAMESPACE_POLICY = 'required-hostUsers-false';
function shellPodName(sessionId) { return `os-shell-${String(sessionId).replace(/-/g, '').slice(0, 20)}`; }
function env(name, value) { return { name, value: String(value) }; }

function buildRuntimePod(session, config) {
  const name = shellPodName(session.session_id);
  if (!DNS.test(name) || !String(config.runtimeImage).includes('@sha256:')) throw new Error('closed runtime template inputs are invalid');
  const binding = [
    env('OPENSPHERE_SHELL_SESSION_ID', session.session_id), env('OPENSPHERE_SHELL_ACTOR_ID', session.actor_id),
    env('OPENSPHERE_SHELL_ORIGIN', session.origin), env('OPENSPHERE_SHELL_SESSION_CLASS', 'operator-interactive'),
    env('OPENSPHERE_SHELL_RUNTIME_ADAPTER_ID', 'cbss.kubernetes-pod'), env('OPENSPHERE_SHELL_NETWORK_PROFILE', 'console-only'),
    { name: 'OPENSPHERE_SHELL_RUNTIME_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
    env('OPENSPHERE_SHELL_PERMISSION_REVISION', session.permission_revision), env('OPENSPHERE_SHELL_AAL', session.aal),
    env('OPENSPHERE_SHELL_RELEASE_EVIDENCE_REF', session.release_evidence_ref),
    env('OPENSPHERE_SHELL_GENERATION', session.generation), env('OPENSPHERE_SHELL_FENCING_EPOCH', session.fencing_epoch),
    env('OPENSPHERE_SHELL_MAX_PROCESSES', config.runtimeMaxProcesses),
  ];
  const securityContext = { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: true, runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: { type: 'RuntimeDefault' } };
  return {
    apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: config.namespace, labels: {
      app: 'opensphere-os-shell-runtime', 'opensphere.io/session-id': session.session_id,
      'opensphere.io/generation': String(session.generation), 'opensphere.io/fencing-epoch': String(session.fencing_epoch),
    } }, spec: {
      serviceAccountName: config.runtimeServiceAccount, automountServiceAccountToken: false, restartPolicy: 'Never',
      hostUsers: false,
      enableServiceLinks: false, terminationGracePeriodSeconds: 5, dnsPolicy: 'ClusterFirst', schedulerName: 'default-scheduler',
      imagePullSecrets: [{ name: 'opensphere-ghcr-pull' }],
      securityContext: { runAsNonRoot: true, fsGroup: 65532, fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } },
      volumes: [
        { name: 'internal', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
        { name: 'agent-channel', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
        { name: 'workspace', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
        { name: 'bootstrap', projected: { defaultMode: 0o440, sources: [{ serviceAccountToken: {
          audience: 'opensphere-shell-runtime-bootstrap', expirationSeconds: 600,
          path: 'opensphere-shell-runtime-bootstrap',
        } }] } },
        { name: 'control-ca', configMap: { name: 'opensphere-shell-control-ca', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
      ],
      containers: [
        { name: 'pty', image: config.runtimeImage, imagePullPolicy: 'IfNotPresent', args: ['pty'],
          env: [...binding, env('OPENSPHERE_SHELL_CONSOLE_API_URL', config.consoleAPIURL), env('SSL_CERT_FILE', '/var/run/opensphere-shell-control-ca/ca.crt')],
          volumeMounts: [{ name: 'internal', mountPath: '/run/opensphere-shell-internal' },
            { name: 'agent-channel', mountPath: '/run/opensphere-shell', readOnly: true },
            { name: 'workspace', mountPath: '/home/opensphere' },
            { name: 'control-ca', mountPath: '/var/run/opensphere-shell-control-ca', readOnly: true }], securityContext,
          resources: { requests: { cpu: '25m', memory: '32Mi', 'ephemeral-storage': '16Mi' }, limits: { cpu: '500m', memory: '256Mi', 'ephemeral-storage': '128Mi' } } },
        { name: 'agent', image: config.runtimeImage, imagePullPolicy: 'IfNotPresent', args: ['agent'],
          env: [...binding, env('OPENSPHERE_SHELL_REGISTRATION_URL', config.registrationURL),
            env('OPENSPHERE_SHELL_CONTROL_URL', config.runtimeControlURL),
            env('OPENSPHERE_SHELL_CONSOLE_API_URL', config.consoleAPIURL), env('SSL_CERT_FILE', '/var/run/opensphere-shell-control-ca/ca.crt')],
          ports: [{ name: 'runtime-wss', containerPort: 8443 }],
          volumeMounts: [{ name: 'internal', mountPath: '/run/opensphere-shell-internal' },
            { name: 'agent-channel', mountPath: '/run/opensphere-shell' },
            { name: 'bootstrap', mountPath: '/var/run/secrets/tokens', readOnly: true },
            { name: 'control-ca', mountPath: '/var/run/opensphere-shell-control-ca', readOnly: true }],
          readinessProbe: { tcpSocket: { port: 'runtime-wss' }, periodSeconds: 2, failureThreshold: 10 }, securityContext,
          resources: { requests: { cpu: '25m', memory: '32Mi', 'ephemeral-storage': '16Mi' }, limits: { cpu: '500m', memory: '128Mi', 'ephemeral-storage': '64Mi' } } },
      ],
    },
  };
}

module.exports = { buildRuntimePod, shellPodName, USER_NAMESPACE_POLICY };
