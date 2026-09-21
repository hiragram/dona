import type { HumanWaitProjection } from "./human-wait-query.js";
import type { EventRow } from "./types.js";

export class HumanWaitPresentationError extends Error {
  readonly code="human_wait_intent_not_explicit";
  constructor(){super("human_wait_intent_not_explicit");this.name="HumanWaitPresentationError";}
}

function record(value:string):Record<string,unknown>|undefined {
  try {const parsed=JSON.parse(value) as unknown;return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed as Record<string,unknown>:undefined;}
  catch{return undefined;}
}

function unquotedText(value:string):string {
  let fenced=false;
  return value.split(/\r?\n/).filter(line=>{
    if(line.trim().startsWith("```")){fenced=!fenced;return false;}
    return !fenced&&!line.trimStart().startsWith(">");
  }).join("\n")
    .replace(/`[^`\r\n]*`|「[^」\r\n]*」|『[^』\r\n]*』|“[^”\r\n]*”|‘[^’\r\n]*’|"[^"\r\n]*"|'[^'\r\n]*'/g," ")
    .replace(/<@[A-Z0-9]+>/g," ").trim();
}

export function hasExplicitOwnHumanWaitIntent(event:EventRow,input:{continuation?:boolean}={}):boolean {
  if(event.source!=="slack"||!(event.event_type==="app_mention"||event.event_type==="message"))return false;
  const subject=record(event.subject_json),payload=record(event.payload_json);
  if(!subject||!payload||typeof payload.text!=="string")return false;
  const text=unquotedText(payload.text).normalize("NFKC");
  if(!text||text.length>500)return false;
  const continuationRequest=/^(?:(?:次|続き)(?:を)?(?:表示|見せて|みせて|お願い|おねがい)?(?:してください|して|ください)?|(?:next|more)(?:\s+(?:page|please))?)[。.!！?？]*$/iu.test(text);
  if(event.event_type==="message"&&subject.channel_type!=="im")return input.continuation===true&&continuationRequest;
  if(input.continuation&&continuationRequest)return true;
  const self=/(?:今|現在)?\s*(?:自分|僕|ぼく|私|わたし)(?:が)?(?:対応)?待ち|(?:自分|僕|ぼく|私|わたし)の(?:対応)?待ち|waiting\s+on\s+me|my\s+(?:human\s+)?waits?/iu.test(text);
  const request=/(?:一覧|見せ|みせ|教え|おしえ|確認|ある|あります|何|どれ|次|続きを|表示)|(?:list|show|what|any|next|more)/iu.test(text);
  return self&&request;
}

const category:Record<HumanWaitProjection["category"],string>={
  job:"バックグラウンド作業",job_group:"関連作業のまとまり",schedule_run:"予定された作業",
  notification:"通知の確認",agent_session:"会話の確認",
};
const reason:Record<HumanWaitProjection["reason"],string>={
  human_input:"入力待ち",ambiguous_write:"実行結果の確認待ち",invalid_result:"結果の確認待ち",
  notification_reconcile:"通知の確認待ち",operator_review_unknown:"運用確認待ち",
};
const decision:Record<HumanWaitProjection["decision"],string>={
  provide_input:"入力する",reconcile_write:"実行結果を確認する",review_result:"結果を確認する",operator_review:"運用判断する",
};

function elapsed(updatedAt:string,now:Date):string {
  const milliseconds=Math.max(0,now.getTime()-Date.parse(updatedAt));
  if(milliseconds<60*60_000)return "1時間未満";
  if(milliseconds<24*60*60_000)return `${Math.max(1,Math.floor(milliseconds/3_600_000))}時間`;
  if(milliseconds<7*24*60*60_000)return `${Math.floor(milliseconds/86_400_000)}日`;
  return "7日以上";
}

export function renderHumanWaits(input:{items:HumanWaitProjection[];has_more:boolean;next_cursor?:string},now=new Date()):{
  status:"empty"|"ok";text:string;actions:Array<{position:number;origin_ref:string;revision:number}>;has_more:boolean;next_cursor?:string
} {
  const items=input.items.slice(0,10);
  if(items.length===0&&!input.has_more)return {status:"empty",text:"現在確認できる自分待ちはありません。",actions:[],has_more:false};
  const lines=items.map((item,index)=>`${index+1}. ${category[item.category]} — ${reason[item.reason]}（${elapsed(item.updated_at,now)}、次: ${decision[item.decision]}）`);
  const suffix=input.has_more?"\n続きがあります。「次を表示」と明示してください。":"";
  let text=`現在確認できる自分待ちは${items.length}件です。\n${lines.join("\n")}${suffix}`;
  if(text.length>1800)text=`現在確認できる自分待ちは${items.length}件です。\n${lines.slice(0,5).join("\n")}\n表示上限に達しました。`;
  return {status:"ok",text,actions:items.map((item,index)=>({position:index+1,origin_ref:item.origin.origin_ref,revision:item.revision})),
    has_more:input.has_more,...(input.next_cursor?{next_cursor:input.next_cursor}:{})};
}
