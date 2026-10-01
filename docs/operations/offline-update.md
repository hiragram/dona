# CLIからの停止更新

Donaの外のターミナルで、checkout内の次のコマンドを実行します。

```sh
./scripts/dona-update
```

最新の`origin/main`をexact SHAに固定し、CI確認と隔離ビルドを済ませてから、
Donaのサービス・専用Herdr session内のプロセスを停止して更新・再起動します。
Slack上の更新依頼、event/job ID、handoff receipt、旧jobの`needs_review`解消は不要です。
通常の`plan_self_update` / `apply_self_update`とは独立した、ローカル管理者用の停止更新です。

## 保持するデータと停止範囲

Dispatcher DB、通知DB、進捗DB、Resultのpathと履歴を保持します。Updater DBは履歴ごと新しいcontrol領域へ複製し、旧DBも残します。内部tokenは新世代用に生成し、旧tokenは復旧用の旧設定にだけ残します。
schedule・jobを空DBで初期化せず、repository・worktree・未commit成果も残します。
既存のlaunchd plistとdotenvから実際のpathを読むため、標準installと世代別installの両方に対応します。
停止済みサービスからでも準備できます。Slack tokenなどを標準出力へ出しません。

停止対象は`dev.dona.dispatcher`、`dev.dona.slack-adapter`、`dev.dona.updater`と、
専用Herdr session **`dona`** のserver/clientおよび観測した子孫です。
作業中のDona workerも終了するので、外部への操作が途中だったjobは通常の復旧処理で確認対象になり得ます。
それを成功扱いに変えたり、古いjobを一括再実行したりはしません。
他のHerdr sessionは対象にしません。`dona` sessionに無関係な作業を同居させないでください。
このコマンド自身をDonaのpaneから実行すると、自分を停止するため実行前に拒否します。

旧Updater requestは履歴・監査を保持したまま`offline_update_superseded`の`needs_review`にし、
自動reconcileとleaseを終了します。未配信の古いUpdater outboxも`needs_review`へ移します。
これにより新サービス起動時に旧activationが再開することを防ぎます。
すでにDispatcherへ渡った通知やSlackへの投稿を取り消したことにはしません。
通常self-updateの承認条件を緩める変更ではありません。

## 更新の順序

1. 設定を読み、mainのSHAと必須CIを確認する。独立領域で各componentの`npm ci`、test、typecheck、buildを完了する。生成した設定で両MCPのinitialize・tools/listも確認し、停止直前にも再確認する。この間はサービスを稼働させたままにする。
2. 準備物と元設定を照合し、3つのLaunchAgentをdisableする。対象プロセスを親から順に`SIGSTOP`してforkを止めてから子を列挙する。停止対象のPID・UID・開始時刻をjournalへ記録し、launchd登録を外した後、同じidentityの子孫と親を終了する。
3. 全4DBをDonaと同じNode SQLiteでWAL込みbackupし、integrity checkを行う。Result directoryもcopyし、復旧用hashを記録する。
4. target版の正規DB migrationを適用する。コード・設定は新しい世代に置き、旧世代を保持する。activeなUpdater ledgerの自動再開を終了する。
5. run専用のHerdr設定で`resume_agents_on_restore=false`を指定し、旧main・workerのnative conversationを自動再開しない状態でserverを起動する。設定はTOMLとして解析して生成し、元ファイルは変更しない。新しいmainを起動する。両MCPは`required=true`で接続し、target release・pane・interactive readyを確認する。
6. Dispatcher、Slack Adapter、Updaterを起動する。3サービスの`/health/version`でexact SHAとreadyを確認し、Slackのworkspace接続、Dispatcher接続、mainのreleaseを照合した後だけ`succeeded`にする。

親子関係を切って事前にdaemon化した任意の外部プログラムや、別の管理者による同時起動まで隔離するOS sandboxではありません。
通常のDona管理下のプロセスを対象とします。更新中は他のターミナルからDonaの起動・旧保守経路を並行実行しないでください。
PIDの観測を、既存のsigned maintenance fence receiptとして扱うことはありません。

## 事前準備だけ行う

```sh
./scripts/dona-update prepare --run "$HOME/.dona-maintenance/offline-20261001-1"
```

準備完了時に、固定SHAと再開コマンドを表示します。run内にはprivateな設定、独立runner、
plan、journalを保存します。実行時はそのrunのrunnerを使用するため、元のcheckoutを移動しても継続できます。
準備物が変わった場合は停止前に検出します。ビルドの詳細はrun内のprivateな`prepare.log`に保存します。失敗したprepareはそのまま残るので、原因を解消して別runで準備してください。

```sh
python3 -B "$HOME/.dona-maintenance/offline-20261001-1/offline_update.py" resume \
  --run "$HOME/.dona-maintenance/offline-20261001-1"
```

## 障害時の再開と復旧

`./scripts/dona-update resume`で未完了runを再開します。引数なしの`./scripts/dona-update`も、未完了runがあればそれを自動選択します。新しいrunによる割込みは防ぎます。journalは副作用の前後でfsyncとatomic renameにより保存します。
途中の再起動でもLaunchAgentのdisableが残るため、migration中のDBでサービスが勝手に起動しません。

- 通常Updaterが停止直前にsourceを切り替えた場合は、凍結中に不一致を検出し、kill前にprocessを再開してLaunchAgentのenable/disableを元へ戻します。runは`aborted`となり、`./scripts/dona-update`で新しいsourceから準備し直せます。凍結途中のcrashでも、次のresumeでまず凍結を取り消します。
- 停止確認前の失敗ではDBに進まず、保存したプロセスidentityを次回照合します。
- 新mainの起動を試みる前に失敗した場合は、確定backupからDB・Result・plistを戻して旧版を起動します。復旧にも失敗した場合は`restoring`に残し、同じrunから復旧を再開します。
- mainの起動intent以後は必須MCPから書き込まれた可能性があり、その後はDispatcherのscheduleやjobも実行され得るため、DBを巻き戻しません。次回の`resume`でtarget側を停止・再起動し、更新後のデータを保持したまま前進復旧します。
- `succeeded`のrunを再開した場合は正常性を再確認するだけです。

停止処理を開始した更新を明示的に戻す場合は`restore`を使えます。準備だけのrun、新mainの起動intent以後は拒否します。旧mainの復旧起動でも、そのintent以後はDBを再コピーせず現データを保持します。

```sh
python3 -B "$HOME/.dona-maintenance/offline-20261001-1/offline_update.py" status \
  --run "$HOME/.dona-maintenance/offline-20261001-1"
```

`prepared`は準備完了、`rolled_back`は旧版への復旧であり、更新成功ではありません。
新しいSHAでmain・3サービス・Slack接続を確認した`succeeded`だけが更新成功です。
ログインやネットワーク障害などでhealthが失敗した場合も、起動したというだけで成功と報告しません。

## 検証

```sh
node --test test/offline-update.test.mjs
npm --prefix updater test
```

prepare時には、構築済releaseを使う隔離DB試験で未解決job・event・Resultの保持とmigrationの再実行も確認します。

プロセス停止の順序、停止途中からの再開、PID再利用、無関係なプロセスの保護、migration失敗、
受付再開後のrollback禁止、旧Updater requestの監査・再開抑止を検証します。
本番の停止・再起動試験は別に実施し、準備成功と混同しないでください。

復旧時のmain起動にも準備・検証済みの新版adapterとNodeを使います。復旧対象のrelease・policy・MCPは旧版を指定し、旧Updaterサービス自体は元のまま復元します。旧policyを新版adapterで読み込めない場合はサービス停止前に準備を中断します。
