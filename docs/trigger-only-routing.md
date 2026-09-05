# Trigger-only event の所有権と結果保存

Issue #49 の実装先は `feature/external-event-sources`。#48 の PR #77 を統合済みの base を使用する。

## 認証境界と永続 binding

`VerifiedIngressPrincipal.resourceId` は、adapter の `authenticate` が認証済み transport metadata と永続 allowlist から解決した resource ID。payload の自己申告をコピーしてはならない。`connectionId` とともに normalize 前に snapshot し、Event Envelope の自由記述とは別引数で `enqueueProvider` へ渡す。未対応の既存 registration は ingress/ACK を継続できるが、owner が未確定なので job を作成できない。

owner は次の closed union。

- `slack_thread`: `workspace_id`、`channel_id`、`thread_ts`
- `provider_resource`: `source`、`connection_id`、`resource_id`

`event_bindings` と `job_bindings` は owner、execution policy、destination を保存し、UPDATE trigger で変更を拒否する。既存の有効な Slack event/job は migration 時に backfill する。判定不能な legacy owner を推測して補わない。

provider の background job 許可は `provider_execution_policies` の `(source, connection_id, resource_id, event_type)` に完全一致する設定から取得する。未設定は拒否。trusted local configuration API `setProviderExecutionPolicy` は HTTP/MCP に公開しない。許可の snapshot は admission 時に固定され、後日の policy 更新や再送では既存 event を昇格させない。provider job の workspace は `scratch` に限定する。Slack の GitHub workspace は従来どおり。

## 照会と制御

`list_owner_jobs(source_event_id)` は永続 owner に一致する job だけを返す。`get_job_status` は provider job に `source_event_id` を要求し、不一致・未確定を拒否する。steer/cancel は同じ比較を runtime 操作前に行う。cancelled job の重複 cancel でも先に owner を検証する。

既存 `list_thread_jobs` と引数なしの Slack `get_job_status(job_id)` は後方互換を維持する。これらは従来どおり private UDS の trusted Dona caller 向けであり、public provider 認証経路ではない。source event ID は Dispatcher が発行した処理 context を使用する。

## Result と completion

`reply_target: null` の event は通常の serial worker で no-op、同期処理、許可された job 委任を判断する。prompt は外部通知・Slack 座標の生成を禁止する。どの経路も既存の Result Envelope 検証と SQLite の `events.result_json` 保存を使用する。

job は既存の別 workspace/result path と runtime identity を維持する。`saveJobResult` は schema、job ID、result path を検証する。正常な job Result と event Result は別々に保存する。

`job_completions` は `(job_id, job_status)` ごとの一意な completion projection。status ごとのキーは、従来の Slack `blocked` 通知後に明示 cancel した場合の `cancelled` 通知を維持するため。同一 terminal status の重複/restartでは増えない。

- provider destination は `{ kind: "none" }`。job Result と completion projection の保存だけを行い、`dona_job` event も Slack wake も生成しない。
- Slack destination は owner と同一の typed `slack_thread`。既存 `dona_job` event を生成する。
- completion projection、notification event、job への event ID link は同じ SQLite transaction で commit する。
- `notification_state` と `notification_result_json` は job Result から分離する。`accepted` は通知用 Dona event の処理完了を表し、Slack API の配信 receipt の代用ではない。実際の外部操作は通知 event の Result/actions で照合する。
- notification prompt の受付不明は既存 event の `needs_review` に従い、completion を再生成せず、通知 Result と独立して job Result を保持する。

この実装の destination union は `none | slack_thread` のみ。provider comment/update の destination、approval、connector、outbound executor は実装しない。追加する場合は ingress permission と独立した capability/approval/outbox contract が必要。

## migration と #46 の境界

routing migration は追加テーブルと trigger の transaction。既存 jobs/group schema、`user_version`、event/job/runtime ID、Result、completion event を書き換えない。重複 ingress、create、completion は `BEGIN IMMEDIATE` で read→write の競合を直列化し、外部 write の retry で解決しない。

本 branch の job engine は schema v2。#46 は別の未統合 feature branch であり、取り込み・merge・fan-out の再実装はしていない。`migrateEventRouting` は #46 schema v3 にも適用でき、`dispatcher/test/fixtures/jobs-v3.sql` は採取元 SHA を記録した実際の #46 migration SQL。fixture は両 schema の row 保持、rollback、`integrity_check`、`foreign_key_check` を検証する。

schema v3 DB をこの branch の旧 v2 job engine で運転できるという意味ではない。#46 を統合する際は、その job engine と `job_key`/group admission を保持し、schema migration 後に routing migration を適用する。双方を統合した runtime の E2E は別 gate。routing テーブルが存在する DB を旧版へ戻して provider job を運転する rollback も未対応であり、schema version の数値だけで runtime 互換と判定しない。

## 検証と live smoke の残境界

`npm test`（dispatcher）は fake provider の認証 owner snapshot、nullable codec、capability、cross-owner 操作、UDS query、通常の event Result、job terminal Result、通知先なし、Result fault、prompt受付不明、completion commit 後の restart、notification受付不明、および独立プロセス同時 create/completion を検証する。fake runtime の job 実行回数と通知 wake 回数も照合する。

live smoke は未実施。このバックグラウンドワーカーには Dona Dispatcher MCP と隔離 provider test ingress の接続がない。shell から Herdr/Codex worker を起動せず、production deploy、自動更新、認証設定変更、外部通知も行わない。

最終 live gate は、隔離 test runtime にこの変更を用意したうえで、Dona Dispatcher MCP を使える担当が以下を一度実施する。

1. read-only test source/type/resource に限る永続 scratch job policy と、認証済み connection/resource を持つ test ingress を確認する。
2. test event 1件を投入し、persist receipt と固定 event ID を取得する。Dona の処理 context から `delegate_job` を1回呼ぶ。
3. MCP の owner query/status と隔離環境の読み取り証拠で owner binding、job ID、別 workspace/result、terminal DB Result、destination `none` を照合する。
4. completion projection が1件、`notification_state: none`、notification event ID が null、Slack通知が0件であることを照合する。受付不明なら再投入せず既存 identity で照合する。

fake 検証を live 成功として扱わず、この gate と #46 統合後 runtime gate が未実施である間は Issue 全体の完了を主張しない。
