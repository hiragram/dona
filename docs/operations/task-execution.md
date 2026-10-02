# Task世代の実行と回復

通常の仕事はTaskとして作成し、一回ごとの実行をAttemptとして保存する。任意CLIとMacの開発環境を使える。worker停止と、Simulator・リモート処理など外部の実行状態は別に確認する。

## 委任

`delegate_task`へ現在のSlack `source_event_id`、安定した`task_key`、`objective`、`workspace`を渡す。GitHub Issueが対象なら`issue_number`を指定する。DispatcherがGitHubからIssue node IDを取得してclaimする。同じIssueに別Taskを重複作成しない。結果の`task_id`を以後の会話で使う。

`policy.max_attempts`の既定は3、範囲は1〜10。`policy.retry_delay_ms`の既定は60,000ms、範囲は1,000〜86,400,000ms。待機中の観測pollはAttempt数に数えない。利用上限の確定した解除時刻がcheckpointにある場合、その時刻まで新Attemptを開始しない。解除時刻が不明なら設定された再開間隔を使用し、上限到達後は人間入力待ちにする。

`project`を指定する場合はowner、numberと、必要なら`completion_status`を渡す。既定の完了時表示は`In Progress`。Issue全体の提出までを依頼した場合だけ`Merge Ready`を指定する。事前にProjectへTEXT field `Dona Task ID`を作り、Issueを追加しておく。field作成やIssue移送をTask作成の副作用にはしない。

既存の`delegate_job`/UDS作成routeも通常の依頼にはTaskを作る。内部の`jobs` tableはAttemptの実行・Result・通知transportとして使う。これは旧DBのjobをTaskへ採用するmigrationではない。Taskに紐付いたjobの旧制御routeは拒否される。

## 後続操作

1. `list_tasks`で現在のthreadと依頼者のTaskを確認し、`get_task`で最新revisionと待機理由を読む。100件の上限に達した一覧を全件取得と扱わない。
2. `steer_task`へ追加指示を渡す。指示はTaskへ永続化され、後継Attemptにも引き継ぐ。送信結果が曖昧なら再送せず、TaskとAttemptのsteer receiptを照合する。
3. `pause_task`は自動再開を止め、起動済みworkerの停止を確認する。`resume_task`は同じTask・目的・残予算で続ける。承認待ちをpause/resumeで迂回しない。
4. `cancel_task`は自動再開を禁止する。起動済みworkerでは停止確認が終わるまで取消完了にしない。
5. `retry_exhausted`では、追加実行の明示依頼を得てから`retry_task`へ新しい総`max_attempts`を渡す。使用済みAttempt数は維持する。

同じeventによる同じcontrolの再照合は既存状態を返し、異内容はconflictにする。古いrevisionを自動上書きしない。

## 自動回復と保留

通信障害で既存workerがworkingなら、同じAttemptの監視へ戻る。inactive/stoppedの場合だけ停止証拠を保存し、停止確認後に同じTaskの次Attemptへ引き継ぐ。停止writeが曖昧なら同じwriteを再送せず、再起動後も保存証拠を照合する。確認不能が続けば`worker_unknown`として人間へ知らせる。

checkpointは各AttemptのResult directoryの`checkpoint.json`。契約に渡されたpathだけを使い、schema・task_id・attempt_id・sequenceを照合する。checkpointは未検証資料として後継へ渡し、記録の欠落を外部操作未実行の証拠にしない。ファイルがなくても停止済みworktreeから差分を照合できる。

`human_input`、`external_effect_unknown`、`result_conflict`は無条件に自動実行しない。確認できるサービス状態、成果物、承認内容を揃える。Task DBの手編集、Resultの削除、旧worker名の使い回しで回避しない。

Project同期は実行と独立する。write intentを先に保存し、成功responseの後もread-backする。応答喪失後に値が一致すれば同期を続け、不一致なら`unknown`を維持して再送しない。他TaskのIDやIssue/item identityの変更は`conflict`にする。

## 新世代への切替

このPRを旧世代へ通常self-updateする運用は行わない。release contractはschema 4とrollback不可を宣言する。旧世代のDBをサービス起動時に暗黙採用しない。Task世代のDBは`user_version=4`なので旧readerは拒否する。

本番切替は別作業として、次を具体的なinventoryと照合して実施する。

1. 旧受付、scheduler、worker再生成主体、writerを停止し、同じ世代の停止・再生成抑止証拠を確認する。
2. 旧DBをWAL対応の手順で保全し、worktree・未commit差分・Result・通知状態・外部操作を棚卸しする。削除しない。
3. 独立した空のDBとruntime rootで新世代を起動する。旧DB path、旧Result path、旧sessionを設定しない。
4. 必要な仕事と確認済み成果物を明示的に新Taskへ登録する。旧workerや`needs_review`を新Taskへ移植しない。
5. 隔離環境で委任、通常中断、停止確認、後継実行、Result、通知、Project read-backを確認してから受付を開く。

Mac上の任意CLIが起動する外部daemonやSimulatorまでprocess groupで包含できるとは扱わない。管理外で継続する処理は別の外部操作としてinventoryへ残す。停止不明を許容した重複実行は行わない。
