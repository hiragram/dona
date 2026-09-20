import assert from "node:assert/strict";
import { test } from "node:test";
import { notificationFixture } from "./fixtures/notification.js";
import { ApprovalNotificationError } from "../../src/approval/notification-broker.js";
import { scope } from "./fixtures/broker.js";
const claim=(f:ReturnType<typeof notificationFixture>,kind:"approval_card"|"pending_notice"="approval_card")=>f.notifications.claim("claim_"+kind,f.notificationCommand(kind));
test("card dispatchとsentを保存して作成時revisionの決定proofへ接続する",t=>{
 const f=notificationFixture(t);assert.equal(claim(f).status,"dispatching");assert.equal(f.read().row.state,"delivery_pending");
 assert.equal(f.notifications.claim("duplicate",f.notificationCommand()).status,"denied");
 f.notifications.resolve("sent",f.notificationCommand());assert.equal(f.read().row.state,"sent");assert.equal(f.read().row.revision,2);
 assert.equal(f.notification("approval_card").row.request_revision,1);assert.equal(f.notification("approval_card").row.fence,2);
 assert.equal(f.decision.decide("approve",f.command("approve",1)).status,"decided");assert.equal(f.read().row.state,"approved");
});
test("dispatching復旧はrequestとattemptをunknownへ同時保存し旧callbackと再claimを拒否する",t=>{
 const f=notificationFixture(t);claim(f);const old=f.notificationCommand();f.notifications.recover("recover",old);
 assert.equal(f.read().row.state,"delivery_unknown");assert.equal(f.notification("approval_card").row.state,"acceptance_unknown");
 assert.equal(f.notifications.resolve("late",old).status,"denied");assert.equal(f.notifications.claim("resend",f.notificationCommand()).status,"denied");
 f.setReceipt({outcome:"unknown"},"reconcile");assert.equal(f.notifications.resolve("zero",f.notificationCommand()).status,"unchanged");
 f.setReceipt({outcome:"sent",presentation_ref:"message_approval_card"},"reconcile");f.notifications.resolve("one",f.notificationCommand());
 assert.equal(f.read().row.state,"sent");assert.equal(f.read().row.revision,3);assert.equal(f.decision.decide("approve",f.command("approve",1)).status,"decided");
});
test("card cancel先着後の遅着sentはcancelledのまま無効表示updateを一度生成する",t=>{
 const f=notificationFixture(t);claim(f);f.decision.decide("cancel",f.command("cancel",1));
 assert.equal(f.rows("approval_payload_secrets"),0);f.notifications.resolve("late_sent",f.notificationCommand());
 assert.equal(f.read().row.state,"cancelled");assert.equal(f.notification("approval_card").row.state,"sent");assert.equal(f.rows("approval_presentation_updates"),1);
 assert.equal(f.notifications.resolve("duplicate_sent",f.notificationCommand()).status,"unchanged");assert.equal(f.rows("approval_presentation_updates"),1);
 assert.equal(f.decision.decide("no_approval",f.command("approve",1)).status,"denied");
});
test("pending noticeはcardと独立しterminal後の遅着でもrequestを戻さず表示更新する",t=>{
 const f=notificationFixture(t);claim(f,"pending_notice");f.decision.decide("cancel",f.command("cancel",1));
 f.setReceipt({outcome:"sent",presentation_ref:"message_pending_notice"});f.notifications.resolve("late_notice",f.notificationCommand("pending_notice"));
 assert.equal(f.read().row.state,"cancelled");assert.equal(f.notification("approval_card").row.state,"aborted");assert.equal(f.rows("approval_presentation_updates"),1);
});
test("known card rejectionはpayload削除とnotice abort、notice単独拒否はcardを維持する",t=>{
 for(const kind of ["approval_card","pending_notice"] as const){const f=notificationFixture(t);claim(f,kind);f.setReceipt({outcome:"rejected",reason:"scope_denied"});
  f.notifications.resolve("rejected",f.notificationCommand(kind));assert.equal(f.notification(kind).row.state,"failed");
  assert.equal(f.read().row.state,kind==="approval_card"?"delivery_failed":"delivery_pending");assert.equal(f.rows("approval_payload_secrets"),kind==="approval_card"?0:1);
 }
});
test("不明cardの複数proofはneeds_reviewと本文削除へ収束する",t=>{
 const f=notificationFixture(t);claim(f);f.setReceipt({outcome:"unknown"});f.notifications.resolve("unknown",f.notificationCommand());
 f.setReceipt({outcome:"ambiguous"},"reconcile");f.notifications.resolve("multiple",f.notificationCommand());
 assert.equal(f.read().row.state,"needs_review");assert.equal(f.notification("approval_card").row.state,"needs_review");assert.equal(f.rows("approval_payload_secrets"),0);
});
test("claim期限境界はexpire decisionと全pending abortを同時保存する",t=>{
 const f=notificationFixture(t);f.setNow("2026-09-19T00:15:00.000Z");claim(f);
 assert.equal(f.read().row.state,"expired");assert.equal(f.rows("approval_decisions"),1);assert.equal(f.rows("approval_event_outbox"),1);
 assert.equal(f.notification("approval_card").row.state,"aborted");assert.equal(f.notification("pending_notice").row.state,"aborted");assert.equal(f.rows("approval_payload_secrets"),0);
});
test("current driftでは本文を削除して全pendingをabortし認証やscope拒否では状態を変えない",t=>{
 const drift=notificationFixture(t);drift.setClaim(g=>g.status==="verified"?{...g,binding_revision:g.binding_revision+1}:g);claim(drift);
 assert.equal(drift.read().row.state,"needs_review");assert.equal(drift.rows("approval_payload_secrets"),0);
 for(const fault of ["denied","scope"]){const f=notificationFixture(t);f.setClaim(g=>fault==="denied"?{status:"denied",reason:"unauthorized"}:g.status==="verified"?{...g,scope:{...scope,workspace_id:"other"}}:g);
  assert.equal(claim(f).status,"denied");assert.equal(f.read().row.state,"delivery_pending");assert.equal(f.notification("approval_card").row.fence,0);
 }
});
test("失効markerはclaimを拒否し復旧時のunknown記録は妨げない",t=>{
 const f=notificationFixture(t);f.revokeMarker();assert.throws(()=>claim(f),ApprovalNotificationError);assert.equal(f.notification("approval_card").row.state,"pending");
 const g=notificationFixture(t);claim(g);g.revokeMarker();g.notifications.recover("revoked_recovery",g.notificationCommand());assert.equal(g.read().row.state,"delivery_unknown");
});
test("SQLとaudit障害でdispatch成功を返さず保存前後を区別する",t=>{
 for(const fault of ["sql","reserve_after","finalize_after"] as const){const f=notificationFixture(t);
  if(fault==="sql"){const prepare=f.db.prepare.bind(f.db);f.db.prepare=((...args:Parameters<typeof f.db.prepare>)=>{if(args[0].startsWith("UPDATE main.approval_notifications SET"))throw Error("fixture fault");return prepare(...args);}) as typeof f.db.prepare;t.after(()=>{f.db.prepare=prepare;});}else f.anchors.fault=fault;
  assert.throws(()=>claim(f),ApprovalNotificationError);assert.equal(f.db.prepare("SELECT state FROM approval_notifications WHERE kind='approval_card'").pluck().get(),fault==="finalize_after"?"dispatching":"pending");
 }
});

test("dispatch後の期限切れ復旧はunknownとexpire decisionと本文削除を同時保存する",t=>{
 const f=notificationFixture(t);claim(f);f.setNow("2026-09-19T00:15:00.000Z");f.notifications.recover("expired_recovery",f.notificationCommand());
 assert.equal(f.read().row.state,"expired");assert.equal(f.notification("approval_card").row.state,"acceptance_unknown");
 assert.equal(f.rows("approval_decisions"),1);assert.equal(f.rows("approval_event_outbox"),1);assert.equal(f.rows("approval_payload_secrets"),0);
 f.setReceipt({outcome:"sent",presentation_ref:"message_approval_card"},"reconcile");f.notifications.resolve("expired_sent",f.notificationCommand());
 assert.equal(f.read().row.state,"expired");assert.equal(f.rows("approval_presentation_updates"),1);
});
test("期限後のsent callbackも承認可能なsentへ戻さずexpireと無効表示を保存する",t=>{
 const f=notificationFixture(t);claim(f);f.setNow("2026-09-19T00:15:00.000Z");f.notifications.resolve("late_expired_callback",f.notificationCommand());
 assert.equal(f.read().row.state,"expired");assert.equal(f.notification("approval_card").row.state,"sent");assert.equal(f.rows("approval_payload_secrets"),0);
 assert.equal(f.rows("approval_decisions"),1);assert.equal(f.rows("approval_presentation_updates"),1);
});
test("再openしたdispatchingを再送せずunknownへ進めexact receiptだけでsentへ収束する",async t=>{
 const {openSecurityDatabase}=await import("../../src/audit/coordination.js");
 const {installApprovalSchema}=await import("../../src/approval/schema.js");
 const {ApprovalRecordRepository}=await import("../../src/approval/record-repository.js");
 const {ApprovalNotificationBroker}=await import("../../src/approval/notification-broker.js");
 const {content,wrapping,notification:markerKey}=await import("./fixtures/broker.js");
 const f=notificationFixture(t);claim(f);const command=f.notificationCommand();f.db.close();const db=openSecurityDatabase(f.filename);
 try{db.pragma("journal_mode=WAL");db.pragma("synchronous=FULL");db.pragma("foreign_keys=ON");installApprovalSchema(db);
  const broker=new ApprovalNotificationBroker(db,f.providers,scope,()=>({status:"denied",reason:"unauthorized"}),
    (_command,_request,notification)=>({status:"verified",scope,notification_id:notification.row.notification_attempt_id,consumer_id:"fixture_reopened"}),
    (command,_request,notification)=>({status:"verified",scope,notification_id:notification.row.notification_attempt_id,consumer_id:"fixture_reopened",delivery_fence:command.expected_fence,proof_kind:"reconcile",receipt:{outcome:"sent",presentation_ref:"message_approval_card"}}),
    ()=>content,()=>wrapping,()=>markerKey);
  broker.recover("reopen_recover",command);const records=new ApprovalRecordRepository(db,f.providers.auditAnchors,f.providers.auditKeys,scope);
  assert.equal(records.read("request",f.requestId)!.row.state,"delivery_unknown");
  broker.resolve("reopen_receipt",{...command,expected_fence:2});assert.equal(records.read("request",f.requestId)!.row.state,"sent");
  assert.equal(db.prepare("SELECT count(*) FROM approval_notifications").pluck().get(),2);
 }finally{db.close();}
});
test("failed結果のSQL障害はrequestとnotificationと本文削除を全てrollbackする",t=>{
 const f=notificationFixture(t);claim(f);f.setReceipt({outcome:"rejected",reason:"scope_denied"});
 const prepare=f.db.prepare.bind(f.db);f.db.prepare=((...args:Parameters<typeof f.db.prepare>)=>{if(args[0].startsWith("UPDATE main.approval_payload_metadata SET state='deleted'"))throw Error("fixture payload fault");return prepare(...args);}) as typeof f.db.prepare;t.after(()=>{f.db.prepare=prepare;});
 assert.throws(()=>f.notifications.resolve("failed_commit",f.notificationCommand()),ApprovalNotificationError);
 assert.equal(f.db.prepare("SELECT state FROM approval_requests").pluck().get(),"delivery_pending");
 assert.equal(f.db.prepare("SELECT state FROM approval_notifications WHERE kind='approval_card'").pluck().get(),"dispatching");
 assert.equal(f.rows("approval_payload_secrets"),1);
});
