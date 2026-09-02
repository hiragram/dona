# Self-updateアーキテクチャ

## 信頼境界

stable updaterは`runtime/current`の外にinstallし、current releaseのcodeやDB schemaに依存しません。更新要求の自由記述を実行せず、versioned 0600 policyで固定したrepository、branch、root、label、executableだけを使用します。child processは`spawn(..., { shell: false })`、固定argv、minimal environment、timeout、1 MiB output上限で動かします。stagingへSlack本文、Keychain値、private URL、production environmentを渡しません。

`npm ci`はlockfile一致を強制しますがlifecycle scriptを実行し得るため、candidate buildは専用checkout・secret-free environment・非root userに隔離します。user/global npm configは`/dev/null`へ固定し、controller-owned cacheだけを使います。target SHAに対して`Verify dispatcher`、`Verify sources/slack`、`Verify updater`がGitHub Actions App由来のterminal successであることをplan時とstage直前に確認します。署名必須化はpolicyで有効にできます。

structured log、永続error、API error、completion payloadはcredential形式とURLを値レベルでもredactします。Slack本文、raw plan、全environmentは監査logやrelease manifestへ保存しません。

## 永続状態の所有

`updater.sqlite3`はapp DBから分離し、WAL + `synchronous=FULL`を使用します。

- `update_requests`: exact SHA、plan hash、policy version、互換性、reply target、attempt/generation/restart、lease/fence、error
- `controller_state`: system-wide single-flight
- `update_audit`: UPDATE/DELETE triggerで保護したappend-only transition log
- `update_outbox`: terminal transitionと同じtransactionで作るcompletion event

lease reclaimはfenceを単調増加させ、すべてのstate mutationを`request_id + fence` CASで制限します。長い処理中はleaseを更新し、外部phase境界でもowner・期限・fenceを再検証します。古いcontrollerは外部操作後もDBを進められません。source event/requestの重複は同じrecordを返し、payload mismatchを拒否します。

## Releaseとactivation

candidateは`releases/.staging/<request>-<fence>`にcloneし、fixed mainからapproved SHAが現在もreachableであること、origin/HEAD、compatibility、lock hash、Node engine、3 packageのcanonical verifyを再確認します。完了manifestをfsyncしてからsame-filesystem renameで`releases/<sha>`へpublishし、owner-only read/executeにします。不完全な`.staging`をcurrentへ接続しません。

activationは次のcrash-observable sequenceです。

1. currentがplanned current SHAであることをCAS確認
2. `previous.tmp` symlinkを作り`previous`へrename、parent directory fsync
3. `current.tmp` symlinkを作り`current`へrename、parent directory fsync
4. stable control rootへactivation receiptをatomic write + file/directory fsync
5. DBへactivation generationをfenced commit

crash後はDB stateだけで推測せず、current/previous、release manifest、receipt、Dispatcher/SlackのSHA health、`dona-main`のrelease cwdを再観測します。current=targetかつ両serviceとagentがtarget readyならsuccess、current=planned currentかつ両serviceとagentがprevious readyならrolled backです。それ以外は`needs_review`です。

rollbackは`current`をknown-good previousへ先に切り替え、その後`previous`をtargetへ移します。二つのrename間でcrashしてもtargetはimmutable SHA directoryから回収でき、known-good pointerを失いません。`needs_review`のcompletionでは稼働SHAを推測せず`active_sha: null`にします。

## Runtimeの停止・起動順序

applyを受けたapproval event IDと、そのeventの永続化済みreply targetをrequestへ保存します。この受付eventのResultが`completed`になるまでactivation leaseをclaimしません。local UDSはrequest/response双方のschema・protocol versionとservice種別を検証します。normal activationはSlack Adapterを最初にquiesceし、新規Socket ingressを止め、in-flight Dispatcher commit/Slack ACKをbounded drainします。次にDispatcherをstop-after-currentへ移し、新しいqueue item、job、update controlを受け付けず、すでに`dona-main`へ受理された1件のResult公開だけを完走させます。prompt/steer/cancel acceptance-unknownがなく、Herdr上の`dona-main`が`idle`または`done`であることを確認してから、そのexact agent identityへ`Ctrl+C`を送り、agent消失を観測します。

clean stop後にpointerを切り替え、同じpaneへtargetのimmutable releaseを`-C`で指定したCodexを`dona-main`という名前で起動します。project-scoped `.codex/config.toml`はtrusted projectでだけ読み込まれるため、updaterが生成したexact target release pathだけをinline `projects`設定でtrustします。stdio MCPにはprotected policy由来の`config/*.env`、current manifest、updater socket、固定executableのpathだけをinline environmentとして渡し、credential値はargvやreleaseへ載せません。config rootと2つのenv fileが実directory・regular file・owner-onlyでない場合は起動前に拒否します。agent名、kind、pane、Codex session、foreground cwd、interactive readinessを照合してからDispatcherをstartし、target SHA/protocol/schema readyを確認した後にSlack Adapterをstartして全workspace readyを確認します。Codex CLIの終了とproject configの仕様は[OpenAI公式のCLI reference](https://developers.openai.com/codex/cli/reference/)と[config basics](https://developers.openai.com/codex/config-basic/)に従います。

targetの起動後にrollbackする場合も、起動済みのSlack/Dispatcherを先にquiesceして新規投入を止め、`dona-main`をidleまでdrainしてexact identityを停止します。pointerをpreviousへ戻した後、previous releaseから同じpaneへCodexを再生成します。`blocked`、`unknown`、identity変化、終了・起動acceptance不明ではblind retryせず`needs_review`にします。

LaunchAgentはroutine releaseで書き換えません。Dispatcher/Slackは`KeepAlive.SuccessfulExit=false`なのでclean quiesce終了は勝手にrestartせず、crashだけがthrottle付きrestart対象です。stable updaterだけは`KeepAlive=true`です。updater service自身は自分のbootout/bootstrapを行いません。

## 完了通知のrouting

terminal stateは`update:<request_id>:terminal:<fence>`をstable external IDにした`dona_update` Event Envelopeとしてoutboxへ入ります。Dispatcherの外部`POST /v1/events`は`dona_update`を拒否し、0600 shared tokenで認証したinternal UDSだけがtyped schemaを受けます。POST response喪失時はexternal ID lookupで存在確認し、同じwriteをblind retryしません。通知失敗はrelease stateを巻き戻しません。
