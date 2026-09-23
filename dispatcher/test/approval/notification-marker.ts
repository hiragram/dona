import assert from "node:assert/strict";
import { test } from "node:test";
import { signApprovalNotificationMarker, verifyApprovalNotificationMarker, ApprovalNotificationMarkerError, type ApprovalNotificationMarker, type ApprovalNotificationKey } from "../../src/approval/notification-marker.js";
import type { ClockMark } from "../../src/approval/clock.js";
const marker:ApprovalNotificationMarker={codec_version:1,instance_id:"instance",workspace_id:"tenant",request_id:"request",notification_attempt_id:"attempt",kind:"approval_card",semantic_hash:"a".repeat(64),created_at:"2026-09-19T00:00:00.000Z",key_version:1};
const key:ApprovalNotificationKey={purpose:"approval_notification_marker",version:1,state:"active",activated_at:"2026-09-01T00:00:00.000Z",signing_expires_at:"2026-11-01T00:00:00.000Z",secret:Buffer.alloc(32,73)};
const mark:ClockMark={codec_version:1,transaction_id:"transaction",previous_transaction_id:null,boot_id:"boot",continuous_ms:1,effective_utc:marker.created_at};
test("notification markerは独立HMAC値に一致し全binding fieldへ結合する",()=>{
 const mac=signApprovalNotificationMarker(marker,key,mark);
 // Python hmac/hashlib、固定positional JSONとdomainから独立算出。
 assert.equal(mac,"9dce7a2303ac5f66d567e775a984b27cd0c3a1630713e5cfdc4aa8acb56cdc7a");verifyApprovalNotificationMarker(marker,mac,key);
 for(const change of [{instance_id:"other"},{workspace_id:"other"},{request_id:"other"},{notification_attempt_id:"other"},{kind:"pending_notice" as const},{semantic_hash:"b".repeat(64)},{created_at:"2026-09-19T00:01:00.000Z"},{key_version:2}])
  assert.throws(()=>verifyApprovalNotificationMarker({...marker,...change},mac,key),ApprovalNotificationMarkerError);
});
test("notification key rotationは旧検証のみ許可し失効・用途違い・sign期間外を拒否",()=>{
 const mac=signApprovalNotificationMarker(marker,key,mark),old={...key,state:"verification_only" as const};verifyApprovalNotificationMarker(marker,mac,old);
 assert.throws(()=>signApprovalNotificationMarker(marker,old,mark),ApprovalNotificationMarkerError);
 for(const invalid of [{...key,state:"revoked" as const},{...key,purpose:"approval_content" as ApprovalNotificationKey["purpose"]},{...key,version:2},{...key,secret:Buffer.alloc(31)},{...key,activated_at:marker.created_at,signing_expires_at:marker.created_at},{...key,signing_expires_at:"2027-01-01T00:00:00.000Z"}])
  assert.throws(()=>verifyApprovalNotificationMarker(marker,mac,invalid),ApprovalNotificationMarkerError);
 assert.throws(()=>signApprovalNotificationMarker(marker,key,{...mark,effective_utc:"2026-09-19T00:01:00.000Z"}),ApprovalNotificationMarkerError);
});
test("notification markerは未知field・Proxy・getter・非canonical MACを受け付けない",()=>{
 const mac=signApprovalNotificationMarker(marker,key,mark);let calls=0;
 for(const input of [{...marker,unknown:true},new Proxy(marker,{get(){calls++;throw Error();}}),{...marker,get request_id(){calls++;return "request";}}])
  assert.throws(()=>verifyApprovalNotificationMarker(input,mac,key),ApprovalNotificationMarkerError);
 assert.equal(calls,0);assert.throws(()=>verifyApprovalNotificationMarker(marker,mac.toUpperCase(),key),ApprovalNotificationMarkerError);
});
