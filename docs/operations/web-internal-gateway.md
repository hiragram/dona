# Web内部APIの単一UDS gateway

`WebInternalGateway`は、BFF policyの一つの`dispatcher_socket_path`へ4種類の固定protocolを接続する。読取・session確認・login/失効操作・job commandを同じowner-only socketで処理する。ブラウザ向けlistenerや任意URLへのproxyではない。

| protocol | 固定path | 固定Host | body上限 |
| --- | --- | --- | --- |
| [session確認](web-session-service.md) | `/v1/web/session/verify` | `dona-web-session` | 16 KiB |
| [認証準備の読取](web-auth-read-service.md) | `/v1/web/auth/read` | `dona-web-auth-read` | 32 KiB |
| [login・失効write](web-auth-write-service.md) | `/v1/web/auth/write` | `dona-web-auth-write` | 32 KiB |
| [job submit・cancel](web-command-api.md) | `/v1/web/command` | `dona-web-command` | 128 KiB |

pathとHostの組をserverの固定表から選び、各protocol固有のaudience・MAC domain・body/response bindingを検証する。別protocolのproofを転用できない。未知path、query、余分なheader、chunked body、upgrade、CONNECT、Expectを拒否する。routeやhandlerのcaller指定、外部への転送、汎用repository操作は受け付けない。

一つのlistenerが最大32接続を共有し、socketごとに1 request、whole request期限は最大5秒。parentはowner-only 0700、socketはowner-only 0600とし、実行時にもinodeと権限を照合する。scopeとrepositoryの設定が一致しない場合は起動しない。認証後・repository操作前・署名応答前にも接続期限とsocketを確認する。

repositoryの意味は各protocolで維持する。読取はcurrent verified snapshotだけを返し、session確認はnonceと監査を確定する。writeは認証済みproofから同じtransaction IDを導出し、共有保護clockの一回性を使う。未知のcommit状態を成功へ変換せず、自動再送しない。

既存の`WebSessionService`、`WebAuthReadService`、`WebAuthWriteService`も共通listener実装を使うが、それぞれの固定endpointだけを公開する。既存のconstructor契約とwireを維持し、専用serviceを起動しただけではgatewayの他endpointを有効にしない。BFFの4 clientはpathを変更せず同じsocketを指定できる。command request/responseも専用MAC domainとservice credential metadataを検証し、session ingressのcurrent principal認可を代替しない。

実UDS/SQLiteテストで4 protocolの連続利用、Host・proof取り違え、body上限、専用serviceの範囲、socket権限変更、監査commit不明、共通接続枠と未完requestの切断を確認する。保護clock/anchorはfixtureであり、実OS providerやproductionの検証ではない。

このmoduleのimportでlistenerは起動しない。runtimeは保護provider・credential・監査continuity・readinessを確立してから起動する必要がある。ブラウザcontroller、TLS/proxy、operator provisioning、native broker、runtime/release接続は残っており、#141の完了条件をこのgatewayだけで満たしたとは扱わない。
