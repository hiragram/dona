# Dona Slack integration

このnpmパッケージには、別プロセスとして動く2つのアプリケーションがあります。認証情報とworkspace設定は共有します。

| application | entry point | responsibility |
|---|---|---|
| Slack Adapter | `dist/index.js` | Socket ModeイベントをDispatcherへ渡し、typed internal update通知をSlackへ届ける |
| Dona Slack MCP | `dist/mcp/index.js` | CodexがSlackの読み取り・書き込みを任意に実行するstdio MCP |

AdapterはSlack Socket ModeのWebSocketからイベントを受信し、共通Event Envelopeへ正規化してDona Dispatcherへ転送します。また、認証済みの内部UDS endpointでセルフアップデートの固定terminal通知を受け、該当threadへの投稿とAgent Session状態変更を行います。Macへの公開port、Request URL、Signing Secretは不要です。MCPはAdapterとは別プロセスで、Herdr/Codexから必要時に起動されます。

通常の`message`はDona宛とは限らないため、正規化時にSlackの`channel_type`（`channel` / `group` / `im` / `mpim`）を許可リストで検証し、存在する場合は`subject.channel_type`として渡します。Donaはこの値、イベント種別、本文、スレッド文脈から対応要否を判断します。

重要な順序は次のとおりです。

```text
Socket Mode Envelope受信
→ payload.event_idを使って正規化
→ Dispatcher POST /v1/events
→ SQLite commit済みの200/202を確認
→ envelope_idを明示ACK
```

AdapterはHerdrやDispatcherのSQLiteを直接操作しません。使用している低レベル`@slack/socket-mode` clientはイベントを自動ACKせず、listenerへ渡された`ack`を上記の最後でだけ呼びます。

## Slack Appの設定

接続する各Slack Appについて次を行います。

1. [`manifest.yaml`](./manifest.yaml)に合わせ、Socket Modeを有効にします。
2. 「Basic Information」→「App-Level Tokens」でtokenを発行します。
3. App-Level Tokenには`connections:write`だけを付与します。
4. Event Subscriptionsを有効にし、必要なBot Eventsを登録します。
5. OAuth scopesを確認し、Appをworkspaceへinstall/reinstallします。
6. Botを受信対象チャンネルへ招待します。
7. Request URLは設定しません。

tokenは用途と接頭辞を混同しないでください。

| token | prefix | purpose |
|---|---|---|
| App-Level Token | `xapp-` | Socket Mode接続と`apps.connections.open` |
| Bot User OAuth Token | `xoxb-` | bot権限、MCPからのSlack読み取り・書き込み |

`app_mention`だけに絞る場合は、manifestからmessage eventsと対応するhistory scopesを削除できます。その場合も`app_mentions:read`と`app_mention`は残します。

現在のmanifestのように`app_mention`とmessage eventsを併用すると、チャンネル内のメンションは両方のイベントとして配送されます。Adapterは自分宛メンションを含む`message.channels` / `message.groups`をACKだけしてDispatcherへ送らず、`app_mention`だけを処理します。DMのmessage eventは除外しません。

MCPは、チャンネル・ユーザー・リアクション・ファイルの参照に`channels:read`、`groups:read`、`users:read`、`reactions:read`、`files:read`を使います。メッセージ投稿とAgent Sessionの状態変更には`chat:write`、Agent宣言には`assistant:write`、リアクション追加には`reactions:write`を使います。manifestのscopeを既存Appへ追加した後は、各workspaceでAppをreinstallしてください。

## 起動

先にDispatcherを起動します。

```sh
cd dispatcher
npm run dev
```

別ターミナルでAdapterを起動します。

```sh
cd sources/slack
npm install
cp .env.example .env
npm run dev
```

複数workspaceでは安定した別名を設定します。各設定につきSocket Mode接続は1本です。

```dotenv
SLACK_WORKSPACES=company,community
SLACK_SOCKET_MODE_ENABLED=true
```

初回起動時は別名ごとに2つのtokenを順に尋ね、macOS Keychainへ保存します。入力は`*`でマスクされ、貼り付け可能です。

| workspace alias | Keychain service | account |
|---|---|---|
| `company` | `dona.slack-source` | `company.slack-app-token` |
| `company` | `dona.slack-source` | `company.slack-bot-token` |
| `community` | `dona.slack-source` | `community.slack-app-token` |
| `community` | `dona.slack-source` | `community.slack-bot-token` |

「キーチェーンアクセス」では、ログインキーチェーンからサービス名`dona.slack-source`を検索し、対象項目を開いて「パスワードを表示」を選びます。HTTP受信用のSigning Secret項目は使用しません。

## Dona Slack MCP

まず一度Adapterを対話可能なターミナルで起動して、各workspaceの`xoxb-` tokenをKeychainへ登録します。MCPのstdin/stdoutはプロトコル専用なので、MCP自身はtoken入力を促しません。未登録なら設定方法をstderrへ出して終了します。

MCPが公開するツール:

| tool | side effect | purpose |
|---|---|---|
| `list_workspaces` | なし | 利用可能なworkspace aliasを確認 |
| `list_channels` | なし | Botから見える公開・非公開チャンネルを列挙 |
| `get_channel` | なし | channel IDから名前・topic・参加状態を取得 |
| `list_users` | なし | メールアドレスを除いたユーザー一覧を取得 |
| `get_user` | なし | user IDから表示名などを取得 |
| `get_thread` | なし | channel IDとthread timestampでスレッドを読む |
| `get_reactions` | なし | messageの既存リアクションを取得 |
| `get_file` | なし | ファイル情報と対応形式の内容を取得 |
| `set_agent_session_status` | あり | threadのAgent Sessionを`processing`、`active`、`suspended`、`closed`へ変更 |
| `post_message` | あり | channel投稿またはthread返信 |
| `add_reaction` | あり | messageへemoji reactionを追加 |

`set_agent_session_status`は、Donaが返信すると判断した後に`processing`、返信完了後に`active`、質問や承認待ちでは`suspended`を設定します。`closed`は会話を明示的に終了するときだけ使います。statusを設定しないイベントにはローディング表示は出ません。

MCPはSlack APIへの自動再試行を無効にしています。書き込みの通信結果が曖昧な場合、二重投稿を避けるためエージェントへ自動再試行しないよう伝えます。token、投稿本文、スレッド本文は通常ログへ出しません。

セルフアップデート通知では、`request_id`とterminal fenceから一意な`notification_id`を作り、`dona.update_notification` metadataとして投稿します。再配送時は`conversations.replies`をcursorの終端まで読み、同じmetadataが1件なら既存投稿を再利用します。0件だけ新規投稿し、複数件なら恒久エラーとして止めます。Slack Agent Sessionは成功・rollback・cancelで`active`、失敗・確認待ちで`suspended`へ遷移します。本文、宛先、statusはDispatcherのstrict schema以外から指定できません。

Slack AppのApp Manifestへ[`manifest.yaml`](./manifest.yaml)を反映し、manifestトップレベルの`metadata.event_subscriptions`にある`dona.update_notification` schemaとbot scopeの`metadata.message:read`を各workspaceで確認して再認可してから、`slack.env`の`SLACK_UPDATE_METADATA_SCHEMA_REGISTERED=true`を設定します。`metadata`を`settings`配下へ置くとSlackはschemaを登録せず、投稿時にmetadataをwarning付きで破棄します。未設定または`false`ではAdapterは`update_notification_protocol`をversion healthへ公開せず、Updaterはterminal完了を確定しません。schema登録とscope付与を確認せずにこの値だけを有効化してはいけません。

`get_file`は、テキスト系ファイルを最大1 MiBで本文として返します。JPEG、PNG、GIF、WebPは最大5 MiBでMCPのimage contentとして返し、大きな画像ではSlackの縮小画像を使用します。その他のバイナリは安全なメタデータとSlack permalinkだけを返します。`url_private`とBot tokenはエージェントへ渡しません。イベントに添付されたファイルは、private URLを除いた`file_id`などの最小情報だけがEvent Envelopeへ入ります。

ビルド後、リポジトリの[`.codex/config.toml`](../../.codex/config.toml)が、Donaプロジェクトで起動したCodexへstdio MCPを追加します。

```sh
npm run build
cd ../..
codex mcp list
```

設定では読み取りツールをそのまま使え、`set_agent_session_status`、`post_message`、`add_reaction`は実行前に承認対象となる`default_tools_approval_mode = "writes"`を指定しています。既に起動している`dona-main`へ反映するには、そのCodexエージェントを再起動してください。Codexのproject-scoped `.codex/config.toml` とstdio MCP設定については[OpenAI公式ドキュメント](https://developers.openai.com/codex/mcp)も参照できます。

MCPだけを手動で起動するデバッグ用コマンドもありますが、通常はCodexに起動させます。

```sh
npm run dev:mcp
```

## ACK・再接続・ログ

- Dispatcherの`200`（重複）または`202`（新規永続化）でだけACKします。
- Dispatcher接続失敗、timeout、4xx、5xxではACKしません。
- ACK直前にWebSocketが切れた場合は、再配信された内側の同じ`event_id`をDispatcherのunique制約が吸収します。
- SDKのheartbeatを使用し、切断・`warning`・`refresh_requested`後は1/2/5/10/30秒を基準にjitter付きで再接続します。
- 認証・token種別・scopeの恒久エラーは高速に再試行しません。
- graceful shutdownは処理中のDispatcher受付とACKを最大3秒待ってから切断します。
- typed `POST /v1/admin/quiesce`は新規Socket ingressを止め、in-flight Dispatcher POST/Slack ACKをbounded drainします。
- token、WebSocket URL、payload全文、本文は通常ログへ出しません。

## ローカルhealth check

外部TCP portではなく、Adapter専用UDSを使います。

```sh
curl --unix-socket "$HOME/Library/Application Support/Dona/run/slack-adapter.sock" \
  http://localhost/health/live

curl --unix-socket "$HOME/Library/Application Support/Dona/run/slack-adapter.sock" \
  http://localhost/health/ready

curl --unix-socket "$HOME/Library/Application Support/Dona/run/slack-adapter.sock" \
  http://localhost/health/version
```

readyは、設定したSocket Mode接続がすべて`connected`、Dispatcherの`/health/ready`が成功、停止処理中でない場合だけ`200`です。version healthはrelease manifest由来のbuild SHA、protocol 1、app schema 2、config 1、全workspace readinessを返し、metadata readinessをattestし、内部reporterと共有tokenを読み取れる場合だけ`update_notification_protocol: 1`を加えます。attestationがない場合は内部通知endpoint自体も503で拒否し、Slackへ書き込みません。secretやlocal private pathは返しません。

## 検証

```sh
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
```
