# GitHub ProjectsとTaskのIssue着手・提出手順

現行DonaはTask世代である。実行の所有権はDispatcherのIssue node ID claimで決まり、Projectは進捗の表示先になる。旧`Dona Job ID`、`In Progress`、旧jobの照会結果を新Taskの排他制御に使わない。[旧手順](legacy-job-issue-lifecycle.md)は旧世代を保守するときだけ参照する。

## 新規着手と同じTaskの継続

1. ユーザーの依頼範囲、対象repository・Issue number/node ID、既存成果・残作業を確認する。Project #4はowner `reirei-lab`、ID `PVT_kwDOEPyLNM4BlJjH`。実際のProject/item identityはGitHubから読み、資料の番号だけでwriteしない。
2. 現在のthread・依頼者の`list_tasks`と`get_task`で既存Taskを確認する。同じ仕事の追加条件は`steer_task`、一時停止・再開は`pause_task` / `resume_task`を使う。別Taskのclaimがあれば新規委任で回避せず、そのTaskの正規認可経路で照合する。
3. 新Taskは`delegate_task`へ安定した`task_key`、現在eventの`source_event_id`、`workspace`、`issue_number`を渡す。DispatcherがGitHub Issue node IDを検証し、永続claimを確保する。`task_owner_mismatch`では他Taskの詳細を推測・開示しない。
4. Project同期を依頼する場合、全fieldと対象itemを取得し、`Dona Task ID`がTEXT、`Status`がSINGLE_SELECTで`Todo` / `In Progress` / `Merge Ready`を持つことを確認する。Project/item・型違い・権限不足は報告する。設定変更を含む導入・修正がユーザーから依頼済みなら、その範囲のfield作成を再承認待ちにしない。通常の委任だけから無関係な設定変更権限を推定しない。
5. `project: {owner, number, completion_status}`を構造化指定する。Issue全体の実装・検証・レビュー・CI完了まで依頼された場合だけ`Merge Ready`を指定し、objectiveへ受け入れ条件を記載する。部分調査の既定は`In Progress`。

`job_json.task`があるworkerは`Dona Job ID`、`Dona Task ID`、`Status`を手動変更しない。Dispatcherが同期し、read-backを行う。Project同期失敗とTask実行の所有権は別であり、表示修復のためにTaskを重複作成しない。

## 空DB切替後の旧Issueを引き継ぐ

旧jobの`job_not_found`は空DB切替で生じる想定内の状態である。停止証明でも、旧Dispatcherを復活させる理由でもない。旧Job IDのterminal照会、`inspect_job_worker`、`resume_job`を新世代への引継ぎ条件にしない。

1. 現在のユーザーが対象Issueの続きを依頼していること、ProjectのIssue node ID・item ID・旧`Dona Job ID`、既存PRと成果を確認する。複数Issueの順次対応が明示されている場合、各Issue番号の再指定は要求しない。
2. [旧成果の引継ぎ記録](legacy-task-handoff.md)をread-onlyの`inspect`で照合する。外部operatorが確認・記録した切替停止証拠と旧worktreeの一致を使う。記録がなければ必要なのは外部operatorによる引継ぎ準備であり、旧DBを現行Dispatcherに戻すことではない。
3. 記録のrepository・Issue number/node ID・Project item ID・旧job IDを現在のGitHub値と照合する。不一致、旧成果の変更、停止記録の変更では、その対象だけを保留して他の確認可能なIssueを進める。外部サービスで継続する処理や送信結果が曖昧な操作は別途照合する。
4. 新Taskのobjectiveへ確認済みIssue identity、recordの照合コマンド、旧成果のHEAD、成果の取り込み方針、残作業と承認範囲を含める。旧worktreeは読み取り専用の資料とし、新Taskが新しいworktreeで作業する。旧Resultを新Taskの完了Resultにコピーしない。
5. workerはrecordを再照合し、既存PR・commitを現行mainと比較する。既にmainへ入った変更は再適用しない。未反映commit、記録されたtracked fileの生内容・mode・削除状態、untrackedだけを新worktreeへ必要な範囲で取り込み、競合を解決する。旧worktreeでは`git diff`を実行しない（external diff、textconv、clean/process filterを起動し得る）。indexと通常fileを直接読み、symlinkはtarget文字列だけを扱い、外部targetを読まない。確認済み変更を新worktree側で組み立て、そこで差分をreviewする。旧`.git`、node_modules、設定・認証情報、旧AGENTSを丸ごと上書きコピーしない。旧worktreeへのcheckout、reset、clean、commit、削除は禁止する。
6. 通常の`delegate_task`のIssue claimを使用する。Projectの旧Job IDは履歴として残せる。新Task IDが他Taskと競合する場合は上書きしない。

operator記録は成果の由来と停止時点の証拠であり、外部操作の成功・全Issueの完了・承認の代用品ではない。

## 提出完了

`code-submission-review-cycle`でcurrent-head review/CIとIssue全体のscopeを確認する。Taskのobjectiveを満たしてResultを公開した後、Dispatcherが指定された完了Statusへ同期する。部分成果でIssue全体を`Merge Ready`にしない。PR merge、本番反映、Issue closeはそれぞれ依頼範囲に従う。workerによる旧Job IDの記入・照会を提出条件に追加しない。
