# Ceph representative credentials — edge.33

Ceph connection now separates one representative storage user/key, optional RBD provisioner/node overrides, and explicitly selected management/observer credentials. A storage key is never implicitly used for management.

Setup carries an immutable-image preparation profile for the existing 22 → OS Shell → Cluster Manager owner. The prepared bundle contains 124 resources. Compared with edge.32 it adds a fixed-name CSI admission policy/binding and get/create/update/delete for CephConnection and ClientProfile at rook-ceph/opensphere-ceph-external only. The policy rejects foreign names, ownership adoption, custom driver configuration and additional credential references. No cluster-admin or external Ceph privileges are added.

For an existing localhost edge installation, run the source or published portable CLI prepare-ceph command described in [edge.32 preparation](CEPH-PREPARATION-EDGE32.md). Then ask 22 to inspect and update Ceph prerequisites through OS Shell. Setup preserves the existing preparation operation record; it does not connect Ceph or receive CephX keys.

Credentials belong in the Console secure Drawer. Configured means saved resources, not authenticated storage or successful PVC I/O. Use the existing data-path verification after real credentials are supplied. Synthetic-key tests do not establish external Ceph connectivity.

This release changes only the bundled preparation profile. Console source lock and uninstall scope remain unchanged. It does not claim a clean reinstall or real external Ceph data-path acceptance.
