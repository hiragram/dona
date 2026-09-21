import type Database from "better-sqlite3";
import { z } from "zod";

import type { AuditEvent } from "./audit/codec.js";
import type { AuditRepository } from "./audit/repository.js";
import { readEventJobBinding } from "./job-routing.js";
import { readVerifiedPrincipalBinding } from "./principal-binding.js";
import { stableStringify } from "./validation.js";

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value);
const taskSchema = z.strictObject({
  provider: z.literal("github"),
  repository_node_id: opaqueId,
  task_node_id: opaqueId,
  task_number: z.number().int().positive(),
  resource_revision: z.number().int().positive(),
});

export interface VerifiedTaskBindingEvidence {
  evidence_sha256: string;
  source_event_id: string;
  authorization_principal_event_id: string;
  tenant_id: string;
  workspace_id: string;
  principal_kind: "human";
  principal_id: string;
  permission: "bind_exact_task";
  verified_at: string;
  expires_at: string;
  task: z.infer<typeof taskSchema>;
}

export interface TaskBindingEvidenceVerifier {
  verify(input: unknown): VerifiedTaskBindingEvidence;
}

export interface TaskBindingAuditContext {
  instance_id: string;
  transaction_id: string;
  key_version: number;
}

export interface EventTaskBindingRow {
  event_id: string;
  provider: "github";
  repository_node_id: string;
  task_node_id: string;
  task_number: number;
  resource_revision: number;
  authorization_principal_event_id: string;
  authorization_evidence_sha256: string;
  binding_revision: number;
  status: "active" | "revoked";
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface JobAuthorizationBindingRow {
  job_id: string;
  source_event_id: string;
  owner_kind: "human_verified" | "schedule" | "service" | "unknown";
  principal_binding_event_id: string | null;
  ingress_proof_sha256: string | null;
  tenant_id: string | null;
  workspace_id: string | null;
  principal_kind: "human" | null;
  principal_id: string | null;
  disclosure_origin_json: string;
  resource_kind: "github_issue" | "schedule_run" | "unknown";
  repository_node_id: string | null;
  task_node_id: string | null;
  task_number: number | null;
  resource_revision: number | null;
  policy_revision: number;
  binding_revision: number;
  task_binding_revision: number | null;
  created_at: string;
}

export class TaskBindingConflictError extends Error {
  readonly code = "task_binding_conflict";
  constructor() { super("Exact task binding conflicts with durable evidence"); this.name = "TaskBindingConflictError"; }
}

export function migrateJobAuthorizationBindings(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_authorization_binding_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_task_bindings (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider='github'),
      repository_node_id TEXT NOT NULL,
      task_node_id TEXT NOT NULL,
      task_number INTEGER NOT NULL CHECK(task_number>0),
      resource_revision INTEGER NOT NULL CHECK(resource_revision>0),
      authorization_principal_event_id TEXT NOT NULL REFERENCES verified_principal_bindings(event_id),
      authorization_evidence_sha256 TEXT NOT NULL CHECK(length(authorization_evidence_sha256)=64),
      binding_revision INTEGER NOT NULL CHECK(binding_revision>0),
      status TEXT NOT NULL CHECK(status IN ('active','revoked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS job_authorization_bindings (
      job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
      source_event_id TEXT NOT NULL REFERENCES events(event_id),
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('human_verified','schedule','service','unknown')),
      principal_binding_event_id TEXT REFERENCES verified_principal_bindings(event_id),
      ingress_proof_sha256 TEXT,
      tenant_id TEXT,
      workspace_id TEXT,
      principal_kind TEXT CHECK(principal_kind='human' OR principal_kind IS NULL),
      principal_id TEXT,
      disclosure_origin_json TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK(resource_kind IN ('github_issue','schedule_run','unknown')),
      repository_node_id TEXT,
      task_node_id TEXT,
      task_number INTEGER,
      resource_revision INTEGER,
      policy_revision INTEGER NOT NULL CHECK(policy_revision>0),
      binding_revision INTEGER NOT NULL CHECK(binding_revision>0),
      task_binding_revision INTEGER,
      created_at TEXT NOT NULL,
      CHECK((owner_kind='human_verified')=(principal_binding_event_id IS NOT NULL)),
      CHECK((resource_kind='github_issue')=(task_node_id IS NOT NULL)),
      CHECK(resource_kind!='github_issue' OR (repository_node_id IS NOT NULL AND task_number>0 AND resource_revision>0 AND task_binding_revision>0))
    );
    CREATE INDEX IF NOT EXISTS event_task_resource_idx
      ON event_task_bindings(repository_node_id,task_node_id,resource_revision);
    CREATE UNIQUE INDEX IF NOT EXISTS event_task_evidence_idx
      ON event_task_bindings(authorization_evidence_sha256);
    CREATE INDEX IF NOT EXISTS job_authorization_owner_idx
      ON job_authorization_bindings(tenant_id,workspace_id,principal_kind,principal_id,job_id);
    CREATE TRIGGER IF NOT EXISTS job_authorization_binding_immutable BEFORE UPDATE ON job_authorization_bindings
      BEGIN SELECT RAISE(ABORT,'job_authorization_binding_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS job_authorization_source_match BEFORE INSERT ON job_authorization_bindings
      WHEN NOT EXISTS (SELECT 1 FROM jobs WHERE job_id=NEW.job_id AND source_event_id=NEW.source_event_id)
      BEGIN SELECT RAISE(ABORT,'job_authorization_source_mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS job_authorization_principal_complete BEFORE INSERT ON job_authorization_bindings
      WHEN (NEW.owner_kind='human_verified' AND (NEW.principal_binding_event_id IS NULL OR NEW.ingress_proof_sha256 IS NULL
        OR NEW.tenant_id IS NULL OR NEW.workspace_id IS NULL OR NEW.principal_kind IS NULL OR NEW.principal_id IS NULL))
        OR (NEW.owner_kind!='human_verified' AND (NEW.principal_binding_event_id IS NOT NULL OR NEW.ingress_proof_sha256 IS NOT NULL
        OR NEW.tenant_id IS NOT NULL OR NEW.workspace_id IS NOT NULL OR NEW.principal_kind IS NOT NULL OR NEW.principal_id IS NOT NULL))
      BEGIN SELECT RAISE(ABORT,'job_authorization_principal_incomplete'); END;
    CREATE TRIGGER IF NOT EXISTS job_authorization_task_match BEFORE INSERT ON job_authorization_bindings
      WHEN NEW.resource_kind='github_issue' AND NOT EXISTS (
        SELECT 1 FROM event_task_bindings t WHERE t.event_id=NEW.source_event_id AND t.status='active'
          AND t.repository_node_id=NEW.repository_node_id AND t.task_node_id=NEW.task_node_id
          AND t.task_number=NEW.task_number AND t.resource_revision=NEW.resource_revision
          AND t.binding_revision=NEW.task_binding_revision)
      BEGIN SELECT RAISE(ABORT,'job_authorization_task_mismatch'); END;
    INSERT OR IGNORE INTO job_authorization_binding_schema(singleton,version) VALUES(1,1);
  `);
  const marker = db.prepare("SELECT version FROM job_authorization_binding_schema WHERE singleton=1").get() as {version:number}|undefined;
  if (marker?.version !== 1) throw new Error("Unsupported job authorization binding schema");
  const now = new Date(0).toISOString();
  db.prepare(`INSERT OR IGNORE INTO job_authorization_bindings(
    job_id,source_event_id,owner_kind,principal_binding_event_id,ingress_proof_sha256,tenant_id,workspace_id,
    principal_kind,principal_id,disclosure_origin_json,resource_kind,repository_node_id,task_node_id,task_number,
    resource_revision,policy_revision,binding_revision,task_binding_revision,created_at)
    SELECT j.job_id,j.source_event_id,
      CASE json_extract(b.owner_json,'$.kind') WHEN 'schedule' THEN 'schedule' ELSE 'unknown' END,
      NULL,NULL,NULL,NULL,NULL,NULL,
      CASE WHEN b.destination_json IS NULL THEN '{"kind":"none"}' ELSE b.destination_json END,
      CASE json_extract(b.owner_json,'$.kind') WHEN 'schedule' THEN 'schedule_run' ELSE 'unknown' END,
      NULL,NULL,NULL,NULL,1,1,NULL,COALESCE(j.created_at,?)
    FROM jobs j LEFT JOIN job_owner_bindings b USING(job_id)`).run(now);
}

function parsedEvidence(input: VerifiedTaskBindingEvidence): VerifiedTaskBindingEvidence {
  return z.strictObject({
    evidence_sha256: digest,
    source_event_id: z.string().regex(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i),
    authorization_principal_event_id: z.string().regex(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i),
    tenant_id: z.string().min(1).max(128), workspace_id: z.string().min(1).max(128),
    principal_kind: z.literal("human"), principal_id: z.string().min(1).max(128),
    permission: z.literal("bind_exact_task"), verified_at: utc, expires_at: utc, task: taskSchema,
  }).parse(input);
}

export class JobAuthorizationBindingRepository {
  constructor(private readonly db: Database.Database) {}

  bindEventTask(eventId: string, expectedBindingRevision: number, rawEvidence: unknown,
    verifier: TaskBindingEvidenceVerifier, audit: Pick<AuditRepository, "append">,
    auditContext: TaskBindingAuditContext, at = new Date()): EventTaskBindingRow {
    if (!Number.isSafeInteger(expectedBindingRevision) || expectedBindingRevision < 0) throw new TaskBindingConflictError();
    const evidence = parsedEvidence(verifier.verify(rawEvidence));
    const now = at.toISOString();
    if (evidence.source_event_id !== eventId || evidence.authorization_principal_event_id !== eventId ||
      Date.parse(evidence.verified_at) > at.getTime() || Date.parse(evidence.expires_at) <= at.getTime()) throw new TaskBindingConflictError();
    const principal = readVerifiedPrincipalBinding(this.db, eventId);
    if (!principal || principal.revoked_at !== null || principal.tenant_id !== evidence.tenant_id ||
      principal.workspace_id !== evidence.workspace_id || principal.principal_kind !== evidence.principal_kind ||
      principal.principal_id !== evidence.principal_id) throw new TaskBindingConflictError();
    const existing = this.readEventTask(eventId);
    const sameEvidence = existing?.authorization_evidence_sha256 === evidence.evidence_sha256;
    const sameTask = existing?.provider === evidence.task.provider && existing.repository_node_id === evidence.task.repository_node_id &&
      existing.task_node_id === evidence.task.task_node_id && existing.task_number === evidence.task.task_number &&
      existing.resource_revision === evidence.task.resource_revision && existing.status === "active";
    if (sameEvidence && sameTask) return existing;
    if ((!existing && expectedBindingRevision !== 0) || (existing && (existing.binding_revision !== expectedBindingRevision ||
      existing.status !== "active" || existing.repository_node_id !== evidence.task.repository_node_id ||
      existing.task_node_id !== evidence.task.task_node_id || evidence.task.resource_revision < existing.resource_revision))) {
      throw new TaskBindingConflictError();
    }
    const auditValues = z.strictObject({
      instance_id: opaqueId, transaction_id: opaqueId, key_version: z.number().int().positive(),
    }).parse(auditContext);
    const auditEvent: AuditEvent = {
      occurred_at: now,
      scope: { instance_id: auditValues.instance_id, tenant_id: evidence.tenant_id },
      actor: { kind: "principal", id: evidence.principal_id },
      action: "binding_change", operation: "binding.change.v1", resource_id: evidence.task.task_node_id,
      outcome: "succeeded", reason: "none", session_ref: eventId, receipt_id: null,
      attempt_id: evidence.evidence_sha256, policy_revision: 1,
      binding_revision: existing ? existing.binding_revision + 1 : 1, authz_revision: principal.event_attempt,
    };
    return audit.append(auditValues.transaction_id, auditValues.key_version, auditEvent, () => this.db.transaction(() => {
      const current = this.readEventTask(eventId);
      if (!current) {
        if (expectedBindingRevision !== 0) throw new TaskBindingConflictError();
        this.db.prepare(`INSERT INTO event_task_bindings VALUES(?,?,?,?,?,?,?,?,1,'active',?,?,NULL)`).run(
          eventId,evidence.task.provider,evidence.task.repository_node_id,evidence.task.task_node_id,evidence.task.task_number,
          evidence.task.resource_revision,eventId,evidence.evidence_sha256,now,now);
        return this.readEventTask(eventId)!;
      }
      if (current.binding_revision !== expectedBindingRevision || current.status !== "active" ||
        current.repository_node_id !== evidence.task.repository_node_id || current.task_node_id !== evidence.task.task_node_id ||
        evidence.task.resource_revision < current.resource_revision) throw new TaskBindingConflictError();
      const changed = this.db.prepare(`UPDATE event_task_bindings SET task_number=?,resource_revision=?,authorization_evidence_sha256=?,
        binding_revision=binding_revision+1,updated_at=? WHERE event_id=? AND binding_revision=? AND status='active'`).run(
        evidence.task.task_number,evidence.task.resource_revision,evidence.evidence_sha256,now,eventId,expectedBindingRevision).changes;
      if (changed !== 1) throw new TaskBindingConflictError();
      return this.readEventTask(eventId)!;
    })()).result;
  }

  readEventTask(eventId: string): EventTaskBindingRow | undefined {
    return this.db.prepare("SELECT * FROM event_task_bindings WHERE event_id=?").get(eventId) as EventTaskBindingRow | undefined;
  }

  readJob(jobId: string): JobAuthorizationBindingRow | undefined {
    return this.db.prepare("SELECT * FROM job_authorization_bindings WHERE job_id=?").get(jobId) as JobAuthorizationBindingRow | undefined;
  }

  captureJob(jobId: string, sourceEventId: string, at: Date): JobAuthorizationBindingRow {
    const existing = this.readJob(jobId);
    if (existing) return existing;
    const principal = readVerifiedPrincipalBinding(this.db, sourceEventId);
    const routing = readEventJobBinding(this.db, sourceEventId);
    const task = this.readEventTask(sourceEventId);
    const human = principal?.revoked_at === null ? principal : undefined;
    const ownerKind = human ? "human_verified" : routing?.owner.kind === "schedule" ? "schedule" : "unknown";
    const resourceKind = task?.status === "active" ? "github_issue" : routing?.owner.kind === "schedule" ? "schedule_run" : "unknown";
    const disclosure = stableStringify({ kind: "event_destination", source_event_id: sourceEventId,
      destination: routing?.destination ?? { kind: "none" } });
    this.db.prepare(`INSERT INTO job_authorization_bindings(
      job_id,source_event_id,owner_kind,principal_binding_event_id,ingress_proof_sha256,tenant_id,workspace_id,
      principal_kind,principal_id,disclosure_origin_json,resource_kind,repository_node_id,task_node_id,task_number,
      resource_revision,policy_revision,binding_revision,task_binding_revision,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      jobId,sourceEventId,ownerKind,human?.event_id??null,human?.proof_sha256??null,human?.tenant_id??null,human?.workspace_id??null,
      human?.principal_kind??null,human?.principal_id??null,disclosure,resourceKind,task?.repository_node_id??null,task?.task_node_id??null,
      task?.task_number??null,task?.resource_revision??null,1,1,task?.binding_revision??null,at.toISOString());
    return this.readJob(jobId)!;
  }
}
