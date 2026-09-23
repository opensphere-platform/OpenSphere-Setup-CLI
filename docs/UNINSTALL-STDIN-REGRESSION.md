# Uninstall stdin hang — 2026-09-23

RKE2 edge.35 completed all 11 read-only Beszel inspection Jobs, then remained at
`kubectl --context default create -f -` for more than five minutes. Its stdin was
`/dev/pts/2`. The RBAC cleanup ConfigMap was absent, all Console namespaces were
Active and the two Gitea PVs remained Bound; namespace/data deletion had not begun.

`run()` supplied the manifest as spawnSync `input` but set all stdio to `inherit`
when capture was false. Therefore kubectl read the terminal instead of the manifest.
The same path affects the installed-agent cleanup checkpoint. Mocked kubectl
tests verified the object but failed to exercise this real subprocess boundary.

When input is supplied, stdin now always uses a pipe. Output still streams unless
capture is requested. An explicitly empty string supplies EOF; absent input retains
interactive behavior. `test/process-stdin.test.mjs` uses real nested child processes
with different parent/child input. The original implementation fails and the fixed
implementation passes; no Kubernetes API is involved in those regression tests.
Cleanup checkpoint requests also have explicit request/process timeouts. Stage,
node and namespace progress includes elapsed time in the CLI.

The user stops the blocked command with Ctrl+C and reruns the verified edge.36
uninstall. Existing ownership, node, path, shared-RBAC and CRD guards still apply.
Do not submit a manifest into the blocked terminal or delete namespaces around
the installer. An agent staging the fix must not execute target uninstall/bootstrap
when the administrator has chosen to run those commands themselves.
