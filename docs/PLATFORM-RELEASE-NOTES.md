# OpenSphere Setup CLI — portable execution

Setup is an occasional standalone administration tool, not an installed host application.

- Windows: download `opensphere-setup.exe` and run directly.
- Linux/macOS, or pre-downloaded Windows runtime: extract the platform archive and run in place.
- No Setup installation directory, global npm package, PATH registration, service, or permanent runtime cache.
- Windows launcher verifies immutable GitHub metadata, asset size, SHA-256 and SHA256SUMS, extracts the runtime to a unique temporary directory, executes it and cleans up.
- Each operational command downloads the full runtime archive. Internal Node is still about 99 MiB; this release changes lifecycle, not runtime size.
- bootstrap/upgrade no longer install the host os CLI. Use the separate explicit `install-cli` command.
- Windows localhost CA trust requires explicit `bootstrap --trust-local-ca`.
- Old installer assets are no longer published. Immutable older releases remain unchanged.
- Runtimes without `hostInstallation: explicit-only` are refused by the new launcher.

```powershell
.\opensphere-setup.exe version
.\opensphere-setup.exe --channel edge doctor --release edge --context docker-desktop
.\opensphere-setup.exe --version 0.5.0-edge.19 bootstrap --release edge --context docker-desktop
```

Setup selectors precede the command; Console `--release` and `--lock` remain independent.
Caller cwd, stdin, stdout/stderr and exit status are preserved.
Operation outputs and Kubernetes resources are not removed with the temporary runtime.

Five platform archives contain Node.js, PowerShell and kubectl (plus libatomic on Linux).
Every platform runs native runtime smoke tests; publication verifies all remote digests.

Edge Windows executables are not Authenticode signed. Do not bypass organization controls.
macOS ad-hoc signatures are not Apple notarization. Candidate/stable remain HOLD.
