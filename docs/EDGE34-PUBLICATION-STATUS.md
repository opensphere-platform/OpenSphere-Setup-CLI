# Setup edge.34 publication status

2026-09-12. Source version `0.5.0-edge.34` is a candidate. It is not a published portable release. The public `channels/edge` pointer remains `setup-v0.5.0-edge.33`, whose release and portable assets exist. Do not describe an unbuilt candidate as the current public installer.

2026-09-23 preparation: private Console checkout now uses the dedicated
`CONSOLE_SOURCE_READ_TOKEN` Secret with Contents read-only access and disables
credential persistence. The user selected this method; Secret registration and
successful public build still need verification. No broad host credential has
been copied into Actions and no repository visibility was changed.

Publication validates the exact source package version and prerelease class while
retaining the previously published channel pointer during the build. Immutable
assets and digests must pass verification before a separate reviewed pointer
promotion. No automatic CI main push has been added. The public edge pointer
still names edge.33; this document does not claim that edge.34 is published or
that a target cluster installation has completed.
