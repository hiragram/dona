# 旧 `needs_review` job の停止下復旧 preflight

## 現在提供する機能

`dona-dispatcher job legacy-offline-preflight <new_private_backup_path>` は、Dispatcher DBを読み取り専用で開き、SQLite Online Backupを新しいowner-onlyディレクトリへ作る。backupを再度開き、schema v3、`integrity_check`、`foreign_key_check`、主要table件数を確認してから、`needs_review`の全jobを件数上限なしで列挙する。各final Resultは `O_NOFOLLOW` と1 MiB上限で読み、存在・schema妥当性・bytes SHA-256・file identityを記録する。通知とgroupの保存行もdigestに固定する。既存backupの上書きは拒否する。

この出力の`provisional_decision`は、Resultを受理できる形か、無効・欠落として扱う形かの**候補**である。現在のDB、Result、外部副作用、通知の確認結果ではない。preflightはworkerを停止せず、admissionを凍結せず、Herdrの完全inventoryも取得しない。常に`maintenance_fence: unavailable`、`recovery_allowed: false`を返す。backupは事後調査用であり、production DBへrestoreしない。

既存の`resolve-invalid-result`と`resolve-review-attention`は、保存済みlive identityがあり、最新receiptが`session_absent`を示す場合だけ進める。`not_addressable`を含む`do_not_retry`判定のみでは停止済みと見なさない。これは旧jobを解除する経路ではない。

## 未実装の停止証明に必要な契約

Herdrまたはhost supervisor側に、次を同一generationへ固定した独立のmaintenance receiptが必要である。

1. Dispatcher・Slack ingress・worker生成元・Updater activationのadmission freezeを、再起動後も効くdurable generationとして公開する。
2. 保存済みjob IDに依存せず、Herdr session、pane、process groupと子孫processを完全に列挙する。paginationや上限、取得失敗は不完全として拒否する。
3. 各候補のterminal stopと、receipt発行から復旧transaction完了まで再生成されないことを証明する。`idle`、`not_addressable`、Result fileの存在、Dispatcher停止、権限剥奪は停止証明にしない。
4. host/boot identity、supervisor generation、fence generation、対象集合、観測開始・終了、inventory完全性、発行者、検証可能な署名または同等の改ざん検知情報を含める。再起動・generation変更・期限切れでは失効する。

この契約が実装され、同じgenerationをDispatcherとstable Updaterがread-backできるまでは、旧jobの`needs_review`解除、`job_terminal_worker_stop_proofs`や`legacy_job_agents_to_stop`の停止済み更新、activation gateの例外を実装しない。現行の`updateSafetyStatus()`とUpdaterの`workerSafety()`はそのまま危険状態を報告する。

## 後続の復旧実装境界

停止receiptを独立に検証できるようになった後、operatorはjobごとに外部副作用、既存通知の配送・曖昧性、正常finalの受理可否を証跡digestとともに決める。復旧transactionはpreflightの`updated_at`、job行、Result bytesとfile identity、通知/group行、fence generationをCASで再検査し、append-only ledgerへ結果を保存する。正常finalは共有validatorと既存のterminal保存経路を使い、無効・欠落finalは元fileを修復せず`failed`へ確定する。未配送通知のみを抑止し、曖昧な配送は拒否する。commit後は同じgenerationでDispatcherとUpdaterの安全判定を再読する。

現在のpreflightにはこのwrite、ledger、通知遷移、再開・rollback機能はない。11件の旧jobが解決したことも意味しない。後続実装では、停止中のDBコピーでCAS drift、途中crash、再起動、通知競合、backupからの手動復旧境界を検証する。
