import { tsImport } from "tsx/esm/api";
const { withSecurityTransactionLock, openSecurityDatabase } = await tsImport(
  "../../../src/audit/coordination.ts",
  import.meta.url,
);
const db = openSecurityDatabase(process.argv[2]);
withSecurityTransactionLock(db, () => process.exit(79));
