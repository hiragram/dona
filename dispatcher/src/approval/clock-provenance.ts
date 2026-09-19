import type Database from "better-sqlite3";
import { withClockRowsReadOnly } from "../audit/file-identity.js";
import type { ClockMark } from "./clock.js";

const ledgers = [
  ["approval_requests", "request_id"],
  ["approval_decisions", "decision_id"],
  ["approval_consumes", "consume_id"],
  ["approval_execution_attempts", "attempt_id"],
  ["approval_notifications", "notification_attempt_id"],
  ["approval_presentation_updates", "update_id"],
] as const;

/** Internal step inside the shared audit mutation guard. Existing immutable
 * creation references remain unchanged; every newly inserted ledger must use
 * this transaction's verified mark. No independent authority is granted here. */
export function applyClockBoundMutation<T>(db: Database.Database, mark: Readonly<ClockMark>, mutation: () => T): T {
  if (!db.inTransaction) throw new Error("approval_clock_provenance_unverified");
  const previous = ledgers.map(([table, key]) => new Set(
    (db.prepare(`SELECT ${key} AS id FROM main.${table}`).all() as Array<{ id: string }>).map(row => row.id),
  ));
  const count = () => (db.prepare("SELECT count(*) AS n FROM main.approval_clock_reservations").get() as { n: number }).n;
  const priorCount = count();
  const encoded = JSON.stringify(mark);
  db.prepare("INSERT INTO main.approval_clock_reservations VALUES (?,?)").run(mark.transaction_id, encoded);
  const result = withClockRowsReadOnly(db, mutation);
  const saved = db.prepare("SELECT mark_json FROM main.approval_clock_reservations WHERE transaction_id=?").get(mark.transaction_id) as { mark_json: string } | undefined;
  if (count() !== priorCount + 1 || saved?.mark_json !== encoded) throw new Error("approval_clock_provenance_unverified");
  for (const [index, [table, key]] of ledgers.entries()) {
    const rows = db.prepare(`SELECT ${key} AS id,clock_transaction_id AS clock FROM main.${table}`).all() as Array<{ id: string; clock: string }>;
    if (rows.some(row => !previous[index]!.has(row.id) && row.clock !== mark.transaction_id)) {
      throw new Error("approval_clock_provenance_unverified");
    }
  }
  return result;
}
