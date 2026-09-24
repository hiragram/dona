# 無効なJob Resultのoperator解決

通常jobのResultが検証に失敗した場合、Dispatcherは`needs_review`へ隔離する。実作業や外部操作が済んでいる可能性があるため、同じjobを再投入しない。

1. `job show <job_id> --live-session`で最新のreceiptを取得する。`not_addressable`はworker停止の証明ではない。利用できる運用手段でworkerの終了を別途確認する。
2. 既存branch、Pull Request、Issue、外部操作の証跡を照合し、未記録の副作用と残作業を確認する。
3. 確認できた場合だけ、表示された`receipt_id`とjobの`updated_at`を使い、`job resolve-invalid-result <job_id> <receipt_id> <expected_updated_at> --worker-stopped-reviewed --side-effects-reviewed`を実行する。これは旧jobを`failed`へ確定する操作で、Resultの修復、再実行、Project担当の変更は行わない。
4. `job show <job_id>`で`failed`と`invalid_result_operator_resolved`を再読する。Projectの担当引継ぎは、既存成果と明示指示を確認してからIssue lifecycle手順に従って別途行う。

状態、最新receipt、Result有無、更新時刻が一致しなければ操作は失敗する。worker停止または副作用を確認できない場合は`needs_review`を維持する。schedule所有jobは専用のreconciliation経路を使用する。
