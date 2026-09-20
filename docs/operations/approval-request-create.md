# 承認request作成と通知outbox

`ApprovalCreateBroker`は、既存のrecord/payload保存とclock履歴を使う内部作成componentである。requestを`delivery_pending`として保存し、`approval_card`と`pending_notice`をそれぞれ一件の`pending` notificationとして同時作成する。外部送信、decision、consume、action executionは行わない。

## 現在の認証済みsourceが前提

constructorに渡す`ApprovalCreateAuthority`はtrusted runtime専用の同期read-only依存である。引数の`VerifiedAuditState`を共有repositoryの`readInState`へ渡すことで、作成と同じ検証済みtransaction内でbinding/sourceを照合できる。このstateは同期callback内だけ有効であり、cloneや保存後の再利用を認めない。認証済みtransport connectionと保存済みsource owner・stable operation slotに結び付き、current binding、policy、requesterの権限、supervisor visibility、shared状態、exact draftの安全な開示を都度検証してからgrantを返す必要がある。`source_ref`やevent/job IDを知っているだけではgrantを返してはいけない。本文中のactorやsupervisor、任意callbackをこの依存へ転用しない。

本PRはその実adapterを提供しない。fixtureのgrantをproduction providerとするdefaultや公開APIは作らず、実source/bindingの認証経路が接続されるまでruntimeで有効化しない。secretやprivate download URLを含まないこと、exact draft・target・通知対象を安全に表示できることもauthorityの必要条件であり、単なる文字列の形式検査で保証したことにしない。

caller入力は`source_ref`、stable slot、typed target、本文だけである。actor、supervisor、policy、state、MAC、key versionを受け取らない。grantはpassive dataとしてclone・freezeし、固定instance/workspace、exact target、slotへ照合する。本文はこの作成経路では最大3000 UTF-16 code unitとし、不正UTF-8、`<!...>`構文、allowlist外の明示user mentionを拒否する。通知対象の表示は本文から得た一意user ID集合と一致させる。

Slackでは自動解析の抑止とmanual mentionの扱いが別である。実adapterでは`plain_text`、fallback、unfurl、threadなどの固定wireを検証する必要がある。このcomponentの文字列検査をSlack表示の実証として扱わない。[Slack公式のformatting仕様](https://docs.slack.dev/messaging/formatting-message-text/)、[text object仕様](https://docs.slack.dev/reference/block-kit/composition-objects/text-object/)

## 重複確認から保存まで

最初に、serverが解決したsource contextから既存codecと同じcreation keyを導出する。key自体はowner認可ではない。既存requestがあれば保存済みsource ownerを照合し、そのcontent MAC・key version・作成時刻を使って本文を旧検証鍵で確認する。現在active keyで新MACを作って比較しないため、鍵rotationだけで別依頼にならない。

有効な本文の不一致と、target/policy/precondition/bindingの不一致は、既存状態を変えず監査済み`idempotency_conflict`へする。owner不一致は`unauthorized`とし、いずれも既存handleを返さない。失効・不正なkeyは通常conflictへ変換せず処理を失敗させる。model versionだけが変わった場合は、既存requestと保存済みmodel versionを維持する。

完全一致のduplicateは同じhandle・保存状態・expiryだけを返し、再暗号化や通知追加をしない。これによって期限や外部実行権限を延長したことにはならない。expiry sweep、配送前の再認可、decision/consumeの期限判定は別途接続する。

新規requestだけにCSPRNGのopaque IDを割り当てる。request TTLは15分、暗号化request payloadの上限は追加consume時間を含め20分とし、本文は短期ciphertextだけへ保存する。content、wrapping、notification markerは用途とkey materialを分離する。record、二つのnotification、payload、clock履歴のrootを一つの共有監査transactionへcommitする。戻り値に本文、MAC、snapshot、policy、supervisorやkey情報を含めない。

## 通知marker

`notification-marker` codecはinstance/workspace、request ID、notification attempt ID、kind、semantic hash、作成時刻、key versionへHMAC-SHA-256を結合する。専用用途の32-byte keyを使い、signing期間は最大90日。旧keyはverification-onlyなら既存markerの確認に使えるが、新規署名には使わない。失効keyは拒否する。

marker署名だけは認可ではない。adapterは認証済みapp author、exact message、保存済みnotification/request、現在のscopeを別途照合する必要がある。実際のmarker wireや投稿・reconcile workerは後続作業である。

## 検証と残る接続

fixtureではatomic create、二つのpending outbox、reopen、鍵rotation後のduplicate、本文・policy・owner不一致、authority拒否、mention制約、key失効、SQL/anchor障害を検証する。通知markerはPython標準HMACで独立算出した値と照合する。受理不明のwriteを自動再実行せず、finalize後の応答喪失はread-onlyでdurable recordを確認する。

実authority/key provider、二者operatorのbinding/root admission、公開API、delivery worker、decision/consume/execution、expiry/retentionと実IdP/WebAuthnは継続作業である。#16全体やEpicの完了、production activationの証拠にはしない。
