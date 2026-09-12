-- OpenSphere Console fresh-start authority baseline.
-- This file is the proposed baseline-0001 model. It does not migrate a legacy DB.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'console_api') THEN
    CREATE ROLE console_api NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'console_extension_controller') THEN
    CREATE ROLE console_extension_controller NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA console_identity;
CREATE SCHEMA console_operation;
CREATE SCHEMA console_audit;
CREATE SCHEMA console_extension;
CREATE SCHEMA console_migration;

REVOKE ALL ON SCHEMA console_identity, console_operation, console_audit, console_extension, console_migration FROM PUBLIC;
GRANT USAGE ON SCHEMA console_identity, console_operation TO authenticated;
GRANT USAGE ON SCHEMA console_identity, console_operation, console_audit, console_extension TO console_api;
GRANT USAGE ON SCHEMA console_operation, console_extension TO console_extension_controller;

CREATE TABLE console_migration.applied_migration (
  applied_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  global_id text NOT NULL UNIQUE
    CHECK (global_id ~ '^opensphere-console/[0-9]{8}/[0-9]{4}$'),
  semantic_key text NOT NULL UNIQUE
    CHECK (semantic_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  predecessor_global_id text REFERENCES console_migration.applied_migration(global_id) ON DELETE RESTRICT,
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[a-f0-9]{64}$'),
  source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
  migration_set_digest text NOT NULL CHECK (migration_set_digest ~ '^sha256:[a-f0-9]{64}$'),
  migration_set_size integer NOT NULL CHECK (migration_set_size > 0),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  executor name NOT NULL DEFAULT current_user
);

CREATE FUNCTION console_migration.reject_applied_migration_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'console_migration.applied_migration is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER applied_migration_row_append_only
  BEFORE UPDATE OR DELETE ON console_migration.applied_migration
  FOR EACH ROW EXECUTE FUNCTION console_migration.reject_applied_migration_mutation();
CREATE TRIGGER applied_migration_truncate_append_only
  BEFORE TRUNCATE ON console_migration.applied_migration
  FOR EACH STATEMENT EXECUTE FUNCTION console_migration.reject_applied_migration_mutation();

REVOKE ALL ON TABLE console_migration.applied_migration FROM PUBLIC;
REVOKE ALL ON SEQUENCE console_migration.applied_migration_applied_sequence_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION console_migration.reject_applied_migration_mutation() FROM PUBLIC;

CREATE TABLE console_identity.subject_authority (
  subject_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  person_ref uuid NOT NULL,
  permission_revision bigint NOT NULL CHECK (permission_revision >= 0),
  revoke_epoch bigint NOT NULL DEFAULT 0 CHECK (revoke_epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE console_identity.browser_session (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  token_digest bytea NOT NULL UNIQUE,
  csrf_token_digest bytea NOT NULL UNIQUE,
  aal text NOT NULL CHECK (aal IN ('aal1', 'aal2')),
  permission_revision bigint NOT NULL CHECK (permission_revision >= 0),
  revoke_epoch bigint NOT NULL DEFAULT 0 CHECK (revoke_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND length(btrim(revoke_reason)) > 0))
);

CREATE TABLE console_identity.permission_grant (
  subject_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-z0-9_.:-]{2,127}$'),
  grant_revision bigint NOT NULL CHECK (grant_revision > 0),
  granted_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (subject_id, permission, grant_revision)
);

CREATE INDEX browser_session_subject_active_idx
  ON console_identity.browser_session (subject_id, expires_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE console_identity.subject_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.subject_authority FORCE ROW LEVEL SECURITY;
ALTER TABLE console_identity.browser_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.browser_session FORCE ROW LEVEL SECURITY;
ALTER TABLE console_identity.permission_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.permission_grant FORCE ROW LEVEL SECURITY;

CREATE POLICY subject_authority_self_read
  ON console_identity.subject_authority
  FOR SELECT TO authenticated
  USING (subject_id = auth.uid());

CREATE POLICY browser_session_self_read
  ON console_identity.browser_session
  FOR SELECT TO authenticated
  USING (subject_id = auth.uid());

CREATE POLICY permission_grant_self_read
  ON console_identity.permission_grant
  FOR SELECT TO authenticated
  USING (subject_id = auth.uid() AND revoked_at IS NULL);

GRANT SELECT ON console_identity.subject_authority,
  console_identity.browser_session,
  console_identity.permission_grant TO authenticated;

CREATE TABLE console_operation.operation (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id text NOT NULL CHECK (action_id ~ '^[a-z][a-z0-9.-]{2,127}$'),
  action_version text NOT NULL CHECK (action_version ~ '^[0-9]+\.[0-9]+$'),
  actor_ref uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  target_ref text NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 512),
  required_permission text NOT NULL CHECK (required_permission ~ '^[a-z][a-z0-9_.:-]{2,127}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  risk text NOT NULL CHECK (risk IN ('R0', 'R1', 'R2', 'R3')),
  reason text NOT NULL DEFAULT '',
  aal text NOT NULL CHECK (aal IN ('aal1', 'aal2')),
  permission_revision bigint NOT NULL CHECK (permission_revision >= 0),
  plan_revision text NOT NULL CHECK (length(plan_revision) BETWEEN 1 AND 128),
  approval_required boolean NOT NULL,
  approval_revision text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 8 AND 128),
  source_revision text,
  owner_ref text,
  execution_plan jsonb,
  state text NOT NULL CHECK (state IN ('Planned', 'Authorized', 'Submitted', 'Reconciling', 'Applied', 'Verified', 'Failed', 'Unknown', 'RolledBack')),
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  expected_postcondition jsonb,
  observed_postcondition jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (actor_ref, idempotency_key),
  CHECK (risk = 'R0' OR length(btrim(reason)) BETWEEN 3 AND 500),
  CHECK (risk NOT IN ('R2', 'R3') OR aal = 'aal2'),
  CHECK (updated_at >= created_at)
);

CREATE TABLE console_operation.outbox (
  outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES console_operation.operation(operation_id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  claimed_at timestamptz,
  claim_owner uuid,
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  UNIQUE (operation_id, event_type, payload_digest)
);

CREATE TABLE console_operation.approval (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES console_operation.operation(operation_id) ON DELETE RESTRICT,
  actor_ref uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  approval_revision text NOT NULL CHECK (length(approval_revision) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  permission_revision bigint NOT NULL CHECK (permission_revision >= 0),
  revoke_epoch bigint NOT NULL CHECK (revoke_epoch >= 0),
  aal text NOT NULL CHECK (aal = 'aal2'),
  expected_state_version bigint NOT NULL CHECK (expected_state_version >= 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (actor_ref, idempotency_key),
  UNIQUE (operation_id, actor_ref)
);

CREATE TABLE console_operation.verification_receipt (
  verification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL UNIQUE REFERENCES console_operation.operation(operation_id) ON DELETE RESTRICT,
  actor_ref uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  permission_revision bigint NOT NULL CHECK (permission_revision >= 0),
  revoke_epoch bigint NOT NULL CHECK (revoke_epoch >= 0),
  expected_state_version bigint NOT NULL CHECK (expected_state_version >= 0),
  authority text NOT NULL CHECK (authority IN ('ConsoleExtensionRevocation', 'KubernetesUIPluginRegistration')),
  observation_digest text NOT NULL CHECK (observation_digest ~ '^sha256:[0-9a-f]{64}$'),
  observation jsonb NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (actor_ref, idempotency_key)
);

CREATE TABLE console_operation.execution_receipt (
  execution_receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES console_operation.operation(operation_id) ON DELETE RESTRICT,
  owner_ref text NOT NULL CHECK (length(owner_ref) BETWEEN 1 AND 128),
  worker_id uuid NOT NULL,
  claim_epoch bigint NOT NULL CHECK (claim_epoch > 0),
  phase text NOT NULL CHECK (phase IN ('Reconciling', 'Applied', 'Verified', 'Failed', 'Unknown')),
  evidence jsonb NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (operation_id, claim_epoch, phase)
);

CREATE TABLE console_extension.registry_connection (
  connection_id text PRIMARY KEY CHECK (connection_id = 'opensphere-ghcr'),
  registry_origin text NOT NULL CHECK (registry_origin = 'ghcr.io'),
  namespace text NOT NULL CHECK (namespace = 'opensphere-platform'),
  username text CHECK (username IS NULL OR length(username) BETWEEN 1 AND 128),
  credential_version text CHECK (credential_version IS NULL OR length(credential_version) BETWEEN 1 AND 128),
  secret_ref_digest text CHECK (secret_ref_digest IS NULL OR secret_ref_digest ~ '^sha256:[0-9a-f]{64}$'),
  configuration_state text NOT NULL CHECK (configuration_state IN ('NotConfigured', 'Configured', 'VerificationPending', 'Verified', 'Failed')),
  last_verified_at timestamptz,
  last_verification_code text CHECK (last_verification_code IS NULL OR last_verification_code ~ '^[A-Z][A-Za-z0-9]{2,63}$'),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (
    (configuration_state = 'NotConfigured' AND username IS NULL AND credential_version IS NULL AND secret_ref_digest IS NULL)
    OR (configuration_state <> 'NotConfigured' AND username IS NOT NULL AND credential_version IS NOT NULL AND secret_ref_digest IS NOT NULL)
  ),
  CHECK (configuration_state <> 'Verified' OR last_verified_at IS NOT NULL)
);

INSERT INTO console_extension.registry_connection(
  connection_id, registry_origin, namespace, configuration_state
) VALUES ('opensphere-ghcr', 'ghcr.io', 'opensphere-platform', 'NotConfigured');

CREATE TABLE console_extension.revocation (
  image_ref text PRIMARY KEY CHECK (
    image_ref ~ '^ghcr\.io/opensphere-platform/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$'
  ),
  operation_id uuid NOT NULL UNIQUE REFERENCES console_operation.operation(operation_id) ON DELETE RESTRICT,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  action_version text NOT NULL CHECK (action_version ~ '^[0-9]+\.[0-9]+$'),
  claim_epoch bigint NOT NULL CHECK (claim_epoch > 0),
  revoked_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

ALTER TABLE console_operation.operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_operation.operation FORCE ROW LEVEL SECURITY;
ALTER TABLE console_operation.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_operation.outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE console_operation.approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_operation.approval FORCE ROW LEVEL SECURITY;
ALTER TABLE console_operation.verification_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_operation.verification_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE console_operation.execution_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_operation.execution_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE console_extension.registry_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_extension.registry_connection FORCE ROW LEVEL SECURITY;
ALTER TABLE console_extension.revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_extension.revocation FORCE ROW LEVEL SECURITY;

CREATE POLICY operation_actor_read
  ON console_operation.operation
  FOR SELECT TO authenticated
  USING (actor_ref = auth.uid());

CREATE POLICY approval_actor_read
  ON console_operation.approval
  FOR SELECT TO authenticated
  USING (actor_ref = auth.uid());

CREATE POLICY verification_actor_read
  ON console_operation.verification_receipt
  FOR SELECT TO authenticated
  USING (actor_ref = auth.uid());

CREATE POLICY execution_receipt_initiator_read
  ON console_operation.execution_receipt
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM console_operation.operation operation_record
    WHERE operation_record.operation_id = execution_receipt.operation_id
      AND operation_record.actor_ref = auth.uid()
  ));

GRANT SELECT ON console_operation.operation, console_operation.approval,
  console_operation.verification_receipt,
  console_operation.execution_receipt TO authenticated;

CREATE TABLE console_audit.event (
  sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  operation_id uuid REFERENCES console_operation.operation(operation_id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  correlation_id text NOT NULL,
  actor_ref text NOT NULL,
  action text NOT NULL,
  target_ref text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'succeeded', 'failed', 'unknown')),
  reason text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash text CHECK (previous_hash IS NULL OR previous_hash ~ '^sha256:[0-9a-f]{64}$'),
  event_hash text NOT NULL UNIQUE CHECK (event_hash ~ '^sha256:[0-9a-f]{64}$')
);

ALTER TABLE console_audit.event ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_audit.event FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION console_audit.reject_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'console audit events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_event_immutable
  BEFORE UPDATE OR DELETE ON console_audit.event
  FOR EACH ROW EXECUTE FUNCTION console_audit.reject_event_mutation();

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON console_audit.event
  FOR EACH STATEMENT EXECUTE FUNCTION console_audit.reject_event_mutation();

CREATE OR REPLACE FUNCTION console_audit.append_event_internal(
  p_operation_id uuid,
  p_correlation_id text,
  p_actor_ref text,
  p_action text,
  p_target_ref text,
  p_outcome text,
  p_reason text,
  p_evidence jsonb
)
RETURNS console_audit.event
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_audit
AS $$
DECLARE
  v_event console_audit.event;
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := statement_timestamp();
  v_previous_hash text;
  v_event_hash text;
  v_chain_input jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(471920260901);
  SELECT event_hash INTO v_previous_hash
    FROM console_audit.event
    ORDER BY sequence_id DESC
    LIMIT 1;

  v_chain_input := jsonb_build_object(
    'eventId', v_event_id,
    'operationId', p_operation_id,
    'occurredAt', v_occurred_at,
    'correlationId', p_correlation_id,
    'actorRef', p_actor_ref,
    'action', p_action,
    'targetRef', p_target_ref,
    'outcome', p_outcome,
    'reason', p_reason,
    'evidence', COALESCE(p_evidence, '{}'::jsonb),
    'previousHash', v_previous_hash
  );
  v_event_hash := 'sha256:' || encode(sha256(convert_to(v_chain_input::text, 'UTF8')), 'hex');

  INSERT INTO console_audit.event(
    event_id, operation_id, occurred_at, correlation_id, actor_ref, action,
    target_ref, outcome, reason, evidence, previous_hash, event_hash
  ) VALUES (
    v_event_id, p_operation_id, v_occurred_at, p_correlation_id, p_actor_ref, p_action,
    p_target_ref, p_outcome, COALESCE(p_reason, ''), COALESCE(p_evidence, '{}'::jsonb),
    v_previous_hash, v_event_hash
  ) RETURNING * INTO v_event;
  RETURN v_event;
END;
$$;

REVOKE ALL ON FUNCTION console_audit.append_event_internal(uuid, text, text, text, text, text, text, jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION console_audit.list_events(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_cursor bigint,
  p_limit integer,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_items jsonb;
  v_evidence_refs jsonb;
  v_page_count bigint;
  v_last_visible_sequence bigint;
  v_observed_at timestamptz := statement_timestamp();
BEGIN
  IF p_limit NOT BETWEEN 1 AND 200
      OR (p_cursor IS NOT NULL AND p_cursor < 1)
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid audit projection request' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_observed_at THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = 'console.audit.read'
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;

  WITH page AS (
    SELECT event.*
    FROM console_audit.event
    WHERE p_cursor IS NULL OR sequence_id < p_cursor
    ORDER BY sequence_id DESC
    LIMIT p_limit + 1
  ), visible AS (
    SELECT * FROM page ORDER BY sequence_id DESC LIMIT p_limit
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'sequenceId', visible.sequence_id::text,
      'eventId', visible.event_id,
      'operationId', visible.operation_id,
      'occurredAt', visible.occurred_at,
      'correlationId', visible.correlation_id,
      'actorRef', visible.actor_ref,
      'action', visible.action,
      'targetRef', visible.target_ref,
      'outcome', visible.outcome,
      'reason', visible.reason,
      'evidence', visible.evidence,
      'previousHash', visible.previous_hash,
      'eventHash', visible.event_hash
    ) ORDER BY visible.sequence_id DESC), '[]'::jsonb),
    COALESCE(jsonb_agg(('audit-event:' || visible.event_id::text)::text
      ORDER BY visible.sequence_id DESC), '[]'::jsonb),
    (SELECT count(*) FROM page),
    min(visible.sequence_id)
    INTO v_items, v_evidence_refs, v_page_count, v_last_visible_sequence
    FROM visible;

  RETURN jsonb_build_object(
    'schemaVersion', '1.0',
    'data', jsonb_build_object(
      'items', v_items,
      'nextCursor', CASE WHEN v_page_count > p_limit THEN v_last_visible_sequence::text ELSE NULL END
    ),
    'authority', 'SupabaseAuditLedger',
    'observedAt', v_observed_at,
    'freshness', 'fresh',
    'correlationId', p_correlation_id,
    'evidenceRefs', v_evidence_refs
  );
END;
$$;

REVOKE ALL ON FUNCTION console_audit.list_events(uuid, uuid, bigint, bigint, bigint, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_audit.list_events(uuid, uuid, bigint, bigint, bigint, integer, text) TO console_api;

CREATE OR REPLACE FUNCTION console_identity.resolve_browser_session(
  p_token_digest bytea,
  p_csrf_token_digest bytea,
  p_require_csrf boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_permissions text[];
BEGIN
  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE token_digest = p_token_digest;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  IF p_require_csrf AND (p_csrf_token_digest IS NULL OR v_session.csrf_token_digest <> p_csrf_token_digest) THEN
    RAISE EXCEPTION 'Console session CSRF validation failed' USING ERRCODE = '42501', DETAIL = 'CsrfRejected';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = v_session.subject_id;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT permission ORDER BY permission), ARRAY[]::text[])
    INTO v_permissions
    FROM console_identity.permission_grant
    WHERE subject_id = v_session.subject_id
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL;

  RETURN jsonb_build_object(
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'expiresAt', v_session.expires_at,
    'revokedAt', v_session.revoked_at,
    'authorityFresh', true,
    'permissions', to_jsonb(v_permissions),
    'permissionRevision', v_authority.permission_revision,
    'revokeEpoch', v_authority.revoke_epoch,
    'aal', v_session.aal
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.resolve_browser_session(bytea, bytea, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.resolve_browser_session(bytea, bytea, boolean) TO console_api;

CREATE OR REPLACE FUNCTION console_identity.revoke_browser_session(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_event console_audit.event;
  v_revoked_at timestamptz := statement_timestamp();
BEGIN
  IF length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid correlation id' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id
    FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_revoked_at THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref
    FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  UPDATE console_identity.browser_session
    SET revoked_at = v_revoked_at,
        revoke_reason = 'self-logout',
        last_seen_at = v_revoked_at
    WHERE session_id = v_session.session_id;

  v_event := console_audit.append_event_internal(
    NULL,
    p_correlation_id,
    p_actor_ref::text,
    'console.identity.session.revoke',
    'browser-session:' || v_session.session_id::text,
    'succeeded',
    'self-logout',
    jsonb_build_object(
      'sessionId', v_session.session_id,
      'permissionRevision', v_authority.permission_revision,
      'revokeEpoch', v_authority.revoke_epoch,
      'revokedAt', v_revoked_at
    )
  );

  RETURN jsonb_build_object(
    'sessionId', v_session.session_id,
    'revokedAt', v_revoked_at,
    'auditEventId', v_event.event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.revoke_browser_session(uuid, uuid, bigint, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.revoke_browser_session(uuid, uuid, bigint, bigint, text) TO console_api;

CREATE OR REPLACE FUNCTION console_identity.get_supabase_status(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_observed_at timestamptz := statement_timestamp();
  v_authority_table_count integer;
  v_rls_table_count integer;
  v_baseline_objects_present boolean;
  v_migration_count integer := 0;
  v_migration_chain_count integer := 0;
  v_migration_latest_global_id text;
  v_migration_latest_set_digest text;
  v_migration_latest_set_size integer;
  v_migration_state text;
  v_migration_reason text;
BEGIN
  IF length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid correlation id' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_observed_at THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = 'console.data_identity.read'
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::integer
    INTO v_authority_table_count, v_rls_table_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('console_identity', 'console_operation', 'console_audit', 'console_extension')
      AND c.relkind IN ('r', 'p');

  v_baseline_objects_present :=
    to_regclass('console_identity.browser_session') IS NOT NULL
    AND to_regclass('console_operation.operation') IS NOT NULL
    AND to_regclass('console_audit.event') IS NOT NULL
    AND to_regclass('console_extension.registry_connection') IS NOT NULL
    AND to_regprocedure('console_identity.resolve_browser_session(bytea,bytea,boolean)') IS NOT NULL
    AND to_regprocedure('console_operation.accept_operation(uuid,uuid,bigint,bigint,text,text,text,text,text,text,text,text,boolean,text,text,text,text,jsonb,jsonb)') IS NOT NULL
    AND to_regprocedure('console_extension.apply_install_registration(uuid,bigint,bigint,uuid,text,text,jsonb,text,text,text,text,bigint,boolean,text,text,text,text)') IS NOT NULL
    AND to_regprocedure('console_extension.record_install_observation(uuid,bigint,bigint,uuid,text,text,text,jsonb)') IS NOT NULL
    AND to_regprocedure('console_operation.verify_extension_operation(uuid,uuid,bigint,bigint,uuid,bigint,text,text)') IS NOT NULL;

  IF to_regclass('console_migration.applied_migration') IS NOT NULL THEN
    WITH ordered AS (
      SELECT global_id, predecessor_global_id,
             row_number() OVER (ORDER BY applied_sequence) AS ordinal,
             lag(global_id) OVER (ORDER BY applied_sequence) AS prior_global_id
      FROM console_migration.applied_migration
    )
    SELECT count(*)::integer,
           count(*) FILTER (
             WHERE (ordinal = 1 AND predecessor_global_id IS NULL)
                OR (ordinal > 1 AND predecessor_global_id = prior_global_id)
           )::integer
      INTO v_migration_count, v_migration_chain_count
      FROM ordered;

    SELECT global_id, migration_set_digest, migration_set_size
      INTO v_migration_latest_global_id, v_migration_latest_set_digest, v_migration_latest_set_size
      FROM console_migration.applied_migration
      ORDER BY applied_sequence DESC
      LIMIT 1;
  END IF;

  IF NOT v_baseline_objects_present THEN
    v_migration_state := 'Unknown';
    v_migration_reason := 'BaselineObjectsMissing';
  ELSIF v_migration_count = 0 THEN
    v_migration_state := 'Partial';
    v_migration_reason := 'MigrationLedgerMissing';
  ELSIF v_migration_chain_count <> v_migration_count OR v_migration_latest_set_size <> v_migration_count THEN
    v_migration_state := 'Blocked';
    v_migration_reason := 'MigrationLedgerInvalid';
  ELSE
    v_migration_state := 'Ready';
    v_migration_reason := NULL;
  END IF;

  RETURN jsonb_build_object(
    'schemaVersion', '1.0',
    'data', jsonb_build_object(
      'state', 'Degraded',
      'required', true,
      'components', jsonb_build_array(
        jsonb_build_object('component', 'database', 'state', 'Ready', 'authority', 'SupabasePostgreSQL', 'reasonCode', NULL),
        jsonb_build_object('component', 'auth', 'state', 'Unknown', 'authority', 'SupabaseAuth', 'reasonCode', 'LiveProbeUnavailable'),
        jsonb_build_object('component', 'dataApi', 'state', 'Unknown', 'authority', 'SupabasePostgREST', 'reasonCode', 'LiveProbeUnavailable'),
        jsonb_build_object('component', 'storage', 'state', 'Unknown', 'authority', 'SupabaseStorage', 'reasonCode', 'LiveProbeUnavailable'),
        jsonb_build_object(
          'component', 'migration',
          'state', v_migration_state,
          'authority', 'ConsoleMigrationLedger',
          'reasonCode', v_migration_reason,
          'baselineRevision', v_migration_latest_global_id,
          'setDigest', v_migration_latest_set_digest,
          'migrationCount', v_migration_count
        ),
        jsonb_build_object(
          'component', 'rls',
          'state', CASE WHEN v_authority_table_count = 11 AND v_rls_table_count = v_authority_table_count THEN 'Ready' ELSE 'Blocked' END,
          'authority', 'PostgreSQLCatalog',
          'reasonCode', CASE WHEN v_authority_table_count = 11 AND v_rls_table_count = v_authority_table_count THEN NULL ELSE 'RlsCoverageIncomplete' END,
          'authorityTables', v_authority_table_count,
          'protectedTables', v_rls_table_count
        ),
        jsonb_build_object('component', 'backup', 'state', 'Unknown', 'authority', 'RecoveryOwner', 'reasonCode', 'EvidenceUnavailable'),
        jsonb_build_object('component', 'restore', 'state', 'Unknown', 'authority', 'RecoveryOwner', 'reasonCode', 'EvidenceUnavailable')
      )
    ),
    'authority', 'Supabase',
    'observedAt', v_observed_at,
    'freshness', 'fresh',
    'correlationId', p_correlation_id,
    'evidenceRefs', jsonb_build_array(
      'supabase-postgresql:connected',
      CASE
        WHEN v_migration_state = 'Ready' THEN 'migration-ledger:' || v_migration_latest_global_id || '@' || v_migration_latest_set_digest
        WHEN v_baseline_objects_present THEN 'baseline-schema:objects-present-ledger-missing'
        ELSE 'baseline-schema:objects-missing'
      END,
      'rls:' || v_rls_table_count::text || '/' || v_authority_table_count::text
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.get_supabase_status(uuid, uuid, bigint, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.get_supabase_status(uuid, uuid, bigint, bigint, text) TO console_api;

CREATE OR REPLACE FUNCTION console_operation.accept_operation(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_required_permission text,
  p_action_id text,
  p_action_version text,
  p_target_ref text,
  p_payload_digest text,
  p_risk text,
  p_reason text,
  p_plan_revision text,
  p_approval_required boolean,
  p_idempotency_key text,
  p_correlation_id text,
  p_source_revision text DEFAULT NULL,
  p_owner_ref text DEFAULT NULL,
  p_expected_postcondition jsonb DEFAULT NULL,
  p_execution_plan jsonb DEFAULT NULL
)
RETURNS TABLE(operation_record jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_operation console_operation.operation;
  v_request_digest text;
  v_outbox_payload jsonb;
  v_outbox_event_type text;
BEGIN
  IF p_payload_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid payload digest' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  IF p_risk NOT IN ('R0', 'R1', 'R2', 'R3') THEN
    RAISE EXCEPTION 'invalid operation risk' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  IF p_risk <> 'R0' AND length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'operation reason is required' USING ERRCODE = '22023', DETAIL = 'ReasonRequired';
  END IF;

  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id
    FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref
    FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = p_required_permission
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;
  IF p_risk IN ('R2', 'R3') AND v_session.aal <> 'aal2' THEN
    RAISE EXCEPTION 'recent aal2 is required' USING ERRCODE = '42501', DETAIL = 'StepUpRequired';
  END IF;

  v_request_digest := 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'actionId', p_action_id,
    'actionVersion', p_action_version,
    'targetRef', p_target_ref,
    'requiredPermission', p_required_permission,
    'payloadDigest', p_payload_digest,
    'risk', p_risk,
    'reason', COALESCE(p_reason, ''),
    'planRevision', p_plan_revision,
    'approvalRequired', p_approval_required,
    'sourceRevision', p_source_revision,
    'ownerRef', p_owner_ref,
    'expectedPostcondition', p_expected_postcondition,
    'executionPlan', p_execution_plan
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_ref::text || ':' || p_idempotency_key, 0));
  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE actor_ref = p_actor_ref AND idempotency_key = p_idempotency_key
    FOR UPDATE;
  IF FOUND THEN
    IF v_operation.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'idempotency key was already used for a different request'
        USING ERRCODE = '23505', DETAIL = 'IdempotencyMismatch';
    END IF;
    RETURN QUERY SELECT to_jsonb(v_operation), true;
    RETURN;
  END IF;

  INSERT INTO console_operation.operation(
    action_id, action_version, actor_ref, target_ref, required_permission,
    payload_digest, request_digest, risk, reason, aal, permission_revision,
    plan_revision, approval_required, idempotency_key, correlation_id,
    source_revision, owner_ref, execution_plan, state, expected_postcondition
  ) VALUES (
    p_action_id, p_action_version, p_actor_ref, p_target_ref, p_required_permission,
    p_payload_digest, v_request_digest, p_risk, COALESCE(p_reason, ''), v_session.aal,
    v_authority.permission_revision, p_plan_revision, p_approval_required,
    p_idempotency_key, p_correlation_id, p_source_revision, p_owner_ref, p_execution_plan,
    CASE WHEN p_approval_required THEN 'Planned' ELSE 'Authorized' END,
    p_expected_postcondition
  ) RETURNING * INTO v_operation;

  v_outbox_event_type := CASE
    WHEN v_operation.approval_required THEN 'OperationAwaitingApproval'
    ELSE 'OperationReadyForDispatch'
  END;
  v_outbox_payload := jsonb_build_object(
    'schemaVersion', '1.0',
    'eventType', v_outbox_event_type,
    'operationId', v_operation.operation_id,
    'actionId', v_operation.action_id,
    'actionVersion', v_operation.action_version,
    'targetRef', v_operation.target_ref,
    'payloadDigest', v_operation.payload_digest,
    'risk', v_operation.risk,
    'approvalRequired', v_operation.approval_required,
    'correlationId', v_operation.correlation_id
  );
  INSERT INTO console_operation.outbox(operation_id, event_type, payload, payload_digest)
  VALUES (v_operation.operation_id, v_outbox_event_type, v_outbox_payload, v_operation.payload_digest);

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    v_operation.correlation_id,
    v_operation.actor_ref::text,
    v_operation.action_id,
    v_operation.target_ref,
    'accepted',
    v_operation.reason,
    jsonb_build_object(
      'requestDigest', v_operation.request_digest,
      'payloadDigest', v_operation.payload_digest,
      'risk', v_operation.risk,
      'aal', v_operation.aal,
      'permissionRevision', v_operation.permission_revision,
      'approvalRequired', v_operation.approval_required
    )
  );

  UPDATE console_identity.browser_session
    SET last_seen_at = statement_timestamp()
    WHERE session_id = v_session.session_id;

  RETURN QUERY SELECT to_jsonb(v_operation), false;
END;
$$;

REVOKE ALL ON FUNCTION console_operation.accept_operation(
  uuid, uuid, bigint, bigint, text, text, text, text, text, text, text, text,
  boolean, text, text, text, text, jsonb, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.accept_operation(
  uuid, uuid, bigint, bigint, text, text, text, text, text, text, text, text,
  boolean, text, text, text, text, jsonb, jsonb
) TO console_api;

CREATE OR REPLACE FUNCTION console_operation.approve_operation(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_operation_id uuid,
  p_expected_state_version bigint,
  p_reason text,
  p_approval_revision text,
  p_confirmation text,
  p_idempotency_key text,
  p_correlation_id text
)
RETURNS TABLE(operation_record jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_initiator_authority console_identity.subject_authority;
  v_operation console_operation.operation;
  v_approval console_operation.approval;
  v_request_digest text;
  v_outbox_payload jsonb;
BEGIN
  IF p_expected_state_version < 0
      OR length(btrim(COALESCE(p_reason, ''))) < 3
      OR length(COALESCE(p_approval_revision, '')) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid approval request' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id
    FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref
    FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = 'console.operation.approve'
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;
  IF v_session.aal <> 'aal2' THEN
    RAISE EXCEPTION 'recent aal2 is required' USING ERRCODE = '42501', DETAIL = 'StepUpRequired';
  END IF;

  v_request_digest := 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'operationId', p_operation_id,
    'expectedStateVersion', p_expected_state_version,
    'reason', btrim(p_reason),
    'approvalRevision', p_approval_revision,
    'confirmation', p_confirmation
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_ref::text || ':' || p_idempotency_key, 0));
  SELECT * INTO v_approval
    FROM console_operation.approval
    WHERE actor_ref = p_actor_ref AND idempotency_key = p_idempotency_key
    FOR UPDATE;
  IF FOUND THEN
    IF v_approval.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'idempotency key was already used for a different approval'
        USING ERRCODE = '23505', DETAIL = 'IdempotencyMismatch';
    END IF;
    SELECT * INTO v_operation
      FROM console_operation.operation
      WHERE operation_id = v_approval.operation_id;
    RETURN QUERY SELECT to_jsonb(v_operation), true;
    RETURN;
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation was not found' USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  IF v_operation.actor_ref = p_actor_ref THEN
    RAISE EXCEPTION 'operation initiator cannot approve the same operation'
      USING ERRCODE = '42501', DETAIL = 'SelfApprovalDenied';
  END IF;
  SELECT * INTO v_initiator_authority
    FROM console_identity.subject_authority
    WHERE subject_id = v_operation.actor_ref
    FOR SHARE;
  IF NOT FOUND OR v_initiator_authority.person_ref = v_authority.person_ref THEN
    RAISE EXCEPTION 'operation initiator and approver must be different people'
      USING ERRCODE = '42501', DETAIL = 'SelfApprovalDenied';
  END IF;
  IF NOT v_operation.approval_required THEN
    RAISE EXCEPTION 'operation does not require approval' USING ERRCODE = '22023', DETAIL = 'ApprovalNotRequired';
  END IF;
  IF v_operation.approval_revision IS NOT NULL OR v_operation.plan_revision <> p_approval_revision THEN
    RAISE EXCEPTION 'approval policy revision is stale' USING ERRCODE = '40001', DETAIL = 'StaleRevision';
  END IF;
  IF v_operation.state_version <> p_expected_state_version THEN
    RAISE EXCEPTION 'operation state version changed' USING ERRCODE = '40001', DETAIL = 'StaleOperationVersion';
  END IF;
  IF v_operation.state <> 'Planned' THEN
    RAISE EXCEPTION 'operation is not awaiting approval' USING ERRCODE = '55000', DETAIL = 'InvalidOperationState';
  END IF;

  INSERT INTO console_operation.approval(
    operation_id, actor_ref, reason, approval_revision, request_digest,
    permission_revision, revoke_epoch, aal, expected_state_version,
    idempotency_key, correlation_id
  ) VALUES (
    v_operation.operation_id, p_actor_ref, btrim(p_reason), p_approval_revision,
    v_request_digest, v_authority.permission_revision, v_authority.revoke_epoch,
    v_session.aal, p_expected_state_version, p_idempotency_key, p_correlation_id
  ) RETURNING * INTO v_approval;

  UPDATE console_operation.operation
    SET state = 'Authorized',
        state_version = state_version + 1,
        approval_revision = p_approval_revision,
        updated_at = statement_timestamp()
    WHERE operation_id = v_operation.operation_id
    RETURNING * INTO v_operation;

  v_outbox_payload := jsonb_build_object(
    'schemaVersion', '1.0',
    'eventType', 'OperationReadyForDispatch',
    'operationId', v_operation.operation_id,
    'approvalId', v_approval.approval_id,
    'approverRef', v_approval.actor_ref,
    'approvalRevision', v_approval.approval_revision,
    'state', v_operation.state,
    'stateVersion', v_operation.state_version,
    'correlationId', p_correlation_id
  );
  INSERT INTO console_operation.outbox(operation_id, event_type, payload, payload_digest)
  VALUES (v_operation.operation_id, 'OperationReadyForDispatch', v_outbox_payload, v_request_digest);

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    p_correlation_id,
    p_actor_ref::text,
    'console.operation.approve',
    v_operation.target_ref,
    'accepted',
    btrim(p_reason),
    jsonb_build_object(
      'approvalId', v_approval.approval_id,
      'approvalRevision', v_approval.approval_revision,
      'requestDigest', v_approval.request_digest,
      'permissionRevision', v_approval.permission_revision,
      'revokeEpoch', v_approval.revoke_epoch,
      'aal', v_approval.aal,
      'initiatorRef', v_operation.actor_ref,
      'distinctPerson', true,
      'stateVersion', v_operation.state_version
    )
  );

  UPDATE console_identity.browser_session
    SET last_seen_at = statement_timestamp()
    WHERE session_id = v_session.session_id;

  RETURN QUERY SELECT to_jsonb(v_operation), false;
END;
$$;

REVOKE ALL ON FUNCTION console_operation.approve_operation(
  uuid, uuid, bigint, bigint, uuid, bigint, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.approve_operation(
  uuid, uuid, bigint, bigint, uuid, bigint, text, text, text, text, text
) TO console_api;

CREATE OR REPLACE FUNCTION console_operation.claim_owner_operation(
  p_worker_id uuid,
  p_owner_ref text,
  p_supported_actions text[],
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_audit
AS $$
DECLARE
  v_outbox console_operation.outbox;
  v_operation console_operation.operation;
  v_initial_state text;
BEGIN
  IF p_worker_id IS NULL OR length(btrim(COALESCE(p_owner_ref, ''))) < 1
      OR COALESCE(array_length(p_supported_actions, 1), 0) < 1
      OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid owner claim request' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  IF p_owner_ref <> 'C_EXT'
      OR p_supported_actions <> ARRAY[
        'console.extension.install', 'console.extension.remove', 'console.extension.revocation.create'
      ]::text[] THEN
    RAISE EXCEPTION 'worker role is outside its typed owner capability'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  SELECT dispatch.* INTO v_outbox
    FROM console_operation.outbox dispatch
    JOIN console_operation.operation operation_record USING (operation_id)
    WHERE dispatch.event_type IN (
      'OperationReadyForDispatch',
      'ExtensionInstallObservationRequested',
      'ExtensionRemovalObservationRequested'
    )
      AND dispatch.delivered_at IS NULL
      AND (dispatch.lease_expires_at IS NULL OR dispatch.lease_expires_at <= statement_timestamp())
      AND operation_record.owner_ref = p_owner_ref
      AND operation_record.action_id = ANY(p_supported_actions)
      AND (
        (dispatch.event_type = 'OperationReadyForDispatch'
          AND operation_record.state IN ('Authorized', 'Submitted', 'Reconciling', 'Unknown'))
        OR (dispatch.event_type = 'ExtensionInstallObservationRequested'
          AND operation_record.action_id = 'console.extension.install'
          AND operation_record.state = 'Applied')
        OR (dispatch.event_type = 'ExtensionRemovalObservationRequested'
          AND operation_record.action_id = 'console.extension.remove'
          AND operation_record.state = 'Applied')
      )
    ORDER BY dispatch.outbox_id
    FOR UPDATE OF dispatch SKIP LOCKED
    LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = v_outbox.operation_id
    FOR UPDATE;
  v_initial_state := v_operation.state;

  UPDATE console_operation.outbox
    SET claim_owner = p_worker_id,
        claim_epoch = claim_epoch + 1,
        claimed_at = statement_timestamp(),
        lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
        attempt_count = attempt_count + 1
    WHERE outbox_id = v_outbox.outbox_id
    RETURNING * INTO v_outbox;

  IF v_outbox.event_type = 'OperationReadyForDispatch' AND v_operation.state = 'Authorized' THEN
    UPDATE console_operation.operation
      SET state = 'Submitted', state_version = state_version + 1,
          updated_at = statement_timestamp()
      WHERE operation_id = v_operation.operation_id
      RETURNING * INTO v_operation;
  END IF;

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    v_operation.correlation_id,
    p_worker_id::text,
    'console.operation.dispatch.claim',
    v_operation.target_ref,
    'accepted',
    '',
    jsonb_build_object(
      'ownerRef', p_owner_ref,
      'outboxId', v_outbox.outbox_id,
      'claimEpoch', v_outbox.claim_epoch,
      'attemptCount', v_outbox.attempt_count,
      'leaseExpiresAt', v_outbox.lease_expires_at,
      'resumeMode', CASE WHEN v_initial_state = 'Authorized' THEN 'apply' ELSE 'reconcile' END,
      'dispatchPhase', CASE WHEN v_outbox.event_type IN (
        'ExtensionInstallObservationRequested', 'ExtensionRemovalObservationRequested'
      ) THEN 'observe' ELSE 'apply' END
    )
  );

  RETURN jsonb_build_object(
    'schemaVersion', '1.0',
    'outboxId', v_outbox.outbox_id,
    'operationId', v_operation.operation_id,
    'actionId', v_operation.action_id,
    'actionVersion', v_operation.action_version,
    'actorRef', v_operation.actor_ref,
    'reason', v_operation.reason,
    'targetRef', v_operation.target_ref,
    'payloadDigest', v_operation.payload_digest,
    'executionPlan', v_operation.execution_plan,
    'ownerRef', v_operation.owner_ref,
    'claimEpoch', v_outbox.claim_epoch,
    'leaseExpiresAt', v_outbox.lease_expires_at,
    'attemptCount', v_outbox.attempt_count,
    'resumeMode', CASE WHEN v_initial_state = 'Authorized' THEN 'apply' ELSE 'reconcile' END,
    'dispatchPhase', CASE WHEN v_outbox.event_type IN (
      'ExtensionInstallObservationRequested', 'ExtensionRemovalObservationRequested'
    ) THEN 'observe' ELSE 'apply' END,
    'dispatchPayload', v_outbox.payload,
    'state', v_operation.state,
    'stateVersion', v_operation.state_version,
    'correlationId', v_operation.correlation_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_operation.renew_owner_claim(
  p_worker_id uuid,
  p_outbox_id bigint,
  p_claim_epoch bigint,
  p_lease_seconds integer
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation
AS $$
DECLARE
  v_lease_expires_at timestamptz;
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid owner lease duration' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  UPDATE console_operation.outbox
    SET lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds)
    WHERE outbox_id = p_outbox_id
      AND claim_owner = p_worker_id
      AND claim_epoch = p_claim_epoch
      AND delivered_at IS NULL
      AND lease_expires_at > statement_timestamp()
      AND EXISTS (
        SELECT 1 FROM console_operation.operation operation_record
        WHERE operation_record.operation_id = outbox.operation_id
          AND operation_record.owner_ref = 'C_EXT'
          AND operation_record.action_id IN (
            'console.extension.install', 'console.extension.remove', 'console.extension.revocation.create'
          )
      )
    RETURNING lease_expires_at INTO v_lease_expires_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner claim is stale or expired' USING ERRCODE = '40001', DETAIL = 'StaleClaim';
  END IF;
  RETURN v_lease_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION console_operation.claim_owner_operation(uuid, text, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.claim_owner_operation(uuid, text, text[], integer)
  TO console_extension_controller;
REVOKE ALL ON FUNCTION console_operation.renew_owner_claim(uuid, bigint, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.renew_owner_claim(uuid, bigint, bigint, integer)
  TO console_extension_controller;

CREATE OR REPLACE FUNCTION console_extension.apply_revocation(
  p_worker_id uuid,
  p_outbox_id bigint,
  p_claim_epoch bigint,
  p_operation_id uuid,
  p_target_ref text,
  p_payload_digest text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_extension, console_audit
AS $$
DECLARE
  v_outbox console_operation.outbox;
  v_operation console_operation.operation;
  v_evidence jsonb;
  v_evidence_digest text;
  v_inserted boolean;
  v_row_count bigint;
BEGIN
  SELECT * INTO v_outbox
    FROM console_operation.outbox
    WHERE outbox_id = p_outbox_id
    FOR UPDATE;
  IF NOT FOUND OR v_outbox.operation_id <> p_operation_id
      OR v_outbox.event_type <> 'OperationReadyForDispatch'
      OR v_outbox.claim_owner <> p_worker_id
      OR v_outbox.claim_epoch <> p_claim_epoch
      OR v_outbox.delivered_at IS NOT NULL
      OR v_outbox.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'owner claim is stale or expired' USING ERRCODE = '40001', DETAIL = 'StaleClaim';
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR UPDATE;
  IF NOT FOUND OR v_operation.owner_ref <> 'C_EXT'
      OR v_operation.action_id <> 'console.extension.revocation.create'
      OR v_operation.action_version <> '1.0'
      OR v_operation.target_ref <> p_target_ref
      OR v_operation.payload_digest <> p_payload_digest
      OR v_operation.state NOT IN ('Submitted', 'Reconciling', 'Unknown') THEN
    RAISE EXCEPTION 'claim does not match the typed Extension action'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  IF v_operation.state <> 'Reconciling' THEN
    UPDATE console_operation.operation
      SET state = 'Reconciling', state_version = state_version + 1,
          updated_at = statement_timestamp()
      WHERE operation_id = v_operation.operation_id
      RETURNING * INTO v_operation;
  END IF;

  INSERT INTO console_extension.revocation(
    image_ref, operation_id, payload_digest, action_version, claim_epoch
  ) VALUES (
    v_operation.target_ref, v_operation.operation_id, v_operation.payload_digest,
    v_operation.action_version, p_claim_epoch
  ) ON CONFLICT (image_ref) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  v_inserted := v_row_count = 1;

  v_evidence := jsonb_build_object(
    'schemaVersion', '1.0',
    'authority', 'ConsoleExtensionRevocation',
    'imageRef', v_operation.target_ref,
    'operationId', v_operation.operation_id,
    'claimEpoch', p_claim_epoch,
    'inserted', v_inserted,
    'postcondition', 'RevocationPresent'
  );
  v_evidence_digest := 'sha256:' || encode(sha256(convert_to(v_evidence::text, 'UTF8')), 'hex');

  INSERT INTO console_operation.execution_receipt(
    operation_id, owner_ref, worker_id, claim_epoch, phase, evidence, evidence_digest
  ) VALUES (
    v_operation.operation_id, 'C_EXT', p_worker_id, p_claim_epoch,
    'Applied', v_evidence, v_evidence_digest
  );

  UPDATE console_operation.operation
    SET state = 'Applied', state_version = state_version + 1,
        observed_postcondition = v_evidence,
        updated_at = statement_timestamp()
    WHERE operation_id = v_operation.operation_id
    RETURNING * INTO v_operation;

  UPDATE console_operation.outbox
    SET delivered_at = statement_timestamp()
    WHERE outbox_id = v_outbox.outbox_id;

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    v_operation.correlation_id,
    p_worker_id::text,
    v_operation.action_id,
    v_operation.target_ref,
    'succeeded',
    '',
    jsonb_build_object(
      'ownerRef', 'C_EXT',
      'claimEpoch', p_claim_epoch,
      'state', v_operation.state,
      'stateVersion', v_operation.state_version,
      'evidenceDigest', v_evidence_digest
    )
  );

  RETURN jsonb_build_object(
    'operationRecord', to_jsonb(v_operation),
    'evidenceDigest', v_evidence_digest,
    'inserted', v_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.apply_revocation(uuid, bigint, bigint, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.apply_revocation(uuid, bigint, bigint, uuid, text, text)
  TO console_extension_controller;

CREATE OR REPLACE FUNCTION console_extension.assert_install_not_revoked(
  p_worker_id uuid,
  p_outbox_id bigint,
  p_claim_epoch bigint,
  p_operation_id uuid,
  p_target_ref text,
  p_payload_digest text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_extension
AS $$
DECLARE
  v_outbox console_operation.outbox;
  v_operation console_operation.operation;
BEGIN
  IF COALESCE(p_target_ref, '') !~ '^ghcr\.io/opensphere-platform/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$'
      OR COALESCE(p_payload_digest, '') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid Extension install revocation check'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_outbox
    FROM console_operation.outbox
    WHERE outbox_id = p_outbox_id
    FOR SHARE;
  IF NOT FOUND OR v_outbox.operation_id <> p_operation_id
      OR v_outbox.event_type NOT IN ('OperationReadyForDispatch', 'ExtensionInstallObservationRequested')
      OR v_outbox.claim_owner <> p_worker_id
      OR v_outbox.claim_epoch <> p_claim_epoch
      OR v_outbox.delivered_at IS NOT NULL
      OR v_outbox.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'owner claim is stale or expired'
      USING ERRCODE = '40001', DETAIL = 'StaleClaim';
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR SHARE;
  IF NOT FOUND OR v_operation.owner_ref <> 'C_EXT'
      OR v_operation.action_id <> 'console.extension.install'
      OR v_operation.action_version <> '1.0'
      OR v_operation.target_ref <> p_target_ref
      OR v_operation.payload_digest <> p_payload_digest
      OR NOT (
        (v_outbox.event_type = 'OperationReadyForDispatch'
          AND v_operation.state IN ('Submitted', 'Reconciling', 'Unknown'))
        OR (v_outbox.event_type = 'ExtensionInstallObservationRequested'
          AND v_operation.state = 'Applied')
      ) THEN
    RAISE EXCEPTION 'revocation check does not match the typed Extension install action'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM console_extension.revocation
    WHERE image_ref = p_target_ref
  ) THEN
    RAISE EXCEPTION 'exact Extension image digest is revoked'
      USING ERRCODE = '55000', DETAIL = 'ImageRevoked';
  END IF;

  RETURN jsonb_build_object(
    'image', p_target_ref,
    'revoked', false,
    'checkedAt', statement_timestamp()
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.assert_install_not_revoked(
  uuid, bigint, bigint, uuid, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.assert_install_not_revoked(
  uuid, bigint, bigint, uuid, text, text
) TO console_extension_controller;

CREATE OR REPLACE FUNCTION console_extension.apply_install_registration(
  p_worker_id uuid,
  p_outbox_id bigint,
  p_claim_epoch bigint,
  p_operation_id uuid,
  p_target_ref text,
  p_payload_digest text,
  p_execution_plan jsonb,
  p_registration_name text,
  p_registration_uid text,
  p_registration_resource_version text,
  p_package_resource_version text,
  p_package_generation bigint,
  p_created boolean,
  p_manifest_digest text,
  p_source_revision text,
  p_compatibility_version text,
  p_key_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_extension, console_audit
AS $$
DECLARE
  v_outbox console_operation.outbox;
  v_operation console_operation.operation;
  v_evidence jsonb;
  v_evidence_digest text;
  v_observation_payload jsonb;
  v_observation_payload_digest text;
BEGIN
  IF p_execution_plan IS NULL OR jsonb_typeof(p_execution_plan) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_execution_plan)) <> 5
      OR p_execution_plan->>'schemaVersion' <> '1.0'
      OR p_execution_plan->>'authority' <> 'OpenSphereRegistry'
      OR COALESCE(p_execution_plan->>'descriptorId', '') !~ '^extension\.[a-z0-9][a-z0-9-]{0,62}$'
      OR COALESCE(p_execution_plan->>'catalogRevision', '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_execution_plan->>'image', '') !~ '^ghcr\.io/opensphere-platform/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$'
      OR COALESCE(p_registration_name, '') !~ '^[a-z0-9][a-z0-9-]{0,62}$'
      OR p_registration_name <> substring(p_execution_plan->>'descriptorId' FROM 11)
      OR length(COALESCE(p_registration_uid, '')) NOT BETWEEN 1 AND 128
      OR COALESCE(p_registration_resource_version, '') !~ '^[0-9A-Za-z._:-]{1,128}$'
      OR COALESCE(p_package_resource_version, '') !~ '^[0-9A-Za-z._:-]{1,128}$'
      OR COALESCE(p_package_generation, 0) < 1
      OR p_created IS NULL
      OR COALESCE(p_manifest_digest, '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_source_revision, '') !~ '^[0-9a-f]{40}$'
      OR COALESCE(p_compatibility_version, '') !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
      OR length(COALESCE(p_key_id, '')) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'invalid Extension install evidence' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_outbox
    FROM console_operation.outbox
    WHERE outbox_id = p_outbox_id
    FOR UPDATE;
  IF NOT FOUND OR v_outbox.operation_id <> p_operation_id
      OR v_outbox.event_type <> 'OperationReadyForDispatch'
      OR v_outbox.claim_owner <> p_worker_id
      OR v_outbox.claim_epoch <> p_claim_epoch
      OR v_outbox.delivered_at IS NOT NULL
      OR v_outbox.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'owner claim is stale or expired' USING ERRCODE = '40001', DETAIL = 'StaleClaim';
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR UPDATE;
  IF NOT FOUND OR v_operation.owner_ref <> 'C_EXT'
      OR v_operation.action_id <> 'console.extension.install'
      OR v_operation.action_version <> '1.0'
      OR v_operation.target_ref <> p_target_ref
      OR v_operation.payload_digest <> p_payload_digest
      OR v_operation.execution_plan IS DISTINCT FROM p_execution_plan
      OR p_execution_plan->>'image' <> p_target_ref
      OR v_operation.state NOT IN ('Submitted', 'Reconciling', 'Unknown') THEN
    RAISE EXCEPTION 'claim does not match the typed Extension install action'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM console_extension.revocation
    WHERE image_ref = p_target_ref
  ) THEN
    RAISE EXCEPTION 'exact Extension image digest is revoked before install receipt'
      USING ERRCODE = '55000', DETAIL = 'ImageRevoked';
  END IF;

  IF v_operation.state <> 'Reconciling' THEN
    UPDATE console_operation.operation
      SET state = 'Reconciling', state_version = state_version + 1,
          updated_at = statement_timestamp()
      WHERE operation_id = v_operation.operation_id
      RETURNING * INTO v_operation;
  END IF;

  v_evidence := jsonb_build_object(
    'schemaVersion', '1.0',
    'authority', 'KubernetesUIPluginRegistration',
    'operationId', v_operation.operation_id,
    'descriptorId', p_execution_plan->>'descriptorId',
    'catalogRevision', p_execution_plan->>'catalogRevision',
    'image', p_execution_plan->>'image',
    'packageResourceVersion', p_package_resource_version,
    'packageGeneration', p_package_generation,
    'manifestDigest', p_manifest_digest,
    'sourceRevision', p_source_revision,
    'compatibilityVersion', p_compatibility_version,
    'keyId', p_key_id,
    'registrationName', p_registration_name,
    'registrationUid', p_registration_uid,
    'registrationResourceVersion', p_registration_resource_version,
    'claimEpoch', p_claim_epoch,
    'created', p_created,
    'postcondition', 'RegistrationPresent'
  );
  v_evidence_digest := 'sha256:' || encode(sha256(convert_to(v_evidence::text, 'UTF8')), 'hex');

  INSERT INTO console_operation.execution_receipt(
    operation_id, owner_ref, worker_id, claim_epoch, phase, evidence, evidence_digest
  ) VALUES (
    v_operation.operation_id, 'C_EXT', p_worker_id, p_claim_epoch,
    'Applied', v_evidence, v_evidence_digest
  );
  UPDATE console_operation.operation
    SET state = 'Applied', state_version = state_version + 1,
        observed_postcondition = v_evidence,
        updated_at = statement_timestamp()
    WHERE operation_id = v_operation.operation_id
    RETURNING * INTO v_operation;
  UPDATE console_operation.outbox
    SET delivered_at = statement_timestamp()
    WHERE outbox_id = v_outbox.outbox_id;
  v_observation_payload := jsonb_build_object(
    'schemaVersion', '1.0',
    'eventType', 'ExtensionInstallObservationRequested',
    'operationId', v_operation.operation_id,
    'descriptorId', p_execution_plan->>'descriptorId',
    'image', p_execution_plan->>'image',
    'packageResourceVersion', p_package_resource_version,
    'packageGeneration', p_package_generation,
    'manifestDigest', p_manifest_digest,
    'sourceRevision', p_source_revision,
    'compatibilityVersion', p_compatibility_version,
    'keyId', p_key_id,
    'registrationName', p_registration_name,
    'registrationUid', p_registration_uid,
    'appliedReceiptDigest', v_evidence_digest
  );
  v_observation_payload_digest := 'sha256:' || encode(
    sha256(convert_to(v_observation_payload::text, 'UTF8')), 'hex'
  );
  INSERT INTO console_operation.outbox(operation_id, event_type, payload, payload_digest)
  VALUES (
    v_operation.operation_id, 'ExtensionInstallObservationRequested',
    v_observation_payload, v_observation_payload_digest
  );
  PERFORM console_audit.append_event_internal(
    v_operation.operation_id, v_operation.correlation_id, p_worker_id::text,
    v_operation.action_id, v_operation.target_ref, 'succeeded', '',
    jsonb_build_object(
      'ownerRef', 'C_EXT', 'claimEpoch', p_claim_epoch,
      'state', v_operation.state, 'stateVersion', v_operation.state_version,
      'evidenceDigest', v_evidence_digest, 'postcondition', 'RegistrationPresent'
    )
  );
  RETURN jsonb_build_object(
    'operationRecord', to_jsonb(v_operation),
    'evidenceDigest', v_evidence_digest,
    'registrationName', p_registration_name,
    'created', p_created
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.apply_install_registration(
  uuid, bigint, bigint, uuid, text, text, jsonb, text, text, text, text, bigint, boolean,
  text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.apply_install_registration(
  uuid, bigint, bigint, uuid, text, text, jsonb, text, text, text, text, bigint, boolean,
  text, text, text, text
) TO console_extension_controller;

CREATE OR REPLACE FUNCTION console_extension.apply_remove_registration(
  p_worker_id uuid,
  p_outbox_id bigint,
  p_claim_epoch bigint,
  p_operation_id uuid,
  p_target_ref text,
  p_payload_digest text,
  p_registration_name text,
  p_registration_uid text,
  p_registration_resource_version_before text,
  p_registration_resource_version text,
  p_registration_generation bigint,
  p_package_resource_version text,
  p_package_generation bigint,
  p_package_scope text,
  p_changed boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_extension, console_audit
AS $$
DECLARE
  v_outbox console_operation.outbox;
  v_operation console_operation.operation;
  v_evidence jsonb;
  v_evidence_digest text;
  v_observation_payload jsonb;
  v_observation_payload_digest text;
BEGIN
  IF COALESCE(p_target_ref, '') !~ '^extension\.[a-z0-9][a-z0-9-]{0,62}$'
      OR COALESCE(p_registration_name, '') !~ '^[a-z0-9][a-z0-9-]{0,62}$'
      OR p_registration_name <> substring(p_target_ref FROM 11)
      OR length(COALESCE(p_registration_uid, '')) NOT BETWEEN 1 AND 128
      OR COALESCE(p_registration_resource_version_before, '') !~ '^[0-9A-Za-z._:-]{1,128}$'
      OR COALESCE(p_registration_resource_version, '') !~ '^[0-9A-Za-z._:-]{1,128}$'
      OR COALESCE(p_registration_generation, 0) < 1
      OR COALESCE(p_package_resource_version, '') !~ '^[0-9A-Za-z._:-]{1,128}$'
      OR COALESCE(p_package_generation, 0) < 1
      OR length(COALESCE(p_package_scope, '')) > 128
      OR COALESCE(p_package_scope, '') LIKE 'main-shell%'
      OR p_changed IS NULL THEN
    RAISE EXCEPTION 'invalid Extension removal evidence' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_outbox
    FROM console_operation.outbox
    WHERE outbox_id = p_outbox_id
    FOR UPDATE;
  IF NOT FOUND OR v_outbox.operation_id <> p_operation_id
      OR v_outbox.event_type <> 'OperationReadyForDispatch'
      OR v_outbox.claim_owner <> p_worker_id
      OR v_outbox.claim_epoch <> p_claim_epoch
      OR v_outbox.delivered_at IS NOT NULL
      OR v_outbox.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'owner claim is stale or expired' USING ERRCODE = '40001', DETAIL = 'StaleClaim';
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR UPDATE;
  IF NOT FOUND OR v_operation.owner_ref <> 'C_EXT'
      OR v_operation.action_id <> 'console.extension.remove'
      OR v_operation.action_version <> '1.0'
      OR v_operation.target_ref <> p_target_ref
      OR v_operation.payload_digest <> p_payload_digest
      OR v_operation.state NOT IN ('Submitted', 'Reconciling', 'Unknown') THEN
    RAISE EXCEPTION 'claim does not match the typed Extension removal action'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  IF v_operation.state <> 'Reconciling' THEN
    UPDATE console_operation.operation
      SET state = 'Reconciling', state_version = state_version + 1,
          updated_at = statement_timestamp()
      WHERE operation_id = v_operation.operation_id
      RETURNING * INTO v_operation;
  END IF;

  v_evidence := jsonb_build_object(
    'schemaVersion', '1.0',
    'authority', 'KubernetesUIPluginRegistration',
    'operationId', v_operation.operation_id,
    'descriptorId', p_target_ref,
    'registrationName', p_registration_name,
    'registrationUid', p_registration_uid,
    'registrationResourceVersionBefore', p_registration_resource_version_before,
    'registrationResourceVersion', p_registration_resource_version,
    'registrationGeneration', p_registration_generation,
    'packageResourceVersion', p_package_resource_version,
    'packageGeneration', p_package_generation,
    'packageScope', p_package_scope,
    'claimEpoch', p_claim_epoch,
    'changed', p_changed,
    'postcondition', 'RemovalRequested'
  );
  v_evidence_digest := 'sha256:' || encode(sha256(convert_to(v_evidence::text, 'UTF8')), 'hex');

  INSERT INTO console_operation.execution_receipt(
    operation_id, owner_ref, worker_id, claim_epoch, phase, evidence, evidence_digest
  ) VALUES (
    v_operation.operation_id, 'C_EXT', p_worker_id, p_claim_epoch,
    'Applied', v_evidence, v_evidence_digest
  );
  UPDATE console_operation.operation
    SET state = 'Applied', state_version = state_version + 1,
        observed_postcondition = v_evidence,
        updated_at = statement_timestamp()
    WHERE operation_id = v_operation.operation_id
    RETURNING * INTO v_operation;
  UPDATE console_operation.outbox
    SET delivered_at = statement_timestamp()
    WHERE outbox_id = v_outbox.outbox_id;

  v_observation_payload := jsonb_build_object(
    'schemaVersion', '1.0',
    'eventType', 'ExtensionRemovalObservationRequested',
    'operationId', v_operation.operation_id,
    'descriptorId', p_target_ref,
    'registrationName', p_registration_name,
    'registrationUid', p_registration_uid,
    'appliedReceiptDigest', v_evidence_digest
  );
  v_observation_payload_digest := 'sha256:' || encode(
    sha256(convert_to(v_observation_payload::text, 'UTF8')), 'hex'
  );
  INSERT INTO console_operation.outbox(operation_id, event_type, payload, payload_digest)
  VALUES (
    v_operation.operation_id, 'ExtensionRemovalObservationRequested',
    v_observation_payload, v_observation_payload_digest
  );
  PERFORM console_audit.append_event_internal(
    v_operation.operation_id, v_operation.correlation_id, p_worker_id::text,
    v_operation.action_id, v_operation.target_ref, 'succeeded', '',
    jsonb_build_object(
      'ownerRef', 'C_EXT', 'claimEpoch', p_claim_epoch,
      'state', v_operation.state, 'stateVersion', v_operation.state_version,
      'evidenceDigest', v_evidence_digest, 'postcondition', 'RemovalRequested'
    )
  );
  RETURN jsonb_build_object(
    'operationRecord', to_jsonb(v_operation),
    'evidenceDigest', v_evidence_digest,
    'registrationName', p_registration_name,
    'changed', p_changed
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.apply_remove_registration(
  uuid, bigint, bigint, uuid, text, text, text, text, text, text, bigint, text, bigint, text, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.apply_remove_registration(
  uuid, bigint, bigint, uuid, text, text, text, text, text, text, bigint, text, bigint, text, boolean
) TO console_extension_controller;

CREATE OR REPLACE FUNCTION console_extension.record_install_observation(
  p_worker_id uuid,
  p_outbox_id bigint,
  p_claim_epoch bigint,
  p_operation_id uuid,
  p_target_ref text,
  p_payload_digest text,
  p_applied_receipt_digest text,
  p_observation jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_extension, console_audit
AS $$
DECLARE
  v_outbox console_operation.outbox;
  v_operation console_operation.operation;
  v_applied_receipt console_operation.execution_receipt;
  v_evidence jsonb;
  v_evidence_digest text;
BEGIN
  IF p_observation IS NULL OR jsonb_typeof(p_observation) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation)) <> 6
      OR jsonb_typeof(p_observation->'package') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'package')) <> 8
      OR jsonb_typeof(p_observation->'registration') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'registration')) <> 7
      OR jsonb_typeof(p_observation->'workload') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'workload')) <> 1
      OR jsonb_typeof(p_observation->'verification') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'verification')) <> 4
      OR jsonb_typeof(p_observation->'serving') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'serving')) <> 3
      OR jsonb_typeof(p_observation->'revalidation') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'revalidation')) <> 1
      OR COALESCE(p_applied_receipt_digest, '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_observation->'package'->>'name', '') !~ '^[a-z0-9][a-z0-9-]{0,62}$'
      OR COALESCE(p_observation->'package'->>'resourceVersion', '') !~ '^[0-9A-Za-z._:-]{1,128}$'
      OR COALESCE(p_observation->'package'->>'generation', '') !~ '^[1-9][0-9]{0,17}$'
      OR COALESCE(p_observation->'package'->>'digest', '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_observation->'package'->>'manifestDigest', '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_observation->'package'->>'sourceRevision', '') !~ '^[0-9a-f]{40}$'
      OR COALESCE(p_observation->'package'->>'compatibilityVersion', '') !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
      OR length(COALESCE(p_observation->'package'->>'keyId', '')) NOT BETWEEN 1 AND 256
      OR COALESCE(p_observation->'registration'->>'name', '') !~ '^[a-z0-9][a-z0-9-]{0,62}$'
      OR length(COALESCE(p_observation->'registration'->>'uid', '')) NOT BETWEEN 1 AND 128
      OR COALESCE(p_observation->'registration'->>'resourceVersion', '') !~ '^[0-9A-Za-z._:-]{1,128}$'
      OR COALESCE(p_observation->'registration'->>'generation', '') !~ '^[1-9][0-9]{0,17}$'
      OR COALESCE(p_observation->'registration'->>'observedGeneration', '') !~ '^[1-9][0-9]{0,17}$'
      OR NOT (
        (p_observation->'registration'->>'desiredState' = 'Installed'
          AND p_observation->'registration'->>'phase' = 'Ready')
        OR (p_observation->'registration'->>'desiredState' = 'Enabled'
          AND p_observation->'registration'->>'phase' = 'Activated')
      )
      OR (p_observation->'registration'->>'observedGeneration')::bigint
        < (p_observation->'registration'->>'generation')::bigint
      OR p_observation->'workload'->>'phase' <> 'Ready'
      OR p_observation->'verification'->>'manifest' <> 'Verified'
      OR p_observation->'verification'->>'signature' <> 'Verified'
      OR p_observation->'verification'->>'entryDigest' <> 'Verified'
      OR p_observation->'verification'->>'permissions' <> 'Approved'
      OR p_observation->'serving'->>'phase' <> 'Current'
      OR COALESCE(p_observation->'serving'->>'digest', '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_observation->'serving'->>'manifestDigest', '') !~ '^sha256:[0-9a-f]{64}$'
      OR p_observation->'revalidation'->>'phase' <> 'Passed' THEN
    RAISE EXCEPTION 'invalid Extension install observation'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_outbox
    FROM console_operation.outbox
    WHERE outbox_id = p_outbox_id
    FOR UPDATE;
  IF NOT FOUND OR v_outbox.operation_id <> p_operation_id
      OR v_outbox.event_type <> 'ExtensionInstallObservationRequested'
      OR v_outbox.claim_owner <> p_worker_id
      OR v_outbox.claim_epoch <> p_claim_epoch
      OR v_outbox.delivered_at IS NOT NULL
      OR v_outbox.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'owner observation claim is stale or expired'
      USING ERRCODE = '40001', DETAIL = 'StaleClaim';
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR UPDATE;
  IF NOT FOUND OR v_operation.owner_ref <> 'C_EXT'
      OR v_operation.action_id <> 'console.extension.install'
      OR v_operation.action_version <> '1.0'
      OR v_operation.target_ref <> p_target_ref
      OR v_operation.payload_digest <> p_payload_digest
      OR v_operation.state <> 'Applied' THEN
    RAISE EXCEPTION 'observation claim does not match an Applied Extension install'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM console_extension.revocation
    WHERE image_ref = p_target_ref
  ) THEN
    RAISE EXCEPTION 'exact Extension image digest is revoked before ready observation'
      USING ERRCODE = '55000', DETAIL = 'ImageRevoked';
  END IF;

  SELECT * INTO v_applied_receipt
    FROM console_operation.execution_receipt
    WHERE operation_id = p_operation_id
      AND owner_ref = 'C_EXT'
      AND phase = 'Applied'
      AND evidence_digest = p_applied_receipt_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Applied install receipt is missing'
      USING ERRCODE = '55000', DETAIL = 'ObservationMissing';
  END IF;
  IF v_applied_receipt.evidence->>'authority' <> 'KubernetesUIPluginRegistration'
      OR v_applied_receipt.evidence->>'postcondition' <> 'RegistrationPresent'
      OR v_applied_receipt.evidence->>'operationId' <> p_operation_id::text
      OR v_applied_receipt.evidence->>'image' <> p_target_ref
      OR v_applied_receipt.evidence->>'registrationName' <> p_observation->'registration'->>'name'
      OR v_applied_receipt.evidence->>'registrationUid' <> p_observation->'registration'->>'uid'
      OR v_applied_receipt.evidence->>'packageResourceVersion' <> p_observation->'package'->>'resourceVersion'
      OR v_applied_receipt.evidence->>'packageGeneration' <> p_observation->'package'->>'generation'
      OR v_applied_receipt.evidence->>'manifestDigest' <> p_observation->'package'->>'manifestDigest'
      OR v_applied_receipt.evidence->>'sourceRevision' <> p_observation->'package'->>'sourceRevision'
      OR v_applied_receipt.evidence->>'compatibilityVersion' <> p_observation->'package'->>'compatibilityVersion'
      OR v_applied_receipt.evidence->>'keyId' <> p_observation->'package'->>'keyId'
      OR v_operation.execution_plan->>'descriptorId' <> ('extension.' || (p_observation->'package'->>'name'))
      OR split_part(p_target_ref, '@', 2) <> p_observation->'package'->>'digest'
      OR p_observation->'serving'->>'digest' <> p_observation->'package'->>'digest'
      OR p_observation->'serving'->>'manifestDigest' <> p_observation->'package'->>'manifestDigest' THEN
    RAISE EXCEPTION 'install observation does not match the Applied coordinates'
      USING ERRCODE = '55000', DETAIL = 'ObservationMismatch';
  END IF;

  v_evidence := jsonb_build_object(
    'schemaVersion', '1.0',
    'authority', 'KubernetesUIPluginRegistration',
    'operationId', p_operation_id,
    'image', p_target_ref,
    'appliedReceiptDigest', p_applied_receipt_digest,
    'package', p_observation->'package',
    'registration', p_observation->'registration',
    'workload', p_observation->'workload',
    'verification', p_observation->'verification',
    'serving', p_observation->'serving',
    'revalidation', p_observation->'revalidation',
    'postcondition', 'InstallReady'
  );
  v_evidence_digest := 'sha256:' || encode(sha256(convert_to(v_evidence::text, 'UTF8')), 'hex');

  INSERT INTO console_operation.execution_receipt(
    operation_id, owner_ref, worker_id, claim_epoch, phase, evidence, evidence_digest
  ) VALUES (
    p_operation_id, 'C_EXT', p_worker_id, p_claim_epoch,
    'Verified', v_evidence, v_evidence_digest
  );
  UPDATE console_operation.outbox
    SET delivered_at = statement_timestamp()
    WHERE outbox_id = p_outbox_id;
  PERFORM console_audit.append_event_internal(
    p_operation_id, v_operation.correlation_id, p_worker_id::text,
    'console.extension.install.observe', p_target_ref, 'succeeded', '',
    jsonb_build_object(
      'ownerRef', 'C_EXT', 'claimEpoch', p_claim_epoch,
      'evidenceDigest', v_evidence_digest, 'postcondition', 'InstallReady'
    )
  );
  RETURN jsonb_build_object(
    'operationRecord', to_jsonb(v_operation),
    'evidenceDigest', v_evidence_digest,
    'postcondition', 'InstallReady'
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.record_install_observation(
  uuid, bigint, bigint, uuid, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.record_install_observation(
  uuid, bigint, bigint, uuid, text, text, text, jsonb
) TO console_extension_controller;

CREATE OR REPLACE FUNCTION console_extension.record_remove_observation(
  p_worker_id uuid,
  p_outbox_id bigint,
  p_claim_epoch bigint,
  p_operation_id uuid,
  p_target_ref text,
  p_payload_digest text,
  p_applied_receipt_digest text,
  p_observation jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_extension, console_audit
AS $$
DECLARE
  v_outbox console_operation.outbox;
  v_operation console_operation.operation;
  v_applied_receipt console_operation.execution_receipt;
  v_evidence jsonb;
  v_evidence_digest text;
BEGIN
  IF p_observation IS NULL OR jsonb_typeof(p_observation) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation)) <> 1
      OR jsonb_typeof(p_observation->'registration') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'registration')) <> 3
      OR COALESCE(p_applied_receipt_digest, '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_observation->'registration'->>'name', '') !~ '^[a-z0-9][a-z0-9-]{0,62}$'
      OR length(COALESCE(p_observation->'registration'->>'uid', '')) NOT BETWEEN 1 AND 128
      OR p_observation->'registration'->>'phase' <> 'Absent' THEN
    RAISE EXCEPTION 'invalid Extension removal observation'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_outbox
    FROM console_operation.outbox
    WHERE outbox_id = p_outbox_id
    FOR UPDATE;
  IF NOT FOUND OR v_outbox.operation_id <> p_operation_id
      OR v_outbox.event_type <> 'ExtensionRemovalObservationRequested'
      OR v_outbox.claim_owner <> p_worker_id
      OR v_outbox.claim_epoch <> p_claim_epoch
      OR v_outbox.delivered_at IS NOT NULL
      OR v_outbox.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'owner removal observation claim is stale or expired'
      USING ERRCODE = '40001', DETAIL = 'StaleClaim';
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR UPDATE;
  IF NOT FOUND OR v_operation.owner_ref <> 'C_EXT'
      OR v_operation.action_id <> 'console.extension.remove'
      OR v_operation.action_version <> '1.0'
      OR v_operation.target_ref <> p_target_ref
      OR v_operation.payload_digest <> p_payload_digest
      OR v_operation.state <> 'Applied' THEN
    RAISE EXCEPTION 'observation claim does not match an Applied Extension removal'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  SELECT * INTO v_applied_receipt
    FROM console_operation.execution_receipt
    WHERE operation_id = p_operation_id
      AND owner_ref = 'C_EXT'
      AND phase = 'Applied'
      AND evidence_digest = p_applied_receipt_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Applied removal receipt is missing'
      USING ERRCODE = '55000', DETAIL = 'ObservationMissing';
  END IF;
  IF v_applied_receipt.evidence->>'authority' <> 'KubernetesUIPluginRegistration'
      OR v_applied_receipt.evidence->>'postcondition' <> 'RemovalRequested'
      OR v_applied_receipt.evidence->>'operationId' <> p_operation_id::text
      OR v_applied_receipt.evidence->>'descriptorId' <> p_target_ref
      OR v_applied_receipt.evidence->>'registrationName' <> p_observation->'registration'->>'name'
      OR v_applied_receipt.evidence->>'registrationUid' <> p_observation->'registration'->>'uid' THEN
    RAISE EXCEPTION 'removal observation does not match the Applied coordinates'
      USING ERRCODE = '55000', DETAIL = 'ObservationMismatch';
  END IF;

  v_evidence := jsonb_build_object(
    'schemaVersion', '1.0',
    'authority', 'KubernetesUIPluginRegistration',
    'operationId', p_operation_id,
    'descriptorId', p_target_ref,
    'appliedReceiptDigest', p_applied_receipt_digest,
    'registration', p_observation->'registration',
    'postcondition', 'RegistrationAbsent'
  );
  v_evidence_digest := 'sha256:' || encode(sha256(convert_to(v_evidence::text, 'UTF8')), 'hex');

  INSERT INTO console_operation.execution_receipt(
    operation_id, owner_ref, worker_id, claim_epoch, phase, evidence, evidence_digest
  ) VALUES (
    p_operation_id, 'C_EXT', p_worker_id, p_claim_epoch,
    'Verified', v_evidence, v_evidence_digest
  );
  UPDATE console_operation.outbox
    SET delivered_at = statement_timestamp()
    WHERE outbox_id = p_outbox_id;
  PERFORM console_audit.append_event_internal(
    p_operation_id, v_operation.correlation_id, p_worker_id::text,
    'console.extension.remove.observe', p_target_ref, 'succeeded', '',
    jsonb_build_object(
      'ownerRef', 'C_EXT', 'claimEpoch', p_claim_epoch,
      'evidenceDigest', v_evidence_digest, 'postcondition', 'RegistrationAbsent'
    )
  );
  RETURN jsonb_build_object(
    'operationRecord', to_jsonb(v_operation),
    'evidenceDigest', v_evidence_digest,
    'postcondition', 'RegistrationAbsent'
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.record_remove_observation(
  uuid, bigint, bigint, uuid, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.record_remove_observation(
  uuid, bigint, bigint, uuid, text, text, text, jsonb
) TO console_extension_controller;

CREATE OR REPLACE FUNCTION console_extension.record_execution_failure(
  p_worker_id uuid,
  p_outbox_id bigint,
  p_claim_epoch bigint,
  p_operation_id uuid,
  p_error_code text,
  p_error_digest text,
  p_side_effect text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_extension, console_audit
AS $$
DECLARE
  v_outbox console_operation.outbox;
  v_operation console_operation.operation;
  v_phase text := CASE WHEN p_side_effect = 'unknown' THEN 'Unknown' ELSE 'Failed' END;
  v_dispatch_phase text;
  v_evidence jsonb;
BEGIN
  IF COALESCE(p_error_code, '') !~ '^[A-Z][A-Za-z0-9]{2,63}$'
      OR COALESCE(p_error_digest, '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_side_effect, '') NOT IN ('none', 'present', 'unknown') THEN
    RAISE EXCEPTION 'invalid typed execution failure' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_outbox
    FROM console_operation.outbox
    WHERE outbox_id = p_outbox_id
    FOR UPDATE;
  IF NOT FOUND OR v_outbox.operation_id <> p_operation_id
      OR v_outbox.event_type NOT IN (
        'OperationReadyForDispatch',
        'ExtensionInstallObservationRequested',
        'ExtensionRemovalObservationRequested'
      )
      OR v_outbox.claim_owner <> p_worker_id
      OR v_outbox.claim_epoch <> p_claim_epoch
      OR v_outbox.delivered_at IS NOT NULL
      OR v_outbox.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'owner claim is stale or expired' USING ERRCODE = '40001', DETAIL = 'StaleClaim';
  END IF;
  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR UPDATE;
  IF NOT FOUND OR v_operation.owner_ref <> 'C_EXT'
      OR v_operation.action_id NOT IN (
        'console.extension.install', 'console.extension.remove', 'console.extension.revocation.create'
      )
      OR NOT (
        (v_outbox.event_type = 'OperationReadyForDispatch'
          AND v_operation.state IN ('Submitted', 'Reconciling'))
        OR (v_outbox.event_type = 'ExtensionInstallObservationRequested'
          AND v_operation.action_id = 'console.extension.install'
          AND v_operation.state = 'Applied')
        OR (v_outbox.event_type = 'ExtensionRemovalObservationRequested'
          AND v_operation.action_id = 'console.extension.remove'
          AND v_operation.state = 'Applied')
      )
      OR (v_outbox.event_type <> 'OperationReadyForDispatch' AND p_side_effect = 'none') THEN
    RAISE EXCEPTION 'failure receipt does not match the typed Extension action'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;
  v_dispatch_phase := CASE
    WHEN v_outbox.event_type = 'OperationReadyForDispatch' THEN 'apply'
    ELSE 'observe'
  END;

  v_evidence := jsonb_build_object(
    'schemaVersion', '1.0',
    'ownerRef', 'C_EXT',
    'operationId', v_operation.operation_id,
    'claimEpoch', p_claim_epoch,
    'outboxId', v_outbox.outbox_id,
    'attemptCount', v_outbox.attempt_count,
    'dispatchPhase', v_dispatch_phase,
    'errorCode', p_error_code,
    'errorDigest', p_error_digest,
    'sideEffect', p_side_effect
  );
  INSERT INTO console_operation.execution_receipt(
    operation_id, owner_ref, worker_id, claim_epoch, phase, evidence, evidence_digest
  ) VALUES (
    v_operation.operation_id, 'C_EXT', p_worker_id, p_claim_epoch,
    v_phase, v_evidence,
    'sha256:' || encode(sha256(convert_to(v_evidence::text, 'UTF8')), 'hex')
  );
  UPDATE console_operation.operation
    SET state = v_phase, state_version = state_version + 1,
        error = jsonb_build_object(
          'code', p_error_code,
          'digest', p_error_digest,
          'sideEffect', p_side_effect,
          'dispatchPhase', v_dispatch_phase,
          'attemptCount', v_outbox.attempt_count
        ),
        updated_at = statement_timestamp()
    WHERE operation_id = v_operation.operation_id
    RETURNING * INTO v_operation;
  UPDATE console_operation.outbox
    SET delivered_at = statement_timestamp()
    WHERE outbox_id = v_outbox.outbox_id;
  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    v_operation.correlation_id,
    p_worker_id::text,
    v_operation.action_id,
    v_operation.target_ref,
    CASE WHEN p_side_effect = 'unknown' THEN 'unknown' ELSE 'failed' END,
    '',
    jsonb_build_object(
      'ownerRef', 'C_EXT',
      'claimEpoch', p_claim_epoch,
      'outboxId', v_outbox.outbox_id,
      'attemptCount', v_outbox.attempt_count,
      'dispatchPhase', v_dispatch_phase,
      'state', v_phase,
      'errorCode', p_error_code,
      'errorDigest', p_error_digest,
      'sideEffect', p_side_effect
    )
  );
  RETURN to_jsonb(v_operation);
END;
$$;

REVOKE ALL ON FUNCTION console_extension.record_execution_failure(
  uuid, bigint, bigint, uuid, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.record_execution_failure(
  uuid, bigint, bigint, uuid, text, text, text
) TO console_extension_controller;

CREATE OR REPLACE FUNCTION console_operation.verify_extension_operation(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_operation_id uuid,
  p_expected_state_version bigint,
  p_idempotency_key text,
  p_correlation_id text
)
RETURNS TABLE(operation_record jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation, console_extension, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_operation console_operation.operation;
  v_verification console_operation.verification_receipt;
  v_revocation console_extension.revocation;
  v_applied_receipt console_operation.execution_receipt;
  v_observed_receipt console_operation.execution_receipt;
  v_request_digest text;
  v_observation jsonb;
  v_observation_digest text;
BEGIN
  IF p_expected_state_version < 0
      OR length(COALESCE(p_idempotency_key, '')) NOT BETWEEN 8 AND 256
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid verification request' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id
    FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref
    FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = 'console.operation.verify'
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;

  v_request_digest := 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'operationId', p_operation_id,
    'expectedStateVersion', p_expected_state_version
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_ref::text || ':' || p_idempotency_key, 0));
  SELECT * INTO v_verification
    FROM console_operation.verification_receipt
    WHERE actor_ref = p_actor_ref AND idempotency_key = p_idempotency_key
    FOR UPDATE;
  IF FOUND THEN
    IF v_verification.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'idempotency key was already used for a different verification'
        USING ERRCODE = '23505', DETAIL = 'IdempotencyMismatch';
    END IF;
    SELECT * INTO v_operation
      FROM console_operation.operation
      WHERE operation_id = v_verification.operation_id;
    RETURN QUERY SELECT to_jsonb(v_operation), true;
    RETURN;
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation was not found' USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  IF v_operation.state_version <> p_expected_state_version THEN
    RAISE EXCEPTION 'operation state version changed' USING ERRCODE = '40001', DETAIL = 'StaleOperationVersion';
  END IF;
  IF v_operation.state <> 'Applied' THEN
    RAISE EXCEPTION 'operation is not ready for verification' USING ERRCODE = '55000', DETAIL = 'InvalidOperationState';
  END IF;
  IF v_operation.owner_ref <> 'C_EXT'
      OR v_operation.action_id NOT IN (
        'console.extension.install', 'console.extension.remove', 'console.extension.revocation.create'
      )
      OR v_operation.action_version <> '1.0' THEN
    RAISE EXCEPTION 'verification action is outside the typed Extension boundary'
      USING ERRCODE = '42501', DETAIL = 'ObservationMismatch';
  END IF;

  IF v_operation.action_id = 'console.extension.revocation.create' THEN
    SELECT * INTO v_revocation
      FROM console_extension.revocation
      WHERE operation_id = v_operation.operation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Extension revocation observation is missing'
        USING ERRCODE = '55000', DETAIL = 'ObservationMissing';
    END IF;
    IF v_revocation.image_ref <> v_operation.target_ref
        OR v_revocation.payload_digest <> v_operation.payload_digest
        OR v_revocation.action_version <> v_operation.action_version THEN
      RAISE EXCEPTION 'Extension revocation observation does not match the operation'
        USING ERRCODE = '55000', DETAIL = 'ObservationMismatch';
    END IF;

    SELECT * INTO v_applied_receipt
      FROM console_operation.execution_receipt
      WHERE operation_id = v_operation.operation_id
        AND owner_ref = 'C_EXT'
        AND claim_epoch = v_revocation.claim_epoch
        AND phase = 'Applied';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Applied owner receipt is missing'
        USING ERRCODE = '55000', DETAIL = 'ObservationMissing';
    END IF;
    IF v_applied_receipt.evidence->>'authority' <> 'ConsoleExtensionRevocation'
        OR v_applied_receipt.evidence->>'imageRef' <> v_operation.target_ref
        OR v_applied_receipt.evidence->>'operationId' <> v_operation.operation_id::text
        OR v_applied_receipt.evidence->>'claimEpoch' <> v_revocation.claim_epoch::text
        OR v_applied_receipt.evidence->>'postcondition' <> 'RevocationPresent' THEN
      RAISE EXCEPTION 'Applied owner receipt does not match the observed revocation'
        USING ERRCODE = '55000', DETAIL = 'ObservationMismatch';
    END IF;

    v_observation := jsonb_build_object(
      'schemaVersion', '1.0',
      'authority', 'ConsoleExtensionRevocation',
      'imageRef', v_revocation.image_ref,
      'operationId', v_revocation.operation_id,
      'payloadDigest', v_revocation.payload_digest,
      'actionVersion', v_revocation.action_version,
      'claimEpoch', v_revocation.claim_epoch,
      'revokedAt', v_revocation.revoked_at,
      'appliedReceiptDigest', v_applied_receipt.evidence_digest,
      'postcondition', 'RevocationPresent'
    );
  ELSIF v_operation.action_id = 'console.extension.install' THEN
    IF EXISTS (
      SELECT 1 FROM console_extension.revocation
      WHERE image_ref = v_operation.target_ref
    ) THEN
      RAISE EXCEPTION 'exact Extension image digest is revoked before verification'
        USING ERRCODE = '55000', DETAIL = 'ImageRevoked';
    END IF;
    SELECT * INTO v_applied_receipt
      FROM console_operation.execution_receipt
      WHERE operation_id = v_operation.operation_id
        AND owner_ref = 'C_EXT'
        AND phase = 'Applied';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Applied install receipt is missing'
        USING ERRCODE = '55000', DETAIL = 'ObservationMissing';
    END IF;
    SELECT * INTO v_observed_receipt
      FROM console_operation.execution_receipt
      WHERE operation_id = v_operation.operation_id
        AND owner_ref = 'C_EXT'
        AND phase = 'Verified';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ready install observation is missing'
        USING ERRCODE = '55000', DETAIL = 'ObservationMissing';
    END IF;
    IF v_applied_receipt.evidence->>'authority' <> 'KubernetesUIPluginRegistration'
        OR v_applied_receipt.evidence->>'operationId' <> v_operation.operation_id::text
        OR v_applied_receipt.evidence->>'image' <> v_operation.target_ref
        OR v_applied_receipt.evidence->>'postcondition' <> 'RegistrationPresent'
        OR v_observed_receipt.evidence->>'authority' <> 'KubernetesUIPluginRegistration'
        OR v_observed_receipt.evidence->>'operationId' <> v_operation.operation_id::text
        OR v_observed_receipt.evidence->>'image' <> v_operation.target_ref
        OR v_observed_receipt.evidence->>'appliedReceiptDigest' <> v_applied_receipt.evidence_digest
        OR v_observed_receipt.evidence->>'postcondition' <> 'InstallReady'
        OR v_observed_receipt.evidence->'registration'->>'name' <> v_applied_receipt.evidence->>'registrationName'
        OR v_observed_receipt.evidence->'registration'->>'uid' <> v_applied_receipt.evidence->>'registrationUid'
        OR v_observed_receipt.evidence->'package'->>'resourceVersion' <> v_applied_receipt.evidence->>'packageResourceVersion'
        OR v_observed_receipt.evidence->'package'->>'generation' <> v_applied_receipt.evidence->>'packageGeneration'
        OR v_observed_receipt.evidence->'package'->>'digest' <> split_part(v_operation.target_ref, '@', 2)
        OR v_observed_receipt.evidence->'package'->>'manifestDigest' <> v_applied_receipt.evidence->>'manifestDigest'
        OR v_observed_receipt.evidence->'workload'->>'phase' <> 'Ready'
        OR v_observed_receipt.evidence->'revalidation'->>'phase' <> 'Passed' THEN
      RAISE EXCEPTION 'ready install observation does not match the Applied receipt'
        USING ERRCODE = '55000', DETAIL = 'ObservationMismatch';
    END IF;
    v_observation := v_observed_receipt.evidence || jsonb_build_object(
      'ownerObservationReceiptDigest', v_observed_receipt.evidence_digest
    );
  ELSE
    SELECT * INTO v_applied_receipt
      FROM console_operation.execution_receipt
      WHERE operation_id = v_operation.operation_id
        AND owner_ref = 'C_EXT'
        AND phase = 'Applied';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Applied removal receipt is missing'
        USING ERRCODE = '55000', DETAIL = 'ObservationMissing';
    END IF;
    SELECT * INTO v_observed_receipt
      FROM console_operation.execution_receipt
      WHERE operation_id = v_operation.operation_id
        AND owner_ref = 'C_EXT'
        AND phase = 'Verified';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'absent Registration observation is missing'
        USING ERRCODE = '55000', DETAIL = 'ObservationMissing';
    END IF;
    IF v_applied_receipt.evidence->>'authority' <> 'KubernetesUIPluginRegistration'
        OR v_applied_receipt.evidence->>'operationId' <> v_operation.operation_id::text
        OR v_applied_receipt.evidence->>'descriptorId' <> v_operation.target_ref
        OR v_applied_receipt.evidence->>'postcondition' <> 'RemovalRequested'
        OR v_observed_receipt.evidence->>'authority' <> 'KubernetesUIPluginRegistration'
        OR v_observed_receipt.evidence->>'operationId' <> v_operation.operation_id::text
        OR v_observed_receipt.evidence->>'descriptorId' <> v_operation.target_ref
        OR v_observed_receipt.evidence->>'appliedReceiptDigest' <> v_applied_receipt.evidence_digest
        OR v_observed_receipt.evidence->>'postcondition' <> 'RegistrationAbsent'
        OR v_observed_receipt.evidence->'registration'->>'name' <> v_applied_receipt.evidence->>'registrationName'
        OR v_observed_receipt.evidence->'registration'->>'uid' <> v_applied_receipt.evidence->>'registrationUid'
        OR v_observed_receipt.evidence->'registration'->>'phase' <> 'Absent' THEN
      RAISE EXCEPTION 'absent Registration observation does not match the Applied removal receipt'
        USING ERRCODE = '55000', DETAIL = 'ObservationMismatch';
    END IF;
    v_observation := v_observed_receipt.evidence || jsonb_build_object(
      'ownerObservationReceiptDigest', v_observed_receipt.evidence_digest
    );
  END IF;
  v_observation_digest := 'sha256:' || encode(sha256(convert_to(v_observation::text, 'UTF8')), 'hex');

  INSERT INTO console_operation.verification_receipt(
    operation_id, actor_ref, request_digest, permission_revision, revoke_epoch,
    expected_state_version, authority, observation_digest, observation,
    idempotency_key, correlation_id
  ) VALUES (
    v_operation.operation_id, p_actor_ref, v_request_digest,
    v_authority.permission_revision, v_authority.revoke_epoch,
    p_expected_state_version, v_observation->>'authority', v_observation_digest,
    v_observation, p_idempotency_key, p_correlation_id
  ) RETURNING * INTO v_verification;

  UPDATE console_operation.operation
    SET state = 'Verified', state_version = state_version + 1,
        observed_postcondition = v_observation, updated_at = statement_timestamp()
    WHERE operation_id = v_operation.operation_id
    RETURNING * INTO v_operation;

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    p_correlation_id,
    p_actor_ref::text,
    'console.operation.verify',
    v_operation.target_ref,
    'succeeded',
    '',
    jsonb_build_object(
      'verificationId', v_verification.verification_id,
      'authority', v_verification.authority,
      'requestDigest', v_verification.request_digest,
      'observationDigest', v_verification.observation_digest,
      'appliedReceiptDigest', v_applied_receipt.evidence_digest,
      'permissionRevision', v_verification.permission_revision,
      'revokeEpoch', v_verification.revoke_epoch,
      'stateVersion', v_operation.state_version
    )
  );

  UPDATE console_identity.browser_session
    SET last_seen_at = statement_timestamp()
    WHERE session_id = v_session.session_id;

  RETURN QUERY SELECT to_jsonb(v_operation), false;
END;
$$;

REVOKE ALL ON FUNCTION console_operation.verify_extension_operation(
  uuid, uuid, bigint, bigint, uuid, bigint, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.verify_extension_operation(
  uuid, uuid, bigint, bigint, uuid, bigint, text, text
) TO console_api;

CREATE OR REPLACE FUNCTION console_operation.get_operation(
  p_session_id uuid,
  p_actor_ref uuid,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_operation console_operation.operation;
BEGIN
  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id AND actor_ref = p_actor_ref;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(v_operation);
END;
$$;

REVOKE ALL ON FUNCTION console_operation.get_operation(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.get_operation(uuid, uuid, uuid) TO console_api;

CREATE OR REPLACE FUNCTION console_extension.get_registry_connection(
  p_session_id uuid,
  p_actor_ref uuid,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_extension
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_connection console_extension.registry_connection;
  v_observed_at timestamptz := statement_timestamp();
BEGIN
  IF length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid correlation id' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_observed_at THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = 'console.registry.manage'
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;

  SELECT * INTO STRICT v_connection
    FROM console_extension.registry_connection
    WHERE connection_id = 'opensphere-ghcr';

  RETURN jsonb_build_object(
    'schemaVersion', '1.0',
    'data', jsonb_build_object(
      'connectionId', v_connection.connection_id,
      'registryOrigin', v_connection.registry_origin,
      'namespace', v_connection.namespace,
      'username', v_connection.username,
      'credentialPresent', v_connection.credential_version IS NOT NULL,
      'credentialVersion', v_connection.credential_version,
      'configurationState', v_connection.configuration_state,
      'lastVerifiedAt', v_connection.last_verified_at,
      'lastVerificationCode', v_connection.last_verification_code,
      'updatedAt', v_connection.updated_at
    ),
    'authority', 'ConsoleRegistryConnectionMetadata',
    'observedAt', v_observed_at,
    'freshness', 'fresh',
    'correlationId', p_correlation_id,
    'evidenceRefs', jsonb_build_array(
      'registry-connection:' || v_connection.connection_id || ':' || v_connection.configuration_state
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.get_registry_connection(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.get_registry_connection(uuid, uuid, text) TO console_api;

CREATE OR REPLACE FUNCTION console_extension.list_revocations(
  p_session_id uuid,
  p_actor_ref uuid,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation, console_extension
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_data jsonb;
  v_evidence_refs jsonb;
  v_observed_at timestamptz := statement_timestamp();
BEGIN
  IF length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid correlation id' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_observed_at THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = 'console.extension.revoke'
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;

  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'imageRef', revocation.image_ref,
      'operationId', revocation.operation_id,
      'payloadDigest', revocation.payload_digest,
      'actionVersion', revocation.action_version,
      'claimEpoch', revocation.claim_epoch,
      'revokedAt', revocation.revoked_at
    ) ORDER BY revocation.revoked_at DESC, revocation.image_ref), '[]'::jsonb),
    COALESCE(jsonb_agg(to_jsonb('operation:' || revocation.operation_id::text)
      ORDER BY revocation.revoked_at DESC, revocation.image_ref), '[]'::jsonb)
    INTO v_data, v_evidence_refs
    FROM console_extension.revocation;

  RETURN jsonb_build_object(
    'schemaVersion', '1.0',
    'data', v_data,
    'authority', 'ConsoleExtensionRevocation',
    'observedAt', v_observed_at,
    'freshness', 'fresh',
    'correlationId', p_correlation_id,
    'evidenceRefs', v_evidence_refs
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.list_revocations(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.list_revocations(uuid, uuid, text) TO console_api;

COMMENT ON SCHEMA console_identity IS 'Supabase-backed Console identity projections and opaque sessions';
COMMENT ON SCHEMA console_operation IS 'Durable intent, idempotency and external-effect outbox authority';
COMMENT ON SCHEMA console_audit IS 'Append-only Console security and operation evidence';
COMMENT ON SCHEMA console_extension IS 'Extension Controller-owned package, registration and revocation authority';
COMMENT ON TABLE console_operation.operation IS 'State changes require compare-and-set on state_version by constrained functions';
COMMENT ON TABLE console_operation.verification_receipt IS 'Idempotent verifier evidence derived from current owner state; callers cannot submit observations';
COMMENT ON TABLE console_extension.registry_connection IS 'No-secret metadata authority for the fixed OpenSphere GHCR connection';
COMMENT ON FUNCTION console_operation.accept_operation(
  uuid, uuid, bigint, bigint, text, text, text, text, text, text, text, text,
  boolean, text, text, text, text, jsonb, jsonb
) IS 'Atomically revalidates session and permission, accepts an idempotent intent, and appends audit/outbox evidence';
COMMENT ON FUNCTION console_audit.list_events(uuid, uuid, bigint, bigint, bigint, integer, text)
  IS 'Returns a bounded newest-first page from the append-only audit ledger after current authority checks';
COMMENT ON FUNCTION console_identity.revoke_browser_session(uuid, uuid, bigint, bigint, text)
  IS 'Revokes only the caller current opaque session and atomically appends no-token audit evidence';
COMMENT ON FUNCTION console_identity.get_supabase_status(uuid, uuid, bigint, bigint, text)
  IS 'Returns a fail-closed Supabase readiness projection with append-only migration lineage and without promoting unprobed recovery evidence';
COMMENT ON FUNCTION console_operation.approve_operation(
  uuid, uuid, bigint, bigint, uuid, bigint, text, text, text, text, text
) IS 'Atomically revalidates an independent aal2 approver and advances a Planned operation by compare-and-set';
COMMENT ON FUNCTION console_operation.verify_extension_operation(
  uuid, uuid, bigint, bigint, uuid, bigint, text, text
) IS 'Revalidates verifier authority and derives Verified only from matching fenced C_EXT execution and observation evidence';
COMMENT ON FUNCTION console_operation.claim_owner_operation(uuid, text, text[], integer)
  IS 'Claims one ready owner operation with skip-locked selection, bounded lease and monotonic fencing epoch';
COMMENT ON FUNCTION console_operation.renew_owner_claim(uuid, bigint, bigint, integer)
  IS 'Renews only the current unexpired owner claim fence';
COMMENT ON FUNCTION console_extension.apply_revocation(uuid, bigint, bigint, uuid, text, text)
  IS 'Applies one exact-digest Extension revocation under the current claim fence and appends execution evidence';
COMMENT ON FUNCTION console_extension.assert_install_not_revoked(uuid, bigint, bigint, uuid, text, text)
  IS 'Checks the current fenced install or observation claim against C_EXT exact-digest revocation authority before side effect or success evidence';
COMMENT ON FUNCTION console_extension.apply_install_registration(
  uuid, bigint, bigint, uuid, text, text, jsonb, text, text, text, text, bigint, boolean,
  text, text, text, text
)
  IS 'Records one unrevoked C_REG-bound UIPluginRegistration application under the current claim fence';
COMMENT ON FUNCTION console_extension.record_install_observation(uuid, bigint, bigint, uuid, text, text, text, jsonb)
  IS 'Records exact Ready UIPluginRegistration evidence only while its image remains unrevoked, without advancing verifier state';
COMMENT ON FUNCTION console_extension.apply_remove_registration(
  uuid, bigint, bigint, uuid, text, text, text, text, text, text, bigint, text, bigint, text, boolean
)
  IS 'Records a fenced request to uninstall one exact UIPluginRegistration and queues absence observation';
COMMENT ON FUNCTION console_extension.record_remove_observation(uuid, bigint, bigint, uuid, text, text, text, jsonb)
  IS 'Records exact RegistrationAbsent evidence without advancing the operation verification state';
COMMENT ON FUNCTION console_extension.record_execution_failure(uuid, bigint, bigint, uuid, text, text, text)
  IS 'Closes a fenced apply or observation dispatch as typed Failed or Unknown without raw error material';
COMMENT ON FUNCTION console_extension.list_revocations(uuid, uuid, text)
  IS 'Returns the current C_EXT exact-digest revocation authority through a session-revalidated no-secret projection';
COMMENT ON FUNCTION console_extension.get_registry_connection(uuid, uuid, text)
  IS 'Returns fixed GHCR connection metadata without credential or SecretRef material after current authority checks';
