// Fixed, non-deploying prerequisites for the PSSS-owned Argo CD Core.
// The existing Console installation Role is intentionally left unchanged.
export const BOOTSTRAP_RESOURCES = [
  {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role',
    metadata: {name: 'opensphere-platform-support-core-plan-reader', namespace: 'argocd',
      labels: {'app.kubernetes.io/managed-by': 'opensphere-setup', 'opensphere.io/owner': 'platform-support'}},
    rules: [{apiGroups: ['rbac.authorization.k8s.io'], resources: ['roles', 'rolebindings'],
      resourceNames: ['opensphere-platform-support-core-executor'], verbs: ['get']}],
  },
  {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
    metadata: {name: 'opensphere-platform-support-core-plan-reader', namespace: 'argocd',
      labels: {'app.kubernetes.io/managed-by': 'opensphere-setup', 'opensphere.io/owner': 'platform-support'}},
    roleRef: {apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'opensphere-platform-support-core-plan-reader'},
    subjects: [{kind: 'ServiceAccount', name: 'opensphere-platform-support-runtime', namespace: 'opensphere-console'}],
  },
  {
    apiVersion: 'argoproj.io/v1alpha1', kind: 'AppProject',
    metadata: {name: 'default', namespace: 'argocd',
      labels: {'app.kubernetes.io/managed-by': 'opensphere-setup', 'opensphere.io/owner': 'platform-support'}},
    spec: {description: 'Closed default project; reviewed projects are required for deployments',
      sourceRepos: [], destinations: [], clusterResourceWhitelist: []},
  },
];
