# Setup CLI channel pointers

These public text files are mutable distribution selectors for the Setup CLI package only. They do not replace OpenSphere OCI image channels or an installation release lock.

- `edge` must contain `setup-v<semver>-edge.<sequence>`.
- `candidate` must contain `setup-v<semver>-candidate.<sequence>`.
- `stable` must contain `setup-v<semver>` without a prerelease suffix.
- `HOLD` means the channel has no installable Setup CLI release.

An installer resolves a requested channel once and then requires the selected GitHub Release to be published, immutable and non-draft. Exact installations use `--version` and bypass these mutable pointers. A release workflow must refuse publication when its package version and channel pointer disagree.