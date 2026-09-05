# Dona Dispatcher

AdapterからUnix Domain Socket上のHTTP/1.1でイベントを受け、SQLiteへ永続化した後にHerdrの`dona-main`へ1件ずつ投入します。長い作業は別のCodexワーカーへ委任でき、`dona-main`は次のイベント受付へ戻れます。セルフアップデートのterminal通知だけは専用の永続workerが処理し、停止・再起動される`dona-main`を経由しません。

## セットアップと起動

```sh
npm install
cp .env.example .env
npm run dev
```

設定を省略した場合、次のファイルを使います。

```text
~/Library/Application Support/Dona/
├── dona.sqlite3
├── update-notifications.sqlite3
├── results/<event_id>.json
├── job-results/<job_id>.json
└── run/dispatcher.sock
```

ジョブworkspaceの初期値は次のとおりです。

```text
~/.dona/workspaces/
├── scratch/<job_id>/
└── github/<owner>/<repo>/
    ├── repository/
    └── worktrees/<job_id>/
```

GitHub jobのbranchは`dona/<job_id>`です。Dona独自のrepository許可台帳は設けず、clone、push、PR作成の認証・権限は`gh`とGitHub側へ委ねます。

`run`と`results`は`0700`、socketとDBは`0600`へ設定します。SQLiteはWALモードです。起動時に接続不能なsocketが残っていればstale socketとして削除し、接続可能なら二重起動として失敗します。

Herdr連携の初期値は次のとおりです。

```dotenv
HERDR_SESSION=dona
DONA_AGENT_NAME=dona-main
DONA_HERDR_PATH=herdr
DONA_AGENT_MISSING_GRACE_MS=5000
DONA_JOBS_WORKSPACE_ROOT=~/.dona/workspaces
DONA_JOB_RESULTS_DIR=~/Library/Application Support/Dona/job-results
DONA_JOB_CONCURRENCY=4
DONA_JOB_AGENT_START_TIMEOUT_MS=30000
DONA_JOB_COMMAND_TIMEOUT_MS=10000
DONA_GH_PATH=gh
DONA_GIT_PATH=git
DONA_UPDATER_SOCKET_PATH=~/Library/Application Support/Dona/update-control/updater.sock
DONA_UPDATE_INTERNAL_TOKEN_PATH=~/Library/Application Support/Dona/update-control/dispatcher.token
DONA_UPDATE_NOTIFICATION_DATABASE_PATH=~/Library/Application Support/Dona/update-notifications.sqlite3
SLACK_HEALTH_SOCKET_PATH=~/Library/Application Support/Dona/run/slack-adapter.sock
DONA_RELEASE_MANIFEST_PATH=~/Library/Application Support/Dona/runtime/current/release-manifest.json
```

Dispatcherはshellを介さず、次の形のargvでHerdr 0.8.2を呼びます。

```text
herdr --session dona agent get dona-main
herdr --session dona agent prompt dona-main <prompt>
herdr --session dona agent wait dona-main --until idle --until done --until blocked --timeout 120000
```

バックグラウンドジョブでは、専用workspaceまたはworktreeを`--no-focus`で作り、同じ`job_id`をHerdr agent名としてCodexを起動します。GitHub jobではDispatcherが検証・選択したrepositoryとworktreeだけを、起動時の`projects = { "<path>" = { trust_level = "trusted" } }`overrideへ渡すため、対話的なproject trust確認でworkerが停止しません。これはsandboxやcommand approvalを無効化する設定ではありません。稼働中agentへの`agent prompt`はCodexのsteerとして扱われます。Dispatcher以外はジョブagentを直接操作しません。

## Dona Dispatcher MCP

Dispatcher packageには、常駐Dispatcherとは別プロセスのstdio MCPも含まれます。MCP自身はSQLiteやHerdrへ直接触らず、常駐DispatcherのUDS APIだけを呼びます。

- `delegate_job`: 長い調査・開発をscratchまたはGitHub worktreeへ委任。同じsource eventでは安定した`job_key`ごとにcreate/reuseを判定
- `list_event_jobs`: create応答喪失時に`source_event_id`と任意の`job_key`から、writeを再送せずjobを照合。元の`objective`とworkspaceも渡すとcanonical payloadの`matched` / `conflict`を判定
- `list_thread_jobs`: Slack threadに紐づくジョブを列挙
- `get_job_status`: 状態と結果を取得
- `steer_job`: 同じthreadの後続イベントを稼働中Codex turnへsteer
- `cancel_job`: ジョブを中止
- `plan_self_update`: fixed mainのexact SHA update planを作る（read-only）
- `apply_self_update`: exact plan hashと明示承認receiptを投入（destructive）
- `get_self_update_status`: state、fence、SHA、health、outboxを取得（read-only）
- `cancel_self_update`: activation前にcancel。外部mutation後はneeds_review（destructive）

`apply_self_update`のacceptedはupdater DB commit後だけ返ります。元のSlack受付eventが`completed`になる前にupdaterはactivationをclaimしません。timeoutや接続切断でapply/cancelのacceptanceが不明な場合は、同じwriteを再送せずstatusを確認します。

terminal updateは`source: dona_update`としてDispatcherへ戻ります。外部`POST /v1/events`はこのsourceを拒否し、0600 tokenを使う`POST /v1/internal/update-events`だけがtyped payloadを受けます。stable external IDで重複を吸収し、POST response喪失時はexternal IDとcanonical payload SHA-256をlookupしてから判断します。

`dona_update`は通常のメインキューから除外され、`update-notifications.sqlite3`をtruthとする専用workerがSlack Adapterの`POST /v1/internal/update-notifications`へ通知します。通知IDは`request_id`とterminal fenceへ固定し、Slack message sectionの`block_id`を全thread pageで照合してから完了するため、応答喪失やworker再起動後も二重投稿を避けます。Slack投稿receiptを先に永続化し、その後で元eventのResult Envelopeをatomic publish・再読して`reported`へ進めます。恒久拒否は`needs_review`、通信失敗はbounded backoff付き`pending`として残ります。

ビルド後はリポジトリの[`.codex/config.toml`](../.codex/config.toml)を読んだCodexが`dist/mcp/index.js`を起動します。`npm run dev`が起動するのは常駐DispatcherとSlack Adapterだけです。

ジョブが`completed`、`failed`、`blocked`、`cancelled`、`needs_review`になると、Dispatcherは同じSQLiteへ`source: dona_job`の内部イベントを冪等に追加します。`dona-main`がそのイベントを通常の直列キューで受け、必要なSlack応答とAgent Sessionの状態変更を行います。ジョブworkerはSlackへ直接書き込みません。セルフアップデート通知は前述の専用workerだけが、固定文面・固定宛先でSlack Adapterへ依頼します。

明示的な`job_key`を持つ複数jobでは、元のsource eventが`dispatching` / `waiting_agent`から離れるtransaction内でgroupをsealし、それまではjob通知をメインキューへ流しません。各通知にはResult全文とは別のboundedなgroup snapshotと`progress` / `attention` / `all_terminal` transitionを付けます。`progress`はAgent Sessionを変更せず、最初の`attention`だけが`suspended`、attention対象がなく全jobが`completed`または`cancelled`になった最初の`all_terminal`だけが`active`を所有します。transition claim、event enqueue、jobの`completion_event_id`更新は1 transactionなので、再起動後は未通知jobだけを再照合できます。v2移行由来の単一jobと`job_key`省略callerはgroup fieldのない従来通知を維持します。

Dispatcher DB schema v3は、v2の`jobs.source_event_id UNIQUE`を`UNIQUE(source_event_id, job_key)`へtransactionalにrebuildします。既存jobは`job_key = legacy-default`へbackfillされ、全job列、Result、runtime identity、completion eventを保持します。source eventごとの`job_groups`も同じtransactionで作成し、通知済みjobは`notification_mode = legacy`、未通知jobは`grouped`として区別します。migration失敗時は旧tableと`PRAGMA user_version = 2`がそのままrollbackされます。production backup/restoreとactivationはこの自動migrationとは別のrelease手順で、WAL稼働中DBの単体file copyをbackup扱いしません。

新規jobは作成時canonical payloadのSHA-256を`workspace_json`内のDispatcher予約metadataへ保存し、後続steerで`objective`が変わってもcreate/reuse判定を固定します。v2から移行した`legacy-default` rowには作成時payloadが存在しないためhashを推測せず、payload付き照合では`unverified_legacy`を返して従来の単一job reuseを維持します。予約metadataはworker promptと`dona_job` payloadのworkspace projectionから除外されます。

Codexで`/clear`するとagent sessionが置き換わり、Herdr上の`dona-main`という名前が解除される場合があります。`waiting_agent`の処理中は`/clear`を避けてください。解除された場合は`herdr --session dona agent list`で対象の`pane_id`を確認し、次のように名前を戻します。

```sh
herdr --session dona agent rename <pane_id> dona-main
herdr --session dona agent get dona-main
```

## 手動疎通

workerを動かさず受付だけを確認したい場合は、`DONA_HERDR_PATH`に存在しないコマンドを設定するとイベントは`retryable_failed`になります。通常の疎通は次のとおりです。

```sh
curl --unix-socket "$HOME/Library/Application Support/Dona/run/dispatcher.sock" \
  -X POST http://localhost/v1/events \
  -H 'Content-Type: application/json' \
  -d '{
    "schema_version": 1,
    "source": "slack",
    "external_event_id": "manual-test-001",
    "type": "app_mention",
    "occurred_at": "2026-09-01T10:20:30Z",
    "subject": {
      "workspace_id": "T_TEST",
      "channel_id": "C_TEST",
      "thread_ts": "1756722030.123456",
      "actor_id": "U_TEST"
    },
    "payload": { "text": "外部プロセスからの疎通テストです" },
    "reply_target": {
      "kind": "slack_thread",
      "workspace_id": "T_TEST",
      "channel_id": "C_TEST",
      "thread_ts": "1756722030.123456"
    }
  }'
```

health check:

```sh
curl --unix-socket "$HOME/Library/Application Support/Dona/run/dispatcher.sock" http://localhost/health/live
curl --unix-socket "$HOME/Library/Application Support/Dona/run/dispatcher.sock" http://localhost/health/ready
curl --unix-socket "$HOME/Library/Application Support/Dona/run/dispatcher.sock" http://localhost/health/version
```

`POST /v1/admin/quiesce`は新規event/job control受付を止め、workerとJob supervisorをdrainします。`GET /v1/admin/update-safety`はeventの`dispatching/waiting_agent`、jobの`dispatching/cancelling`、steer acceptance unknownを報告します。version healthはbuild SHA、protocol 1、実DB schema 3、read range 2〜3、write schema 3、config 1、`update_notification_protocol: 1`だけを出し、pathやsecretは返しません。

## 運用CLI

開発時は`npm exec -- tsx src/cli.ts ...`、build後は`node dist/cli.js ...`を使えます。

```sh
npm exec -- tsx src/cli.ts event list
npm exec -- tsx src/cli.ts event list --status needs_review
npm exec -- tsx src/cli.ts event show evt_...
npm exec -- tsx src/cli.ts event complete evt_...
npm exec -- tsx src/cli.ts event dead-letter evt_...
npm exec -- tsx src/cli.ts event retry evt_...
npm exec -- tsx src/cli.ts event retry evt_... --force
npm exec -- tsx src/cli.ts job list
npm exec -- tsx src/cli.ts job list --status running
npm exec -- tsx src/cli.ts job show job_...
```

`blocked`または`needs_review`のretryには`--force`が必要です。Herdr画面、結果ファイル、構造化ログを確認し、二重実行の可能性を理解した場合だけ実行してください。

## 状態と復旧

- `queued` / `retryable_failed`: sequence先頭から再開します。先頭イベントがbackoff中なら後続を追い越しません。
- `waiting_agent`: Result Envelopeとagent状態の確認を再開し、promptは再送しません。
- prompt受理後にagentが見つからない状態が`DONA_AGENT_MISSING_GRACE_MS`（既定5秒）を超えた場合は、二重投入を避けて`needs_review`へ移します。
- staleな`dispatching`: 起動時に`needs_review`へ移します。
- `blocked`: 自動解除せず、キュー全体を停止します。
- `needs_review` / `completed` / `dead_letter`: 自動変更しません。

ジョブは複数同時に動きますが、同じ`dona-main`へのイベント投入は従来どおり1件ずつです。ジョブの`preparing`は再起動時に`retryable_failed`へ戻します。prompt、steer、cancelの受理が曖昧な状態は`needs_review`へ移し、自動再投入しません。`running`は結果ファイルとHerdr agent状態の監視を再開し、最初のpromptを再送しません。

Result Envelopeは完成パスの最大1 MiB、schema version、event ID、status、UTC完了日時を検証します。`actions`は保存するだけで実行しません。agentの画面テキストは結果判定に使いません。

## 検証

```sh
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
```
