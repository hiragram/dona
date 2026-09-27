# 独立した保守reset / upgrade

`scripts/maintenance/reset_upgrade.py` はDona専用の保守経路です。通常の
`plan_self_update` / exact plan承認 / `apply_self_update`、maintenance-fence検証は変更しません。
DB履歴を引き継がず、新しい世代を準備して3サービスを切り替えます。
実行前に通常self-updateの非terminal request（承認待ちを含む）がないことも確認します。
残っている場合は親がDispatcherの通常cancel経路で整理し、再照合してください。保守runnerは通常updateを並行実行しません。
本番実行には、委任job・元event・その完了通知eventのterminalと、親へのhandoff receiptが必要です。
準備だけでは本番を停止しません。

## 対象と保持するもの

- 対象サービスは `dev.dona.slack-adapter`、`dev.dona.dispatcher`、`dev.dona.updater` のみです。
- 元のlaunchd plist、dotenv、Updater policyから実際のDB、Result、socket、release、設定を取得します。
  parse値とhashは同じbytesから作り、snapshot終了時にも設定とpointerを再照合します。
  prepare時と停止前で設定のhash・pointerを照合します。
- canonical `hiragram/dona` のmainをGitHub APIとfetchの両方でexact SHAへ固定し、archiveを独立領域でbuildします。
  prepareとexecute / 再開時に、既存policyのrequired checks（GitHub Actions・同SHA・最新run成功）と要求される署名検証を確認します。
- 新世代は `~/.dona/g/<runから導いたID>` です。DB（Dispatcher、通知、進捗、Updater）、Result、socket、log、設定、pointerを分離します。
  Updaterの実行codeは新世代control領域へcopyし、通常release保持期限による削除から分離します。
  schedule履歴も新しいDispatcher DBで初期化されます。旧履歴から通知を再送しません。
- 元のDB・Result・release・pointer・設定はその場に保持し、任意の `--snapshot-old-databases` をprepare時に指定した場合だけDonaと同じNode SQLiteでWAL込みの整合snapshotも保存します。
  標準では旧pathをそのまま残すだけで、snapshot作成・旧37件のreconciliation・旧履歴継承を切替条件にしません。
  各DBは同じ旧世代のsnapshotですが、全DBの同一時刻transactionを保証するものではありません。
- Git repository / worktree / 未commit成果、他Herdr session、他project、Slack / GitHub上の成果を削除・変更しません。
- Slack認証（Keychainを含む）と外部連携設定を保持します。内部通知tokenだけ新世代でrotateします。

### 世代分離を選ぶ理由

同じDB pathを上書きする方式では、残存workerの古いfile descriptor・遅延Resultが新状態へ混ざります。
このrunnerは旧pathを削除・symlink転送せず、新DB・Result・socketを別pathへ作ります。
旧workerが旧契約に従って書く限り、新状態へ混ざりません。旧workerの完全停止やhost-wide fenceを証明したとは扱いません。
同じOS userで任意pathを探索して書くworkerに対するsecurity sandboxでもありません。
親operatorはDona専用sessionという運用前提と、この残余リスクをreceiptへ記録します。
mainの停止・起動だけ通常Updaterの `RealRuntime` adapterを使用します。独自のHerdr shell commandやworker一括操作は追加しません。
`send-keys` のidentity条件不足は残ります。Dona専用sessionかつ保守中に他operatorがpaneを変更しない運用前提で、観測をmachine fenceと偽りません。
必要なworker操作はDispatcher正規経路で親が行います。

## 準備

macOS、Python 3、Node/npm、`gh`の認証、稼働する3つのDona LaunchAgentが必要です。
既存policyのexecutableを使います。runnerの標準出力・例外にはcredentialやコマンド出力を出しません。

```sh
python3 scripts/maintenance/reset_upgrade.py prepare \
  --run "$HOME/.dona-maintenance/reset-YYYYMMDD-unique" \
  --repository "$PWD" \
  --event-id evt_XXXXXXXXXXXXXXXXXXXXXXXXXX \
  --job-id job_xxxxxxxxxxxxxxxxxxxxxxxxxx
```

run directoryは新規の絶対pathにしてください。prepareの失敗時はそのrunを実行対象にせず、
診断後に別runへ再準備します。既存のrunや世代を自動削除しません。

独立領域へ次を作ります（すべてprivate。Slackへ転載しないこと）。

- `runner.py`: self-contained runnerのcopy。元Dispatcher DBやworktreeに依存せず継続できます。
- `inventory.json`: 元設定・plist・writerのPIDとidentity hash・書込先。secretを含み得ます。
- `plan.json`: canonical SHA、準備した世代、inventory / runner / plist / 全build成果のseal。
- `plists/`: 新設定。元のLaunchAgentsはまだ変更しません。
- `journal.json`: hashで固定したplanとphase、operator判断、実行記録。

空DBはtarget releaseの `DispatcherDatabase`、`UpdateNotificationDatabase`、`JobProgressStore`、
`UpdateDatabase` のconstructorで正規migrationします。既存DBへmigrationしません。
releaseとstable updaterのfileは0400、directoryは0500へ固定してからsealを作ります。
prepare後に元設定や準備成果が変わった場合、実行を拒否して再準備します。
execute / restore / arm / probe-mcpは準備領域のsealed `runner.py`自身からだけ起動できます。

## 親へのhandoffと実行

既に与えられた保守初期化の許可を再要求する手順ではありません。
親はjobの完了通知を処理し、準備成果と残余リスクを確認したうえで、run直下へ
次の `handoff.json` をmode 600、temp + renameで記録します。

```json
{
  "schema_version": 1,
  "plan_sha256": "prepareが返したSHA-256",
  "event_id": "plan.jsonのevent_id",
  "job_id": "plan.jsonのjob_id",
  "handoff_event_id": "jobs.completion_event_idの親通知event",
  "operator_assertion": {
    "exclusive_dona_session": true,
    "residual_old_workers_accepted": true,
    "parent_handoff_complete": true
  }
}
```

このreceiptはoperator assertionです。署名された機械停止証明ではありません。
runnerは旧DBをread-onlyで照合し、元eventとjob完了通知eventが`completed`、
指定jobが`completed / failed / cancelled`であることを確認します。
親通知eventの処理中に起動すると、停止前に拒否されます。

親はreceipt記録後、次の `arm` を呼び、登録結果を確認して自身のEvent Resultを公開します。
一度だけ動く独立LaunchAgentが最大10分terminalを待ち、3サービスや旧mainを止めても継続します。
plistはrun領域に置くためlogin時には自動再実行されません。`KeepAlive=false`で、再度armしてもkickstartしません。
登録応答が不明な場合はexact labelをread-only照合し、未登録なら再送せず `arm_acceptance_unknown` とします。

```sh
python3 "$HOME/.dona-maintenance/reset-YYYYMMDD-unique/runner.py" arm \
  --run "$HOME/.dona-maintenance/reset-YYYYMMDD-unique" \
  --handoff "$HOME/.dona-maintenance/reset-YYYYMMDD-unique/handoff.json"
```

独立terminalからterminal成立後に即実行する場合は、同じ引数で `arm` を `execute` に置き換えます。
再開も `execute` です。armは停止・初期化の承認を追加要求しません。

1. 全run共通のfile lockを取得し、receipt、元設定、準備成果を検証します。
2. Updater、Slack新規受付、Dispatcher（schedulerとjob生成元を含む）の順でbootoutします。
   停止後に通常updateの非terminal requestと元pointer / 設定を再照合し、並行activationを検出します。
   service由来のPID・UID・command identityを記録し、未登録を連続観測し、元PIDが残存していないことを確認します。
   これは3サービスの観測であり、Herdr worker全体の停止証明ではありません。
3. snapshotを明示選択した場合だけ、停止前とbackup前に容量floorを確認して旧DBのsnapshotを保存します。
   backup失敗時にはpartial snapshotとsidecarを削除してから復元します。旧Resultはpathごと保持し、遅延writeも旧世代へ残します。
4. UpdaterとDispatcherのplistを新世代のrelease pointer / 設定へ切り替えます。
   Slackの新plistはmain確認後のingress開始intentまでinstallせず、旧plistを未登録のまま保持します。
5. 起動直前に未起動世代のfull sealを再照合し、UpdaterとDispatcherを起動してcore healthを確認します。
   `awaiting_main`は中間phaseです。同じ実行で旧mainを停止し、新main起動・MCP確認を行います。
   main確認receipt生成後にingress開始intentを永続化し、Slack plistのinstallと起動を行います。
   bootstrap応答が曖昧な場合は同writeを再送せず観測します。
6. 3サービスの`/health/version`でexact SHA / readyを、DispatcherとSlackで`update_notification_protocol == 1`を、
   Slackで`workspaces_ready`と`dispatcher_ready`を確認します。
   成功を独立journalへ記録します。

### main agentの接続切替と受付barrier

`main_bridge.mjs` はtarget mainに既存の通常Updater `RealRuntime` をimportして使います。
`dona` sessionの `dona-main` の旧release・idle/done・pane・sessionを照合し、同じpaneで停止・新規起動します。
旧workerの状態や旧job履歴を解決する処理は呼びません。停止・起動のintentと応答を独立した
`main-lifecycle.json`へ記録し、応答喪失時に同writeを再送しません。start応答喪失後は
新release・同pane・旧と異なるsession・interactive readyをread-only照合して回復できます。
stop応答喪失は `main_stop_acceptance_unknown` とし、新サービスを停止したまま保ちます。

新mainはtarget releaseをworking directoryにし、両MCPにpolicy指定node、世代固有wrapper、
`enabled=true` / `required=true` をCLI overrideします。MCP初期化失敗時にCodexの起動を失敗させる設定は
[OpenAI公式Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)に従います。
wrapperは新世代dotenvで継承envを上書きし、target MCPを起動します。secretはargvへ渡しません。
通常adapterのREADY確認後、実Codex argvの必須設定と、同UIDの2つの固定wrapper childをOSから照合します。
mainとMCPのstart identityも記録します。Herdrにhost-wide atomic fenceがあるとは扱いません。

`main-ready.json`はplanとprocess identityへ束縛した120秒のreceiptで、runner自身が生成します。
人間がPIDやhandshake済flagを埋める `confirm-main` は不要です。Slack起動直前と成功記録前にも再照合します。
mainが起動できなければ `forward_recovery` となり、受付しません。親はjournalとoperator.logを確認し、
同じ `execute` で記録済mainを照合・再開します。曖昧なstop/startを勝手に再送しないでください。

本番停止前に、新世代の両MCPを実際に起動してinitializeとtools/listだけを試すこともできます。
Slack側は保持した認証でauth.testを行います。Slack投稿・Socket Mode受付・tool実行はしません。

```sh
python3 "$HOME/.dona-maintenance/reset-YYYYMMDD-unique/runner.py" probe-mcp \
  --run "$HOME/.dona-maintenance/reset-YYYYMMDD-unique"
```

結果は `mcp-probe.json`へplan hash付きで保存します。probeは新mainからの接続証拠とは区別し、
本番execute時には上記main起動とchild観測を必ず行います。

## 失敗と再開

同じ `execute` commandで再開します。phaseは副作用の前後でfsync + atomic renameします。
DB・pointerを再初期化せず、途中のplist切替は同じ内容で収束させます。
bootstrap済serviceは登録状態から照合し、terminal後の再実行は副作用を追加しません。
未知のphase・変更されたplan / runner / plistは拒否します。未起動phaseでは全世代sealを、
起動intent以後でもcode / 設定 / pointerとpermissionの静的sealを再照合します。
起動直前にinstall済みplistとstaged bytesも比較し、再開時は既存登録を停止して検証済plistからbootstrapします。
seal照合失敗もphaseに応じた復元・停止の対象で、ingress後なら新世代を保持して停止します。

main handoff開始前の失敗では、新世代の3サービス停止を確認して元plistへ戻し、
保持した旧DB・Result・releaseで起動し、旧SHAのhealthを確認します。
旧DBのsnapshotを上書き復元しないため、退避後の旧worker writeも破壊しません。
復元の停止確認・healthに失敗した場合は `rolling_back` のままです。成功と扱いません。
main handoff開始（`awaiting_main`）以後の失敗は `forward_recovery` とし、新3サービスを停止して新世代DBを保持します。
新mainを旧DBへ誤接続したり、ACK済eventを旧DBへ取り残したりしないため、旧世代への自動・手動restoreを禁止します。
同じexecuteで同じ新DBを使って起動・healthを再確認します。DBの破棄・event再送を自動で行いません。

起動前のcrash後にseal driftを検出した場合は、新世代を起動せず停止します。
main handoff開始前であることをjournalで確認できる場合だけ、明示的なrestoreも使えます。

```sh
python3 "$HOME/.dona-maintenance/reset-YYYYMMDD-unique/runner.py" restore \
  --run "$HOME/.dona-maintenance/reset-YYYYMMDD-unique"
```

元世代は既存の`needs_review`等を含むため、復元は旧状態へ戻ることであり、旧問題の修復ではありません。

```sh
python3 "$HOME/.dona-maintenance/reset-YYYYMMDD-unique/runner.py" status \
  --run "$HOME/.dona-maintenance/reset-YYYYMMDD-unique"
```

`prepared`、`awaiting_main`、`succeeded`、`rolled_back`、`rolling_back`、`forward_recovery`を区別してください。
`succeeded`は上記サービス切替・healthの範囲です。Slack投稿や新mainでのevent処理成功を意味しません。

## 検証

```sh
python3 -B -m unittest discover -s test -p maintenance_reset_test.py
npm run test:skills
```

一時directoryで実SQLite backup、古いwriterの後続write、phase途中再開、部分plist切替、
health失敗・復元失敗、handoff未成立、設定drift、共通lock、未公開tempの再開を検証します。
3つの実child processとUNIX HTTP socketによる起動・health・停止も通します。
CI失敗・署名不一致、install済plistの旧DB混入、ingress後のseal drift、内部通知protocol欠落、
permission drift、backup hashのchunk計算、partial backup回収、容量不足、sealed entrypoint、
main未準備時のingress停止、実process treeのmain / MCP対応、main起動応答喪失時のread-only再照合、
one-shot armとparent terminal待機、成功journal失敗、backup中のgeneration変更も検証します。
通常Updater adapterを実際に通したbridgeの停止→起動とMCP overrideもfixture Herdrで検証します。
launchd adapterと本物のSlack接続は本番停止を伴うため、ここでは未実行です。
UpdaterのCIではDonaと同じNode SQLiteでclose後DBのread-only照合とlive WALのbackupも検証します。
通常self-update gate・Herdr repository・本番DBの変更はありません。
