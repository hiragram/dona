# 旧 `needs_review` job の停止下復旧に必要な証拠

## 現在の境界

保存済みlive session identityを持たない旧jobでは、個別のHerdr照会が`not_addressable`となる。これはworker停止の証明ではない。`resolve-invalid-result`、`resolve-review-attention`、`accept-late-result`は、保存済みidentityの同一generationに対して取得した最新の`session_absent` receiptだけでも進めない。DB内のnonce、identity、receiptはbackupから一緒に巻き戻せるため、独立したhost/supervisorのmaintenance fence receiptがない間は`maintenance_fence_receipt_required`で拒否する。identity generation digestは照会中の差し替え検出にだけ用い、停止証明とはみなさない。

現行のHerdr連携は個別agentの`get` / `prompt` / `wait`であり、全worker/process treeの完全inventory、admission freeze、再生成防止、host/supervisor generationを束ねた停止receiptを提供しない。したがって機械的停止証明による旧job群の一括解除経路は実装していない。対象件数は毎回durable stateから再取得する。operator assertionによる個別解決は下記の別経路を使う。

## 利用者の手動停止申告を扱う場合

利用者が待機中のCodexプロセスを手動終了し、残る異常状態jobを停止済みと扱う判断を明示した場合、その判断は`operator_assertion`として記録する。これは停止に関する運用上の受容判断であり、`session_absent`、`job_terminal_worker_stop_proofs`、独立したmaintenance fence receiptへ変換しない。申告だけで既存の`maintenance_fence_receipt_required`を通過させない。個別の照合と監査記録が完了したjobだけ、Dispatcher・Updaterの安全判定で別証拠として評価する。

監査記録には、申告元event ID、保存済み申告者actor ID、申告受信時刻、申告本文のdigest、実際の停止時刻が不明ならその事実、候補job IDと各`updated_at`、申告を候補へ適用した判断時刻、証拠クラス、残余リスクを含める。復旧writeの承認者は申告者と区別し、認証済みoperator principal・role・対象workspace/channelとjobのtenant bindingをwrite直前に検証して記録する。候補はその時点のdurable stateから再取得し、過去の件数を固定しない。申告後に作成・再開したworkerは申告の対象と推定しない。記録は元のResultやDBの停止proofを上書きせず、追記とread-backができる別の監査成果物にする。

申告を使って旧jobを解決する経路を実装する場合は、machine proof経路と異なる明示的なoperator decisionとして設計する。対象job・認証済みoperator・申告時点・Result file identity・DB状態・通知・group・副作用の証跡をwrite直前に再照合し、どの不確実性をoperatorが受容したかをjob単位で記録する。`jobs.updated_at`はworker identityの変更を必ずしも表さない。現行Dona sessionの単一writer契約では、`needs_review` jobは通常のpreparation / prompt / steerの対象にならない。対象jobの状態・時刻・steer状態を同じtransactionで再確認し、申告後の状態変更があれば拒否する。この契約外の手動Herdr起動までは観測できないため、operatorが残余リスクとして受容する。妥当なfinalだけを共有validatorと正規の受理経路へ渡し、無効・欠落finalから成功Resultを生成しない。配送済み・未送信・応答不明の通知を別々に扱い、曖昧な送信を自動再試行しない。旧jobを解決しても、残るrunning workerやUpdater自身の`needs_review`を解決済みとみなさず、双方の安全判定を再読する。

`job inspect-operator-recovery`と`job recover-operator-assertion`は、個別の照合と監査付きoperator decisionを実行する。既存の`--worker-stopped-reviewed`は申告の監査記録を作らない。productionのDB、Result、worker、Updaterを直接変更しない。

`dispatcher/src/maintenance-fence.ts`には署名済みreceiptのDona側検証契約を実装した。これはsynthetic receiptを使う契約テスト用であり、現在のoperator復旧CLIには接続していない。現行Herdr 0.8.2の`agent list` / `workspace list`は表示用一覧で、全session・pane・process treeの完全性watermarkや、一覧から停止まで同一世代で再生成を禁止するatomic操作を返さない。`agent get`の`idle` / `done` / `agent_not_found`も停止の証明ではない。従って現行APIだけでproviderを構成してreceiptを発行してはならない。

## 外部componentに必要な契約

Herdrまたはhost supervisorが次を同一generationへ束縛した検証可能なmaintenance receiptを提供する必要がある。

1. Dispatcher、Slack ingress、worker生成元、Updater activationのadmission freezeをdurableに確定し、再起動後も新規workerを作れないことを示す。
2. 保存済みjob IDに依存せず、Herdr session、pane、process group、子孫processを全件列挙する。paginationや上限到達、照会失敗では完全と見なさない。
3. 各候補のterminal stopと、receiptから復旧transaction完了まで再生成されないことを示す。`idle`、`not_addressable`、Result file、Dispatcher停止、権限剥奪を停止証明にしない。
4. host/boot identity、supervisor/fence generation、対象集合、観測期間、inventory完全性、発行者、改ざん検知情報を含める。再起動、generation変更、期限切れで失効する。

必要な外部API案は、host supervisorまたはHerdr serverが発行するatomicな`begin_maintenance_fence(scope)`と、保護された同じgenerationを読む`current_maintenance_fence()`である。インストール済みHerdr 0.8.2の`herdr api schema --json`には該当methodがない。Herdr側で実装するなら[herdrdev/herdr](https://github.com/herdrdev/herdr)のserver/socket APIが依存先となる。前者は全ingress、Dispatcher admission、Updater activation、Herdr/host worker生成を凍結した後、全Herdr session/paneとhost所有Codex process group・子孫を上限・欠落なしで列挙し、各processのterminal stopを確認してから、対象job集合を含むEd25519署名receiptを返す必要がある。後者はDBのrollback domain外で保持したboot ID、supervisor/fence generation、各freezeとno-recreation guardの継続状態を返し、復旧transaction直前とUpdater activation直前に照合する。起動経路が複数なら全経路がこのgeneration fenceへ参加し、参加不能なら発行を拒否する。Herdrまたはhost supervisorのAPI/repository変更が先行しない限り、Donaは署名のtrust anchorとlive generation readerを安全に設定できない。

現在の検証関数は署名、期限、job scope、完全性field、live世代を厳格に検査するが、fieldの真実性は発行元とlive readerの実装に依存する。providerが整うまではDispatcherの`maintenance_fence_receipt_required`を保持し、Updaterの安全判定も変更しない。

## receipt提供後のDona実装

停止下でSQLite Online Backupを作り、0600で保全し、backupの`integrity_check`、`foreign_key_check`、schema、全table件数と内容digestを検証する。backupと観測reportはcrash後に同一snapshotを再照合できるcommit protocolで公開する。backupの本体・一時file・SQLite sidecarがsource DBやResultとfilesystem上で同値にならないことを実volumeで検査する。Resultはregular fileを`O_NOFOLLOW`、上限付きで読む。

jobごとに外部副作用、通知の配送・曖昧性、正常finalの受理可否をoperatorが判断する。routing owner/destinationとgroup、attention receipt/claimを厳密に照合する。復旧transactionはjob状態、`updated_at`、Result bytesとfile identity、通知/group、fence generationをCASで再確認し、append-only ledgerへ記録する。正常finalだけを共有validatorとterminal保存経路で受理し、無効・欠落finalは元fileを修復せず`failed`へ確定する。曖昧な通知は再送しない。commit後は同じgenerationでDispatcher/Updater双方の安全判定を再読する。

この手順の実行にはmaintenance windowと個別operator判断が必要であり、現在の依頼ではservice停止、production DB/Result変更、self-updateを行わない。旧job群の解決、通知、self-updateは未実施である。

## operator assertionによる個別回復

申告が保存されたSlack eventを用い、同じworkspace/channelに属し、申告時刻以前に作成・最終更新された`needs_review` jobだけを対象にする。`job list --status needs_review`で現況を読み、旧件数を固定しない。申告本文は監査台帳にdigestだけを保存する。実行者は権限を持つローカルCLI principalとして記録し、申告者actorとは区別する。workspace IDをSlack tenant bindingとして扱う。

1. `job show <job_id>`と`job inspect-operator-recovery <job_id>`を読み、原因、`updated_at`、Resultの`valid` / `invalid` / `missing`、SHA-256、通知証跡digestを保存する。外部副作用と既存通知の配送状態を個別に確認し、それぞれの証跡を保管する。
2. `job recover-operator-assertion <job_id> <assertion_event_id> <expected_updated_at> <expected_cause> <valid|invalid|missing> <result_sha256|missing> <side_effects_evidence_sha256> <notification_evidence_sha256> --assertion-reviewed --side-effects-reviewed --notification-reviewed`を一度だけ呼ぶ。欠落Resultのみ`missing`を指定する。
3. 応答喪失時は`job show`、`inspect-operator-recovery`、監査台帳と通知eventを再読し、blind retryしない。別jobへ申告を流用する場合も各jobのscopeと証跡を個別に照合する。

妥当Resultは共有schemaで検証して元のResultを受理する。無効・欠落Resultは成功を捏造せず`failed`へ確定する。通知・groupの既存状態が曖昧な場合はwriteを拒否し、配信済み通知を再送しない。回復結果は`job_operator_assertion_recoveries`へ追記され、machine stop proofや旧停止markerは作らない。安全判定はこの台帳と現在のterminal状態・`updated_at`が一致するjobだけを別証拠として扱う。残るrunning job、未解決通知、Updater自身の`needs_review`は引き続き阻害条件である。
