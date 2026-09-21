import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const agents=fs.readFileSync(path.join(root,"AGENTS.md"),"utf8");
const config=fs.readFileSync(path.join(root,".codex/config.toml"),"utf8");

test("自分待ち表示は明示問い合わせ、bounded continuation、session終端、非再送を固定する",()=>{
  for(const phrase of ["明示的に「自分待ち」","`present_human_waits`","`processing`","`post_message_once`",
    "acceptance unknown","同じwriteを再試行せず","`suspended`","`active`","自動取得せず",
    "`resolve_human_wait_origin`","current access","直接行わず"])assert.match(agents,new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  const slack=config.split("[mcp_servers.dona_slack]")[1].split("[mcp_servers.dona_dispatcher]")[0];
  assert.match(slack,/enabled_tools = \[[^\n]*"post_message_once"/);
  const dispatcher=config.split("[mcp_servers.dona_dispatcher]")[1];
  assert.match(dispatcher,/enabled_tools = \[[^\n]*"present_human_waits"/);
});
