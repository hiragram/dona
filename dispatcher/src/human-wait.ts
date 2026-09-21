import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const humanWaitResourceKinds = ["job", "job_group", "schedule_run", "notification", "agent_session"] as const;
export type HumanWaitResourceKind = (typeof humanWaitResourceKinds)[number];
export type HumanWaitOwnerKind = "human_verified" | "schedule" | "unknown";
export type HumanWaitState = "open" | "resolved" | "stale";
export type HumanWaitReasonCode = "human_input" | "ambiguous_write" | "invalid_result" | "notification_reconcile" | "operator_review_unknown";
export type HumanWaitDecisionKind = "provide_input" | "reconcile_write" | "review_result" | "operator_review";

export interface HumanWaitItemRow {
  item_id: string;
  dedupe_key: string;
  tenant_id: string | null;
  workspace_id: string | null;
  owner_kind: HumanWaitOwnerKind;
  owner_principal_kind: "human" | null;
  owner_principal_id: string | null;
  decision_actor_kind: "owner" | "operator";
  decision_kind: HumanWaitDecisionKind;
  resource_kind: HumanWaitResourceKind;
  resource_id: string;
  parent_resource_id: string | null;
  resource_revision: number;
  reason_code: HumanWaitReasonCode;
  origin_ref: string;
  source_revision: string;
  state: HumanWaitState;
  session_settlement_verified: 0 | 1;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
  stale_at: string | null;
  retain_until: string;
}

export interface HumanWaitRepairResult {
  dry_run: boolean;
  scanned: number;
  repaired: number;
  quarantined: number;
  next_cursor: string | null;
  snapshot_revision: string;
  digest: string;
}
export interface VerifiedHumanWaitSessionSettlement {
  provider_verified: true;
  event_id: string;
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
  desired_session_status: "active" | "suspended";
  session_status: "active" | "suspended";
}

export function dropHumanWaitTriggersForCoreMigration(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS human_wait_job_insert;
    DROP TRIGGER IF EXISTS human_wait_job_update;
    DROP TRIGGER IF EXISTS human_wait_job_binding_insert;
    DROP TRIGGER IF EXISTS human_wait_group_update;
    DROP TRIGGER IF EXISTS human_wait_schedule_run_insert;
    DROP TRIGGER IF EXISTS human_wait_schedule_run_update;
    DROP TRIGGER IF EXISTS human_wait_schedule_revision;
    DROP TRIGGER IF EXISTS human_wait_schedule_update;
    DROP TRIGGER IF EXISTS human_wait_completion_update;
    DROP TRIGGER IF EXISTS human_wait_outbox_insert;
    DROP TRIGGER IF EXISTS human_wait_outbox_update;
  `);
}

const openJobSql = `
  INSERT INTO human_wait_items(
    item_id,dedupe_key,tenant_id,workspace_id,owner_kind,owner_principal_kind,owner_principal_id,
    decision_actor_kind,decision_kind,resource_kind,resource_id,parent_resource_id,resource_revision,
    reason_code,origin_ref,source_revision,state,session_settlement_verified,opened_at,updated_at,
    resolved_at,stale_at,retain_until)
  SELECT
    'wait_'||lower(hex(randomblob(16))), 'job:'||NEW.job_id,
    CASE WHEN a.owner_kind='human_verified' THEN a.tenant_id WHEN json_extract(r.owner_json,'$.kind')='schedule' THEN json_extract(r.owner_json,'$.tenant_id') END,
    CASE WHEN a.owner_kind='human_verified' THEN a.workspace_id WHEN json_extract(r.owner_json,'$.kind')='schedule' THEN json_extract(r.owner_json,'$.tenant_id') END,
    CASE WHEN a.owner_kind='human_verified' THEN 'human_verified' WHEN json_extract(r.owner_json,'$.kind')='schedule' THEN 'schedule' ELSE 'unknown' END,
    CASE WHEN a.owner_kind='human_verified' OR json_extract(r.owner_json,'$.kind')='schedule' THEN 'human' END,
    CASE WHEN a.owner_kind='human_verified' THEN a.principal_id WHEN json_extract(r.owner_json,'$.kind')='schedule' THEN json_extract(r.owner_json,'$.owner_id') END,
    CASE WHEN NEW.status='blocked' THEN 'owner' ELSE 'operator' END,
    CASE WHEN NEW.status='blocked' THEN 'provide_input'
      WHEN NEW.last_error_code IN ('ambiguous_prompt_acceptance','prompt_acceptance_unknown','prompt_interrupted','steer_acceptance_unknown','cancel_acceptance_unknown','cancel_exit_unknown','ambiguous_cancel_acceptance','agent_wait_observation_unknown') THEN 'reconcile_write'
      WHEN NEW.last_error_code IN ('invalid_result','invalid_result_agent_stop_unknown','invalid_result_agent_stopped') THEN 'review_result'
      ELSE 'operator_review' END,
    'job',NEW.job_id,NEW.source_event_id,COALESCE(a.resource_revision,a.binding_revision,1),
    CASE WHEN NEW.status='blocked' THEN 'human_input'
      WHEN NEW.last_error_code IN ('ambiguous_prompt_acceptance','prompt_acceptance_unknown','prompt_interrupted','steer_acceptance_unknown','cancel_acceptance_unknown','cancel_exit_unknown','ambiguous_cancel_acceptance','agent_wait_observation_unknown') THEN 'ambiguous_write'
      WHEN NEW.last_error_code IN ('invalid_result','invalid_result_agent_stop_unknown','invalid_result_agent_stopped') THEN 'invalid_result'
      ELSE 'operator_review_unknown' END,
    'origin_'||lower(hex(randomblob(16))),NEW.updated_at,'open',0,NEW.updated_at,NEW.updated_at,NULL,NULL,
    datetime(NEW.updated_at,'+30 days')
  FROM (SELECT 1) seed
  LEFT JOIN job_authorization_bindings a ON a.job_id=NEW.job_id
  LEFT JOIN job_owner_bindings r ON r.job_id=NEW.job_id
  WHERE NEW.status IN ('blocked','needs_review') AND COALESCE(json_extract(r.owner_json,'$.kind'),'')!='schedule' AND NOT EXISTS (
    SELECT 1 FROM job_groups g WHERE g.source_event_id=NEW.source_event_id
      AND g.attention_event_id IS NOT NULL AND g.all_terminal_event_id IS NULL) AND NOT EXISTS (
    SELECT 1 FROM human_wait_quarantine q WHERE q.dedupe_key='job:'||NEW.job_id)
  ON CONFLICT(dedupe_key) DO UPDATE SET
    tenant_id=excluded.tenant_id,workspace_id=excluded.workspace_id,owner_kind=excluded.owner_kind,
    owner_principal_kind=excluded.owner_principal_kind,owner_principal_id=excluded.owner_principal_id,
    decision_actor_kind=excluded.decision_actor_kind,decision_kind=excluded.decision_kind,
    resource_revision=excluded.resource_revision,reason_code=excluded.reason_code,
    source_revision=excluded.source_revision,state='open',opened_at=CASE WHEN human_wait_items.state='open' THEN human_wait_items.opened_at ELSE excluded.opened_at END,
    session_settlement_verified=CASE WHEN human_wait_items.state='open' THEN human_wait_items.session_settlement_verified ELSE 0 END,
    updated_at=excluded.updated_at,
    resolved_at=NULL,stale_at=NULL,retain_until=excluded.retain_until`;

export function migrateHumanWaitReadModel(db: Database.Database): void {
  dropHumanWaitTriggersForCoreMigration(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS human_wait_schema(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS human_wait_items(
      item_id TEXT PRIMARY KEY CHECK(item_id GLOB 'wait_*'),
      dedupe_key TEXT NOT NULL UNIQUE,
      tenant_id TEXT, workspace_id TEXT,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('human_verified','schedule','unknown')),
      owner_principal_kind TEXT CHECK(owner_principal_kind='human' OR owner_principal_kind IS NULL),
      owner_principal_id TEXT,
      decision_actor_kind TEXT NOT NULL CHECK(decision_actor_kind IN ('owner','operator')),
      decision_kind TEXT NOT NULL CHECK(decision_kind IN ('provide_input','reconcile_write','review_result','operator_review')),
      resource_kind TEXT NOT NULL CHECK(resource_kind IN ('job','job_group','schedule_run','notification','agent_session')),
      resource_id TEXT NOT NULL, parent_resource_id TEXT,
      resource_revision INTEGER NOT NULL CHECK(resource_revision>0),
      reason_code TEXT NOT NULL CHECK(reason_code IN ('human_input','ambiguous_write','invalid_result','notification_reconcile','operator_review_unknown')),
      origin_ref TEXT NOT NULL UNIQUE CHECK(origin_ref GLOB 'origin_*'),
      source_revision TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open','resolved','stale')),
      session_settlement_verified INTEGER NOT NULL DEFAULT 0 CHECK(session_settlement_verified IN (0,1)),
      opened_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT, stale_at TEXT,
      retain_until TEXT NOT NULL,
      CHECK((owner_kind='unknown')=(owner_principal_id IS NULL)),
      CHECK((owner_principal_id IS NULL)=(owner_principal_kind IS NULL)),
      CHECK(state!='resolved' OR resolved_at IS NOT NULL),
      CHECK(state!='stale' OR stale_at IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS human_wait_owner_open_idx
      ON human_wait_items(tenant_id,workspace_id,owner_principal_id,updated_at,item_id) WHERE state='open';
    CREATE INDEX IF NOT EXISTS human_wait_retention_idx ON human_wait_items(retain_until,state);
    CREATE TABLE IF NOT EXISTS human_wait_audit(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT NOT NULL,reason_class TEXT NOT NULL,
      source_revision TEXT NOT NULL,transition TEXT NOT NULL CHECK(transition IN ('opened','reopened','resolved','stale','purged','quarantined')),
      actor_class TEXT NOT NULL CHECK(actor_class IN ('system','operator')),created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS human_wait_audit_retention_idx ON human_wait_audit(created_at,sequence);
    CREATE TABLE IF NOT EXISTS human_wait_quarantine(
      dedupe_key TEXT PRIMARY KEY,reason_class TEXT NOT NULL,source_revision TEXT NOT NULL,quarantined_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS human_wait_no_sensitive_insert BEFORE INSERT ON human_wait_items
      WHEN NEW.reason_code LIKE '%/%' OR NEW.origin_ref LIKE '%://%' OR NEW.origin_ref LIKE '%/%'
      BEGIN SELECT RAISE(ABORT,'human_wait_sensitive_value_denied'); END;
    CREATE TRIGGER IF NOT EXISTS human_wait_audit_insert AFTER INSERT ON human_wait_items BEGIN
      INSERT INTO human_wait_audit(item_id,reason_class,source_revision,transition,actor_class,created_at)
      VALUES(NEW.item_id,NEW.reason_code,NEW.source_revision,'opened','system',NEW.updated_at);
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_audit_state AFTER UPDATE OF state ON human_wait_items
      WHEN OLD.state!=NEW.state BEGIN
      INSERT INTO human_wait_audit(item_id,reason_class,source_revision,transition,actor_class,created_at)
      VALUES(NEW.item_id,NEW.reason_code,NEW.source_revision,
        CASE NEW.state WHEN 'open' THEN 'reopened' WHEN 'resolved' THEN 'resolved' ELSE 'stale' END,
        'system',NEW.updated_at);
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_job_insert AFTER INSERT ON jobs BEGIN
      ${openJobSql};
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_job_update AFTER UPDATE OF status,last_error_code,updated_at ON jobs BEGIN
      ${openJobSql};
      UPDATE human_wait_items SET state='resolved',resolved_at=NEW.updated_at,updated_at=NEW.updated_at,
        source_revision=NEW.updated_at,retain_until=datetime(NEW.updated_at,'+30 days')
      WHERE dedupe_key='job:'||NEW.job_id AND (NEW.status NOT IN ('blocked','needs_review') OR EXISTS (
        SELECT 1 FROM job_groups g WHERE g.source_event_id=NEW.source_event_id
          AND g.attention_event_id IS NOT NULL AND g.all_terminal_event_id IS NULL) OR EXISTS (
        SELECT 1 FROM job_owner_bindings b WHERE b.job_id=NEW.job_id AND json_extract(b.owner_json,'$.kind')='schedule'))
        AND state='open';
      UPDATE job_groups SET updated_at=NEW.updated_at WHERE source_event_id=NEW.source_event_id
        AND attention_event_id IS NOT NULL AND all_terminal_event_id IS NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_job_binding_insert AFTER INSERT ON job_authorization_bindings BEGIN
      UPDATE human_wait_items SET tenant_id=NEW.tenant_id,workspace_id=NEW.workspace_id,
        owner_kind=NEW.owner_kind,owner_principal_kind=NEW.principal_kind,owner_principal_id=NEW.principal_id,
        resource_revision=COALESCE(NEW.resource_revision,NEW.binding_revision),updated_at=NEW.created_at
      WHERE dedupe_key='job:'||NEW.job_id AND state='open' AND owner_kind='unknown' AND NEW.owner_kind='human_verified';
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_group_update AFTER UPDATE OF attention_event_id,all_terminal_event_id,updated_at ON job_groups BEGIN
      INSERT INTO human_wait_items(item_id,dedupe_key,tenant_id,workspace_id,owner_kind,owner_principal_kind,owner_principal_id,
        decision_actor_kind,decision_kind,resource_kind,resource_id,parent_resource_id,resource_revision,reason_code,
        origin_ref,source_revision,state,session_settlement_verified,opened_at,updated_at,resolved_at,stale_at,retain_until)
      SELECT 'wait_'||lower(hex(randomblob(16))),'group:'||NEW.source_event_id,
        MIN(a.tenant_id),MIN(a.workspace_id),
        CASE WHEN COUNT(*)=SUM(CASE WHEN a.owner_kind='human_verified' THEN 1 ELSE 0 END) THEN 'human_verified' ELSE 'unknown' END,
        CASE WHEN COUNT(*)=SUM(CASE WHEN a.owner_kind='human_verified' THEN 1 ELSE 0 END) THEN 'human' END,
        CASE WHEN COUNT(DISTINCT a.principal_id)=1 AND COUNT(*)=SUM(CASE WHEN a.owner_kind='human_verified' THEN 1 ELSE 0 END) THEN MIN(a.principal_id) END,
        'owner',CASE WHEN SUM(CASE WHEN j.status='blocked' THEN 1 ELSE 0 END)>0 THEN 'provide_input' ELSE 'operator_review' END,
        'job_group',NEW.source_event_id,NULL,MAX(COALESCE(a.resource_revision,a.binding_revision,1)),
        CASE WHEN SUM(CASE WHEN j.status='blocked' THEN 1 ELSE 0 END)>0 THEN 'human_input' ELSE 'operator_review_unknown' END,
        'origin_'||lower(hex(randomblob(16))),NEW.updated_at,'open',0,NEW.updated_at,NEW.updated_at,NULL,NULL,datetime(NEW.updated_at,'+30 days')
      FROM jobs j LEFT JOIN job_authorization_bindings a USING(job_id)
      WHERE j.source_event_id=NEW.source_event_id AND NEW.attention_event_id IS NOT NULL AND NEW.all_terminal_event_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM human_wait_quarantine q WHERE q.dedupe_key='group:'||NEW.source_event_id)
      HAVING COUNT(*)>0
      ON CONFLICT(dedupe_key) DO UPDATE SET tenant_id=excluded.tenant_id,workspace_id=excluded.workspace_id,
        owner_kind=excluded.owner_kind,owner_principal_kind=excluded.owner_principal_kind,owner_principal_id=excluded.owner_principal_id,
        decision_actor_kind=excluded.decision_actor_kind,decision_kind=excluded.decision_kind,resource_revision=excluded.resource_revision,
        reason_code=excluded.reason_code,source_revision=excluded.source_revision,state='open',
        opened_at=CASE WHEN human_wait_items.state='open' THEN human_wait_items.opened_at ELSE excluded.opened_at END,
        session_settlement_verified=CASE WHEN human_wait_items.state='open' THEN human_wait_items.session_settlement_verified ELSE 0 END,
        updated_at=excluded.updated_at,resolved_at=NULL,stale_at=NULL,retain_until=excluded.retain_until;
      UPDATE human_wait_items SET state='resolved',resolved_at=NEW.updated_at,updated_at=NEW.updated_at,source_revision=NEW.updated_at,
        retain_until=datetime(NEW.updated_at,'+30 days')
      WHERE parent_resource_id=NEW.source_event_id AND resource_kind='job' AND state='open'
        AND NEW.attention_event_id IS NOT NULL AND NEW.all_terminal_event_id IS NULL;
      UPDATE human_wait_items SET state='resolved',resolved_at=NEW.updated_at,updated_at=NEW.updated_at,source_revision=NEW.updated_at,
        retain_until=datetime(NEW.updated_at,'+30 days')
      WHERE dedupe_key='group:'||NEW.source_event_id AND state='open'
        AND (NEW.all_terminal_event_id IS NOT NULL OR NEW.attention_event_id IS NULL)
      ;
      UPDATE jobs SET updated_at=updated_at WHERE source_event_id=NEW.source_event_id
        AND (NEW.attention_event_id IS NULL OR NEW.all_terminal_event_id IS NOT NULL) AND status IN ('blocked','needs_review');
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_schedule_run_insert AFTER INSERT ON schedule_runs BEGIN
      INSERT INTO human_wait_items(item_id,dedupe_key,tenant_id,workspace_id,owner_kind,owner_principal_kind,owner_principal_id,
        decision_actor_kind,decision_kind,resource_kind,resource_id,parent_resource_id,resource_revision,reason_code,
        origin_ref,source_revision,state,session_settlement_verified,opened_at,updated_at,resolved_at,stale_at,retain_until)
      SELECT 'wait_'||lower(hex(randomblob(16))),'run:'||NEW.run_id,s.tenant_id,s.tenant_id,'schedule','human',s.owner_id,
        'owner',CASE COALESCE(NEW.wait_reason,NEW.reason) WHEN 'human_input' THEN 'provide_input' WHEN 'invalid_result' THEN 'review_result' WHEN 'ambiguous_write' THEN 'reconcile_write' ELSE 'operator_review' END,
        'schedule_run',NEW.run_id,NEW.schedule_id,NEW.revision,
        CASE WHEN COALESCE(NEW.wait_reason,NEW.reason) IN ('human_input','invalid_result','ambiguous_write') THEN COALESCE(NEW.wait_reason,NEW.reason) ELSE 'operator_review_unknown' END,
        'origin_'||lower(hex(randomblob(16))),COALESCE(NEW.terminal_at,NEW.created_at),'open',0,
        COALESCE(NEW.terminal_at,NEW.created_at),COALESCE(NEW.terminal_at,NEW.created_at),NULL,NULL,datetime(COALESCE(NEW.terminal_at,NEW.created_at),'+30 days')
      FROM schedules s WHERE s.schedule_id=NEW.schedule_id AND NEW.status='needs_review' AND s.revision=NEW.revision
        AND NOT EXISTS (SELECT 1 FROM human_wait_quarantine q WHERE q.dedupe_key='run:'||NEW.run_id)
      ON CONFLICT(dedupe_key) DO NOTHING;
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_schedule_run_update AFTER UPDATE OF status,reason,wait_reason,terminal_at ON schedule_runs BEGIN
      INSERT INTO human_wait_items(item_id,dedupe_key,tenant_id,workspace_id,owner_kind,owner_principal_kind,owner_principal_id,
        decision_actor_kind,decision_kind,resource_kind,resource_id,parent_resource_id,resource_revision,reason_code,
        origin_ref,source_revision,state,session_settlement_verified,opened_at,updated_at,resolved_at,stale_at,retain_until)
      SELECT 'wait_'||lower(hex(randomblob(16))),'run:'||NEW.run_id,s.tenant_id,s.tenant_id,'schedule','human',s.owner_id,
        'owner',CASE COALESCE(NEW.wait_reason,NEW.reason) WHEN 'human_input' THEN 'provide_input' WHEN 'invalid_result' THEN 'review_result' WHEN 'ambiguous_write' THEN 'reconcile_write' ELSE 'operator_review' END,
        'schedule_run',NEW.run_id,NEW.schedule_id,NEW.revision,
        CASE WHEN COALESCE(NEW.wait_reason,NEW.reason) IN ('human_input','invalid_result','ambiguous_write') THEN COALESCE(NEW.wait_reason,NEW.reason) ELSE 'operator_review_unknown' END,
        'origin_'||lower(hex(randomblob(16))),COALESCE(NEW.terminal_at,s.updated_at),'open',0,
        COALESCE(NEW.terminal_at,s.updated_at),COALESCE(NEW.terminal_at,s.updated_at),NULL,NULL,datetime(COALESCE(NEW.terminal_at,s.updated_at),'+30 days')
      FROM schedules s WHERE s.schedule_id=NEW.schedule_id AND NEW.status='needs_review' AND s.revision=NEW.revision
        AND NOT EXISTS (SELECT 1 FROM human_wait_quarantine q WHERE q.dedupe_key='run:'||NEW.run_id)
      ON CONFLICT(dedupe_key) DO UPDATE SET reason_code=excluded.reason_code,decision_kind=excluded.decision_kind,
        source_revision=excluded.source_revision,state='open',opened_at=CASE WHEN human_wait_items.state='open' THEN human_wait_items.opened_at ELSE excluded.opened_at END,
        session_settlement_verified=CASE WHEN human_wait_items.state='open' THEN human_wait_items.session_settlement_verified ELSE 0 END,
        updated_at=excluded.updated_at,resolved_at=NULL,stale_at=NULL;
      UPDATE human_wait_items SET state='resolved',resolved_at=COALESCE(NEW.terminal_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at=COALESCE(NEW.terminal_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        source_revision=COALESCE(NEW.terminal_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        retain_until=datetime(COALESCE(NEW.terminal_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'+30 days')
      WHERE dedupe_key='run:'||NEW.run_id AND (NEW.status!='needs_review' OR NEW.revision!=(SELECT revision FROM schedules WHERE schedule_id=NEW.schedule_id)) AND state='open';
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_schedule_revision AFTER UPDATE OF revision ON schedules BEGIN
      UPDATE human_wait_items SET state='stale',stale_at=NEW.updated_at,updated_at=NEW.updated_at,source_revision=NEW.updated_at,
        retain_until=datetime(NEW.updated_at,'+30 days')
      WHERE resource_revision!=NEW.revision AND state='open' AND (
        (resource_kind='schedule_run' AND parent_resource_id=NEW.schedule_id) OR
        (resource_kind='notification' AND EXISTS (
          SELECT 1 FROM connector_outbox o JOIN schedule_runs r ON r.run_id=o.run_id
          WHERE o.outbox_id=human_wait_items.resource_id AND r.schedule_id=NEW.schedule_id)) OR
        (resource_kind='notification' AND EXISTS (
          SELECT 1 FROM job_owner_bindings b WHERE b.job_id=human_wait_items.parent_resource_id
            AND json_extract(b.owner_json,'$.schedule_id')=NEW.schedule_id))
      );
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_schedule_update AFTER UPDATE OF updated_at ON schedules BEGIN
      UPDATE human_wait_items SET source_revision=NEW.updated_at,updated_at=NEW.updated_at,retain_until=datetime(NEW.updated_at,'+30 days')
      WHERE resource_kind='schedule_run' AND parent_resource_id=NEW.schedule_id AND resource_revision=NEW.revision AND state='open'
        AND EXISTS (SELECT 1 FROM schedule_runs r WHERE r.run_id=human_wait_items.resource_id AND r.status='needs_review' AND r.revision=NEW.revision)
        AND julianday(source_revision)<julianday(NEW.updated_at);
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_completion_update AFTER UPDATE OF notification_state,notification_event_id ON job_completion_results BEGIN
      INSERT INTO human_wait_items(item_id,dedupe_key,tenant_id,workspace_id,owner_kind,owner_principal_kind,owner_principal_id,
        decision_actor_kind,decision_kind,resource_kind,resource_id,parent_resource_id,resource_revision,reason_code,
        origin_ref,source_revision,state,session_settlement_verified,opened_at,updated_at,resolved_at,stale_at,retain_until)
      SELECT 'wait_'||lower(hex(randomblob(16))),'notification:'||NEW.job_id||':'||NEW.job_status,
        json_extract(NEW.owner_json,'$.tenant_id'),json_extract(NEW.owner_json,'$.tenant_id'),'schedule','human',json_extract(NEW.owner_json,'$.owner_id'),
        'owner','reconcile_write','notification',COALESCE(NEW.notification_event_id,NEW.job_id),NEW.job_id,
        COALESCE(json_extract(NEW.owner_json,'$.revision'),1),'notification_reconcile','origin_'||lower(hex(randomblob(16))),
        MAX(COALESCE((SELECT MAX(o.updated_at) FROM connector_outbox o JOIN schedule_runs r USING(run_id)
          WHERE r.job_id=NEW.job_id AND o.completion_job_status=NEW.job_status),NEW.materialized_at),COALESCE((SELECT updated_at FROM events WHERE event_id=NEW.notification_event_id),NEW.materialized_at),NEW.materialized_at),'open',0,
        MAX(COALESCE((SELECT MAX(o.updated_at) FROM connector_outbox o JOIN schedule_runs r USING(run_id)
          WHERE r.job_id=NEW.job_id AND o.completion_job_status=NEW.job_status),NEW.materialized_at),COALESCE((SELECT updated_at FROM events WHERE event_id=NEW.notification_event_id),NEW.materialized_at),NEW.materialized_at),MAX(COALESCE((SELECT MAX(o.updated_at) FROM connector_outbox o JOIN schedule_runs r USING(run_id)
          WHERE r.job_id=NEW.job_id AND o.completion_job_status=NEW.job_status),NEW.materialized_at),COALESCE((SELECT updated_at FROM events WHERE event_id=NEW.notification_event_id),NEW.materialized_at),NEW.materialized_at),NULL,NULL,NEW.content_delete_at
      WHERE json_extract(NEW.owner_json,'$.kind')='schedule' AND NEW.notification_state='needs_review' AND
        (NEW.job_status IN ('blocked','needs_review') OR NEW.notification_event_id IS NULL OR EXISTS (SELECT 1 FROM events e WHERE e.event_id=NEW.notification_event_id AND e.status IN ('completed','blocked','needs_review','dead_letter'))) AND EXISTS (
        SELECT 1 FROM schedules s WHERE s.schedule_id=json_extract(NEW.owner_json,'$.schedule_id')
          AND s.revision=COALESCE(json_extract(NEW.owner_json,'$.revision'),1)) AND NOT EXISTS (
        SELECT 1 FROM human_wait_quarantine q WHERE q.dedupe_key='notification:'||NEW.job_id||':'||NEW.job_status)
      ON CONFLICT(dedupe_key) DO UPDATE SET resource_id=excluded.resource_id,source_revision=excluded.source_revision,state='open',
        opened_at=CASE WHEN human_wait_items.state='open' THEN human_wait_items.opened_at ELSE excluded.opened_at END,
        session_settlement_verified=CASE WHEN human_wait_items.state='open' THEN human_wait_items.session_settlement_verified ELSE 0 END,updated_at=excluded.updated_at,
        resolved_at=NULL,stale_at=NULL;
      UPDATE human_wait_items SET state='resolved',
        resolved_at=MAX(COALESCE((SELECT MAX(o.updated_at) FROM connector_outbox o JOIN schedule_runs r USING(run_id)
          WHERE r.job_id=NEW.job_id AND o.completion_job_status=NEW.job_status),NEW.materialized_at),COALESCE((SELECT updated_at FROM events WHERE event_id=NEW.notification_event_id),NEW.materialized_at),NEW.materialized_at),
        updated_at=MAX(COALESCE((SELECT MAX(o.updated_at) FROM connector_outbox o JOIN schedule_runs r USING(run_id)
          WHERE r.job_id=NEW.job_id AND o.completion_job_status=NEW.job_status),NEW.materialized_at),COALESCE((SELECT updated_at FROM events WHERE event_id=NEW.notification_event_id),NEW.materialized_at),NEW.materialized_at),
        source_revision=MAX(COALESCE((SELECT MAX(o.updated_at) FROM connector_outbox o JOIN schedule_runs r USING(run_id)
          WHERE r.job_id=NEW.job_id AND o.completion_job_status=NEW.job_status),NEW.materialized_at),COALESCE((SELECT updated_at FROM events WHERE event_id=NEW.notification_event_id),NEW.materialized_at),NEW.materialized_at),
        retain_until=datetime(MAX(COALESCE((SELECT MAX(o.updated_at) FROM connector_outbox o JOIN schedule_runs r USING(run_id)
          WHERE r.job_id=NEW.job_id AND o.completion_job_status=NEW.job_status),NEW.materialized_at),COALESCE((SELECT updated_at FROM events WHERE event_id=NEW.notification_event_id),NEW.materialized_at),NEW.materialized_at),'+30 days')
      WHERE dedupe_key='notification:'||NEW.job_id||':'||NEW.job_status AND state='open' AND (
        NEW.notification_state!='needs_review' OR (NEW.job_status NOT IN ('blocked','needs_review') AND NEW.notification_event_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM events e WHERE e.event_id=NEW.notification_event_id AND e.status IN ('completed','blocked','needs_review','dead_letter'))) OR NOT EXISTS (
          SELECT 1 FROM schedules s WHERE s.schedule_id=json_extract(NEW.owner_json,'$.schedule_id')
            AND s.revision=COALESCE(json_extract(NEW.owner_json,'$.revision'),1)));
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_outbox_insert AFTER INSERT ON connector_outbox BEGIN
      INSERT INTO human_wait_items(item_id,dedupe_key,tenant_id,workspace_id,owner_kind,owner_principal_kind,owner_principal_id,
        decision_actor_kind,decision_kind,resource_kind,resource_id,parent_resource_id,resource_revision,reason_code,
        origin_ref,source_revision,state,session_settlement_verified,opened_at,updated_at,resolved_at,stale_at,retain_until)
      SELECT 'wait_'||lower(hex(randomblob(16))),'outbox:'||NEW.outbox_id,s.tenant_id,s.tenant_id,'schedule','human',s.owner_id,
        'owner','reconcile_write','notification',NEW.outbox_id,NEW.run_id,r.revision,'ambiguous_write',
        'origin_'||lower(hex(randomblob(16))),NEW.updated_at,'open',0,NEW.updated_at,NEW.updated_at,NULL,NULL,
        COALESCE(NEW.content_delete_at,datetime(NEW.updated_at,'+30 days'))
      FROM schedule_runs r JOIN schedules s USING(schedule_id)
      WHERE r.run_id=NEW.run_id AND NEW.status='needs_review' AND NEW.kind!='slack.work_result.post' AND s.revision=r.revision
        AND NOT EXISTS (SELECT 1 FROM human_wait_quarantine q WHERE q.dedupe_key='outbox:'||NEW.outbox_id)
      ON CONFLICT(dedupe_key) DO NOTHING;
    END;
    CREATE TRIGGER IF NOT EXISTS human_wait_outbox_update AFTER UPDATE OF status,updated_at ON connector_outbox BEGIN
      INSERT INTO human_wait_items(item_id,dedupe_key,tenant_id,workspace_id,owner_kind,owner_principal_kind,owner_principal_id,
        decision_actor_kind,decision_kind,resource_kind,resource_id,parent_resource_id,resource_revision,reason_code,
        origin_ref,source_revision,state,session_settlement_verified,opened_at,updated_at,resolved_at,stale_at,retain_until)
      SELECT 'wait_'||lower(hex(randomblob(16))),'outbox:'||NEW.outbox_id,s.tenant_id,s.tenant_id,'schedule','human',s.owner_id,
        'owner','reconcile_write','notification',NEW.outbox_id,NEW.run_id,r.revision,'ambiguous_write',
        'origin_'||lower(hex(randomblob(16))),NEW.updated_at,'open',0,NEW.updated_at,NEW.updated_at,NULL,NULL,
        COALESCE(NEW.content_delete_at,datetime(NEW.updated_at,'+30 days'))
      FROM schedule_runs r JOIN schedules s USING(schedule_id)
      WHERE r.run_id=NEW.run_id AND NEW.status='needs_review' AND NEW.kind!='slack.work_result.post' AND s.revision=r.revision
        AND NOT EXISTS (SELECT 1 FROM human_wait_quarantine q WHERE q.dedupe_key='outbox:'||NEW.outbox_id)
      ON CONFLICT(dedupe_key) DO UPDATE SET source_revision=excluded.source_revision,state='open',
        opened_at=CASE WHEN human_wait_items.state='open' THEN human_wait_items.opened_at ELSE excluded.opened_at END,
        session_settlement_verified=CASE WHEN human_wait_items.state='open' THEN human_wait_items.session_settlement_verified ELSE 0 END,updated_at=excluded.updated_at,
        resolved_at=NULL,stale_at=NULL;
      UPDATE human_wait_items SET state='resolved',resolved_at=NEW.updated_at,updated_at=NEW.updated_at,source_revision=NEW.updated_at,
        retain_until=datetime(NEW.updated_at,'+30 days')
      WHERE dedupe_key='outbox:'||NEW.outbox_id AND state='open' AND (NEW.status!='needs_review' OR NEW.kind='slack.work_result.post' OR EXISTS (
        SELECT 1 FROM schedule_runs r JOIN schedules s USING(schedule_id)
        WHERE r.run_id=NEW.run_id AND r.revision!=s.revision));
    END;
    INSERT OR IGNORE INTO human_wait_schema VALUES(1,1);
  `);
  const marker = db.prepare("SELECT version FROM human_wait_schema WHERE singleton=1").get() as {version:number}|undefined;
  if (marker?.version !== 1) throw new Error("unsupported_human_wait_schema");
}

export class HumanWaitRepository {
  constructor(private readonly db: Database.Database) {}

  get(itemId: string): HumanWaitItemRow | undefined {
    return this.db.prepare("SELECT * FROM human_wait_items WHERE item_id=?").get(itemId) as HumanWaitItemRow | undefined;
  }

  listInternal(state: HumanWaitState = "open"): HumanWaitItemRow[] {
    return this.db.prepare(`SELECT * FROM human_wait_items i WHERE state=? AND NOT EXISTS (
      SELECT 1 FROM human_wait_quarantine q WHERE q.dedupe_key=i.dedupe_key) ORDER BY updated_at,item_id`).all(state) as HumanWaitItemRow[];
  }

  recordVerifiedSessionSettlement(receipt: VerifiedHumanWaitSessionSettlement, settledAt: string): boolean {
    if (!Number.isFinite(Date.parse(settledAt)) || new Date(Date.parse(settledAt)).toISOString() !== settledAt) throw new Error("invalid_session_settlement_time");
    return this.db.transaction(() => {
      const completion = this.db.prepare(`SELECT job_id,job_status,destination_json,owner_json FROM job_completion_results WHERE notification_event_id=?
        UNION ALL SELECT j.job_id,j.status AS job_status,b.destination_json,b.owner_json FROM jobs j JOIN job_owner_bindings b USING(job_id)
          WHERE j.completion_event_id=? LIMIT 1`).get(receipt.event_id,receipt.event_id) as {job_id:string;job_status:string;destination_json:string;owner_json:string}|undefined;
      if (!completion) return false;
      const destination=JSON.parse(completion.destination_json) as {kind?:unknown;workspace_id?:unknown;channel_id?:unknown;thread_ts?:unknown;target?:Record<string,unknown>};
      const target=destination.kind==="slack"?destination.target:destination;
      if(receipt.provider_verified!==true||receipt.desired_session_status!=="suspended"||receipt.session_status!=="suspended"||
        (target?.kind!=="thread"&&target?.kind!=="slack_thread")||
        target.workspace_id!==receipt.workspace_id||target.channel_id!==receipt.channel_id||target.thread_ts!==receipt.thread_ts) return false;
      const job = this.db.prepare("SELECT status,updated_at,source_event_id FROM jobs WHERE job_id=?").get(completion.job_id) as {status:string;updated_at:string;source_event_id:string}|undefined;
      const owner=JSON.parse(completion.owner_json) as {kind?:unknown;run_id?:unknown};
      const runDedupe=owner.kind==="schedule"&&typeof owner.run_id==="string"?`run:${owner.run_id}`:"";
      const cause = job ? this.db.prepare(`SELECT * FROM human_wait_items WHERE state='open' AND
        dedupe_key IN (?,?,?,?) ORDER BY CASE resource_kind WHEN 'schedule_run' THEN 0 WHEN 'notification' THEN 1 WHEN 'job_group' THEN 2 ELSE 3 END LIMIT 1`)
        .get(`job:${completion.job_id}`,`group:${job.source_event_id}`,`notification:${completion.job_id}:${completion.job_status}`,runDedupe) as HumanWaitItemRow | undefined : undefined;
      if (!job || !cause || Date.parse(settledAt)<Date.parse(cause.opened_at) ||
        (cause.resource_kind==="job" && !["blocked","needs_review"].includes(job.status))) return false;
      if(cause.session_settlement_verified===1)return true;
      const changed=this.db.prepare(`UPDATE human_wait_items SET session_settlement_verified=1
        WHERE item_id=? AND state='open'`).run(cause.item_id).changes;
      if(changed!==1)return false;
      return true;
    }).immediate();
  }

  repair(input: { dryRun: boolean; limit: number; cursor?: string | null; snapshotRevision: string }): HumanWaitRepairResult {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new Error("human_wait_repair_limit_invalid");
    if (!Number.isFinite(Date.parse(input.snapshotRevision)) || new Date(Date.parse(input.snapshotRevision)).toISOString() !== input.snapshotRevision) throw new Error("human_wait_snapshot_invalid");
    type Candidate={source_key:string;kind:"job"|"group"|"run"|"completion"|"outbox";resource_id:string;projected_resource_id:string;aux_id:string|null;source_revision:string;desired_open:number;dedupe_key:string};
    type ExpectedProjection=Pick<HumanWaitItemRow,"tenant_id"|"workspace_id"|"owner_kind"|"owner_principal_kind"|"owner_principal_id"|
      "decision_actor_kind"|"decision_kind"|"resource_kind"|"resource_id"|"parent_resource_id"|"resource_revision"|"reason_code"|"source_revision">;
    const expectedProjection=(row:Candidate):ExpectedProjection|undefined=>{
      if(row.kind==="job")return this.db.prepare(`SELECT
        CASE WHEN a.owner_kind='human_verified' THEN a.tenant_id WHEN json_extract(b.owner_json,'$.kind')='schedule' THEN json_extract(b.owner_json,'$.tenant_id') END AS tenant_id,
        CASE WHEN a.owner_kind='human_verified' THEN a.workspace_id WHEN json_extract(b.owner_json,'$.kind')='schedule' THEN json_extract(b.owner_json,'$.tenant_id') END AS workspace_id,
        CASE WHEN a.owner_kind='human_verified' THEN 'human_verified' WHEN json_extract(b.owner_json,'$.kind')='schedule' THEN 'schedule' ELSE 'unknown' END AS owner_kind,
        CASE WHEN a.owner_kind='human_verified' OR json_extract(b.owner_json,'$.kind')='schedule' THEN 'human' END AS owner_principal_kind,
        CASE WHEN a.owner_kind='human_verified' THEN a.principal_id WHEN json_extract(b.owner_json,'$.kind')='schedule' THEN json_extract(b.owner_json,'$.owner_id') END AS owner_principal_id,
        CASE WHEN j.status='blocked' THEN 'owner' ELSE 'operator' END AS decision_actor_kind,
        CASE WHEN j.status='blocked' THEN 'provide_input' WHEN j.last_error_code IN ('ambiguous_prompt_acceptance','prompt_acceptance_unknown','prompt_interrupted','steer_acceptance_unknown','cancel_acceptance_unknown','cancel_exit_unknown','ambiguous_cancel_acceptance','agent_wait_observation_unknown') THEN 'reconcile_write'
          WHEN j.last_error_code IN ('invalid_result','invalid_result_agent_stop_unknown','invalid_result_agent_stopped') THEN 'review_result' ELSE 'operator_review' END AS decision_kind,
        'job' AS resource_kind,j.job_id AS resource_id,j.source_event_id AS parent_resource_id,COALESCE(a.resource_revision,a.binding_revision,1) AS resource_revision,
        CASE WHEN j.status='blocked' THEN 'human_input' WHEN j.last_error_code IN ('ambiguous_prompt_acceptance','prompt_acceptance_unknown','prompt_interrupted','steer_acceptance_unknown','cancel_acceptance_unknown','cancel_exit_unknown','ambiguous_cancel_acceptance','agent_wait_observation_unknown') THEN 'ambiguous_write'
          WHEN j.last_error_code IN ('invalid_result','invalid_result_agent_stop_unknown','invalid_result_agent_stopped') THEN 'invalid_result' ELSE 'operator_review_unknown' END AS reason_code,
        j.updated_at AS source_revision
        FROM jobs j LEFT JOIN job_authorization_bindings a USING(job_id) LEFT JOIN job_owner_bindings b USING(job_id) WHERE j.job_id=?`).get(row.resource_id) as ExpectedProjection|undefined;
      if(row.kind==="group")return this.db.prepare(`SELECT MIN(a.tenant_id) AS tenant_id,MIN(a.workspace_id) AS workspace_id,
        CASE WHEN COUNT(*)=SUM(CASE WHEN a.owner_kind='human_verified' THEN 1 ELSE 0 END) THEN 'human_verified' ELSE 'unknown' END AS owner_kind,
        CASE WHEN COUNT(*)=SUM(CASE WHEN a.owner_kind='human_verified' THEN 1 ELSE 0 END) THEN 'human' END AS owner_principal_kind,
        CASE WHEN COUNT(DISTINCT a.principal_id)=1 AND COUNT(*)=SUM(CASE WHEN a.owner_kind='human_verified' THEN 1 ELSE 0 END) THEN MIN(a.principal_id) END AS owner_principal_id,
        'owner' AS decision_actor_kind,CASE WHEN SUM(CASE WHEN j.status='blocked' THEN 1 ELSE 0 END)>0 THEN 'provide_input' ELSE 'operator_review' END AS decision_kind,
        'job_group' AS resource_kind,j.source_event_id AS resource_id,NULL AS parent_resource_id,MAX(COALESCE(a.resource_revision,a.binding_revision,1)) AS resource_revision,
        CASE WHEN SUM(CASE WHEN j.status='blocked' THEN 1 ELSE 0 END)>0 THEN 'human_input' ELSE 'operator_review_unknown' END AS reason_code,
        g.updated_at AS source_revision FROM job_groups g JOIN jobs j USING(source_event_id) LEFT JOIN job_authorization_bindings a USING(job_id)
        WHERE g.source_event_id=? GROUP BY g.source_event_id`).get(row.resource_id) as ExpectedProjection|undefined;
      if(row.kind==="run")return this.db.prepare(`SELECT s.tenant_id AS tenant_id,s.tenant_id AS workspace_id,'schedule' AS owner_kind,'human' AS owner_principal_kind,s.owner_id AS owner_principal_id,
        'owner' AS decision_actor_kind,CASE COALESCE(r.wait_reason,r.reason) WHEN 'human_input' THEN 'provide_input' WHEN 'invalid_result' THEN 'review_result' WHEN 'ambiguous_write' THEN 'reconcile_write' ELSE 'operator_review' END AS decision_kind,
        'schedule_run' AS resource_kind,r.run_id AS resource_id,r.schedule_id AS parent_resource_id,r.revision AS resource_revision,
        CASE WHEN COALESCE(r.wait_reason,r.reason) IN ('human_input','invalid_result','ambiguous_write') THEN COALESCE(r.wait_reason,r.reason) ELSE 'operator_review_unknown' END AS reason_code,
        CASE WHEN julianday(COALESCE(r.terminal_at,r.created_at))>=julianday(s.updated_at) THEN COALESCE(r.terminal_at,r.created_at) ELSE s.updated_at END AS source_revision
        FROM schedule_runs r JOIN schedules s USING(schedule_id) WHERE r.run_id=?`).get(row.resource_id) as ExpectedProjection|undefined;
      if(row.kind==="completion")return this.db.prepare(`SELECT json_extract(owner_json,'$.tenant_id') AS tenant_id,json_extract(owner_json,'$.tenant_id') AS workspace_id,
        'schedule' AS owner_kind,'human' AS owner_principal_kind,json_extract(owner_json,'$.owner_id') AS owner_principal_id,'owner' AS decision_actor_kind,
        'reconcile_write' AS decision_kind,'notification' AS resource_kind,COALESCE(notification_event_id,job_id) AS resource_id,job_id AS parent_resource_id,
        COALESCE(json_extract(owner_json,'$.revision'),1) AS resource_revision,'notification_reconcile' AS reason_code,
        MAX(COALESCE((SELECT MAX(o.updated_at) FROM connector_outbox o JOIN schedule_runs r USING(run_id)
          WHERE r.job_id=job_completion_results.job_id AND o.completion_job_status=job_completion_results.job_status),materialized_at),
          COALESCE((SELECT updated_at FROM events WHERE event_id=notification_event_id),materialized_at),materialized_at) AS source_revision
        FROM job_completion_results WHERE job_id=? AND job_status=?`).get(row.resource_id,row.aux_id) as ExpectedProjection|undefined;
      return this.db.prepare(`SELECT s.tenant_id AS tenant_id,s.tenant_id AS workspace_id,'schedule' AS owner_kind,'human' AS owner_principal_kind,s.owner_id AS owner_principal_id,
        'owner' AS decision_actor_kind,'reconcile_write' AS decision_kind,'notification' AS resource_kind,o.outbox_id AS resource_id,o.run_id AS parent_resource_id,
        r.revision AS resource_revision,'ambiguous_write' AS reason_code,o.updated_at AS source_revision FROM connector_outbox o JOIN schedule_runs r USING(run_id) JOIN schedules s USING(schedule_id)
        WHERE o.outbox_id=?`).get(row.resource_id) as ExpectedProjection|undefined;
    };
    const currentDesiredOpen=(row:Candidate):boolean=>{
      if(row.kind==="job")return this.db.prepare(`SELECT 1 FROM jobs j WHERE j.job_id=? AND j.status IN ('blocked','needs_review')
        AND NOT EXISTS (SELECT 1 FROM job_groups g WHERE g.source_event_id=j.source_event_id AND g.attention_event_id IS NOT NULL AND g.all_terminal_event_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM job_owner_bindings b WHERE b.job_id=j.job_id AND json_extract(b.owner_json,'$.kind')='schedule')`).get(row.resource_id)!==undefined;
      if(row.kind==="group")return this.db.prepare("SELECT 1 FROM job_groups WHERE source_event_id=? AND attention_event_id IS NOT NULL AND all_terminal_event_id IS NULL")
        .get(row.resource_id)!==undefined;
      if(row.kind==="run")return this.db.prepare(`SELECT 1 FROM schedule_runs r JOIN schedules s USING(schedule_id)
        WHERE r.run_id=? AND r.status='needs_review' AND r.revision=s.revision`).get(row.resource_id)!==undefined;
      if(row.kind==="completion")return this.db.prepare(`SELECT 1 FROM job_completion_results c JOIN schedules s
        ON s.schedule_id=json_extract(c.owner_json,'$.schedule_id') WHERE c.job_id=? AND c.job_status=?
        AND json_extract(c.owner_json,'$.kind')='schedule' AND c.notification_state='needs_review'
        AND (c.job_status IN ('blocked','needs_review') OR c.notification_event_id IS NULL OR EXISTS (SELECT 1 FROM events e WHERE e.event_id=c.notification_event_id AND e.status IN ('completed','blocked','needs_review','dead_letter')))
        AND s.revision=COALESCE(json_extract(c.owner_json,'$.revision'),1)`).get(row.resource_id,row.aux_id)!==undefined;
      return this.db.prepare(`SELECT 1 FROM connector_outbox o JOIN schedule_runs r USING(run_id) JOIN schedules s USING(schedule_id)
        WHERE o.outbox_id=? AND o.status='needs_review' AND o.kind!='slack.work_result.post' AND r.revision=s.revision`).get(row.resource_id)!==undefined;
    };
    const obsoleteScheduleRevision=(row:Candidate):boolean=>{
      if(row.kind==="run")return this.db.prepare(`SELECT 1 FROM schedule_runs r JOIN schedules s USING(schedule_id)
        WHERE r.run_id=? AND r.revision!=s.revision`).get(row.resource_id)!==undefined;
      if(row.kind==="completion")return this.db.prepare(`SELECT 1 FROM job_completion_results c JOIN schedules s
        ON s.schedule_id=json_extract(c.owner_json,'$.schedule_id') WHERE c.job_id=? AND c.job_status=?
        AND json_extract(c.owner_json,'$.kind')='schedule' AND s.revision!=COALESCE(json_extract(c.owner_json,'$.revision'),1)`)
        .get(row.resource_id,row.aux_id)!==undefined;
      if(row.kind==="outbox")return this.db.prepare(`SELECT 1 FROM connector_outbox o JOIN schedule_runs r USING(run_id) JOIN schedules s USING(schedule_id)
        WHERE o.outbox_id=? AND r.revision!=s.revision`).get(row.resource_id)!==undefined;
      return false;
    };
    const derivedProjectionMismatch=(item:HumanWaitItemRow,expected:ExpectedProjection)=>
      Object.entries(expected).some(([key,value])=>key!=="source_revision"&&item[key as keyof HumanWaitItemRow]!==value);
    const projectionMismatch=(item:HumanWaitItemRow,expected:ExpectedProjection,row:Candidate)=>
      item.source_revision!==row.source_revision||derivedProjectionMismatch(item,expected);
    const rows = this.db.prepare(`SELECT * FROM (
      SELECT 'job:'||j.job_id AS source_key,'job' AS kind,j.job_id AS resource_id,j.job_id AS projected_resource_id,NULL AS aux_id,j.updated_at AS source_revision,
        CASE WHEN j.status IN ('blocked','needs_review') AND NOT EXISTS (SELECT 1 FROM job_groups g WHERE g.source_event_id=j.source_event_id AND g.attention_event_id IS NOT NULL AND g.all_terminal_event_id IS NULL)
          AND NOT EXISTS (SELECT 1 FROM job_owner_bindings b WHERE b.job_id=j.job_id AND json_extract(b.owner_json,'$.kind')='schedule') THEN 1 ELSE 0 END AS desired_open,
        'job:'||j.job_id AS dedupe_key FROM jobs j
      UNION ALL SELECT 'group:'||g.source_event_id,'group',g.source_event_id,g.source_event_id,NULL,g.updated_at,
        CASE WHEN g.attention_event_id IS NOT NULL AND g.all_terminal_event_id IS NULL THEN 1 ELSE 0 END,'group:'||g.source_event_id FROM job_groups g
      UNION ALL SELECT 'run:'||r.run_id,'run',r.run_id,r.run_id,NULL,
        CASE WHEN julianday(COALESCE(r.terminal_at,r.created_at))>=julianday(s.updated_at) THEN COALESCE(r.terminal_at,r.created_at) ELSE s.updated_at END,
        CASE WHEN r.status='needs_review' AND r.revision=s.revision THEN 1 ELSE 0 END,'run:'||r.run_id FROM schedule_runs r JOIN schedules s USING(schedule_id)
      UNION ALL SELECT 'completion:'||c.job_id||':'||c.job_status,'completion',c.job_id,COALESCE(c.notification_event_id,c.job_id),c.job_status,
        MAX(COALESCE((SELECT MAX(o.updated_at) FROM connector_outbox o JOIN schedule_runs r USING(run_id)
          WHERE r.job_id=c.job_id AND o.completion_job_status=c.job_status),c.materialized_at),COALESCE(e.updated_at,c.materialized_at),c.materialized_at),CASE WHEN json_extract(c.owner_json,'$.kind')='schedule' AND c.notification_state='needs_review'
          AND (c.job_status IN ('blocked','needs_review') OR c.notification_event_id IS NULL OR e.status IN ('completed','blocked','needs_review','dead_letter')) AND EXISTS (
          SELECT 1 FROM schedules s WHERE s.schedule_id=json_extract(c.owner_json,'$.schedule_id')
            AND s.revision=COALESCE(json_extract(c.owner_json,'$.revision'),1)) THEN 1 ELSE 0 END,
        'notification:'||c.job_id||':'||c.job_status FROM job_completion_results c LEFT JOIN events e ON e.event_id=c.notification_event_id
      UNION ALL SELECT 'outbox:'||o.outbox_id,'outbox',o.outbox_id,o.outbox_id,NULL,o.updated_at,
        CASE WHEN o.status='needs_review' AND o.kind!='slack.work_result.post' AND r.revision=s.revision THEN 1 ELSE 0 END,'outbox:'||o.outbox_id
        FROM connector_outbox o JOIN schedule_runs r USING(run_id) JOIN schedules s USING(schedule_id)
    ) WHERE source_key>? AND julianday(source_revision)<=julianday(?) ORDER BY source_key LIMIT ?`)
      .all(input.cursor??"",input.snapshotRevision,input.limit+1) as Candidate[];
    const page=rows.slice(0,input.limit), next=rows.length>input.limit?page.at(-1)!.source_key:null;
    let repaired=0,quarantined=0;
    if(input.dryRun) {
      for(const row of page) {
        const item=this.db.prepare("SELECT * FROM human_wait_items WHERE dedupe_key=?").get(row.dedupe_key) as HumanWaitItemRow|undefined;
        if(item&&Date.parse(item.source_revision)>Date.parse(input.snapshotRevision)) continue;
        const quarantinedAlready=this.db.prepare("SELECT 1 FROM human_wait_quarantine WHERE dedupe_key=?").get(row.dedupe_key)!==undefined;
        const shouldOpen=currentDesiredOpen(row)&&!quarantinedAlready;
        const expected=expectedProjection(row);
        if(expected&&Date.parse(expected.source_revision)!==Date.parse(row.source_revision)) continue;
        const malformed=!quarantinedAlready&&this.db.prepare(`SELECT 1 FROM human_wait_items WHERE dedupe_key=? AND
          (origin_ref LIKE '%/%' OR reason_code NOT IN ('human_input','ambiguous_write','invalid_result','notification_reconcile','operator_review_unknown'))`).get(row.dedupe_key);
        if(malformed){quarantined++;continue;}
        if((shouldOpen&&!item)||(item&&shouldOpen&&expected&&(item.state!=="open"||projectionMismatch(item,expected,row)))||(item&&!shouldOpen&&item.state==="open")) repaired++;
      }
    }
    if(!input.dryRun) this.db.transaction(()=>{
      for(const row of page) {
        const item=this.db.prepare("SELECT * FROM human_wait_items WHERE dedupe_key=?").get(row.dedupe_key) as HumanWaitItemRow|undefined;
        const quarantinedAlready=this.db.prepare("SELECT 1 FROM human_wait_quarantine WHERE dedupe_key=?").get(row.dedupe_key)!==undefined;
        const shouldOpen=currentDesiredOpen(row)&&!quarantinedAlready;
        if(item&&Date.parse(item.source_revision)>Date.parse(input.snapshotRevision)) continue;
        const expected=expectedProjection(row);
        if(expected&&Date.parse(expected.source_revision)!==Date.parse(row.source_revision)) continue;
        const malformed=!quarantinedAlready&&this.db.prepare(`SELECT 1 FROM human_wait_items WHERE dedupe_key=? AND
          (origin_ref LIKE '%/%' OR reason_code NOT IN ('human_input','ambiguous_write','invalid_result','notification_reconcile','operator_review_unknown'))`).get(row.dedupe_key);
        if(malformed){
          this.db.prepare("INSERT OR REPLACE INTO human_wait_quarantine VALUES(?,?,?,?)").run(row.dedupe_key,"invalid_projection",row.source_revision,input.snapshotRevision);
          this.db.prepare(`UPDATE human_wait_items SET state='stale',stale_at=?,updated_at=?,source_revision=?,retain_until=datetime(?,'+30 days')
            WHERE dedupe_key=? AND state='open'`).run(input.snapshotRevision,input.snapshotRevision,row.source_revision,input.snapshotRevision,row.dedupe_key);
          this.db.prepare(`INSERT INTO human_wait_audit(item_id,reason_class,source_revision,transition,actor_class,created_at)
            SELECT item_id,'invalid_projection',?,'quarantined','operator',? FROM human_wait_items WHERE dedupe_key=?`)
            .run(row.source_revision,input.snapshotRevision,row.dedupe_key);
          quarantined++;
          continue;
        }
        const needsRepair=(shouldOpen&&!item)||(item&&shouldOpen&&expected&&(item.state!=="open"||projectionMismatch(item,expected,row)))||(item&&!shouldOpen&&item.state==="open");
        if(needsRepair) {
          let changed=0;
          if(!item&&shouldOpen){
            if(row.kind==="job")changed=this.db.prepare("UPDATE jobs SET updated_at=updated_at WHERE job_id=? AND julianday(updated_at)<=julianday(?)").run(row.resource_id,input.snapshotRevision).changes;
            else if(row.kind==="group")changed=this.db.prepare("UPDATE job_groups SET updated_at=updated_at WHERE source_event_id=? AND julianday(updated_at)<=julianday(?)").run(row.resource_id,input.snapshotRevision).changes;
            else if(row.kind==="run")changed=this.db.prepare(`UPDATE schedule_runs SET status=status WHERE run_id=? AND
              MAX(julianday(COALESCE(terminal_at,created_at)),julianday((SELECT updated_at FROM schedules WHERE schedule_id=schedule_runs.schedule_id)))<=julianday(?)`).run(row.resource_id,input.snapshotRevision).changes;
            else if(row.kind==="completion")changed=this.db.prepare(`UPDATE job_completion_results SET notification_state=notification_state,notification_event_id=notification_event_id WHERE job_id=? AND job_status=? AND
              julianday(MAX(COALESCE((SELECT MAX(o.updated_at) FROM connector_outbox o JOIN schedule_runs r USING(run_id)
                WHERE r.job_id=job_completion_results.job_id AND o.completion_job_status=job_completion_results.job_status),materialized_at),
                COALESCE((SELECT updated_at FROM events WHERE event_id=job_completion_results.notification_event_id),materialized_at),materialized_at))<=julianday(?)`).run(row.resource_id,row.aux_id,input.snapshotRevision).changes;
            else changed=this.db.prepare("UPDATE connector_outbox SET updated_at=updated_at WHERE outbox_id=? AND julianday(updated_at)<=julianday(?)").run(row.resource_id,input.snapshotRevision).changes;
          } else if(item&&shouldOpen&&expected) {
            const settlement= item.state==="open"&&!derivedProjectionMismatch(item,expected)?item.session_settlement_verified:0;
            changed=this.db.prepare(`UPDATE human_wait_items SET tenant_id=?,workspace_id=?,owner_kind=?,owner_principal_kind=?,owner_principal_id=?,
              decision_actor_kind=?,decision_kind=?,resource_kind=?,resource_id=?,parent_resource_id=?,resource_revision=?,reason_code=?,source_revision=?,state='open',
              opened_at=CASE WHEN state='open' THEN opened_at ELSE ? END,session_settlement_verified=?,updated_at=?,resolved_at=NULL,stale_at=NULL,retain_until=datetime(?,'+30 days')
              WHERE item_id=? AND julianday(source_revision)<=julianday(?)`).run(expected.tenant_id,expected.workspace_id,expected.owner_kind,expected.owner_principal_kind,
              expected.owner_principal_id,expected.decision_actor_kind,expected.decision_kind,expected.resource_kind,expected.resource_id,expected.parent_resource_id,
              expected.resource_revision,expected.reason_code,row.source_revision,row.source_revision,settlement,row.source_revision,row.source_revision,item.item_id,input.snapshotRevision).changes;
          } else if(item&&!shouldOpen) {
            const stale=quarantinedAlready||obsoleteScheduleRevision(row);
            changed=this.db.prepare(`UPDATE human_wait_items SET state=?,resolved_at=?,stale_at=?,updated_at=?,source_revision=?,retain_until=datetime(?,'+30 days')
              WHERE item_id=? AND state='open' AND julianday(source_revision)<=julianday(?)`).run(stale?"stale":"resolved",
              stale?null:row.source_revision,stale?row.source_revision:null,row.source_revision,row.source_revision,row.source_revision,item.item_id,input.snapshotRevision).changes;
          }
          if(changed===1)repaired++;
        }
      }
    }).immediate();
    const projectionPlan=page.map(row=>{
      const expected=expectedProjection(row);
      return {dedupe_key:row.dedupe_key,source_revision:row.source_revision,desired_open:currentDesiredOpen(row),expected:expected?{
        tenant_id:expected.tenant_id,workspace_id:expected.workspace_id,owner_kind:expected.owner_kind,owner_principal_kind:expected.owner_principal_kind,
        owner_principal_id:expected.owner_principal_id,decision_actor_kind:expected.decision_actor_kind,decision_kind:expected.decision_kind,
        resource_kind:expected.resource_kind,resource_id:expected.resource_id,parent_resource_id:expected.parent_resource_id,
        resource_revision:expected.resource_revision,reason_code:expected.reason_code,source_revision:expected.source_revision}:null};
    });
    const digest=createHash("sha256").update(JSON.stringify({cursor:input.cursor??null,next,scanned:page.length,repaired,quarantined,
      snapshot:input.snapshotRevision,projection_plan:projectionPlan})).digest("hex");
    return {dry_run:input.dryRun,scanned:page.length,repaired,quarantined,next_cursor:next,snapshot_revision:input.snapshotRevision,digest};
  }

  purge(before: string, limit = 500): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("human_wait_purge_limit_invalid");
    if (!Number.isFinite(Date.parse(before)) || new Date(Date.parse(before)).toISOString() !== before) throw new Error("human_wait_purge_time_invalid");
    return this.db.transaction(() => {
      const ids=this.db.prepare(`SELECT item_id,source_revision FROM human_wait_items WHERE state!='open' AND julianday(retain_until)<=julianday(?)
        ORDER BY retain_until,item_id LIMIT ?`).all(before,limit) as Array<{item_id:string;source_revision:string}>;
      const audit=this.db.prepare("INSERT INTO human_wait_audit(item_id,reason_class,source_revision,transition,actor_class,created_at) VALUES(?,'retention',?,'purged','operator',?)");
      const remove=this.db.prepare("DELETE FROM human_wait_items WHERE item_id=? AND state!='open' AND julianday(retain_until)<=julianday(?)");
      for(const {item_id,source_revision} of ids){audit.run(item_id,source_revision,before);remove.run(item_id,before);}
      return ids.length;
    }).immediate();
  }
}
