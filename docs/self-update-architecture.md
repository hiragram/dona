# Self-updateアーキテクチャ

## 信頼境界

stable updaterは`runtime/current`の外にinstallし、current releaseのcodeやDB schemaに依存しません。更新要求の自由記述を実行せず、versioned 0600 policyで固定したrepository、branch、root、label、executableだけを使用します。child processは`spawn(..., { shell: false })`、固定argv、minimal environment、timeout、1 MiB output上限で動かします。stagingへSlack本文、Keychain値、private URL、production environmentを渡しません。

`npm ci`はlockfile一致を強制しますがlifecycle scriptを実行し得るため、candidate buildは専用checkout・secret-free environment・非root userに隔離します。user/global npm configは別々のcontroller-owned private empty fileへ固定し、専用cacheだけを使います。target SHAに対して`Verify dispatcher`、`Verify sources/slack`、`Verify updater`がGitHub Actions App由来のterminal successであることをplan時とstage直前に確認します。署名必須化はpolicyで有効にできます。

structured log、永続error、API error、completion payloadはcredential形式とURLを値レベルでもredactします。Slack本文、raw plan、全environmentは監査logやrelease manifestへ保存しません。

## 永続状態の所有

`updater.sqlite3`はapp DBから分離し、WAL + `synchronous=FULL`を使用します。

- `update_requests`: exact SHA、plan hash、policy version、互換性、reply target、attempt/generation/restart、lease/fence、bounded reconcile期限、observed active SHA、error
- `controller_state`: system-wide single-flight
- `update_audit`: UPDATE/DELETE triggerで保護したappend-only transition log
- `runtime_operations`: stop/start前に保存するintent、対象pane/service/SHA、旧新Codex session、acceptance/observation evidence
- `update_outbox`: terminal transitionと同じtransactionで作るcompletion event、Dispatcher受理ID、Slack報告完了時刻、訂正でsupersedeされた未送信event

lease reclaimはfenceを単調増加させ、すべてのstate mutationを`request_id + fence` CASで制限します。長い処理中はleaseを更新し、外部phase境界でもowner・期限・fenceを再検証します。古いcontrollerは外部操作後もDBを進められません。source event/requestの重複は同じrecordを返し、payload mismatchを拒否します。

非terminal planは全体で1件だけです。terminal transition後も、そのoutboxがDispatcherで`completed`となりSlack投稿・Agent Session更新・Result Envelope再読まで確定する間は、次のupdateをclaimしません。通知が恒久的な`needs_review`になった場合だけ、自動進行不能であることをstatusへ残して後続判断を人間へ戻します。

## Releaseとactivation

candidateは`releases/.staging/<request>-<fence>`にcloneし、fixed mainからapproved SHAが現在もreachableであること、origin/HEAD、compatibility、lock hash、Node engine、3 packageのcanonical verifyを再確認します。完了manifestをfsyncしてからsame-filesystem renameで`releases/<sha>`へpublishし、owner-only read/executeにします。不完全な`.staging`をcurrentへ接続しません。

activationは次のcrash-observable sequenceです。

1. currentがplanned current SHAであることをCAS確認
2. `previous.tmp` symlinkを作り`previous`へrename、parent directory fsync
3. `current.tmp` symlinkを作り`current`へrename、parent directory fsync
4. stable control rootへactivation receiptをatomic write + file/directory fsync
5. DBへactivation generationをfenced commit

crash後はDB stateだけで推測せず、current/previous、release manifest、receipt、Dispatcher/SlackのSHA health、通知protocol、`dona-main`のrelease cwd/sessionを再観測します。processのstop/start writeは先に`runtime_operations`へintentをcommitし、応答喪失後は同じwriteを再送せず、保存済みidentityと観測結果をbounded reconcileします。quiesceはstable request IDへ束縛された冪等operationとして再観測し、ingress service自身が再起動した場合も両方のdrain完了を取り直します。期限内にexact targetまたはexact rollbackを証明できた場合だけterminalへ進み、証明できなければ`needs_review`です。

rollbackは`current`をknown-good previousへ先に切り替え、その後`previous`をtargetへ移します。二つのrename間でcrashしてもtargetはimmutable SHA directoryから回収でき、known-good pointerを失いません。`needs_review`のcompletionでは稼働SHAを推測せず`active_sha: null`にします。

## Runtimeの停止・起動順序

applyを受けたapproval event IDと、そのeventの永続化済みreply targetをrequestへ保存します。この受付eventのResultが`completed`になるまでactivation leaseをclaimしません。local UDSはrequest/response双方のschema・protocol versionとservice種別を検証します。normal activationはSlack Adapterを最初にquiesceし、新規Socket ingressを止め、in-flight Dispatcher commit/Slack ACKをbounded drainします。次にDispatcherをstop-after-currentへ移し、新しいqueue item、job、update controlを受け付けず、すでに`dona-main`へ受理された1件のResult公開だけを完走させます。prompt/steer/cancel acceptance-unknownがなく、Herdr上の`dona-main`が`idle`または`done`であることを確認してから、そのexact agent identityへ`Ctrl+C`を送り、agent消失を観測します。

clean stop後にpointerを切り替え、同じpaneへtargetのimmutable releaseを`-C`で指定したCodexを`dona-main`という名前で起動します。project-scoped `.codex/config.toml`はtrusted projectでだけ読み込まれるため、updaterが生成したexact target release pathだけをinline `projects`設定でtrustします。stdio MCPにはprotected policy由来の`config/*.env`、current manifest、updater socket、固定executableのpathだけをinline environmentとして渡し、credential値はargvやreleaseへ載せません。config rootと2つのenv fileが実directory・regular file・owner-onlyでない場合は起動前に拒否します。agent名、kind、pane、Codex session、foreground cwd、interactive readinessを照合してからDispatcherをstartし、target SHA/protocol/schema readyを確認した後にSlack Adapterをstartして全workspace readyを確認します。Codex CLIの終了とproject configの仕様は[OpenAI公式のCLI reference](https://developers.openai.com/codex/cli/reference/)と[config basics](https://developers.openai.com/codex/config-basic/)に従います。

targetの起動後にrollbackする場合も、起動済みのSlack/Dispatcherを先にquiesceして新規投入を止め、`dona-main`をidleまでdrainしてexact identityを停止します。pointerをpreviousへ戻した後、previous releaseから同じpaneへCodexを再生成します。`blocked`、identity変化、または観測期限切れでは`needs_review`にします。終了・起動の応答が不明でも即座に再送せず、保存したintentに対してprocess消失、version health、新Codex sessionを観測します。

LaunchAgentはroutine releaseで書き換えません。Dispatcher/Slackは`KeepAlive.SuccessfulExit=false`なのでclean quiesce終了は勝手にrestartせず、crashだけがthrottle付きrestart対象です。stable updaterだけは`KeepAlive=true`です。updater service自身は自分のbootout/bootstrapを行いません。

## 完了通知のrouting

terminal stateは`update:<request_id>:terminal:<fence>`をstable external IDにした`dona_update` Event Envelopeとしてoutboxへ入ります。Dispatcherの外部`POST /v1/events`は`dona_update`を拒否し、0600 shared tokenで認証したinternal UDSだけがtyped schemaを受けます。POST response喪失時はexternal IDとcanonical payload SHA-256の両方をlookupで照合し、IDだけが一致する別payloadを受理済みにしません。

`dona_update`は通常のmain-agent queueから除外され、Dispatcher内の専用SQLite workerが定型日本語へrenderします。workerはSlack Adapterの認証済みinternal UDSへ、workspace/channel/thread、terminal fence、sessionの最終状態だけをtyped requestで渡します。Slack Adapterは`notification_id`をmessage metadataへ付け、thread全pageをread-backしてから投稿するため、投稿応答やsession status応答を失っても同じ本文を二重投稿しません。Slack投稿とAgent Session更新が完了した後だけ、そのeventのResult Envelopeを同一filesystem renameで公開し、再読後にDispatcher eventを`completed`にします。

Dispatcher/Slackの`/health/version`は`update_notification_protocol: 1`を返します。Dispatcherは通知workerが稼働し、通知DBを実際に読み書きできる場合だけreadyになります。Slack Adapterは内部reporterと共有tokenを利用でき、かつApp Manifestへの`dona.update_notification` schema登録と`metadata.message:read` scopeの再認可を運用者が`SLACK_UPDATE_METADATA_SCHEMA_REGISTERED=true`でattestした場合だけこのcapabilityを公開します。未登録metadataがwarningだけで無視されるSlack仕様を、完了条件から隠しません。投稿応答と直後の全page read-backのどちらにもexact metadataがない場合は、既に確定したmessage receiptを失わず通知eventを`needs_review`にします。旧runtimeでpolicy `2026-09-03.1`の`main_agent_start_failed`を補正する場合は、pointer、activation receipt、target health、target releaseの`dona-main`が一致した証拠だけを先に保存します。訂正eventは通知protocol 1のruntimeへ更新された後に新しいfenceで発行し、すでに別releaseへ進んでいれば「当時確認したtarget」と「現在の稼働SHA」を分けて報告します。

## Stable control-planeの更新

routine releaseはstable updater自身を変更しません。policy/schema変更時はcleanな最新main checkoutから`--upgrade-control`を明示実行します。このmodeはtrusted CIと3 package buildを再検証し、active/approved/awaiting approval requestがないことをUpdater UDSで確認してからだけUpdaterを停止します。同じSHAのreleaseが既にある場合もmanifestだけでは再利用せず、fresh stagingと実行treeの内容hashが一致することを確認します。停止をsocketで確認後、SQLite全件のnonterminal countを再確認し、WALをcheckpointして旧DB・updater・policy・plistをSHA別backupへ保存してからstaged control filesを切り替えます。

新Updaterはlaunchctlの終了コードだけで成功扱いせず、期待SHA、`update_schema: 3`、DB読書きが揃うversion healthを30秒以内に観測します。SHAはplist環境変数由来なので、schemaも照合して旧binaryの取り残しを成功扱いしません。観測できなければ新processの停止を確認し、旧filesとDB snapshotを復元して旧SHA healthを確認します。command応答が曖昧でprocess停止を確定できない場合はfileを上書きしません。control-plane更新が成功してもDispatcher/Slack Adapterは変わらないため、続けて通常のplan/applyで同じ新releaseへ切り替えます。
