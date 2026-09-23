import { tsImport } from "tsx/esm/api";
const { withSecurityTransactionLock, openSecurityDatabase } = await tsImport("../../../src/audit/coordination.ts", import.meta.url);
const duration = Number(process.argv[3]);
if (!Number.isSafeInteger(duration) || duration < 0 || duration > 5000) throw new Error("fixture_invalid_duration");
const db = openSecurityDatabase(process.argv[2]);
try {
  withSecurityTransactionLock(db, () => {
    process.send({ kind: "locked" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
  });
} finally { db.close(); }
