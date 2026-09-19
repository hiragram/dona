import type Database from "better-sqlite3";
import { withClockRowsReadOnly } from "../audit/file-identity.js";
import type { ClockMark } from "./clock.js";

/** Internal step inside the shared audit mutation guard. Existing immutable
 * creation references remain unchanged; every newly inserted ledger must use
 * this transaction's verified mark. No independent authority is granted here. */
export function applyClockBoundMutation<T>(db: Database.Database, mark: Readonly<ClockMark>, mutation: () => T): T {
  if (!db.inTransaction) throw new Error("approval_clock_provenance_unverified");
  const encoded = JSON.stringify(mark);
  db.prepare("INSERT INTO main.approval_clock_reservations VALUES (?,?)").run(mark.transaction_id, encoded);
  const result = withClockRowsReadOnly(db, mark.transaction_id, mutation);
  const saved = db.prepare("SELECT mark_json FROM main.approval_clock_reservations WHERE transaction_id=?").get(mark.transaction_id) as { mark_json: string } | undefined;
  if (saved?.mark_json !== encoded) throw new Error("approval_clock_provenance_unverified");
  return result;
}
