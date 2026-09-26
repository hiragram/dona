# 旧 `needs_review` job の停止下復旧に必要な証拠

## 現在の境界

保存済みlive session identityを持たない旧jobでは、個別のHerdr照会が`not_addressable`となる。これはworker停止の証明ではない。`resolve-invalid-result`、`resolve-review-attention`、`accept-late-result`は、保存済みidentityの同一generationに対して取得した最新の`session_absent` receiptだけでも進めない。DB内のnonce、identity、receiptはbackupから一緒に巻き戻せるため、独立したhost/supervisorのmaintenance fence receiptがない間は`maintenance_fence_receipt_required`で拒否する。identity generation digestは照会中の差し替え検出にだけ用い、停止証明とはみなさない。

現行のHerdr連携は個別agentの`get` / `prompt` / `wait`であり、全worker/process treeの完全inventory、admission freeze、再生成防止、host/supervisor generationを束ねた停止receiptを提供しない。したがって旧11件を解除するwrite経路は実装していない。`updateSafetyStatus()`とUpdaterの`workerSafety()`の危険判定も緩めない。

## 外部componentに必要な契約

Herdrまたはhost supervisorが次を同一generationへ束縛した検証可能なmaintenance receiptを提供する必要がある。

1. Dispatcher、Slack ingress、worker生成元、Updater activationのadmission freezeをdurableに確定し、再起動後も新規workerを作れないことを示す。
2. 保存済みjob IDに依存せず、Herdr session、pane、process group、子孫processを全件列挙する。paginationや上限到達、照会失敗では完全と見なさない。
3. 各候補のterminal stopと、receiptから復旧transaction完了まで再生成されないことを示す。`idle`、`not_addressable`、Result file、Dispatcher停止、権限剥奪を停止証明にしない。
4. host/boot identity、supervisor/fence generation、対象集合、観測期間、inventory完全性、発行者、改ざん検知情報を含める。再起動、generation変更、期限切れで失効する。

## receipt提供後のDona実装

停止下でSQLite Online Backupを作り、0600で保全し、backupの`integrity_check`、`foreign_key_check`、schema、全table件数と内容digestを検証する。backupと観測reportはcrash後に同一snapshotを再照合できるcommit protocolで公開する。backupの本体・一時file・SQLite sidecarがsource DBやResultとfilesystem上で同値にならないことを実volumeで検査する。Resultはregular fileを`O_NOFOLLOW`、上限付きで読む。

jobごとに外部副作用、通知の配送・曖昧性、正常finalの受理可否をoperatorが判断する。routing owner/destinationとgroup、attention receipt/claimを厳密に照合する。復旧transactionはjob状態、`updated_at`、Result bytesとfile identity、通知/group、fence generationをCASで再確認し、append-only ledgerへ記録する。正常finalだけを共有validatorとterminal保存経路で受理し、無効・欠落finalは元fileを修復せず`failed`へ確定する。曖昧な通知は再送しない。commit後は同じgenerationでDispatcher/Updater双方の安全判定を再読する。

この手順の実行にはmaintenance windowと個別operator判断が必要であり、現在の依頼ではservice停止、production DB/Result変更、self-updateを行わない。旧11件の解決、通知、self-updateは未実施である。
