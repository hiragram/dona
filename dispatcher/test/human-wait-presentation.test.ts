import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { hasExplicitOwnHumanWaitIntent, renderHumanWaits } from "../src/human-wait-presentation.js";
import type { HumanWaitProjection } from "../src/human-wait-query.js";
import type { EventRow } from "../src/types.js";

function event(text:string, eventType="app_mention", channelType="channel"):EventRow {
  return {
    event_id:"evt_01m1zfewbjx8v0844yrrkqwzc7", sequence:1, schema_version:1,
    source:"slack", external_event_id:"Ev1", event_type:eventType,
    occurred_at:"2026-09-21T00:00:00Z", subject_json:JSON.stringify({channel_type:channelType}),
    payload_json:JSON.stringify({text}), reply_target_json:null, trace_json:null, status:"waiting_agent", attempt_count:1,
    available_at:"2026-09-21T00:00:00Z", dispatch_started_at:null, prompt_accepted_at:null, completed_at:null,
    result_json:null, result_path:null, last_error_code:null, last_error_message:null,
    created_at:"2026-09-21T00:00:00Z", updated_at:"2026-09-21T00:00:00Z",
    schedule_access_checked_at:null, schedule_access_consumed_at:null,
  };
}

function item(overrides:Partial<HumanWaitProjection>={}):HumanWaitProjection {
  return {item_id:"wait_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",category:"job",reason:"human_input",decision:"provide_input",
    state:"open",opened_at:"2026-09-20T11:00:00Z",updated_at:"2026-09-21T11:00:00Z",
    origin:{available:true,origin_ref:"origin_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},revision:3,...overrides};
}

describe("自分待ちSlack表示",()=>{
  test("本人のtop-level明示問い合わせだけを受理する",()=>{
    assert.equal(hasExplicitOwnHumanWaitIntent(event("<@U_BOT> 私の待ちを一覧で見せて")),true);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("<@U_BOT> 今、僕待ちになっているもの")),true);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("自分待ちの次を表示して","message","im")),true);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("次を表示","message","im")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("次を表示","message","im"),{continuation:true}),true);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("次を表示","message","channel"),{continuation:true}),true);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("次を表示","message","group"),{continuation:true}),true);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("次を表示して田中さんへ送って","message","im"),{continuation:true}),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("私の待ちを一覧で見せて","message","im"),{continuation:true}),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("自分待ちを一覧で見せて","message","channel"),{continuation:true}),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("自分待ちを一覧で見せて","message","channel")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("> 私の待ちを一覧で見せて\n了解です")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("```\n自分待ちを一覧で見せて\n```\n確認します")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("<@U_BOT> `私の待ちを一覧で見せて`って入力すればいいですか？")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("<@U_BOT> 「私の待ちを一覧で見せて」と言えばいいですか？")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("<@U_BOT> ＂私の待ちを一覧で見せて＂と入力すればいいですか？")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event('<@U_BOT> "my waits list" と入力しますか？')),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("私の待ち受け画面を見せて")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("私の待ち時間を教えて")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("私の待ちにはバグがあります。直してください")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("私の待ちに関連する仕様を確認したい","message","im")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("私の待ちはありますか","message","im")),true);
    assert.equal(hasExplicitOwnHumanWaitIntent(event("田中さんの待ちを一覧で見せて")),false);
    assert.equal(hasExplicitOwnHumanWaitIntent({...event("私の待ちを一覧で見せて"),source:"dona_job"}),false);
  });

  test("safe fieldだけからbounded日本語表示とopaque actionを作る",()=>{
    const rendered=renderHumanWaits({items:[item()],has_more:true,next_cursor:"opaque.cursor"},new Date("2026-09-21T12:00:00Z"));
    assert.equal(rendered.status,"ok");
    assert.match(rendered.text,/自分待ちは1件/);
    assert.match(rendered.text,/バックグラウンド作業 — 入力待ち（1時間、次: 入力する）/);
    assert.match(rendered.text,/「次を表示」/);
    assert.doesNotMatch(rendered.text,/wait_|origin_|PRIVATE|objective|error/);
    assert.deepEqual(rendered.actions,[{position:1,origin_ref:"origin_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",revision:3}]);
    assert.equal(rendered.next_cursor,"opaque.cursor");
  });

  test("0件と表示上限を区別する",()=>{
    assert.deepEqual(renderHumanWaits({items:[],has_more:false}),{
      status:"empty",text:"現在確認できる自分待ちはありません。",actions:[],has_more:false,
    });
    const many=Array.from({length:20},(_,index)=>item({
      item_id:`wait_${index.toString(16).padStart(32,"0")}`,
      origin:{available:true,origin_ref:`origin_${index.toString(16).padStart(32,"0")}`},
    }));
    const rendered=renderHumanWaits({items:many,has_more:true});
    assert.ok(rendered.actions.length<=10);
    assert.ok(rendered.text.length<=1800);
  });
});
