import Database from "better-sqlite3";
import {WebStateError} from "./model.js";
const sql=`
 CREATE TABLE web_auth_schema (version INTEGER PRIMARY KEY CHECK(version=1)) STRICT;
 INSERT INTO web_auth_schema VALUES(1);
 CREATE TABLE web_auth_state (
  instance_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK(length(CAST(state_json AS BLOB))<=4194304),
  PRIMARY KEY(instance_id,tenant_id)
 ) STRICT;
 CREATE TABLE web_auth_payloads (
  instance_id TEXT NOT NULL, tenant_id TEXT NOT NULL, payload_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB))<=16384),
  PRIMARY KEY(instance_id,tenant_id,payload_ref),
  FOREIGN KEY(instance_id,tenant_id) REFERENCES web_auth_state(instance_id,tenant_id)
 ) STRICT;
`;
const shapeSql="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(lower(name),1,9)='web_auth_' OR substr(lower(tbl_name),1,9)='web_auth_' ORDER BY type,name";
const shadowSql="SELECT 1 FROM sqlite_temp_master WHERE substr(lower(name),1,9)='web_auth_' OR substr(lower(tbl_name),1,9)='web_auth_'";
let expected:string|undefined;
function shape(db:Database.Database):string{return JSON.stringify(db.prepare(shapeSql).all());}
export function verifyWebAuthSchema(db:Database.Database):void {
 try{
  if(expected===undefined){const fixture=new Database(":memory:");try{fixture.exec(sql);expected=shape(fixture);}finally{fixture.close();}}
  if(shape(db)!==expected || db.prepare(shadowSql).get() || db.pragma("foreign_keys",{simple:true})!==1
    || db.pragma("ignore_check_constraints",{simple:true})!==0 || db.pragma("encoding",{simple:true})!=="UTF-8")throw new WebStateError();
  const versions=db.prepare("SELECT version FROM web_auth_schema").all() as Array<{version:number}>;
  if(versions.length!==1 || versions[0]?.version!==1)throw new WebStateError();
 }catch{throw new WebStateError();}
}
/** Installs empty opt-in containers only. It does not initialize authenticated
 * metadata, registry entries, payloads, keys, a clock or an audit trust root. */
export function installWebAuthSchema(db:Database.Database):void {
 try{
  if(db.inTransaction)throw new WebStateError();
  db.transaction(()=>{
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='web_auth_schema' AND type='table'").get()){verifyWebAuthSchema(db);return;}
   if(db.prepare(shapeSql).get() || db.prepare(shadowSql).get())throw new WebStateError();
   db.exec(sql);verifyWebAuthSchema(db);
  }).immediate();
 }catch{throw new WebStateError();}
}
