# ブラウザsession認証とlocal logout

`WebAuthController`は、browser requestの境界を既存のOIDC protocol・認証付きUDS client・共有監査repositoryへ接続する。以下の固定endpointだけを扱う。HTML/UIやTLS listenerは起動せず、job/approval操作は提供しない。

| endpoint | 検証と結果 |
| --- | --- |
| `GET /`、`GET /api/session` | online照合とDispatcher確認後にsafe principalとsession-bound CSRFを返す。`/`のHTML表示層は別途必要 |
| `POST /api/session/csrf` | 同じlocal cookie・binding・Origin・Fetch Metadataを照合し、CSRFだけを返す。IdP不要 |
| `POST /api/session/logout` | 同じlocal cookie・CSRFを検証し、一回のrevokeと失効read-backの後だけ204とcookie削除を返す |
| `POST /api/session/logout-status` | 同じlocal cookie・CSRFで現行の失効状態だけをread-onlyで確認する。失効確認済みならcookieを削除できる |

## 入力境界

Hostはconfigured originと完全一致させ、TLS/proxy検証済みであることを信頼できるlistenerから受け取る。request header/bodyのbooleanをtransport証明にしない。proxy/identity/Authorization header、同名cookieの重複、malformed cookie、未知pathを拒否する。

GETは空body、`Sec-Fetch-Site: same-origin`を要求し、Originがあればconfigured originと完全一致させる。POSTはexact Origin、same-origin Fetch Metadata、`application/json`の空objectだけを受け付ける。logout/statusはcustom CSRF headerも必要であり、client指定のprincipal/session参照を入力に使わない。

## online認証の順序

1. 保護storeの全保持versionのcookie keyからindexを導出し、authenticated readで現行sessionを取得する。欠落・重複・revoked keyで別versionへfallbackしない。
2. local registry/session/世代/期限を照合し、sealed payloadのdigest・owner binding・AEADを検証してaccess tokenをメモリ内で開く。
3. 固定OIDC introspectionを毎回実行し、raw subjectから全保持versionのHMAC indexを導出する。raw subject/tokenをresponseやdurable stateへ追加しない。
4. current principalとrevision・BFF世代を再読し、実requestのmethod/route/bodyへ結合した最大10秒のcontextを作る。
5. Dispatcherのsession transactionで現行registryとnonceを確認・監査確定した後だけ結果を返す。

request内では保護clockの巻戻りを拒否し、I/O後にも再読する。contextと最終成功の期限は10秒・session期限・online token期限の最小値。遅れた署名済み応答から期限後の成功を返さない。pollによるidle延長やpositive introspection cacheは行わない。

IdP inactiveでは`revoke_inactive`で失効・payload削除・拒否auditを同時に確定し、401を返す。IdP unavailableやkey不明は503。その他の拒否も固定reasonで監査へ接続し、監査が確認できなければ503とする。private principal/resourceは失敗responseへ含めない。

## local logoutと受理不明

local CSRF/statusは権限を付与するAPIではなく、同じcookieの現行状態だけを扱う。期限切れ・既失効sessionでもkeyとbindingを確認できれば、IdPを呼ばずlocal logoutできる。別cookie、見つからないsession、照合不能を成功ackに変換しない。

logoutは一回だけwriteし、signed成功後に同じcookie/sessionの失効とpayload削除をread-backする。writeまたはread-backが不明なら503とし、削除用Set-Cookieを送らない。mutation/session確認を一度試みた後に応答を失った場合、追加のdenial writeも行わない。後続のlogout-statusはread-onlyで照合し、失効が確認できた場合だけcookieを削除する。activeなら保持し、自動でlogoutを再POSTしない。

全responseはno-store・no-referrer・既存CSP等を使い、callback/token/cookieや詳細provider errorを転載しない。

## 検証と残る範囲

controller unit 11件に加え、`npm run test:web-integration`が実SQLite・共有監査・単一UDS・実BFF clientを接続する5件を実行する。結合testの型検査も同じcommandで行う。Web CIはWebとDispatcherの依存をinstallし、このcommandを実行する。ローカルでも両packageで`npm ci`が必要。`npm run verify:web`はWeb test/typecheck/buildと結合検証を含む。

IdPのHTTPS transport応答、clock/anchor、key、TLS listener分類はfixtureであり、実IdP・WebAuthn・browser・Keychain・productionのE2Eではない。login開始/callback、UI、TLS/proxy、operator provisioning、保護native broker、runtime/release接続と後続command/read/approval routeは残る。このcontrollerだけで#141やEpic全体を完了扱いしない。
