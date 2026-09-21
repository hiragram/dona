# Web loopback TLS listener

## 対応範囲

`WebLoopbackTlsListener`は#141の部分対応として、loopback/direct_tlsの固定policyを既存の公開ページ・ログイン・セッションcontrollerへ接続する。importではlistenせず、明示`start()`を一度だけ実行する。`close()`は同じPromiseを返し、終了後やbind失敗後に同じinstanceを再起動しない。

`private`/`internet`のproxy_udsはこのlistenerでは起動を拒否する。汎用handlerや任意proxyは追加しない。認証済み`GET /`は固定CSPのdashboard HTMLを返し、同一originの`/api/session`、principalに許可されたjob一覧・詳細・SSE・submit・cancel、local logoutだけを固定routeとして扱う。approval操作はこのdashboardの対応範囲に含めない。

## 証明書と保護時刻

固定policyのopaque `certificate_ref`/`private_key_ref`だけを、信頼された`WebTlsMaterialProvider`へ渡す。request、環境変数、raw pathから秘密鍵を取得しない。証明書は16 KiB、鍵は8 KiB以下のPEMに限定し、単一leaf、CAでないこと、serverAuth EKU、RSA 2048〜4096 bitまたはP-256/P-384、鍵の一致、SANとorigin名の一致、有効期間を確認する。CN fallbackやwildcardは認めない。

IP literalのoriginはbind先のIPとも一致させる。TLSは1.2以上でticketとrenegotiationを無効にし、固定contextを作成した後でこのcomponentが複製したPEM Bufferを消去する。provider所有BufferやOpenSSLが必要とする内部鍵を消去したと主張しない。start前後・controller実行前後で保護UTCを確認し、証明書期限外・不正時刻・逆行を検出すると受付を閉じる。

この構造検証は証明書の配備、クライアントのtrust、native providerの真正性を証明しない。runtimeは採用ADRの監査continuity、rollback-resistant anchor、保護clock、完全なkey inventory、audited BFF restart generation/read-back、IdP適合等を接続する必要がある。constructorにgenerationの数値を渡すだけでは、その起動条件を満たさない。

## HTTPと接続上限

loopbackのpolicy指定host/portだけでlistenする。port 0、別bind先へのfallback、自動bind retryはない。raw connectionとsecure socketはそれぞれ最大32本、未完了controllerは最大32件。handshakeは5秒、secure接続は10秒、raw接続全体は15秒で閉じる。タイマーを通信のたびに延長しない。

HTTP/1.1の1 socket/1 requestだけを処理し、keep-aliveを返さない。parserは16 KiB、raw headerは128組、bodyは64 byte以下。headerを黙って切り詰めず、duplicate Content-Length、chunked、過大length、Expect、Upgrade、CONNECT、pipelineを拒否する。本文を読み終えて上限を確認する前にcontrollerを呼ばない。raw targetをURL正規化する前に固定route表で照合する。

`transportVerified`は実TLSSocketからのみ生成し、Forwarded等のheaderを輸送経路の証拠にしない。Host/Origin/Fetch Metadata/cookie/CSRFはcontroller側でも検証する。callbackの複数Set-Cookieを配列のまま返す。HTTP応答はno-store/no-referrerを固定し、query、cookie、Referer、Authorization、鍵、raw errorをログへ出さない。TLS handshake失敗や送信不能時はHTTP本文を返せずsocketを閉じる。

socket切断・期限到達は、既に受理された監査mutationの取消を意味しない。未完了controllerの枠は実Promiseのsettleまで保持し、同じwriteを自動再実行しない。終了時も接続を閉じるだけで、既に受理された操作のrollbackや未実行を保証しない。

## 検証

合成証明書をNode clientの`ca`へ明示し、実TLSで公開ページ、認証済みdashboard、固定asset、拒否応答、曖昧HTTP、起動/終了、handshake/body期限、切断後のcontroller上限を確認する。実SQLite・native extension・共有監査repository・私有UDSへの結合テストでは、login rotation、local logout、principal-scoped job read・SSE・submit、曖昧cookie、session作成とwriteの応答喪失を検証する。自動pollやsession確認でactivityを更新しない既存境界を維持する。

fixtureのIdP fetch、保護鍵、anchor、clockは実providerではない。OSのtrust設定、実IdP、WebAuthn、production credential配備、稼働runtime起動は未検証であり、このPRでは操作しない。既存Playwrightテストはnetwork mockによるUI検証で、信頼済みbrowser TLSの証拠とは分ける。

参照: [Node HTTPS server](https://nodejs.org/api/https.html#httpscreateserveroptions-requestlistener)、[TLS context](https://nodejs.org/api/tls.html#tlscreatesecurecontextoptions)、[証明書と秘密鍵の照合](https://nodejs.org/api/crypto.html#x509checkprivatekeyprivatekey)。実装はprojectのNode最低versionで使えるAPIを使用する。
