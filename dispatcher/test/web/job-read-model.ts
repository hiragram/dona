import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { DispatcherDatabase, type WebJobReadIdentity } from "../../src/database.js";
import { WebJobReadBroker } from "../../src/web/job-read-broker.js";
import type { JobProgressPhase } from "../../src/types.js";

const owner:WebJobReadIdentity={instance_id:"instance",tenant_id:"tenant",principal_id:"principal"};
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
  const pruned=f.jobs.pruneWebJobProjection(new Date("2026-09-22T00:00:00.000Z"),new Date("2026-09-22T00:00:01.000Z"));assert.equal(pruned.events,2);
  const after=f.raw.prepare("SELECT COUNT(*) AS count FROM web_job_projection_events WHERE job_id=?").get(job) as {count:number};assert.equal(after.count,0);
});

test("brokerはResultとartifactをallowlist projectionしprogress更新をdurable eventへ収束させる",t=>{const f=fixture(t),job=f.seed();
  f.raw.prepare("UPDATE jobs SET result_json=?,last_error_code=?,updated_at=? WHERE job_id=?").run(JSON.stringify({schema_version:1,job_id:job,status:"completed",
    summary:"完了 https://private.invalid/token /Users/private/result",output:{format:"text",text:"SECRET"},artifacts:[{name:"report",kind:"report",media_type:"text/plain",size_bytes:12,path:"/private",url:"https://private"},{name:"bad",kind:"download",url:"secret"}],completed_at:"2026-09-21T00:02:00.000Z"}),
    "safe_code","2026-09-21T00:02:00.000Z",job);
  let progress:{sequence:number;phase:JobProgressPhase;updated_at:string}={sequence:1,phase:"testing",updated_at:"2026-09-21T00:02:01.000Z"};
  const auth={verifySessionIngress:()=>({status:"succeeded",kind:"session_verified",principal:{...owner}})},broker=new WebJobReadBroker(auth as never,f.jobs,{get:()=>progress});
  const detail=broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"});assert.equal(detail.status,"succeeded");if(detail.status!=="succeeded"||detail.kind!=="detail")return;
  assert.deepEqual(detail.job.result?.artifacts,[{name:"artifact-1",kind:"report",media_type:"text/plain",size_bytes:12}]);
  assert.equal(JSON.stringify(detail).includes("SECRET"),false);assert.equal(JSON.stringify(detail).includes("/private"),false);
  assert.equal(JSON.stringify(detail).includes("private.invalid"),false);assert.equal(JSON.stringify(detail).includes("/Users"),false);
  progress={sequence:2,phase:"reviewing",updated_at:"2026-09-21T00:02:02.000Z"};
  const events=broker.execute({codec_version:1,operation:"events",method:"GET",target:`/api/jobs/${job}/events`,context:"context",cursor:detail.event_cursor});
  assert.equal(events.status,"succeeded");if(events.status==="succeeded"&&events.kind==="events"){assert.equal(events.changed,true);assert.equal(events.job.progress?.sequence,2);}
});

test("summaryとartifact名のpath・URL・token表現をbrowser projectionへ出さない",t=>{const f=fixture(t),job=f.seed();
  const summary="path=/Users/alice/key [設定](/etc/dona/secret) C:\\private\\token %2Fhome%2Falice%2Fkey ghp_1234567890abcdefghijkl";
  f.raw.prepare("UPDATE jobs SET result_json=?,updated_at=? WHERE job_id=?").run(JSON.stringify({schema_version:1,job_id:job,status:"failed",summary,
    artifacts:[{name:"safe-report.txt",kind:"report"},{name:"/etc/passwd",kind:"file"},{name:"ghp_1234567890abcdefghijkl",kind:"log"}],completed_at:"2026-09-21T00:02:00.000Z"}),"2026-09-21T00:02:00.000Z",job);
  const broker=new WebJobReadBroker({verifySessionIngress:()=>({status:"succeeded",kind:"session_verified",principal:{...owner}})} as never,f.jobs);
  const detail=broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"});assert.equal(detail.status,"succeeded");
  const encoded=JSON.stringify(detail);for(const secret of ["/Users","/etc","C:\\\\private","%2Fhome","ghp_"])assert.equal(encoded.includes(secret),false,secret);
  if(detail.status==="succeeded"&&detail.kind==="detail")assert.deepEqual(detail.job.result?.artifacts,
    [{name:"artifact-1",kind:"report"},{name:"artifact-2",kind:"file"},{name:"artifact-3",kind:"log"}]);
});

test("固定terminal summaryは非公開raw summaryの長さと文字種に依存しない",t=>{const f=fixture(t),job=f.seed();
  f.raw.prepare("UPDATE jobs SET result_json=?,updated_at=? WHERE job_id=?").run(JSON.stringify({schema_version:1,job_id:job,status:"completed",
    summary:"secret="+"x".repeat(3000)+"\u0000",completed_at:"2026-09-21T00:02:00.000Z"}),"2026-09-21T00:02:00.000Z",job);
  const broker=new WebJobReadBroker({verifySessionIngress:()=>({status:"succeeded",kind:"session_verified",principal:{...owner}})} as never,f.jobs);
  const detail=broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"});
  assert.equal(detail.status,"succeeded");if(detail.status==="succeeded"&&detail.kind==="detail")assert.equal(detail.job.result?.summary,"完了");
});

test("別principalと未知jobを同じnot_found projectionにする",t=>{const f=fixture(t),job=f.seed();
  const auth={verifySessionIngress:()=>({status:"succeeded",kind:"session_verified",principal:{...owner,principal_id:"other"}})},broker=new WebJobReadBroker(auth as never,f.jobs);
  assert.deepEqual(broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"}),{status:"denied",reason:"not_found"});
  assert.deepEqual(broker.execute({codec_version:1,operation:"detail",method:"GET",target:"/api/jobs/job_missing",context:"context"}),{status:"denied",reason:"not_found"});
});

test("can_cancelは現行cancel受付状態だけを公開する",t=>{const f=fixture(t);
  const broker=new WebJobReadBroker({verifySessionIngress:()=>({status:"succeeded",kind:"session_verified",principal:{...owner}})} as never,f.jobs);
  for(const [status,expected] of [["queued",true],["preparing",false],["dispatching",false],["retryable_failed",true],["running",true],["blocked",true],["completed",false]] as const){
    const job=f.seed(owner,status);const detail=broker.execute({codec_version:1,operation:"detail",method:"GET",target:`/api/jobs/${job}`,context:"context"});
    assert.equal(detail.status,"succeeded");if(detail.status==="succeeded"&&detail.kind==="detail")assert.equal(detail.job.control.can_cancel,expected,status);
  }
});
