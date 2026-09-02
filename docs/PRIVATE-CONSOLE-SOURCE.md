# Private Console source artifacts

OpenSphere Setup treats container registry credentials and Console source credentials as separate authorities.

OPENSPHERE_CONSOLE_SOURCE_TOKEN must grant read-only GitHub Contents access to the private
opensphere-platform/OpenSphere-console repository. Setup removes the variable from its process
environment as soon as it creates an opaque credential. The token is never placed in an argument,
URL, release lock, Kubernetes Secret, or log.

When this credential is present, immutable artifacts are read through the GitHub Contents API at
the exact 40-character Console source revision. Redirects, invalid coordinates, forged credential
objects, and HTTP authentication failures fail closed. Without the variable, Setup retains its
public raw.githubusercontent.com path.

PowerShell example:

    $env:OPENSPHERE_CONSOLE_SOURCE_TOKEN = $env:GITHUB_SOURCE_READ_TOKEN
    try {
      $env:GHCR_TOKEN | opensphere-setup doctor --release edge --context docker-desktop --registry-username <github-login> --registry-token-stdin
    } finally {
      Remove-Item Env:OPENSPHERE_CONSOLE_SOURCE_TOKEN -ErrorAction SilentlyContinue
    }

The GHCR token remains stdin-only and is not accepted as a source credential.
