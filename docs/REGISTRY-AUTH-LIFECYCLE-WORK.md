# GHCR authentication lifecycle implementation — 2026-09-03

Status: Setup edge.21 publication in progress; Console lifecycle remains local and undeployed. See OAUTH-EDGE21-PUBLICATION-STATUS.md for the latest publication state. Sections below are chronological evidence, not current blockers.

Scope: CON-FR-007, CON-FR-014, CON-FR-017. Setup authenticates and verifies read-only package access; Console owns operational credential lifecycle. Setup stays portable and stores no credential on Windows. Existing processes only; no new repository, process, datastore, dependency, or broad cluster role.

C4 ownership: C_API authenticates operator requests, records durable authorization and owns the narrow Registry credential broker; C_REG remains catalog/read-model authority; kubelet consumes access-token-only imagePullSecrets. Broker access is restricted by namespaced RBAC to six named Secret instances (one broker state plus five pull Secrets).

Contract: registry-auth/v1. Refresh token and device_code exist only in the broker Secret in opensphere-console; never in pull Secrets, release locks, audit evidence, logs, browser storage or portable runtime cache. Docker pull credentials contain only the access token. Compare-and-swap prevents parallel refresh. Ambiguous consumed refresh tokens require reauthorization; no blind retry. Device authorization is explicitly initiated by an operator; no automatic browser popups in unattended executions.

Provider constraints: GitHub OAuth device flow needs an OpenSphere-owned registered Client ID with Device Flow enabled. None found in source. Request read:packages + offline_access; reject extra granted scopes and verify identity and actual GHCR manifest reads. GitHub Container Registry documentation still documents PAT classic as its supported user credential; OAuth must remain opt-in and must not be advertised as production-supported until a real registered-app GHCR pull + refresh test passes. PAT fallback is manual rotation, never claimed to auto-refresh.

Gates: device pending/slow_down/cancel/expiry; limited scopes; no credential logging; Secret separation; resourceVersion conflicts; interrupted refresh; fan-out convergence; current session/AAL2/CSRF/idempotency/audit; runtime acceptance; provider end-to-end. Missing Client ID is an external activation gate, not a reason to skip local implementation and tests.

Official sources:
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry

## Final local status

Setup 282 tests, Console API 188 tests, Console contracts 29 tests passed; CLI bundle and Console web production build passed. Source changes are local; migration source commit bcde4e0 and manifest digest verified. No GitHub push/publication or live Kubernetes credential mutation. Historical pre-approval state: auto-review rejected the C_API Secret privilege expansion. This was resolved by the explicit user approval recorded below. A registered OpenSphere OAuth Client ID and live GHCR/refresh/DB/cluster evidence remain necessary. See Console docs/REGISTRY-AUTH-IMPLEMENTATION-REPORT.md for resume state.

## 2026-09-03 approval implemented

User approved the six named Secret get/update exception. C_API deploy.yaml now includes five exact namespace Roles/RoleBindings, a 600-second projected Kubernetes identity with automount disabled, registry-auth/v1 activation, and the public OAuth Client ID Secret reference. Setup discovers the default/kubernetes Service and ready EndpointSlices and renders only host CIDRs with their HTTPS ports. Missing or malformed discovery fails before installation writes. Provider TCP/443 egress has the documented FQDN-policy limitation.

Verification: Setup 286 tests; Console API 188 tests; contracts 30 tests; migration manifest 27; inventory 65 operations/75 schemas/56 DB functions/117 browser patterns; Setup bundle/help passed. Localhost API destinations were 10.96.0.1:443 and 172.18.0.3:6443. Strict client dry-run validated 14 objects without mutation. Evidence: .release/registry-auth-verification/kubernetes-egress.json and console-api-live-rendered.yaml (synthetic image digest, NEVER an installation artifact).

Canonical design trust boundary, lifecycle, index and denominator updated. Registered OpenSphere OAuth Client ID is still absent; asked user for the public ID or registration intent. Live OAuth/GHCR refresh, database execution and Kubernetes cold-pull remain unverified. No push, public release, GHCR write or cluster mutation. Next publication must use a NEW immutable version; current local bundle still reports package version edge.20 and must not replace that public release.

## Publication request follow-up

The user requested an OAuth-enabled public release. Local edge.21 candidate, bundled public Client ID configuration and publication gate are prepared; see [publication status](OAUTH-EDGE21-PUBLICATION-STATUS.md). Remote main/channel/releases remain unchanged. PAT-authorized configuration lookup did not locate a registered OAuth Client ID; organization variables returned 404 (not proof of absence). Do not repeat the earlier claim that the local package is still edge.20.

## Registered app and live verification — 2026-09-03

The user supplied public Client ID Ov23lijzo43hyJMnNcMb and approved Device Flow. Actual read:packages login, 8-hour access-token issuance, refresh, identity preservation and old-access-token rejection passed. GHCR opensphere-console:edge returned HTTP 404/MANIFEST_UNKNOWN before and after refresh. The org packages API probe was invalid for this account (public API type User); its 404 cannot establish package absence. No OAuth credentials were saved.

Setup passed 290 tests against the pinned canonical Console source; provider and lifecycle contract copies match Console. Windows thin launcher, Go tests and bundle checks passed. Publishing edge.21 is explicitly scoped to opt-in OAuth authentication, not proven GHCR pull or a completed Console installation. Unsupported Console bootstrap fails before namespace/credential writes. Console runtime/DB/cold-pull gates remain open.
