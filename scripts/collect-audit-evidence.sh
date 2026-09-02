#!/usr/bin/env bash
set -euo pipefail

# Capture only target bootstrap release/runtime facts for independent audit.
# Secret objects and their data are deliberately never queried or written.
context="${1:?Kubernetes context is required}"
output_dir="${2:?output directory is required}"
mkdir -p "$output_dir"

namespaces=(
  opensphere-console-data
  opensphere-console-change
  opensphere-monitoring
  opensphere-console
  opensphere-system
)

capture() {
  local file="$1"
  shift
  if ! "$@" >"$output_dir/$file" 2>&1; then
    printf 'command failed (evidence collection continues): %q ' "$@" >>"$output_dir/$file"
    printf '\n' >>"$output_dir/$file"
  fi
}

{
  printf 'captured_at_utc=%s\n' "$(date --utc --iso-8601=seconds)"
  printf 'github_run_id=%s\n' "${GITHUB_RUN_ID:-local}"
  printf 'github_sha=%s\n' "${GITHUB_SHA:-local}"
  printf 'kubernetes_context=%s\n' "$context"
} >"$output_dir/metadata.env"

capture kubernetes-version.json kubectl --context "$context" version -o json
capture namespaces.yaml kubectl --context "$context" get namespace \
  "${namespaces[@]}" -o yaml

for namespace in "${namespaces[@]}"; do
  capture "workloads-$namespace.yaml" kubectl --context "$context" -n "$namespace" get \
    deployment,statefulset,daemonset,job,cronjob -o yaml
  capture "services-$namespace.yaml" kubectl --context "$context" -n "$namespace" get \
    service,endpointslice -o yaml
  capture "network-policies-$namespace.yaml" kubectl --context "$context" -n "$namespace" get \
    networkpolicy -o yaml
  capture "recent-events-$namespace.txt" kubectl --context "$context" -n "$namespace" get \
    events --sort-by=.lastTimestamp
done

capture installation-lock.yaml kubectl --context "$context" -n opensphere-console get \
  configmap/opensphere-installation-lock -o yaml
capture installation-state.yaml kubectl --context "$context" -n opensphere-console get \
  configmap/opensphere-installation-state -o yaml
capture installation-evidence.yaml kubectl --context "$context" -n opensphere-console get \
  configmap/opensphere-installation-evidence -o yaml
capture release-inventory.yaml kubectl --context "$context" -n opensphere-console get \
  configmap/opensphere-release-inventory -o yaml

capture target-crds.yaml kubectl --context "$context" get \
  customresourcedefinition/uipluginpackages.plugins.opensphere.io \
  customresourcedefinition/uipluginregistrations.plugins.opensphere.io \
  -o yaml
capture target-cluster-rbac.yaml kubectl --context "$context" get \
  clusterrole/opensphere-extension-controller-cli-downloads \
  clusterrole/opensphere-registry \
  clusterrolebinding/opensphere-extension-controller-cli-downloads \
  clusterrolebinding/opensphere-registry \
  -o yaml
capture target-admission.yaml kubectl --context "$context" get \
  validatingadmissionpolicy/opensphere-console-manual-ui-contract \
  validatingadmissionpolicy/opensphere-console-image-integrity-workload \
  validatingadmissionpolicy/opensphere-console-image-integrity-cronjob \
  validatingadmissionpolicybinding/opensphere-console-manual-ui-contract \
  validatingadmissionpolicybinding/opensphere-console-image-integrity-workload \
  validatingadmissionpolicybinding/opensphere-console-image-integrity-cronjob \
  -o yaml

capture audit-runtime-boundary.txt kubectl --context "$context" -n opensphere-console-data exec \
  statefulset/opensphere-supabase-postgres -- psql -U supabase_admin -d postgres -Atc \
  "SELECT rolname || '|superuser=' || rolsuper || '|bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname IN ('console_api','console_extension_controller','opensphere_console_api_runtime','opensphere_console_extension_runtime','supabase_auth_admin','supabase_storage_admin') ORDER BY rolname; SELECT 'console_audit_event_rls=' || relrowsecurity || '|forced=' || relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='console_audit' AND c.relname='event';"
