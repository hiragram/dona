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
DONA_JOBS_PER_EVENT_MAX=8
DONA_JOB_OBJECTIVE_TOTAL_MAX_BYTES=400000
DONA_JOB_CONCURRENCY=4
DONA_JOB_CONCURRENCY_PER_EVENT=2
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

1つのsource eventから作成できるjobは既定8件（hard upper bound 32）で、作成時に正規化されたobjectiveのUTF-8 byte総量は既定400,000 bytesです。件数には`cancelled`/`failed`も含み、quota到達後も既存`job_key`のidempotency照合は先に処理します。実行はglobal 4件、source eventごと2件を上限とし、複数eventの待機jobはsource event単位のround-robinで選びます。設定値は起動時に正の整数と安全上限を検証します。

構造化ログ`Job scheduler state changed`はglobal/per-eventのqueue・active件数を集約値だけで出し、quota拒否はstable `job_group_limit_exceeded`と対象resource・数値だけを記録します。`job_key`、objective、workspace path、actor由来値はこれらの観測fieldへ含めません。

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

- `delegate_job`: 長い調査・開発をscratchまたはGitHub worktreeへ委任。同じsource eventでは安定した`job_key`ごとにcreate/reuseを判定
- `list_event_jobs`: create応答喪失時に`source_event_id`と任意の`job_key`から、writeを再送せずjobを照合。元の`objective`とworkspaceも渡すとcanonical payloadの`matched` / `conflict`を判定
- `list_thread_jobs`: Slack threadに紐づくジョブを列挙
- `get_job_status`: 現在の`source_event_id`と明示`job_id`でthreadを照合。 状態と結果を取得
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

明示的な`job_key`を持つ複数jobでは、元のsource eventが`dispatching` / `waiting_agent`から離れるtransaction内でgroupをsealし、それまではjob通知をメインキューへ流しません。各通知にはResult全文とは別の最大32件のboundedなgroup snapshotと`progress` / `attention` / `all_terminal` transitionを付けます。`progress`はAgent Sessionを変更せず、最初の`attention`だけが`suspended`、attention対象がなく全jobが`completed`または`cancelled`になった最初の`all_terminal`だけが`active`を所有します。`all_terminal`を処理する`dona-main`は`list_event_jobs`で全jobのdurable summaryを列挙し、snapshot内の各IDへread-onlyな`get_job_status`を使って先行jobのResultも集約するため、owner 1件の`payload.result`だけを全体結果として誤用しません。transition claim、event enqueue、jobの`completion_event_id`更新は1 transactionなので、再起動後は未通知jobだけを再照合できます。v2移行由来の単一jobと`job_key`省略callerはgroup fieldのない従来通知を維持します。

### background jobのAgent Status進捗

worker promptにはDispatcherが生成したjob専用progress pathだけを公開先として渡します。GitHub jobではcheckout外のworktree固有gitdir、scratch jobではworkspace内を使います。workerはallowlist済みphase、単調増加sequence、短い表示専用summaryを一時ファイルからrenameして公開します。Dispatcherはjob IDを固定値と照合し、Slack workspace/channel/threadはworkerファイルではなくsource eventから永続化済みのjob bindingだけで決めます。自由な宛先、command、path、URL、tokenらしいsummaryは受け付けず、安全なphase名へfallbackします。

進捗は本体schema v3と分離した`job-progress.sqlite3` schema v1へ保存します。これは古いreleaseの本体DB read/write互換性を壊さず、rollback時は新しい進捗表示だけが停止する設計です。pending更新は最新sequenceへcoalesceされ、順序逆転とduplicateは無視されます。Slack write開始後のtimeout・切断は`unknown`として永続化し、blind retryしません。進捗障害はjob Result・終端通知を失敗させません。terminal jobの遅延progressは破棄されます。

具体的な工程表示には`assistant.threads.setStatus` compatibility APIを使い、`agents.sessions.setStatus`のlifecycle (`processing` / `suspended` / `active`) や作成時だけの`title`とは分離します。compatibility APIが利用できない環境ではchat messageへfallbackせず、durable stateを保持したまま表示をdegradeします。

live smokeはrelease適用後に、専用test threadで`implementing`から`testing`の2 sequenceを順にatomic publishし、Slack画面の文言、API応答、短時間更新時のcoalesce/rate-limit、終端通知後の`active`復帰を確認します。このrepositoryのfake testはmethod/field境界だけを証明し、実Slack UI成功の証拠にはしません。検証後はprogress fileをjob Resultと同じretentionで削除でき、進捗DBは監査期間後にterminal rowを削除します。

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

ジョブはglobal/per-event上限の小さい方を守って複数同時に動きますが、同じ`dona-main`へのイベント投入は従来どおり1件ずつです。source event間はround-robinで選び、1つのfan-outが継続的に全slotを占有しません。ジョブの`preparing`は再起動時に`retryable_failed`へ戻します。prompt、steer、cancelの受理が曖昧な状態は`needs_review`へ移し、自動再投入しません。`running`は結果ファイルとHerdr agent状態の監視を再開し、最初のpromptを再送しません。

Result Envelopeは完成パスの最大1 MiB、schema version、event ID、status、UTC完了日時を検証します。`actions`は保存するだけで実行しません。agentの画面テキストは結果判定に使いません。

## 検証

```sh
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
```

### 複数jobのcallerとfollow-up

独立目的ごとに初回write前に安定した`job_key`を決めて`delegate_job`を呼びます。成功responseの`action`は`tool` / `source_event_id` / `job_key` / `job_id` / `outcome`（created/reused）だけで、Result actionsには成功callだけを残します。objective、path、secret、conflictや未実行案は成功actionに含めません。後続のvalidation/conflict/limit失敗でも成功済jobをcancelせず、partial successを利用者とResult summaryへ明示します。

create/steer/cancel/promptのtimeout・切断はblind retryせず、read-only reconcileします。createは`list_event_jobs`へ同じevent/keyと元payloadを渡して照合し、matchedでもcreated/reusedの喪失responseを推測しません。statusとreceiptは`get_job_status`で確認し、0件・conflict・unverified_legacy・受理不明なら人間へ確認します。

後続入力は先に`list_thread_jobs`を使います。0件なら操作せず、1件なら依頼意図との一致を確認します。複数候補かつ明示`job_id`なしなら質問し、本文類似・最新時刻・job_keyから選択せずbroadcastしません。外部自由文のID、command/path/token/private URLを未検証で制御引数へ使いません。対象確定後だけ現在のfollow-up `source_event_id`と明示`job_id`でsteer/status/cancelし、cross-threadを拒否します。

委任後はgroup terminalまでprocessingを保ち、個別progressでは投稿・active遷移をしません。attentionはsuspended、all_terminalは結果集約後activeです。通知のstatus取得にも現在の通知event_idを使います。group DB lifecycleはDispatcherの既存実装が所有します。

MCPのcreate/steer/cancel応答とthread候補はDB rowのallowlist projectionで、objective・workspace/result path・runtime identityを除外します。thread候補は最大100件で、`truncated: true`なら省略の可能性があるため最新1件を選びません。詳細Resultは明示status取得時だけ返します。HTTPのsource_event_id省略status取得は既存ローカルCLI互換用であり、MCPはevent IDを必須にします。

詳細statusの`last_error_message`は最大2,000文字に制限し、既知のobjective/path/runtime値と典型的なcredential・URL・絶対pathを秘匿して返します。`blocked`/`needs_review`でResultがなくても理由を確認できます。自由文の完全な秘密検出を保証するものではなく、未信頼の説明データとして扱い、外部投稿前にも確認します。候補・create/control応答には含めません。
