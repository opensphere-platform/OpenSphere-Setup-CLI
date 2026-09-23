# RKE2 fresh installation corrections

The administrator will run cleanup and installation. This change prepares the
official CLI; development does not delete or install their target environment.
Only the used Linux amd64 archive and SHA256SUMS are published.

## Partial-installation uninstall

edge.34 required a Beszel DaemonSet or previous ownership checkpoint even when
Gitea failed before the Beszel installation step. Do not bypass this check by
inventing a DaemonSet UID or discarding unknown host data. edge.35 instead uses
the installed digest-pinned utility in read-only inspection Jobs on every exact
Ready node. Each Job mounts only /var/lib/opensphere/beszel-agent read-only and
requires an empty listing. DirectoryOrCreate can create an empty mount directory
on a node that has never hosted the agent. No child files are deleted by inspection.

No live Pod may use that path before or after inspection. Missing/replaced/offline
nodes, nonempty or unreadable directories, or a newly appearing agent stop the
uninstall before namespace deletion. Existing populated installations still use
the original recorded-DaemonSet cleanup and retry checkpoint path.

## Cilium API egress

The original RKE2 repair existed only as a live policy. CIDR peers do not ordinarily
select node-hosted API servers under Cilium's default behavior. Setup now detects
the Cilium policy CRD and adds a policy in opensphere-console selecting only
app.kubernetes.io/name=opensphere-console-api. It permits only kube-apiserver on
the same HTTPS ports discovered from default/kubernetes and its EndpointSlices.
No world/cluster entity, empty endpoint selector, or cluster-global configuration
is introduced. Other CNI providers retain their existing NetworkPolicy rendering.
The generated policy is included in both preflight and the actual materialized
PowerShell installer input.

References: [Cilium network policy](https://docs.cilium.io/en/stable/network/kubernetes/policy/),
[entity policy](https://docs.cilium.io/en/latest/security/policy/layer3/).

The companion Console source declares PGDATA beneath the PVC root in both Gitea
and Supabase manifests and enables Pod DNS resolver discovery in nginx. Actual
manifest-driven PostgreSQL fresh-init/restart and full nginx configuration tests
are required Console CI steps. The Setup governed provider interface remains the
same; target release files are fetched and verified from the exact Console lock.
