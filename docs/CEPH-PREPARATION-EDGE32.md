# Ceph connection preparation — Setup CLI edge.32

## Responsibility

Setup provisions 14 fixed authority, admission, network-policy and durable-record resources. It does not install Rook or connect an external Ceph cluster. On a fresh localhost edge Console bootstrap this happens before the Main Shell is accepted. On an existing installation, use the portable executable's `prepare-ceph` command; without `--apply` it performs server dry-run only.

The profile is restricted to Kubernetes context `docker-desktop`, channel `edge`, and `https://localhost:1114`. It is not a production or multi-cluster Ceph installer. The installer executable remains portable; no Windows service, PATH entry or resident installation is added.

```powershell
.\opensphere-setup.exe --channel edge prepare-ceph --context docker-desktop
.\opensphere-setup.exe --channel edge prepare-ceph --context docker-desktop --apply
```

For source execution use `node src/cli.mjs prepare-ceph --context docker-desktop --channel edge --apply`. The portable launcher consumes its version/channel selector before invoking the Node CLI.

## Normal control path

Ask 22: “Ceph 연결 준비를 설치해줘. 외부 Ceph 연결이나 데이터 변경은 하지 마.”

22 discovers the existing Cluster Manager's signed commands through OS Shell, reads the current plan, submits the exact revision, and queries status. GUI and OS CLI use the same owner commands:

- `cluster-manager.ceph.prerequisites.plan`
- `cluster-manager.ceph.prerequisites.install`
- `cluster-manager.ceph.prerequisites.status`

The owner applies 122 fixed resources from existing Rook 1.20.2 and Ceph CSI drivers 1.0.4 assets using a short-lived immutable-image Job. Setup does not accept a caller-supplied image, manifest, executable, namespace or credential for this profile. Only the requested operation UUID is passed to the Job. The profile's image and bundle digest are bundled in `src/ceph-preparation-profile.json`.

## Security and retry

The preparer cannot read Secrets or obtain cluster-admin. Named bind/escalate is limited to the fixed installation roles, and admission limits all writes to the fixed inventory. Named server-side apply creates the intended roles without an unbounded escalation grant. CSI controllers retain their upstream operating privileges, including Secret reads and privileged node-plugin host mounts; these are separate from the preparer's own authority. No NBD host preparation is performed.

Existing operation history is preserved on profile replay. A record with another owner, deletion in progress or admission conflict fails rather than being overwritten. Console uninstall lists only the eight cluster-scoped profile authorities/admission resources; it does not implicitly delete Rook CRDs, external storage namespaces, pools or data.

## Acceptance boundary

Profile application is not installation completion. Ceph preparation is complete only when the actual owner verifies CRDs, desired resources, Rook/CSI workloads, driver registrations and runtime connection permissions, and repeated preparation returns no change. External Ceph remains NotConfigured until its real connection information is provided. This release does not claim a full clean Console reinstall or real PVC I/O verification.

The governed Console source lock remains `baeac27377a5e843d8ffe82992894bee53864e34`; no unrelated Console source is pulled into this Setup change.
