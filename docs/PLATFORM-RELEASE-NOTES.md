# OpenSphere Setup CLI 0.5.0-edge.31 — HISS and Platform Support prerequisites

This edge prerelease pins Console source `baeac27377a5e843d8ffe82992894bee53864e34`.
It includes the reviewed HISS preparation, separate L4 trust and fixed Core preparation
contracts, and the Crossplane consumer observer correction. It does not install L4
workloads by itself: after Console is ready, use 22 → OS Shell → the module owner.

The observer consists of exactly one ClusterRole and one ClusterRoleBinding named
`opensphere-platform-support-core-observer`, assigned only to the Console Cluster Manager
runtime service account. It adds cluster-wide get/list for Crossplane Providers, Functions,
ProviderConfigs, Releases, Compositions and CompositeResourceDefinitions. This observer
adds no Secret access, writes, wildcard, bind or escalate permissions. The separately
reviewed fixed Core preparation contains controller execution authority; it is not a
read-only profile. Existing Core artifact bytes and automatic removal scope are unchanged.

Validation: 350 Setup tests and 26 observer/profile/deployment contract tests pass.
The exact two observer resources are applied on localhost, and replay of the existing
Core preparation created 0 resources and preserved all 53. Argo CD Core has been verified
Ready with a no-change reinstall. Crossplane Core installation via 22 passed the previous
403 check but is not accepted: this PC's Docker Desktop registry mirror returned empty
image responses. No full clean-install reproducibility or Gitea delivery completion is claimed.

Windows remains a portable executable, with checksum-verified runtime reuse and no
Windows application installation, PATH modification or permanent service. GitHub device
OAuth remains supported. Setup `--version` / `--channel` selectors remain independent
of Console `--release`. Candidate and stable remain on HOLD.

[Windows portable launcher](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.31/opensphere-setup.exe)

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.31 status --context docker-desktop
```

A successful Setup update is not evidence that optional Crossplane or L5 services are ready.
