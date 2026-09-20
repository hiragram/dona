import assert from "node:assert/strict";
import { decisionFixture } from "./decision.js";
import { scope, content, wrapping, notification as markerKey } from "./broker.js";
import { ApprovalNotificationBroker } from "../../../src/approval/notification-broker.js";
import { assertCurrentAuditReadState } from "../../../src/audit/repository.js";
import type { NotificationCommand, NotificationClaimAuthority, NotificationRecoveryAuthority, NotificationReceiptAuthority } from "../../../src/approval/notification-authority.js";
export function notificationFixture(t: { after(fn: () => void): void }) {
  const f = decisionFixture(t, false);
  let override: ((grant: ReturnType<NotificationClaimAuthority>) => ReturnType<NotificationClaimAuthority>) | null = null;
  let receipt: Extract<ReturnType<NotificationReceiptAuthority>, {status:"verified"}>["receipt"] = {outcome:"sent",presentation_ref:"message_approval_card"};
  let proof: "callback" | "reconcile" = "callback", revoked=false;
  const claim: NotificationClaimAuthority = (command, request, notification, _mark, state) => {
    assertCurrentAuditReadState(f.db, state); assert.equal(command.authority_ref,"fixture_notification_connection");
    assert.equal(f.records.readInState(state,"request",request.row.request_id)!.row.revision,request.row.revision);
    const snapshot=JSON.parse(request.row.snapshot_json);
    const grant:ReturnType<NotificationClaimAuthority>={status:"verified",scope,notification_id:notification.row.notification_attempt_id,consumer_id:"fixture_notification_worker",
      binding_id:request.row.binding_id,binding_revision:request.row.binding_revision,policy_revision:request.row.policy_revision,semantic_hash:request.row.semantic_hash,
      requester_authorization_revision:snapshot.preconditions.requester_authorization_revision,stale_reason:null};
    return override?override(grant):grant;
  };
  const recovery:NotificationRecoveryAuthority=(command,_request,notification,_mark,state)=>{
    assertCurrentAuditReadState(f.db,state);assert.equal(command.authority_ref,"fixture_notification_connection");
    return {status:"verified",scope,notification_id:notification.row.notification_attempt_id,consumer_id:"fixture_notification_worker"};
  };
  const receipts:NotificationReceiptAuthority=(command,_request,notification,_mark,state)=>{
    assertCurrentAuditReadState(f.db,state);assert.equal(command.authority_ref,"fixture_notification_connection");
    return {status:"verified",scope,notification_id:notification.row.notification_attempt_id,consumer_id:"fixture_notification_worker",delivery_fence:command.expected_fence,proof_kind:proof,receipt};
  };
  const broker=new ApprovalNotificationBroker(f.db,f.providers,scope,claim,recovery,receipts,()=>content,()=>wrapping,()=>({...markerKey,state:revoked?"revoked":"active"}));
  const command=(kind:"approval_card"|"pending_notice"="approval_card"):NotificationCommand=>{
    const row=f.notification(kind);return {notification_handle:row.row.notification_attempt_id,authority_ref:"fixture_notification_connection",expected_fence:row.row.fence};
  };
  return {...f,notifications:broker,notificationCommand:command,setClaim:(fn:typeof override)=>{override=fn;},setReceipt:(value:typeof receipt,kind:typeof proof="callback")=>{receipt=value;proof=kind;},revokeMarker:()=>{revoked=true;}};
}
