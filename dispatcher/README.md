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

Figma Webhooks V2の1-file pilotを有効にする場合だけ、`FIGMA_CONNECTION_ID`、`FIGMA_WEBHOOK_ID`、`FIGMA_FILE_KEY`、`FIGMA_ALLOWED_EVENTS=FILE_UPDATE`、`FIGMA_WEBHOOK_PASSCODE`をsecret storeから環境へ渡します。pilotが受理するbusiness eventは`FILE_UPDATE`だけです。passcodeはpayload照合だけに使い、DB・Event Envelope・logへ保存しません。公開endpointはTLS、rate limit、request body上限を持つlocal reverse proxyから`POST /v1/ingress/figma`へ接続します。

Dispatcherはshellを介さず、次の形のargvでHerdr 0.8.2を呼びます。

```text
herdr --session dona agent get dona-main
herdr --session dona agent prompt dona-main <prompt>
herdr --session dona agent wait dona-main --until idle --until done --until blocked --timeout 120000
```

バックグラウンドジョブでは、専用workspaceまたはworktreeを`--no-focus`で作り、30文字の`job_id`をそのままHerdr agent名としてCodexを起動します。新規`job_id`はULID互換の26文字の末尾4文字を固定slugにし、たとえば改善作業は`job_01m1ne631mt99zdpwfmrwsenhc`になります。slugは外部入力を転写せず、`enhc`（改善）、`mend`（修正）、`feat`（実装）、`test`（テスト）、`read`（文書）、`rvwx`（レビュー）、`rsch`（調査）、`sync`（更新）、`send`（デプロイ）、`tags`（リリース）、`task`（その他）の固定語彙から選びます。ULIDの時刻部と60bitのランダム値を保持し、既存のjob ID形式、DB schema v2、`agent_name = job_id`も維持するため、旧リリースへ戻した場合も新規ジョブを同じ名前で制御できます。`job_id`は従来どおりDB主キー、API、workspace/worktree path、branch、Result Envelopeに使い、永続済みのagent名も再起動時にそのまま使います。

Codex 0.152.0でも有効な`projects = { "<path>" = { trust_level = "trusted" } }`inline tableを起動時overrideに使い、scratch jobではDispatcherが生成した`<jobsWorkspaceRoot>/scratch/<job_id>`との完全一致を検証した当該workspace 1件だけ、GitHub jobでは従来どおり検証・選択したrepositoryとworktreeだけをtrustします。scratch root、job-results、global Codex configはtrust対象にしません。これはsandbox、command approval、network policyを変更する設定ではありません。稼働中agentへの`agent prompt`はCodexのsteerとして扱われます。Dispatcher以外はジョブagentを直接操作しません。

## Dona Dispatcher MCP

Dispatcher packageには、常駐Dispatcherとは別プロセスのstdio MCPも含まれます。MCP自身はSQLiteやHerdrへ直接触らず、常駐DispatcherのUDS APIだけを呼びます。

- `delegate_job`: 長い調査・開発をscratchまたはGitHub worktreeへ委任
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

外部providerは`POST /v1/ingress/:source`の登録contractを使い、raw bytesのprovider認証、strict normalization、SQLite commit receipt、provider ACKをこの順序で処理します。登録のないsourceと`slack` / `dona_job` / `dona_update`の予約名は拒否します。詳細、互換matrix、provider追加手順は[External event ingress contract](../docs/external-event-ingress.md)を参照してください。

`dona_update`は通常のメインキューから除外され、`update-notifications.sqlite3`をtruthとする専用workerがSlack Adapterの`POST /v1/internal/update-notifications`へ通知します。通知IDは`request_id`とterminal fenceへ固定し、Slack message sectionの`block_id`を全thread pageで照合してから完了するため、応答喪失やworker再起動後も二重投稿を避けます。Slack投稿receiptを先に永続化し、その後で元eventのResult Envelopeをatomic publish・再読して`reported`へ進めます。恒久拒否は`needs_review`、通信失敗はbounded backoff付き`pending`として残ります。

ビルド後はリポジトリの[`.codex/config.toml`](../.codex/config.toml)を読んだCodexが`dist/mcp/index.js`を起動します。`npm run dev`が起動するのは常駐DispatcherとSlack Adapterだけです。

ジョブが`completed`、`failed`、`blocked`、`cancelled`、`needs_review`になると、Dispatcherは同じSQLiteへ`source: dona_job`の内部イベントを冪等に追加します。`dona-main`がそのイベントを通常の直列キューで受け、必要なSlack応答とAgent Sessionの状態変更を行います。ジョブworkerはSlackへ直接書き込みません。セルフアップデート通知は前述の専用workerだけが、固定文面・固定宛先でSlack Adapterへ依頼します。

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

`POST /v1/admin/quiesce`は新規event/job control受付を止め、workerとJob supervisorをdrainします。`GET /v1/admin/update-safety`はeventの`dispatching/waiting_agent`、jobの`dispatching/cancelling`、steer acceptance unknownを報告します。build SHA、protocol 1、app schema 2、config 1、`update_notification_protocol: 1`だけをversion healthへ出し、pathやsecretは返しません。

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

外部connection/subscription/cursorのSQLite registry、typed driver、CLI、renewal復旧とlive smokeの境界は[運用手順](../docs/operations/connection-lifecycle.md)を参照してください。

### Trigger-only job routing

provider event の認証 owner、永続 execution policy、通知先 `none` の Result 保存、MCP owner query、および migration/live 検証境界は [trigger-only routing](../docs/trigger-only-routing.md) を参照してください。
