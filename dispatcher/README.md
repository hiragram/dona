# Dona Dispatcher

AdapterからUnix Domain Socket上のHTTP/1.1でイベントを受け、SQLiteへ永続化した後にHerdrの`dona-main`へ1件ずつ投入します。

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
└── run/dispatcher.sock
```

`run`と`results`は`0700`、socketとDBは`0600`へ設定します。SQLiteはWALモードです。起動時に接続不能なsocketが残っていればstale socketとして削除し、接続可能なら二重起動として失敗します。

Herdr連携の初期値は次のとおりです。

```dotenv
HERDR_SESSION=dona
DONA_AGENT_NAME=dona-main
DONA_HERDR_PATH=herdr
DONA_AGENT_MISSING_GRACE_MS=5000
```

Dispatcherはshellを介さず、次の形のargvでHerdr 0.8.2を呼びます。

```text
herdr --session dona agent get dona-main
herdr --session dona agent prompt dona-main <prompt>
herdr --session dona agent wait dona-main --until idle --until done --until blocked --timeout 120000
```

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
```

`blocked`または`needs_review`のretryには`--force`が必要です。Herdr画面、結果ファイル、構造化ログを確認し、二重実行の可能性を理解した場合だけ実行してください。

## 状態と復旧

- `queued` / `retryable_failed`: sequence先頭から再開します。先頭イベントがbackoff中なら後続を追い越しません。
- `waiting_agent`: Result Envelopeとagent状態の確認を再開し、promptは再送しません。
- prompt受理後にagentが見つからない状態が`DONA_AGENT_MISSING_GRACE_MS`（既定5秒）を超えた場合は、二重投入を避けて`needs_review`へ移します。
- staleな`dispatching`: 起動時に`needs_review`へ移します。
- `blocked`: 自動解除せず、キュー全体を停止します。
- `needs_review` / `completed` / `dead_letter`: 自動変更しません。

Result Envelopeは完成パスの最大1 MiB、schema version、event ID、status、UTC完了日時を検証します。`actions`は保存するだけで実行しません。agentの画面テキストは結果判定に使いません。

## 検証

```sh
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
```
