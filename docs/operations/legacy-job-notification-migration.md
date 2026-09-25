# legacy job の通知移行

schema v2 から v3 への移行では、terminal な旧 Slack job の元 event Result を読み、通知を `notified`、`not_sent`、`acceptance_unknown` に分類する。結果は `job_legacy_notification_migration` に job ごとに保存される。分類と schema 更新は同じ transaction で確定する。既に v3 の DB でも、起動時に marker が欠けた旧 job を同じ規則で分類する。

- `notified`: 元 event の同じ job に対する委任 action と、job ID・投稿本文 hash・固定 workspace、channel、thread に束縛された `dona_slack.post_message` の成功 receipt がある。message timestamp は job の terminal 時刻以降かつ元 Result の完了時刻以前とする。旧形式に本文 hash や job ID がなければ既送信と断定しない。新しい `dona_job` event は作らない。
- `not_sent`: 元 Result に同じ job の `delegate_job` 受理 action があり、post action がない。既存の通知 enqueue transaction が event 作成と `completion_event_id` の保存を一緒に確定する。
- `acceptance_unknown`: Result 欠落、不完全な action、未知の tool、投稿失敗・曖昧応答、receipt の競合、時刻・宛先の不一致など。自動通知を止める。運用者は元 event Result と実際の投稿履歴を照合するまで再送しない。

既存の `completion_event_id` がある job は従来の event を再利用し、移行分類の対象にしない。新規の grouped job と schedule owner の通知はこの分類の対象外である。marker は分類時の job status に束縛する。後続の正当な cancellation など別 status の通知は旧 marker で抑止しない。`acceptance_unknown` は移行時の監査状態であり、job の実行結果や保存済み Result を変更しない。自動的な再分類や受理不明の再投稿は行わない。

確認には `job_legacy_notification_migration` の `state`、固定 `workspace_id`、`channel_id`、`thread_ts`、`message_ts`、`jobs.completion_event_id`、対応する `events.external_event_id` を同一 DB snapshot で読む。Result 本文、objective、認証情報を診断ログへ転記しない。
