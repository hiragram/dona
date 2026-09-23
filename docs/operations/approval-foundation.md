# 承認domain・保護clock・snapshotの共通部品

[#16](https://github.com/hiragram/dona/issues/16)の部分実装。承認ADRの[参照版](https://github.com/hiragram/dona/blob/0c4a1a451cbeb6962da1d49033948e6fd0f57c46/docs/adr/0001-supervisor-approval.md)と、これを優先する採用済み[Web ADR](../adr/0002-web-trust-boundary.md)に基づく。#15の採用・担当を変更せず、採用版が変われば整合性を再reviewする。

## domain

request、decision、delivery attempt、execution attemptを区別する。stateの遷移関数は認可を実行せず、外部writeやDB更新もしない。後続repositoryはpersisted identity、snapshot、binding/policy revision、期限、presentationを再検証し、共通auditと同じtransactionで結果を適用する。

- approve/rejectはrequestとdeliveryがともにsentのpresentationだけに適用する。先着decision後は別decisionで上書きしない。
- approvedは実行結果ではない。consume、承認後取消、consume期限切れは別遷移で競合する。
- cancel/expire/invalidation済みrequestは、遅れて配送成功が確認されてもsentへ戻さない。未送信pendingはabortedにする。
- 復旧したdispatching/executingは受理不明とし、再送可能な状態へ戻さない。経過時間を証明できないclaimed/unknownはneeds_reviewとpayload削除へ進める。

## clock

clock sourceは認証済みboot ID、suspendを含むcontinuous clock、UTCを提供する。process再起動後も同じbootとcontinuous値を検証できる場合だけ、UTCとcontinuous経過の大きい方を使う。`Date.now`やprocess開始からのelapsedだけを跨プロセスの証拠にしない。

DB transactionの前に、DB/backup外の保護storeへ直前markと候補markを一回限りのtransaction IDでCAS reserveする。CAS競合・応答喪失・read-back不一致ではDB処理を始めず、自動再送しない。commitされなかったreservationも取消・再利用せず、high-water markを巻き戻さない。

boot変更、continuous巻戻り、wallが保存markより前、固定local policyのdrift上限超過、unknown codec、取得不能はfail closed。request TTLは15分、consume TTLは5分で、期限ちょうどからexpired。既存requestの期限を再生成して延長しない。復旧時の判定はrepositoryがpayload削除・auditとtransactionalに適用する。

## snapshot

MVPの`slack.post_thread_reply.v1`だけをclosedなschemaで保存する。source/ownerは認証済みeventまたは永続job ownerから導出したserver contextへ完全一致させる。codecはcontextの出所を認証せず、gatewayやtransportの本人確認を代替しない。

UTF-8のcanonical JSONはfield名を辞書順とし、threadの完全なmessage集合と順序、content HMAC、policy/binding/requester revision、mention allowlistをsemantic hashへ含める。encrypted payload参照だけをhashから除き、payload allocation前のcreation key lookupを可能にする。source/operation slotが同じでもsemantic hashが変われば、後続repositoryは既存requestを書き換えずconflictにする。

unknown field/version/operation、raw本文、private URL、broadcast/shared channel、重複・順序不正のmention、thread root不一致を拒否する。保存bytesはcanonical形式だけとし、重複JSON keyや余分な空白を含む別serializationをdecodeで拒否する。返すsnapshotはdeep freezeした独立copyで、後から書き換えない。

このschemaはcodec version 1、thread最大1000件、canonical bytes最大256 KiBに限定する。上限超過時は不完全なsnapshotへ切り詰めず拒否する。operation gatewayのcurrent visibility、root/reply全page取得、HMAC検証、payload暗号化と送信直前の再検証は後続接続の責務である。

## 未接続範囲

これらはpure domainとprovider portであり、実clock/credential storeを捏造しない。実provider、request/decision/consumeのSQLite正本、binding、typed outbox、service/API、executor、awaiting/resumeの接続と競合・restart E2Eは別途必要。ここでのfixture成功を実IdP/WebAuthn/browser/productionやIssue全体の完了とは扱わない。
