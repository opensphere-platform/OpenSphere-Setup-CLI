# OpenSphere Setup CLI 0.5.0-edge.26 — verify the packaged Console API

This edge prerelease adds a governed, independently updatable Main Index content artifact and exact Kubernetes API endpoint recovery for the Extension Controller. The first renderer/content transition is atomic; later content-only releases reuse the Console workload without rebuilding its runtime image.

The validation boundary is also corrected. A new gate starts the built image using its normal entrypoint and UID 1001 against isolated PostgreSQL. It requires HTTP 200/Ready with a real restricted runtime DB connection, and HTTP 503 with an invalid DB credential. It uses no Kubernetes data, host ports, or host source mounts. Temporary test containers, volumes and network are removed.

CI runs this gate after building the API image. The local edge publisher runs it against the exact image digest before moving date/edge tags, including reused images. OCI metadata inspection is no longer described as an application startup check. The previously published broken image was rejected by this gate; the fixed local image passed.

Governed Console source: `101f770c5691ac905838c4bd2476d5b0bd02e1e8`, Console version `202609031742`. Earlier installer order and null-output fixes remain in place. No DB schema, RBAC, network-policy, credential or readiness requirement is weakened.

[Publication, validation and clean-install record](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/blob/main/docs/CONSOLE-INSTALL-IMAGE-STARTUP-EDGE26.md). The image gate verifies API startup and DB-backed readiness, not a completed Kubernetes bootstrap or every Console feature. Candidate/stable remain on HOLD.

Download the [Windows portable EXE](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.28/opensphere-setup.exe), then start the prepared local installation:

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.26 bootstrap `
  --release edge --context docker-desktop `
  --storage-class standard --registry-auth oauth
```

Approve the displayed new GitHub device code. The public Client ID is built in; no PAT or client secret is bundled. Windows remains portable with verified per-version runtime reuse, no host Setup installation, PATH change or service registration. The first use of a new version downloads about 166 MiB once. Tokens are not kept in the portable runtime cache. Windows edge executables are not Authenticode signed and macOS ad-hoc signatures are not notarization.
