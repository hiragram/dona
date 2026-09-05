import type Database from "better-sqlite3";

// Core user_version is owned by the Dispatcher (including the independent v3 job migration).
export function migrateScheduler(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS scheduler_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL
    )`);
    const row = db.prepare("SELECT version FROM scheduler_schema WHERE singleton = 1").get() as { version: number } | undefined;
    if (row && row.version !== 1) throw new Error("unsupported_scheduler_schema");
    if (row) return;
    db.exec(`
      CREATE TABLE schedules (
        schedule_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','paused','expired','needs_review','cancelled','completed')),
        revision INTEGER NOT NULL CHECK(revision > 0), next_due TEXT, high_watermark TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT,
        FOREIGN KEY(schedule_id, revision) REFERENCES schedule_revisions(schedule_id, revision) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX schedules_due_idx ON schedules(next_due, schedule_id) WHERE state = 'active';
      CREATE INDEX schedules_owner_idx ON schedules(tenant_id, owner_id, state);
      CREATE TABLE schedule_revisions (
        schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK(revision > 0),
        recurrence_json TEXT NOT NULL, recurrence_hash TEXT NOT NULL,
        policy_json TEXT NOT NULL, policy_version INTEGER NOT NULL CHECK(policy_version = 1),
        timezone TEXT, tzdb_version TEXT,
        authorization_id TEXT NOT NULL, authorization_revision INTEGER NOT NULL CHECK(authorization_revision > 0),
        content_scope TEXT NOT NULL CHECK(content_scope IN ('fixed_body','fixed_objective_redacted_result')), approver_id TEXT NOT NULL, approved_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('slack.reminder.post','work.read_only')),
        target_json TEXT NOT NULL, content TEXT, content_hash TEXT NOT NULL,
        content_delete_at TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(schedule_id, revision), CHECK(expires_at > approved_at)
      );
      CREATE TABLE schedule_runs (
        run_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, revision INTEGER NOT NULL,
        occurrence_key TEXT NOT NULL, scheduled_for TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('materialized','started','completed','failed','cancelled','skipped','needs_review')),
        reason TEXT CHECK(reason IN ('misfire','overlap','authorization_expired','cancelled','revision_replaced','ambiguous_write') OR reason IS NULL),
        event_id TEXT UNIQUE REFERENCES events(event_id), job_id TEXT,
        created_at TEXT NOT NULL, started_at TEXT, terminal_at TEXT,
        UNIQUE(schedule_id, occurrence_key), UNIQUE(schedule_id, scheduled_for),
        FOREIGN KEY(schedule_id, revision) REFERENCES schedule_revisions(schedule_id, revision)
      );
      CREATE INDEX schedule_runs_state_idx ON schedule_runs(schedule_id, status, scheduled_for);
      CREATE INDEX schedule_runs_terminal_idx ON schedule_runs(terminal_at);
      CREATE TABLE connector_outbox (
        outbox_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES schedule_runs(run_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('slack.reminder.post','slack.work_result.post')),
        idempotency_key TEXT NOT NULL UNIQUE, target_json TEXT NOT NULL, content TEXT, content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','claimed','request_started','sent','failed','cancelled','needs_review')),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 3), available_at TEXT NOT NULL,
        claim_token TEXT, lease_until TEXT, request_started_at TEXT, receipt_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT, content_delete_at TEXT,
        UNIQUE(run_id, kind)
      );
      CREATE INDEX connector_outbox_claim_idx ON connector_outbox(status, available_at, outbox_id);
      CREATE INDEX connector_outbox_lease_idx ON connector_outbox(status, lease_until);
      CREATE TABLE schedule_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL, revision INTEGER NOT NULL,
        tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, source_event_id TEXT REFERENCES events(event_id),
        operation TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX schedule_audit_order_idx ON schedule_audit(schedule_id, sequence);
      CREATE INDEX schedule_audit_retention_idx ON schedule_audit(created_at);
      INSERT INTO scheduler_schema VALUES (1, 1);
    `);
  }).immediate();
}
