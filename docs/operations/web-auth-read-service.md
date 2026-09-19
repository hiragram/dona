# BFFのsession・registry読取

`WebAuthReadService`と`WebAuthReadClient`は、認証済みBFFがlogin/session確認の準備に使う専用UDSを提供する。Dispatcherの共有監査で検証した現在snapshotを読む。返却値は登録情報とsealed payloadであり、ブラウザの認証成功やjob・approval操作の許可へ変換しない。

## 固定operation

endpointは`POST /v1/web/auth/read`、Hostは`dona-web-auth-read`に固定する。bodyはcodec version 1と次のoperationだけを受け付ける。

| operation | 入力 | 返却値 |
| --- | --- | --- |
| `login_context` | 追加fieldなし | 現在のBFF世代と保持中のsubject index鍵version一覧 |
| `session_lookup` | 最大128件のcookie key version・digest | 一致するsession、principal、BFF世代、sealed payload。該当なしはnull |
| `principal_lookup` | 全保持versionのsubject index | 一致する既存principalとBFF世代。該当なしはnull |

raw cookie、raw subject、access token、任意のprincipal/role指定は入力に含めない。登録・世代更新・session作成・失効などのmutationは公開しない。

subject検索は、保持中の鍵一覧が空、入力versionが不足・余分・重複、複数principalに一致、未初期化または監査未検証の場合に停止する。現行registryで正当に失効したprincipalやsessionは、失効状態のまま返せる。失効を隠して別identityへfallbackしない。失効sessionのpayloadはnullとなる。

## 通信の認証

既存の`web_bff_service`専用credentialを使うが、session確認APIと異なるaudience、path、MAC用途`dona.web-auth-read.request.v1`/`response.v1`を使う。instance・tenant、key version、nonce、request body digest、request proof digest、発行時刻と最大10秒の期限をrequest/responseへ結合する。別operationの応答や別APIのproofは受け付けない。

bodyとresponseは最大32 KiB、request proofは最大2 KiB。canonical JSON/base64、全field、scopeを検証し、session応答では入力cookie indexとの一致とsealed payloadのdigest・owner bindingも確認する。これはAEAD復号やonline認証の代わりではない。

接続は同一ownerのcanonicalな0700親directoryと0600 socketに限定し、起動後もinodeと権限を再検証する。最大32接続、接続ごと1 request、最大5秒のwhole request/body期限、固定header集合を使う。chunked body、追加identity header、redirect、upgrade、CONNECT、期限超過、不明な応答は停止し、clientはcacheや自動再送を行わない。同期providerは期限内に戻る実装を要し、JavaScript timerで任意の同期callbackを強制停止できるとは扱わない。

読取にはmutationもnonce消費もないため、同一の有効requestを再読してもstate・監査・idle時刻を進めない。10秒以内の読取応答を後続の操作許可として再利用しない。外部responseやlogへsealed payload、index、proofを転載するAPIも提供しない。

## OIDCとの接続契約

durable sessionへraw subjectを保存しないため、`OidcProtocol.introspect`で得たsubjectをBFFのメモリ内で全保持versionのHMAC indexへ変換し、`principal_lookup`で現在のregistryへ照合する。sessionを確認する呼出元は、返却principalとsessionのidentity・revision・世代・expiryを一致させたうえで、freshなingress contextを作り、既存のsession確認APIを呼ぶ必要がある。groupsやemailからprincipalを割り当てない。

[RFC 7662のintrospection response](https://www.rfc-editor.org/rfc/rfc7662.html#section-2.2)の一般仕様では複数のmetadata fieldが任意だが、Donaの採用profileは`sub`、`client_id`、`aud`、`exp`を必須とする。`introspect`も固定client/audience・expiry・応答後の保護時計を検証し、結果をcacheしない。既存の`inspect`とcode exchangeは引き続き期待subjectとの完全一致を要求する。

## 検証と未接続範囲

Pythonの独立HMAC生成による共通wire fixture、Dispatcher側の実UDSと実SQLite、BFF側の独立署名fixture serverを使う。別API・別request・別operation・異なるtenant、cookie不一致、payload改変、鍵一覧の不足、曖昧なprincipal、失効・restart、socket変更、応答喪失とtimeoutを検証する。

この差分はread serviceとOIDC metadata取得までを実装する。ブラウザrequestを処理する認証controller、login/logout mutationのRPC、TLS listener、保護providerとruntime/releaseの接続は残る。実IdP・browser・Keychain・productionのE2Eを実行した証拠ではなく、#141を完了扱いにしない。
