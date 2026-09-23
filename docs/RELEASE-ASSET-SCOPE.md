# Release asset scope

Administrator decision, 2026-09-23: do not create unused GitHub Release Assets.
Publish only assets required by an actual installation. The current installation
runs on RKE2 Linux amd64, so publication contains exactly:

- `opensphere-setup-linux-amd64.tar.gz`
- `SHA256SUMS`

The workflow builds one platform, rejects unexpected intermediate files, and
verifies exactly two uploaded assets and their digests. Other platform build code
remains available, but adding a publication target requires an actual installation
need and a corresponding reviewed change to the matrix and asset allowlist.

The immutable edge.34 release was already published for five platforms before this
decision. Its historical verification record remains accurate. This workflow-only
change does not publish a new CLI version, replace existing assets, move a channel,
or install Console. GitHub's automatically generated source archives are not files
uploaded by this workflow.
