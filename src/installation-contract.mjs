export const INSTALLATION_LOCK_CONFIGMAP = 'opensphere-installation-lock';
export const INSTALLATION_EVIDENCE_CONFIGMAP = 'opensphere-installation-evidence';

export const MANAGED_NAMESPACES = Object.freeze([
  'opensphere-console-data',
  'opensphere-console-change',
  'opensphere-monitoring',
  'opensphere-console',
  'opensphere-osaa-credentials',
  'opensphere-shell-sessions',
  'opensphere-system'
]);

export const MANAGED_CLUSTER_SCOPED_RESOURCES = Object.freeze({
  customResourceDefinitions: Object.freeze([
    'uipluginpackages.plugins.opensphere.io',
    'uipluginregistrations.plugins.opensphere.io'
  ]),
  clusterRbac: Object.freeze([
    'clusterrolebinding/opensphere-extension-controller-cli-downloads',
    'clusterrolebinding/opensphere-registry',
    'clusterrolebinding/opensphere-console-osaa-gateway-environment-reader',
    'clusterrolebinding/opensphere-shell-runtime-token-reviewer',
    'clusterrolebinding/opensphere-cluster-manager-runtime',
    'clusterrolebinding/opensphere-extension-installation-profile-reader',
    'clusterrole/opensphere-extension-controller-cli-downloads',
    'clusterrole/opensphere-registry',
    'clusterrole/opensphere-console-osaa-gateway-environment-reader',
    'clusterrole/opensphere-shell-runtime-token-reviewer',
    'clusterrole/opensphere-cluster-manager-runtime',
    'clusterrole/opensphere-extension-installation-profile-reader'
  ]),
  admissionPolicies: Object.freeze([
    'validatingadmissionpolicybinding/opensphere-console-manual-ui-contract',
    'validatingadmissionpolicy/opensphere-console-manual-ui-contract',
    'validatingadmissionpolicybinding/opensphere-console-image-integrity-workload',
    'validatingadmissionpolicy/opensphere-console-image-integrity-workload',
    'validatingadmissionpolicybinding/opensphere-console-image-integrity-cronjob',
    'validatingadmissionpolicy/opensphere-console-image-integrity-cronjob',
    'validatingadmissionpolicybinding/opensphere-shell-runtime-template-v1',
    'validatingadmissionpolicy/opensphere-shell-runtime-template-v1'
  ])
});

export const BASELINE_OBSERVABILITY_REQUIREMENT = Object.freeze({
  namespace: 'opensphere-monitoring',
  workload: 'daemonset/beszel-agent',
  runAsUser: 0,
  hostAccess: Object.freeze([
    '/proc:ro',
    '/sys:ro',
    '/etc:ro',
    '/:ro',
    '/var/lib/opensphere/beszel-agent:rw'
  ]),
  setupRepairsHost: false,
  setupLowersPodSecurity: false
});

export const INSTALLATION_PHASES = Object.freeze([
  'Preparing',
  'Installing',
  'Ready',
  'Failed'
]);
