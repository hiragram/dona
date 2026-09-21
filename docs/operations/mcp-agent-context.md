# MCP agent実行contextと管理境界

## 境界

`dona-main`が使うDispatcher MCPは、管理用`dispatcher.sock`ではなくagent専用`dispatcher-agent.sock`へ接続する。Dispatcher workerはprompt直前に、現在のevent ID、dispatch attempt、verified human principal、tenant/workspace、purpose、失効時刻、policy revisionへ束縛した短命credentialを発行する。MCP clientは各requestでcredentialとcredentialから読んだ認証用event IDを送り、Dispatcherはserver-side sessionと完全一致した場合だけ処理する。toolの対象event IDはこれと別に検証し、通常は現在eventとの一致を要求する。

credentialはowner-only fileへ置き、値をprompt、model output、通常log、auditへ記録しない。新しいattemptの発行で旧credentialを置換し、terminal result、停止、再起動で削除する。Dispatcher再起動後はprocess memoryのsessionが空になるため、残存credentialだけでは認可されない。`waiting_agent`を再開するときは、永続化済みverified principal bindingから同じevent/attempt用の新しいcredentialを発行してからagentを待つ。

管理・health・internal ingressは管理用socketだけに残す。agent socketは下表のoperation以外をroute前に拒否する。OS管理者がsocketやcredential fileを直接読める侵害はこの境界の防御範囲外である。

## purpose別tool inventory

| purpose | event source | 許可tool |
| --- | --- | --- |
| `human_command` | verified Slack ingress | `delegate_job`、`list_event_jobs`、`list_thread_jobs`、`list_owner_jobs`、`get_job_status`、`steer_job`、`cancel_job`、self-update 4 tool、schedule 9 tool |
| `job_completion` | durable `dona_job` notification | `list_event_jobs`、`get_job_status`、`authorize_job_notification` |
| `schedule_work` | durable `dona_schedule` run | `record_schedule_job_access`、`delegate_scheduled_work` |
| `update_completion` | stable updater notification | `get_self_update_status` |

正本は`dispatcher/src/agent-context.ts`の`agentPurposeOperations`である。`.codex/config.toml`のtool allowlistはこの集合の和と一致させる。background job workerは親agentのcapabilityを継承せず、`dona_dispatcher` MCPを常に無効化する。

`list_thread_jobs`と`get_self_update_status`を含む全toolは現在の`source_event_id`を明示する。write routeのJSON bodyにある`source_event_id`は、schema validationや業務処理より前にserver-side contextのevent IDと完全一致させる。唯一、`job_completion`の`list_event_jobs`はgroup完了集約のため、durableな完了通知の`subject.source_event_id`または`trace.source_event_id`と一致する元eventを一覧対象にできる。queryでpath上の対象eventを上書きできず、他purposeや無関係なeventへの横断はdenyする。tool説明やmodelの遵守は認可根拠にせず、source-event swap、別attempt、期限切れ、purpose違反、context欠落、agent socketからの管理routeを一律denyする。

## legacy eventの明示的な再認可

verified principal bindingが存在しない旧eventからprincipalを推測してbackfillしない。`waiting_agent`の旧eventは`agent_context_reauthorization_required`を記録して保持し、promptを再送しない。

再開するには、元のSlack Event Envelopeと同じsecurity-relevant contentを、freshな署名済みprincipal proof付きで認証済みingressへ再配送する。Dispatcherは既存eventのschema、type、発生時刻、subject、payload、reply targetとの一致を確認し、proofのevent、attempt、tenant、workspace、principal、nonce、期限を検証したうえでbindingを同一transactionに保存する。ingress attempt等のtrace metadataは再配送で更新できるが、payload等が変わった再配送、異なるprincipal、消費済みproofはconflictとして拒否する。actor文字列やjob IDだけを根拠に修復してはならない。

再配送後はbindingをread-backする。queuedのまま再試行が必要なeventは通常のevent retry手順を使い、`waiting_agent`は次のworker loopで新しいcredentialを発行して既存agentの待機を再開する。scheduleやjob completionの派生eventは、認可元になった元Slack eventを再認可する。
