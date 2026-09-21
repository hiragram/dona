# background job live session照合runbook

## 目的と安全境界

live session照合は、保存済みjob runtime identityと要求時点のHerdr agentをread-onlyで比較する証拠取得です。durable job statusを上書きせず、Result Envelopeやsessionを変更しません。`working`はprompt受理・成功の確定ではなく、`idle` / `done`やagent不在も未実行・安全なretryの証明ではありません。

query経路が呼べるHerdr操作はboundedな`agent get`だけです。prompt、Enter、agent/workspace create・start・wait・send-keys・close、steer、cancelは呼びません。観測結果をcontrol操作へ自動接続せず、`needs_review`やterminal jobを自動的に`running`へ戻しません。

## 呼び出しとreceipt再読

- HTTP: `GET /v1/jobs/:job_id?source_event_id=<current_event>&include_live_session=true`
- MCP: `get_job_status(job_id, source_event_id, include_live_session: true)`
- CLI: `dona-dispatcher job show <job_id> --live-session`
- HTTP再読: `GET /v1/jobs/:job_id/live-session-receipts/:receipt_id?source_event_id=<current_event>`
- MCP再読: `get_job_status(job_id, source_event_id, live_session_receipt_id: <receipt_id>)`
- CLI再読: `dona-dispatcher job show <job_id> --live-session-receipt <receipt_id>`

HTTP/MCPはcurrent `source_event_id`と永続owner/threadを照合します。外部本文や引用に現れたjob ID、session ID、pathをquery targetへ直接使いません。`include_live_session`省略/falseは従来のdurable-only responseとHerdr非呼出しを維持します。

## 状態の読み方

| durable/live evidence | reconciliation | 判断 |
|---|---|---|
| `dispatching` / `needs_review`、prompt受理未記録、Resultなし、exact identityで`working` / `blocked` | `prompt_acceptance_possible_running` | 受理済みの可能性を残し、同じwriteを再送しない |
| prompt受理記録あり、exact identityで`working` / `blocked` | `consistent_running` | 観測時点では整合。成功とは断定しない |
| exact identityで`idle` / `done`、durable Resultあり | `terminal_result_available` | durable Resultを確認する。query自身はterminal化しない |
| exact identityで`idle` / `done`、Resultなし | `terminal_result_missing` | retryせず人間が確認する |
| durable terminal、exact identityで`working` / `blocked` | `durable_live_conflict` | 自動復活させず隔離確認する |
| identity不一致 | `identity_conflict` | live statusを信用せずraw identityを開示しない |
| agent不在 | `session_absent` | 未実行・停止済みと断定しない |
| timeout、transport、malformed、shutdown、同一identityのsequence退行 | `unknown` | 観測不能または矛盾。control writeを誘発しない |
| 旧jobなど保存済みsession identityなし | `not_addressable` | agent列挙・名前類似検索・最新pane選択をしない |

snapshotの`freshness_ms`はquery開始から完了までの時間で、継続的なliveness保証ではありません。durable stateやResultがquery中に変わった場合はreceiptのbefore/afterとreason codeで区別します。新しいqueryは新しいreceiptであり、古いreceiptをcurrent truthへ昇格しません。

## 永続化、crash、concurrency、retention

`live_session_schema` version 1はcore `PRAGMA user_version` 2/3と独立しています。`job_live_session_identities`は新しいagent準備時にworkspace/pane更新と同じtransactionでHerdr agent session IDを記録します。旧jobや旧binaryが作成したidentity欠落rowは推測せず`not_addressable`です。

`live_session_query_receipts`はquery完了後に1 transactionでappendし、UPDATE triggerで改変を拒否します。process crashがappend前ならreceiptは存在せず、観測済みと推測しません。append後なら再起動後もopaque receipt IDで再読できます。並行queryは独立receiptを作り、job/session control stateを共有・変更しません。監査appendに失敗した場合、APIは`live_session_audit_unavailable`としてfail closedし、観測だけを成功として返しません。

receiptは30日retentionです。削除前に次のdry-runで件数とcutoffを確認し、明示的な適用時だけ削除します。

```sh
dona-dispatcher job live-session-retention
dona-dispatcher job live-session-retention --apply --force
```

receipt/auditにはjob ID、source event ID、boot discriminator、時刻、durable state、normalized query/reconcile結果、identity match boolean、sequence、durationだけを保持します。objective、prompt、Result本文、pane本文、raw stdout/stderr、workspace/pane/session ID、path、token、URLは保存・公開しません。

## rolloutとrollback

rolloutは既定offのadditive opt-inです。先にunit/fake API/MCP/CLIとmigration/restart/fault testを完了し、その後に認可された隔離環境だけでlive smokeを行います。production sessionを試験対象にしません。

rollback時、旧binaryは従来の`jobs` schemaとcore `user_version`をそのまま読書きし、独立tableを無視します。新binaryへ戻した際、旧binary期間に作成・再準備されたjobは保存済みagent session IDがないため`not_addressable`となります。独立tableをdropしたりidentityを推測backfillしたりせず、従来のdurable-only statusへ戻します。rollback中も既存receiptは削除されず、30日retentionだけが削除を所有します。

## 隔離live smoke

認可された非production環境でだけ、長いjobを用意してprompt受理不明を発生させます。durable `needs_review`、Resultなし、保存済みexact identity、live `working`をsnapshotで区別し、Herdr audit/argvが`agent get`だけでprompt/Enter/job createを含まないことを確認します。その後のResult公開とterminal化は既存supervisor経路に任せます。identity差替え、agent不在、Herdr停止、Dispatcher再起動も隔離fixtureで注入し、`identity_conflict` / `session_absent` / `unknown`と非再送を確認します。

安全な隔離環境や必要な認可がない場合はlive smoke未検証と明記します。fake testやローカルschema testをproduction proofへ格上げしません。
