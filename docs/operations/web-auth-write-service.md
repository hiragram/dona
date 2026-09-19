# BFFのlogin・session lifecycle接続

`WebAuthWriteService`と`WebAuthWriteClient`は、認証済みBFFの固定lifecycle操作を共有`WebAuthRepository`へ接続する。DB/監査への直接write、registry登録、role変更、job/approval実行をBFFへ公開しない。ブラウザ向けcontrollerやruntimeの起動は、このmoduleのimportでは行わない。

## 固定operation

endpointは`POST /v1/web/auth/write`、Hostは`dona-web-auth-write`。入力はcodec version 1と次のoperationに限定する。

| operation | 保持する境界 |
| --- | --- |
| `restart` | expected BFF generationを同じ監査transactionで照合してから世代を進める。遅れたstartup要求で新世代を失効させない |
| `create_login` | sealed loginとcookie indexを保存し、旧session参照をrepository側で導出する。client指定の旧session参照を受け付けない |
| `consume_login` | 全必要versionのcookie indexから一意なloginを同一transaction内で選び、secret削除と一回限りreceiptを確定する |
| `create_session` | receipt、全保持versionのsubject index、現行registry・revision、sealed tokenを照合して保存する |
| `revoke_session` | 同じsessionとcookieだけをlocalに失効させる。IdPを呼ばず、既失効でも冪等に処理する |
| `revoke_inactive` | IdP inactive時のsession失効・payload削除・拒否auditを同時に確定する |
| `record_denial` | 限定された理由だけを拒否auditへ記録し、actorや権限をclient fieldから作らない |
| `expire` | 保護時計に従って既存の期限切れcleanupを監査transactionで行う |

初期化やoperator maintenanceの汎用APIは提供しない。`restart`は既存stateに対する操作であり、missing DB/headを初期化しない。

## 一回限りのtransaction

専用BFF credentialでscope、固定path・audience、body digest、nonce、key versionと最大10秒の期限を認証する。read/session確認APIとはMAC用途を分ける。body/responseは最大32 KiB、proofは最大2 KiB。owner-only UDS、接続/whole-body期限、固定header集合、scope/結果bindingの検証を使う。

serverは認証済みproof全体に対するdomain-separated SHA-256から`web_auth_`で始まるtransaction IDを導出する。これは権限の証明ではなく、認証後に共有clockへ渡す一回限りのIDである。requestの再送で別のrandom IDを割り当てない。`ClockMarkStore`は契約どおりDB外の保護headとdurableな使用済みID台帳を維持する必要があり、通常DBやmemoryで本番の一回性を代替しない。

同一proofは、直前の予約が未使用、DB rollback、commit後の応答喪失であっても自動再試行しない。新しいproofを使う場合も、既存のlogin/session IDや消費receiptの重複制約を回避できない。clock予約、audit reserve、DB commit、anchor finalize、response検証の各不明状態を成功へ丸めず、clientは再送しない。

## loginと結果のbinding

raw cookieをlogin参照IDとして保存しない。callback側はcookie indexを送り、repositoryが現在のloginを選択・消費する。未登録cookie、必要な鍵versionの不足、複数一致は拒否する。既存の5分loginと最大10秒の消費receiptを延長せず、secretのdurable削除とreceipt確定の後に返されたenvelopeだけをBFFが復号してcode exchangeする。

client/serverはoperationに対応する結果kind、世代、cookie binding、payload digest/owner bindingを検証する。消費receiptはそのrequest proofから導いたtransaction IDと一致しなければならない。期限を過ぎたlogin/sessionの作成・消費を、遅れて到着した成功応答から継続しない。

## 失効・拒否・logout

`revoke_inactive`はpayloadとsession nonceを削除してsessionを失効させ、`identity_invalid`の拒否auditを同時に確定する。応答も`denied`であり、認証成功へ変換しない。actorは未認証のまま、確認できたsession参照だけを記録する。`record_denial`もcaller指定actorを受け付けず、cookieを照合できた場合だけsession参照を残す。

`revoke_session`はlocal cookie bindingによる権限縮小の操作で、IdPは不要。ブラウザcontrollerは同じcookie、Origin、Fetch Metadata、CSRFを事前に検証し、durable revokeの成功と[読取API](web-auth-read-service.md)による失効read-backの後だけcookieを削除する。書込やread-backが不明なら503とし、削除用Set-Cookieを送らない。client自体はcookieを操作せず、同じPOSTを自動再送しない。

## 検証と残る実装

独立生成のHMAC/transaction ID fixture、実UDSと実SQLiteを使い、login作成・一回消費・session作成・拒否・失効・cleanup・restartを検証する。同じproofの即時/後続再送、stale generation、cookie不一致、reserve/finalize応答喪失、commit後のcredential失効、BFF clientのtimeout・改変・scope/receipt/世代不一致も確認する。OS保護headはfixtureであり、実Keychainやproductionの耐rollback検証ではない。

ブラウザcontrollerのHost/Origin/CSRF・callback・online照合、単一UDSへのgateway統合、TLS、保護provider、operator provisioning、runtime/release接続は残る。#141とEpic全体の完了を、この差分で主張しない。
