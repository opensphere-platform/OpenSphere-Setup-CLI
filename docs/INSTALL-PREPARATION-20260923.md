# Administrator-driven fresh installation

Bootstrap asks the installing administrator for the Console URL and an existing
StorageClass and displays the Kubernetes context for confirmation before
authentication, lock migration or cluster mutation. Longhorn is optional; the
existing channel storage policy still applies. The administrator prepares DNS.
Explicit automated execution requires all of `--non-interactive --yes --console
<origin> --storage-class <name>`. EOF/cancellation prevents installation.

The closed, non-secret input receipt is stored under `.opensphere-setup/inputs`.
Conversation history is not a configuration source. Resume keeps the installed
URL and storage choice, and does not silently migrate either.

Portable packages include a Node executable for the PowerShell installer
subprocesses. Linux portable PowerShell uses invariant globalization unless the
operator explicitly overrides it, permitting minimal hosts without system ICU.

`uninstall --purge-data --confirm DELETE-OPENSPHERE` also removes Beszel agent
state from the exact Console host path, using the installed digest-pinned
bootstrap utility. It records node identities, requires Ready nodes, stops the
agent before cleanup, and waits for each cleanup Job. Failure retains the
checkpoint for retry. The path may remain as an empty mount directory.
If both the agent workload and the ownership checkpoint are missing, purge stops
for operator inspection rather than inferring that its host data was removed.

The user explicitly approved this deletion extension on 2026-09-23. Console's
named Role/RoleBinding pairs in default, argocd and crossplane-system are removed
only after checking their Console service-account subjects and recorded UIDs.
Shared namespaces themselves, ArgoCD/Crossplane workloads and unrelated RBAC
remain. Cluster ownership includes the previously omitted Console read/observer
roles. No target-cluster install or uninstall was executed during preparation.

Traceability: CON-FR-001/014/017; Setup administrator/install record, C_API identity
bootstrap, C_EXT permissions and C_MON baseline observation. No new permanent
service or datastore; cleanup Jobs and retry ConfigMaps live inside the existing
managed namespaces and disappear with a successful uninstall.
