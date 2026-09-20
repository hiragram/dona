import Database from "better-sqlite3";
import { assertSecurityDurability } from "../audit/durability.js";
import { withSecurityTransactionLock } from "../audit/coordination.js";
import { loadSecurityExtension, verifyOpenDatabaseFile } from "../audit/file-identity.js";

export class ApprovalSchemaError extends Error {
  constructor() { super("approval_schema_unverified"); this.name = "ApprovalSchemaError"; }
}

const schemaSql = `
        CREATE TABLE approval_schema (version INTEGER PRIMARY KEY CHECK(version=1)) STRICT;
        INSERT INTO approval_schema VALUES (1);
        CREATE TABLE approval_clock_reservations (
          transaction_id TEXT PRIMARY KEY NOT NULL,
          mark_json TEXT NOT NULL CHECK(json_valid(mark_json) AND json_extract(mark_json,'$.codec_version') IS 1
            AND json_extract(mark_json,'$.transaction_id') IS transaction_id)
        ) STRICT;
        CREATE TABLE approval_requests (
          request_id TEXT PRIMARY KEY NOT NULL,
          instance_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
          creation_key TEXT NOT NULL UNIQUE CHECK(length(creation_key)=64),
          snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB))<=262144),
          semantic_hash TEXT NOT NULL CHECK(length(semantic_hash)=64),
          binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL CHECK(binding_revision>0 AND binding_revision<=9007199254740991),
          policy_revision INTEGER NOT NULL CHECK(policy_revision>0 AND policy_revision<=9007199254740991), model_version TEXT NOT NULL CHECK(length(model_version)<=128),
          state TEXT NOT NULL CHECK(state IN ('requested','delivery_pending','delivery_unknown','sent','approved','rejected',
            'cancelled','expired','delivery_failed','consumed','execution_cancelled','consume_expired','needs_review')),
          revision INTEGER NOT NULL CHECK(revision>0 AND revision<=9007199254740991),
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consume_expires_at TEXT,
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          UNIQUE(request_id,instance_id,workspace_id,semantic_hash,binding_id,binding_revision),
          CHECK(json_extract(snapshot_json,'$.codec_version') IS 1),
          CHECK(json_extract(snapshot_json,'$.operation_kind') IS 'slack.post_thread_reply.v1'),
          CHECK(json_extract(snapshot_json,'$.instance_id') IS instance_id),
          CHECK(json_extract(snapshot_json,'$.workspace_id') IS workspace_id),
          CHECK(json_extract(snapshot_json,'$.policy_revision') IS policy_revision)
        ) STRICT;
        CREATE INDEX approval_requests_sweep ON approval_requests(state,expires_at);
        CREATE INDEX approval_requests_consume_sweep ON approval_requests(state,consume_expires_at);
        CREATE TABLE approval_decisions (
          decision_id TEXT NOT NULL UNIQUE, request_id TEXT PRIMARY KEY NOT NULL,
          instance_id TEXT NOT NULL, workspace_id TEXT NOT NULL, semantic_hash TEXT NOT NULL,
          binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('approve','reject','cancel','expire')),
          actor_kind TEXT NOT NULL CHECK(actor_kind IN ('supervisor','requester','system')), actor_id TEXT NOT NULL,
          presentation_revision INTEGER CHECK(presentation_revision IS NULL OR (presentation_revision>0 AND presentation_revision<=9007199254740991)), decided_at TEXT NOT NULL,
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          FOREIGN KEY(request_id,instance_id,workspace_id,semantic_hash,binding_id,binding_revision)
            REFERENCES approval_requests(request_id,instance_id,workspace_id,semantic_hash,binding_id,binding_revision),
          UNIQUE(decision_id,request_id,kind),
          CHECK((kind IN ('approve','reject') AND actor_kind='supervisor' AND presentation_revision IS NOT NULL AND presentation_revision>0)
            OR (kind='cancel' AND actor_kind='requester') OR (kind='expire' AND actor_kind='system'))
        ) STRICT;
        CREATE TABLE approval_consumes (
          consume_id TEXT NOT NULL UNIQUE, request_id TEXT PRIMARY KEY NOT NULL,
          decision_id TEXT NOT NULL UNIQUE, decision_kind TEXT NOT NULL CHECK(decision_kind='approve'),
          attempt_id TEXT NOT NULL UNIQUE, claimed_at TEXT NOT NULL,
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          FOREIGN KEY(decision_id,request_id,decision_kind) REFERENCES approval_decisions(decision_id,request_id,kind),
          UNIQUE(consume_id,request_id,attempt_id),
          FOREIGN KEY(attempt_id,request_id,consume_id) REFERENCES approval_execution_attempts(attempt_id,request_id,consume_id)
            DEFERRABLE INITIALLY DEFERRED
        ) STRICT;
        CREATE TABLE approval_execution_attempts (
          attempt_id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, consume_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('claimed','executing','succeeded','failed','acceptance_unknown','needs_review')),
          fence INTEGER NOT NULL CHECK(fence>0 AND fence<=9007199254740991), claimed_at TEXT NOT NULL, execution_expires_at TEXT NOT NULL,
          payload_expires_at TEXT NOT NULL, receipt_ref TEXT, failure_code TEXT,
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          UNIQUE(attempt_id,request_id,consume_id),
          FOREIGN KEY(consume_id,request_id,attempt_id) REFERENCES approval_consumes(consume_id,request_id,attempt_id)
            DEFERRABLE INITIALLY DEFERRED
        ) STRICT;
        CREATE INDEX approval_execution_recovery ON approval_execution_attempts(state,payload_expires_at);
        CREATE TABLE approval_notifications (
          notification_attempt_id TEXT PRIMARY KEY NOT NULL,
          request_id TEXT NOT NULL REFERENCES approval_requests(request_id),
          kind TEXT NOT NULL CHECK(kind IN ('approval_card','pending_notice')),
          state TEXT NOT NULL CHECK(state IN ('pending','dispatching','sent','failed','acceptance_unknown','needs_review','aborted')),
          request_revision INTEGER NOT NULL CHECK(request_revision>0 AND request_revision<=9007199254740991),
          presentation_revision INTEGER NOT NULL CHECK(presentation_revision>0 AND presentation_revision<=9007199254740991),
          marker_mac TEXT NOT NULL CHECK(length(marker_mac)=64), marker_key_version INTEGER NOT NULL CHECK(marker_key_version>0 AND marker_key_version<=9007199254740991),
          fence INTEGER NOT NULL CHECK(fence>=0 AND fence<=9007199254740991), message_ref TEXT,
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          CHECK(state IN ('pending','aborted') OR fence>0),
          CHECK((state='sent' AND message_ref IS NOT NULL) OR (state<>'sent' AND message_ref IS NULL)),
          UNIQUE(request_id,kind), UNIQUE(notification_attempt_id,request_id),
          UNIQUE(notification_attempt_id,message_ref), UNIQUE(message_ref)
        ) STRICT;
        CREATE INDEX approval_notification_dispatch ON approval_notifications(state);
        CREATE TABLE approval_event_outbox (
          event_id TEXT PRIMARY KEY NOT NULL, decision_id TEXT NOT NULL UNIQUE REFERENCES approval_decisions(decision_id),
          kind TEXT NOT NULL CHECK(kind='dona_approval.decision.v1'),
          state TEXT NOT NULL CHECK(state IN ('pending','delivered')), delivered_at TEXT,
          CHECK((state='pending' AND delivered_at IS NULL) OR (state='delivered' AND delivered_at IS NOT NULL))
        ) STRICT;
        CREATE INDEX approval_event_dispatch ON approval_event_outbox(state);
        CREATE TABLE approval_presentation_updates (
          update_id TEXT PRIMARY KEY NOT NULL,
          notification_attempt_id TEXT NOT NULL,
          message_ref TEXT NOT NULL, desired_revision INTEGER NOT NULL CHECK(desired_revision>0 AND desired_revision<=9007199254740991),
          state TEXT NOT NULL CHECK(state IN ('pending','dispatching','succeeded','failed','acceptance_unknown','needs_review','aborted')),
          fence INTEGER NOT NULL CHECK(fence>=0 AND fence<=9007199254740991),
          clock_transaction_id TEXT NOT NULL REFERENCES approval_clock_reservations(transaction_id),
          CHECK(state IN ('pending','aborted') OR fence>0),
          FOREIGN KEY(notification_attempt_id,message_ref) REFERENCES approval_notifications(notification_attempt_id,message_ref),
          UNIQUE(notification_attempt_id,desired_revision)
        ) STRICT;
        CREATE UNIQUE INDEX approval_one_message_write ON approval_presentation_updates(message_ref)
          WHERE state IN ('dispatching','acceptance_unknown');
        CREATE TRIGGER approval_clock_immutable BEFORE UPDATE ON approval_clock_reservations
          BEGIN SELECT RAISE(ABORT,'approval_clock_immutable'); END;
        CREATE TRIGGER approval_request_revision_monotonic BEFORE UPDATE OF revision ON approval_requests
          WHEN NEW.revision < OLD.revision BEGIN SELECT RAISE(ABORT,'approval_revision_rollback'); END;
        CREATE TRIGGER approval_attempt_fence_monotonic BEFORE UPDATE OF fence ON approval_execution_attempts
          WHEN NEW.fence < OLD.fence BEGIN SELECT RAISE(ABORT,'approval_fence_rollback'); END;
        CREATE TRIGGER approval_notification_fence_monotonic BEFORE UPDATE OF fence ON approval_notifications
          WHEN NEW.fence < OLD.fence BEGIN SELECT RAISE(ABORT,'approval_fence_rollback'); END;
        CREATE TRIGGER approval_update_fence_monotonic BEFORE UPDATE OF fence ON approval_presentation_updates
          WHEN NEW.fence < OLD.fence BEGIN SELECT RAISE(ABORT,'approval_fence_rollback'); END;
        CREATE TRIGGER approval_request_immutable BEFORE UPDATE OF request_id,instance_id,workspace_id,creation_key,snapshot_json,
          semantic_hash,binding_id,binding_revision,policy_revision,model_version,created_at,expires_at,clock_transaction_id ON approval_requests
          BEGIN SELECT RAISE(ABORT,'approval_request_immutable'); END;
        CREATE TRIGGER approval_consume_expiry_immutable BEFORE UPDATE OF consume_expires_at ON approval_requests
          WHEN OLD.consume_expires_at IS NOT NULL AND NEW.consume_expires_at IS NOT OLD.consume_expires_at
          BEGIN SELECT RAISE(ABORT,'approval_consume_expiry_immutable'); END;
        CREATE TRIGGER approval_decision_immutable BEFORE UPDATE ON approval_decisions
          BEGIN SELECT RAISE(ABORT,'approval_decision_immutable'); END;
        CREATE TRIGGER approval_consume_immutable BEFORE UPDATE ON approval_consumes
          BEGIN SELECT RAISE(ABORT,'approval_consume_immutable'); END;
        CREATE TRIGGER approval_attempt_identity_immutable BEFORE UPDATE OF attempt_id,request_id,consume_id,claimed_at,
          execution_expires_at,payload_expires_at,clock_transaction_id ON approval_execution_attempts
          BEGIN SELECT RAISE(ABORT,'approval_attempt_identity_immutable'); END;
        CREATE TRIGGER approval_notification_identity_immutable BEFORE UPDATE OF notification_attempt_id,request_id,kind,
          request_revision,presentation_revision,marker_mac,marker_key_version,clock_transaction_id ON approval_notifications
          BEGIN SELECT RAISE(ABORT,'approval_notification_identity_immutable'); END;
        CREATE TRIGGER approval_message_identity_immutable BEFORE UPDATE OF message_ref ON approval_notifications
          WHEN OLD.message_ref IS NOT NULL AND NEW.message_ref IS NOT OLD.message_ref
          BEGIN SELECT RAISE(ABORT,'approval_message_identity_immutable'); END;
        CREATE TRIGGER approval_event_identity_immutable BEFORE UPDATE OF event_id,decision_id,kind ON approval_event_outbox
          BEGIN SELECT RAISE(ABORT,'approval_event_identity_immutable'); END;
        CREATE TRIGGER approval_event_delivery_immutable BEFORE UPDATE OF state,delivered_at ON approval_event_outbox
          WHEN OLD.state='delivered' AND (NEW.state!='delivered' OR NEW.delivered_at IS NOT OLD.delivered_at)
          BEGIN SELECT RAISE(ABORT,'approval_event_delivery_immutable'); END;
        CREATE TRIGGER approval_request_terminal BEFORE UPDATE OF state ON approval_requests
          WHEN OLD.state IN ('rejected','cancelled','expired','delivery_failed','consumed','execution_cancelled','consume_expired','needs_review')
            AND NEW.state IS NOT OLD.state
          BEGIN SELECT RAISE(ABORT,'approval_request_terminal'); END;
        CREATE TRIGGER approval_execution_transition BEFORE UPDATE OF state ON approval_execution_attempts
          WHEN NEW.state IS NOT OLD.state AND NOT (
            (OLD.state='claimed' AND NEW.state IN ('executing','needs_review')) OR
            (OLD.state='executing' AND NEW.state IN ('succeeded','failed','acceptance_unknown','needs_review')) OR
            (OLD.state='acceptance_unknown' AND NEW.state IN ('succeeded','failed','needs_review')))
          BEGIN SELECT RAISE(ABORT,'approval_execution_transition'); END;
        CREATE TRIGGER approval_execution_result_immutable BEFORE UPDATE OF receipt_ref,failure_code ON approval_execution_attempts
          WHEN OLD.state IN ('succeeded','failed','needs_review')
            AND (NEW.receipt_ref IS NOT OLD.receipt_ref OR NEW.failure_code IS NOT OLD.failure_code)
          BEGIN SELECT RAISE(ABORT,'approval_execution_result_immutable'); END;
        CREATE TRIGGER approval_notification_transition BEFORE UPDATE OF state ON approval_notifications
          WHEN NEW.state IS NOT OLD.state AND NOT (
            (OLD.state='pending' AND NEW.state IN ('dispatching','aborted','needs_review')) OR
            (OLD.state='dispatching' AND NEW.state IN ('sent','failed','acceptance_unknown','needs_review')) OR
            (OLD.state='acceptance_unknown' AND NEW.state IN ('sent','needs_review')))
          BEGIN SELECT RAISE(ABORT,'approval_notification_transition'); END;
        CREATE TRIGGER approval_presentation_transition BEFORE UPDATE OF state ON approval_presentation_updates
          WHEN NEW.state IS NOT OLD.state AND NOT (
            (OLD.state='pending' AND NEW.state IN ('dispatching','aborted','needs_review')) OR
            (OLD.state='dispatching' AND NEW.state IN ('succeeded','failed','acceptance_unknown','needs_review')) OR
            (OLD.state='acceptance_unknown' AND NEW.state IN ('succeeded','failed','needs_review')))
          BEGIN SELECT RAISE(ABORT,'approval_presentation_transition'); END;
        CREATE TRIGGER approval_update_identity_immutable BEFORE UPDATE OF update_id,notification_attempt_id,message_ref,
          desired_revision,clock_transaction_id ON approval_presentation_updates
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
` + ["requests", "decisions", "consumes", "execution_attempts", "notifications", "presentation_updates"].map(name => `
        CREATE TRIGGER approval_${name}_clock_provenance BEFORE INSERT ON approval_${name}
          WHEN dona_clock_reference(NEW.clock_transaction_id) IS NOT 1
          BEGIN SELECT RAISE(ABORT,'approval_clock_provenance_unverified'); END;
`).join("");


const metadataSql = `
        CREATE TABLE approval_metadata_nodes (
          digest TEXT PRIMARY KEY NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*'),
          wire TEXT NOT NULL CHECK(length(CAST(wire AS BLOB)) IN (132,176))
        ) STRICT;
        CREATE TRIGGER approval_metadata_nodes_no_update BEFORE UPDATE ON approval_metadata_nodes
          BEGIN SELECT RAISE(ABORT,'approval_metadata_node_immutable'); END;
        CREATE TRIGGER approval_metadata_nodes_no_delete BEFORE DELETE ON approval_metadata_nodes
          BEGIN SELECT RAISE(ABORT,'approval_metadata_node_immutable'); END;
`;
const schemaV2Sql = schemaSql.replace("CHECK(version=1)", "CHECK(version=2)")
  .replace("INSERT INTO approval_schema VALUES (1)", "INSERT INTO approval_schema VALUES (2)") + metadataSql;

function shape(db: Database.Database): string {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(lower(name),1,9)='approval_' OR substr(lower(tbl_name),1,9)='approval_' ORDER BY type,name").all());
}
let expectedShapes: Map<number, string> | undefined;
/** Hot-path schema and connection checks only. Row-level foreign keys are
 * enforced by SQLite statements/commit, not a repeated historical row scan. */
function verifiedVersion(db: Database.Database): number {
  try {
    if (expectedShapes === undefined) {
      const computed = new Map<number, string>();
      for (const [version, sql] of [[1, schemaSql], [2, schemaV2Sql]] as const) {
        const expected = new Database(":memory:");
        try { expected.exec(sql); computed.set(version, shape(expected)); }
        finally { expected.close(); }
      }
      expectedShapes = computed;
    }
    if (db.pragma("recursive_triggers", { simple: true }) !== 1 || db.pragma("foreign_keys", { simple: true }) !== 1
      || db.pragma("ignore_check_constraints", { simple: true }) !== 0
      || db.pragma("encoding", { simple: true }) !== "UTF-8") throw new ApprovalSchemaError();
    const triggers = db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND substr(lower(name),1,9)!='approval_'").all() as Array<{name:string;tbl_name:string;sql:string}>;
    if (triggers.some(row => row.name !== "security_audit_no_update" || row.tbl_name !== "security_audit_records"
      || row.sql !== "CREATE TRIGGER security_audit_no_update BEFORE UPDATE ON security_audit_records\n          BEGIN SELECT RAISE(ABORT, 'security_audit_append_only'); END")) throw new ApprovalSchemaError();
    if (db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='trigger'").get()) throw new ApprovalSchemaError();
    if (db.prepare("SELECT 1 FROM sqlite_temp_master WHERE substr(lower(name),1,9)='approval_' OR substr(lower(tbl_name),1,9)='approval_'").get()) throw new ApprovalSchemaError();
    const actual = shape(db);
    const version = [...expectedShapes].find(([, expected]) => actual === expected)?.[0];
    if (version === undefined) throw new ApprovalSchemaError();
    const rows = db.prepare("SELECT version FROM approval_schema").all() as Array<{ version: number }>;
    if (rows.length !== 1 || rows[0]?.version !== version) throw new ApprovalSchemaError();
    return version;
  } catch { throw new ApprovalSchemaError(); }
}

export function verifyApprovalSchema(db: Database.Database): void { verifiedVersion(db); }
export function verifyApprovalMetadataSchema(db: Database.Database): void {
  if (verifiedVersion(db) !== 2) throw new ApprovalSchemaError();
}

function verifyIntegrityInside(db: Database.Database): void {
  verifyApprovalSchema(db);
  if (db.prepare("PRAGMA main.foreign_key_check").get()) throw new ApprovalSchemaError();
}

/** Full historical foreign-key inspection for connection admission and offline
 * restore/reconcile. It does not authenticate business rows or repair anything. */
export function verifyApprovalIntegrity(db: Database.Database): void {
  try {
    if (db.inTransaction) throw new ApprovalSchemaError();
    db.transaction(() => verifyIntegrityInside(db))();
  } catch { throw new ApprovalSchemaError(); }
}

/** Opt-in durable metadata only. Runtime migration, authenticated broker and the
 * transactional, backup-excluded payload store must be connected before use.
 * This installer never provisions bindings, credentials, clocks or audit roots. */
export function installApprovalSchema(db: Database.Database): void {
  try {
    loadSecurityExtension(db);
    if (db.inTransaction || db.pragma("foreign_keys", { simple: true }) !== 1
      || db.pragma("encoding", { simple: true }) !== "UTF-8") throw new ApprovalSchemaError();
    db.pragma("recursive_triggers = ON");
    db.transaction(() => {
      const prior = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approval_schema'").get();
      if (prior) {
        verifyIntegrityInside(db);
        return;
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE substr(lower(name),1,9)='approval_' OR substr(lower(tbl_name),1,9)='approval_'").get()) throw new ApprovalSchemaError();
      db.exec(schemaSql);
      verifyIntegrityInside(db);
    }).immediate();
  } catch { throw new ApprovalSchemaError(); }
}


/** 明示的なv1->v2 migration。既存recordと監査を維持し、node schema
 * だけを追加する。rootを作成せず既存recordの正当性を自己申告しない。 */
export function installApprovalMetadataSchema(db: Database.Database): void {
  try {
    loadSecurityExtension(db);
    if (db.inTransaction) throw new ApprovalSchemaError();
    withSecurityTransactionLock(db, () => {
      db.transaction(() => {
        assertSecurityDurability(db); verifyOpenDatabaseFile(db);
        verifyIntegrityInside(db);
        if (verifiedVersion(db) !== 2) {
          db.exec("DROP TABLE main.approval_schema");
          db.exec("CREATE TABLE approval_schema (version INTEGER PRIMARY KEY CHECK(version=2)) STRICT; INSERT INTO approval_schema VALUES (2)");
          db.exec(metadataSql);
          verifyIntegrityInside(db); verifyApprovalMetadataSchema(db);
        }
        // 既存v2でも省略せず、旧inodeへのmigrationを成功にしない。
        verifyOpenDatabaseFile(db);
      }).immediate();
      verifyOpenDatabaseFile(db);
    });
  } catch { throw new ApprovalSchemaError(); }
}
