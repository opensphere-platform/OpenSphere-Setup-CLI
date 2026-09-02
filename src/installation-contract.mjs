export const INSTALLATION_LOCK_CONFIGMAP = 'opensphere-installation-lock';
export const INSTALLATION_EVIDENCE_CONFIGMAP = 'opensphere-installation-evidence';

export const MANAGED_NAMESPACES = Object.freeze([
  'opensphere-console-data',
  'opensphere-console-change',
  'opensphere-monitoring',
  'opensphere-console',
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
    'clusterrole/opensphere-extension-controller-cli-downloads',
    'clusterrole/opensphere-registry'
  ]),
  admissionPolicies: Object.freeze([
    'validatingadmissionpolicybinding/opensphere-console-manual-ui-contract',
    'validatingadmissionpolicy/opensphere-console-manual-ui-contract',
    'validatingadmissionpolicybinding/opensphere-console-image-integrity-workload',
    'validatingadmissionpolicy/opensphere-console-image-integrity-workload',
    'validatingadmissionpolicybinding/opensphere-console-image-integrity-cronjob',
    'validatingadmissionpolicy/opensphere-console-image-integrity-cronjob'
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
