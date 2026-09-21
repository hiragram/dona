import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { signSlackAccessReceipt } from "../src/access-receipt.js";
import { verifyCurrentSlackAccess } from "../src/current-access.js";
import { SlackApiError, type SlackApiClient, type SlackChannel, type SlackUser } from "../src/slack-api.js";

const user: SlackUser = { id:"U_OWNER", teamId:"T_HOME", updatedAt:7, isBot:false, isAppUser:false, isDeleted:false };
const channel: SlackChannel = { id:"C_PRIVATE", isPrivate:false, isArchived:false, isMember:true, isShared:false };

function provider(overrides: { user?:Partial<SlackUser>; channel?:Partial<SlackChannel>; member?:boolean; error?:boolean } = {}): SlackApiClient {
  return {
    async authenticate(){ return {teamId:"T_HOME"}; }, async listChannels(){ return {channels:[]}; },
    async getChannel(){ if(overrides.error) throw new Error("provider secret"); return {...channel,...overrides.channel}; },
    async hasChannelMember(){ if(overrides.error) throw new Error("provider secret"); return overrides.member ?? true; },
    async listUsers(){ return {users:[]}; }, async getUser(){ if(overrides.error) throw new Error("provider secret"); return {...user,...overrides.user}; },
    async getThread(){ return {messages:[],hasMore:false}; }, async getReactions(){ throw new Error("unused"); },
    async getFile(){ throw new Error("unused"); }, async postMessage(){ throw new Error("unused"); },
    async setAgentSessionStatus(){ throw new Error("unused"); }, async addReaction(){ throw new Error("unused"); },
  };
}

async function denied(client: SlackApiClient, channelId = "C_PRIVATE") {
  await assert.rejects(() => verifyCurrentSlackAccess(client,"T_HOME",{eventId:"evt_1",channelId,userId:"U_OWNER"}),
    (error:unknown) => error instanceof SlackApiError && error.errorCode === "access_unavailable" && !error.message.includes("secret"));
}

describe("Slack current access verifier", () => {
  test("current human membershipをworkspace、destination、visibility revisionへ束縛する", async () => {
    const value=await verifyCurrentSlackAccess(provider(),"T_HOME",{eventId:"evt_1",channelId:"C_PRIVATE",userId:"U_OWNER"});
    assert.deepEqual({status:value.status,event_id:value.event_id,workspace_id:value.workspace_id,principal_id:value.principal_id,
      destination_id:value.destination_id,destination_kind:value.destination_kind,revision:value.visibility_revision.length},
    {status:"current",event_id:"evt_1",workspace_id:"T_HOME",principal_id:"U_OWNER",destination_id:"C_PRIVATE",destination_kind:"public_channel",revision:64});
  });

  test("退会、disabled、bot/app、別workspace、archived、Slack Connect、unknown分類を同じdenyへ縮退する", async () => {
    await denied(provider({member:false}));
    await denied(provider({user:{isDeleted:true}}));
    await denied(provider({user:{isBot:true}}));
    await denied(provider({user:{isAppUser:true}}));
    await denied(provider({user:{teamId:"T_OTHER"}}));
    await denied(provider({channel:{isArchived:true}}));
    await denied(provider({channel:{isShared:true}}));
    await denied(provider({channel:{id:"X_UNKNOWN"}}),"X_UNKNOWN");
    await denied(provider({error:true}));
  });

  test("DMはcounterpart本人、mpim/privateは明示membershipを要求し、bot membershipを代用しない", async () => {
    const dm=await verifyCurrentSlackAccess(provider({channel:{id:"D_OWNER",isIm:true,userId:"U_OWNER"}}),"T_HOME",
      {eventId:"evt_dm",channelId:"D_OWNER",userId:"U_OWNER"});
    assert.equal(dm.destination_kind,"im");
    await denied(provider({channel:{id:"D_OTHER",isIm:true,userId:"U_OTHER"}}),"D_OTHER");
    const mpim=await verifyCurrentSlackAccess(provider({channel:{id:"G_MPIM",isPrivate:true,isMpim:true}}),"T_HOME",
      {eventId:"evt_mpim",channelId:"G_MPIM",userId:"U_OWNER"});
    assert.equal(mpim.destination_kind,"mpim");
    await denied(provider({channel:{isMember:true},member:false}));
  });

  test("positive cacheを持たず、revoke・provider障害・restart相当を次の照会へ即時反映する", async () => {
    let member=true,calls=0;
    const client=provider(); client.hasChannelMember=async()=>{calls++;return member;};
    await verifyCurrentSlackAccess(client,"T_HOME",{eventId:"evt_1",channelId:"C_PRIVATE",userId:"U_OWNER"});
    member=false; await denied(client); assert.equal(calls,2);
    const restarted=provider({error:true}); await denied(restarted);
  });
});

test("access receiptは観測時刻からexclusive 120秒、opaque nonce、safe evidenceだけを署名する", async () => {
  const evidence=await verifyCurrentSlackAccess(provider(),"T_HOME",{eventId:"evt_1",channelId:"C_PRIVATE",userId:"U_OWNER"});
  const receipt=signSlackAccessReceipt(evidence,"k".repeat(32),new Date("2026-09-21T00:00:00.999Z"),"nonce-test");
  const [payload,signature,...extra]=receipt.split("."), decoded=JSON.parse(Buffer.from(payload!,"base64url").toString("utf8"));
  assert.equal(extra.length,0); assert.equal(typeof signature,"string");
  assert.deepEqual({issued_at:decoded.issued_at,expires_at:decoded.expires_at,nonce:decoded.nonce,consumed:decoded.consumed},
    {issued_at:"2026-09-21T00:00:00Z",expires_at:"2026-09-21T00:02:00Z",nonce:"nonce-test",consumed:false});
  assert.equal(JSON.stringify(decoded).includes("provider secret"),false);
});
