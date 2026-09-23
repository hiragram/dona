import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { DispatcherDatabase, type WebJobReadIdentity } from "../../src/database.js";
import { WebJobReadBroker } from "../../src/web/job-read-broker.js";
import { maintainWebJobProjection, startWebJobProjectionMaintenance } from "../../src/web/job-read-maintenance.js";
import type { RegistryPrincipal } from "../../src/web/domain.js";
import type { JobProgressPhase } from "../../src/types.js";

const owner:WebJobReadIdentity={instance_id:"instance",tenant_id:"tenant",principal_id:"principal",
  identity_binding_revision:1,authz_revision:1,authorization_kind:"own"};
const registryPrincipal=(identity:WebJobReadIdentity,options:{state?:"active"|"revoked";observer?:boolean}={}):RegistryPrincipal=>{
  const observer=options.observer??true;return{codec_version:1,instance_id:identity.instance_id,tenant_id:identity.tenant_id,
    principal_id:identity.principal_id,state:options.state??"active",revoke_generation:1,identity_binding_revision:identity.identity_binding_revision,
    authz_revision:identity.authz_revision,role_ids:observer?["observer"]:["requester"],scopes:observer?["job:read:granted"]:["job:read:own"]};};
const browserPrincipal=(identity:WebJobReadIdentity,scopes=["job:read:own"])=>(
  {instance_id:identity.instance_id,tenant_id:identity.tenant_id,principal_id:identity.principal_id,
    identity_binding_revision:identity.identity_binding_revision,authz_revision:identity.authz_revision,scopes});
const readAuth=(identity:WebJobReadIdentity,scopes=["job:read:own"],effective_utc="2026-09-21T00:01:00.000Z",
  auditJobReadOutcome:(...args:unknown[])=>boolean=()=>true)=>({verifyJobReadIngress:()=>({status:"succeeded" as const,kind:"job_read_session_verified" as const,
    principal:browserPrincipal(identity,scopes),session_ref:"session",effective_utc}),auditJobReadOutcome});
function fixture(t:TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),"dona-web-read-")),file=path.join(root,"dispatcher.sqlite3");
  const jobs=new DispatcherDatabase(file);const raw=new Database(file);raw.pragma("foreign_keys=ON");
  t.after(()=>{raw.close();jobs.close();fs.rmSync(root,{recursive:true,force:true});});
  let n=0;const seed=(identity=owner,status="running",created="2026-09-21T00:00:00.000Z")=>{n++;const eventId=`evt_web_read_${n}`;
    raw.prepare(`INSERT INTO events(event_id,schema_version,source,external_event_id,event_type,occurred_at,subject_json,payload_json,reply_target_json,status,available_at,completed_at,created_at,updated_at)
      VALUES(?,1,'web',?,'web_job_submit',?,?,'{}',NULL,'completed',?,?,?,?)`).run(eventId,`read-${n}`,created,JSON.stringify(identity),created,created,created,created);
    const jobId=`job_read_${n}`;raw.prepare(`INSERT INTO jobs(job_id,source_event_id,job_key,source,workspace_id,channel_id,thread_ts,actor_id,objective,workspace_json,status,
      attempt_count,available_at,workspace_path,result_path,agent_name,created_at,updated_at) VALUES(?,?,?,'web',?,NULL,NULL,?,'private objective','{}',?,0,?,'/private/work','/private/result',?,?,?)`)
      .run(jobId,eventId,`key-${n}`,identity.tenant_id,identity.principal_id,status,created,`agent-${n}`,created,created);return jobId;};
  return{jobs,raw,seed};}

test("principalでfilterしてstable cursorをpaginationし後発jobを混ぜない",t=>{const f=fixture(t);
  const old=f.seed(owner,"running","2026-09-21T00:00:00.000Z"),newer=f.seed(owner,"queued","2026-09-21T00:00:01.000Z");
  f.seed({...owner,principal_id:"other"},"running","2026-09-21T00:00:02.000Z");
  const first=f.jobs.listWebJobs(owner,1,undefined,new Date("2026-09-21T00:01:00.000Z"));assert.deepEqual(first.rows.map(x=>x.job_id),[newer]);assert.ok(first.next_cursor);
  const cursors=f.raw.prepare("SELECT cursor_kind,COUNT(*) AS count FROM web_job_projection_cursors GROUP BY cursor_kind").all() as Array<{cursor_kind:string;count:number}>;
  assert.deepEqual(cursors,[{cursor_kind:"list",count:1}]);
  assert.throws(()=>f.jobs.listWebJobs(owner,1,first.next_cursor!.slice(0,-1)+(first.next_cursor!.endsWith("A")?"B":"A"),new Date("2026-09-21T00:01:00.000Z")),/cursor/);
  f.seed(owner,"running","2026-09-21T00:00:03.000Z");
  const second=f.jobs.listWebJobs(owner,1,first.next_cursor!,new Date("2026-09-21T00:01:01.000Z"));assert.deepEqual(second.rows.map(x=>x.job_id),[old]);
  assert.throws(()=>f.jobs.listWebJobs({...owner,principal_id:"other"},1,first.next_cursor!,new Date("2026-09-21T00:01:01.000Z")),/cursor/);
  assert.throws(()=>f.jobs.listWebJobs({...owner,authorization_kind:"granted"},1,first.next_cursor!,new Date("2026-09-21T00:01:01.000Z")),/cursor/);
});

test("projection初期backfillは通常readで再実行しない",t=>{const f=fixture(t),job=f.seed();
  assert.deepEqual(f.jobs.listWebJobs(owner,20).rows.map(row=>row.job_id),[job]);
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_state").get() as {count:number}).count,1);
  f.raw.prepare("DELETE FROM web_job_projection_events WHERE job_id=?").run(job);
  assert.deepEqual(f.jobs.listWebJobs(owner,20).rows,[]);
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_events WHERE job_id=?").get(job) as {count:number}).count,0);
});

test("event cursorは更新をmonotonicに再生しretention gapでresetを要求する",t=>{const f=fixture(t),job=f.seed();
  const cursor=f.jobs.webJobEventCursor(owner,job,new Date("2026-09-21T00:01:00.000Z"));
  f.raw.prepare("UPDATE jobs SET status='completed',completed_at=?,updated_at=? WHERE job_id=?")
    .run("2026-09-21T00:02:00.000Z","2026-09-21T00:02:00.000Z",job);
  const changed=f.jobs.listWebJobChanges(owner,job,cursor,50,new Date("2026-09-21T00:02:01.000Z"));assert.equal(changed.reset_required,false);assert.equal(changed.rows.length,1);
  assert.deepEqual(f.jobs.listWebJobChanges(owner,job,cursor,50,new Date("2026-09-21T00:02:02.000Z")).rows,changed.rows);
  assert.equal(f.jobs.listWebJobChanges(owner,job,changed.next_cursor,50,new Date("2026-09-21T00:02:03.000Z")).rows.length,0);
  f.jobs.pruneWebJobProjection(new Date("2026-09-21T00:03:00.000Z"),new Date("2026-09-21T00:03:01.000Z"));
  f.seed(owner,"running","2026-09-21T00:04:00.000Z");
  assert.equal(f.jobs.listWebJobChanges(owner,job,cursor,50,new Date("2026-09-21T00:04:01.000Z")).reset_required,true);
});

test("同一millisecondのprojection変更もeventとして再生する",t=>{const f=fixture(t),job=f.seed(owner,"running","2026-09-21T00:00:00.000Z");
  const cursor=f.jobs.webJobEventCursor(owner,job,new Date("2026-09-21T00:01:00.000Z"));
  f.raw.prepare("UPDATE jobs SET status='blocked' WHERE job_id=?").run(job);
  const changed=f.jobs.listWebJobChanges(owner,job,cursor,50,new Date("2026-09-21T00:01:01.000Z"));
  assert.deepEqual(changed.rows.map(row=>row.event_kind),["updated"]);
});

test("非公開Resultと内部errorだけの変更をevent side channelにしない",t=>{const f=fixture(t),job=f.seed();
  const cursor=f.jobs.webJobEventCursor(owner,job,new Date("2026-09-21T00:01:00.000Z"));
  f.raw.prepare("UPDATE jobs SET result_json=?,last_error_code=? WHERE job_id=?")
    .run(JSON.stringify({summary:"private secret"}),"private_internal_code",job);
  assert.deepEqual(f.jobs.listWebJobChanges(owner,job,cursor,50,new Date("2026-09-21T00:01:01.000Z")).rows,[]);
});

test("event cursor発行時に期限切れcursorをruntime回収する",t=>{const f=fixture(t),job=f.seed();
  f.jobs.webJobEventCursor(owner,job,new Date("2026-09-21T00:01:00.000Z"));
  const insert=f.raw.prepare(`INSERT INTO web_job_projection_cursors
    (cursor_digest,cursor_kind,instance_id,tenant_id,principal_id,authorization_kind,resource_id,snapshot_sequence,expires_at,created_at)
    VALUES(?,'events',?,?,?,?,?,0,?,?)`);
  for(let index=1;index<200;index++)insert.run(index.toString(16).padStart(64,"0"),owner.instance_id,owner.tenant_id,
    owner.principal_id,owner.authorization_kind,job,"2026-09-21T01:01:00.000Z","2026-09-21T00:01:00.000Z");
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_cursors").get() as {count:number}).count,200);
  f.jobs.webJobEventCursor(owner,job,new Date("2026-09-21T02:00:00.000Z"));
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_cursors").get() as {count:number}).count,73);
});

test("旧cursor schemaと旧update triggerをtransactionalにupgradeする",t=>{const f=fixture(t),job=f.seed();
  f.jobs.webJobEventCursor(owner,job,new Date("2026-09-21T00:01:00.000Z"));
  f.raw.exec(`
    DROP TABLE web_job_projection_cursors;
    CREATE TABLE web_job_projection_cursors (
      cursor_digest TEXT PRIMARY KEY CHECK (length(cursor_digest)=64),cursor_kind TEXT NOT NULL,
      instance_id TEXT NOT NULL,tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,resource_id TEXT,
      snapshot_sequence INTEGER NOT NULL,after_created_at TEXT,after_job_id TEXT,expires_at TEXT NOT NULL,created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX web_job_projection_cursors_expiry_idx ON web_job_projection_cursors(expires_at);
    INSERT INTO web_job_projection_cursors VALUES('${"a".repeat(64)}','events','instance','tenant','principal','${job}',0,NULL,NULL,'2026-09-22T00:00:00.000Z','2026-09-21T00:00:00.000Z');
    DROP TRIGGER web_job_projection_update;
    CREATE TRIGGER web_job_projection_update AFTER UPDATE ON jobs
      WHEN new.source='web' AND old.updated_at<>new.updated_at BEGIN
        INSERT INTO web_job_projection_events(job_id,event_kind,created_at) VALUES(new.job_id,'updated',new.updated_at);
      END;
    DROP TABLE web_job_projection_schema;
  `);
  (f.jobs as unknown as {webJobProjectionReady:boolean}).webJobProjectionReady=false;
  f.jobs.webJobEventCursor(owner,job,new Date("2026-09-21T00:02:00.000Z"));
  const columns=f.raw.pragma("table_info(web_job_projection_cursors)") as Array<{name:string}>;
  assert.equal(columns.some(column=>column.name==="authorization_kind"),true);
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_cursors WHERE cursor_digest=?").get("a".repeat(64)) as {count:number}).count,0);
  assert.equal((f.raw.prepare("SELECT version FROM web_job_projection_schema WHERE singleton=1").get() as {version:number}).version,4);
  const trigger=(f.raw.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='web_job_projection_update'").get() as {sql:string}).sql;
  assert.equal(trigger.includes("old.status IS NOT new.status"),true);
  assert.equal(trigger.includes("old.result_json"),false);
});

test("version 2 cursor schemaはgrant evidence追加時に旧cursorをinvalid化する",t=>{const f=fixture(t),job=f.seed();
  f.jobs.webJobEventCursor(owner,job,new Date("2026-09-21T00:01:00.000Z"));
  f.raw.exec(`DROP TABLE web_job_projection_cursors;
    CREATE TABLE web_job_projection_cursors (
      cursor_digest TEXT PRIMARY KEY,cursor_kind TEXT NOT NULL,instance_id TEXT NOT NULL,tenant_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,authorization_kind TEXT NOT NULL,resource_id TEXT,snapshot_sequence INTEGER NOT NULL,
      after_created_at TEXT,after_job_id TEXT,expires_at TEXT NOT NULL,created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX web_job_projection_cursors_expiry_idx ON web_job_projection_cursors(expires_at);
    INSERT INTO web_job_projection_cursors VALUES('${"b".repeat(64)}','events','instance','tenant','principal','own','${job}',0,NULL,NULL,'2026-09-22T00:00:00.000Z','2026-09-21T00:00:00.000Z');
    UPDATE web_job_projection_schema SET version=2;`);
  (f.jobs as unknown as {webJobProjectionReady:boolean}).webJobProjectionReady=false;
  f.jobs.webJobEventCursor(owner,job,new Date("2026-09-21T00:02:00.000Z"));
  const columns=f.raw.pragma("table_info(web_job_projection_cursors)") as Array<{name:string}>;
  assert.equal(columns.some(column=>column.name==="grant_revision"),true);
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_cursors WHERE cursor_digest=?").get("b".repeat(64)) as {count:number}).count,0);
  assert.equal((f.raw.prepare("SELECT version FROM web_job_projection_schema").get() as {version:number}).version,4);
});

test("version 3 grantは厳格version 4 schemaへfail-closed移行する",t=>{const f=fixture(t),job=f.seed();
  f.jobs.webJobEventCursor(owner,job,new Date("2026-09-21T00:01:00.000Z"));
  f.raw.exec(`
    DROP TABLE web_job_read_grants;
    CREATE TABLE web_job_read_grants (
      grant_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,instance_id TEXT NOT NULL,tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,
      grant_revision INTEGER NOT NULL,state TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(job_id,instance_id,tenant_id,principal_id)
    ) STRICT;
    CREATE INDEX web_job_read_grants_principal_idx ON web_job_read_grants(instance_id,tenant_id,principal_id,state,expires_at,job_id);
    INSERT INTO web_job_read_grants VALUES('legacy','${job}','instance','tenant','observer',7,'active',
      '2026-09-22T00:00:00.000Z','2026-09-21T00:00:00.000Z','2026-09-21T00:00:00.000Z');
    UPDATE web_job_projection_schema SET version=3;
  `);
  (f.jobs as unknown as {webJobProjectionReady:boolean}).webJobProjectionReady=false;
  f.jobs.listWebJobs(owner,20);
  assert.equal((f.raw.prepare("SELECT version FROM web_job_projection_schema").get() as {version:number}).version,4);
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_read_grants").get() as {count:number}).count,0);
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_cursors").get() as {count:number}).count,0);
  const columns=f.raw.pragma("table_info(web_job_read_grants)") as Array<{name:string;notnull:number}>;
  for(const name of ["owner_principal_id","principal_identity_binding_revision","principal_authz_revision"])
    assert.equal(columns.find(column=>column.name===name)?.notnull,1,name);
});

test("未知のprojection schema versionはDDL前にfail closedする",t=>{const f=fixture(t),job=f.seed();
  f.jobs.webJobEventCursor(owner,job,new Date("2026-09-21T00:01:00.000Z"));
  f.raw.exec(`UPDATE web_job_projection_schema SET version=5;
    DROP TRIGGER web_job_projection_update;
    CREATE TRIGGER web_job_projection_update AFTER UPDATE ON jobs BEGIN SELECT 1; END;`);
  const before=(f.raw.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='web_job_projection_update'").get() as {sql:string}).sql;
  (f.jobs as unknown as {webJobProjectionReady:boolean}).webJobProjectionReady=false;
  assert.throws(()=>f.jobs.listWebJobs(owner,20),/schema_unsupported/);
  const after=(f.raw.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='web_job_projection_update'").get() as {sql:string}).sql;
  assert.equal(after,before);
});

test("通常job更新はwall clockが同一でもupdated_atを単調増加させる",t=>{const f=fixture(t);
  const job=f.seed(owner,"queued","2099-01-01T00:00:00.000Z");
  f.jobs.beginJobPreparation(job,new Date("2099-01-01T00:00:00.000Z"));
  const before=(f.raw.prepare("SELECT updated_at FROM jobs WHERE job_id=?").get(job) as {updated_at:string}).updated_at;
  f.jobs.setJobRuntime(job,"workspace","pane");
  const after=(f.raw.prepare("SELECT updated_at FROM jobs WHERE job_id=?").get(job) as {updated_at:string}).updated_at;
  assert.equal(Date.parse(after),Date.parse(before)+1);
});

test("detail snapshot直後の更新は同時取得したcursorから再生できる",t=>{const f=fixture(t),job=f.seed();
  const snapshot=f.jobs.webJobSnapshot(owner,job,new Date("2026-09-21T00:01:00.000Z"));assert.ok(snapshot);assert.equal(snapshot.row.status,"running");
  f.raw.prepare("UPDATE jobs SET status='completed',completed_at=?,updated_at=? WHERE job_id=?")
    .run("2026-09-21T00:02:00.000Z","2026-09-21T00:02:00.000Z",job);
  const changed=f.jobs.listWebJobChanges(owner,job,snapshot.event_cursor,50,new Date("2026-09-21T00:02:01.000Z"));
  assert.equal(changed.rows.some(row=>row.event_kind==="updated"),true);
});

test("retentionはjob anchorと有効なlist cursorを保持しtimestamp逆転の欠落をresetにする",t=>{const f=fixture(t);
  const older=f.seed(owner,"running","2026-09-21T00:00:00.000Z"),newer=f.seed(owner,"running","2026-09-21T00:00:01.000Z");
  const page=f.jobs.listWebJobs(owner,1,undefined,new Date("2026-09-21T00:01:00.000Z"));assert.deepEqual(page.rows.map(row=>row.job_id),[newer]);
  const eventCursor=f.jobs.webJobEventCursor(owner,older,new Date("2026-09-21T00:01:00.000Z"));
  f.raw.prepare("UPDATE jobs SET updated_at=? WHERE job_id=?").run("2026-09-20T23:00:00.000Z",older);
  const pruned=f.jobs.pruneWebJobProjection(new Date("2026-09-21T00:00:30.000Z"),new Date("2026-09-21T00:02:00.000Z"));assert.equal(pruned.events,1);
  const second=f.jobs.listWebJobs(owner,1,page.next_cursor!,new Date("2026-09-21T00:02:01.000Z"));assert.deepEqual(second.rows.map(row=>row.job_id),[older]);
  assert.equal(f.jobs.listWebJobChanges(owner,older,eventCursor,50,new Date("2026-09-21T00:02:01.000Z")).reset_required,true);
  const anchors=f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_events WHERE event_kind='snapshot'").get() as {count:number};assert.equal(anchors.count,2);
});

test("retentionは削除済みweb jobのanchorとtombstoneをwatermarkへ畳み込む",t=>{const f=fixture(t),job=f.seed();
  f.jobs.listWebJobs(owner,1,undefined,new Date("2026-09-21T00:01:00.000Z"));f.raw.prepare("DELETE FROM jobs WHERE job_id=?").run(job);
  const before=f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_events WHERE job_id=?").get(job) as {count:number};assert.equal(before.count,2);
  const now=Date.now();const pruned=f.jobs.pruneWebJobProjection(new Date(now+1000),new Date(now+2000));assert.equal(pruned.events,2);
  const after=f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_events WHERE job_id=?").get(job) as {count:number};assert.equal(after.count,0);
});

test("runtime maintenanceはtransactionを1000件に制限してyieldしながらbacklogを解消する",async t=>{const f=fixture(t),job=f.seed();
  f.jobs.listWebJobs(owner,20);const insert=f.raw.prepare("INSERT INTO web_job_projection_events(job_id,event_kind,created_at) VALUES(?,'progress',?)");
  const insertCursor=f.raw.prepare(`INSERT INTO web_job_projection_cursors
    (cursor_digest,cursor_kind,instance_id,tenant_id,principal_id,authorization_kind,grant_id,grant_revision,resource_id,snapshot_sequence,after_created_at,after_job_id,expires_at,created_at)
    VALUES(?,'list','instance','tenant','principal','own',NULL,NULL,NULL,0,NULL,NULL,'2026-09-21T00:00:00.000Z','2026-09-21T00:00:00.000Z')`);
  f.raw.transaction(()=>{for(let index=0;index<2200;index++)insert.run(job,"2026-09-21T00:00:01.000Z");})();
  f.raw.transaction(()=>{for(let index=0;index<1200;index++)insertCursor.run(index.toString(16).padStart(64,"0"));})();
  const first=maintainWebJobProjection(f.jobs,new Date("2026-09-23T00:00:02.000Z"));
  assert.equal(first.events+first.cursors,1000);
  const errors:unknown[]=[];const stop=startWebJobProjectionMaintenance(f.jobs,error=>errors.push(error),()=>new Date("2026-09-23T00:00:02.000Z"));
  for(let attempt=0;attempt<10;attempt++){
    const events=(f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_events WHERE job_id=?").get(job) as {count:number}).count;
    const cursors=(f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_cursors").get() as {count:number}).count;
    if(events===1&&cursors===0)break;await new Promise<void>(resolve=>setImmediate(resolve));
  }
  stop();
  assert.deepEqual(errors,[]);
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_events WHERE job_id=?").get(job) as {count:number}).count,1);
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_cursors").get() as {count:number}).count,0);
});

test("brokerはResultとartifactをallowlist projectionしprogress更新をdurable eventへ収束させる",t=>{const f=fixture(t),job=f.seed();
  f.raw.prepare("UPDATE jobs SET result_json=?,last_error_code=?,updated_at=? WHERE job_id=?").run(JSON.stringify({schema_version:1,job_id:job,status:"completed",
    summary:"完了 https://private.invalid/token /Users/private/result",output:{format:"text",text:"SECRET"},artifacts:[{name:"report",kind:"report",media_type:"text/plain",size_bytes:12,path:"/private",url:"https://private"},{name:"bad",kind:"download",url:"secret"}],completed_at:"2026-09-21T00:02:00.000Z"}),
    "safe_code","2026-09-21T00:02:00.000Z",job);
  let progress:{sequence:number;phase:JobProgressPhase;updated_at:string}={sequence:1,phase:"testing",updated_at:"2026-09-21T00:02:01.000Z"};
  const broker=new WebJobReadBroker(readAuth(owner) as never,f.jobs,{get:()=>progress});
  const detail=broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"});assert.equal(detail.status,"succeeded");if(detail.status!=="succeeded"||detail.kind!=="detail")return;
  assert.deepEqual(detail.job.result?.artifacts,[{name:"artifact-1",kind:"report",media_type:"text/plain",size_bytes:12}]);
  assert.equal(JSON.stringify(detail).includes("SECRET"),false);assert.equal(JSON.stringify(detail).includes("/private"),false);
  assert.equal(JSON.stringify(detail).includes("private.invalid"),false);assert.equal(JSON.stringify(detail).includes("/Users"),false);
  progress={sequence:2,phase:"reviewing",updated_at:"2026-09-21T00:02:02.000Z"};
  const events=broker.execute({codec_version:1,operation:"events",method:"GET",target:`/api/jobs/${job}/events`,context:"context",cursor:detail.event_cursor});
  assert.equal(events.status,"succeeded");if(events.status==="succeeded"&&events.kind==="events"){assert.equal(events.changed,true);assert.equal(events.job.progress?.sequence,2);}
  const retained=f.raw.prepare("SELECT created_at FROM web_job_projection_events WHERE job_id=? AND event_kind='progress' ORDER BY sequence DESC LIMIT 1").get(job) as {created_at:string};
  assert.equal(retained.created_at,"2026-09-21T00:01:00.000Z");
});

test("summaryとartifact名のpath・URL・token表現をbrowser projectionへ出さない",t=>{const f=fixture(t),job=f.seed();
  const summary="path=/Users/alice/key [設定](/etc/dona/secret) C:\\private\\token %2Fhome%2Falice%2Fkey ghp_1234567890abcdefghijkl";
  f.raw.prepare("UPDATE jobs SET result_json=?,updated_at=? WHERE job_id=?").run(JSON.stringify({schema_version:1,job_id:job,status:"failed",summary,
    artifacts:[{name:"safe-report.txt",kind:"report"},{name:"/etc/passwd",kind:"file"},{name:"ghp_1234567890abcdefghijkl",kind:"log"}],completed_at:"2026-09-21T00:02:00.000Z"}),"2026-09-21T00:02:00.000Z",job);
  const broker=new WebJobReadBroker(readAuth(owner) as never,f.jobs);
  const detail=broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"});assert.equal(detail.status,"succeeded");
  const encoded=JSON.stringify(detail);for(const secret of ["/Users","/etc","C:\\\\private","%2Fhome","ghp_"])assert.equal(encoded.includes(secret),false,secret);
  if(detail.status==="succeeded"&&detail.kind==="detail")assert.deepEqual(detail.job.result?.artifacts,
    [{name:"artifact-1",kind:"report"},{name:"artifact-2",kind:"file"},{name:"artifact-3",kind:"log"}]);
});

test("固定terminal summaryは非公開raw summaryの長さと文字種に依存しない",t=>{const f=fixture(t),job=f.seed();
  f.raw.prepare("UPDATE jobs SET result_json=?,updated_at=? WHERE job_id=?").run(JSON.stringify({schema_version:1,job_id:job,status:"completed",
    summary:"secret="+"x".repeat(3000)+"\u0000",completed_at:"2026-09-21T00:02:00.000Z"}),"2026-09-21T00:02:00.000Z",job);
  const broker=new WebJobReadBroker(readAuth(owner) as never,f.jobs);
  const detail=broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"});
  assert.equal(detail.status,"succeeded");if(detail.status==="succeeded"&&detail.kind==="detail")assert.equal(detail.job.result?.summary,"完了");
});

test("別principalと未知jobを同じnot_found projectionにする",t=>{const f=fixture(t),job=f.seed();
  const other={...owner,principal_id:"other"};
  const broker=new WebJobReadBroker(readAuth(other) as never,f.jobs);
  assert.deepEqual(broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"}),{status:"denied",reason:"not_found"});
  assert.deepEqual(broker.execute({codec_version:1,operation:"detail",method:"GET",target:"/api/jobs/job_missing",context:"context"}),{status:"denied",reason:"not_found"});
});

test("can_cancelはowner・scope・現行cancel受付状態を満たす場合だけ公開する",t=>{const f=fixture(t);
  const broker=new WebJobReadBroker(readAuth(owner,["job:read:own","job:cancel:own"]) as never,f.jobs);
  for(const [status,expected] of [["queued",true],["preparing",true],["dispatching",true],["retryable_failed",true],["running",true],["blocked",true],["needs_review",true],["cancelling",false],["completed",false]] as const){
    const job=f.seed(owner,status);const detail=broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"});
    assert.equal(detail.status,"succeeded");if(detail.status==="succeeded"&&detail.kind==="detail")assert.equal(detail.job.control.can_cancel,expected,status);
  }
  const unknown=f.seed(owner,"needs_review");f.raw.prepare("UPDATE jobs SET last_error_code='web_cancel_acceptance_unknown' WHERE job_id=?").run(unknown);
  const unknownDetail=broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${unknown}`,context:"context"});
  assert.equal(unknownDetail.status,"succeeded");if(unknownDetail.status==="succeeded"&&unknownDetail.kind==="detail")assert.equal(unknownDetail.job.control.can_cancel,false);
  const withoutScope=new WebJobReadBroker(readAuth(owner,["job:read:own"]) as never,f.jobs);
  const ownJob=f.seed(owner,"running"),ownDetail=withoutScope.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${ownJob}`,context:"context"});
  assert.equal(ownDetail.status,"succeeded");if(ownDetail.status==="succeeded"&&ownDetail.kind==="detail")assert.equal(ownDetail.job.control.can_cancel,false);
});

test("observerはcurrent明示grantのjobだけを読めて失効後はnot_foundになる",t=>{const f=fixture(t),job=f.seed();
  const observer:WebJobReadIdentity={...owner,principal_id:"observer",authorization_kind:"granted"};
  const grantInput={operation_id:"grant_issue_1",operation:"grant" as const,job_id:job,expected_owner_principal_id:owner.principal_id,
    principal_id:observer.principal_id,principal_identity_binding_revision:observer.identity_binding_revision,
    principal_authz_revision:observer.authz_revision,expected_grant_revision:0,expires_at:"2026-09-22T00:00:00.000Z"};
  assert.throws(()=>f.jobs.mutateWebJobReadGrant(grantInput,undefined,new Date("2026-09-21T00:00:00.000Z")),/not_found/);
  assert.throws(()=>f.jobs.mutateWebJobReadGrant(grantInput,registryPrincipal({...observer,identity_binding_revision:2}),new Date("2026-09-21T00:00:00.000Z")),/not_found/);
  assert.throws(()=>f.jobs.mutateWebJobReadGrant(grantInput,registryPrincipal(observer,{state:"revoked"}),new Date("2026-09-21T00:00:00.000Z")),/not_found/);
  assert.throws(()=>f.jobs.mutateWebJobReadGrant(grantInput,registryPrincipal(observer,{observer:false}),new Date("2026-09-21T00:00:00.000Z")),/not_found/);
  const issued=f.jobs.mutateWebJobReadGrant(grantInput,registryPrincipal(observer),new Date("2026-09-21T00:00:00.000Z"));assert.equal(issued.outcome,"created");
  assert.deepEqual(f.jobs.mutateWebJobReadGrant(grantInput,undefined,new Date("2026-09-21T00:01:00.000Z")),{...issued,outcome:"reused"});
  assert.throws(()=>f.jobs.mutateWebJobReadGrant({...grantInput,principal_authz_revision:2},registryPrincipal({...observer,authz_revision:2}),new Date("2026-09-21T00:01:00.000Z")),/idempotency/);
  const broker=new WebJobReadBroker(readAuth(observer,["job:read:granted"]) as never,f.jobs);
  const detail=broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"});assert.equal(detail.status,"succeeded");
  if(detail.status!=="succeeded"||detail.kind!=="detail")return;
  assert.equal(detail.job.control.can_cancel,false);
  const stalePrincipal=new WebJobReadBroker(readAuth({...observer,authz_revision:2},["job:read:granted"]) as never,f.jobs);
  assert.deepEqual(stalePrincipal.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"}),
    {status:"denied",reason:"not_found"});
  const bound=f.raw.prepare("SELECT grant_id,grant_revision FROM web_job_projection_cursors WHERE resource_id=?").get(job);
  assert.deepEqual(bound,{grant_id:issued.grant_id,grant_revision:1});
  const {expires_at:_expires,...grantBinding}=grantInput;
  const revoked=f.jobs.mutateWebJobReadGrant({...grantBinding,operation_id:"grant_revoke_1",operation:"revoke",expected_grant_revision:1},undefined,
    new Date("2026-09-21T00:02:00.000Z"));assert.equal(revoked.grant_revision,2);
  assert.deepEqual(broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"}),{status:"denied",reason:"not_found"});
  const regranted=f.jobs.mutateWebJobReadGrant({...grantInput,operation_id:"grant_issue_2",expected_grant_revision:2},registryPrincipal(observer),
    new Date("2026-09-21T00:03:00.000Z"));assert.equal(regranted.grant_revision,3);
  assert.throws(()=>f.jobs.listWebJobChanges(observer,job,detail.event_cursor,50,new Date("2026-09-21T00:03:01.000Z")),/cursor/);
  assert.equal((f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_read_grant_mutations").get() as {count:number}).count,3);
  assert.throws(()=>f.raw.prepare("DELETE FROM web_job_read_grant_mutations").run(),/immutable/);
});

test("grantとcursor期限は認証transactionの保護時刻で評価する",t=>{const f=fixture(t),job=f.seed();
  const observer:WebJobReadIdentity={...owner,principal_id:"clocked",authorization_kind:"granted"};f.jobs.listWebJobs(owner,20);
  f.jobs.mutateWebJobReadGrant({operation_id:"grant_clock_1",operation:"grant",job_id:job,expected_owner_principal_id:owner.principal_id,
    principal_id:observer.principal_id,principal_identity_binding_revision:observer.identity_binding_revision,
    principal_authz_revision:observer.authz_revision,expected_grant_revision:0,expires_at:"2026-09-21T00:01:30.000Z"},registryPrincipal(observer),new Date("2026-09-21T00:00:00.000Z"));
  const broker=new WebJobReadBroker(readAuth(observer,["job:read:granted"],"2026-09-21T00:02:00.000Z") as never,f.jobs);
  assert.deepEqual(broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"}),
    {status:"denied",reason:"not_found"});
});

test("job readの最終outcomeを専用operationとsafe resourceで監査する",t=>{const f=fixture(t),job=f.seed();
  const calls:unknown[][]=[],broker=new WebJobReadBroker(readAuth(owner,["job:read:own"],"2026-09-21T00:01:00.000Z",(...args)=>{calls.push(args);return true;}) as never,f.jobs);
  assert.equal(broker.execute({codec_version:1,operation:"list",method:"GET",target:"/api/jobs",context:"context"}).status,"succeeded");
  assert.deepEqual(broker.execute({codec_version:1,operation:"detail",method:"GET",target:"/api/jobs/job_missing",context:"context"}),{status:"denied",reason:"not_found"});
  assert.deepEqual(calls.map(call=>call.slice(2)),[["web.job_list.v1","web_jobs","succeeded","none"],
    ["web.job_read.v1","job_missing","denied","resource_not_visible"]]);
  const stale=new WebJobReadBroker(readAuth(owner,["job:read:own"],"2026-09-21T00:01:00.000Z",()=>false) as never,f.jobs);
  assert.deepEqual(stale.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"}),
    {status:"denied",reason:"identity_unavailable"});
  const failed=new WebJobReadBroker(readAuth(owner,["job:read:own"],"2026-09-21T00:01:00.000Z",()=>{throw Error("web_job_cursor_invalid");}) as never,f.jobs);
  assert.deepEqual(failed.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"}),
    {status:"denied",reason:"internal_error"});
});

test("ownとgrantedの両scopeは両方のjobをunionしcursorへbindする",t=>{const f=fixture(t);
  const dual:WebJobReadIdentity={...owner,principal_id:"dual",authorization_kind:"own_or_granted"};
  const ownJob=f.seed(dual,"running","2026-09-21T00:00:01.000Z"),grantedJob=f.seed(owner,"running","2026-09-21T00:00:00.000Z");
  f.jobs.listWebJobs(owner,20);
  f.jobs.mutateWebJobReadGrant({operation_id:"grant_dual_1",operation:"grant",job_id:grantedJob,expected_owner_principal_id:owner.principal_id,
    principal_id:dual.principal_id,principal_identity_binding_revision:dual.identity_binding_revision,principal_authz_revision:dual.authz_revision,
    expected_grant_revision:0,expires_at:"2026-09-22T00:00:00.000Z"},registryPrincipal(dual),new Date("2026-09-21T00:00:00.000Z"));
  const broker=new WebJobReadBroker(readAuth(dual,["job:read:own","job:read:granted"]) as never,f.jobs);
  const list=broker.execute({codec_version:1,operation:"list",method:"GET",target:"/api/jobs?limit=1",context:"context",limit:1});
  assert.equal(list.status,"succeeded");if(list.status!=="succeeded"||list.kind!=="list")return;
  assert.deepEqual(list.items.map(item=>item.job_id),[ownJob]);const next=list.next_cursor;assert.ok(next);
  assert.throws(()=>f.jobs.listWebJobs({...dual,authorization_kind:"own"},1,next),/cursor/);
  const second=broker.execute({codec_version:1,operation:"list",method:"GET",target:`/api/jobs?limit=1&cursor=${encodeURIComponent(next)}`,
    context:"context",limit:1,cursor:next});
  assert.equal(second.status,"succeeded");if(second.status==="succeeded"&&second.kind==="list")assert.deepEqual(second.items.map(item=>item.job_id),[grantedJob]);
  f.jobs.mutateWebJobReadGrant({operation_id:"grant_dual_revoke",operation:"revoke",job_id:grantedJob,expected_owner_principal_id:owner.principal_id,
    principal_id:dual.principal_id,principal_identity_binding_revision:dual.identity_binding_revision,principal_authz_revision:dual.authz_revision,
    expected_grant_revision:1},undefined,new Date("2026-09-21T00:01:00.000Z"));
  const after=broker.execute({codec_version:1,operation:"list",method:"GET",target:"/api/jobs",context:"context"});
  assert.equal(after.status,"succeeded");if(after.status==="succeeded"&&after.kind==="list")assert.deepEqual(after.items.map(item=>item.job_id),[ownJob]);
});
