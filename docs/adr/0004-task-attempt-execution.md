# ADR 0004: Taskを継続し、Attemptとworkerを交換できる実行管理

状態: 採用。Task / Attemptの分離、Macの開発環境とCLIの自由度維持、通常中断からの自動再開は利用者合意済み。本PRで実装し、PR提出と本番切替は分ける。

## 目的と決定

利用上限、通信障害、CLI終了で実行が中断しても、依頼と成果物を失わず続行できるようにする。GitHub Projectの`In Progress`と`Dona Job ID`を実行ロックとして使う方式を廃止する。旧DB、実行中の旧workerとの互換性は要件にしない。既存のjob transportは内部Attempt実行に再利用するが、通常作成は必ずTaskの所有下に置く。新しい実行管理は一括で切り替える。

workerは許可された範囲で任意のCLIを使える。すべての外部操作を専用APIへ閉じ込める方式は採用しない。そのため外部操作のexactly-once実行は保証しない。新workerの起動前に旧実行の停止を確認し、旧workerが送信済みの外部操作は別途照合する。

通常の中断は、最初の依頼に固定された目的・権限・予算の範囲で自動回復する。自動回復によって新しい承認を得たことにしたり、Taskの目的を拡張したりしない。利用上限の解除時刻が分からない場合、時刻を捏造しない。

## 現状の根拠

調査対象は`cf7de9c`。本番適用状態の証拠ではない。

- `dispatcher/src/types.ts`: jobが目的、workspace、worker identity、実行状態、Result、通知を保持する。
- `dispatcher/src/database.ts`: job作成の冪等性は`source_event_id + job_key`。Issueを跨ぐevent間のclaimではない。
- `dispatcher/src/job-supervisor.ts`: prompt受理不明、観測失敗、Result欠落などが`needs_review`へ集約される。waitのtimeoutだけなら`running`を維持する。
- `dispatcher/src/job-handoff.ts`と`job-runtime.ts`: 旧workerのprocess/paneを観測して停止後に新jobへworktreeを渡す。agent名の不存在だけで停止とはしない。
- `docs/operations/github-project-issue-lifecycle.md`: Projectの再読・更新・read-backで担当を管理する。厳密なCASではない。

## データの責務

| 集約 | 正本とする情報 |
| --- | --- |
| Task | 不変ID、目的、受け入れ条件、対象resource、ownerと認可範囲、固定通知先、進捗、現在のAttempt、revision |
| Attempt | 不変ID、Task ID、単調増加する実行番号、開始・終了、中断理由、再開条件、checkpoint、Result |
| Worker session | Attempt ID、runtimeが発行する実行identity、起動intent/receipt、稼働観測、停止intent/receipt |
| Checkpoint | 到達点、残作業、成果物参照、未解決の承認・外部操作、作成元Attemptと検証状態 |
| Projection / notification outbox | Task revision、同期先、要求内容digest、送信状態、受理receipt、配送・照合状態 |

TaskとAttemptは1対多。Attemptは別のTaskへ付け替えない。実行ごとの会話履歴は補助資料であり、Taskの正本にしない。再開時のbranch、worktree、Result保存先をユーザー自由文から採用しない。

Taskのowner・通知先と、操作を求める現在のevent/actorを別々に検証する。Task IDを知っているだけでは読み取り・再開・取消の権限を与えない。schedule workは永続run、期限、read-only scopeの契約を保持し、通常Taskの自動再開許可を流用しない。

## 状態と不変条件

Taskの仕事の進捗は`todo / in_progress / merge_ready / completed / cancelled`。進捗と実行可能性は分ける。PR提出を目的とするTaskは提出条件達成で完了でき、merge/deployまで依頼されたTaskはその条件を別途満たす必要がある。

Attemptの状態は`queued / starting / running / waiting / retiring / interrupted / succeeded / failed / cancelled`。`waiting`には機械判定できるreasonと次のactionを持たせる。表示用の日本語だけを状態判定に使わない。

待機理由は少なくとも`capacity_wait / observation_unknown / worker_stop_pending / external_effect_unknown / human_input / retry_exhausted / result_conflict`を区別する。

1. 同一Taskで実行を許可するAttemptは最大一つ。取得・更新はDB transaction内でcurrent Attemptとrevisionを照合する。
2. 同じ対象Issueへの競合するTask作成もDBで防ぐ。repositoryの別名や移管を文字列だけで処理せず、照合したresource identityを使う。別ownerの存在を無権限callerへ開示しない。
3. heartbeat/lease期限切れは停止証明ではない。TTLだけで所有権を奪わない。
4. successorの作成前に旧worker停止receiptを確認する。新workerは停止した旧workerの作業領域だけを引き継げる。
5. Resultは発行元Attemptへ固定する。旧Attemptの遅着Resultは後継の成功に使わず、現在のTask状態を上書きしない。
6. 取消・手動pauseは自動再開より優先する。回復workerは起動直前のtransactionでも再確認する。
7. DB上の取消完了とworker停止完了を区別する。resource claimを解放する前に残存workerと外部操作の扱いを確定する。
8. Projectや通知先の通信障害では、Taskの所有権を変更しない。同期・配送状態として回復する。

## 起動と停止の境界

起動前にAttemptとlaunch intentを永続化し、runtimeに同一identityで照会できる実行単位を作る。起動成功responseを失っても、同じ起動を無条件に再送しない。runtimeのreceiptと実在状態を照合する。照合できない場合は保留する。

停止も同様にintent、送信開始、receipt、消失確認を分ける。runtimeが同一操作IDへの冪等な停止を保証できる場合だけ、その契約に従った再送を許す。それ以外は送信開始後の曖昧結果をread-onlyで照合する。

現行のpane + process group観測は、意図的にdaemon化・別session化した処理を包含するOS境界ではない。これを無条件の停止保証として再利用しない。ホストMacのXcode・Simulator・キーチェーンが必要という要件に従い、Herdrのnative pane/process観測を使用する。起動時と監視時のprocess/groupを蓄積し、その消失とpane/agent一覧を照合する。管理外daemonの完全な停止保証は置かず、外部操作として照合する。実行境界の外へ起動した外部処理は、停止したworkerとは別の成果物・外部操作として扱う必要がある。

起動identityを保存する前のクラッシュ、子processが残る終了、PID再利用、観測権限不足を本番以外の実processで検証する。生死不明なのに後継を起動することで可用性を得る設計にはしない。

## 自動回復

回復処理はLLMの判断だけに依存せず、Dispatcherが永続状態から選ぶ。read-only照合の再試行と、新Attemptによる再実行を別々に数える。確認のpollで実行予算を消費しない一方、pollにもbackoffと頻度上限を設ける。

| 原因 | 動作 |
| --- | --- |
| 明示された利用上限 | 再開待ち。信頼できる解除時刻があれば以後に確認し、なければboundedなbackoffで確認する |
| 通信断、同一workerは稼働中 | 既存Attemptへ再接続し監視を続ける。新Attemptは作らない |
| CLI終了、Result未公開 | 停止確認、成果物保全、後継Attempt作成、照合から続行 |
| worker生死不明 | 再観測。確認できなければ具体的な不足証拠を提示する |
| 承認・回答待ち | 人間入力待ち。自動でworkerを替えて承認を迂回しない |
| 外部操作の応答喪失 | 対象サービスを照合。未実行と確認できるか冪等性契約がある場合だけ再送する |
| 不正または競合するResult | 証拠を保持して隔離。成功・中断を推測しない |
| 実行再試行上限 | 人間へ戻す。別eventで同じTaskを指示しても予算を暗黙に初期化しない |

再開上限・backoff・実行時間上限はTask policyとして保存する。既定値はTask request schemaから採用し、policyを変更して回復する場合はrevisionと変更権限を検証する。目的や権限の変更は新revisionとして扱い、旧Attemptへ後付けで適用しない。

## 成果物と外部操作

checkpointはLLMの申告と確認済み事実を分けて保持する。少なくともbranch、commit、未commit差分、PR、検証対象SHA、残作業、未決着の承認と外部操作を扱う。突然の停止でcheckpointがなくても、停止確認済みworkspaceを照合して復元できる。

新Attemptの最初の工程はreconcileとする。PRの既存head、push結果、Issue/Project、実行途中の外部処理を確認してから依存するwriteへ進む。曖昧な外部操作が独立した場合、他のread-only作業まで一律に禁止しない。

任意CLIが許されるため、すべての副作用を機械的に識別できるという保証は置かない。外部操作を記録できる箇所ではoperation identity、request digest、external ID、receiptを残すが、記録がないことを未実行の証明としない。確認手段がない操作は人間入力待ちへ戻す。

## Projectと通知

Projectには安定したTask IDと仕事の進捗を表示する。Attempt IDは補助情報にする。Task creationは確認したIssue identityでclaimし、Project fieldの古いjob IDをlockとして使わない。Projectの変更はDispatcher側のprojection処理が行い、workerへ担当fieldの更新を要求しない。

同期要求はTask revisionに結び付ける。古いrevisionの成功応答で新しい表示を巻き戻さない。write response喪失時はread-backし、受理済みなら同じwriteを繰り返さない。Projectを手で変更した値は新しい実行権限と解釈しない。

Attempt中断はTask失敗の最終通知にしない。自動再開中は作業中表示を保ち、boundedな進捗だけを出す。人間入力待ちとTaskの最終結果を通知する。groupはTask単位で集約し、Attempt交換のたびにgroupを作り直さない。完了状態と通知配送完了は別に管理する。

## 一括切替

旧実行stateのオンライン変換、旧workerの新Taskへの暗黙採用、旧DBからのTask採用adapterは作らない。既存job作成routeの通常依頼もTaskを作成するが、管理済みAttemptを旧job制御routeから変更することは拒否する。Task/Attemptとその通知・projectionが一緒に動く完成形を検証してから切り替える。

切替では旧受付・再起動主体・writerを止め、worker停止と再生成抑止を確認し、DBと成果物を保全する。旧環境の未決着外部操作・通知は消去せず棚卸しする。新DBへ取り込むのは確認した仕事と成果物であり、旧`needs_review`などの実行stateは移植しない。成否不明な副作用は新Taskの照合事項として明示的に残す。

旧DBやworktreeを削除せず、読み取り用に保持する。本番切替・停止・resetはこの設計・実装PRの提出とは別操作。切替手順を具体化した後、適用対象と停止影響を確認して実行する。

## 完了条件

- 同じIssueへの同時依頼が一つのTask claimに収束し、別ownerへ情報を漏らさない。
- 利用上限・CLI終了から同じTaskの後継Attemptで続行し、差分を保持する。
- 通信復旧で既存workerが見つかった場合、重複起動しない。
- 起動/停止response喪失、Dispatcher再起動、旧Result遅着でも所有権が一つである。
- 未停止worker、残存子process、停止証拠不明では後継を起動しない。
- PR作成response喪失を照合し、重複PRを作らない。
- 承認待ち、取消、pause、再試行上限を自動回復が迂回しない。
- Project同期失敗、通知配送失敗でTask実行を二重化しない。
- actual runtime境界の実process検証と、入口MCP/APIからResult/通知までの統合検証を通す。
- current PR headに対するCodex Cloud reviewとCIの提出条件を満たす。mergeと本番適用は含まない。

## 実装との対応

`tasks`が所有権と仕事の進捗、`task_attempts`が実行履歴とcheckpointを持つ。`jobs`は既存の実行・Result・通知transportとして再利用し、各Attemptの不変IDに対応する。公開するTask stateは`active / waiting / paused / completed / failed / cancelled`で、仕事の`progress`と待機理由を別fieldにする。内部jobの状態をそのまま仕事全体の状態とは扱わない。

`task-execution.ts`がtransaction/CASと回復予算、`job-supervisor.ts`がboundedな自動照合、`task-github.ts`がIssue node identityとProjectのwrite intent/read-back、`task-checkpoint.ts`がcheckpoint契約を担当する。通常Taskの結果通知では中断済みAttemptをgroup snapshotから除き、Task projectionを同じ保存済み通知先へ返す。

通常中断の自動回復と、停止確認済みの予算追加を実装する。結果不正・未解決の外部操作・承認不明を人間の一言だけで成功や未実行へ変換するAPIは設けない。Taskのterminal failureや完了後の別目的への再着手を、元の自動回復許可で行わない。
