# Dona Dispatcher

AdapterからUnix Domain Socket上のHTTP/1.1でイベントを受け、SQLiteへ永続化した後にHerdrの`dona-main`へ1件ずつ投入します。長い作業は別のCodexワーカーへ委任でき、`dona-main`は次のイベント受付へ戻れます。

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
```

Dispatcherはshellを介さず、次の形のargvでHerdr 0.8.2を呼びます。

```text
herdr --session dona agent get dona-main
herdr --session dona agent prompt dona-main <prompt>
herdr --session dona agent wait dona-main --until idle --until done --until blocked --timeout 120000
```

バックグラウンドジョブでは、専用workspaceまたはworktreeを`--no-focus`で作り、Herdrの32文字制限内に収まる`j<完全なULID>-<固定slug>`をagent名としてCodexを起動します。たとえば改善作業は`j01m1ne631mt99zdpwfmrwsvjdg-impr`です。slugは外部入力を転写せず、`impr`、`fix`、`impl`、`test`、`docs`、`rvw`、`rsch`、`updt`、`dply`、`rels`、`task`の固定語彙から選びます。`job_id`は従来どおりDB主キー、API、workspace/worktree path、branch、Result Envelopeに使い、永続済みの旧agent名も再起動時にそのまま使います。GitHub jobではDispatcherが検証・選択したrepositoryとworktreeだけを、起動時の`projects = { "<path>" = { trust_level = "trusted" } }`overrideへ渡すため、対話的なproject trust確認でworkerが停止しません。これはsandboxやcommand approvalを無効化する設定ではありません。稼働中agentへの`agent prompt`はCodexのsteerとして扱われます。Dispatcher以外はジョブagentを直接操作しません。

## Dona Dispatcher MCP

Dispatcher packageには、常駐Dispatcherとは別プロセスのstdio MCPも含まれます。MCP自身はSQLiteやHerdrへ直接触らず、常駐DispatcherのUDS APIだけを呼びます。

- `delegate_job`: 長い調査・開発をscratchまたはGitHub worktreeへ委任
- `list_thread_jobs`: Slack threadに紐づくジョブを列挙
- `get_job_status`: 状態と結果を取得
- `steer_job`: 同じthreadの後続イベントを稼働中Codex turnへsteer
- `cancel_job`: ジョブを中止

ビルド後はリポジトリの[`.codex/config.toml`](../.codex/config.toml)を読んだCodexが`dist/mcp/index.js`を起動します。`npm run dev`が起動するのは常駐DispatcherとSlack Adapterだけです。

ジョブが`completed`、`failed`、`blocked`、`cancelled`、`needs_review`になると、Dispatcherは同じSQLiteへ`source: dona_job`の内部イベントを冪等に追加します。`dona-main`がそのイベントを通常の直列キューで受け、必要なSlack応答とAgent Sessionの状態変更を行います。ワーカーはSlackへ直接書き込みません。

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
```

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
