# Job Result 構造化公開 contract v1

`job-result-publish.ts` は worker から受ける値と、専用 capability の認可結果を定義する。既存の Result file ingestion はこの変更で切り替えない。#291 は検証済み `envelope` と `canonicalDigest` を永続 commit へ接続し、#292 は新規 job だけを切り替える gate と旧方式との混在・rollback を扱う。

## 発行と配送

- Dispatcher の dispatching 境界だけが `issue(job, session)` を呼ぶ。同じ job の既存 grant は失効する。32 byte の暗号学的乱数を base64url にし、server は SHA-256 digest のみを保持する。
- raw capability は対象 worker だけが読める専用の stdin／file descriptor 等で配送し、prompt、argv、環境変数、共通 log へ載せない。既存 Herdr 起動経路は prompt を argv に渡すため、`buildJobResultPublishInstructions` は秘密値を引数にも返り値にも含まない案内文だけとする。#292 が非argv配送を実装・検証するまで capability を実際の worker 起動へ配線しない。通常の `buildJobPrompt` は変更せず、共通 Dispatcher MCP に公開 tool を追加しない。
- 有効期間は発行から30分。`revokeJob` は cancel と worker 再投入時に呼ぶ。terminal 後は元の期限まで同じ grant の再送を read-only `reconcile` callback へだけ渡し、新たな commit は禁止する。発行時と認可時に永続 live-session identity の session を確認し、認可時に永続 job の status、attempt count、pane ID も再照合する。job ID や Result path は認可材料にならない。
- 長時間 job は発行から15分以降、期限前に専用接続の `POST /v1/job-result-publish/renew` で現在の grant を更新する。それ以前は固定 code `renewal_not_due` で拒否する。旧 grant は元の期限まで有効で、新しい capability は private な応答で worker に返す。同じ旧 capability からの renewal 再送は同じ successor と期限を返すため、応答喪失後も回収できる。期限切れ後の再発行は自動で行わず、Dispatcher の worker 世代確認が必要になる。
- grant は process memory だけに保持する。Dispatcher restart では全 grant が失われ、旧 worker の再送は拒否する。restart 後の復旧・再発行は #292 の gate と worker 世代照合で扱う。
- `JobResultPublishServer` は汎用 Dispatcher API/MCP と別の `POST /v1/job-result-publish` を定義し、信頼済みの接続済み socket だけを `accept()` で受ける。pathname を bind する機能は持たない。同一 OS user の sibling worker が pathname を置換して別 job の capability を盗むことを防ぐため、#292 は対象 worker へ接続済み file descriptor を専用経路で配送する。capability は `x-dona-job-result-capability`、worker session は `JSON.stringify(session)` の UTF-8 bytes を base64url 化した `x-dona-worker-session` で受ける。複合live sessionは全体を8 KiB以下とし、永続schemaに合わせて第4要素のagent session IDだけを512 Unicode code point以下へ制限する。本文を読む前と commit の直前に永続 job row を照合する。同時接続と切断後の実行中publishの上限はconstructorの必須`maxConnections`で指定し、#292 は少なくとも設定されたjob並行数を渡す。1接続ではrequestを逐次処理してrenewal後のpublishにも使えるが、重複したpipelined requestは拒否する。接続済みFDの初回idleはworker実行中維持し、初回headerの受信開始後と本文にはそれぞれ15秒の期限を設ける。認証失敗時は `Connection: close` を返して未完了接続を短時間で閉じる。停止時は未完了本文の接続を閉じ、開始済み commit／reconcile の完了と応答送出または切断を待つ。接続 FD の所持だけでは公開できない。#291 が commit callback を実装し、#292 が接続 FD・worker 配送・切替を配線する。

## request と応答材料

- request は `schema_version: 1`、`status`、`summary`、任意の `output`、object 配列の `artifacts`、`actions` だけ。未知 field は拒否する。job ID、時刻、path、owner は worker から受けない。
- 認可後、Dispatcher が取得した永続 job row から job ID を補い、Dispatcher 時計から `completed_at` を補う。最終 JSON の UTF-8 byte 数は既存 reader と共有する 1 MiB 上限以下とする。
- `canonicalDigest` は domain prefix、job ID、field 名の Unicode code point 順に安定化した request JSON の SHA-256。Dispatcher 補完時刻は含めない。同じ job と同じ request の再送は同じ digest、異なる内容は異なる digest になる。#291 が永続 receipt と照合して同一再送・異内容競合を確定する。
- terminal job の再送は、永続 `result_json` がある場合だけ受け入れ、`reconcileOnly` によって read-only callback へ分岐する。cleanup が live session や pane を削除していても、要求 session と grant 発行時 session の一致は必須とし、期限内の未失効 grant と永続 Result が一致対象になる。#291 は保存済み digest と比較して `reused` または `conflict` だけを返し、terminal Result を更新しない。
- 認可済み candidate の `fence` は job ID、公開可能なstatus集合（`dispatching`または`running`）、grant generation、attempt count、pane ID、live session を保持する。#291 の commit callback は Result 作成と同じ同期durable transactionでstatus集合とworker世代を照合し、`assertCurrentGrant()`をResult作成直前に呼ぶ。これにより正常な`dispatching`から`running`への遷移を許し、cancel・再投入・grant再発行後の旧worker結果を保存しない。全 job の期限内 grant の digest を照合し、別 job や更新前後の capability が本文の長い文字列へ埋め込まれていても拒否する。JSON の数値は安全整数だけを受け入れ、小数・指数表記は parse 前に拒否して丸めによる digest 衝突を防ぐ。
- validation error は固定 code だけを返す。本文、capability、private URL、local path は error や通常の log、metrics、監査へ含めない。公開 transport も raw header/body を記録せず、この型付き code だけを返す。
- artifact と action のキーは区切り文字と camelCase を正規化して資格情報・内部 runtime identity を拒否する。自由文内の引用符付き設定キー、userinfo を持つ URI、port付き loopback URL も拒否する。本文中の全 job の期限内 grant に含まれる session／pane、永続 job の objective、workspace/result path 等も値照合して拒否する。
