# 承認recordの固定aliasと一覧読取

`ApprovalRecordRepository.readAlias`と`readListHead`は、内部brokerが保存済みrecordへ到達するための読取componentである。各呼出しで共有監査の現在rootを取得し、そのscopeのmetadata・SQL record・親参照を同じ検証付き読取へ結合する。任意root、SQL条件、sort、transport identityを入力にしない。

## 固定alias

creation key、decision ID、consume/attempt、notification request/kind/message、event decision、presentation revision/message fenceという既存の固定selectorだけを受ける。selectorをcodecで検証し、alias targetのrecordと実際のselectorが一致することを確認する。存在するaliasが欠落recordや別recordを指す場合は失敗し、`null`にしない。

recordの全固定aliasとall/active membershipも照合する。presentationのmessage holderは`dispatching`または`acceptance_unknown`だけであり、解放後のtombstoneと未登録aliasは、同じtransactionで固定partial UNIQUE indexを使いSQLにholderが残っていないことも確認してから`null`を返す。SQL確認は不整合を拒否するためだけに使い、SQLをrootの代替にはしない。履歴aliasを解放したりone-shot IDを再利用したりする操作は追加しない。

## 内部一覧の先頭

既存のall/active listについて先頭から1〜4件を読み、manifest、head/tail、隣接link、truncated時の次linkを確認する。各recordをSQL/親参照/全固定aliasへ照合し、active一覧にterminal recordが混入していたら拒否する。結果はimmutableな`count`、`records`、`truncated`で、recordのcanonical bytes合計にも3 MiB上限を設ける。

`count`は監査されたmanifestの件数であり、`truncated: true`は一部取得を表す。このAPIは全件走査、pagination cursor、expiry sweepの進捗保証を提供しない。欠落rootや必要なmanifest、SQL/親参照の改変、pending anchor、不整合を空の一覧へ変換しない。読取だけで監査sequenceやstateを更新しない。

## 検証と残る接続

実SQLite/native guardとfixtureの共有監査を使い、7種recordのaliasとall/active、message fenceの引継ぎ・解放、4件上限とtruncated、再open、別scope、不正selector、SQL/親参照改変、pending anchorを検証する。署名されたmetadata自体が別recordのaliasやterminalのactive混入を含むfixtureでも、root照合だけでrecordを返さないことを確認する。

保存recordやsnapshotはprivateな内部データであり、このAPIの戻り値を認可せずWeb/Slackへ出さない。現在のactor/binding/visibility/TTLを判断するbroker、expiry sweep、payload削除、retention/GC、bootstrapと実provider/runtimeの接続は残る。#16やEpic #139をこの読取接続だけで完了扱いにしない。
