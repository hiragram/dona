# 承認payloadのSQL保存と共有監査root

Issue #16の内部保存component。`ApprovalPayloadSql`、`ApprovalPayloadRepository`、`ApprovalPayloadMutation`を既存の保護SQLite接続と共有`ApprovalTransaction`へ接続する。broker、外部transport、key providerのprovisionやproduction起動は追加しない。

## 読取と復旧の区別

固定SQLは各fieldをbyte上限付きで読み、canonical bindingとcolumn・scopeを照合する。repositoryは共有audit v3のcurrent resource binding `approval_payloads`を一つだけ取得し、`approval_payloads_v1` treeのowner keyとSQL metadataのdigestを比較する。root欠落、別scope、SQLだけの変更を空結果や新しい空rootへ変換しない。

`inspect`は暗号文を復号しない。`secret.status`の意味は次のとおり。

- `present`: canonical envelopeと保存済みdigestが一致する。HMAC/GCM認証・現在のowner認可・TTLの成功は意味しない。
- `missing`: 認証されたactive metadataに対応するsecretが欠落している。
- `invalid`: secretが過大・非canonical・不正形式、またはdigest不一致。暗号文を返さない。
- `deleted`: 認証されたtombstoneにsecretが残っていない。削除済みなのにsecretが存在すれば読取全体を拒否する。

missing/invalidを本文の取得成功にせず、上位の復旧処理がrecordを`needs_review`へ固定するとき、同じtransactionでmetadataを削除済みにしsecretを除去できる。欠落本文の再生成・自動再送は提供しない。metadata/root自体が壊れた場合の再構築も行わない。

## 保存と監査

payload mutationは最大2変更を受け付け、新規active payloadの挿入、または既存active payloadの削除済み遷移だけを準備する。owner・ref・binding・envelope digestの差替え、削除済みslot/refの再利用、重複owner/refを拒否する。作成・seal・削除時刻は現在の保護clock markへ結合する。

準備ではSQL expected値とcurrent root leafを照合し、最大2つのpoint更新を計算する。実行時は同じ保護clock transactionのmutation phaseを確認し、SQL・tree nodeを保存してから新rootのpointを再読する。返すcommitmentは共有auditの一要素であり、独自のaudit sequenceやanchorを持たない。

record mutationと合成する場合は、両componentのcommitmentを共有codecのscope/resource順に並べ、一つの`runPrepared`へ渡す。同じscopeでは`approval_payloads`、`approval_records`の順になる。mutation closureは親recordの保存後にpayloadを保存する。consumeではrequestの削除とattemptの別binding/別暗号文の挿入を同じpayload planへ入れる。成功を返すのは既存frameworkが監査anchorのfinalizeを確認した後だけである。

prepared closureを通常のSQLite transaction、clock phase外、別clock transactionへ持ち出して使うことを共通`assertActiveClockMutation`で拒否する。既存record mutationも同じguardを使う。一つのclosureは一度しか実行しない。任意のJavaScriptをsandbox化する仕組みではなく、SQL component自体はactor認可を与えない。

## 上位に残る責務

brokerは、認証されたowner record graph、snapshotの本文MAC/ref、current binding/actor/visibility、request/consume/attemptのTTLとboot継続性、HMAC/GCMを検証してから保存componentを呼ぶ必要がある。今回のrepositoryはpayload metadataの認証を担当し、owner recordの現在の操作可能性を単独で証明しない。fixtureでrecordとpayloadを同時更新できても、productionのdecision/consume endpointが完成したことにはならない。

rootの初期化・operator admission、metadata-only export/restore、expiry/recovery sweepの対象列挙、retention削除、provider/runtime接続は後続工程。backup境界は[保存schemaとbackup](approval-payload-storage.md)の制限を維持する。

## 検証

fixtureでrequest作成、consumeの再暗号化と旧payload削除、期限後の`needs_review`と削除、再open、missing/invalid/過大secret、SQLだけの変更、復活secret、node書込失敗、audit reserve/finalize応答喪失を検証する。prepared closureの通常transaction・clock phase外・別transactionへの持ち出しと二重実行、stale metadata、重複slot/refも拒否する。fixtureのanchorとclock providerを用いた検証であり、実credentialやproduction activationの証拠ではない。
