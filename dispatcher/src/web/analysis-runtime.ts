import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";
import { z } from "zod";
import { assertSecurityDurability } from "../audit/durability.js";
import { verifyOpenDatabaseFile } from "../audit/file-identity.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().length(64).regex(/^[a-f0-9]+$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const utc = z.string().refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const absolutePath = z.string().min(1).max(4096).refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value));

export const analysisProfile = "analysis.read_only.v1" as const;
export const analysisStageSchema = z.enum(["admission", "snapshot_open", "inference", "result_commit"]);
export type AnalysisStage = z.infer<typeof analysisStageSchema>;

export const analysisReceiptSchema = z.strictObject({
  codec_version: z.literal(1),
  profile: z.literal(analysisProfile),
  receipt_id: id,
  job_id: id,
  instance_id: id,
  tenant_id: id,
  principal_id: id,
  session_generation: revision,
  authz_revision: revision,
  owner_revision: revision,
  source_manifest_id: id,
  source_manifest_digest: digest,
  source_grant_revision: revision,
  snapshot_digest: digest,
  broker_id: id,
  broker_generation: revision,
  model: id,
  tokenizer: id,
  maximum_calls: z.number().int().min(1).max(64),
  maximum_tokens: z.number().int().min(1).max(1_000_000),
  maximum_runtime_ms: z.number().int().min(1).max(3_600_000),
  maximum_scratch_bytes: z.number().int().min(1).max(1_073_741_824),
  issued_at: utc,
  expires_at: utc,
}).refine((value) => Date.parse(value.expires_at) > Date.parse(value.issued_at)
  && Date.parse(value.expires_at) - Date.parse(value.issued_at) <= value.maximum_runtime_ms);
export type AnalysisReceipt = z.infer<typeof analysisReceiptSchema>;

const currentAuthorizationSchema = z.strictObject({
  receipt_id: id, job_id: id, instance_id: id, tenant_id: id, principal_id: id,
  session_generation: revision, authz_revision: revision, owner_revision: revision,
  source_manifest_id: id, source_manifest_digest: digest, source_grant_revision: revision,
  snapshot_digest: digest, broker_id: id, broker_generation: revision,
});
export type CurrentAnalysisAuthorization = z.infer<typeof currentAuthorizationSchema>;
function authorizationFromReceipt(receipt: AnalysisReceipt): CurrentAnalysisAuthorization {
  return {
    receipt_id: receipt.receipt_id, job_id: receipt.job_id, instance_id: receipt.instance_id,
    tenant_id: receipt.tenant_id, principal_id: receipt.principal_id, session_generation: receipt.session_generation,
    authz_revision: receipt.authz_revision, owner_revision: receipt.owner_revision,
    source_manifest_id: receipt.source_manifest_id, source_manifest_digest: receipt.source_manifest_digest,
    source_grant_revision: receipt.source_grant_revision, snapshot_digest: receipt.snapshot_digest,
    broker_id: receipt.broker_id, broker_generation: receipt.broker_generation,
  };
}

const permitClaimsSchema = z.strictObject({
  codec_version: z.literal(1),
  audience: z.literal("dona.analysis-inference-broker"),
  permit_id: id,
  receipt_id: id,
  job_id: id,
  stage: analysisStageSchema,
  fence: revision,
  broker_id: id,
  broker_generation: revision,
  model: id,
  tokenizer: id,
  source_manifest_digest: digest,
  snapshot_digest: digest,
  maximum_tokens: z.number().int().min(1).max(1_000_000),
  issued_at: utc,
  expires_at: utc,
}).refine((value) => Date.parse(value.expires_at) > Date.parse(value.issued_at)
  && Date.parse(value.expires_at) - Date.parse(value.issued_at) <= 10_000);
type PermitClaims = z.infer<typeof permitClaimsSchema>;

const runtimeSql = `
 CREATE TABLE analysis_runtime_schema (version INTEGER PRIMARY KEY CHECK(version=1)) STRICT;
 INSERT INTO analysis_runtime_schema VALUES(1);
 CREATE TABLE analysis_runtime_receipts (
 receipt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64), integrity_mac TEXT NOT NULL CHECK(length(integrity_mac)=64),
  state TEXT NOT NULL CHECK(state IN ('ready','completed','needs_review')),
  next_fence INTEGER NOT NULL CHECK(next_fence>=1), used_calls INTEGER NOT NULL CHECK(used_calls>=0),
  reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>=0), result_digest TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 ) STRICT;
 CREATE TABLE analysis_runtime_permits (
  permit_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, stage TEXT NOT NULL,
  fence INTEGER NOT NULL, claims_json TEXT NOT NULL, claims_digest TEXT NOT NULL CHECK(length(claims_digest)=64),
  consumed_at TEXT, integrity_mac TEXT NOT NULL CHECK(length(integrity_mac)=64), FOREIGN KEY(receipt_id) REFERENCES analysis_runtime_receipts(receipt_id)
 ) STRICT;
 CREATE TABLE analysis_runtime_calls (
  call_id TEXT PRIMARY KEY, permit_id TEXT NOT NULL UNIQUE, receipt_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64), reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>0),
  status TEXT NOT NULL CHECK(status IN ('reserved','succeeded','known_rejected','acceptance_unknown')),
  usage_tokens INTEGER, output_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  integrity_mac TEXT NOT NULL CHECK(length(integrity_mac)=64),
  FOREIGN KEY(permit_id) REFERENCES analysis_runtime_permits(permit_id),
  FOREIGN KEY(receipt_id) REFERENCES analysis_runtime_receipts(receipt_id)
 ) STRICT;
`;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function canonical(value: unknown): string {
  return JSON.stringify(value);
}
function nowMs(value: string): number {
  return Date.parse(utc.parse(value));
}
function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AnalysisRuntimeError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "denied" | "quota" | "expired" | "ambiguous") {
    super(`analysis_runtime_${code}`);
    this.name = "AnalysisRuntimeError";
  }
}

export function installAnalysisRuntimeSchema(db: Database.Database): void {
  if (db.inTransaction) throw new AnalysisRuntimeError("invalid");
  db.transaction(() => {
    const installed = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_runtime_schema'").get();
    if (installed) {
      const existing = db.prepare("SELECT version FROM analysis_runtime_schema").get() as { version: number } | undefined;
      if (!existing || existing.version !== 1) throw new AnalysisRuntimeError("invalid");
      return;
    }
    const collision = db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'analysis_runtime_%' LIMIT 1").get();
    if (collision) throw new AnalysisRuntimeError("invalid");
    db.exec(runtimeSql);
  }).immediate();
}

interface StoredReceipt {
  receipt_id: string; job_id: string; payload_json: string; payload_digest: string; integrity_mac: string; state: "ready" | "completed" | "needs_review";
  next_fence: number; used_calls: number; reserved_tokens: number; result_digest: string | null;
  created_at: string;
}
export class AnalysisRuntimeStore {
  constructor(private readonly db: Database.Database, private readonly signingSecret: Uint8Array) {
    if (signingSecret.byteLength !== 32) throw new AnalysisRuntimeError("invalid");
    try { assertSecurityDurability(db); verifyOpenDatabaseFile(db); } catch { throw new AnalysisRuntimeError("invalid"); }
    installAnalysisRuntimeSchema(db);
  }

  private mac(domain: string, fields: readonly unknown[]): string {
    return createHmac("sha256", this.signingSecret).update(domain).update("\0").update(canonical(fields)).digest("hex");
  }
  private receiptMac(row: Omit<StoredReceipt, "integrity_mac">): string {
    return this.mac("dona.analysis-receipt.v1", [row.receipt_id, row.job_id, row.payload_digest, row.state, row.next_fence,
      row.used_calls, row.reserved_tokens, row.result_digest, row.created_at]);
  }
  private verifiedReceipt(row: StoredReceipt): AnalysisReceipt {
    const { integrity_mac: _mac, ...fields } = row;
    if (!equalText(this.receiptMac(fields), row.integrity_mac) || !equalText(sha256(row.payload_json), row.payload_digest)) {
      throw new AnalysisRuntimeError("denied");
    }
    try { return analysisReceiptSchema.parse(JSON.parse(row.payload_json)); }
    catch { throw new AnalysisRuntimeError("denied"); }
  }
  private updateReceipt(row: StoredReceipt, changes: Partial<Pick<StoredReceipt, "state" | "next_fence" | "used_calls" | "reserved_tokens" | "result_digest">>, now: string): StoredReceipt {
    const updated = { ...row, ...changes }; const { integrity_mac: _mac, ...fields } = updated;
    updated.integrity_mac = this.receiptMac(fields);
    this.db.prepare(`UPDATE analysis_runtime_receipts SET state=?,next_fence=?,used_calls=?,reserved_tokens=?,result_digest=?,updated_at=?,integrity_mac=? WHERE receipt_id=?`)
      .run(updated.state, updated.next_fence, updated.used_calls, updated.reserved_tokens, updated.result_digest, now, updated.integrity_mac, updated.receipt_id);
    return updated;
  }

  register(input: unknown): { outcome: "created" | "reused"; receipt: AnalysisReceipt } {
    const receipt = analysisReceiptSchema.parse(input);
    const payload = canonical(receipt); const payloadDigest = sha256(payload);
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM analysis_runtime_receipts WHERE receipt_id=? OR job_id=?")
        .get(receipt.receipt_id, receipt.job_id) as StoredReceipt | undefined;
      if (existing) {
        if (existing.receipt_id !== receipt.receipt_id || !equalText(existing.payload_digest, payloadDigest)) throw new AnalysisRuntimeError("conflict");
        return { outcome: "reused" as const, receipt: this.verifiedReceipt(existing) };
      }
      const base = { receipt_id: receipt.receipt_id, job_id: receipt.job_id, payload_json: payload, payload_digest: payloadDigest,
        state: "ready" as const, next_fence: 1, used_calls: 0, reserved_tokens: 0, result_digest: null, created_at: receipt.issued_at };
      const integrityMac = this.receiptMac(base);
      this.db.prepare(`INSERT INTO analysis_runtime_receipts
       (receipt_id,job_id,payload_json,payload_digest,integrity_mac,state,next_fence,used_calls,reserved_tokens,result_digest,created_at,updated_at)
       VALUES(?,?,?,?,?,'ready',1,0,0,NULL,?,?)`).run(receipt.receipt_id, receipt.job_id, payload, payloadDigest, integrityMac, receipt.issued_at, receipt.issued_at);
      return { outcome: "created" as const, receipt };
    }).immediate();
  }

  authorizeStage(receiptId: string, stageInput: unknown, currentInput: unknown, maximumTokens: number, now: string): string {
    const stage = analysisStageSchema.parse(stageInput); const current = currentAuthorizationSchema.parse(currentInput);
    const at = nowMs(now);
    if (!Number.isSafeInteger(maximumTokens) || maximumTokens < 1) throw new AnalysisRuntimeError("invalid");
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM analysis_runtime_receipts WHERE receipt_id=?").get(receiptId) as StoredReceipt | undefined;
      if (!row || row.state !== "ready") throw new AnalysisRuntimeError("denied");
      const receipt = this.verifiedReceipt(row);
      if (at < nowMs(receipt.issued_at) || at >= nowMs(receipt.expires_at)) throw new AnalysisRuntimeError("expired");
      const expected = authorizationFromReceipt(receipt);
      if (!equalText(canonical(expected), canonical(current))) throw new AnalysisRuntimeError("denied");
      if (stage === "inference" && (row.used_calls >= receipt.maximum_calls
        || row.reserved_tokens + maximumTokens > receipt.maximum_tokens)) throw new AnalysisRuntimeError("quota");
      const permitId = `permit_${randomBytes(16).toString("hex")}`;
      const expiresAt = new Date(Math.min(at + 10_000, nowMs(receipt.expires_at))).toISOString();
      const claims = permitClaimsSchema.parse({ codec_version: 1, audience: "dona.analysis-inference-broker", permit_id: permitId,
        receipt_id: receipt.receipt_id, job_id: receipt.job_id, stage, fence: row.next_fence, broker_id: receipt.broker_id,
        broker_generation: receipt.broker_generation, model: receipt.model, tokenizer: receipt.tokenizer,
        source_manifest_digest: receipt.source_manifest_digest, snapshot_digest: receipt.snapshot_digest,
        maximum_tokens: maximumTokens, issued_at: now, expires_at: expiresAt });
      const claimsJson = canonical(claims); const claimsDigest = sha256(claimsJson);
      const permitMac = this.mac("dona.analysis-permit-row.v1", [permitId, receipt.receipt_id, stage, row.next_fence, claimsDigest, null]);
      this.db.prepare("INSERT INTO analysis_runtime_permits VALUES(?,?,?,?,?,?,NULL,?)")
        .run(permitId, receipt.receipt_id, stage, row.next_fence, claimsJson, claimsDigest, permitMac);
      this.updateReceipt(row, { next_fence: row.next_fence + 1 }, now);
      const payload = Buffer.from(claimsJson).toString("base64url");
      const mac = createHmac("sha256", this.signingSecret).update("dona.analysis-permit.v1\0").update(payload).digest("base64url");
      return `${payload}.${mac}`;
    }).immediate();
  }

  private decodePermit(token: string, now: string): PermitClaims {
    const at = nowMs(now); const parts = token.split("."); if (parts.length !== 2) throw new AnalysisRuntimeError("denied");
    const actual = Buffer.from(parts[1]!, "base64url");
    const expected = createHmac("sha256", this.signingSecret).update("dona.analysis-permit.v1\0").update(parts[0]!).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AnalysisRuntimeError("denied");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parts[0]!, "base64url"));
      const claims = permitClaimsSchema.parse(JSON.parse(text));
      if (canonical(claims) !== text || at < nowMs(claims.issued_at) || at >= nowMs(claims.expires_at)) throw new Error();
      return claims;
    } catch { throw new AnalysisRuntimeError("expired"); }
  }

  private consumeStagePermit(token: string, stage: AnalysisStage, now: string): PermitClaims {
    const claims = this.decodePermit(token, now); if (claims.stage !== stage) throw new AnalysisRuntimeError("denied");
    const permit = this.db.prepare("SELECT * FROM analysis_runtime_permits WHERE permit_id=?").get(claims.permit_id) as
      { permit_id: string; receipt_id: string; stage: string; fence: number; claims_digest: string; consumed_at: string | null; integrity_mac: string } | undefined;
    const receipt = this.db.prepare("SELECT * FROM analysis_runtime_receipts WHERE receipt_id=?").get(claims.receipt_id) as StoredReceipt | undefined;
    if (!permit || !receipt || permit.consumed_at || receipt.state !== "ready" || permit.receipt_id !== claims.receipt_id
      || permit.fence !== claims.fence || !equalText(permit.claims_digest, sha256(canonical(claims)))
      || !equalText(permit.integrity_mac, this.mac("dona.analysis-permit-row.v1", [permit.permit_id, permit.receipt_id,
        permit.stage, permit.fence, permit.claims_digest, null]))) throw new AnalysisRuntimeError("denied");
    const configured = this.verifiedReceipt(receipt);
    if (configured.broker_id !== claims.broker_id || configured.broker_generation !== claims.broker_generation
      || configured.source_manifest_digest !== claims.source_manifest_digest || configured.snapshot_digest !== claims.snapshot_digest) {
      throw new AnalysisRuntimeError("denied");
    }
    const consumedMac = this.mac("dona.analysis-permit-row.v1", [permit.permit_id, permit.receipt_id,
      permit.stage, permit.fence, permit.claims_digest, now]);
    this.db.prepare("UPDATE analysis_runtime_permits SET consumed_at=?,integrity_mac=? WHERE permit_id=?")
      .run(now, consumedMac, claims.permit_id);
    return claims;
  }

  consumeSnapshotPermit(token: string, currentInput: unknown, actualSnapshotDigest: string, now: string): { maximum_scratch_bytes: number } {
    digest.parse(actualSnapshotDigest); const current = currentAuthorizationSchema.parse(currentInput);
    return this.db.transaction(() => {
      const claims = this.consumeStagePermit(token, "snapshot_open", now);
      const row = this.db.prepare("SELECT * FROM analysis_runtime_receipts WHERE receipt_id=?").get(claims.receipt_id) as StoredReceipt;
      const receipt = this.verifiedReceipt(row);
      if (!equalText(canonical(authorizationFromReceipt(receipt)), canonical(current))
        || !equalText(receipt.snapshot_digest, actualSnapshotDigest)) throw new AnalysisRuntimeError("denied");
      return { maximum_scratch_bytes: receipt.maximum_scratch_bytes };
    }).immediate();
  }

  consumeInferencePermit(token: string, requestDigest: string, now: string): { call_id: string; claims: PermitClaims } {
    const at = nowMs(now); digest.parse(requestDigest);
    const parts = token.split("."); if (parts.length !== 2) throw new AnalysisRuntimeError("denied");
    const actual = Buffer.from(parts[1]!, "base64url");
    const expected = createHmac("sha256", this.signingSecret).update("dona.analysis-permit.v1\0").update(parts[0]!).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AnalysisRuntimeError("denied");
    let claims: PermitClaims;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parts[0]!, "base64url"));
      claims = permitClaimsSchema.parse(JSON.parse(text)); if (canonical(claims) !== text) throw new Error();
    } catch { throw new AnalysisRuntimeError("denied"); }
    if (claims.stage !== "inference" || at < nowMs(claims.issued_at) || at >= nowMs(claims.expires_at)) throw new AnalysisRuntimeError("expired");
    return this.db.transaction(() => {
      const permit = this.db.prepare("SELECT * FROM analysis_runtime_permits WHERE permit_id=?").get(claims.permit_id) as
        { permit_id: string; receipt_id: string; stage: string; fence: number; claims_digest: string; consumed_at: string | null; integrity_mac: string } | undefined;
      const receipt = this.db.prepare("SELECT * FROM analysis_runtime_receipts WHERE receipt_id=?").get(claims.receipt_id) as StoredReceipt | undefined;
      if (!permit || !receipt || permit.consumed_at || receipt.state !== "ready" || permit.receipt_id !== claims.receipt_id
        || permit.fence !== claims.fence || !equalText(permit.claims_digest, sha256(canonical(claims)))
        || !equalText(permit.integrity_mac, this.mac("dona.analysis-permit-row.v1", [permit.permit_id, permit.receipt_id,
          permit.stage, permit.fence, permit.claims_digest, permit.consumed_at]))) throw new AnalysisRuntimeError("denied");
      const configured = this.verifiedReceipt(receipt);
      if (configured.broker_id !== claims.broker_id || configured.broker_generation !== claims.broker_generation
        || configured.model !== claims.model || configured.tokenizer !== claims.tokenizer
        || configured.source_manifest_digest !== claims.source_manifest_digest || configured.snapshot_digest !== claims.snapshot_digest
        || receipt.used_calls >= configured.maximum_calls || receipt.reserved_tokens + claims.maximum_tokens > configured.maximum_tokens) {
        throw new AnalysisRuntimeError("denied");
      }
      const callId = `call_${randomBytes(16).toString("hex")}`;
      const consumedMac = this.mac("dona.analysis-permit-row.v1", [permit.permit_id, permit.receipt_id,
        permit.stage, permit.fence, permit.claims_digest, now]);
      this.db.prepare("UPDATE analysis_runtime_permits SET consumed_at=?,integrity_mac=? WHERE permit_id=? AND consumed_at IS NULL")
        .run(now, consumedMac, claims.permit_id);
      this.updateReceipt(receipt, { used_calls: receipt.used_calls + 1,
        reserved_tokens: receipt.reserved_tokens + claims.maximum_tokens }, now);
      const callMac = this.mac("dona.analysis-call.v1", [callId, claims.permit_id, claims.receipt_id, requestDigest,
        claims.maximum_tokens, "reserved", null, null, now]);
      this.db.prepare("INSERT INTO analysis_runtime_calls VALUES(?,?,?,?,?,'reserved',NULL,NULL,?,?,?)")
        .run(callId, claims.permit_id, claims.receipt_id, requestDigest, claims.maximum_tokens, now, now, callMac);
      return { call_id: callId, claims };
    }).immediate();
  }

  finishCall(callId: string, result: { status: "succeeded"; usage_tokens: number; output_digest: string }
    | { status: "known_rejected" | "acceptance_unknown" }, now: string): void {
    nowMs(now);
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM analysis_runtime_calls WHERE call_id=?").get(callId) as
        { call_id: string; permit_id: string; receipt_id: string; request_digest: string; reserved_tokens: number;
          status: string; usage_tokens: number | null; output_digest: string | null; created_at: string; integrity_mac: string } | undefined;
      if (!row || row.status !== "reserved" || !equalText(row.integrity_mac, this.mac("dona.analysis-call.v1",
        [row.call_id, row.permit_id, row.receipt_id, row.request_digest, row.reserved_tokens, row.status,
          row.usage_tokens, row.output_digest, row.created_at]))) throw new AnalysisRuntimeError("conflict");
      let usage: number | null = null; let output: string | null = null;
      if (result.status === "succeeded") {
        digest.parse(result.output_digest);
        if (!Number.isSafeInteger(result.usage_tokens) || result.usage_tokens < 0 || result.usage_tokens > row.reserved_tokens) throw new AnalysisRuntimeError("invalid");
        usage = result.usage_tokens; output = result.output_digest;
      }
      const callMac = this.mac("dona.analysis-call.v1", [row.call_id, row.permit_id, row.receipt_id, row.request_digest,
        row.reserved_tokens, result.status, usage, output, row.created_at]);
      this.db.prepare("UPDATE analysis_runtime_calls SET status=?,usage_tokens=?,output_digest=?,updated_at=?,integrity_mac=? WHERE call_id=?")
        .run(result.status, usage, output, now, callMac, callId);
      if (result.status === "acceptance_unknown") {
        const receipt = this.db.prepare("SELECT * FROM analysis_runtime_receipts WHERE receipt_id=?").get(row.receipt_id) as StoredReceipt;
        this.verifiedReceipt(receipt); this.updateReceipt(receipt, { state: "needs_review" }, now);
      }
    }).immediate();
  }

  reconcileCall(callId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM analysis_runtime_calls WHERE call_id=?").get(callId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const expected = this.mac("dona.analysis-call.v1", [row.call_id, row.permit_id, row.receipt_id, row.request_digest,
      row.reserved_tokens, row.status, row.usage_tokens, row.output_digest, row.created_at]);
    if (!equalText(String(row.integrity_mac), expected)) throw new AnalysisRuntimeError("denied");
    const { permit_id: _permit, integrity_mac: _mac, ...publicRow } = row; return publicRow;
  }

  commitResult(receiptId: string, permit: string, currentInput: unknown, sourceManifestDigest: string, resultDigest: string, now: string): void {
    digest.parse(sourceManifestDigest); digest.parse(resultDigest); nowMs(now);
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM analysis_runtime_receipts WHERE receipt_id=?").get(receiptId) as StoredReceipt | undefined;
      if (!row || row.state !== "ready") throw new AnalysisRuntimeError("denied");
      const receipt = this.verifiedReceipt(row); const current = currentAuthorizationSchema.parse(currentInput);
      if (nowMs(now) < nowMs(receipt.issued_at) || nowMs(now) >= nowMs(receipt.expires_at)
        || !equalText(canonical(authorizationFromReceipt(receipt)), canonical(current))) throw new AnalysisRuntimeError("expired");
      if (!equalText(receipt.source_manifest_digest, sourceManifestDigest)) throw new AnalysisRuntimeError("denied");
      const claims = this.consumeStagePermit(permit, "result_commit", now);
      if (claims.receipt_id !== receiptId) throw new AnalysisRuntimeError("denied");
      const calls = this.db.prepare("SELECT * FROM analysis_runtime_calls WHERE receipt_id=?").all(receiptId) as Array<Record<string, unknown>>;
      for (const call of calls) {
        const expected = this.mac("dona.analysis-call.v1", [call.call_id, call.permit_id, call.receipt_id, call.request_digest,
          call.reserved_tokens, call.status, call.usage_tokens, call.output_digest, call.created_at]);
        if (!equalText(String(call.integrity_mac), expected)) throw new AnalysisRuntimeError("denied");
        if (call.status === "reserved" || call.status === "acceptance_unknown") throw new AnalysisRuntimeError("ambiguous");
      }
      this.updateReceipt(row, { state: "completed", result_digest: resultDigest }, now);
    }).immediate();
  }
}

export interface FixedInferenceTransport {
  invoke(input: { endpoint: string; model: string; prompt: string; maximum_tokens: number; credential: Uint8Array; signal: AbortSignal }):
    Promise<{ output: string; usage_tokens: number }>;
}

export class FixedInferenceBroker {
  constructor(private readonly store: AnalysisRuntimeStore, private readonly identity: {
    broker_id: string; broker_generation: number; endpoint: string; model: string; tokenizer: string;
  }, private readonly providerCredential: Uint8Array, private readonly transport: FixedInferenceTransport,
  private readonly now: () => string, private readonly timeoutMs = 30_000) {
    id.parse(identity.broker_id); revision.parse(identity.broker_generation); id.parse(identity.model); id.parse(identity.tokenizer);
    if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~/-]+$/.test(identity.endpoint) || providerCredential.byteLength < 16
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new AnalysisRuntimeError("invalid");
  }

  async invoke(input: { permit: string; prompt: string }): Promise<{ call_id: string; output: string; usage_tokens: number }> {
    if (typeof input.prompt !== "string" || Buffer.byteLength(input.prompt) > 1_048_576) throw new AnalysisRuntimeError("invalid");
    const requestDigest = sha256(Buffer.from(input.prompt));
    const reserved = this.store.consumeInferencePermit(input.permit, requestDigest, this.now());
    const claims = reserved.claims;
    if (claims.broker_id !== this.identity.broker_id || claims.broker_generation !== this.identity.broker_generation
      || claims.model !== this.identity.model || claims.tokenizer !== this.identity.tokenizer) {
      this.store.finishCall(reserved.call_id, { status: "known_rejected" }, this.now());
      throw new AnalysisRuntimeError("denied");
    }
    try {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error("inference_timeout")); controller.abort(); }, this.timeoutMs);
        timer.unref();
      });
      const result = await Promise.race([this.transport.invoke({ endpoint: this.identity.endpoint, model: this.identity.model,
        prompt: input.prompt, maximum_tokens: claims.maximum_tokens, credential: this.providerCredential, signal: controller.signal }), timeout])
        .finally(() => { if (timer) clearTimeout(timer); });
      if (!Number.isSafeInteger(result.usage_tokens) || result.usage_tokens < 0 || result.usage_tokens > claims.maximum_tokens
        || typeof result.output !== "string" || Buffer.byteLength(result.output) > 4_194_304) throw new AnalysisRuntimeError("invalid");
      this.store.finishCall(reserved.call_id, { status: "succeeded", usage_tokens: result.usage_tokens,
        output_digest: sha256(Buffer.from(result.output)) }, this.now());
      return { call_id: reserved.call_id, output: result.output, usage_tokens: result.usage_tokens };
    } catch (error) {
      this.store.finishCall(reserved.call_id, { status: "acceptance_unknown" }, this.now());
      throw new AnalysisRuntimeError("ambiguous");
    }
  }
}

export interface AnalysisSandboxLaunch {
  executable: "/usr/bin/sandbox-exec";
  args: readonly ["-p", string, string];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdio: readonly ["pipe", "pipe", "pipe"];
  scratch_quota: Readonly<{ root: string; maximum_bytes: number; poll_interval_ms: 10; exceed_action: "SIGKILL" }>;
}
function seatbeltLiteral(value: string): string { return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\""); }
function snapshotTreeDigest(root: string): string {
  const hash = createHash("sha256"); let entries = 0;
  const visit = (relative: string): void => {
    if (++entries > 100_000) throw new AnalysisRuntimeError("invalid");
    const absolute = path.join(root, relative); const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new AnalysisRuntimeError("invalid");
    hash.update(stat.isDirectory() ? "d\0" : "f\0").update(relative).update("\0");
    if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name));
    else hash.update(String(stat.size)).update("\0").update(fs.readFileSync(absolute));
  };
  visit(""); return hash.digest("hex");
}
export function analysisSnapshotDigest(rootInput: string): string {
  return snapshotTreeDigest(fs.realpathSync(absolutePath.parse(rootInput)));
}
function scratchBytes(root: string): number {
  let total = 0; const visit = (absolute: string): void => {
    const stat = fs.lstatSync(absolute); if (stat.isSymbolicLink()) throw new AnalysisRuntimeError("denied");
    if (stat.isDirectory()) for (const name of fs.readdirSync(absolute)) visit(path.join(absolute, name)); else total += stat.size;
  }; visit(root); return total;
}
export function startAnalysisScratchGuard(launch: AnalysisSandboxLaunch, terminate: (signal: "SIGKILL") => void): () => void {
  const check = (): void => { try { if (scratchBytes(launch.scratch_quota.root) > launch.scratch_quota.maximum_bytes) terminate("SIGKILL"); }
    catch { terminate("SIGKILL"); } };
  check(); const timer = setInterval(check, launch.scratch_quota.poll_interval_ms); timer.unref(); return () => clearInterval(timer);
}
function analysisSandboxLaunch(input: { worker_executable: string; snapshot_path: string; scratch_path: string; maximum_scratch_bytes: number }): AnalysisSandboxLaunch {
  let worker: string, snapshot: string, scratch: string;
  try {
    worker = fs.realpathSync(absolutePath.parse(input.worker_executable));
    snapshot = fs.realpathSync(absolutePath.parse(input.snapshot_path));
    scratch = fs.realpathSync(absolutePath.parse(input.scratch_path));
  } catch { throw new AnalysisRuntimeError("invalid"); }
  if (!fs.statSync(worker).isFile() || !fs.statSync(snapshot).isDirectory() || !fs.statSync(scratch).isDirectory()) throw new AnalysisRuntimeError("invalid");
  if (!Number.isSafeInteger(input.maximum_scratch_bytes) || input.maximum_scratch_bytes < 1
    || scratchBytes(scratch) > input.maximum_scratch_bytes) throw new AnalysisRuntimeError("quota");
  if ([worker, snapshot, scratch].some((value) => value === "/") || snapshot === scratch || snapshot.startsWith(`${scratch}${path.sep}`)
    || scratch.startsWith(`${snapshot}${path.sep}`)) throw new AnalysisRuntimeError("invalid");
  const profile = `(version 1)\n(deny default)\n(import "system.sb")\n(allow process-info* signal (target self))\n(deny process-fork)\n(allow process-exec (literal "${seatbeltLiteral(worker)}"))\n(deny network*)\n(allow file-read* (literal "${seatbeltLiteral(worker)}") (subpath "/usr/lib") (subpath "/System/Library") (subpath "${seatbeltLiteral(snapshot)}"))\n(allow file-read* file-write* (subpath "${seatbeltLiteral(scratch)}"))\n`;
  return { executable: "/usr/bin/sandbox-exec", args: ["-p", profile, worker], cwd: scratch,
    env: Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }), stdio: ["pipe", "pipe", "pipe"],
    scratch_quota: Object.freeze({ root: scratch, maximum_bytes: input.maximum_scratch_bytes, poll_interval_ms: 10, exceed_action: "SIGKILL" }) };
}

export function authorizedAnalysisSandboxLaunch(input: { store: AnalysisRuntimeStore; snapshot_permit: string;
  current: CurrentAnalysisAuthorization; worker_executable: string; snapshot_path: string; scratch_path: string; now: string }): AnalysisSandboxLaunch {
  const snapshot = fs.realpathSync(absolutePath.parse(input.snapshot_path));
  const binding = input.store.consumeSnapshotPermit(input.snapshot_permit, input.current, snapshotTreeDigest(snapshot), input.now);
  return analysisSandboxLaunch({ worker_executable: input.worker_executable, snapshot_path: snapshot,
    scratch_path: input.scratch_path, maximum_scratch_bytes: binding.maximum_scratch_bytes });
}
