import fs from "node:fs";
import { openSecurityDatabase } from "../../../src/audit/coordination.js";
import { ApprovalConsumeBroker, ApprovalConsumeError } from "../../../src/approval/consume-broker.js";
import { ApprovalRecordRepository } from "../../../src/approval/record-repository.js";
import { fixtureHeadProviders } from "./consume-heads.js";
import { fixtureConsumeAuthority } from "./consume-authority.js";
import { scope, content, wrapping, notification } from "./broker.js";
const [filename,heads,request,transaction,held,release]=process.argv.slice(2) as [string,string,string,string,string,string];
const db=openSecurityDatabase(filename);db.pragma("journal_mode=WAL");db.pragma("synchronous=FULL");db.pragma("foreign_keys=ON");
const providers=fixtureHeadProviders(heads),records=new ApprovalRecordRepository(db,providers.auditAnchors,providers.auditKeys,scope),authorize=fixtureConsumeAuthority(records);
const broker=new ApprovalConsumeBroker(db,providers,scope,(...args)=>{
  if(transaction==="consume_one"){
    fs.writeFileSync(held,"held",{mode:0o600,flag:"wx"});const deadline=performance.now()+10000;
    while(!fs.existsSync(release)){if(performance.now()>deadline)throw Error("fixture_release_timeout");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
  }
  return authorize(...args);
},()=>content,()=>wrapping,()=>notification);
process.send?.({kind:"ready"});
process.once("message",message=>{
  if(message!=="start")process.exit(2);
  let result:unknown;
  try{result={kind:"result",result:broker.consume(transaction,{request_handle:request,authority_ref:"fixture_consumer_connection",expected_revision:3})};}
  catch(error){result={kind:"result",error:error instanceof ApprovalConsumeError?"approval_consume_unverified":"unexpected_fixture_error"};}
  db.close();process.send?.(result,()=>process.exit(0));
});
