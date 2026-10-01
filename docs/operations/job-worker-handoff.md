# 停滞したジョブの稼働確認と引継ぎ

ジョブの`running` / `blocked` / `needs_review`は永続処理状態であり、現在のワーカーが作業している証明ではない。利用上限、CLI終了、通信障害などで処理が止まった場合は、現在のSlack依頼から`inspect_job_worker`、`resume_job`を使う。通常のジョブだけが対象であり、scheduleの権限・期限契約は変更しない。

## 観測と再委譲

1. 同じthreadの`list_thread_jobs`、または明示されたIssueの正しいProject itemに保存された`Dona Job ID`で対象を特定する。複数候補を類似度や時刻で自動選択しない。
2. 現在のSlack `source_event_id`とexact `job_id`で`inspect_job_worker`を呼ぶ。Dispatcherが保存済みownerのworkspace/channelを確認する。session ID未保存でもjob名、保存されたworkspace/pane、process inventoryを照合する。terminal本文、argv、環境変数は取得・返却しない。
3. `working`は稼働中、`waiting`は承認・質問待ち、`inactive`は入力受付状態または子processのないshell、`stopped`は保存されたprocessとpaneの消失確認済み、`unknown`は確認不能である。`inactive`だけで停止完了と報告しない。通信失敗・名前の不存在・`not_addressable`だけでは`stopped`にしない。
4. 利用者が再開・引継ぎを依頼し、既存PR・commit・未完了範囲を確認したら、`resume_job(job_id, source_event_id, instruction)`を呼ぶ。`instruction`には引継ぐ残作業と外部操作の照合事項を書く。toolへpath、branch、workspace、result保存先を渡せない。
5. Dispatcherが再観測し、`inactive`なworkerの終了意図を先にDBへ保存する。保存されたpaneだけを閉じ、採取したshell/子孫processの消失、pane不存在、agent不存在、完全なagent一覧を再確認する。作業中・承認待ち・確認不能なら新workerを作らない。`stopped`では追加の停止writeは不要である。
6. 停止を確認した場合だけ、旧jobの取消、新job作成、旧→新jobのrelationshipを同じDB transactionで確定する。新jobには新しいagent名・Result保存先・進捗保存先を割り当て、元のworktreeとbranch、staged / unstaged / untrackedファイル、元objectiveを保持する。新workerは既存PRと外部操作の受理状態を確認して残作業を進める。古いResultを新jobの成功証拠として使わない。
7. `created` / `reused`で返った`job_id`が新担当である。旧job IDを新worker名へ付け替えない。Projectは引継ぎ手順に従いwrite直前に再読し、新担当を記録してread-backする。旧jobは`handed_off`として取消通知を抑止し、完了通知は新job経路から届く。旧groupに別のsiblingがある場合はその結果を保持し、引継ぎで接続されたgroupの全作業がterminalになるまで双方の最終通知を保留する。停止確認済みの受理済みsteerは同じtransaction内で停止待ち状態を解消する。

## 応答喪失・再起動・競合

`resume_job`は旧jobごとに一つの引継ぎclaimを持つ。同じinstructionの再照合は同じ新jobを返し、異なるinstructionはconflictになる。claimは`retirement_state: not_sent`で保存し、停止writeの直前に`attempting`への一度だけの遷移を永続化する。claim直後のクラッシュでは、未送信を確認して再観測・受付条件確認後に初回の停止要求を送れる。`attempting`以降のクラッシュや応答喪失は受理不明として同じ停止writeを再送しない。この遷移と外部writeの間で落ちた場合も未送信とは断定できず、read-only照合を維持する。送信状態の証拠を持たない既存claimも`attempting`として移行する。

`retirement_pending`やtimeoutでは、まず`inspect_job_worker`で保存済み`handoff.state`、`retirement_state`と`successor_job_id`を読む。acceptedなら後継jobを確認する。claimedでは、利用者による再照合・再開依頼に同じinstructionで`resume_job`を使える。`not_sent`の場合だけ上記の再検証後に初回送信し、`attempting`なら停止結果の読み取りと、停止が証明できた場合の後継作成だけを行う。旧依頼eventが終了済みなら、後続の現在eventへ後継jobを所属させる。shellからのworker操作やDB直接更新で回避しない。

観測中のjob更新、別owner、未決着の通知、遅着Result、後継のkey競合・受付上限では後継を重複作成しない。遅着Resultがある場合は先に既存Resultを照合する。承認待ちのworkerを自動で閉じたり、承認を満たしたことにして新workerへ渡したりしない。

## 証拠と適用範囲

新しいworkerは初回prompt前にprocess情報を記録する。稼働確認も同じruntime identityに結び付く証拠を保存するため、後でpaneが消失しても再照合できる。MCPにはprocess ID・ローカルpath・生のruntime応答を出さない。PID再利用や権限エラーで消失を確認できない場合は保守的に未確定とする。

旧版で起動され、paneもprocess証拠も既に失われたjobは、停止を後から捏造できないため`unknown`となる。paneが残っている旧jobはsession IDなしでも観測できる。意図的にdaemon化されてworkerのprocess treeから離脱した外部処理や、外部サービスの処理完了は、このruntime観測だけでは証明しない。引継ぎworkerが外部操作の結果を確認する。

この機構は通常運用中のジョブ継続を扱う。DB backupの巻戻し、Herdr session全体の復元、self-updateの世代移行・maintenance fenceの代替にはしない。旧binaryへのrollback時は引継ぎjobを起動しない。新しいworkspace継承metadataを理解しない旧binaryは元branchのidentity検証に失敗し得るため、引継ぎ中のrollbackを運用手順として使用しない。
