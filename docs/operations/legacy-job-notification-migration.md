# legacy job の通知移行

## 起動時の歴史的通知 gate

通知 policy 導入前に作成された job は、元 Result から `not_sent` と分類されても、起動時の notification scan で新しい `dona_job` event を生成しない。`not_sent` は Result 内に投稿 action がないことだけを示し、旧 thread への再投稿許可ではない。既存 `completion_event_id` は再利用できるが、この gate は新しい group transition event を推測で生成しない。

`job notification-preview [--cursor <candidate_id>] [--limit <1-100>]` は保存済み候補の件数、元 terminal 期間、reason と最大100件の page を返す dry-run である。`next_cursor` がある間は次の page を取得する。候補 ledger は追記のみで、旧 thread への投稿や承認はこの command では行わない。現在の実装には旧 thread 投稿の承認・access 再検証・外部 receipt 照合を伴う batch write がないため、保留候補は隔離したままとする。既存の `reconcile-legacy-notification` で `not_sent` を確認しても、この gate は解除されない。

schema v2 から v3 への移行では、terminal な旧 Slack job の元 event Result を読み、通知を `notified`、`not_sent`、`acceptance_unknown` に分類する。結果は `job_legacy_notification_migration` に job ごとに保存される。分類と schema 更新は同じ transaction で確定する。既に v3 の DB でも、起動時に marker が欠けた旧 job を同じ規則で分類する。

- `notified`: 元 event の同じ job に対する委任 action と、job ID・投稿本文 hash・固定 workspace、channel、thread に束縛された `dona_slack.post_message` の成功 receipt がある。投稿後に job status に対応する Agent Session の最終 `active` / `suspended` 更新も成功している。message timestamp は job の terminal 時刻以降かつ元 Result の完了時刻以前とする。旧形式に本文 hash、job ID、最終 session status がなければ既送信と断定しない。新しい `dona_job` event は作らない。
- `not_sent`: 元 Result に同じ job の `delegate_job` 受理 action があり、post action がない。既存の通知 enqueue transaction が event 作成と `completion_event_id` の保存を一緒に確定する。
- `acceptance_unknown`: Result 欠落、不完全な action、未知の tool、投稿失敗・曖昧応答、receipt の競合、時刻・宛先の不一致など。自動通知を止める。運用者は元 event Result と実際の投稿履歴を照合するまで再送しない。

既存の `completion_event_id` がある job は従来の event を再利用し、移行分類の対象にしない。新規の grouped job と schedule owner の通知はこの分類の対象外である。marker は分類時の job status と error code に束縛する。後続の正当な cancellation や同じ status での理由変更は旧 marker で抑止しない。既に分類済みの job は起動時に再分類しない。`acceptance_unknown` は移行時の監査状態であり、job の実行結果や保存済み Result を変更しない。自動的な再分類や受理不明の再投稿は行わない。

確認には `job_legacy_notification_migration` の `state`、固定 `workspace_id`、`channel_id`、`thread_ts`、`message_ts`、`jobs.completion_event_id`、対応する `events.external_event_id` を同一 DB snapshot で読む。Result 本文、objective、認証情報を診断ログへ転記しない。

受理不明を運用者が「未送信」と確認した場合は、`job legacy-notification <job_id>` で現在の job 更新時刻と marker 分類時刻を読む。投稿履歴・元 Result・固定宛先の照合証拠の SHA-256 を用意し、`job reconcile-legacy-notification <job_id> <expected_job_updated_at> <expected_classified_at> <evidence_sha256> --notification-reviewed --no-post-confirmed` を一度だけ実行する。現在の status、error code、両時刻、`completion_event_id`、既存 `dona_job` event を transaction 内で再検査し、合致したときだけ marker を `not_sent` に変えて証拠 digest と判断時刻を別 table へ記録する。次の通常 scan が既存の通知 enqueue transaction を使う。応答が曖昧なら同じ command を再実行せず、`job legacy-notification` と event を再読する。既送信と判断した場合は、この未送信確定 command を使わず個別に調査する。
