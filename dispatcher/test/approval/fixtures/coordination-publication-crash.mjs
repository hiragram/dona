import { tsImport } from "tsx/esm/api";
const { withSecurityTransactionLock, openSecurityDatabase } = await tsImport("../../../src/audit/coordination.ts", import.meta.url);
const db = openSecurityDatabase(process.argv[2]);
const prepare = db.prepare.bind(db);
db.prepare = sql => {
  const statement = prepare(sql);
  if (sql === "SELECT dona_publish_mutex(?,?) AS published") {
    const get = statement.get.bind(statement);
    statement.get = (...args) => {
      if (process.argv[3] === "before") process.exit(80);
      get(...args);
      process.exit(81);
    };
  }
  return statement;
};
withSecurityTransactionLock(db, () => {});
