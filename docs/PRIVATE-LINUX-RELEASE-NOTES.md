## Private Linux distribution

This release is available only to authenticated users who can read the private
`opensphere-platform/OpenSphere-Setup-CLI` repository.

Assets:

- `opensphere-setup-linux-amd64`: Linux x86_64 single executable
- `opensphere-setup-linux-arm64`: Linux AArch64 single executable
- `SHA256SUMS`: release asset checksums

The self-extracting executables contain the Node.js SEA runtime, architecture
specific `libatomic.so.1`, Setup certificate-generation assets, and required
Node/GCC redistribution notices. They verify the embedded payload and extract
it once into the calling user's private XDG cache. Node.js, libatomic packages
and a repository checkout are not required on the target node.

Runtime prerequisites remain `pwsh`, `kubectl`, `gh`, `tar`, `sha256sum` and
network access to GitHub/GHCR.

See `docs/PRIVATE-LINUX-INSTALL.md` in this private repository for installation,
verification, bootstrap and upgrade commands.
