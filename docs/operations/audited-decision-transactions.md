# 監査付き業務更新の事前判定

#16 の repository 接続に向け、共通監査へ次の内部境界を追加する。runtime への公開や新しい認可経路は追加しない。

`AuditRepository.appendPrepared` は SQLite writer lock の下で現在状態を読み、監査結果と更新計画を決めてから DB 外 anchor を予約する。重複・期限切れ・revision 不一致などの通常結果は、明示した監査結果と更新計画として返す。予約後の SQL 障害・commit 障害・finalize 応答喪失では、従来どおり fail closed とし、予約を自動取消・再送しない。

`ApprovalTransaction.runPrepared` は clock 予約前から finalize 後までの process 間 lock を維持し、確定する監査結果と同じ transaction に clock 参照を保存する。事前判定が失敗した場合、clock の high-water mark は戻さず、audit anchor は予約しない。

`AuditRepository.readVerified` は SQLite の同じ read snapshot で chain を前後検証する。検証中に peer が commit して外部 anchor が進んだ場合、古い snapshot の結果を返さない。callback は信頼済み repository の同期読み取り専用であり、任意 code の sandbox ではない。`query_only` を設定してnative SQLite authorizerの下でcallbackを実行し、transaction切替とpragma変更を実行前に拒否する。prepare済みwriteも再評価し、変更件数を照合する。callback から transaction 制御、pragma 変更、別 connection 更新、外部通信、非同期処理を行わない。

監査 record v2 は必須の `resource_digest` と非 null の `resource_id` を署名対象へ追加する。v1 と v2 の混在 chain を検証し、未知 version、digest 改変、v1 への差し替えを拒否する。digest は信頼済み repository が作る canonical な業務 metadata の照合用であり、本文・token・private URL を渡さない。署名だけで業務 table との一致を保証するものではない。後続 repository が保存前後の metadata と照合して初めて改変検知へ使える。

request/decision/consume の公開 API、業務 metadata の照合、payload の暗号化・同一 transaction 内の移送と削除・backup 除外、実 provider、runtime migration は引き続き後続実装とする。#16 の whole completion を主張しない。

同じsnapshotのmetadata digest照合とretention後の根拠保持は [状態digestとcheckpoint](audited-resource-checkpoints.md) を参照する。
