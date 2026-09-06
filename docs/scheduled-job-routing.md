# scheduled work のjob ownershipとResult routing

`dona_schedule` のwork runは、run・event・owner・Result destinationを永続的に結び付ける。自由記述のpayloadや後続eventからowner、外部write権限、通知先を組み立て直さない。

## Binding

- `event_job_bindings`はSlack threadまたは`schedule` ownerとtyped destinationをeventへ固定する。
- `job_owner_bindings`はjob作成時のbinding snapshotであり、更新triggerで差し替えを拒否する。
- schedule ownerはtenant、owner、schedule、run、revisionを含む。runごとにeventとjobは最大1件で、`jobs.source_event_id`と`schedule_runs.job_id`の一意性を併用する。
- `list_thread_jobs`は後方互換のまま維持し、`list_owner_jobs(source_event_id)`は同じ永続ownerだけを返す。steer/cancelも同じ比較をruntime操作前に行う。

## 実行と取消し

materialization transactionはwork eventとbindingを同時に保存する。通常workerは`dona_schedule`を処理し、promptに保存済みobjective、`read_only` scope、空の`allowed_external_writes`、Result destinationを明示する。`delegate_job`の重複は既存jobを返し、異なる内容ならpayload mismatchになる。

job作成時に最新のschedule state、revision、authorization expiry、misfireを再確認してからrunを`started`へ移す。schedule cancel・pause・authorization expiry後も開始済みworkのResultは保存するが、repository policyに従って通知だけを抑止する。未開始runは既存scheduler遷移で`cancelled`または`skipped`となりjob作成を拒否する。

## Resultとnotification

`job_completion_results`はwork stateとnotification stateを別fieldで保存し、Result本文は既存`jobs.result_json`を唯一の保存先にする。destination `none`でもResultを保存し、`dona_job`通知eventを生成しない。Result本文は完了記録から7日後に消去し、owner・destination・work/notification stateの監査metadataは残す。

Slack destinationを持つscheduled workは既存`connector_outbox`の`slack.work_result.post`へ渡し、outboxの`pending`、`accepted`、`failed`、`needs_review`をcompletion metadataへ同期する。job自体が`needs_review`になった場合はrunとscheduleも`needs_review`へ隔離し、adminの明示的な`reconcileWorkRun`だけが失敗または取消しへ確定できる。これによりjob失敗、notification failure、request acceptance unknownを別状態で監査する。Slack thread起点jobは従来どおり`dona_job` eventを生成する。

provider ingress一般、recurrence計算、Slack reminder送信実装はこのcontractの対象外である。
