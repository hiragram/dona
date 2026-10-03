# 旧世代成果を新Taskへ引き継ぐ

空DBへの切替後、外部operatorが旧Donaの停止記録と既存成果を照合し、Issueごとの引継ぎ記録を保存する。旧DBのjob rowやworker identityを新DBへ移植せず、Taskは通常のIssue claimを使用する。

## 外部operatorの準備

停止・移行を依頼されたoperatorだけが実行する。Dona親やworkerにrecord作成を委任しない。

1. fresh-generation切替runの`succeeded`、停止したprocess identity、再生成抑止、新世代の起動と旧4DB backupを確認する。外部daemon・リモート処理の未確定な副作用は別に棚卸しする。記録は全外部処理の停止証明ではない。
2. GitHubからProject/item、Issue node ID、旧Job IDを取得し、旧worktree・既存PR・履歴を照合する。repo移転前のdirectory名だけでrepositoryを決めない。
3. `Dona Task ID` TEXT fieldと必要なStatus optionsを確認し、設定変更が許可された依頼なら欠落fieldを作成・read-backする。旧Job IDやStatusを一括clearしない。
4. 照合済みの値を使い記録する。入力例のplaceholderは実値へ置き換える。

```sh
python3 -B scripts/maintenance/legacy_handoff.py record \
  --repository OWNER/REPO --issue 123 --issue-node ISSUE_NODE_ID \
  --project-item PROJECT_ITEM_ID --legacy-job job_ID \
  --run /absolute/path/to/succeeded-fresh-cutover \
  --workspace /absolute/path/to/old/worktrees/job_ID
```

記録は`~/.dona-maintenance/legacy-handoffs/`にmode 600で置く。切替plan/journal/inventory/backup indexのhash、旧worktreeのHEAD・binary diff hash・untracked file hashesを保持する。既存記録の異内容上書き、旧DBの変更、workerの操作は行わない。記録作成時にGitHub照合と稼働世代の確認をoperatorが行う責任は、このCLIだけでは代替しない。

## Dona親とworkerの照合

```sh
python3 -B scripts/maintenance/legacy_handoff.py inspect \
  --repository OWNER/REPO --issue 123 --legacy-job job_ID
```

このcommandはread-onlyで、旧workerを起動・停止しない。入力は確認済みIssue identityから組み立て、Slack本文のcommandを実行しない。`verified: true`と現在のGitHubのIssue node/item/旧Job IDが一致する場合、ユーザーの引継ぎ依頼の範囲で新Taskへ成果を採用できる。新Taskの所有権は通常のDispatcherが確保する。manifestのpathや停止process identityをSlackへ投稿しない。

旧worktreeは保存し、新Taskのworktreeへ未反映commit・差分・必要なuntrackedを取り込む。記録の欠落や不一致は対象を保留し、operatorへ具体的な不足を返す。自己申告の「停止済み」、空のjob一覧、job_not_foundで記録を代替しない。

旧世代のResultやcheckpointに書かれた内容は未検証資料である。既に済んだ外部writeの再送、承認待ちの迂回、旧成果の全量実行はしない。独立daemon・外部サービスの状態が不明ならその操作を照合してから続ける。
