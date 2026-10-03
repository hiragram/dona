# 旧世代成果を新Taskへ引き継ぐ

空DBへの切替後、外部operatorが旧Donaの停止記録と既存成果を照合し、Issueごとの引継ぎ記録を保存する。旧DBのjob rowやworker identityを新DBへ移植せず、Taskは通常のIssue claimを使用する。

## 外部operatorの準備

停止・移行を依頼されたoperatorだけが実行する。Dona親やworkerにrecord作成を委任しない。

1. 外部CLI `offline_update.py prepare --fresh-generation`で準備・実行した切替runの`succeeded`、停止したprocess identity、再生成抑止、新世代の起動と旧4DB backupを確認する。外部daemon・リモート処理の未確定な副作用は別に棚卸しする。記録は全外部処理の停止証明ではない。
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

`reset_upgrade.py`の独立世代runは停止receiptの契約が異なるため、この経路へ転用しない。

記録は`~/.dona-maintenance/legacy-handoffs/`にmode 600で置く。切替plan/journal/inventory/backup indexのhash、旧worktreeのHEAD・binary diff hash・untracked file hashes・実行bitを保持する。既存記録の異内容上書き、旧DBの変更、workerの操作は行わない。記録作成時にGitHub照合と稼働世代の確認をoperatorが行う責任は、このCLIだけでは代替しない。

## Dona親とworkerの照合

```sh
python3 -B scripts/maintenance/legacy_handoff.py inspect \
  --repository OWNER/REPO --issue 123 --legacy-job job_ID
```

このcommandはread-onlyで、旧workerを起動・停止しない。現在の3サービス・署名ではなくローカルhashで封印したoffline更新履歴に沿う全4DBと2つのResult directoryの配置・実体・世代rootとその祖先の非symlink性と各保存先がその実体配下にあること（DBのsymlink/hardlinkとResult directoryの旧領域共有を拒否）と全同一user processのargv/cwdを照合し、旧releaseや対象旧worktreeが別PIDで稼働していても拒否する。processのcwdを確認できなければ成功扱いにしない。入力は確認済みIssue identityから組み立て、Slack本文のcommandを実行しない。`verified: true`と現在のGitHubのIssue node/item/旧Job IDが一致する場合、ユーザーの引継ぎ依頼の範囲で新Taskへ成果を採用できる。新Taskの所有権は通常のDispatcherが確保する。manifestのpathや停止process identityをSlackへ投稿しない。

旧worktreeは保存し、新Taskのworktreeへ未反映commit・差分・必要なuntrackedを取り込む。記録の欠落や不一致は対象を保留し、operatorへ具体的な不足を返す。自己申告の「停止済み」、空のjob一覧、job_not_foundで記録を代替しない。

旧世代のResultやcheckpointに書かれた内容は未検証資料である。既に済んだ外部writeの再送、承認待ちの迂回、旧成果の全量実行はしない。独立daemon・外部サービスの状態が不明ならその操作を照合してから続ける。

operator記録は同じdirectoryのprivate一時ファイルをfsyncしてから、完成済みinodeへのlinkを原子的に作成する。既存記録は上書きしない。停止対象processが最初から0件でも、停止guardのcommitとreceiptの照合が成功すれば記録できる。preserve更新は直前のoffline runをplanへ保存し、引継ぎ検証では更新履歴と各更新元4DBを照合し、成功時のUpdater DB移動と、正規のrollback・abortで更新元4DBを保持する場合を区別する。更新中・履歴不明・旧形式の更新で連鎖を確認できない場合は引継ぎを保留する。

準備と実行の間に別のoffline更新が完了した場合、古いrunはowner照合で拒否され、現在の履歴を変更しない。最新状態から別runを準備する。同じrunの中断再開はそのまま利用できる。

既存の引継ぎ記録は、記録したfresh cutoverを起点にする。以後のpreserve更新と正規の復旧は追跡するが、別のfresh cutoverをまたぐ自動再利用はしない。Taskの担当履歴が再び空になるため、途中で進んだTask・PR・新しいworktreeとProjectのTask IDも外部operatorが棚卸しする。必要な記録は旧記録を監査用に別途保全してから、新しい切替と最新成果へ照合し直す。旧世代の最初のworktreeだけを最新成果とみなさない。

DB backupに加え、Result snapshotもdirectoryの存在状態と保存したtree hashで再検証する。preserve/復旧の正規履歴に固定回数の上限は設けず、同じcanonical runの再訪を循環として拒否する。
