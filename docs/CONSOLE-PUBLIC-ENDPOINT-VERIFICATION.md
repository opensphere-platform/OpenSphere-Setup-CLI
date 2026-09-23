# Console public endpoint acceptance

The edge.36 installer recorded https://console.opensphere.triangles.com and Ready,
but the Service still exposed1114 ->8443. DNS correctly resolved10.10.1.55;443 timed
out while TLS-verified1114 returned200. HTTPS rendering returned the source manifest
unchanged, and final validation checked internal resources without the public origin.

Edge.37 derives the Service port and nginx listener from normalizeConsoleUrl.
It parses YAML documents, changes only opensphere-console/opensphere-console-ext,
preserves all surrounding workload bytes, and rejects ambiguous or invalid ports.
The exact parser version is pinned in the package lock. Signed Console images and
source artifact verification are unchanged; rendering remains governed Setup work.

Before installation evidence can be written, verifyInstallation checks the actual
Service against the recorded origin and directly requests:

1. / — HTTP200, HTML content type, Console title and application root.
2. /readyz — HTTP200, JSON, Ready with SupabasePostgreSQL authority.
3. /api/identity/bootstrap/status — HTTP200 JSON with required/complete state.

HTTPS verifies the CA chain, hostname and validity. Only public ca.crt/tls.crt fields
are read for trust; no private key is passed to the client. Managed CA and external
certificate chains are supported. Requests have body/time bounds; transient network
and readiness failures retry within a bounded window. Redirects, invalid certificates,
wrong HTML and other contract mismatches fail. There is no port-forward or alternate
port fallback. A failure prevents success evidence and propagates to bootstrap Failed.

Evidence records the exact origin/ports, verified HTML/API, TLS outcome, time and
verifiedFrom=setup-host. It proves that origin from the installing host, not every
client network or trust store. Private CA trust in an administrator browser remains
a separate client-side requirement; no agent may bypass its certificate warning.

Tests use the canonical Console Service manifest and actual disposable HTTPS servers,
including mismatch1114/443, wrong trust/hostname/expiry, wrong-site200, redirects,
API503, response limits and unreachable/stalled origins. The production installation
verification orchestration is exercised with an actual failing/succeeding HTTPS probe
to ensure a public failure never reaches evidence publication.

The administrator explicitly owns target deletion and fresh installation. Preparing
edge.37 must not patch the live Service or run target uninstall/bootstrap on their behalf.
