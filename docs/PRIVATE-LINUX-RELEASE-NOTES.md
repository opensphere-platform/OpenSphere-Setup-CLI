## Private Linux distribution

This release is available only to authenticated users who can read the private
`opensphere-platform/OpenSphere-Setup-CLI` repository.

Assets:

- `opensphere-setup-linux-amd64`: Linux x86_64 single executable
- `opensphere-setup-linux-arm64`: Linux AArch64 single executable
- `SHA256SUMS`: release asset checksums

The executables contain the Node.js runtime and Setup certificate-generation
assets. Node.js and a repository checkout are not required on the target node.
Runtime prerequisites remain `pwsh`, `kubectl`, GitHub CLI authentication and
network access to GitHub/GHCR. Minimal Linux installations must also provide
`libatomic.so.1` (`libatomic1` on Debian/Ubuntu, `libatomic` on RHEL-family
distributions).

See `docs/PRIVATE-LINUX-INSTALL.md` in this private repository for installation,
verification, bootstrap and upgrade commands.
