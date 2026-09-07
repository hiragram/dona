# GitHub App webhook pilot 運用手順

Issue #52 の pilot は、所有を確認した単一 repository と `issues.opened` のように明示した event/action だけを受け付ける。共通 ingress の endpoint は `POST /v1/ingress/github` で、public proxy は request body を変更せず Unix socket へ渡す。

## GitHub App の最小権限

- Repository access は pilot 対象の 1 repository のみにする。
- Repository permissions は `Metadata: Read-only` と、購読 event に不可欠な read permission だけにする。`Contents`、`Issues`、`Pull requests` などの write permission は付けない。
- Webhook events は実装時に connection allowlist へ登録した event/action だけを選ぶ。
- webhook secret、App private key、installation token は Keychain 等の secret store に置く。DB、設定ファイル、log、Event Envelope、Result には値を保存せず、`credentialRef` と revision だけを保存する。

起動時は `DONA_GITHUB_PILOT_CONFIG` に `connectionId`、`installationId`、repository numeric ID、`owner/name`、event/action allowlist、owner-only mode の `webhookSecretPath` を JSON で設定する。`dona-dispatcher serve` は DB から current connection revision / credential revision / active subscription generation を解決して `ExternalIngressRegistry` へ登録する。registration は受信開始から 9.5 秒の単一 deadline 内で raw bytes の署名検証後にだけ JSON を解析し、installation/repository identity と allowlist が一致した場合だけ durable enqueue する。

## ACK と障害境界

- GitHub の delivery ID は `X-GitHub-Delivery` を使う。同じ connection の同一 delivery は同じ永続 event に収束し、payload が異なる場合は `409 duplicate_conflict` として隔離する。
- Dispatcher の commit receipt が得られ、9.5 秒の processing budget 内に ACK を構築できた場合だけ `202` を返す。署名/allowlist/JSON failure、queue/DB failure、timeout、commit acceptance unknown では 2xx を返さない。
- response loss や socket 切断の後に redelivery API を自動実行しない。GitHub delivery UI の delivery ID と Dispatcher の source `github` の receipt を read-only で照合し、人間が再配送の要否を決める。
- installation API の追加 fetch は `GitHubReadOnlyInstallationClient` を使い、固定した repository の `GET` のみに限定する。403/404/429/5xx と token expiry は delivery 未受信として扱わず、write や自動 retry に切り替えない。

## 実環境での動作確認（手動 gate）

1. test GitHub App の permissions と対象 repository が上記の最小集合であることを GitHub App settings で再確認する。
2. 隔離した HTTPS proxy と Dispatcher を起動し、許可した event を 1 件発生させる。
3. delivery UI の ID、HTTP `202`、Dispatcher の `github` event/receipt、trigger Result を照合する。
4. 同じ delivery を再配送して `duplicate_same` と 1 row を確認する。改変 payload の自動生成や production write event は行わない。
5. 意図的な failed delivery は delivery UI と receipt の不一致を read-only で確認するに留め、再配送は人間が明示判断する。

この repository の automated test は fake delivery、fake installation API、temporary SQLite を使い、実 GitHub App の installation、公開 HTTPS、delivery UI、production credential は検証しない。
