# Figma Webhooks V2 1-file pilot

このpilotは1つの`file_key`と明示したevent allowlistだけを受け付けます。Figmaのpayload内`passcode`をbounded raw bodyから取り出してconstant-time比較し、認証後にだけstrict schema、`webhook_id`、file、eventを検証します。`PING`はactivation確認として200を返し、business event queueへ追加しません。

dedup keyは`figma-raw-v1`と受信raw bytesのSHA-256です。Figmaに共通stable delivery IDがないため、同じ意味でもraw bytesが異なる配送は別receiptとして保持します。これにより別eventのsilent dropを避け、downstreamのidempotencyを併用します。保持期間はDispatcher event retentionに従い、`fingerprint_version`で将来の変更を識別します。

作成・更新・削除がtimeoutした場合はblind retryせず、`GET /v2/webhooks`と直近7日のrequest historyをread-onlyで取得し、固定した`webhook_id`、file、event、HTTP status、Dispatcherの`event_id`を照合します。passcode、raw body、private callback URLは記録しません。retry（5分、30分、3時間）は同一raw fingerprintのreceiptへ収束します。

live smokeではtest plan内の1 fileだけにwebhookを作成し、PING、許可event 1件、request historyのHTTP 200、Dispatcher receipt、secret非露出logを照合します。webhook create/deleteは外部writeなので、明示承認と利用可能なFigma credentialがない実行では行いません。
