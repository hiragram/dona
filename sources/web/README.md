# Web認証プロトコルの共通部品

[Issue #141](https://github.com/hiragram/dona/issues/141)の部分実装。[ADR 0002](../../docs/adr/0002-web-trust-boundary.md)に従い、固定deployment policy、cookie/Host/Origin/CSRFの検証、OIDC Authorization Code + PKCEとonline introspectionを実装する。

loopback TLS listener、login/session controller、認証済みUDS client、起動時のsession世代更新までを固定compositionとして接続する。runtimeが渡すprotected clock、credential/key inventory、TLS material、Dispatcher側の監査付きrepositoryを起動前後に照合し、不足時はlistenしない。package自身はcredentialや証明書をprovisionせず、実IdP・実保護store・production activationを検証済みとは扱わない。private/internet proxy modeは未接続のためstartupでfail closedする。

## Cookieとbrowser境界

session cookieは`__Host-dona_session`、Secure/HttpOnly/Strict/Path=/、login cookieは`__Host-dona_login`、Secure/HttpOnly/Lax/Path=/とする。256-bitのcanonical base64urlを要求し、同名cookieは同じ値でも拒否する。cookie headerのraw値を例外へ含めない。

Hostは設定originへ完全一致させ、forwarded/identity/bearer headerを本人性の根拠にしない。`transportVerified`はTLSまたは認証済みUDS serverが確定する内部値であり、browserのheader/bodyから渡してはいけない。CSRFは同じlocal sessionへ結合した期待値、exact Origin、same-origin Fetch Metadataを要求する。

cookie削除helperはdurable revokeとread-backに成功した後だけ呼ぶ。local logoutのIdP不要経路、cookie保持を伴う受理不明処理、publicなlogin完了案内への303と新しいdashboard navigationは、後続server/session実装が接続する。完了案内からsession確認や自動redirectをしてはいけない。

## OIDCの呼出契約

`createLogin`は5分のstate/nonce/verifierと固定authorization URLを作る。呼出側がlogin cookieへ結合し、共通監査付きのdurable保存へ確定してからbrowserへ返す。`exchange`の前には、同じcookie-bound transactionの一回限りconsumeをdurableに確定する。memory mapやこのclass自身を一回限りの正本に使わない。

固定token/JWKS/introspection endpoint以外を取得せず、redirect、未知/曖昧key、許可外algorithm、issuer/audience/azp/nonce/時刻の不一致を拒否する。issuer文字列を正規化して別identityへ変えない。JWTのrole/group/emailからDona権限を生成しない。access tokenは認証済みintrospectionでsubject/client/audience/expiryを再確認し、positive cacheを作らない。refresh token/offline accessは要求・保存しない。

各network callは3秒、応答はtoken/introspectionが32 KiB、JWKSが128 KiB、最大64 keysに制限する。例外は固定codeへredactし、自動再送しない。`exchange`の戻り値に含むtokenはBFF内部だけで扱い、暗号化session storeへ移し、log/HTML/Resultへ出さない。呼出側はnetwork処理後のprotected clockを再取得し、session確定・authorization context発行の直前にもexpiry/current revisionを確認する。

## Session tokenの保護

access tokenはAES-256-GCM、96-bit random nonce、128-bit tagでsealする。codec/key version、封印時刻、instance/tenant/principal、session参照と世代、identity/authz revision、発行時刻・期限を固定順序のAADへ結合する。認証tagが確認できるまで平文を返さず、一時的な平文Bufferは成功・失敗のどちらでも消去する。JavaScriptのstringやruntime内部memory全体の消去を保証するものではない。

暗号key、cookie検索HMAC key、CSRF keyは用途を分離し、key versionを結合する。active keyの新規利用は最大90日の有効期間内だけとし、verification-only keyは既存sessionの復号・照合に限る。新規session用と既存照合用のmodeを明示し、用途不一致・失効・未知key・短いkeyを拒否する。key materialはprotected providerから取得する契約で、このpackageは実credentialを作成しない。

cookieそのものは保存せず、version付きのkeyed digestでlookupする。session絶対期限とaccess token期限はseal済みbindingの期限へ反映する。idle 30分とcurrent revocationは後続repositoryが別途検証し、SSE/pollをactivityへ数えない。CSRFの既存値は期限後も同じcookie-bound sessionのlocal logout向けに再構成できるが、他resourceへの認可には使わない。

## 後続routeへ渡す認可境界

固定route表はcommand、read/SSE、approvalを同じprincipal filterへ結ぶ。Dispatcherは署名済みcontextをcurrent session・registry・BFF generationと同じ監査transactionで再検証し、routeごとのrole/scope、POSTのCSRF確認、approval decisionの独立step-up確認をすべて満たす場合だけprincipalを返す。user commandだけがidle activityを進め、自動pollとSSEは進めない。

この判定はresource capabilityそのものではない。job owner、明示grant、supervisor binding、typed action hash、receipt、cursorなどのresource predicateは、#142・#143・#145の各authoritative repositoryが同じoperation transactionで追加検証する。Web login、scope所持、context tokenだけでresourceの存在や操作権限を与えない。

## 検証と残る作業

架空IdP responseと一時署名keyで、claim/署名/key不一致、期限、cookie重複、Origin/CSRF、provider outage、timeout、response上限、introspectionの再取得を検証する。このfixtureは実providerやbrowserでの認証完了の証拠ではない。

fixtureではsession rotation・durable revoke・restart失効、subject tombstone/key lifecycle、Dispatcherのcurrent revision照合、one-use context、監査付きcommit、TLS/UDS/startup gate、browser login/logoutを検証する。実IdP、実credential/protected store、proxy deployment、production activationは未検証であり、package単体のtestをlive deployment証拠にはしない。

参考: [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)、[RFC 7662](https://www.rfc-editor.org/info/rfc7662/)、[jose](https://github.com/panva/jose)。

## Subject索引の準備

`identity-index` はversion付きlength-prefix encodingと用途別HMACでexact issuer/subjectを索引化する。現行keyだけで新indexを作り、旧keyはlookup専用とする。保護store由来の完全なinventoryに対して全versionを検証し、一つでも欠落・revoked・用途不一致なら新規index作成も拒否する。最大1024 versionを越える場合も自動で旧versionを捨てず拒否する。

同じprincipalに結ぶ複数versionの一致は許し、複数principalや同versionの重複rowは拒否する。この関数だけではregistryの完全性・現在性やinventoryの正当性を証明しない。後続の監査付きrepositoryで、同一の検証済みsnapshot内の全version lookup、同じprincipalとquota/revoke履歴の継承、raw subject削除とtombstone保存を原子的に実装する。ここではprincipalや実keyを作成しない。

OIDCのexchangeとinspectは、保護時計を都度再読するcallbackを必須とする。通信後の時刻でiat/expを検証し、通信中の発行・失効・時計巻戻りを判定する。client時刻や未検証wall clockへfallbackせず、最終のdurable認可gateでも再確認する。

login transactionのstate・nonce・PKCE verifierはweb_login_transaction専用keyで暗号化し、cookie keyed digestとそのkey version、instance/tenant、login ref、BFF generation、5分の期限へbindする。serverは監査付きtransactionで一回消費と保存secret削除を確定してから復号・token交換する。暗号化helper自体はreplayを防がず、durable consumeを代替しない。受理不明をtoken交換の再試行へ流さない。

Web session・固定route・ingress contextの追加契約は [運用文書](../../docs/operations/web-session-contracts.md) を参照する。監査付き保存・実listenerへの接続は後続であり、このpackageだけで認可を完了しない。
