#!/usr/bin/env bash
set -euo pipefail

# Capture only release/runtime facts needed for a later independent audit.
# Secret objects and their data are deliberately never queried or written.
context="${1:?Kubernetes context is required}"
output_dir="${2:?output directory is required}"
mkdir -p "$output_dir"

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
  opensphere-console-data \
  opensphere-console-change \
  opensphere-console \
  opensphere-oaa-credentials \
  opensphere-foundation \
  opensphere-system \
  -o yaml
capture pods-wide.txt kubectl --context "$context" get pods -A -o wide
capture services.yaml kubectl --context "$context" get service -A -o yaml
capture endpoint-slices.yaml kubectl --context "$context" get endpointslice -A -o yaml
capture installation-lock.yaml kubectl --context "$context" -n opensphere-console get configmap opensphere-installation-lock -o yaml
capture release-inventory.yaml kubectl --context "$context" -n opensphere-console get configmap opensphere-release-inventory -o yaml
capture network-policies.yaml kubectl --context "$context" get networkpolicy -A -o yaml
# The base manifests do not share a cosmetic common label on cluster-scoped
# RBAC. Capture the exact managed names instead of silently producing an empty
# label-filtered List.
capture opensphere-cluster-rbac.yaml kubectl --context "$context" get \
  clusterrole/dupa-module-profile-installer \
  clusterrole/dupa-console-evidence-reader \
  clusterrole/dupa-clidownload-reader \
  clusterrole/opensphere-console-backend \
  clusterrole/opensphere-console-oaa-gateway-environment-reader \
  clusterrole/opensphere-module-cluster-observer-v1 \
  clusterrole/opensphere-module-cluster-his-manager-v1 \
  clusterrole/opensphere-module-cluster-infrastructure-manager-v1 \
  clusterrolebinding/dupa-module-profile-installer \
  clusterrolebinding/dupa-console-evidence-reader \
  clusterrolebinding/dupa-clidownload-reader \
  clusterrolebinding/opensphere-console-backend \
  clusterrolebinding/opensphere-console-oaa-gateway-environment-reader \
  -o yaml
capture recent-events.txt kubectl --context "$context" get events -A --sort-by=.lastTimestamp
capture audit-runtime-boundary.txt kubectl --context "$context" -n opensphere-console-data exec statefulset/opensphere-supabase-postgres -- \
  psql -U supabase_admin -d postgres -Atc "SELECT rolname || '|superuser=' || rolsuper || '|bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname IN ('opensphere_console_backend','opensphere_oaa_gateway','supabase_auth_admin','supabase_storage_admin') ORDER BY rolname; SELECT 'audit_event_rls=' || relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='audit' AND c.relname='event';"
