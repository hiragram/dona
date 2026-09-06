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

cleanなcanonical main checkoutで明示的に実行します。installerはfetch後の`origin/main`とのSHA一致と、GitHub Actions由来の固定3 check成功を再検証します。

```sh
./scripts/install-self-update.sh --install
```

この段階ではimmutable initial release、stable updater copy、0600 policy/token/config/plistだけを配置し、processやlaunchctlは変更しません。既存`install-launchd.sh`はdeveloper checkoutを直接起動するlegacy方式です。新構成へ切り替えるmaintenance windowで、内容を確認してから次を別途実行します。

```sh
./scripts/install-self-update.sh --bootstrap
```

`--bootstrap`だけが、既存Slack Adapter→Dispatcherの順にbootoutし、stable updater→Dispatcher→Slack Adapterの順にbootstrapします。commandの結果が曖昧なら反復せず、`launchctl print gui/$UID/<label>`とhealthを確認します。実行中stable updaterはinstallerもbootoutしません。

## 通常update

1. Donaは`plan_self_update(source_event_id)`を呼びます。
2. 利用者はcurrent/target exact SHA、plan hash、policy、CI、互換性、rollback可否を確認します。
3. 明示承認後だけ、Donaは`apply_self_update(source_event_id, plan_id, plan_hash, approval_id)`を呼びます。
4. acceptedは「approval受付eventとexact planをDBへcommitした」意味です。その受付Event Resultが`completed`になるまでactivationは始まりません。
5. updaterは新規Slack ingressとDispatcher dequeueを止め、処理中の1件と`dona-main`のidleを待ってからCodexを終了します。owner-onlyの`config/dispatcher.env`と`config/slack.env`をMCPへ接続し、target releaseから同じpaneへ新しい`dona-main`を起動した後、Dispatcher、Slack Adapterの順に再開します。
6. `get_self_update_status`で`runtime_state`、`runtime_operations`、`notification_state`、outbox、`main_agent`のcwd/sessionを確認します。terminal通知はmain agentを経由せず、専用workerから元Slack threadへ戻ります。`notification_state: reported`になるまで次のupdateは開始されません。

Codex hostのwrite approvalは、停止時間・target・migrationを理解したbusiness approvalの代替ではありません。

## Reconcile

crash、sleep/reboot、launchctl/HTTP response喪失後は同じcommandを繰り返しません。

```sh
node "$HOME/Library/Application Support/Dona/update-control/updater/dist/cli.js" status upd_...
node "$HOME/Library/Application Support/Dona/update-control/updater/dist/cli.js" reconcile upd_...
```

reconcileはpointer、receipt、DB fence/checkpoint、保存済みruntime intent、両serviceのversioned health/通知protocol、`dona-main`のagent identity、Codex session、foreground cwdを読みます。acceptance不明のstop/startはpolicyの`reconcile_ms`内でread-only観測し、同じwriteは再送しません。観測がtarget successかprevious rollbackを一意に証明できないまま期限を迎えた場合だけ`needs_review`にします。

## Stable control-plane更新と既存インシデント補正

セルフアップデート通知の重複防止は、Slack Appのcustom message metadata schemaに依存しません。通知本文を表示するsection blockの`block_id`へ決定論的な`notification_id`を埋め、同じBotの投稿だけをthread全pageから照合します。このfieldは通常のmessage read/write権限で永続化・再読できるため、manifest変更、`metadata.message:read`、App再認可、外部状態のattestationは不要です。

maintenance windowを確保し、cleanな最新main checkoutで次を実行します。`needs_review`はterminalなので存在してもよいですが、未承認planを含む非terminal requestが1件でもあれば拒否します。

```sh
./scripts/install-self-update.sh --upgrade-control
```

このmodeは、同じSHAのreleaseが既存でもfresh stagingと実行treeの内容hashが一致しない限り再利用しません。Updaterだけを停止し、socket停止後にSQLite全件でnonterminal countが0であることを再確認します。その後、旧updater/policy/plistとcheckpoint・integrity確認済みSQLiteを`update-control/control-backups/<new-sha>.<attempt>/`へ保存します。新SHA、`update_schema: 3`、DB読書きが揃うversion healthを確認できなければ旧一式とDBを戻し、旧SHA healthを確認します。成功後もDispatcher/Slack Adapterは旧releaseのままなので、表示された新SHAを対象に通常のplan/applyを続けます。

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

bridge releaseはapp DB `user_version=2`とlegacy single-job write/result/completionを維持し、`multi_job_enabled=false`を固定する。healthとrelease manifestのactual build SHA、read range 2〜3、write schema 2、protocol/configが一致しない場合はplanまたはpointer切替前に拒否する。current→bridgeはfast-forwardでなければならず、timeoutやconnection lossはpointer、receipt、version healthをread-onlyで照合してblind retryしない。

schema v3 migration、multi-job activation、SQLite Online Backup/restore、live Slack fan-out smokeは後続activation releaseの責務である。activation targetは実稼働bridge SHAの子孫でなければならず、rollback先もv3をread可能なbridgeに限定する。WAL稼働中の`.sqlite3`単体copyは禁止する。CIやrehearsalはlive rollout成功の代替にしない。

## Retention

current、previous、active attemptを常に保護し、それ以外の直近2 successful releaseも残します。disk floor 2 GiB未満ではstageを開始しません。`doctor`はcleanup候補をdry-run表示し、success後cleanupはSHA形式・realpath containment・owner/modeを再検証したreleaseだけを対象にします。
