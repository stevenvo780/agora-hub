-- Agora — schema canónico en Postgres NAS.
-- Convención: control plane queda en Firebase RTDB (eventos solo), data plane vive aquí + MinIO.
-- Cada tabla es idempotente (CREATE IF NOT EXISTS) para que el script de migración pueda re-correrse.

CREATE SCHEMA IF NOT EXISTS agora;
SET search_path = agora, public;

-- ---------------------------------------------------------------------------
-- workspaces
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  owner_id        TEXT,
  is_personal     BOOLEAN NOT NULL DEFAULT FALSE,
  members         JSONB NOT NULL DEFAULT '[]'::jsonb,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- users (espejo de Firebase Auth + perfil)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  uid             TEXT PRIMARY KEY,
  email           TEXT,
  display_name    TEXT,
  plan_id         TEXT,
  subscription    JSONB,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- documents (metadata pesada — el `content` ya NO vive aquí, vive en MinIO)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT,
  workspace_id    TEXT,
  owner_id        TEXT,
  folder          TEXT,
  mime_type       TEXT,
  size            BIGINT,
  storage_path    TEXT,                 -- key en MinIO bucket agora-blobs
  storage_backend TEXT NOT NULL DEFAULT 'minio',
  content_hash    TEXT,                 -- sha256 hex
  version         BIGINT NOT NULL DEFAULT 1,
  base_version    BIGINT,
  sync_state      TEXT NOT NULL DEFAULT 'synced'
                     CHECK (sync_state IN ('synced','pending_upload','pending_download','conflict','failed')),
  last_writer     TEXT,
  origin_host     TEXT,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_state ON documents(sync_state);
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash);

-- ---------------------------------------------------------------------------
-- snippets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snippets (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT,
  owner_id        TEXT,
  name            TEXT,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- boards (kanban / tableros)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boards (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT,
  owner_id        TEXT,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  cards           JSONB NOT NULL DEFAULT '[]'::jsonb,
  columns         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- agentAuditLog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_audit_log (
  id              TEXT PRIMARY KEY,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- workspace_semantic_states
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_semantic_states (
  workspace_id    TEXT PRIMARY KEY,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- sync_events_outbox (cuando el hub recibe un commit, escribe aquí; un proceso
-- aparte lo publica al RTDB. Sirve como trazabilidad y replay.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_events_outbox (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scope           TEXT NOT NULL,
  workspace_id    TEXT,
  user_id         TEXT,
  doc_id          TEXT,
  path            TEXT,
  version         BIGINT,
  content_hash    TEXT,
  sender          TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  published       BOOLEAN NOT NULL DEFAULT FALSE,
  published_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON sync_events_outbox(published, ts) WHERE NOT published;

-- ---------------------------------------------------------------------------
-- migration_runs (auditoría idempotente)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_runs (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  stats           JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes           TEXT
);
