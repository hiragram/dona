import type Database from "better-sqlite3";
import { z } from "zod";
import { assertSecurityDurability } from "../audit/durability.js";
import { verifyOpenDatabaseFile } from "../audit/file-identity.js";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { verifyApprovalIndexSchema } from "./schema.js";
import { encodeApprovalRecord, type ApprovalRecord, type ApprovalRecordKind, type ApprovalRecordScope } from "./record-codec.js";

type Column = { name: string; bytes?: number; integer?: "positive" | "counter"; nullable: boolean };
type Table = { name: string; primary: string; columns: readonly Column[]; mutable: readonly string[] };
const text = (name: string, bytes = 128, nullable = false): Column => ({ name, bytes, nullable });
const integer = (name: string, kind: "positive" | "counter" = "positive", nullable = false): Column => ({ name, integer: kind, nullable });
// SQL identifierはこの固定定義だけから生成し、callerの文字列を補間しない。
const tables: Record<ApprovalRecordKind, Table> = {
  request: { name: "approval_requests", primary: "request_id", mutable: ["state", "revision", "consume_expires_at"], columns: [
    text("request_id"), text("instance_id"), text("workspace_id"), text("creation_key", 64), text("snapshot_json", 262144),
    text("semantic_hash", 64), text("binding_id"), integer("binding_revision"), integer("policy_revision"), text("model_version"),
    text("state", 32), integer("revision"), text("created_at", 24), text("expires_at", 24), text("consume_expires_at", 24, true), text("clock_transaction_id"),
  ] },
  decision: { name: "approval_decisions", primary: "request_id", mutable: [], columns: [
    text("decision_id"), text("request_id"), text("instance_id"), text("workspace_id"), text("semantic_hash", 64), text("binding_id"), integer("binding_revision"),
    text("kind", 16), text("actor_kind", 16), text("actor_id"), integer("presentation_revision", "positive", true), text("decided_at", 24), text("clock_transaction_id"),
  ] },
  consume: { name: "approval_consumes", primary: "request_id", mutable: [], columns: [
    text("consume_id"), text("request_id"), text("decision_id"), text("decision_kind", 16), text("attempt_id"), text("claimed_at", 24), text("clock_transaction_id"),
  ] },
  execution: { name: "approval_execution_attempts", primary: "attempt_id", mutable: ["state", "fence", "receipt_ref", "failure_code"], columns: [
    text("attempt_id"), text("request_id"), text("consume_id"), text("state", 32), integer("fence"), text("claimed_at", 24), text("execution_expires_at", 24),
    text("payload_expires_at", 24), text("receipt_ref", 128, true), text("failure_code", 64, true), text("clock_transaction_id"),
  ] },
  notification: { name: "approval_notifications", primary: "notification_attempt_id", mutable: ["state", "fence", "message_ref"], columns: [
    text("notification_attempt_id"), text("request_id"), text("kind", 32), text("state", 32), integer("request_revision"), integer("presentation_revision"),
    text("marker_mac", 64), integer("marker_key_version"), integer("fence", "counter"), text("message_ref", 128, true), text("clock_transaction_id"),
  ] },
  event: { name: "approval_event_outbox", primary: "event_id", mutable: ["state", "delivered_at"], columns: [
    text("event_id"), text("decision_id"), text("kind", 64), text("state", 32), text("delivered_at", 24, true),
  ] },
  presentation: { name: "approval_presentation_updates", primary: "update_id", mutable: ["state", "fence"], columns: [
    text("update_id"), text("notification_attempt_id"), text("message_ref"), integer("desired_revision"), text("state", 32), integer("fence", "counter"), text("clock_transaction_id"),
  ] },
};
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scopeSchema = z.strictObject({ instance_id: id, workspace_id: id });
const kindSchema = z.enum(["request", "decision", "consume", "execution", "notification", "event", "presentation"]);
const queries = Object.fromEntries(Object.entries(tables).map(([kind, table]) => {
  const predicate = table.columns.map(column => {
    const valid = column.integer ? `typeof(${column.name})='integer' AND ${column.name} BETWEEN ${column.integer === "positive" ? 1 : 0} AND 9007199254740991`
      : `typeof(${column.name})='text' AND length(CAST(${column.name} AS BLOB)) BETWEEN 1 AND ${column.bytes}`;
    return column.nullable ? `(${column.name} IS NULL OR (${valid}))` : `(${valid})`;
  }).join(" AND ");
  const json = table.columns.map(column => `'${column.name}',${column.name}`).join(",");
  return [kind, {
    read: `SELECT CASE WHEN ${predicate} THEN json_object(${json}) ELSE NULL END AS row_json FROM main.${table.name} WHERE ${table.primary}=?`,
    insert: `INSERT INTO main.${table.name}(${table.columns.map(column => column.name).join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`,
    update: table.mutable.length ? `UPDATE main.${table.name} SET ${table.mutable.map(name => `${name}=?`).join(",")} WHERE ${table.primary}=? AND ${table.mutable.map(name => `${name} IS ?`).join(" AND ")}` : null,
  }];
})) as Record<ApprovalRecordKind, { read: string; insert: string; update: string | null }>;
export class ApprovalRecordSqlError extends Error {
  constructor() { super("approval_record_sql_unverified"); this.name = "ApprovalRecordSqlError"; }
}
export interface ApprovalRecordSqlChange { readonly previous: ApprovalRecord | null; readonly next: ApprovalRecord }
/** 構造を検証したSQL recordのみ。parent/root/actor/binding/stateの認証は
 * 上位repositoryで別途必要。transportから直接呼び出すAPIではない。 */
export class ApprovalRecordSql {
  private readonly scope: ApprovalRecordScope;
  constructor(private readonly db: Database.Database, scope: ApprovalRecordScope) {
    try {
      assertSynchronousResult(scope); this.scope = Object.freeze(scopeSchema.parse(scope));
      if (db.inTransaction) throw Error();
      assertSecurityDurability(db); verifyOpenDatabaseFile(db); verifyApprovalIndexSchema(db);
    } catch { throw new ApprovalRecordSqlError(); }
  }
  read(kindInput: ApprovalRecordKind, primaryKey: string): ApprovalRecord | null {
    try {
      if (!this.db.inTransaction) throw Error();
      verifyOpenDatabaseFile(this.db); verifyApprovalIndexSchema(this.db);
      const kind = kindSchema.parse(kindInput); id.parse(primaryKey);
      const row = this.db.prepare(queries[kind].read).get(primaryKey) as { row_json: string | null } | undefined;
      if (row === undefined) return null;
      if (row.row_json === null || Buffer.byteLength(row.row_json) > 512 * 1024 + 8192) throw Error();
      return encodeApprovalRecord({ codec_version: 1, scope: this.scope, kind, row: JSON.parse(row.row_json) }, this.scope).record;
    } catch { throw new ApprovalRecordSqlError(); }
    finally { try { verifyOpenDatabaseFile(this.db); } catch { throw new ApprovalRecordSqlError(); } }
  }
  /** 同じ共有監査mutation内でのみ使用し、例外は必ずtransactionまで伝播する。
   * これはSQL保存だけで、audit root更新と認可を代行しない。 */
  stage(input: readonly ApprovalRecordSqlChange[]): void {
    try {
      assertSynchronousResult(input);
      if (!this.db.inTransaction || !Array.isArray(input) || input.length < 1 || input.length > 16) throw Error();
      verifyOpenDatabaseFile(this.db); verifyApprovalIndexSchema(this.db);
      const seen = new Set<string>(); let bytes = 0;
      const changes = input.map(change => {
        if (Object.keys(change).sort().join(",") !== "next,previous") throw Error();
        const next = encodeApprovalRecord(change.next, this.scope);
        const previous = change.previous === null ? null : encodeApprovalRecord(change.previous, this.scope);
        if (seen.has(next.key) || (previous !== null && previous.key !== next.key)) throw Error();
        seen.add(next.key); bytes += Buffer.byteLength(next.canonical) + (previous ? Buffer.byteLength(previous.canonical) : 0);
        if (bytes > 8 * 1024 * 1024) throw Error();
        const table = tables[next.record.kind], row = next.record.row as unknown as Record<string, string | number | null>;
        const old = previous?.record.row as unknown as Record<string, string | number | null> | undefined;
        if (old && table.columns.some(column => !table.mutable.includes(column.name) && row[column.name] !== old[column.name])) throw Error();
        const primary = row[table.primary] as string;
        const actual = this.read(next.record.kind, primary);
        if ((actual === null ? null : encodeApprovalRecord(actual, this.scope).digest) !== (previous?.digest ?? null)) throw Error();
        return { next, previous, table, row, old, primary };
      });
      for (const { next, previous, table, row, old, primary } of changes) {
        if (previous?.digest === next.digest) continue;
        const query = queries[next.record.kind];
        const result = previous === null ? this.db.prepare(query.insert).run(...table.columns.map(column => row[column.name]!))
          : query.update !== null && old ? this.db.prepare(query.update).run(...table.mutable.map(name => row[name]!), primary, ...table.mutable.map(name => old[name]!)) : null;
        if (result === null || result.changes !== 1) throw Error();
      }
      // deferred FKで循環するconsume/attemptも、全変更後に一括照合する。
      for (const { next, primary } of changes) {
        const actual = this.read(next.record.kind, primary);
        if (actual === null || encodeApprovalRecord(actual, this.scope).digest !== next.digest) throw Error();
      }
    } catch { throw new ApprovalRecordSqlError(); }
    finally { try { verifyOpenDatabaseFile(this.db); } catch { throw new ApprovalRecordSqlError(); } }
  }
}
