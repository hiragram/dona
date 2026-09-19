CREATE TABLE events (
  sequence            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id            TEXT NOT NULL UNIQUE,
  schema_version      INTEGER NOT NULL,
  source              TEXT NOT NULL,
  external_event_id   TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  occurred_at         TEXT NOT NULL,
  subject_json        TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  reply_target_json   TEXT,
  trace_json          TEXT,
  status              TEXT NOT NULL CHECK (status IN (
    'queued', 'dispatching', 'waiting_agent', 'completed', 'retryable_failed',
    'blocked', 'needs_review', 'dead_letter'
  )),
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  available_at        TEXT NOT NULL,
  dispatch_started_at TEXT,
  prompt_accepted_at  TEXT,
  completed_at        TEXT,
  result_json         TEXT,
  result_path         TEXT,
  last_error_code     TEXT,
  last_error_message  TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (source, external_event_id)
);
CREATE INDEX events_dispatch_idx ON events(status, available_at, sequence);

CREATE TABLE jobs (
  job_id                TEXT PRIMARY KEY,
  source_event_id       TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  source                TEXT NOT NULL,
  workspace_id          TEXT,
  channel_id            TEXT,
  thread_ts             TEXT,
  actor_id              TEXT,
  objective             TEXT NOT NULL,
  workspace_json        TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
    'queued', 'preparing', 'dispatching', 'running', 'retryable_failed', 'blocked',
    'completed', 'failed', 'cancelling', 'cancelled', 'needs_review'
  )),
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  available_at          TEXT NOT NULL,
  workspace_path        TEXT NOT NULL,
  result_path           TEXT NOT NULL,
  herdr_workspace_id    TEXT,
  herdr_pane_id         TEXT,
  agent_name            TEXT NOT NULL UNIQUE,
  dispatch_started_at   TEXT,
  prompt_accepted_at    TEXT,
  completed_at          TEXT,
  result_json           TEXT,
  completion_event_id   TEXT REFERENCES events(event_id),
  steer_event_id        TEXT,
  steer_state           TEXT CHECK (steer_state IN ('dispatching', 'accepted') OR steer_state IS NULL),
  last_error_code       TEXT,
  last_error_message    TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX jobs_run_idx ON jobs(status, available_at, created_at);
CREATE INDEX jobs_thread_idx ON jobs(workspace_id, channel_id, thread_ts, created_at);
PRAGMA user_version = 2;
