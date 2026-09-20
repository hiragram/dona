# Web login開始とcallbackの接続

`WebLoginController`は、same-originのprelogin CSRFからOIDC callbackまでを、認証付きUDSと共有監査repositoryへ接続する。constructorのBFF世代は、runtimeがdurable restartとread-backを完了して得た値を渡す。controller自体はそのgateを初期化せず、principal登録や起動時の復旧判断も行わない。

## 固定endpoint

| endpoint | 入力と結果 |
| --- | --- |
| `POST /api/login/csrf` | exact Origin・same-origin Fetch Metadata・空JSON objectを要求し、短命のprelogin cookieとCSRF tokenを返す |
| `POST /api/login/start` | 同じprelogin cookieとcustom CSRF headerを一回消費し、共有repositoryのlogin作成を確定してから固定IdPのauthorization URLとLax login cookieを返す |
| `GET /oidc/callback` | cookieに結ばれたloginをdurableに一回消費してからcode交換とsession作成を行う。成功後だけStrict session cookieを発行し、固定の`/login/complete`へ303する |

Host、検証済みtransport、identity/proxy header拒否、同名cookieの重複・malformed cookie拒否を全endpointで適用する。callback以外はqueryを許可しない。callbackは専用parserでstate/code/issuer等を検証し、providerの自由記述errorやqueryをresponse/logへ転載しない。

`/login`とpublicな`/login/complete`のHTMLは[public表示層](web-public-pages.md)が扱う。dashboardのHTMLとTLS listenerでのroutingはこのcontrollerに含めない。完了案内は別のpublic表示層で、session lookup・bootstrap・自動redirectをせず、固定dashboard linkを利用者が選ぶ新しいnavigationを提供する必要がある。callbackからの303にもno-referrerを付ける。

## prelogin CSRFの範囲

`PreloginCsrf`はprocess-localの準備状態であり、認証・OIDC login・監査の正本ではない。256-bit randomのcookieとCSRFを生成し、保持するのはcookie keyed digest、CSRFのdomain-separated digest、key version、5分の保護期限のみ。最大512件で、上限時は新しい発行を拒否する。

cookieは`__Host-dona_prelogin`、Secure・HttpOnly・SameSite=Strict・Path=/・Domainなし。CSRFはsame-origin responseから取得し、login開始のcustom headerに付ける。全保持cookie keyを照合し、欠落・重複・revoked keyで別versionへfallbackしない。消費はexact cookie/CSRF照合後、共有login作成の前に行う。process restart、世代変更、時計巻戻りで旧準備を復元しない。CSRFだけでOIDC交換やprincipal権限を許可しない。

## durable loginとsessionの順序

1. 既存OIDC protocolがstate・nonce・PKCE verifierを生成する。固定issuer/client/redirectのcode flowだけを使う。
2. login_ref・cookie digest・BFF世代・5分期限に結んだAEAD payloadを共有repositoryへ保存する。現在のbrowser sessionがあれば、全保持cookie keyから照合した旧sessionをloginへ関連付ける。直接DBへwriteしない。
3. callbackでmatching loginを一回消費し、共有payloadを削除したreceiptを受け取ってから復号・code交換する。state/nonce/署名claimと毎回のonline introspectionを既存OIDC protocolで検証する。
4. raw subjectから全保持versionのHMAC indexを作り、現行の登録済みprincipalだけを照合する。email/group、IdP role、初回loginからlocal権限を作らない。
5. active purpose keyで新しいsession cookie・CSRF binding・暗号化access tokenを構築する。期限は8時間とtoken期限の最小値。
6. 同じ最大10秒のreceiptを使ってsession作成を確定する。shared transactionが旧sessionを失効し、receiptを消費する。current世代・principal revision・全subject indexの再検証はDispatcherが行う。
7. 確定した署名済み応答と保護期限を確認した後だけcookieを返す。旧login cookieは削除し、queryのない固定完了案内へ303する。

保護clockは全I/O後に再読し、巻戻りや無効値が一度発生したcontrollerをそのまま復旧させない。consume開始から10秒を超えたIdP応答やsession作成応答で成功を返さず、receipt期限を延長しない。明示的な新しいloginが必要になる。

## 受理不明と拒否

consume/createのwriteを試みた後に応答が不明なら503とし、新しいtransaction IDでの自動再write、追加のdenial write、session cookie発行をしない。既知のconsume成功後にOIDCやprincipal照合が拒否された場合は、拒否監査を一回確定する。成功済みlogin/sessionを推測して同じcallbackを再実行しない。

全responseはno-store・no-referrer。controllerが返すauthorization URLは固定OIDC protocolが構成したものだけであり、browser指定のreturn URLを採用しない。生のtoken/state/nonce/verifier、cookie、subject、provider errorをauditへ保存しない。

## 検証と残る範囲

`npm run verify:web`でWeb unitと型検査に加え、実SQLite・共有監査・UDS・BFF clientを接続した結合testを実行する。loginの結合testは署名JWTを作り、実OIDCのcode/PKCE/nonce/online検証を通す。prelogin/callback再送、wrong state/nonce、未登録subject、inactive、consume/session応答喪失、10秒期限、旧session rotationを検証する。

HTTPS fetch応答、保護clock/anchor/key、TLS分類はfixtureであり、実IdP・browser・WebAuthn・Keychainやproductionの動作証拠ではない。public表示層のbrowser fixtureとは別に、TLS/proxy listenerとの統合と実IdP/browser、local二者provisioning、保護native broker、runtime/release接続、明示activityとidle更新、後続read/command/approval routeは引き続き必要。この接続だけでIssue #141やEpic #139を完了扱いしない。
