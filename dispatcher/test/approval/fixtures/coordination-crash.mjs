import Database from "better-sqlite3";
import { tsImport } from "tsx/esm/api";
const { withSecurityTransactionLock } = await tsImport(
  "../../../src/audit/coordination.ts",
  import.meta.url,
);
const db = new Database(process.argv[2]);
withSecurityTransactionLock(db, () => process.exit(79));
