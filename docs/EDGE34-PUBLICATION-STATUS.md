# Setup edge.34 publication status

2026-09-12. Source version `0.5.0-edge.34` is a candidate. It is not a published portable release. The public `channels/edge` pointer remains `setup-v0.5.0-edge.33`, whose release and portable assets exist. Do not describe an unbuilt candidate as the current public installer.

The existing publication workflow remains on hold: its cross-repository checkout currently assumes the Console source is public, but the user requires Console to remain private. No existing broad host credential has been copied into GitHub Actions, and no repository visibility was changed.

The existing workflow also requires the channel pointer before publication. This must be resolved before the next channel promotion: verify immutable assets first, then promote the pointer. A proposed new automatic CI main push was rejected by security review pending explicit authorization for that persistent remote-write behavior. It has **not** been added. This change only restores the current published pointer; it does not authorize or implement future automatic promotion, remove a publication check, or claim successful clean installation.
