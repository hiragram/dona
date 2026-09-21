import type Database from "better-sqlite3";

import type { VerifiedSlackPrincipalProof } from "./principal-proof.js";

export interface VerifiedPrincipalBindingRow {
  event_id: string;
  provider: "slack";
  adapter_id: string;
  key_id: string;
  proof_sha256: string;
  event_attempt: number;
  tenant_id: string;
  workspace_id: string;
  principal_kind: "human";
  principal_id: string;
  issued_at: string;
  expires_at: string;
  nonce: string;
  consumed_at: string;
  revoked_at: string | null;
}

export class PrincipalBindingConflictError extends Error {
  readonly code = "principal_binding_conflict";
  constructor() { super("Verified principal binding conflicts with durable evidence"); this.name = "PrincipalBindingConflictError"; }
}

export function migrateVerifiedPrincipalBindings(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verified_principal_binding_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verified_principal_bindings (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider='slack'),
      adapter_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      proof_sha256 TEXT NOT NULL CHECK(length(proof_sha256)=64),
      event_attempt INTEGER NOT NULL CHECK(event_attempt>0),
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      principal_kind TEXT NOT NULL CHECK(principal_kind='human'),
      principal_id TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      nonce TEXT NOT NULL UNIQUE,
      consumed_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS verified_principal_proof_consumptions (
      proof_sha256 TEXT PRIMARY KEY CHECK(length(proof_sha256)=64),
      nonce TEXT NOT NULL UNIQUE,
      event_id TEXT NOT NULL REFERENCES verified_principal_bindings(event_id) ON DELETE CASCADE,
      event_attempt INTEGER NOT NULL CHECK(event_attempt>0),
      consumed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS verified_principal_owner_idx
      ON verified_principal_bindings(tenant_id, workspace_id, principal_kind, principal_id);
    INSERT OR IGNORE INTO verified_principal_binding_schema(singleton,version) VALUES(1,1);
  `);
  const marker = db.prepare("SELECT version FROM verified_principal_binding_schema WHERE singleton=1").get() as {version:number}|undefined;
  if (marker?.version !== 1) throw new Error("Unsupported verified principal binding schema");
}

function expected(eventId: string, proof: VerifiedSlackPrincipalProof, consumedAt: string): VerifiedPrincipalBindingRow {
  return {
    event_id: eventId,
    provider: "slack",
    adapter_id: proof.adapter_id,
    key_id: proof.key_id,
    proof_sha256: proof.proof_sha256,
    event_attempt: proof.attempt,
    tenant_id: proof.tenant_id,
    workspace_id: proof.workspace_id,
    principal_kind: proof.principal_kind,
    principal_id: proof.principal_id,
    issued_at: proof.issued_at,
    expires_at: proof.expires_at,
    nonce: proof.nonce,
    consumed_at: consumedAt,
    revoked_at: null,
  };
}

export function persistVerifiedPrincipalBinding(db: Database.Database, eventId: string, proof: VerifiedSlackPrincipalProof, consumedAt: string): void {
  const value = expected(eventId, proof, consumedAt);
  const existing = readVerifiedPrincipalBinding(db, eventId);
  if (existing) {
    const immutableKeys: Array<keyof VerifiedPrincipalBindingRow> = ["provider", "adapter_id",
      "tenant_id", "workspace_id", "principal_kind", "principal_id"];
    if (immutableKeys.some((key) => existing[key] !== value[key])) throw new PrincipalBindingConflictError();
    consumeProof(db,eventId,proof,consumedAt);
    return;
  }
  try {
    db.prepare(`INSERT INTO verified_principal_bindings(
      event_id,provider,adapter_id,key_id,proof_sha256,event_attempt,tenant_id,workspace_id,principal_kind,principal_id,
      issued_at,expires_at,nonce,consumed_at,revoked_at
    ) VALUES(@event_id,@provider,@adapter_id,@key_id,@proof_sha256,@event_attempt,@tenant_id,@workspace_id,@principal_kind,@principal_id,
      @issued_at,@expires_at,@nonce,@consumed_at,@revoked_at)`).run(value);
    consumeProof(db,eventId,proof,consumedAt);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new PrincipalBindingConflictError();
    throw error;
  }
}

function consumeProof(db: Database.Database,eventId:string,proof:VerifiedSlackPrincipalProof,consumedAt:string):void {
  const existing=db.prepare("SELECT event_id,nonce,event_attempt FROM verified_principal_proof_consumptions WHERE proof_sha256=?")
    .get(proof.proof_sha256) as {event_id:string;nonce:string;event_attempt:number}|undefined;
  if(existing) {
    if(existing.event_id!==eventId||existing.nonce!==proof.nonce||existing.event_attempt!==proof.attempt) throw new PrincipalBindingConflictError();
    return;
  }
  try {
    db.prepare("INSERT INTO verified_principal_proof_consumptions(proof_sha256,nonce,event_id,event_attempt,consumed_at) VALUES(?,?,?,?,?)")
      .run(proof.proof_sha256,proof.nonce,eventId,proof.attempt,consumedAt);
  } catch(error) {
    if(error instanceof Error&&error.message.includes("UNIQUE constraint failed")) throw new PrincipalBindingConflictError();
    throw error;
  }
}

export function readVerifiedPrincipalBinding(db: Database.Database, eventId: string): VerifiedPrincipalBindingRow | undefined {
  return db.prepare("SELECT * FROM verified_principal_bindings WHERE event_id=?").get(eventId) as VerifiedPrincipalBindingRow | undefined;
}
