// Bootstrap authority only. Never remove external Ceph data, Rook/CSI CRDs or
// consumer namespaces as a side effect of uninstalling Console.
export const CEPH_PREPARATION_CLUSTER_RBAC=Object.freeze([
 'clusterrolebinding/opensphere-ceph-preparation-worker',
 'clusterrolebinding/opensphere-ceph-preparation-inspect',
 'clusterrole/opensphere-ceph-preparation-worker',
 'clusterrole/opensphere-ceph-preparation-inspect',
]);
export const CEPH_PREPARATION_ADMISSION=Object.freeze([
 'validatingadmissionpolicybinding/opensphere-ceph-preparation-job',
 'validatingadmissionpolicybinding/opensphere-ceph-preparation-worker',
 'validatingadmissionpolicy/opensphere-ceph-preparation-job',
 'validatingadmissionpolicy/opensphere-ceph-preparation-worker',
]);
