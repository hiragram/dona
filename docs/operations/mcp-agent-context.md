# MCP agent実行contextと管理境界

## 境界

`dona-main`が使うDispatcher MCPは、管理用`dispatcher.sock`ではなくagent専用`dispatcher-agent.sock`へ接続する。Dispatcher workerはprompt直前に、現在のevent ID、dispatch attempt、verified human principal、tenant/workspace、purpose、失効時刻、policy revisionへ束縛した短命credentialを発行する。MCP clientは各requestでcredentialとcaller指定の`source_event_id`を送り、Dispatcherはserver-side sessionと完全一致した場合だけ処理する。

credentialはowner-only fileへ置き、値をprompt、model output、通常log、auditへ記録しない。新しいattemptの発行で旧credentialを置換し、terminal result、停止、再起動で削除する。Dispatcher再起動後はprocess memoryのsessionが空になるため、残存credentialだけでは認可されない。

管理・health・internal ingressは管理用socketだけに残す。agent socketは下表のoperation以外をroute前に拒否する。OS管理者がsocketやcredential fileを直接読める侵害はこの境界の防御範囲外である。

## purpose別tool inventory

| purpose | event source | 許可tool |
| --- | --- | --- |
| `human_command` | verified Slack ingress | `delegate_job`、`list_event_jobs`、`list_thread_jobs`、`list_owner_jobs`、`get_job_status`、`steer_job`、`cancel_job`、self-update 4 tool、schedule 9 tool |
| `job_completion` | durable `dona_job` notification | `list_event_jobs`、`get_job_status`、`authorize_job_notification` |
| `schedule_work` | durable `dona_schedule` run | `record_schedule_job_access`、`delegate_scheduled_work` |
| `update_completion` | stable updater notification | `get_self_update_status` |

正本は`dispatcher/src/agent-context.ts`の`agentPurposeOperations`である。`.codex/config.toml`のtool allowlistはこの集合の和と一致させる。background job workerは親agentのcapabilityを継承せず、`dona_dispatcher` MCPを常に無効化する。

`list_thread_jobs`と`get_self_update_status`を含む全toolは現在の`source_event_id`を明示する。tool説明やmodelの遵守は認可根拠にせず、source-event swap、別attempt、期限切れ、purpose違反、context欠落、agent socketからの管理routeを一律denyする。
