# 使用済みtransaction IDの検証

`used-transactions.ts`は、保護されたrootを基準にtransaction IDの使用済み状態を検証し、新しいIDを追加するimmutable nodeのplanを作る。plan生成は予約の受理ではない。`ClockMarkStore`と`AuditAnchorStore`へ接続するproviderは、domain headとused-ID rootを同じDB外CASで更新する必要がある。

## 認証する範囲

scopeはinstance、audit/clockの用途、ledger世代を含む。scopeとrootは認証済みの保護providerから読み取る。外部requestや補助node storeから取得したrootをcurrent authorityとして採用しない。`emptyUsedTransactionRoot`はoperator provisioning時の計算補助であり、保護headの欠落や読取失敗から自動初期化するために使わない。ledger世代の変更で既存IDの一回性を解除する操作も、このmoduleは提供しない。

256-bit indexの各bitを上位から辿る固定深さのsparse treeを使う。leafには「使用済み」だけを記録し、削除・期限切れ・空の使用済み値は定義しない。empty nodeと、読取先にrecordがない状態を区別する。期待する位置のempty hashと一致した場合だけ未使用と判断し、missing・不正wire・hash/位置/scope不一致では停止する。

方式の参考は[TrillianのMapHashers資料](https://github.com/google/trillian/blob/5061cfc7eb9ada638e810414577deb6575d89eef/docs/MapHashers.md)の位置を含むhash戦略である。nodeの位置とempty/leafを区別する考え方を使うが、Dona固有のwireでありTrillianとの互換性はない。

## 固定wire

SHA-256を使用し、以下の文字列の末尾の`\0`は1 byteのNULとする。IDは1〜128文字のASCII英数字・underscore・hyphenに限定する。

- scope hash：`dona.used-transaction-scope.v1\0`と、NULで区切ったinstance ID・ledger ID・purpose。
- leaf index：`dona.used-transaction-key.v1\0`と、32 byteのscope hash、transaction ID。
- node digest：`dona.used-transaction-node.v1\0`と、node binary。

node binaryのheaderは67 byteで、型1 byte、scope hash 32 byte、depth 2 byteのbig endian、index prefix 32 byteを順に置く。prefixはdepthより後のbitを0にする。型はemptyがASCII `E`、使用済みleafが`L`、branchが`I`。depthはrootの0からleafの256までである。branchだけはheaderの後へ左と右のchild digestを各32 byte置く。両childがemptyであるbranchは拒否し、その位置のempty hashを使う。

補助storeとのwireはこのbinaryのcanonical base64。leafは67 byte、branchは131 byteで、base64は最大176文字。digestは小文字hex 64文字。empty nodeは保存せず、位置とscopeから計算する。nodeへraw transaction IDを保存しないが、IDの秘匿化や暗号化を保証するものではない。

## 永続化と失敗時の契約

1回の検証は最大257 nodeの同期読取、insert planは最大257 nodeで128 KiB未満となる。履歴全体のscanやnodeへの書込は行わない。readerは内部の同期・読取専用callbackであり、任意JavaScriptを隔離するsandboxではない。

provider側には、planのnodeをimmutableな補助storeへdurableに公開し、その全件を読み戻してから、expected rootとdomain headを同時にCASする工程が必要である。CAS前のorphan nodeは予約成功の証拠ではない。CAS応答が不明な場合は自動再試行せず、current protected headから照合する。rootだけ、またはdomain headだけを更新してはいけない。

補助storeを巻き戻すと、新しいprotected rootに必要なnodeが欠けるため検証できなくなる。古いrootを渡すと古い状態を正しく検証してしまうので、rootのfreshnessとrollback耐性は保護providerの責務である。保持期間を過ぎたaudit recordの削除を、used-ID leafの削除へ流用しない。nodeのGC・recovery・backup設計は、current rootから到達するnodeを失わない別の契約が必要である。

## 検証範囲

独立した再帰実装によるroot再計算、追加順序に依存しないroot、過去IDの再使用拒否、補助snapshotの巻戻し、経路上の全nodeの欠落・byte改変、scope変更、canonical wire、同期callback、読取とplan容量の上限をfixtureで検証する。

永続node storeと保護head CASとのadapterは[保護headと使用済みIDの接続](protected-head-adapters.md)を参照する。認証付きnative brokerとoperator provisioningは未接続であり、実Keychainやproductionでの予約・復旧の検証結果ではない。#16全体の完了条件は残る。
