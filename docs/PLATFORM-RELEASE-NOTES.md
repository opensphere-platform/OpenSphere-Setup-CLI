# OpenSphere Setup CLI — reusable portable execution

Setup is an occasional standalone administration tool, not an installed host application.

- Replace the old edge.19 launcher with this release's `opensphere-setup.exe` once.
- Each selected version is downloaded and extracted only once beside the EXE in `opensphere-setup-runtime/<release-tag>/`.
- Later commands verify and reuse the same runtime files. No repeated archive download or extraction for that version.
- Small channel and immutable Release metadata requests still require Internet access. This is not a fully offline launcher.
- Every reuse checks the stored archive and SHA256SUMS against GitHub digests, then checks all extracted files against the verified archive. Changed, missing, linked, or extra files block execution.
- Concurrent first runs share an OS preparation lock. Failed downloads never become complete versions; successful runtimes survive command success, failure, and cancellation.
- New versions live in separate folders. No automatic eviction or overwriting of existing versions.
- Move the EXE and its runtime folder together. To remove them, first close all Setup commands, then delete both. No Setup installation directory, global npm package, PATH registration, service, or hidden shared cache.
- The first Windows archive download remains about 174 MB. The archive and expanded runtime use about 610 MiB per version; leave at least 1 GiB free for a new version. Internal Node remains about 99 MiB.
- Linux/macOS and pre-downloaded Windows archives run in place as before.
- bootstrap/upgrade do not install the host os CLI. Windows development CA trust requires explicit `bootstrap --trust-local-ca`.

```powershell
.\opensphere-setup.exe version
.\opensphere-setup.exe --channel edge status --context docker-desktop
.\opensphere-setup.exe --channel edge doctor --release edge --context docker-desktop
.\opensphere-setup.exe --version 0.5.0-edge.20 bootstrap --release edge --context docker-desktop
```

Setup selectors precede the command. Console `--release` and `--lock` remain independent.
Caller cwd, stdin, stdout/stderr and exit status are preserved. Runtime cleanup never deletes operation outputs or Kubernetes resources.

Edge Windows executables are not Authenticode signed. Do not bypass organization controls.
macOS ad-hoc signatures are not Apple notarization. Candidate/stable remain HOLD.
