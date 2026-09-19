import Database from "better-sqlite3";

export class ApprovalSchemaError extends Error {
  constructor() { super("approval_schema_unverified"); this.name = "ApprovalSchemaError"; }
}

const schemaSql = `
        CREATE TABLE approval_schema (version INTEGER PRIMARY KEY CHECK(version=1));
        INSERT INTO approval_schema VALUES (1);
        CREATE TABLE approval_clock_reservations (
          transaction_id TEXT PRIMARY KEY NOT NULL,
          mark_json TEXT NOT NULL CHECK(json_valid(mark_json) AND json_extract(mark_json,'$.codec_version') IS 1
            AND json_extract(mark_json,'$.transaction_id') IS transaction_id)
        );
        CREATE TABLE approval_requests (
          request_id TEXT PRIMARY KEY NOT NULL,
          instance_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
          creation_key TEXT NOT NULL UNIQUE CHECK(length(creation_key)=64),
          snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(snapshot_json)<=262144),
          semantic_hash TEXT NOT NULL CHECK(length(semantic_hash)=64),
          binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL CHECK(binding_revision>0),
          policy_revision INTEGER NOT NULL CHECK(policy_revision>0), model_version TEXT NOT NULL CHECK(length(model_version)<=128),
          state TEXT NOT NULL CHECK(state IN ('requested','delivery_pending','delivery_unknown','sent','approved','rejected',
            'cancelled','expired','delivery_failed','consumed','execution_cancelled','consume_expired','needs_review')),
          revision INTEGER NOT NULL CHECK(revision>0),
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consume_expires_at TEXT,
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          UNIQUE(request_id,instance_id,workspace_id,semantic_hash,binding_id,binding_revision),
          CHECK(json_extract(snapshot_json,'$.codec_version') IS 1),
          CHECK(json_extract(snapshot_json,'$.operation_kind') IS 'slack.post_thread_reply.v1'),
          CHECK(json_extract(snapshot_json,'$.instance_id') IS instance_id),
          CHECK(json_extract(snapshot_json,'$.workspace_id') IS workspace_id),
          CHECK(json_extract(snapshot_json,'$.policy_revision') IS policy_revision)
        );
        CREATE INDEX approval_requests_sweep ON approval_requests(state,expires_at);
        CREATE INDEX approval_requests_consume_sweep ON approval_requests(state,consume_expires_at);
        CREATE TABLE approval_decisions (
          decision_id TEXT NOT NULL UNIQUE, request_id TEXT PRIMARY KEY NOT NULL,
          instance_id TEXT NOT NULL, workspace_id TEXT NOT NULL, semantic_hash TEXT NOT NULL,
          binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('approve','reject','cancel','expire')),
          actor_kind TEXT NOT NULL CHECK(actor_kind IN ('supervisor','requester','system')), actor_id TEXT NOT NULL,
          presentation_revision INTEGER, decided_at TEXT NOT NULL,
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          FOREIGN KEY(request_id,instance_id,workspace_id,semantic_hash,binding_id,binding_revision)
            REFERENCES approval_requests(request_id,instance_id,workspace_id,semantic_hash,binding_id,binding_revision),
          UNIQUE(decision_id,request_id,kind),
          CHECK((kind IN ('approve','reject') AND actor_kind='supervisor' AND presentation_revision IS NOT NULL AND presentation_revision>0)
            OR (kind='cancel' AND actor_kind='requester') OR (kind='expire' AND actor_kind='system'))
        );
        CREATE TABLE approval_consumes (
          consume_id TEXT NOT NULL UNIQUE, request_id TEXT PRIMARY KEY NOT NULL,
          decision_id TEXT NOT NULL UNIQUE, decision_kind TEXT NOT NULL CHECK(decision_kind='approve'),
          attempt_id TEXT NOT NULL UNIQUE, claimed_at TEXT NOT NULL,
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          FOREIGN KEY(decision_id,request_id,decision_kind) REFERENCES approval_decisions(decision_id,request_id,kind),
          UNIQUE(consume_id,request_id,attempt_id),
          FOREIGN KEY(attempt_id,request_id,consume_id) REFERENCES approval_execution_attempts(attempt_id,request_id,consume_id)
            DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TABLE approval_execution_attempts (
          attempt_id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, consume_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('claimed','executing','succeeded','failed','acceptance_unknown','needs_review')),
          fence INTEGER NOT NULL CHECK(fence>0), claimed_at TEXT NOT NULL, execution_expires_at TEXT NOT NULL,
          payload_expires_at TEXT NOT NULL, receipt_ref TEXT, failure_code TEXT,
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          UNIQUE(attempt_id,request_id,consume_id),
          FOREIGN KEY(consume_id,request_id,attempt_id) REFERENCES approval_consumes(consume_id,request_id,attempt_id)
            DEFERRABLE INITIALLY DEFERRED
        );
        CREATE INDEX approval_execution_recovery ON approval_execution_attempts(state,payload_expires_at);
        CREATE TABLE approval_notifications (
          notification_attempt_id TEXT PRIMARY KEY NOT NULL,
          request_id TEXT NOT NULL REFERENCES approval_requests(request_id),
          kind TEXT NOT NULL CHECK(kind IN ('approval_card','pending_notice')),
          state TEXT NOT NULL CHECK(state IN ('pending','dispatching','sent','failed','acceptance_unknown','needs_review','aborted')),
          request_revision INTEGER NOT NULL CHECK(request_revision>0),
          presentation_revision INTEGER NOT NULL CHECK(presentation_revision>0),
          marker_mac TEXT NOT NULL CHECK(length(marker_mac)=64), marker_key_version INTEGER NOT NULL CHECK(marker_key_version>0),
          fence INTEGER NOT NULL CHECK(fence>=0), message_ref TEXT,
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          CHECK(state IN ('pending','aborted') OR fence>0),
          CHECK(state<>'sent' OR message_ref IS NOT NULL),
          UNIQUE(request_id,kind), UNIQUE(notification_attempt_id,request_id),
          UNIQUE(notification_attempt_id,message_ref), UNIQUE(message_ref)
        );
        CREATE INDEX approval_notification_dispatch ON approval_notifications(state);
        CREATE TABLE approval_event_outbox (
          event_id TEXT PRIMARY KEY NOT NULL, decision_id TEXT NOT NULL UNIQUE REFERENCES approval_decisions(decision_id),
          kind TEXT NOT NULL CHECK(kind='dona_approval.decision.v1'),
          state TEXT NOT NULL CHECK(state IN ('pending','delivered')), delivered_at TEXT,
          CHECK((state='pending' AND delivered_at IS NULL) OR (state='delivered' AND delivered_at IS NOT NULL))
        );
        CREATE INDEX approval_event_dispatch ON approval_event_outbox(state);
        CREATE TABLE approval_presentation_updates (
          update_id TEXT PRIMARY KEY NOT NULL,
          notification_attempt_id TEXT NOT NULL,
          message_ref TEXT NOT NULL, desired_revision INTEGER NOT NULL CHECK(desired_revision>0),
          state TEXT NOT NULL CHECK(state IN ('pending','dispatching','succeeded','failed','acceptance_unknown','needs_review','aborted')),
          fence INTEGER NOT NULL CHECK(fence>=0),
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          CHECK(state IN ('pending','aborted') OR fence>0),
          FOREIGN KEY(notification_attempt_id,message_ref) REFERENCES approval_notifications(notification_attempt_id,message_ref),
          UNIQUE(notification_attempt_id,desired_revision)
        );
        CREATE UNIQUE INDEX approval_one_message_write ON approval_presentation_updates(message_ref)
          WHERE state IN ('dispatching','acceptance_unknown');
        CREATE TRIGGER approval_clock_immutable BEFORE UPDATE ON approval_clock_reservations
          BEGIN SELECT RAISE(ABORT,'approval_clock_immutable'); END;
        CREATE TRIGGER approval_request_immutable BEFORE UPDATE OF request_id,instance_id,workspace_id,creation_key,snapshot_json,
          semantic_hash,binding_id,binding_revision,policy_revision,model_version,created_at,expires_at ON approval_requests
          BEGIN SELECT RAISE(ABORT,'approval_request_immutable'); END;
        CREATE TRIGGER approval_consume_expiry_immutable BEFORE UPDATE OF consume_expires_at ON approval_requests
          WHEN OLD.consume_expires_at IS NOT NULL AND NEW.consume_expires_at IS NOT OLD.consume_expires_at
          BEGIN SELECT RAISE(ABORT,'approval_consume_expiry_immutable'); END;
        CREATE TRIGGER approval_decision_immutable BEFORE UPDATE ON approval_decisions
          BEGIN SELECT RAISE(ABORT,'approval_decision_immutable'); END;
        CREATE TRIGGER approval_consume_immutable BEFORE UPDATE ON approval_consumes
          BEGIN SELECT RAISE(ABORT,'approval_consume_immutable'); END;
        CREATE TRIGGER approval_attempt_identity_immutable BEFORE UPDATE OF attempt_id,request_id,consume_id,claimed_at,
          execution_expires_at,payload_expires_at ON approval_execution_attempts
          BEGIN SELECT RAISE(ABORT,'approval_attempt_identity_immutable'); END;
        CREATE TRIGGER approval_notification_identity_immutable BEFORE UPDATE OF notification_attempt_id,request_id,kind,
          request_revision,presentation_revision,marker_mac,marker_key_version ON approval_notifications
          BEGIN SELECT RAISE(ABORT,'approval_notification_identity_immutable'); END;
        CREATE TRIGGER approval_message_identity_immutable BEFORE UPDATE OF message_ref ON approval_notifications
          WHEN OLD.message_ref IS NOT NULL AND NEW.message_ref IS NOT OLD.message_ref
          BEGIN SELECT RAISE(ABORT,'approval_message_identity_immutable'); END;
        CREATE TRIGGER approval_event_identity_immutable BEFORE UPDATE OF event_id,decision_id,kind ON approval_event_outbox
          BEGIN SELECT RAISE(ABORT,'approval_event_identity_immutable'); END;
        CREATE TRIGGER approval_update_identity_immutable BEFORE UPDATE OF update_id,notification_attempt_id,message_ref,
          desired_revision ON approval_presentation_updates
          BEGIN SELECT RAISE(ABORT,'approval_update_identity_immutable'); END;
        CREATE TRIGGER approval_request_no_delete BEFORE DELETE ON approval_requests
          BEGIN SELECT RAISE(ABORT,'approval_retention_not_authorized'); END;
        CREATE TRIGGER approval_decision_no_delete BEFORE DELETE ON approval_decisions
          BEGIN SELECT RAISE(ABORT,'approval_retention_not_authorized'); END;
        CREATE TRIGGER approval_consume_no_delete BEFORE DELETE ON approval_consumes
          BEGIN SELECT RAISE(ABORT,'approval_retention_not_authorized'); END;
        CREATE TRIGGER approval_attempt_no_delete BEFORE DELETE ON approval_execution_attempts
          BEGIN SELECT RAISE(ABORT,'approval_retention_not_authorized'); END;
        CREATE TRIGGER approval_notification_no_delete BEFORE DELETE ON approval_notifications
          BEGIN SELECT RAISE(ABORT,'approval_retention_not_authorized'); END;
        CREATE TRIGGER approval_event_no_delete BEFORE DELETE ON approval_event_outbox
          BEGIN SELECT RAISE(ABORT,'approval_retention_not_authorized'); END;
        CREATE TRIGGER approval_update_no_delete BEFORE DELETE ON approval_presentation_updates
          BEGIN SELECT RAISE(ABORT,'approval_retention_not_authorized'); END;
        CREATE TRIGGER approval_clock_no_delete BEFORE DELETE ON approval_clock_reservations
          BEGIN SELECT RAISE(ABORT,'approval_retention_not_authorized'); END;
`;

function shape(db: Database.Database): string {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(tbl_name,1,9)='approval_' ORDER BY type,name").all());
}
export function verifyApprovalSchema(db: Database.Database): void {
  const expected = new Database(":memory:");
  try {
    expected.exec(schemaSql);
    if (shape(expected) !== shape(db)) throw new ApprovalSchemaError();
    const rows = db.prepare("SELECT version FROM approval_schema").all() as Array<{ version: number }>;
    if (rows.length !== 1 || rows[0]?.version !== 1) throw new ApprovalSchemaError();
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new ApprovalSchemaError();
  } catch { throw new ApprovalSchemaError(); }
  finally { expected.close(); }
}

/** Opt-in durable metadata only. Runtime migration, authenticated broker and the
 * transactional, backup-excluded payload store must be connected before use.
 * This installer never provisions bindings, credentials, clocks or audit roots. */
export function installApprovalSchema(db: Database.Database): void {
  try {
    if (db.inTransaction || db.pragma("foreign_keys", { simple: true }) !== 1) throw new ApprovalSchemaError();
    db.transaction(() => {
      const prior = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approval_schema'").get();
      if (prior) {
        verifyApprovalSchema(db);
        return;
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE substr(name,1,9)='approval_' OR substr(tbl_name,1,9)='approval_'").get()) throw new ApprovalSchemaError();
      db.exec(schemaSql);
      verifyApprovalSchema(db);
    }).immediate();
  } catch { throw new ApprovalSchemaError(); }
}
