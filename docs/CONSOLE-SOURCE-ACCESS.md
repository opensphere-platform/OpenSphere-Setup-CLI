# Console source artifact access

The canonical `opensphere-platform/OpenSphere-console` source repository is public. Setup reads immutable manifests, migrations and installers from `raw.githubusercontent.com` at the exact 40-character source revision without a GitHub account or token. The public Setup Release workflow also checks out that exact public revision without a stored source Secret.

`OPENSPHERE_CONSOLE_SOURCE_TOKEN` remains an optional authenticated GitHub Contents API path for rate-limited environments. It is not required by the canonical public installation flow. When present, Setup removes the variable from its process environment as soon as it creates an opaque credential. The token is never placed in an argument, URL, release lock, Kubernetes Secret or log.

Redirects, invalid source coordinates, forged credential objects and HTTP authentication failures fail closed. A GHCR package token remains a separate stdin-only authority and is never accepted as a source credential.