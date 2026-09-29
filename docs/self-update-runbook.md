# Self-update運用runbook

## 導入前確認

1. macOS GUI userで、`node`、`npm`、`git`、`gh`、`herdr`がabsolute pathへ解決できることを確認します。
2. GitHub Actionsの3 checkがmain commitで成功していること、`gh auth status`が成功することを確認します。
3. `sources/slack/.env`の既存設定を確認します。tokenはKeychainに残し、env fileへ書きません。
4. templateだけを検証します。これはproduction pathやlaunchctlを変更しません。

```sh
./scripts/install-self-update.sh --check
```

## 初回installとlegacy移行

cleanなcanonical main checkoutで明示的に実行します。installerはfetch後の`origin/main`とのSHA一致と、同じexact SHAの単一main push CI runに属する固定4 checkの成功を再検証します。

```sh
./scripts/install-self-update.sh --install
```

この段階ではimmutable initial release、stable updater copy、0600 policy/token/config/plistだけを配置し、processやlaunchctlは変更しません。既存`install-launchd.sh`はdeveloper checkoutを直接起動するlegacy方式です。新構成へ切り替えるmaintenance windowでは、既存workerと通知をdrainし、稼働中のDispatcher/Slack Adapterのlaunchd label、PID、起動元を確認します。開発用processがあれば所有者が停止し、子processの終了も確認します。未知のprocessを停止しません。

登録済みlegacy serviceは、運用者が確認済みのlabelに対してSlack Adapter、Dispatcherの順で`launchctl bootout gui/$UID/dev.dona.slack-adapter`と`launchctl bootout gui/$UID/dev.dona.dispatcher`を各1回だけ実行します。各操作の後、`node ./scripts/self-update-install-preflight.mjs wait-launchd-unregistered gui/$UID dev.dona.slack-adapter 30000`または同じcommandのlabelを`dev.dona.dispatcher`とした読み取りで登録解除を安定観測します。応答喪失やtimeout時はbootoutを再送せず、同じ読み取りで状態を照合します。登録解除が確定しない場合はここで停止し、現行serviceとsocket healthを調べます。両labelの登録解除とDispatcher socketの非使用を確認した後だけ、次を別途実行します。

```sh
./scripts/install-self-update.sh --bootstrap
```

`--bootstrap`はinstall済みUpdater plistのSHAをcurrent releaseと照合してからstable updater→Dispatcher→Slack Adapterの順にbootstrapします。checkoutがinstall後に進んでも、そのHEADを起動対象とみなしません。Slack Adapter段階だけ失敗した後の再実行では、登録済みDispatcherのinstall済みplistと固定label・PID・exact SHA healthを確認し、再登録せずSlack段階へ進みます。登録済みSlack Adapterもplistとhealthが一致する場合だけ完了済みと認め、不一致なら停止します。bootstrap応答が曖昧な場合は同じwriteを再送せず、登録とsocket healthを照合します。実行中stable updaterをbootoutしません。

## 通常update

1. Donaは`plan_self_update(source_event_id)`を呼びます。
2. 利用者はcurrent/target exact SHA、plan hash、inventory revision、15分の承認期限、policy、CI、互換性、rollback可否を確認します。inventoryはcontrol-plane build、Dispatcher/app schema、launchd登録とplist identity、worker class、pending event/job/schedule/notificationの件数とdigestだけを返します。worker ID、objective、Result、private pathは返しません。
3. 承認者は同じSlack threadで`承認 plan_id=<plan ID> plan_hash=<plan hash> target_sha=<target SHA> inventory_revision=<inventory revision>`と正確に送ります。Donaはその承認event IDと4値を`apply_self_update`へ渡します。Dispatcherは保存済みSlack eventのactor、発生時刻、本文とplanを照合し、承認receipt IDをserver側で生成します。Codex hostのwrite承認や任意のreceipt文字列では代替できません。
4. acceptedは「approval受付eventとexact planをDBへcommitした」意味です。その受付Event Resultが`completed`になるまでactivationは始まりません。

承認受付後、Updaterは準備開始時とquiesce直前に同じinventory projectionを再取得します。plan作成eventと承認eventは保存済みexact IDで投影から除き、その正常な完了遷移だけでplanが失効しないようにします。他のeventは件数とdigestへ残します。projectionが変わった場合は`inventory_replan_required`、読み取り失敗は`inventory_read_unavailable`、target tipの変更は`target_changed_replan_required`として、service・pointer write前に停止します。計画を自動更新・再承認せず、新しいplanを作り直してください。projection外の完了済み履歴のみが変わる場合は許容されます。schema、登録、未settle通知、worker状態の変化は許容しません。旧schemaのworkerにはepoch/protocol/Result公開capabilityの証拠がないためunknownとして集計し、live workerがある場合は既存のworker safety gateでもactivationを拒否します。
5. updaterは新規Slack ingressとDispatcher dequeueを止め、処理中の1件と`dona-main`のidleを待ってからCodexを終了します。owner-onlyの`config/dispatcher.env`と`config/slack.env`をMCPへ接続し、target releaseから同じpaneへ新しい`dona-main`を起動した後、Dispatcher、Slack Adapterの順に再開します。
6. `get_self_update_status`で`runtime_state`、`runtime_operations`、`notification_state`、outbox、`main_agent`のcwd/sessionを確認します。terminal通知はmain agentを経由せず、専用workerから元Slack threadへ戻ります。`notification_state: reported`になるまで次のupdateは開始されません。

### 稼働中のbackground worker

旧Dispatcherがoperator回復CLIを持たず、残存`needs_review`が通常更新とcontrol-plane更新の両方を塞ぐ場合は、[停止下bootstrap手順](operations/offline-recovery-bootstrap.md)でexact releaseをstageし、承認済みmaintenance windowに限って復旧する。

現行のrelease間には、Herdr agent identityとjob単位のresult grantを次のDispatcherへ引き継いだことを証明するreceiptがありません。このため、`running`、`blocked`、`needs_review`等のworkerが残る場合は、isolated result pathでも更新を継続しません。stable Updaterはquiesce前とDispatcher drain後にowner-privateなjob DBを再読し、handoff不能または観測不能ならservice停止、schema migration、pointer切替より前に停止します。workerをcancel/closeしたり、promptを再送したりしません。

Dispatcherの`update-safety`と`drain-status`に出るworker件数と`unsafe_states`は集計値だけです。`active_worker_handoff_unavailable`ならworkerのterminal Resultとnotificationを通常のDispatcherで回収・確認してから、新しいexact planで再開します。`worker_state_unverified`や`jobs.handoff_observation_unknown`ではDBの所有者、状態、healthを読み取りで照合し、更新writeを反復しません。稼働workerを跨ぐ更新は、release間のidentity・grant・terminal ownerを検証するhandoff契約とprocess境界テストが完成するまで未対応です。

### 失敗診断log

pre-activation中の`npm ci/test/typecheck/build`は、memory上の`output_limit_bytes`とは独立して、受信時からstdout/stderrをstream種別付きで保存します。保存先はstable Updaterの`control_root/diagnostics/logs`だけで、directoryは0700、fileは0600です。request/attempt/stepとDBでbindしたopaque `log_id`からのみ参照し、caller指定path、絶対path、symlink、hard link、管理root外の参照は拒否します。

- 既定のper-log上限は8 MiB、aggregate上限は64 MiB、retentionは14日です。上限後もcommand監視とSIGTERM→1秒grace→SIGKILL cleanupは継続します。
- `get_self_update_status`の`diagnostics`は新しい順に最大32件だけを返し、`diagnostics_total_count`と`diagnostics_omitted_count`で全件数と省略数を示します。各項目は`log_id`、attempt、step、redaction後byte size、`complete` / `truncated` / `write_failed` / `purged` / `missing` / `size_mismatch` / `read_error`と、最大4 KiBのredacted tailだけを含み、private absolute pathは返しません。
- token、URL、local pathはbounded carry bufferとUTF-8 decoderを通して永続化前にredactします。DB error summary、logger、terminal outboxには従来どおり短いsummaryとopaque IDだけが入り、raw stdout/stderrは入りません。
- temp fileのまま停止したcaptureは、SQLiteの`updater_writer_lease`をtransactionで取得し、その後にUpdater API socketを取得した単一writerのservice起動時だけ安全性を再検証して回収し、`write_failed`へ落とします。別の生存PIDがleaseを保持している場合はsocketへ触れず起動を拒否し、停止時はservice loopを止めてからleaseを解放します。crash後のdead PIDだけをCASで引き継ぎ、PID再利用など生存判定が曖昧な場合はfail closedにします。read-only CLIによるDB openはactive captureを変更しません。final file不在やsize不一致も`complete`へ丸めません。診断保存の失敗はupdate failureを成功へ変えません。
- control DBは診断logのcontent digest、writer lease、exact inventory/承認期限/preflight revision、outbox検索indexを含む`user_version = 9`へforward-onlyで移行します。schema 9を読めない旧stable Updaterへのbinary差戻しは行わず、stable Updaterの配布・backup・rollback確認は通常のアプリself-updateやこのPRのmergeとは別の、明示承認付きcontrol-plane更新として扱います。
- retentionは常駐serviceが60秒ごとに評価し、terminal requestだけを古い順に対象とします。active captureとnon-terminal requestを削除せず、purge後もDB recordと元byte sizeを保持します。

この機能を含むアプリPRのmergeだけでは、稼働中のstable Updaterへ新しいcapture実装やDB migrationは配布されません。production control planeへの反映は、別のmaintenance window、exact SHA確認、明示承認を伴う`--upgrade-control`の責務です。

Codex hostのwrite approvalは、停止時間・target・migrationを理解したbusiness approvalの代替ではありません。

schema境界を越えるtargetは、policyの`compatibility_transitions`へsource/target compatibilityと必要なcontrol-plane capabilityを完全一致で列挙します。旧形式policyは空のtransition集合として扱うため、従来どおり単一`compatibility`と一致するtarget以外をfail closedします。repository上のtransition追加だけではproduction policyやstable updaterは変化しません。guarded control-plane installを別途承認・実施してexact updater SHAとpolicyを確認した後に、新しいplanを生成します。これは`apply_self_update`、DB migration、pointer切替、service操作の承認を兼ねません。

## Reconcile

crash、sleep/reboot、launchctl/HTTP response喪失後は同じcommandを繰り返しません。

```sh
node "$HOME/Library/Application Support/Dona/update-control/updater/dist/cli.js" status upd_...
node "$HOME/Library/Application Support/Dona/update-control/updater/dist/cli.js" reconcile upd_...
```

reconcileはpointer、receipt、DB fence/checkpoint、保存済みruntime intent、両serviceのversioned health/通知protocol、`dona-main`のagent identity、Codex session、foreground cwdを読みます。acceptance不明のstop/startはpolicyの`reconcile_ms`内でread-only観測し、同じwriteは再送しません。観測がtarget successかprevious rollbackを一意に証明できないまま期限を迎えた場合だけ`needs_review`にします。

## Stable control-plane更新と既存インシデント補正

`dona-main`の`gpt-6-sol`／`medium`設定もstable Updaterの起動実装です。既存installへ適用するには、この変更を含むexact SHAの`--upgrade-control`と新Updaterのversion health確認を先に完了し、その後同じ新releaseの通常plan/applyを行います。runtimeだけの更新成功ではmain設定の反映を保証しません。[モデル設定の適用条件](operations/codex-model-settings.md#既存installへの適用条件)を確認してください。

セルフアップデート通知の重複防止は、Slack Appのcustom message metadata schemaに依存しません。通知本文を表示するsection blockの`block_id`へ決定論的な`notification_id`を埋め、同じBotの投稿だけをthread全pageから照合します。このfieldは通常のmessage read/write権限で永続化・再読できるため、manifest変更、`metadata.message:read`、App再認可、外部状態のattestationは不要です。

maintenance windowを確保し、cleanな最新main checkoutで次を実行します。`needs_review`はterminalなので存在してもよいですが、未承認planを含む非terminal requestが1件でもあれば拒否します。

世代別installを更新する場合は、対象の既存rootを第二引数へ絶対パスで明示します（例: `./scripts/install-self-update.sh --upgrade-control "$HOME/.dona/g/<generation>"`）。installerはそのrootの既存policy、current pointer、Updater/Dispatcher plistを照合し、別のinstallを指す場合は停止前に拒否します。既定installを更新する場合は従来どおり引数を省略します。対象rootを推測せず、稼働中plistと照合してから指定してください。

```sh
./scripts/install-self-update.sh --upgrade-control
```

このmodeはowner-privateな`.staging`でexact SHAのarchiveを展開し、隔離したnpm cache/configで各componentのinstall・test・typecheck・buildを行います。manifestのlockfile hash、toolchain、compatibility、実行entrypointとtree全体を検証してからSHA directoryへ配置し、read-only modeへ変更した後にも同じtree digestを照合します。同じSHAのreleaseが既存でもfresh stagingとのmanifest identity、内容hash、owner、mode、hardlinkを照合できない限り再利用しません。partial stagingや配置後のmode設定中に停止したreleaseは完了扱いにしません。

停止前に`control-backups/<new-sha>.<attempt>/attempt.json`へ旧新build SHA、policy/plist digestを記録します。以後、UpdaterとDispatcherの停止・起動intent、観測結果、DB backup digest、control切替、version health、復旧結果を単調増加するsequenceとともにatomic renameで保存します。Updaterだけを停止し、launchd登録解除の安定観測とsocket停止後にSQLite全件でnonterminal countが0であることを再確認します。旧updater/policy/plistとSQLite Online Backupを同じattemptに保存し、backupを別connectionでopenしてintegrity、外部キー、schema version、table数、request件数を元DBと照合します。さらにbackupのコピーを旧UpdaterのDB readerでopenする復元rehearsalを行い、そのreceipt digestをattemptへ記録します。新SHA、`update_schema: 3`、DB読書きが揃うfresh process healthを確認し、socket healthのPID・start identityをstartup lock、OS process、launchd登録と照合してから、capability receiptをattempt ledgerと復元rehearsalのdigestへ束縛して公開します。`launchctl`は単一の期限付きcallと読み取り照合を使い、応答が不明な場合も同じbootstrapを再送しません。

control DB schemaのforward/rollback境界は次のとおりです。rehearsalはbackupのコピーを新binaryでmigrationし、`old_schema`と`new_schema`を記録します。`new_schema > old_schema`なら`restore_backup_required`、同じなら`same_schema`とし、いずれもbackupの別コピーを旧binaryで開けることを確認します。新Updater起動前の失敗は保存済みOnline Backupを開けることを確認して旧binaryと旧DBへ戻し、旧SHA healthを再読します。新Updaterのmigration後でも、通常runtimeのwriterを解放していない間だけ同じbackupへ復元できます。旧binaryが新schemaを読めない場合、DBを戻さずbinaryだけを差し戻すことは禁じます。backupが欠落・不一致、停止identityや起動acceptanceが不明、または復元後の旧SHA healthが不明なら自動再送せず`needs_review`として隔離します。成功後もDispatcher/Slack Adapterは旧releaseのままなので、表示された新SHAを対象に別の通常plan/applyを続けます。このcontrol-plane receiptは通常runtime updateの承認やactivation receiptを兼ねません。

policy `2026-09-03.1`で`main_agent_start_failed`になった既存requestは、旧runtime上でtarget pointer、activation receipt、両service、`dona-main`が一致した場合だけ証拠を保存します。この時点では訂正通知を送りません。通常updateでDispatcher/Slack Adapterの`update_notification_protocol: 1`を確認した後、新しいterminal fenceを発行し、元threadへ訂正を1回だけ投稿します。

## Emergency rollback

automatic rollbackはwrong target SHAというcandidate regressionを確認でき、previous互換で、1回のcircuit内だけです。Slack network outage、partial workspace ready、irreversible schema/config、unknown healthでは行いません。

`needs_review`後にoperator rollbackする場合、statusでcurrent=target、previous=planned current、互換性を確認し、exact plan hashを指定します。

```sh
node "$HOME/Library/Application Support/Dona/update-control/updater/dist/cli.js" \
  rollback upd_... --confirm-plan-hash <64-hex-plan-hash>
```

previous Dispatcherと全Slack workspaceのprevious SHA healthまで確認できた場合だけ`rolled_back`です。pointerだけ戻った状態を成功扱いしません。

## Circuit open / manual recovery

- `*_acceptance_unknown`: 同じlaunchctl/POSTを再実行せず、PID、`launchctl print`、pointer、receipt、health、external event lookupを確認します。
- `pointer_observation_mismatch`: current/previousを手で書き換えず、symlinkの実体、owner、mode、release manifestを確認します。
- `staged_compatibility_metadata_differs_from_approved_plan`: new SHAで再planします。既存planを流用しません。
- `retention_cleanup_failed`: current、previous、active attemptを削除しません。`doctor`のdry-run候補を確認します。
- outbox `needs_review`: update自体は維持します。元threadの通知有無を人間が確認します。

## Backupとschema

## app DB schema v2→v3 rollout

schema rolloutは通常の単発self-updateへ混ぜない。production source `7dbaab72e3387f94f6c8a2289a685b90b100d083`は`config/release-compatibility.production-v2.json`どおりschema 2だけをread/writeするため、schema-v3 targetへの通常rollback互換性はない。`config/update-compatibility-transitions.json`へsource SHA、source/target compatibility、previous release contract、必要なcontrol-plane capabilityをexactに固定し、plannerとactivation直前の双方で同じtransitionを検証する。移行失敗時はv2 pointer rollbackを推測せず、Online Backup receiptと停止下restore境界へ従う。

schema activation前には、同じexact SHAから`--upgrade-control`されたstable updaterのhealthとowner-only `control-plane-receipt.json`が一致し、capability `dispatcher_v2_to_v3_online_backup_v1`を示すことも必須とする。不明・旧updaterではplan時とpointer切替直前の双方で拒否する。これはproduction更新の許可ではなく、実行には別途exact planの明示承認が必要である。

migration/activation planは次の順序を崩さない。

1. Slack ingress、Dispatcher、job controlをquiesceし、drain結果の`unsafe_states`が空であることを確認する。
2. SQLite Online Backup APIで別fileへbackupする。WAL稼働中の`.sqlite3`単体copyは禁止する。
3. backupをread-only openし、`user_version = 2`、`integrity_check = ok`、`foreign_key_check` 0件、row/Result/completion count一致を確認する。
4. 単一transactionでv2→v3 migrationを実行し、同じ検査と保存件数、`user_version = 3`をreceiptへ記録する。
5. previous releaseがv3をread可能ならpointer rollback可能性を確認してからmulti-job gateを有効化する。productionのv2-only transitionではpointer rollbackを行わず、検証済みOnline Backupを停止下でv2としてrestore-openできることをrollback条件とする。条件不一致、応答不明、未検証の既存backup path、検査失敗はactivation前に拒否し、writeをblind retryしない。

`migrateV2ToV3WithBackup`は上記3〜4の機械的境界であり、pathをreceiptへ含めない。rollback rehearsalは、migration済みv3をcompatibility releaseが開けることと、Online Backupをv2としてrestore-openできることの両方を確認する。v2しかreadできないreleaseへpointer rollbackしてはならない。v3-compatible releaseへ戻せない場合だけservice停止下で検証済みbackupをrestoreする。

初回migrationではbackupとreceiptが未作成であることを`lstat`で確認してからOnline Backupへ進む。再開時はregular fileとして存在するbackup/receiptだけを検査し、backup-onlyならlive DBとbackupがともに健全なschema v2で内容が一致する場合だけ再利用する。permission、I/O、symlink、corruption、未知のSQLite open errorを「未作成」へ降格しない。

legacy compatibilityとして、`job_key`省略時の`legacy-default`、`duplicate` response、group metadataを持たない既存`dona_job` eventを維持する。CIのfixture/integration成功はlive Slack smokeではない。isolated threadでの2 success・1 attention、Agent Session遷移、集約返信を実Dona経路の両側で照合するまでProjectを`Merge Ready`にしない。

## Retention

current、previous、active attempt、needs_review、未報告の最新通知が参照するreleaseを保護し、activation receiptがあるのにpointerが欠落するか、receiptのfrom/to SHAとprevious/current pointerが食い違う場合はcleanupを停止します。failed/cancelled/rolled_backのrelease証拠は最初のretention観測から累積30日以上のsystem uptimeが確認できるまで保護します。時計補正や再起動で保持期間を短縮せず、初回観測や再起動によって実際の保持期間は延び得ます。さらにDBで確認した直近2 successful releaseを保護します。disk floor 2 GiB未満ではstageを開始しません。`doctor`は最大8件のcleanup候補をdry-run表示し、success後と常駐serviceの60秒ごとのmaintenanceで、publish・activate・rollbackとcleanupを同一ReleaseStoreで直列化し、SHA形式・realpath containment・owner/mode・内部linkを再検証したreleaseだけを対象にします。publish時のtree検証にも各scanで3秒・10万entryの上限を適用します。候補のdeep scanは1回あたり最大16件で、削除対象はdev・inode・birthtimeを記録してtombstoneへrenameしてから除去し、部分削除は同じidentityだけ再開します。cleanup時のcursorを永続化し、破損または属性異常のcursorはentry identityを照合して隔離し、先頭から再検証します。

診断logのretentionはrelease retentionとは別です。policyの`diagnostic_log_limit_bytes`、`diagnostic_aggregate_limit_bytes`、`diagnostic_retention_days`を使い、terminal requestのfinalized logだけをpurgeします。
